import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { HelixAdapter, boxDeviceId, type BoxState } from '../src/adapters/helix.ts';
import { Assistant } from '../src/assistant/assistant.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

async function listen(handler: (req: http.IncomingMessage, body: any, send: (code: number, j?: unknown) => void) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      handler(req, body, (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A Helix box's remote port (tools/helix-remote): play and volume. */
async function fakeBox(state: BoxState) {
  const got: { path: string; body: any }[] = [];
  const srv = await listen((req, body, send) => { got.push({ path: req.url!, body }); send(200, { ok: true }); });
  return { ...srv, got, state };
}

/** Helix Server: pairing, boxes and their state through the relay, search and keep watching. */
async function fakeHelix(box: Awaited<ReturnType<typeof fakeBox>>) {
  const s = { approved: false, keys: [] as string[], polls: 0 };
  const TOKEN = 'hxd_' + 'b'.repeat(64);
  const items: Record<string, any> = {
    'helix:office': { id: 'helix:office', kind: 'show', title: 'The Office', hasFile: true, status: 'have' },
    'helix:s1': { id: 'helix:s1', kind: 'season', title: 'Season 1', seasonNo: 1, parentId: 'helix:office' },
    'helix:s0': { id: 'helix:s0', kind: 'season', title: 'Specials', seasonNo: 0, parentId: 'helix:office' },
    'helix:e1': { id: 'helix:e1', kind: 'episode', title: 'Pilot', seasonNo: 1, episodeNo: 1, parentId: 'helix:s1', hasFile: true, status: 'have' },
    'helix:e2': { id: 'helix:e2', kind: 'episode', title: 'Diversity Day', seasonNo: 1, episodeNo: 2, parentId: 'helix:s1', hasFile: true, status: 'have' },
    'helix:dune': { id: 'helix:dune', kind: 'movie', title: 'Dune: Part Two', year: 2024, hasFile: true, status: 'have' },
  };
  const srv = await listen((req, body, send) => {
    const u = new URL(req.url!, 'http://x');
    const p = u.pathname;
    if (p === '/v1/hello') return send(200, { helix: true, name: 'Helix Server', version: '2.0', port: 8090 });
    if (p === '/v1/pair/start') { assert.equal(body.name, 'Kova'); return send(200, { pairingId: 'p1', code: 'KVA234', expiresIn: 300, pollInterval: 1 }); }
    if (p === '/v1/pair/p1') { s.polls++; return send(200, s.approved ? { status: 'approved', token: TOKEN, deviceId: 'd-kova' } : { status: 'pending' }); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (p === '/v1/boxes') return send(200, { boxes: [{ id: 'd-lounge', name: 'Lounge Helix', client: 'helix-tv', remoteUrl: box.url, online: true }] });
    if (p === '/v1/boxes/d-lounge/state') return send(200, box.state);
    const k = /^\/v1\/boxes\/d-lounge\/key\/(\w+)$/.exec(p);
    if (k) { s.keys.push(k[1]); if (k[1] === 'playpause') box.state.paused = !box.state.paused; if (k[1] === 'back') box.state = { mode: 'browse', screen: 'Library' }; return send(200, { ok: true }); }
    if (p === '/v1/search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      return send(200, { items: Object.values(items).filter(i => (i.kind === 'show' || i.kind === 'movie') && i.title.toLowerCase().includes(q)) });
    }
    const ch = /^\/v1\/items\/([^/]+)\/children$/.exec(p);
    if (ch) return send(200, { items: Object.values(items).filter(i => i.parentId === decodeURIComponent(ch[1])) });
    if (p === '/v1/keep-watching') return send(200, { items: [{ item: items['helix:e2'], positionMs: 600_000, reason: 'resume' }] });
    send(404, { error: 'not found' });
  });
  return { ...srv, s, TOKEN };
}

test('Helix: pair with a code, boxes are TVs, play by name, pause for the doorbell, Movie starts by itself', async () => {
  const box = await fakeBox({ mode: 'browse', screen: 'Library', volume: 40 });
  const hx = await fakeHelix(box);
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const port = Number(new URL(hx.url).port);
  const app = await buildServer(t.hub, { webRoot, integrations: manager, lanApps: { helixFindHosts: ['127.0.0.1'], helixFindPort: port } });
  try {
    // Find it on the network, then pair: Kova shows a code and finishes by itself once it's typed in Helix.
    const found = (await app.inject({ method: 'GET', url: '/api/integrations/helix/find' })).json();
    assert.deepEqual(found.servers.map((x: { url: string }) => x.url), [hx.url]);
    const pr = await app.inject({ method: 'POST', url: '/api/integrations/helix/pair', payload: { url: hx.url } });
    assert.equal(pr.statusCode, 200, pr.body);
    assert.equal(pr.json().code, 'KVA234');
    assert.match(pr.json().next, /open Devices, type KVA234/);
    hx.s.approved = true;
    for (let i = 0; i < 40 && !manager.raw('helix')?.token; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(manager.raw('helix')?.token, hx.TOKEN);
    assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/helix/pair' })).json().status, 'approved');

    // Put the box in the lounge; it's a TV that can pause and find titles.
    await manager.update('helix', { ...manager.raw('helix'), rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
    const id = boxDeviceId('Lounge Helix');
    const d = t.hub.reg.get(id)!;
    assert.deepEqual({ type: d.type, room: d.room, caps: d.capabilities }, { type: 'tv', room: 'lounge', caps: ['onoff', 'media', 'volume', 'pause', 'library'] });
    const adapter = t.hub.reg.adapters.get('helix') as HelixAdapter;
    await adapter.poll();
    assert.deepEqual({ on: t.dev(id).on, vol: t.dev(id).vol }, { on: false, vol: 40 });

    // Kova suggests starting Movie with the box; accepting it ties Movie to the box.
    const f = t.hub.checker.findings().find(x => x.id.startsWith('movie-starts:'));
    assert.ok(f, 'suggested');
    assert.equal(f!.title, 'Start Movie when Lounge Helix plays a film');
    t.hub.checker.fix(f!.id);
    const movie = t.hub.config.get().overlays.find(o => o.id === 'movie')!;
    assert.deepEqual(movie.startsOn, { device: id, event: 'video-started' });
    assert.deepEqual(movie.ends, { kind: 'device_off', device: id });
    assert.ok(!t.hub.checker.findings().some(x => x.id.startsWith('movie-starts:')));

    // "play the office in the lounge": resumes the episode you were on, where you left off.
    const ask = new Assistant(t.hub.engine, t.hub.reg, t.hub.config);
    assert.deepEqual(ask.chips(ask.parse('play the office in the lounge')), ['Play', '“the office”', 'Lounge Helix']);
    const r = await ask.ask('play the office in the lounge');
    assert.equal(r.text, 'Playing Diversity Day on Lounge Helix.');
    assert.deepEqual(box.got.at(-1), { path: '/play', body: { itemId: 'helix:e2', positionMs: 600_000 } });

    // The box starts playing: Movie starts by itself (lamp down for the film).
    box.state = { mode: 'video', title: 'Diversity Day', eyebrow: 'S01E02', paused: false, volume: 40 };
    await adapter.poll();
    await new Promise(r => setImmediate(r));
    assert.equal(t.hub.engine.overlay?.id, 'movie');
    assert.equal(t.dev('lamp').bri, 8);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Lounge Helix started playing Diversity Day'));

    // The doorbell rings: the film pauses.
    t.hub.reg.deviceEvent('doorbell', 'ring');
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(hx.s.keys, ['playpause']);
    assert.equal(t.dev(id).paused, true);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Paused Lounge Helix: Doorbell rang'));
    // "carry on" picks up again; Movie is still on while paused.
    const c = await ask.ask('carry on');
    assert.equal(c.text, 'Carrying on: What’s playing.');
    assert.equal(box.state.paused, false);
    assert.equal(t.hub.engine.overlay?.id, 'movie');

    // Volume goes to the box; stopping leaves the player and Movie ends with it.
    await t.hub.engine.command(id, { vol: 25 });
    assert.deepEqual(box.got.at(-1), { path: '/volume', body: { level: 25 } });
    await t.hub.engine.command(id, { on: false, media: null });
    assert.equal(hx.s.keys.at(-1), 'back');
    await new Promise(r => setImmediate(r));
    assert.equal(t.hub.engine.overlay, null);

    // A film by name, from its own panel.
    await t.hub.engine.command(id, { on: true, media: 'dune' });
    assert.deepEqual(box.got.at(-1), { path: '/play', body: { itemId: 'helix:dune', positionMs: 0 } });
    assert.equal(t.dev(id).media, 'Dune: Part Two');
    await assert.rejects(t.hub.reg.command(id, { on: true, media: 'nothing like this' }, { kind: 'user', label: 'You' }), /nothing called “nothing like this”/);
  } finally {
    await app.close();
    await t.hub.stop();
    await hx.close();
    await box.close();
  }
});
