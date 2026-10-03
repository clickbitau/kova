import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { NestAdapter, nestAuthUrl, type NestOptions } from '../src/adapters/nest.ts';
import { buildServer } from '../src/api/server.ts';
import { testHub } from './helpers.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const PROJECT = 'proj-1234';
const SUB = 'projects/gcp-proj/subscriptions/kova-sub';
const dev = (id: string) => `enterprises/${PROJECT}/devices/${id}`;
const DOORBELL = dev('AVPHwEuDOORBELL0000000001');
const GARAGE = dev('AVPHwEuGARAGECAM000000002');
const OFFICE = dev('AVPHwEuOFFICECAM000000003');

const liveTrait = (protocols: string[]) => ({ 'sdm.devices.traits.CameraLiveStream': { maxVideoResolution: { width: 640, height: 480 }, videoCodecs: ['H264'], audioCodecs: ['OPUS'], supportedProtocols: protocols } });

/** A fake Google: OAuth token endpoint, SDM devices + executeCommand, and a Pub/Sub subscription with pull/acknowledge. */
async function fakeGoogle() {
  const s = {
    tokenCalls: 0, token: '', codes: [] as string[],
    queue: [] as { ackId: string; message: { data: string; messageId: string; publishTime: string } }[],
    acked: [] as string[], pulls: 0, emptyPullMs: 20,
    commands: [] as { device: string; command: string; params: Record<string, unknown> }[],
    imgFetches: 0, imgBroken: false,
    authHeaders: [] as string[],
  };
  const devices = [
    { name: DOORBELL, type: 'sdm.devices.types.DOORBELL', traits: { 'sdm.devices.traits.Info': { customName: '' }, ...liveTrait(['WEB_RTC']) }, parentRelations: [{ parent: `enterprises/${PROJECT}/structures/S/rooms/R1`, displayName: 'Front door' }] },
    { name: GARAGE, type: 'sdm.devices.types.CAMERA', traits: { 'sdm.devices.traits.Info': { customName: 'Garage camera' }, ...liveTrait(['RTSP']), 'sdm.devices.traits.Connectivity': { status: 'OFFLINE' } }, parentRelations: [{ parent: 'x', displayName: 'Garage' }] },
    { name: OFFICE, type: 'sdm.devices.types.CAMERA', traits: { ...liveTrait(['WEB_RTC']), 'sdm.devices.traits.CameraEventImage': { maxResolution: { width: 640, height: 480 } } }, parentRelations: [{ parent: 'x', displayName: 'Office' }] },
    { name: dev('THERMOSTAT00000000000004'), type: 'sdm.devices.types.THERMOSTAT', traits: {}, parentRelations: [{ parent: 'x', displayName: 'Hall' }] },
  ];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const send = (j: unknown, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      const url = decodeURIComponent(req.url!);
      if (url === '/token') {
        const f = new URLSearchParams(raw);
        if (f.get('client_id') !== 'cid.apps.googleusercontent.com' || f.get('client_secret') !== 'GOCSPX-secret') return send({ error: 'invalid_client' }, 401);
        if (f.get('grant_type') === 'refresh_token') {
          if (f.get('refresh_token') !== 'rt-1') return send({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
          s.tokenCalls++;
          s.token = `at-${s.tokenCalls}`;
          return send({ access_token: s.token, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/sdm.service https://www.googleapis.com/auth/pubsub' });
        }
        if (f.get('grant_type') === 'authorization_code') {
          s.codes.push(`${f.get('code')}|${f.get('redirect_uri')}`);
          if (f.get('code') !== '4/good-code') return send({ error: 'invalid_grant' }, 400);
          return send({ access_token: 'at-x', refresh_token: 'rt-new', expires_in: 3599 });
        }
        return send({ error: 'unsupported_grant_type' }, 400);
      }
      if (url.startsWith('/img/')) { s.imgFetches++; res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.from(`jpeg-${url.slice(5).split('?')[0]}`)); return; }
      s.authHeaders.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== `Bearer ${s.token}`) return send({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } }, 401);
      if (url === `/sdm/v1/enterprises/${PROJECT}/devices` && req.method === 'GET') return send({ devices });
      const exec = url.match(/^\/sdm\/v1\/(enterprises\/.+\/devices\/[^:]+):executeCommand$/);
      if (exec && req.method === 'POST') {
        const b = JSON.parse(raw);
        s.commands.push({ device: exec[1], command: b.command, params: b.params });
        if (b.command === 'sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream') return send({ results: { answerSdp: `answer-for:${b.params.offerSdp}`, expiresAt: '2026-09-30T13:05:00Z', mediaSessionId: 'ms-1' } });
        if (b.command === 'sdm.devices.commands.CameraLiveStream.ExtendWebRtcStream') return send({ results: { expiresAt: '2026-09-30T13:10:00Z', mediaSessionId: b.params.mediaSessionId } });
        if (b.command === 'sdm.devices.commands.CameraLiveStream.StopWebRtcStream') return send({});
        if (b.command === 'sdm.devices.commands.CameraEventImage.GenerateImage') return s.imgBroken ? send({ error: { code: 400, message: 'Event image has expired.' } }, 400) : send({ results: { url: `${base}/img/${b.params.eventId}`, token: 'imgtok' } });
        return send({ error: { code: 400, message: 'Command not supported.' } }, 400);
      }
      if (url === `/pubsub/v1/${SUB}:pull`) {
        s.pulls++;
        const batch = s.queue.splice(0);
        // Real pulls wait for messages; answer an empty pull after a moment.
        if (!batch.length) { setTimeout(() => send({}), s.emptyPullMs); return; }
        return send({ receivedMessages: batch });
      }
      if (url === `/pubsub/v1/${SUB}:acknowledge`) { s.acked.push(...JSON.parse(raw).ackIds); return send({}); }
      send({ error: { code: 404, message: 'not found' } }, 404);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  /** Queue one SDM event as Pub/Sub would deliver it. */
  const publish = (device: string, events: Record<string, { eventId: string; eventSessionId: string }>, at: number) => {
    const payload = { eventId: `msg-${++n}`, timestamp: new Date(at).toISOString(), resourceUpdate: { name: device, events }, userId: 'u1', resourceGroup: [device] };
    s.queue.push({ ackId: `ack-${n}`, message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId: String(n), publishTime: new Date(at).toISOString() } });
    return `ack-${n}`;
  };
  const opts = (extra: Partial<NestOptions> = {}): NestOptions => ({
    projectId: PROJECT, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', refreshToken: 'rt-1',
    tokenUrl: `${base}/token`, sdmUrl: `${base}/sdm`, pubsubUrl: `${base}/pubsub`, pollMs: 0, idleMs: 5, retryMs: 20, ...extra,
  });
  return { s, server, base, publish, opts, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

const IDS = { [DOORBELL]: 'doorbell', 'Garage camera': 'garage_cam', Office: 'office_cam' };
const ROOMS = { [DOORBELL]: 'front', 'garage camera': 'garage' };

test('Nest: refreshes the access token once and caches it until it nearly expires', async () => {
  const g = await fakeGoogle();
  const clock = { t: Date.now() };
  const reg = new Registry(new Store(':memory:'));
  const nest = new NestAdapter(g.opts({ now: () => clock.t }));
  await reg.addAdapter(nest);
  try {
    assert.equal(g.s.tokenCalls, 1);
    await nest.refreshDevices();
    await nest.refreshDevices();
    assert.equal(g.s.tokenCalls, 1, 'cached');
    assert.ok(g.s.authHeaders.every(h => h === 'Bearer at-1'));
    clock.t += 59 * 60_000; // within a minute of the 1-hour expiry
    await nest.refreshDevices();
    assert.equal(g.s.tokenCalls, 2, 'refreshed before expiry');
    // A token Google stops accepting early is replaced once, then the call is retried.
    g.s.token = 'rotated-by-google';
    await nest.refreshDevices();
    assert.equal(g.s.tokenCalls, 3);
    assert.equal(nest.status().ok, true);
  } finally { await reg.stop(); await g.close(); }
});

test('Nest: announces cameras and doorbells with configured ids and rooms', async () => {
  const g = await fakeGoogle();
  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new NestAdapter(g.opts({ ids: IDS, rooms: ROOMS })));
  try {
    const list = reg.list().sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(list.map(d => d.id), ['doorbell', 'garage_cam', 'office_cam'], 'no thermostat');
    const [bell, garage, office] = list;
    assert.equal(bell.name, 'Front door', 'named after its room when it has no custom name');
    assert.equal(bell.room, 'front');
    assert.equal(bell.type, 'camera');
    assert.deepEqual(bell.capabilities, ['events']);
    assert.equal(bell.integration, 'Google Nest Doorbell');
    assert.equal(bell.address, DOORBELL);
    assert.equal(bell.state.online, true);
    assert.equal(garage.name, 'Garage camera');
    assert.equal(garage.room, 'garage');
    assert.equal(garage.state.online, false, 'from the Connectivity trait');
    assert.equal(office.room, 'office', 'room from the display name when not configured');
  } finally { await reg.stop(); await g.close(); }

  // Without ids: nest_<last 12 of the device id>.
  const g2 = await fakeGoogle();
  const reg2 = new Registry(new Store(':memory:'));
  await reg2.addAdapter(new NestAdapter(g2.opts()));
  try {
    assert.deepEqual(reg2.list().map(d => d.id).sort(), ['nest_cam000000002', 'nest_cam000000003', 'nest_ll0000000001']);
    assert.equal(reg2.get('nest_ll0000000001')!.room, 'front_door', 'room from the display name');
  } finally { await reg2.stop(); await g2.close(); }
});

test('Nest: a person at the doorbell lights the way; duplicates and stale events are ignored; messages are acked', async () => {
  const g = await fakeGoogle();
  // 21:00 is Wind down: the porch and path lights are off, and Light the way is on.
  const { hub, clock, dev } = await testHub(21);
  const nest = new NestAdapter(g.opts({ ids: IDS, rooms: ROOMS, subscription: SUB, now: () => clock.t }));
  await hub.reg.addAdapter(nest);
  const events: { id: string; type: string; data: Record<string, unknown> }[] = [];
  hub.reg.on('event', e => events.push({ id: e.device.id, type: e.type, data: e.data }));
  try {
    assert.equal(hub.reg.get('doorbell')!.adapter, 'nest', 'the Nest doorbell took over the id the triggers use');
    assert.equal(hub.engine.modeId, 'wind');
    assert.equal(dev('front_1').on, false);
    assert.equal(dev('front_2').on, false);

    const a1 = g.publish(DOORBELL, { 'sdm.devices.events.CameraPerson.Person': { eventId: 'ev-1', eventSessionId: 'sess-1' } }, clock.t - 5_000);
    await until(() => g.s.acked.includes(a1));
    await until(() => dev('front_1').on === true && dev('front_2').on === true);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'doorbell');
    assert.equal(events[0].type, 'person');
    assert.equal(events[0].data.eventId, 'ev-1');
    assert.equal(events[0].data.eventSessionId, 'sess-1');
    assert.equal(events[0].data.timestamp, new Date(clock.t - 5_000).toISOString());

    // The same event again (Pub/Sub redelivery, or a thread update), and one from 3 minutes ago.
    const a2 = g.publish(DOORBELL, { 'sdm.devices.events.CameraPerson.Person': { eventId: 'ev-1', eventSessionId: 'sess-1' } }, clock.t - 1_000);
    const a3 = g.publish(OFFICE, { 'sdm.devices.events.CameraPerson.Person': { eventId: 'ev-old', eventSessionId: 'sess-old' } }, clock.t - 3 * 60_000);
    // Then a doorbell press and motion: both come through, and unknown event types are skipped.
    const a4 = g.publish(DOORBELL, {
      'sdm.devices.events.DoorbellChime.Chime': { eventId: 'ev-2', eventSessionId: 'sess-2' },
      'sdm.devices.events.CameraMotion.Motion': { eventId: 'ev-3', eventSessionId: 'sess-2' },
      'sdm.devices.events.CameraClipPreview.ClipPreview': { eventId: 'ev-4', eventSessionId: 'sess-2' },
    }, clock.t);
    await until(() => [a2, a3, a4].every(a => g.s.acked.includes(a)));
    assert.deepEqual(events.map(e => `${e.id}:${e.type}`), ['doorbell:person', 'doorbell:ring', 'doorbell:motion']);
    assert.equal(nest.status().ok, true);
  } finally { await hub.stop(); await g.close(); }
});

test('Nest: WebRTC live view through the hub API, and account linking routes', async () => {
  const g = await fakeGoogle();
  const { hub } = await testHub(12);
  await hub.reg.addAdapter(new NestAdapter(g.opts({ ids: IDS, rooms: ROOMS })));
  const app = await buildServer(hub, { webRoot, nest: { projectId: PROJECT, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', tokenUrl: `${g.base}/token` } });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/devices/doorbell/webrtc', payload: { offerSdp: 'v=0 offer' } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { answerSdp: 'answer-for:v=0 offer', mediaSessionId: 'ms-1', expiresAt: '2026-09-30T13:05:00Z' });
    assert.deepEqual(g.s.commands[0], { device: DOORBELL, command: 'sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream', params: { offerSdp: 'v=0 offer' } });

    const ext = await app.inject({ method: 'POST', url: '/api/devices/doorbell/webrtc/extend', payload: { mediaSessionId: 'ms-1' } });
    assert.deepEqual(ext.json(), { mediaSessionId: 'ms-1', expiresAt: '2026-09-30T13:10:00Z' });
    const stop = await app.inject({ method: 'POST', url: '/api/devices/doorbell/webrtc/stop', payload: { mediaSessionId: 'ms-1' } });
    assert.deepEqual(stop.json(), { ok: true });
    assert.deepEqual(g.s.commands.map(c => c.command.split('.').pop()), ['GenerateWebRtcStream', 'ExtendWebRtcStream', 'StopWebRtcStream']);

    // An RTSP-only camera, and a device with no live view at all.
    const rtsp = await app.inject({ method: 'POST', url: '/api/devices/garage_cam/webrtc', payload: { offerSdp: 'v=0' } });
    assert.equal(rtsp.statusCode, 400);
    assert.match(rtsp.json().error, /Live view isn’t available for this camera yet/);
    assert.equal(g.s.commands.length, 3, 'nothing sent to Google for it');
    const lamp = await app.inject({ method: 'POST', url: '/api/devices/lamp/webrtc', payload: { offerSdp: 'v=0' } });
    assert.equal(lamp.statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/devices/nope/webrtc', payload: { offerSdp: 'v=0' } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/devices/doorbell/snapshot' })).statusCode, 404, 'no event image trait');

    // Linking: the partner-connections URL, then the code exchange.
    const u = (await app.inject({ url: '/api/integrations/nest/auth-url' })).json();
    const url = new URL(u.url);
    assert.equal(url.origin + url.pathname, `https://nestservices.google.com/partnerconnections/${PROJECT}/auth`);
    assert.equal(url.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://www.google.com');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.deepEqual(url.searchParams.get('scope')!.split(' '), ['https://www.googleapis.com/auth/sdm.service', 'https://www.googleapis.com/auth/pubsub']);
    assert.equal(new URL((await app.inject({ url: '/api/integrations/nest/auth-url?redirectUri=http%3A%2F%2Flocalhost%3A8140%2Fcb' })).json().url).searchParams.get('redirect_uri'), 'http://localhost:8140/cb');
    assert.equal(nestAuthUrl({ projectId: 'p', clientId: 'c' }).includes('/partnerconnections/p/auth?'), true);

    const code = await app.inject({ method: 'POST', url: '/api/integrations/nest/auth-code', payload: { code: '4/good-code', redirectUri: 'https://www.google.com' } });
    assert.equal(code.statusCode, 200);
    assert.equal(code.json().refreshToken, 'rt-new');
    assert.deepEqual(g.s.codes, ['4/good-code|https://www.google.com']);
    const bad = await app.inject({ method: 'POST', url: '/api/integrations/nest/auth-code', payload: { code: 'nope' } });
    assert.equal(bad.statusCode, 400);
  } finally { await app.close(); await hub.stop(); await g.close(); }
});

