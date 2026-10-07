import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { CastAdapter } from '../src/adapters/cast/index.ts';
import { SonosAdapter } from '../src/adapters/sonos.ts';
import { encodeMessage, decodeMessage, NS } from '../src/adapters/cast/channel.ts';
import type { Queue } from '../src/adapters/sdk.ts';
import { audioDurationMs, chimeWav, sniffAudio } from '../src/services/clips.ts';
import { askHome } from './ask-helpers.ts';
import { Adhans, BUILTIN_ADHANS } from '../src/services/adhans.ts';

const CAUSE = { kind: 'automation' as const, label: 'Call' };
const CLIP = { url: 'http://10.0.0.2:8140/api/clip/abc.wav', title: 'Chime', contentType: 'audio/wav', durationMs: 1300 };

/** A Cast speaker that keeps a queue and says where it is in it (currentTime, the item's kova index). */
function fakeCast() {
  const log: { type: string; data: Record<string, unknown> }[] = [];
  const st = { appId: 'CC1AD845', running: false, level: 0.3, kova: 0, time: 0, state: 'PLAYING' };
  let sock: net.Socket | null = null;
  const status = (rid: unknown) => ({ type: 'MEDIA_STATUS', requestId: rid, status: st.running ? [{ mediaSessionId: 7, playerState: st.state, currentTime: st.time, currentItemId: 1, items: [{ itemId: 1, customData: { kova: st.kova } }] }] : [] });
  const server = net.createServer(s => {
    sock = s;
    let buf = Buffer.alloc(0);
    const reply = (source: string, namespace: string, data: Record<string, unknown>) => s.write(encodeMessage({ source, destination: 'sender-0', namespace, data }));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const m = decodeMessage(buf.subarray(4, 4 + buf.readUInt32BE(0)));
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        const type = String(m.data.type), rid = m.data.requestId;
        log.push({ type, data: m.data });
        if (m.namespace === NS.receiver) {
          if (type === 'LAUNCH') { st.appId = String(m.data.appId); st.running = true; }
          if (type === 'STOP') st.running = false;
          if (type === 'SET_VOLUME') { const v = m.data.volume as { level?: number }; if (v.level != null) st.level = v.level; }
          reply('receiver-0', NS.receiver, { type: 'RECEIVER_STATUS', requestId: rid, status: { volume: { level: st.level, muted: false }, applications: st.running ? [{ appId: st.appId, sessionId: 's', transportId: 'web-1' }] : [] } });
        } else if (m.namespace === NS.media) {
          if (type === 'LOAD' || type === 'QUEUE_LOAD') { st.running = true; st.state = 'PLAYING'; st.time = Number(m.data.currentTime ?? 0); st.kova = Number(((m.data.items as { customData: { kova: number } }[] | undefined)?.[0]?.customData.kova) ?? 0); }
          if (type === 'PAUSE') st.state = 'PAUSED';
          reply('web-1', NS.media, status(rid));
        }
      }
    });
  });
  return { server, log, st, finish: () => sock!.write(encodeMessage({ source: 'web-1', destination: '*', namespace: NS.media, data: { type: 'MEDIA_STATUS', status: [{ mediaSessionId: 7, playerState: 'IDLE', idleReason: 'FINISHED' }] } })) };
}

const queue = (): Queue => ({ label: 'Loved', shuffle: false, tracks: ['One', 'Two', 'Three'].map((t, i) => ({ id: `t${i}`, title: t, url: `http://helix/t${i}.flac`, contentType: 'audio/flac' })) });

test('Cast: snapshot the queue and the place in it, play the clip on its own, then resume the same song at the same time', async () => {
  const f = fakeCast();
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  const reg = new Registry(new Store(':memory:'));
  reg.queues = async () => queue();
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 5, endpoints: [{ id: 'aaaa0000000000000000000000000001', name: 'Kitchen speaker', model: 'Nest Audio', host: '127.0.0.1', port: (f.server.address() as AddressInfo).port }] });
  await reg.addAdapter(cast);
  const id = 'cast_aaaa0000000000000000000000000001';
  try {
    await reg.command(id, { on: true, media: 'Loved', vol: 30 }, CAUSE);
    // The speaker moved on: the second song, 42 s in.
    f.st.kova = 1; f.st.time = 42;
    const snap = await reg.snapshotPlayback(id);
    assert.equal((snap.exact as { queue: { index: number; position: number } }).queue.index, 1);
    assert.equal((snap.exact as { queue: { position: number } }).queue.position, 42);
    await reg.playClip(id, CLIP, 12, CAUSE);
    const load = f.log.filter(l => l.type === 'LOAD').pop()!;
    assert.equal((load.data.media as { contentId: string; streamType: string }).contentId, CLIP.url);
    assert.equal((load.data.media as { streamType: string }).streamType, 'BUFFERED', 'once, not as a live stream');
    assert.equal(f.st.level, 0.12);
    assert.equal(reg.get(id)!.state.media, 'Chime');
    // It played to the end: Kova hears the speaker go idle.
    f.finish();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(reg.get(id)!.state.on, false);
    const words = await reg.restorePlayback(id, snap, CAUSE);
    assert.equal(words, 'resumed Loved (Two at 0:42)');
    const back = f.log.filter(l => l.type === 'QUEUE_LOAD').pop()!;
    assert.equal((back.data.items as { customData: { kova: number } }[])[0]!.customData.kova, 1);
    assert.equal(back.data.currentTime, 42);
    assert.equal(f.st.level, 0.3, 'the volume it had');
    assert.equal(reg.get(id)!.state.media, 'Loved');
    assert.equal(reg.get(id)!.state.track?.title, 'Two');

    // Something another app cast can't be taken back: it says so.
    f.st.appId = 'SPOTIFY'; f.st.running = true;
    const other = await reg.snapshotPlayback(id);
    await reg.playClip(id, CLIP, 12, CAUSE);
    await assert.rejects(reg.restorePlayback(id, { ...other, state: { ...other.state, on: true, media: 'Casting' } }, CAUSE), /another app/);
    // Idle before: idle after.
    f.st.running = false;
    const idle = await reg.snapshotPlayback(id);
    await reg.playClip(id, CLIP, 12, CAUSE);
    assert.equal(await reg.restorePlayback(id, { ...idle, state: { on: false, media: null, vol: 30 } }, CAUSE), 'idle again');
    assert.equal(f.st.running, false);
  } finally { await reg.stop(); f.server.close(); }
});

