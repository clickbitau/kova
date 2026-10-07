import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoff, HubLink, linkWords, type LinkState, type LinkStatus, type SocketLike } from '../src/logic/link.ts';
import type { Hello, HubAddress, Route } from '../src/logic/addresses.ts';
import type { HubConfig } from '../src/logic/connect.ts';

// The phone's link to its hub, every way it goes wrong, with a fake hub: which addresses answer /api/hello (and as
// which hub), what a request with the token gets, and sockets the test opens, feeds and drops.

const LOCAL = 'http://10.0.0.5:8140';
const REMOTE = 'https://kova.example.ts.net';
const HUB = 'hub-1';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  close() { this.closed = true; }
  say(data: unknown = { devices: [] }) { this.onmessage?.({ data: JSON.stringify({ type: 'state', data }) }); }
  drop() { this.onclose?.({}); }
  fail() { this.onerror?.({}); }
}

interface Fake {
  /** Per address: the hub ID it answers /api/hello with, or null (nothing answers). */
  answers: Record<string, string | null>;
  /** What GET <path> with the token does: a body, or a status to fail with (0: nothing answered). */
  get: Record<string, unknown | { fail: number }>;
  /** Sockets: what each new one does on its own ('speak' sends a snapshot at once). */
  socketDoes: 'speak' | 'fail' | 'hang';
}

function rig(o: { addresses?: HubAddress[]; fake?: Partial<Fake>; token?: string } = {}) {
  const fake: Fake = {
    answers: { [LOCAL]: HUB, [REMOTE]: HUB },
    get: { '/api/connect/addresses': { addresses: [] }, '/api/state': { devices: [], from: 'poll' } },
    socketDoes: 'speak',
    ...o.fake,
  };
  const cfg: HubConfig = {
    url: LOCAL, hubId: HUB, token: o.token ?? 'key',
    addresses: o.addresses ?? [{ url: LOCAL, kind: 'local' }, { url: REMOTE, kind: 'remote' }],
  };
  const sockets: FakeSocket[] = [];
  const states: LinkState[] = [];
  const snaps: unknown[] = [];
  const routes: (Route | null)[] = [];
  const gets: string[] = [];
  const link = new HubLink({
    config: () => cfg,
    hello: async (url: string): Promise<Hello | null> => {
      await new Promise(r => setTimeout(r, 1));
      const id = fake.answers[url];
      return id ? { kova: true, hubId: id } : null;
    },
    get: async <T,>(c: HubConfig, path: string): Promise<T> => {
      gets.push(`${c.url}${path}`);
      await new Promise(r => setTimeout(r, 1));
      if (fake.answers[c.url] === undefined || fake.answers[c.url] === null) throw { status: 0 };
      const g = fake.get[path];
      if (g && typeof g === 'object' && 'fail' in g) throw { status: (g as { fail: number }).fail, problem: (g as { fail: number }).fail === 401 ? 'signedOut' : undefined };
      return g as T;
    },
    socket: url => {
      const s = new FakeSocket(url);
      sockets.push(s);
      if (fake.socketDoes === 'speak') setTimeout(() => s.say(), 1);
      if (fake.socketDoes === 'fail') setTimeout(() => s.fail(), 1);
      return s;
    },
    onSnapshot: s => snaps.push(s),
    onStatus: (s: LinkStatus) => states.push(s.state),
    onRoute: r => routes.push(r),
    random: () => 0.5,
    tuning: { backoffMs: [10, 20, 40], staleMs: 120, watchMs: 15, openTimeoutMs: 80, pollMs: 25, localTimeoutMs: [50, 80], remoteTimeoutMs: [50, 80] },
  });
  const last = () => sockets[sockets.length - 1];
  return { link, fake, cfg, sockets, states, snaps, routes, gets, last };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 1500) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(2);
  }
}

test('connects on the home network, live once the hub has spoken', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  assert.equal(r.link.route?.url, LOCAL);
  assert.ok(r.last().url.startsWith('ws://10.0.0.5:8140/api/ws?token=key'));
  assert.equal(r.link.current.socket, true);
  assert.equal(r.snaps.length, 1);
  r.link.stop();
});

test('a socket that drops while the hub still answers comes straight back, without ever saying offline', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  for (let i = 0; i < 3; i++) {
    const before = r.sockets.length;
    r.last().drop();
    await until('a new socket that spoke', () => r.sockets.length > before && r.link.current.socket);
  }
  assert.ok(!r.states.includes('offline'), r.states.join(' → '));
  assert.ok(!r.states.includes('connecting') || r.states.indexOf('connecting') === 0, `no "connecting" after the first: ${r.states.join(' → ')}`);
  r.link.stop();
});

