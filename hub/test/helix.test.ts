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

async function listen(handler: (req: http.IncomingMessage, body: any, send: (code: number, j?: unknown) => void, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      handler(req, body, (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); }, res);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Helix Server: pairing, boxes, control through /v1/players, /v1/resolve, and playback events on /v1/events. */
async function fakeHelix() {
  const s = {
    approved: false, polls: 0,
    box: { mode: 'browse', screen: 'Library', volume: 40 } as BoxState,
    control: [] as { verb: string; body: any }[],
    streams: [] as { res: http.ServerResponse; lastId?: string }[],
    seq: 0,
    feed: true,
  };
  const TOKEN = 'hxd_' + 'b'.repeat(64);
  const items: Record<string, any> = {
    office: { id: 'helix:e2', kind: 'episode', title: 'Diversity Day', show: 'The Office', season: 1, episode: 2 },
    dune: { id: 'helix:dune', kind: 'movie', title: 'Dune: Part Two', year: 2024 },
  };
  const srv = await listen((req, body, send, res) => {
    const u = new URL(req.url!, 'http://x');
    const p = u.pathname;
    if (p === '/v1/hello') return send(200, { helix: true, name: 'Helix Server', version: '2.0', port: 8090 });
    if (p === '/v1/pair/start') { assert.equal(body.name, 'Kova'); return send(200, { pairingId: 'p1', code: 'KVA234', expiresIn: 300, pollInterval: 1 }); }
    if (p === '/v1/pair/p1') { s.polls++; return send(200, s.approved ? { status: 'approved', token: TOKEN, deviceId: 'd-kova' } : { status: 'pending' }); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (p === '/v1/events' && /event-stream/.test(String(req.headers.accept))) {
      if (!s.feed) return send(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`retry: 5000\n\nevent: hello\ndata: ${JSON.stringify({ v: 1, lastId: s.seq })}\n\n`);
      const st = { res, lastId: req.headers['last-event-id'] as string | undefined };
      s.streams.push(st);
      res.on('close', () => { const i = s.streams.indexOf(st); if (i >= 0) s.streams.splice(i, 1); });
      return;
    }
    if (p === '/v1/boxes') return send(200, { boxes: [{ id: 'd-lounge', name: 'Lounge Helix', client: 'helix-tv', online: true }] });
    if (p === '/v1/boxes/d-lounge/state') return send(200, s.box);
    if (p === '/v1/resolve') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      if (q.includes('office')) return send(200, { item: items.office, positionMs: 600_000, reason: 'resume', confidence: 0.9, alternatives: [] });
      if (q.includes('dune')) return send(200, { item: items.dune, positionMs: 0, reason: 'start', confidence: 0.9, alternatives: [] });
      return send(404, { error: 'Nothing in the library matches that.' });
    }
    const c = /^\/v1\/players\/d-lounge\/(\w+)$/.exec(p);
    if (c && req.method === 'POST') { s.control.push({ verb: c[1], body }); if (c[1] === 'volume') s.box.volume = body.level; return send(200, { ok: true }); }
    send(404, { error: 'not found' });
  });
  /** Publish a playback event, as Helix does: the event's data plus type and at. */
  const publish = (type: string, data: Record<string, unknown>) => {
    const id = ++s.seq;
    for (const st of s.streams) st.res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ ...data, type, at: Date.now() })}\n\n`);
  };
  const drop = () => { for (const st of s.streams.splice(0)) st.res.end(); };
  const player = { id: 'd-lounge', name: 'Lounge Helix', client: 'helix-tv' };
  return { ...srv, s, TOKEN, items, publish, drop, player, close: async () => { drop(); await srv.close(); } };
}

test('Helix: pair with a code, boxes are TVs, play by name, pause for the doorbell, Movie starts by itself', { timeout: 30_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const port = Number(new URL(hx.url).port);
  const app = await buildServer(t.hub, { webRoot, integrations: manager, lanApps: { helixFindHosts: ['127.0.0.1'], helixFindPort: port } });
  const until = async (what: string, ok: () => boolean, ms = 4000) => {
    for (let i = 0; i < ms && !ok(); i += 20) await new Promise(r => setTimeout(r, 20));
    assert.ok(ok(), `timed out waiting for ${what}`);
  };
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

    // Put the box in the lounge; it's a TV that can pause and find titles. Kova follows Helix's live feed.
    await manager.update('helix', { ...manager.raw('helix'), rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
    const id = boxDeviceId('Lounge Helix');
    const d = t.hub.reg.get(id)!;
    assert.deepEqual({ type: d.type, room: d.room, caps: d.capabilities }, { type: 'tv', room: 'lounge', caps: ['onoff', 'media', 'volume', 'pause', 'library'] });
    const adapter = t.hub.reg.adapters.get('helix') as HelixAdapter;
    await until('live', () => adapter.following && hx.s.streams.length === 1);
    assert.match(adapter.status().note ?? '', /1 box · live/);
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

    // "play the office in the lounge": Helix decides what (the episode you were on, where you left off),
    // and the server tells the box: nothing goes to the box's own port.
    const ask = new Assistant(t.hub.engine, t.hub.reg, t.hub.config);
    assert.deepEqual(ask.chips(ask.parse('play the office in the lounge')), ['Play', '“the office”', 'Lounge Helix']);
    const r = await ask.ask('play the office in the lounge');
    assert.equal(r.text, 'Playing Diversity Day on Lounge Helix.');
    assert.deepEqual(hx.s.control.at(-1), { verb: 'play', body: { itemId: 'helix:e2', positionMs: 600_000 } });

    // The box starts playing (an event on the feed, no polling): Movie starts by itself (lamp down for the film).
    hx.publish('playback.started', { player: hx.player, item: hx.items.office, state: 'playing', positionMs: 600_000, durationMs: 1_320_000 });
    await until('Movie', () => t.hub.engine.overlay?.id === 'movie');
    assert.equal(t.dev('lamp').bri, 8);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Lounge Helix started playing Diversity Day'));

    // The doorbell rings: the film pauses.
    t.hub.reg.deviceEvent('doorbell', 'ring');
    await until('paused', () => hx.s.control.at(-1)?.verb === 'pause');
    assert.equal(t.dev(id).paused, true);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Paused Lounge Helix: Doorbell rang'));
    hx.publish('playback.paused', { player: hx.player, item: hx.items.office, state: 'paused' });
    // "carry on" picks up again; Movie is still on while paused.
    const c = await ask.ask('carry on');
    assert.equal(c.text, 'Carrying on: What’s playing.');
    assert.equal(hx.s.control.at(-1)?.verb, 'resume');
    assert.equal(t.hub.engine.overlay?.id, 'movie');
    hx.publish('playback.resumed', { player: hx.player, item: hx.items.office, state: 'playing' });
    await until('resumed', () => t.dev(id).paused === false);

    // Volume goes through the server; stopping does too, and Movie ends with it.
    await t.hub.engine.command(id, { vol: 25 });
    assert.deepEqual(hx.s.control.at(-1), { verb: 'volume', body: { level: 25 } });
    await t.hub.engine.command(id, { on: false, media: null });
    assert.equal(hx.s.control.at(-1)?.verb, 'stop');
    await new Promise(r => setImmediate(r));
    assert.equal(t.hub.engine.overlay, null);
    hx.publish('playback.stopped', { player: hx.player, item: hx.items.office, state: 'stopped', reason: 'stopped' });

    // Something started on the TV itself, with Kova not involved: Kova still knows, and Movie starts again.
    hx.publish('playback.started', { player: hx.player, item: hx.items.dune, state: 'playing' });
    await until('Dune playing', () => t.dev(id).media === 'Dune: Part Two');
    await until('Movie again', () => t.hub.engine.overlay?.id === 'movie');
    hx.publish('playback.ended', { player: hx.player, item: hx.items.dune, state: 'stopped' });
    await until('ended', () => t.dev(id).on === false);

    // The feed drops: Kova reconnects from the last event it saw, and catches up by reading the box once.
    const seen = hx.s.seq;
    hx.drop();
    await until('reconnected', () => hx.s.streams.length === 1, 8000);
    assert.equal(hx.s.streams[0].lastId, String(seen));

    // A film by name, from its own panel. Nothing found is said plainly.
    await t.hub.engine.command(id, { on: true, media: 'dune' });
    assert.deepEqual(hx.s.control.at(-1), { verb: 'play', body: { itemId: 'helix:dune', positionMs: 0 } });
    assert.equal(t.dev(id).media, 'Dune: Part Two');
    await assert.rejects(t.hub.reg.command(id, { on: true, media: 'nothing like this' }, { kind: 'user', label: 'You' }), /nothing called “nothing like this”/);
  } finally {
    await app.close();
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix without playback events: Kova reads the boxes itself', { timeout: 15_000 }, async () => {
  const hx = await fakeHelix();
  hx.s.feed = false;
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(adapter.following, false);
    const events: string[] = [];
    t.hub.reg.on('event', e => events.push(`${e.type}:${e.data.title}`));
    hx.s.box = { mode: 'video', title: 'Diversity Day', eyebrow: 'S01E02', paused: false, volume: 30 };
    await adapter.poll();
    assert.deepEqual({ on: t.dev(id).on, media: t.dev(id).media, vol: t.dev(id).vol }, { on: true, media: 'Diversity Day', vol: 30 });
    hx.s.box = { mode: 'browse', screen: 'Library', volume: 30 };
    await adapter.poll();
    assert.deepEqual(events, ['video-started:Diversity Day', 'stopped:Diversity Day']);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});
