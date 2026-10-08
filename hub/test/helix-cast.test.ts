import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { buildServer } from '../src/api/server.ts';
import { HelixMusic } from '../src/services/helix-music.ts';
import { HelixLink } from '../src/services/helix-link.ts';
import type { HomeConfig } from '../src/model/types.ts';
import { FakeSpeakers } from './fake-speakers.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Helix as Kova reaches it: signs a song again (play-url) and counts plays. */
async function fakeHelix() {
  const signed: { id: string; body: any }[] = [], played: { id: string; body: any }[] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const p = new URL(req.url!, 'http://x').pathname;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const pu = /^\/v1\/items\/([^/]+)\/play-url$/.exec(p);
      if (pu) { signed.push({ id: pu[1]!, body }); return send(200, { path: `/v1/items/${pu[1]}/file?format=${body.format}&sig=kova`, expiresAt: Math.floor(Date.now() / 1000) + 21600, format: body.format }); }
      const pl = /^\/v1\/music\/tracks\/([^/]+)\/played$/.exec(p);
      if (pl) { played.push({ id: pl[1]!, body }); return send(200, { ok: true }); }
      if (p === '/v1/client/features') return send(200, { players: { music: true } });
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, signed, played, close: () => new Promise<void>(r => server.close(() => r())) };
}

const song = (n: number) => ({
  id: `helix:i${n}`, path: `/v1/items/i${n}/file?exp=1&format=flac&maxRate=48000&p=sam&sig=s${n}`, url: `http://phone-saw-this/v1/items/i${n}`,
  expiresAt: Math.floor(Date.now() / 1000) + 21600, contentType: 'audio/flac', title: `Song ${n}`, artist: 'Artist', album: 'Album',
  artPath: `/v1/images/i${n}?exp=1&sig=a${n}`, durationMs: 1500,
});

async function home() {
  const hx = await fakeHelix();
  const fc = new FakeSpeakers('cast', 'Google Cast', [
    { id: 'kitchen', name: 'Kitchen speaker', room: 'kitchen' }, { id: 'dining', name: 'Dining speaker', room: 'kitchen' }, { id: 'office', name: 'Office speaker', room: 'office' },
  ], { groups: [{ id: 'home', name: 'Home speakers', members: ['kitchen', 'dining'] }], seekLatency: 10 });
  const fs = new FakeSpeakers('sonos', 'Sonos', [{ id: 'ray', name: 'Ray', room: 'lounge' }], { dynamic: true, seekLatency: 10 });
  const dir = mkdtempSync(join(tmpdir(), 'kova-cast-'));
  const hub = new Hub({
    dbPath: ':memory:', dataDir: dir, tickMs: 0,
    initialConfig: () => { const c: HomeConfig = demoConfig(); c.speakerGroups = [{ id: 'whole', name: 'Whole home', members: ['kitchen', 'dining', 'ray'] }]; return c; },
    adapters: [new VirtualAdapter(demoDevices()), fc, fs],
    groupSync: { checkMs: 0, marginMs: 20, measureMs: 1500, pollMs: 50 },
  });
  await hub.start();
  const helix = { url: hx.base, token: 'hx-token', musicProfile: 'default' };
  hub.useMusic(new HelixMusic(() => helix));
  const link = new HelixLink(hub, { helix: () => helix, dataDir: dir, port: () => 8140, debounceMs: 0, watchMs: 0 });
  const app = await buildServer(hub, { webRoot, token: 'master', helixLink: link });
  const as = (key: string) => (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
  return { hub, fc, fs, hx, app, helixCall: as(link.token), owner: as('master'), close: async () => { await app.close(); await hub.stop(); await hx.close(); } };
}

test('Helix casting: Helix’s token lists the speakers and groups, plays its queue on them together, and sees it playing', async () => {
  const h = await home();
  try {
    const list = (await h.helixCall('GET', '/api/helix/speakers')).json().speakers as any[];
    const by = (id: string) => list.find(s => s.id === id);
    assert.ok(by('kitchen') && by('ray') && by('group_whole'), list.map(s => s.id).join(','));
    assert.equal(by('group_whole').kind, 'group');
    assert.deepEqual(by('group_whole').members, ['kitchen', 'dining', 'ray']);
    assert.equal(by('kitchen').playing, null);
    // Something that isn't a queue (an announcement, a radio stream) still shows as playing, by its name.
    (h.fc as unknown as { ctx: { report(id: string, s: object): void } }).ctx.report('dining', { on: true, media: 'Adhan' });
    const dining = ((await h.helixCall('GET', '/api/helix/speakers')).json().speakers as any[]).find(s => s.id === 'dining');
    assert.deepEqual([dining.playing.state, dining.playing.track.title, dining.playing.queue], ['playing', 'Adhan', []]);
    (h.fc as unknown as { ctx: { report(id: string, s: object): void } }).ctx.report('dining', { on: false, media: null });
    assert.ok(!list.some(s => s.id === 'lounge_main'), 'a light isn’t a speaker');
    // Helix's token reaches only these (and its TVs); a device command for a light is still refused.
    assert.equal((await h.helixCall('POST', '/api/devices/lounge_main', { on: true })).statusCode, 401);

    const r = await h.helixCall('POST', '/api/helix/play', { targets: ['group_whole', 'office'], session: 'hx-3f2a9c01d4e5b6a7', profile: 'sam', label: 'Helix', tracks: [song(1), song(2), song(3)], index: 0, positionMs: 0 });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true, session: 'hx-3f2a9c01d4e5b6a7' });
    await sleep(300);
    // Every speaker plays it (the group's Cast part as one stream, Ray alongside; the office speaker too).
    const media = h.hub.reg.get('office')!.state.media!;
    assert.match(media, /^Helix · b6a7$/);
    for (const id of ['kitchen', 'dining', 'ray', 'office']) assert.equal(h.hub.reg.get(id)!.state.media, media, id);
    const now = (await h.helixCall('GET', '/api/helix/speakers')).json().speakers as any[];
    const office = now.find(s => s.id === 'office').playing;
    assert.equal(office.session, 'hx-3f2a9c01d4e5b6a7');
    assert.equal(office.state, 'playing');
    assert.equal(office.track.id, 'helix:i1');
    assert.equal(office.queue.length, 3);
    assert.equal(office.queue[1].title, 'Song 2');
    assert.ok(office.positionMs >= 0 && office.positionMs < 1500);
    assert.equal(now.find(s => s.id === 'group_whole').playing.session, 'hx-3f2a9c01d4e5b6a7');
    // The song URLs are Helix's paired address plus the path; never the address the phone saw. Helix signed FLAC; a
    // speaker that takes AAC got its own, signed for the profile Helix cast for.
    assert.ok(h.hx.signed.every(x => x.body.profile === 'sam'), JSON.stringify(h.hx.signed));
  } finally { await h.close(); }
});