test('a hub restart: offline only once nothing answers twice, tries again sooner then later, and is back by itself', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  // The hub goes away: nothing answers at either address.
  r.fake.answers = { [LOCAL]: null, [REMOTE]: null };
  const t0 = Date.now();
  r.last().drop();
  await until('offline', () => r.link.current.state === 'offline');
  assert.ok(Date.now() - t0 >= 10, 'not on the first miss');
  assert.ok(r.link.current.retryAt! > Date.now() - 5, 'says when it tries again');
  const tries = r.sockets.length;
  await sleep(150);
  assert.equal(r.sockets.length, tries, 'no socket opened while nothing answers');
  // Back: picked up by the next try, with a fresh snapshot.
  r.fake.answers = { [LOCAL]: HUB, [REMOTE]: HUB };
  const snaps = r.snaps.length;
  await until('live again', () => r.link.current.state === 'live' && r.link.current.socket);
  assert.ok(r.snaps.length > snaps);
  r.link.stop();
});

test('never "can’t reach" while the remote address works: away from home it moves there', async () => {
  const r = rig({ fake: { answers: { [LOCAL]: null, [REMOTE]: HUB } } });
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  assert.equal(r.link.route?.url, REMOTE);
  assert.ok(r.last().url.startsWith('wss://kova.example.ts.net/api/ws'));
  assert.ok(!r.states.includes('offline'));
  // Home again, and the network changes: back on the home network, the socket moves.
  r.fake.answers[LOCAL] = HUB;
  r.link.networkChanged();
  await until('on the home network', () => r.link.route?.url === LOCAL && r.last().url.startsWith('ws://10.0.0.5') && r.link.current.socket);
  assert.equal(r.sockets.filter(s => !s.closed).length, 1, 'the remote socket was closed');
  // Leaves home: the home address stops answering, the socket there dies.
  r.fake.answers[LOCAL] = null;
  r.link.networkChanged();
  r.last().drop();
  await until('remote again', () => r.link.route?.url === REMOTE && r.link.current.socket);
  assert.ok(!r.states.includes('offline'), r.states.join(' → '));
  r.link.stop();
});

test('a socket that goes quiet (a phone that slept, a Wi-Fi that went) is replaced', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  const first = r.last();
  r.fake.socketDoes = 'speak';
  // It never closes, it just stops talking (the hub sends at least every 30 s; here staleMs is 120 ms).
  await until('replaced', () => r.sockets.length > 1 && first.closed, 1000);
  await until('the new one is live', () => r.link.current.socket);
  assert.ok(!r.states.includes('offline'));
  r.link.stop();
});

test('a socket that never opens is given up on, and the hub asked why', async () => {
  const r = rig({ fake: { socketDoes: 'hang' } });
  r.link.start();
  await until('a second socket', () => r.sockets.length >= 2, 1000);
  assert.ok(r.gets.some(g => g.endsWith('/api/connect/addresses')), 'asked with the token');
  r.link.stop();
});

test('a refused key is "signed out", not offline, and it stops knocking until asked', async () => {
  // The hub answers /api/hello, refuses the socket (which can't say why) and says 401 to a request.
  const r = rig({ fake: { socketDoes: 'fail', get: { '/api/connect/addresses': { fail: 401 } } } });
  r.link.start();
  await until('signed out', () => r.link.current.state === 'signedOut');
  assert.ok(!r.states.includes('offline'), r.states.join(' → '));
  assert.match(r.link.current.message ?? '', /key/);
  const n = r.sockets.length;
  await sleep(200);
  assert.equal(r.sockets.length, n, 'no more tries by itself');
  r.link.resume();
  r.link.networkChanged();
  await sleep(50);
  assert.equal(r.sockets.length, n, 'nor on the foreground or a network change');
  // Signed in again (a new key) and the hub takes it.
  r.fake.socketDoes = 'speak';
  r.fake.get['/api/connect/addresses'] = { addresses: [] };
  r.cfg.token = 'new-key';
  r.link.reset();
  await until('live with the new key', () => r.link.current.state === 'live');
  assert.ok(r.last().url.includes('token=new-key'));
  r.link.stop();
});

test('a request refused (401) signs out at once, and "Try again" asks again', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  r.link.signedOut();
  assert.equal(r.link.current.state, 'signedOut');
  assert.ok(r.last().closed);
  r.link.retryNow();
  await until('live again', () => r.link.current.state === 'live');
  r.link.stop();
});