/** A Sonos speaker on its own queue (track 3, 1:05 in, shuffled), enough UPnP for the adapter. */
function fakeSonos() {
  const calls: { action: string; body: string }[] = [];
  const st = { state: 'PLAYING', vol: 22, uri: 'x-rincon-queue:RINCON_ABC123#0', meta: '' };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/xml/device_description.xml') { res.end('<root><device><UDN>uuid:RINCON_ABC123</UDN><roomName>Lounge</roomName><displayName>Era 100</displayName></device></root>'); return; }
      const action = String(req.headers.soapaction).split('#')[1]!.replace('"', '');
      calls.push({ action, body });
      let inner = '';
      if (action === 'Play') st.state = 'PLAYING';
      if (action === 'SetAVTransportURI') st.uri = body.match(/<CurrentURI>([^<]*)</)![1]!.replace(/&amp;/g, '&');
      if (action === 'SetVolume') st.vol = Number(body.match(/<DesiredVolume>(\d+)</)![1]);
      if (action === 'GetTransportInfo') inner = `<CurrentTransportState>${st.state}</CurrentTransportState>`;
      if (action === 'GetVolume') inner = `<CurrentVolume>${st.vol}</CurrentVolume>`;
      if (action === 'GetMediaInfo') inner = `<CurrentURI>${esc(st.uri)}</CurrentURI><CurrentURIMetaData>${esc('<DIDL-Lite></DIDL-Lite>')}</CurrentURIMetaData>`;
      if (action === 'GetPositionInfo') inner = '<Track>3</Track><RelTime>0:01:05</RelTime>';
      if (action === 'GetTransportSettings') inner = '<PlayMode>SHUFFLE</PlayMode>';
      res.setHeader('content-type', 'text/xml');
      res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return { server, calls, st };
}

test('Sonos: the announcement takes the transport, then its own queue comes back at the same track and time, shuffled, playing', async () => {
  const f = fakeSonos();
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new SonosAdapter({ hosts: [`127.0.0.1:${(f.server.address() as AddressInfo).port}`], discover: false, pollMs: 0 }));
  const id = reg.list()[0]!.id;
  try {
    const snap = await reg.snapshotPlayback(id);
    await reg.playClip(id, CLIP, 9, CAUSE);
    assert.equal(f.st.uri, CLIP.url, 'played as a file, not as radio');
    assert.equal(f.st.vol, 9);
    const words = await reg.restorePlayback(id, { ...snap, state: { ...snap.state, vol: 22, on: true, media: 'Sonos' } }, CAUSE);
    const after = f.calls.slice(f.calls.findIndex(c => c.action === 'Play' && f.calls.indexOf(c) > f.calls.findIndex(x => x.action === 'SetAVTransportURI')) + 1).map(c => c.action);
    assert.deepEqual(after.filter(a => a !== 'GetVolume' && a !== 'GetTransportInfo'), ['SetVolume', 'SetAVTransportURI', 'Seek', 'Seek', 'SetPlayMode', 'Play']);
    assert.equal(f.st.uri, 'x-rincon-queue:RINCON_ABC123#0');
    assert.ok(f.calls.some(c => c.action === 'Seek' && /<Target>3</.test(c.body)));
    assert.ok(f.calls.some(c => c.action === 'Seek' && /<Target>0:01:05</.test(c.body)));
    assert.ok(f.calls.some(c => c.action === 'SetPlayMode' && /SHUFFLE/.test(c.body)));
    assert.equal(f.st.vol, 22);
    assert.match(words, /^resumed .* at track 3, 1:05$/);
  } finally { await reg.stop(); f.server.close(); }
});