test('Nest: a quiet subscription is not an error (a pull may wait longer than an API call)', async () => {
  const g = await fakeGoogle();
  g.s.emptyPullMs = 300; // Pub/Sub holds an empty pull open; longer than the normal API timeout below
  const reg = new Registry(new Store(':memory:'));
  const nest = new NestAdapter(g.opts({ subscription: SUB, timeoutMs: 100, pullTimeoutMs: 2000, idleMs: 0 }));
  await reg.addAdapter(nest);
  try {
    await new Promise(r => setTimeout(r, 800));
    assert.ok(g.s.pulls >= 2, 'kept pulling');
    assert.doesNotMatch(String(nest.status().note), /timeout|aborted/i);
    assert.equal(nest.status().ok, true);
  } finally { await reg.stop(); await g.close(); }
});

test('Nest: a revoked refresh token is reported, not thrown, and the event loop stops cleanly', async () => {
  const g = await fakeGoogle();
  const reg = new Registry(new Store(':memory:'));
  const nest = new NestAdapter(g.opts({ refreshToken: 'revoked', subscription: SUB }));
  await reg.addAdapter(nest);
  try {
    assert.equal(reg.list().length, 0);
    assert.equal(nest.status().ok, false);
    assert.match(nest.status().note!, /revoked/);
  } finally { await reg.stop(); await g.close(); }
});