test('Helix casting: control acts on the whole session (pause, seek, jump, stop); volume and mute on the one named; songs added; errors in words', async () => {
  const h = await home();
  try {
    // A speaker turned all the way down at the speaker: brought back to its last level, so the cast is heard.
    await h.hub.reg.command('office', { vol: 35 }, { kind: 'user', label: 'You' });
    (h.fc as unknown as { ctx: { report(id: string, s: object): void } }).ctx.report('office', { vol: 0 });
    await h.helixCall('POST', '/api/helix/play', { targets: ['kitchen', 'office'], session: 'hx-1', tracks: [song(1), song(2), song(3)] });
    assert.equal(h.hub.reg.get('office')!.state.vol, 35, 'not left at 0');
    await sleep(200);
    const ctl = (b: object) => h.helixCall('POST', '/api/helix/control', b);
    assert.equal((await ctl({ targets: ['kitchen'], action: 'pause' })).statusCode, 200);
    assert.equal(h.hub.reg.get('office')!.state.paused, true, 'the session’s other speaker too');
    await ctl({ targets: ['kitchen'], action: 'resume' });
    assert.equal(h.hub.reg.get('office')!.state.paused, false);
    // Jump to the third song, then seek in it: every speaker of the session moved.
    const n = h.fc.seeks.length;
    assert.equal((await ctl({ targets: ['office'], action: 'jump', index: 2 })).statusCode, 200);
    assert.ok(h.fc.seeks.slice(n).some(x => x.index === 2 && x.id === 'kitchen') && h.fc.seeks.slice(n).some(x => x.index === 2 && x.id === 'office'));
    assert.match((await ctl({ targets: ['office'], action: 'jump', index: 9 })).json().error, /0–2/);
    // Volume and mute: only the speaker named.
    await ctl({ targets: ['office'], action: 'volume', volume: 40 });
    assert.equal(h.hub.reg.get('office')!.state.vol, 40);
    await ctl({ targets: ['office'], action: 'mute', muted: true });
    assert.equal(h.hub.reg.get('office')!.state.vol, 0);
    assert.equal(((await h.helixCall('GET', '/api/helix/speakers')).json().speakers as any[]).find(s => s.id === 'office').muted, true);
    await ctl({ targets: ['office'], action: 'mute' });
    assert.equal(h.hub.reg.get('office')!.state.vol, 40, 'toggled back to where it was');
    // Songs added at the end.
    const q = await h.helixCall('POST', '/api/helix/queue', { targets: ['kitchen'], at: 'end', tracks: [song(4)] });
    assert.deepEqual(q.json(), { ok: true, length: 4 });
    // Stop: the session's speakers stop; adding then is a 409 (Helix plays instead).
    await ctl({ targets: ['kitchen'], action: 'stop' });
    assert.equal(h.hub.reg.get('office')!.state.on, false);
    assert.equal((await h.helixCall('POST', '/api/helix/queue', { targets: ['kitchen'], at: 'end', tracks: [song(5)] })).statusCode, 409);
    // Words for what's wrong.
    assert.equal((await h.helixCall('POST', '/api/helix/play', { targets: ['nope'], tracks: [song(1)] })).statusCode, 404);
    assert.equal((await h.helixCall('POST', '/api/helix/play', { targets: ['kitchen'], tracks: [] })).statusCode, 400);
    assert.equal((await ctl({ targets: ['kitchen'], action: 'dance' })).statusCode, 400);
    // The owner's key reaches them too.
    assert.equal((await h.owner('GET', '/api/helix/speakers')).statusCode, 200);
  } finally { await h.close(); }
});