test('requests work but the socket doesn’t: connected, and the state is fetched until the socket is back', async () => {
  const r = rig({ fake: { socketDoes: 'fail' } });
  r.link.start();
  await until('live without the socket', () => r.link.current.state === 'live' && !r.link.current.socket);
  await until('polled', () => r.snaps.filter(s => (s as { from?: string }).from === 'poll').length >= 2, 1000);
  assert.ok(!r.states.includes('offline'));
  // The socket comes back: polling stops.
  r.fake.socketDoes = 'speak';
  await until('socket back', () => r.link.current.socket, 2000);
  const polls = r.gets.filter(g => g.endsWith('/api/state')).length;
  await sleep(100);
  assert.equal(r.gets.filter(g => g.endsWith('/api/state')).length, polls, 'no polling with the socket up');
  r.link.stop();
});

test('the hub answering with errors is a hub problem, with its words', async () => {
  const r = rig({ fake: { socketDoes: 'fail', get: { '/api/connect/addresses': { fail: 503 } } } });
  r.link.start();
  await until('hub problem', () => r.link.current.state === 'hubError');
  assert.ok(!r.states.includes('offline'));
  r.link.stop();
});

test('a different Kova at the address is a hub problem that says so, not "can’t reach"', async () => {
  const r = rig({ fake: { answers: { [LOCAL]: 'another-hub', [REMOTE]: null } } });
  r.link.start();
  await until('hub problem', () => r.link.current.state === 'hubError');
  assert.match(r.link.current.message ?? '', /different Kova hub answers at 10\.0\.0\.5:8140/);
  assert.equal(r.sockets.length, 0, 'the key never went there');
  r.link.stop();
});

test('in the background the socket is closed and nothing is tried; back in front it reconnects at once and resyncs', async () => {
  const r = rig();
  r.link.start();
  await until('live', () => r.link.current.state === 'live');
  r.link.pause();
  assert.ok(r.last().closed);
  const n = r.sockets.length, snaps = r.snaps.length;
  await sleep(200);
  assert.equal(r.sockets.length, n, 'nothing while in the background');
  assert.equal(r.link.current.state, 'live', 'what was shown stays until it has had a chance');
  const t0 = Date.now();
  r.link.resume();
  await until('a fresh snapshot', () => r.snaps.length > snaps && r.link.current.socket);
  assert.ok(Date.now() - t0 < 100, 'no backoff on the way back');
  assert.ok(!r.states.includes('offline'));
  r.link.stop();
});

test('a request that works while offline brings it back at once', async () => {
  const r = rig({ fake: { answers: { [LOCAL]: null, [REMOTE]: null } } });
  r.link.start();
  await until('offline', () => r.link.current.state === 'offline');
  r.fake.answers[LOCAL] = HUB;
  await r.link.choose();
  r.link.reachable(LOCAL);
  assert.equal(r.link.current.state, 'live');
  await until('socket', () => r.link.current.socket, 300);
  r.link.stop();
});

test('backoff: sooner at first, then capped, with some jitter', () => {
  const steps = [1000, 2000, 4000, 8000, 15_000, 20_000];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(a => backoff(a, steps, () => 0.5)), [1000, 2000, 4000, 8000, 15_000, 20_000, 20_000, 20_000]);
  assert.equal(backoff(0, steps, () => 0), 800);
  assert.equal(backoff(0, steps, () => 1), 1200);
});

test('each state has its own words', () => {
  assert.equal(linkWords({ state: 'live' }).title, 'Connected to your hub');
  assert.equal(linkWords({ state: 'offline' }).title, 'Can’t reach your hub');
  assert.equal(linkWords({ state: 'signedOut' }).title, 'Signed out of your hub');
  assert.equal(linkWords({ state: 'hubError' }).title, 'Your hub has a problem');
  assert.equal(linkWords({ state: 'connecting' }).tone, 'busy');
});

test('a request that finds its address gone moves the socket to the one that answers', async () => {
  const r = rig();
  r.link.start();
  await until('live at home', () => r.link.current.socket && r.link.route?.url === LOCAL);
  r.fake.answers[LOCAL] = null;
  const next = await r.link.lost();
  assert.equal(next?.url, REMOTE);
  await until('socket on the remote address', () => r.last().url.startsWith('wss://') && r.link.current.socket);
  assert.equal(r.sockets.filter(s => !s.closed).length, 1);
  r.link.stop();
});