test('Nest: each event grabs its image while it still exists — the thumbnail outlives Google’s 30 s', async () => {
  const g = await fakeGoogle();
  const dir = await mkdtemp(join(tmpdir(), 'kova-nest-'));
  const reg = new Registry(new Store(':memory:'));
  const nest = new NestAdapter(g.opts({ ids: IDS, rooms: ROOMS, subscription: SUB, storageDir: dir }));
  await reg.addAdapter(nest);
  try {
    // A person at the office camera: the adapter fetches the event image on its own.
    g.publish(OFFICE, { 'sdm.devices.events.CameraPerson.Person': { eventId: 'e-img-1', eventSessionId: 's-1' } }, Date.now());
    const f = join(dir, 'office_cam.jpg');
    await until(() => existsSync(f));
    assert.equal((await readFile(f)).toString(), 'jpeg-e-img-1');

    // Google forgets the image; Kova still has it.
    g.s.imgBroken = true;
    const d = reg.get('office_cam')!;
    const snap = await nest.snapshot(d);
    assert.equal(snap.body.toString(), 'jpeg-e-img-1');

    // A newer event replaces the cached frame.
    g.s.imgBroken = false;
    g.publish(OFFICE, { 'sdm.devices.events.CameraMotion.Motion': { eventId: 'e-img-2', eventSessionId: 's-2' } }, Date.now());
    await until(() => { try { return readFileSync(f).toString() === 'jpeg-e-img-2'; } catch { return false; } });
    await rm(dir, { recursive: true });
  } finally { await reg.stop(); await g.close(); }
});
