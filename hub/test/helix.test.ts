import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { HelixAdapter, boxDeviceId, type BoxState, type HelixPlayer } from '../src/adapters/helix.ts';
import { Assistant } from '../src/assistant/assistant.ts';
import { KOVA_VERSION } from '../src/version.ts';
import { helixScreens } from '../src/services/helix-link.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const BOX = 'd-0123456789abcdef';

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

/**
 * Helix Server as Kova uses it: pairing, the players (the box, Kova itself, a phone), each box's screen, control through
 * /v1/players, /v1/resolve, the live feed on /v1/events. It keeps what Kova must never do: call /v1/boxes, poll a
 * suspended box's screen, call the box's power, input or soundbar, or /v1/boxes/{id}/wake|sleep.
 */
async function fakeHelix(o: { profile?: string; locked?: boolean } = {}) {
  const profile = o.profile ?? 'default';
  const s = {
    approved: false, polls: 0,
    box: { mode: 'browse', screen: 'Library', volume: 40, muted: false } as BoxState,
    players: [
      { id: BOX, name: 'Lounge Helix', client: 'helix-tv', box: true, online: true, asleep: false, suspended: false, capabilities: ['notify', 'sleep', 'wake'], playback: null },
      { id: 'd-aaaaaaaaaaaaaaaa', name: 'Kova', client: `kova/${KOVA_VERSION}`, box: false, you: true, online: true },
      { id: 'd-bbbbbbbbbbbbbbbb', name: 'Phone', client: 'helix-mobile', box: false, online: true },
    ] as HelixPlayer[],
    control: [] as { verb: string; body: any }[],
    streams: [] as { res: http.ServerResponse; lastId?: string; after?: string | null }[],
    seq: 0, feed: true,
    /** Calls Kova must never make. */
    wrong: [] as string[],
    playersReads: 0, stateReads: 0,
    /** How long a suspended box takes to wake after /wake. */
    wakeMs: 150,
  };
  const TOKEN = 'hxd_' + 'b'.repeat(64);
  const items: Record<string, any> = {
    office: { id: 'helix:e2', kind: 'episode', title: 'Diversity Day', show: 'The Office', season: 1, episode: 2 },
    dune: { id: 'helix:dune', kind: 'movie', title: 'Dune: Part Two', year: 2024 },
  };
  const player = (id = BOX) => s.players.find(p => p.id === id)!;
  let publish: (type: string, data: Record<string, unknown>, id?: number) => void = () => {};
  const srv = await listen((req, body, send, res) => {
    const u = new URL(req.url!, 'http://x');
    const p = u.pathname;
    if (p === '/v1/hello') return send(200, { helix: true, name: 'Helix Server', version: '2.0', port: 8090 });
    assert.equal(req.headers['x-helix-client'], `kova/${KOVA_VERSION}`);
    if (p === '/v1/pair/start') { assert.equal(body.name, 'Kova'); return send(200, { pairingId: 'p1', code: 'KVA234', expiresIn: 300, pollInterval: 1 }); }
    if (p === '/v1/pair/p1') { s.polls++; return send(200, s.approved ? { status: 'approved', token: TOKEN, deviceId: 'd-kova' } : { status: 'pending' }); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    assert.equal(req.headers['x-helix-profile'], profile);
    if (p === '/v1/boxes' || p === '/v1/boxes/hello' || /^\/v1\/boxes\/[^/]+\/(wake|sleep)$/.test(p) || /^\/v1\/players\/[^/]+\/(power|input|soundbar)$/.test(p)) {
      s.wrong.push(`${req.method} ${p}`);
      return send(403, { error: 'not for Kova' });
    }
    if (p === '/v1/client/features') return send(200, { players: { enabled: true, music: true, notices: true, devices: true } });
    if (p === '/v1/playlists') return o.locked ? send(403, { error: `profile ${profile} is locked` }) : send(200, { playlists: [] });
    if (p === '/v1/events') {
      if (!s.feed) return send(404, { error: 'not found' });
      if (!/event-stream/.test(String(req.headers.accept)) && u.searchParams.get('stream') !== '1') return send(200, { events: [] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`retry: 5000\n\nevent: hello\ndata: ${JSON.stringify({ v: 1, lastId: s.seq })}\n\n`);
      const st = { res, lastId: req.headers['last-event-id'] as string | undefined, after: u.searchParams.get('after') };
      s.streams.push(st);
      res.on('close', () => { const i = s.streams.indexOf(st); if (i >= 0) s.streams.splice(i, 1); });
      return;
    }
    if (p === '/v1/players' && req.method === 'GET') { s.playersReads++; return send(200, { players: s.players }); }
    const bs = /^\/v1\/boxes\/([^/]+)\/state$/.exec(p);
    if (bs) {
      s.stateReads++;
      if (player(bs[1])?.suspended) { s.wrong.push(`GET ${p} (suspended)`); return setTimeout(() => send(502, { error: 'box asleep' }), 50); }
      return send(200, s.box);
    }
    if (p === '/v1/resolve') {
      assert.equal(u.searchParams.get('profile'), profile);
      if (o.locked) return send(403, { error: `profile ${profile} is locked` });
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      if (q.includes('office')) return send(200, { item: items.office, positionMs: 600_000, reason: 'resume', confidence: 0.9, alternatives: [] });
      if (q.includes('dune')) return send(200, { item: items.dune, positionMs: 0, reason: 'start', confidence: 0.9, alternatives: [] });
      return send(404, { error: 'Nothing in the library matches that.' });
    }
    const c = /^\/v1\/players\/([^/]+)\/(\w+)$/.exec(p);
    if (c && req.method === 'POST') {
      const pl = player(c[1]);
      if (!pl) return send(404, { error: 'no such player' });
      s.control.push({ verb: c[2], body });
      if (c[2] === 'play' && pl.suspended) return send(502, { error: 'box suspended' });
      if (c[2] === 'volume') s.box.volume = body.level;
      if (c[2] === 'mute') s.box.muted = body.muted;
      if (c[2] === 'sleep') { pl.asleep = true; publish('screen.asleep', { player: { id: pl.id, name: pl.name }, reason: 'sleep', by: 'controller' }); }
      if (c[2] === 'wake' && pl.suspended) {
        setTimeout(() => { pl.suspended = false; pl.asleep = false; publish('screen.awake', { player: { id: pl.id, name: pl.name }, reason: 'wake', by: 'suspend' }); }, s.wakeMs).unref();
        return send(200, { waking: true });
      }
      if (c[2] === 'wake') { pl.asleep = false; publish('screen.awake', { player: { id: pl.id, name: pl.name }, reason: 'wake', by: 'controller' }); }
      return send(200, { ok: true });
    }
    send(404, { error: 'not found' });
  });
  /** Publish an event, as Helix does: the event's data plus type and at. `id` repeats one (a replay). */
  publish = (type, data, id) => {
    const n = id ?? ++s.seq;
    for (const st of s.streams) st.res.write(`id: ${n}\nevent: ${type}\ndata: ${JSON.stringify({ ...data, type, at: Date.now() })}\n\n`);
  };
  const drop = () => { for (const st of s.streams.splice(0)) st.res.end(); };
  const me = { id: BOX, name: 'Lounge Helix', client: 'helix-tv' };
  return { ...srv, s, TOKEN, items, publish: (t: string, d: Record<string, unknown>, id?: number) => publish(t, d, id), drop, player: me, box: player, close: async () => { drop(); await srv.close(); } };
}

const waitFor = async (what: string, ok: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms && !ok(); i += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test('Helix: pair with a code, boxes are TVs, play by name, pause for the doorbell, Movie starts by itself', { timeout: 30_000 }, async () => {
  const hx = await fakeHelix();
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

    // Put the box in the lounge; it's a TV that can pause and find titles (not Kova itself, not the phone), known by
    // Helix's stable id. Kova follows Helix's live feed.
    await manager.update('helix', { ...manager.raw('helix'), rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
    const id = boxDeviceId('Lounge Helix');
    const d = t.hub.reg.get(id)!;
    assert.deepEqual({ type: d.type, room: d.room, caps: d.capabilities, address: d.address }, { type: 'tv', room: 'lounge', caps: ['onoff', 'media', 'volume', 'mute', 'pause', 'library', 'extras'], address: BOX });
    assert.equal(t.hub.reg.list().filter(x => x.adapter === 'helix').length, 1);
    const adapter = t.hub.reg.adapters.get('helix') as HelixAdapter;
    await waitFor('live', () => adapter.following && hx.s.streams.length === 1);
    assert.match(adapter.status().note ?? '', /1 box · live/);
    assert.deepEqual({ on: t.dev(id).on, vol: t.dev(id).vol, muted: t.dev(id).muted }, { on: false, vol: 40, muted: false });

    // Kova suggests starting Movie with the box; accepting it ties Movie to the box.
    const f = t.hub.checker.findings().find(x => x.id.startsWith('movie-starts:'));
    assert.ok(f, 'suggested');
    assert.equal(f!.title, 'Start Movie when Lounge Helix plays a film');
    t.hub.checker.fix(f!.id);
    const movie = t.hub.config.get().overlays.find(o => o.id === 'movie')!;
    assert.deepEqual(movie.startsOn, { device: id, event: 'video-started' });
    assert.deepEqual(movie.ends, { kind: 'device_off', device: id });

    // "play the office in the lounge": Helix decides what (for Kova's profile), and the server tells the box.
    const ask = new Assistant(t.hub.engine, t.hub.reg, t.hub.config);
    assert.deepEqual(ask.chips(ask.parse('play the office in the lounge')), ['Play', '“the office”', 'Lounge Helix']);
    const r = await ask.ask('play the office in the lounge');
    assert.equal(r.text, 'Playing Diversity Day on Lounge Helix.');
    assert.deepEqual(hx.s.control.at(-1), { verb: 'play', body: { itemId: 'helix:e2', positionMs: 600_000, profile: 'default' } });

    // The box starts playing (an event on the feed, no polling): Movie starts by itself (lamp down for the film).
    hx.publish('playback.started', { player: hx.player, item: hx.items.office, state: 'playing', positionMs: 600_000, durationMs: 1_320_000 });
    await waitFor('Movie', () => t.hub.engine.overlay?.id === 'movie');
    assert.equal(t.dev('lamp').bri, 8);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Lounge Helix started playing Diversity Day'));

    // The doorbell rings: the film pauses.
    t.hub.reg.deviceEvent('doorbell', 'ring');
    await waitFor('paused', () => hx.s.control.at(-1)?.verb === 'pause');
    assert.equal(t.dev(id).paused, true);
    hx.publish('playback.paused', { player: hx.player, item: hx.items.office, state: 'paused' });
    const c = await ask.ask('carry on');
    assert.equal(c.text, 'Carrying on: What’s playing.');
    assert.equal(hx.s.control.at(-1)?.verb, 'resume');
    hx.publish('playback.resumed', { player: hx.player, item: hx.items.office, state: 'playing' });
    await waitFor('resumed', () => t.dev(id).paused === false);

    // Volume and mute are the box's own (it has no soundbar).
    await t.hub.engine.command(id, { vol: 25 });
    assert.deepEqual(hx.s.control.at(-1), { verb: 'volume', body: { level: 25 } });
    await t.hub.engine.command(id, { muted: true });
    assert.deepEqual(hx.s.control.at(-1), { verb: 'mute', body: { muted: true } });
    // Off stops what plays and puts the screen to sleep; Movie ends with it.
    hx.s.control.length = 0;
    await t.hub.engine.command(id, { on: false, media: null });
    assert.deepEqual(hx.s.control.map(x => x.verb), ['stop', 'sleep']);
    await new Promise(r => setImmediate(r));
    assert.equal(t.hub.engine.overlay, null);
    hx.publish('playback.stopped', { player: hx.player, item: hx.items.office, state: 'stopped', reason: 'stopped' });

    // Something started on the TV itself: Kova still knows, and Movie starts again. It ends: stopped and ended.
    const events: string[] = [];
    t.hub.reg.on('event', e => { if (e.device.id === id) events.push(e.type); });
    hx.publish('playback.started', { player: hx.player, item: hx.items.dune, state: 'playing' });
    await waitFor('Dune playing', () => t.dev(id).media === 'Dune: Part Two');
    await waitFor('Movie again', () => t.hub.engine.overlay?.id === 'movie');
    hx.publish('playback.ended', { player: hx.player, item: hx.items.dune, state: 'stopped' });
    await waitFor('ended', () => t.dev(id).on === false);
    assert.deepEqual(events.filter(e => e !== 'screen-asleep' && e !== 'screen-awake').slice(-3), ['video-started', 'stopped', 'ended']);

    // The feed drops: Kova reconnects from the last event it saw (?after= and Last-Event-ID).
    const seen = hx.s.seq;
    hx.drop();
    await waitFor('reconnected', () => hx.s.streams.length === 1, 8000);
    assert.equal(hx.s.streams[0].lastId, String(seen));
    assert.equal(hx.s.streams[0].after, String(seen));

    // A film by name, from its own panel. Nothing found is said plainly.
    await t.hub.engine.command(id, { on: true, media: 'dune' });
    assert.deepEqual(hx.s.control.at(-1), { verb: 'play', body: { itemId: 'helix:dune', positionMs: 0, profile: 'default' } });
    assert.equal(t.dev(id).media, 'Dune: Part Two');
    await assert.rejects(t.hub.reg.command(id, { on: true, media: 'nothing like this' }, { kind: 'user', label: 'You' }), /nothing called “nothing like this”/);
    assert.deepEqual(hx.s.wrong, []);
  } finally {
    await app.close();
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix feed: events replayed after a reconnect count once; players are read again only when the feed says so; reset reads them', { timeout: 20_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    await waitFor('live', () => adapter.following && hx.s.streams.length === 1);
    await new Promise(r => setTimeout(r, 300));
    const events: string[] = [];
    t.hub.reg.on('event', e => events.push(e.type));
    const reads = hx.s.playersReads;
    hx.publish('playback.started', { player: hx.player, item: hx.items.office, state: 'playing' });
    await waitFor('playing', () => t.dev(id).on === true);
    // The same event again (a replay after a reconnect), and progress: no second start.
    hx.publish('playback.started', { player: hx.player, item: hx.items.office, state: 'playing' }, hx.s.seq);
    hx.publish('playback.progress', { player: hx.player, item: hx.items.office, positionMs: 30_000, durationMs: 1_320_000 });
    await waitFor('progress', () => adapter.progress(id)?.positionMs === 30_000);
    assert.equal(adapter.progress(id)?.durationMs, 1_320_000);
    assert.deepEqual(events, ['video-started']);
    // Playback events don't make Kova read the players: they say it all.
    await new Promise(r => setTimeout(r, 400));
    assert.equal(hx.s.playersReads, reads);
    // player.*, screen.* and a player Kova doesn't know do.
    hx.publish('player.online', { player: hx.player });
    await waitFor('players read', () => hx.s.playersReads === reads + 1);
    hx.publish('playback.started', { player: { id: 'd-cccccccccccccccc', name: 'Den' }, item: hx.items.dune });
    await waitFor('players read for an unknown box', () => hx.s.playersReads === reads + 2);
    // Helix lost the history: it says reset, and Kova reads the players (and what they play) again.
    hx.box(BOX).playback = { state: 'paused', item: hx.items.dune };
    hx.s.streams[0].res.write(`id: 900\nevent: reset\ndata: {}\n\n`);
    await waitFor('reset read', () => hx.s.playersReads === reads + 3);
    await waitFor('caught up from players', () => t.dev(id).media === 'Dune: Part Two' && t.dev(id).paused === true);
    assert.deepEqual(hx.s.wrong, []);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix screens: asleep, shut down and awake are events automations start on; on/off wake and sleep the box', { timeout: 20_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    await waitFor('live', () => adapter.following && hx.s.streams.length === 1);
    const events: { type: string; data: Record<string, unknown> }[] = [];
    t.hub.reg.on('event', e => events.push({ type: e.type, data: e.data }));
    hx.publish('screen.asleep', { player: hx.player, reason: 'sleep', by: 'idle' });
    hx.publish('screen.awake', { player: hx.player, reason: 'wake', by: 'remote' });
    hx.publish('screen.asleep', { player: hx.player, reason: 'shutdown', by: 'sheet' });
    await waitFor('three', () => events.length === 3);
    assert.deepEqual(events, [
      { type: 'screen-asleep', data: { by: 'idle', reason: 'sleep' } },
      { type: 'screen-awake', data: { by: 'remote', reason: 'wake' } },
      { type: 'screen-shutdown', data: { by: 'sheet', reason: 'shutdown' } },
    ]);
    // An automation on "shuts down" runs.
    t.hub.config.update(c => { (c.automations ??= []).push({ id: 'off', name: 'Lamp off when the box shuts down', enabled: true, mode: 'single', triggers: [{ kind: 'event', device: id, event: 'screen-shutdown' }], conditions: [], actions: [{ kind: 'set', targets: { lamp: { on: false } } }] }); });
    await t.hub.engine.command('lamp', { on: true });
    hx.publish('screen.asleep', { player: hx.player, reason: 'shutdown', by: 'remote' });
    await waitFor('lamp off', () => t.dev('lamp').on === false);
    // The screen's state is the box's `asleep` extra: set, it sleeps or wakes the box; on wakes it too.
    await waitFor('asleep shown', () => t.dev(id).extras?.asleep === true);
    hx.s.control.length = 0;
    await t.hub.reg.command(id, { on: true }, { kind: 'user', label: 'You' });
    assert.deepEqual(hx.s.control.map(c => c.verb), ['wake']);
    await waitFor('awake shown', () => t.dev(id).extras?.asleep === false);
    await t.hub.reg.command(id, { extras: { asleep: true } }, { kind: 'user', label: 'You' });
    assert.deepEqual(hx.s.control.map(c => c.verb), ['wake', 'sleep']);
    await t.hub.reg.command(id, { extras: { asleep: false } }, { kind: 'user', label: 'You' });
    assert.deepEqual(hx.s.control.map(c => c.verb), ['wake', 'sleep', 'wake']);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix suspended box: never polled; "play X" wakes it (Wake-on-LAN through Helix) and waits for it before playing', { timeout: 20_000 }, async () => {
  const hx = await fakeHelix();
  hx.box(BOX).suspended = true;
  hx.box(BOX).asleep = true;
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    await waitFor('live', () => adapter.following && hx.s.streams.length === 1);
    await adapter.poll();
    assert.equal(hx.s.stateReads, 0, 'a suspended box is never polled');
    await t.hub.engine.command(id, { on: true, media: 'dune' });
    assert.deepEqual(hx.s.control.map(c => c.verb), ['wake', 'play']);
    assert.deepEqual(hx.s.control[1].body, { itemId: 'helix:dune', positionMs: 0, profile: 'default' });
    assert.equal(t.dev(id).media, 'Dune: Part Two');
    // Awake now: polled again.
    await adapter.poll();
    assert.equal(hx.s.stateReads, 1);
    // It never wakes: said plainly, nothing played.
    hx.box(BOX).suspended = true;
    hx.s.wakeMs = 60_000;
    hx.s.control.length = 0;
    await adapter.refreshBoxes();
    const slow = new HelixAdapter({ url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, wakeWaitMs: 300 });
    const t2 = await testHub(21);
    try {
      await t2.hub.reg.addAdapter(slow);
      await assert.rejects(t2.hub.reg.command(id, { on: true, media: 'dune' }, { kind: 'user', label: 'You' }), /didn’t wake up in time/);
      assert.deepEqual(hx.s.control.map(c => c.verb), ['wake']);
    } finally { await t2.hub.stop(); }
    assert.deepEqual(hx.s.wrong, []);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix box with a soundbar: no box volume (the soundbar’s is the one); notices only where Helix offers them, within its limits', { timeout: 15_000 }, async () => {
  const hx = await fakeHelix();
  hx.box(BOX).soundbar = { deviceId: 'lounge_bar', name: 'Soundbar' };
  hx.box(BOX).capabilities = ['sleep', 'wake', 'soundbar'];
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0, feed: false });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    const d = t.hub.reg.get(id)!;
    assert.deepEqual(d.capabilities, ['onoff', 'media', 'pause', 'library', 'extras']);
    // Without notify in its capabilities: no card.
    await adapter.notice(d, { title: 'Someone’s at the door' });
    assert.equal(hx.s.control.length, 0);
    hx.box(BOX).capabilities = ['notify', 'sleep', 'wake', 'soundbar'];
    await adapter.refreshBoxes();
    await adapter.notice(d, { title: 'x'.repeat(200), body: 'y'.repeat(500), seconds: 600 });
    const n = hx.s.control.at(-1)!;
    assert.equal(n.verb, 'notify');
    assert.equal(n.body.title.length, 80);
    assert.equal(n.body.body.length, 300);
    assert.equal(n.body.seconds, 60);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix: a URL or YouTube play (not announced) is read from the screen while the feed is live', { timeout: 15_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0 });
  try {
    await t.hub.reg.addAdapter(adapter);
    const id = boxDeviceId('Lounge Helix');
    await waitFor('live', () => adapter.following && hx.s.streams.length === 1);
    await new Promise(r => setTimeout(r, 200));
    hx.s.box = { mode: 'video', title: 'A video from the web', paused: false, volume: 30 };
    await adapter.poll();
    assert.deepEqual({ on: t.dev(id).on, media: t.dev(id).media, vol: t.dev(id).vol }, { on: true, media: 'A video from the web', vol: 30 });
    hx.s.box = { mode: 'browse', screen: 'Library', volume: 30 };
    await adapter.poll();
    assert.equal(t.dev(id).on, false);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix profile: Kova acts as the profile set; a locked one is said in the status and when playing', { timeout: 15_000 }, async () => {
  const hx = await fakeHelix({ profile: 'kids', locked: true });
  const t = await testHub(20);
  const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, musicProfile: 'kids', rooms: { 'Lounge Helix': 'lounge' }, pollSec: 0, feed: false });
  try {
    await t.hub.reg.addAdapter(adapter);
    assert.deepEqual(adapter.status(), { ok: false, note: 'Helix profile “kids” is locked. Unlock it in Helix, or choose another profile in Kova’s Helix settings.' });
    await assert.rejects(t.hub.reg.command(boxDeviceId('Lounge Helix'), { on: true, media: 'dune' }, { kind: 'user', label: 'You' }), /profile “kids” is locked/);
  } finally {
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
    // Offline is Helix's to say (its players), not one failed read of the screen.
    hx.box(BOX).online = false;
    await adapter.refreshBoxes();
    assert.equal(t.dev(id).online, false);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix boxes: a box Helix re-keys from its address to its stable id keeps its Kova id, room and TV settings', { timeout: 15_000 }, async () => {
  // Kova before 0.7.44 knew a nameless box by its address: "Helix box <ip>", with the home's settings under that name.
  const hx = await fakeHelix();
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-rekey-'));
  const legacyName = 'Helix box 192.168.1.30';
  const legacyId = boxDeviceId(legacyName);
  hx.box(BOX).name = '';
  hx.box(BOX).id = 'addr:192.168.1.30';
  const t = await testHub(20);
  const rooms = { [legacyName]: 'lounge' };
  const screens = { [legacyName]: { tv: 'lounge_tv', input: 'hdmi2' } };
  try {
    let adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms, screens, pollSec: 0, feed: false, storageDir: dir });
    await t.hub.reg.addAdapter(adapter);
    assert.deepEqual(t.hub.reg.list().filter(d => d.adapter === 'helix').map(d => [d.id, d.address, d.room]), [[legacyId, 'addr:192.168.1.30', 'lounge']]);
    // Helix gives it its stable id and a name, with the address as an alias: same Kova device, settings kept.
    hx.box('addr:192.168.1.30').aliases = ['addr:192.168.1.30'];
    hx.box('addr:192.168.1.30').name = 'Living room box';
    hx.box('addr:192.168.1.30').id = BOX;
    await adapter.refreshBoxes();
    const boxes = () => t.hub.reg.list().filter(d => d.adapter === 'helix');
    assert.deepEqual(boxes().map(d => [d.id, d.address, d.name, d.room]), [[legacyId, BOX, 'Living room box', 'lounge']]);
    assert.ok(adapter.aliases(legacyId).includes(legacyName));
    // The box's TV setting, kept under the old name, still applies.
    const tv = { id: 'lounge_tv', name: 'Lounge TV', room: 'lounge', type: 'tv' as const, capabilities: ['onoff' as const, 'input' as const], adapter: 'samsungtv', integration: 'Samsung', address: 'x', state: {} };
    assert.deepEqual(helixScreens([...boxes(), tv], screens, d => adapter.aliases(d.id)).map(s => [s.playerId, s.tvDeviceId, s.helixInput]), [[BOX, 'lounge_tv', 'hdmi2']]);
    // Kova restarts: the box keeps its Kova id from what Kova kept.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'boxes.json'), 'utf8')).boxes.map((b: { id: string; kovaId: string }) => [b.id, b.kovaId]), [[BOX, legacyId]]);
    await t.hub.reg.removeAdapter('helix', { forget: true });
    adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, rooms, screens, pollSec: 0, feed: false, storageDir: dir });
    await t.hub.reg.addAdapter(adapter);
    assert.deepEqual(boxes().map(d => d.id), [legacyId]);
    // Renamed in Helix: still the same Kova device.
    hx.box(BOX).name = 'Den box';
    await adapter.refreshBoxes();
    assert.deepEqual(boxes().map(d => [d.id, d.name]), [[legacyId, 'Den box']]);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix boxes: a home upgrading from a Kova that kept no boxes keeps the id it used (by name, or by the box’s address)', { timeout: 15_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-up-'));
  mkdirSync(dir, { recursive: true });
  // The box had no name, so the old Kova called it after its address; the home has history for that id.
  const legacyId = boxDeviceId('Helix box 192.168.1.31');
  t.hub.store.set('deviceState', { [legacyId]: { on: false, online: true } });
  writeFileSync(join(dir, 'unused'), '');
  hx.box(BOX).name = 'Bedroom box';
  hx.box(BOX).aliases = ['addr:192.168.1.31'];
  const t2 = await testHub(21);
  try {
    // A fresh registry that has seen the legacy id before.
    (t2.hub.reg as unknown as { saved: Record<string, unknown> }).saved[legacyId] = { on: false };
    const adapter = new HelixAdapter({ url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, storageDir: dir });
    await t2.hub.reg.addAdapter(adapter);
    assert.deepEqual(t2.hub.reg.list().filter(d => d.adapter === 'helix').map(d => [d.id, d.name, d.address]), [[legacyId, 'Bedroom box', BOX]]);
    // Without that history the box is known by its name.
    const fresh = await testHub(22);
    try {
      await fresh.hub.reg.addAdapter(new HelixAdapter({ url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, storageDir: mkdtempSync(join(tmpdir(), 'kova-helix-up2-')) }));
      assert.deepEqual(fresh.hub.reg.list().filter(d => d.adapter === 'helix').map(d => d.id), [boxDeviceId('Bedroom box')]);
    } finally { await fresh.hub.stop(); }
  } finally {
    await t.hub.stop();
    await t2.hub.stop();
    await hx.close();
  }
});