test('Clips: audio only (by its bytes), a size limit, a duration, and served to speakers without a token, with ranges', async () => {
  const wav = chimeWav();
  assert.deepEqual(sniffAudio(wav), { contentType: 'audio/wav', ext: 'wav' });
  assert.equal(audioDurationMs(wav, 'wav'), 1300);
  assert.equal(sniffAudio(Buffer.from('<html><body>not audio</body></html>')), null);
  const dir = mkdtempSync(join(tmpdir(), 'kova-clips-'));
  const h = await askHome();
  // askHome has no data folder: clips need one.
  const r0 = await h.app.inject({ method: 'POST', url: '/api/clips?name=x', headers: { 'content-type': 'audio/wav' }, payload: wav });
  assert.equal(r0.statusCode, 503);
  await h.close();
  const { Hub } = await import('../src/hub.ts');
  const { buildServer } = await import('../src/api/server.ts');
  const { VirtualAdapter } = await import('../src/adapters/virtual.ts');
  const { demoConfig, demoDevices } = await import('../src/seed/demo-home.ts');
  const hub = new Hub({ dbPath: ':memory:', dataDir: dir, initialConfig: demoConfig, adapters: [new VirtualAdapter(demoDevices())], tickMs: 0 });
  await hub.start();
  const app = await buildServer(hub, { webRoot: join(import.meta.dirname, '../../web'), token: 'secret' });
  const auth = { authorization: 'Bearer secret' };
  try {
    let r = await app.inject({ method: 'POST', url: '/api/clips?name=Not%20audio', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: Buffer.from('<html>nope</html>') });
    assert.equal(r.statusCode, 415);
    r = await app.inject({ method: 'POST', url: '/api/clips?name=Front%20door%20chime', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: wav });
    assert.equal(r.statusCode, 200, r.body);
    const clip = r.json().clip;
    assert.equal(clip.name, 'Front door chime');
    assert.equal(clip.durationMs, 1300);
    r = await app.inject({ method: 'POST', url: '/api/clips?name=Big', headers: { ...auth, 'content-type': 'audio/mpeg' }, payload: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16 * 1024 * 1024)]) });
    assert.ok(r.statusCode === 413 || r.statusCode === 400, String(r.statusCode));
    // Speakers fetch it with no token; ranges work; anything else under /api still needs one.
    r = await app.inject({ method: 'GET', url: clip.url });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'audio/wav');
    r = await app.inject({ method: 'GET', url: clip.url, headers: { range: 'bytes=0-43' } });
    assert.equal(r.statusCode, 206);
    assert.equal(r.rawPayload.length, 44);
    assert.equal((await app.inject({ method: 'GET', url: '/api/clip/chime.wav' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/clip/000000000000000000000000.wav' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/clips' })).statusCode, 401);
    // Used by an automation: not removed until it's replaced there.
    hub.config.update(c => { c.automations = [{ id: 'a', name: 'Doorbell', enabled: true, mode: 'single', conditions: [], triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'announce', media: `clip:${clip.id}`, vol: 20, targets: { master_speaker: {} }, restore: true }] }]; });
    r = await app.inject({ method: 'DELETE', url: `/api/clips/${clip.id}`, headers: auth });
    assert.equal(r.statusCode, 409);
    assert.deepEqual(r.json().usedBy, ['Doorbell']);
    // A speaker's announcement loudness: 20–200, speakers only.
    r = await app.inject({ method: 'PATCH', url: '/api/devices/master_speaker/settings', headers: auth, payload: { announceTrim: 70 } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(hub.config.get().devices!.master_speaker!.announceTrim, 70);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/devices/master_speaker/settings', headers: auth, payload: { announceTrim: 500 } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/devices/lamp/settings', headers: auth, payload: { announceTrim: 80 } })).statusCode, 400);
    const s = (await app.inject({ url: '/api/state', headers: auth })).json();
    assert.equal(s.devices.find((d: { id: string }) => d.id === 'master_speaker').announceTrim, 70);
    assert.equal(s.devices.find((d: { id: string }) => d.id === 'lamp').canAnnounce, undefined);
    assert.equal(s.clips.length, 1);
  } finally { await app.close(); await hub.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('Built-in recordings: downloaded once on first use, kept, served from the hub; a failed download says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-adhans-'));
  let fetched = 0;
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200)]);
  const ad = new Adhans(dir, { fetch: (async () => { fetched++; return new Response(ogg); }) as typeof fetch });
  const a = BUILTIN_ADHANS.find(x => x.id === 'adhan:short')!;
  assert.equal(ad.ready(a), false);
  await Promise.all([ad.ensure(a), ad.ensure(a)]);
  await ad.ensure(a);
  assert.equal(fetched, 1);
  assert.equal(ad.serve(Adhans.file(a))?.contentType, 'audio/ogg');
  const bad = new Adhans(dir, { fetch: (async () => new Response('<html>blocked</html>')) as typeof fetch });
  await assert.rejects(bad.ensure(BUILTIN_ADHANS.find(x => x.id === 'adhan:azeez')!), /didn’t download as audio/);
  assert.ok(BUILTIN_ADHANS.every(x => x.page.startsWith('https://commons.wikimedia.org/wiki/File:') && x.licence && x.author));
  rmSync(dir, { recursive: true, force: true });
});
