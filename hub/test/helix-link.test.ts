import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { isScreen } from '../src/adapters/helix.ts';
import { HelixLink, SOUNDBAR_INPUTS, SOUNDBAR_MODES, TV_INPUTS, helixScreens, kovaAddress, kovaUrlProblem } from '../src/services/helix-link.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';
import type { Automation, Command, Device } from '../src/model/types.ts';
import { automationIdeas, carryOverTvOff, upgradeTvOffOnce, upgradeTvOffWithBox } from '../src/engine/automation-ideas.ts';
import { KOVA_VERSION } from '../src/version.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const LOUNGE = 'd-2222222222222222', BED = 'd-1111111111111111';

/** Helix Server: its players, and PUT/GET /v1/integrations/kova like the real one. */
async function fakeHelix(o: { reachable?: boolean; devices?: boolean } = {}) {
  const TOKEN = 'hxd_' + 'c'.repeat(64);
  const puts: { auth?: string; body: any }[] = [];
  const s = { reachable: o.reachable ?? true, devices: o.devices ?? true, gets: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      assert.equal(req.headers['x-helix-client'], `kova/${KOVA_VERSION}`);
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/v1/players') return send(200, { lastId: 7, players: [
        { id: LOUNGE, name: 'Lounge Helix', client: 'helix-tv', box: true, online: true, lastSeenAt: 1_791_000_000, capabilities: ['play', 'pause', 'resume', 'stop', 'seek', 'next', 'previous', 'volume', 'mute', 'tracks', 'notify', 'sleep', 'wake'], playback: null },
        { id: BED, name: 'Bedroom Helix', client: 'helix-tv', box: true, online: true, lastSeenAt: 1_791_000_000, capabilities: ['play', 'pause', 'resume', 'stop', 'seek', 'next', 'previous', 'volume', 'mute', 'tracks', 'notify', 'sleep', 'wake'], playback: null },
        { id: 'd-3333333333333333', name: 'Kova', client: `kova/${KOVA_VERSION}`, box: false, you: true, online: true, lastSeenAt: 1_791_000_000, capabilities: [], playback: null },
      ] });
      if (u.pathname === '/v1/client/features') return send(200, { players: { enabled: true, music: true, notices: true, devices: s.devices } });
      if (/^\/v1\/boxes\/[^/]+\/state$/.test(u.pathname)) return send(200, { mode: 'browse' });
      if (req.method === 'PUT' && u.pathname === '/v1/integrations/kova') {
        puts.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        return send(200, { linked: true });
      }
      if (req.method === 'GET' && u.pathname === '/v1/integrations/kova') {
        s.gets++;
        const last = puts.at(-1)?.body;
        // As Helix answers: unlinked, or linked with the screens it keeps (empty fields left out, never the token).
        if (!last) return send(200, { linked: false, reachable: false, screens: [], autoSwitch: true, sleepOff: true });
        const keep = ['playerId', 'tvDeviceId', 'tvName', 'helixInput', 'inputs', 'soundbarDeviceId', 'soundbarName', 'soundbarTvInput', 'soundbarAdapterInput'];
        const screens = (last.screens ?? []).map((x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k, v]) => keep.includes(k) && (k === 'playerId' || k === 'tvDeviceId' || (v !== '' && v != null)))));
        return send(200, { linked: true, reachable: s.reachable, url: last.url, autoSwitch: true, sleepOff: false, screens });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN, puts, s, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A Samsung-like TV in the lounge and one in the bedroom, and a soundbar. `slowOnMs`: how long a TV takes to come on. */
class Tvs implements Adapter {
  id = 'tvs'; name = 'TVs'; icon = 'tv'; kind = 'Local' as const;
  got: { id: string; cmd: Command }[] = [];
  ctx!: AdapterContext;
  slowOnMs = 0;
  fail = false;
  async start(ctx: AdapterContext) {
    this.ctx = ctx;
    ctx.announce([
      { id: 'lounge_tv', name: 'Lounge TV', room: 'lounge', type: 'tv', capabilities: ['onoff', 'volume', 'input'], integration: 'Samsung', address: '10.0.0.20', state: { on: false, online: true } },
      { id: 'bedroom_tv', name: 'Bedroom TV', room: 'bedroom', type: 'tv', capabilities: ['onoff', 'input'], integration: 'Samsung', address: '10.0.0.21', state: { on: false, online: true } },
      { id: 'lounge_bar', name: 'Soundbar', room: 'lounge', type: 'media', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'], integration: 'Samsung soundbar', address: 'st-1', state: { on: false, online: true, vol: 12, input: 'tv' } },
    ]);
  }
  async stop() {}
  status() { return { ok: true }; }
  // Like the Samsung adapter: a TV can't say its input, so it isn't kept.
  async command(d: Device, cmd: Command) {
    if (this.fail) throw new Error(`${d.name} didn’t answer`);
    if (cmd.on === true && this.slowOnMs) await new Promise(r => setTimeout(r, this.slowOnMs));
    this.got.push({ id: d.id, cmd });
    if (d.type === 'tv' && cmd.input) return { input: null };
  }
}

test('Helix link: after pairing Kova tells Helix where it is, a token and which TV each box is on; the token only reaches those TVs', async () => {
  const hx = await fakeHelix();
  const t = await testHub(12, c => { if (!c.rooms.some(r => r.id === 'bedroom')) c.rooms.push({ id: 'bedroom', name: 'Bedroom', icon: 'bed' }); });
  const tvs = new Tvs();
  await t.hub.reg.addAdapter(tvs);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-link-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const link = new HelixLink(t.hub, { helix: () => manager.raw('helix'), dataDir: dir, port: () => 8140, debounceMs: 0, watchMs: 0 });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, token: 'master', helixLink: link });
  try {
    // Helix's health check needs no token.
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    // The token is made once, kept to the owner, and survives a restart.
    assert.match(link.token, /^kvh_[0-9a-f]{48}$/);
    assert.equal(statSync(join(dir, 'helix-link.json')).mode & 0o777, 0o600);
    assert.equal(new HelixLink(t.hub, { helix: () => undefined, dataDir: dir, port: () => 8140 }).token, link.token);
    assert.equal(JSON.parse(readFileSync(join(dir, 'helix-link.json'), 'utf8')).token, link.token);

    // Not paired: nothing is sent.
    await link.sync();
    assert.equal(hx.puts.length, 0);

    // Paired, boxes in rooms: each box gets the one TV in its room; the box's input comes from settings.
    await manager.update('helix', { url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, kovaUrl: 'http://10.0.0.5:8140', rooms: { 'Lounge Helix': 'lounge', 'Bedroom Helix': 'bedroom' }, screens: { 'Lounge Helix': { input: 'hdmi2' } } });
    await link.sync();
    assert.equal(hx.puts.length, 1);
    assert.equal(hx.puts[0].auth, `Bearer ${hx.TOKEN}`);
    // Every screen with every field, by Helix's stable box ids; never Helix's own autoSwitch or sleepOff.
    assert.deepEqual(hx.puts[0].body, {
      url: 'http://10.0.0.5:8140', token: link.token,
      screens: [
        { playerId: BED, tvDeviceId: 'bedroom_tv', tvName: 'Bedroom TV', inputs: TV_INPUTS },
        {
          playerId: LOUNGE, tvDeviceId: 'lounge_tv', tvName: 'Lounge TV', helixInput: 'hdmi2', inputs: TV_INPUTS,
          soundbarDeviceId: 'lounge_bar', soundbarName: 'Soundbar', soundbarInputs: SOUNDBAR_INPUTS, soundbarModes: SOUNDBAR_MODES, soundbarNight: true,
          soundbarTvInput: 'tv', soundbarAdapterInput: 'hdmi1',
        },
      ],
    });
    // Read back: Helix keeps both and reaches Kova.
    assert.equal(hx.s.gets, 1);
    assert.deepEqual(link.status(), { ok: true, note: 'Helix turns on 2 TVs through Kova · Helix reaches Kova' });

    // Its /api/state: every linked TV and soundbar, by Helix's names and types; what Kova doesn't know is left out.
    const helix = { authorization: `Bearer ${link.token}` };
    const state0 = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    assert.deepEqual(state0.devices.map((d: { id: string }) => d.id), ['bedroom_tv', 'lounge_tv', 'lounge_bar']);
    assert.deepEqual(state0.devices.find((d: { id: string }) => d.id === 'lounge_bar').state, { on: false, online: true, input: 'tv', volume: 12 });
    const bedroom = t.hub.reg.get('bedroom_tv')!;
    const saved = bedroom.state;
    bedroom.state = {};
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json().devices[0].state, {}, 'nothing guessed');
    // A TV that doesn't answer is off, whatever Kova last knew.
    bedroom.state = { on: true, online: false };
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json().devices[0].state, { on: false, online: false });
    bedroom.state = saved;

    // Nothing changed: not sent again. A box moves rooms: sent again.
    await link.sync();
    assert.equal(hx.puts.length, 1);
    await manager.update('helix', { ...manager.raw('helix'), rooms: { 'Lounge Helix': 'lounge', 'Bedroom Helix': 'kitchen' } });
    await link.sync();
    assert.equal(hx.puts.length, 2);
    assert.deepEqual(hx.puts[1].body.screens.map((s: { playerId: string }) => s.playerId), [LOUNGE]);

    // Helix calls back with its token: the lounge TV turns on and changes input.
    const on = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { on: true } });
    assert.equal(on.statusCode, 200, on.body);
    assert.deepEqual(on.json(), { ok: true });
    const inp = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { input: 'hdmi2' } });
    assert.equal(inp.statusCode, 200, inp.body);
    assert.deepEqual(tvs.got, [{ id: 'lounge_tv', cmd: { on: true } }, { id: 'lounge_tv', cmd: { input: 'hdmi2' } }]);
    // The same again straight away (Helix retrying): answered, not sent twice.
    assert.equal((await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { input: 'hdmi2' } })).statusCode, 200);
    assert.equal(tvs.got.length, 2);
    // The soundbar under it: Helix sends one command at a time, by its own names (D98.11).
    for (const payload of [{ on: true }, { volumeStep: 1 }, { volume: 20 }, { mute: true }, { input: 'hdmi1' }, { mode: 'surround' }, { nightMode: true }]) {
      const r = await app.inject({ method: 'POST', url: '/api/devices/lounge_bar', headers: helix, payload });
      assert.equal(r.statusCode, 200, `${JSON.stringify(payload)} ${r.body}`);
    }
    assert.deepEqual(tvs.got.filter(g => g.id === 'lounge_bar').map(g => g.cmd), [{ on: true }, { volStep: 1 }, { vol: 20 }, { muted: true }, { input: 'hdmi1' }, { sound: 'surround' }, { night: true }]);
    // Volume and mute show at once (Helix's on-screen volume reads them back).
    const bar = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json().devices.find((d: { id: string }) => d.id === 'lounge_bar').state;
    assert.deepEqual([bar.volume, bar.muted], [20, true]);
    for (const payload of [{ media: 'Radio' }, { volume: 20, mute: true }, { volume: 20.5 }, { input: 'hdmi9' }, { volumeStep: 5 }, { mode: 'loud' }, { vol: 20 }]) {
      const r = await app.inject({ method: 'POST', url: '/api/devices/lounge_bar', headers: helix, payload });
      assert.equal(r.statusCode, 403, JSON.stringify(payload));
      assert.equal(typeof r.json().error, 'string');
    }
    tvs.got = tvs.got.filter(g => g.id !== 'lounge_bar');
    // Helix switching by itself (X-Helix-Origin: auto) marks it; Kova says who changed each input last, so Helix never
    // switches back someone's choice. A forwarded remote press carries no header: a person.
    const auto = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: { ...helix, 'x-helix-origin': 'auto' }, payload: { input: 'hdmi3' } });
    assert.equal(auto.statusCode, 200, auto.body);
    tvs.got.pop();
    const st = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    const at = (id: string) => st.devices.find((d: { id: string }) => d.id === id).state;
    assert.equal(at('lounge_tv').inputChangedBy, 'helix-auto');
    assert.ok(Number.isInteger(at('lounge_tv').inputChangedAt) && Math.abs(at('lounge_tv').inputChangedAt - Date.now()) < 5000, 'Unix ms');
    assert.equal(at('lounge_bar').inputChangedBy, 'Helix remote');
    for (const d of st.devices) delete d.state.inputChangedAt;
    assert.deepEqual(st, { devices: [
      { id: 'lounge_tv', name: 'Lounge TV', type: 'tv', state: { on: true, online: true, inputChangedBy: 'helix-auto' } },
      { id: 'lounge_bar', name: 'Soundbar', type: 'soundbar', state: { on: true, online: true, input: 'hdmi1', volume: 20, muted: true, mode: 'surround', nightMode: true, inputChangedBy: 'Helix remote' } },
    ] });
    // Someone changes the TV's input in Kova's app: Helix sees it wasn't its own switching.
    await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: { authorization: 'Bearer master' }, payload: { input: 'hdmi4' } });
    tvs.got.pop();
    const st2 = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    assert.deepEqual([st2.devices[0].state.input, st2.devices[0].state.inputChangedBy], [undefined, 'You']);
    // A TV that reads its input back reports it, in Helix's ids; Kova never reports the one it only asked for.
    tvs.ctx.report('lounge_tv', { input: 'hdmi4' });
    assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json().devices[0].state.input, 'hdmi4');
    // …and with the soundbar's own remote (read back as a change at the device).
    tvs.ctx.report('lounge_bar', { input: 'bluetooth' });
    const st3 = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    assert.deepEqual([st3.devices[1].state.input, st3.devices[1].state.inputChangedBy], ['bluetooth', 'remote']);
    // Who changed an input is kept across a restart.
    t.hub.reg.flush();
    assert.equal(t.hub.store.get<Record<string, { by: string }>>('inputLog')?.lounge_tv?.by, 'You');

    // Anything else is refused: another device, the bedroom TV (no longer linked), other fields, other routes.
    for (const [method, url, payload] of [
      ['POST', '/api/devices/lamp', { on: true }],
      ['POST', '/api/devices/bedroom_tv', { on: true }],
      ['GET', '/api/integrations', undefined],
      ['POST', '/api/ask', { text: 'everything off' }],
    ] as const) {
      const r = await app.inject({ method, url, headers: helix, ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 401, `${method} ${url}`);
    }
    const vol = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { vol: 80 } });
    assert.equal(vol.statusCode, 403);
    assert.equal(tvs.got.length, 2);
    // The master token still sees the whole house.
    assert.ok((await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer master' } })).json().devices.length > 2);
  } finally {
    await app.close();
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix link: commands answer within Helix’s timeout; a slow TV wake finishes in the background; an input right after “on” waits for it; failures say why', { timeout: 20_000 }, async () => {
  const hx = await fakeHelix();
  const t = await testHub(12);
  const tvs = new Tvs();
  await t.hub.reg.addAdapter(tvs);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-slow-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const link = new HelixLink(t.hub, { helix: () => manager.raw('helix'), dataDir: dir, port: () => 8140, debounceMs: 0, watchMs: 0, answerMs: 200 });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, token: 'master', helixLink: link });
  const helix = { authorization: `Bearer ${link.token}` };
  try {
    await manager.update('helix', { url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, kovaUrl: 'http://10.0.0.5:8140', rooms: { 'Lounge Helix': 'lounge' } });
    tvs.slowOnMs = 700;
    const started = Date.now();
    const on = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { on: true } });
    assert.equal(on.statusCode, 202, on.body);
    assert.deepEqual(on.json(), { ok: true, pending: true });
    assert.ok(Date.now() - started < 600, 'answered before the TV was up');
    // Helix sends the input straight after: accepted (never refused), and sent only once the TV is on.
    const inp = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { input: 'hdmi2' } });
    assert.ok(inp.statusCode === 202 || inp.statusCode === 200, inp.body);
    // …and again while it waits: joined.
    assert.ok([200, 202].includes((await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { input: 'hdmi2' } })).statusCode));
    // Helix asks again for "on" while it's still going: the same command, joined, not sent twice.
    assert.ok([200, 202].includes((await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { on: true } })).statusCode));
    for (let i = 0; i < 100 && tvs.got.length < 2; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(tvs.got.map(g => g.cmd), [{ on: true }, { input: 'hdmi2' }]);
    assert.equal(t.hub.reg.get('lounge_tv')!.state.on, true);
    // A device that fails: Helix gets {error} with why.
    tvs.slowOnMs = 0;
    tvs.fail = true;
    const bad = await app.inject({ method: 'POST', url: '/api/devices/lounge_bar', headers: helix, payload: { mute: true } });
    assert.equal(bad.statusCode, 502);
    assert.match(bad.json().error, /didn’t answer/);
  } finally {
    await app.close();
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix link: Kova’s address is plain http with an IP literal, sent again when it changes; Helix not reaching it, or turning the link off, is said', async () => {
  const hx = await fakeHelix({ reachable: false });
  const t = await testHub(12);
  await t.hub.reg.addAdapter(new Tvs());
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-addr-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  let nets: any = { eth0: [{ family: 'IPv4', address: '127.0.0.9', internal: false }] };
  const link = new HelixLink(t.hub, { helix: () => manager.raw('helix'), dataDir: dir, port: () => 8140, debounceMs: 0, watchMs: 0, nets: () => nets });
  try {
    await manager.update('helix', { url: hx.url, token: hx.TOKEN, pollSec: 0, feed: false, rooms: { 'Lounge Helix': 'lounge' } });
    // Helix on this machine (127.0.0.1): only a private address is offered, so none here.
    await link.sync();
    assert.equal(hx.puts.length, 0);
    assert.match(link.status()?.note ?? '', /no private network address/);
    nets = { eth0: [{ family: 'IPv4', address: '192.168.7.5', internal: false }] };
    await link.sync();
    assert.equal(hx.puts.at(-1)!.body.url, 'http://192.168.7.5:8140');
    // Helix can't reach that address: said, and sent again next time even with nothing changed.
    assert.deepEqual(link.status(), { ok: false, note: 'Helix can’t reach Kova at http://192.168.7.5:8140. Check Kova’s address for Helix.' });
    await link.sync();
    assert.equal(hx.puts.length, 2);
    // A new lease: Helix gets the new address.
    hx.s.reachable = true;
    nets = { eth0: [{ family: 'IPv4', address: '192.168.7.6', internal: false }] };
    await link.sync();
    assert.equal(hx.puts.at(-1)!.body.url, 'http://192.168.7.6:8140');
    assert.match(link.status()?.note ?? '', /Helix reaches Kova/);
    const n = hx.puts.length;
    await link.sync();
    assert.equal(hx.puts.length, n, 'nothing changed: not sent');
    // An address set by hand that Helix can't use: not sent, and why.
    for (const [kovaUrl, why] of [
      ['http://kova.local:8140', /IP address, not a name/], ['http://kova.example.ts.net:8140', /IP address, not a name/],
      ['https://192.168.7.6:8140', /plain http/], ['http://192.168.7.6:8140/kova', /nothing after it/], ['http://8.8.8.8:8140', /private network/],
    ] as const) {
      await manager.update('helix', { ...manager.raw('helix'), kovaUrl });
      await link.sync();
      assert.equal(hx.puts.length, n, kovaUrl);
      assert.match(link.status()?.note ?? '', why, kovaUrl);
      assert.equal(link.kovaUrl(), null);
    }
    // Helix turned the link off for its devices: nothing sent, and said.
    await manager.update('helix', { ...manager.raw('helix'), kovaUrl: 'http://192.168.7.6:8140' });
    hx.s.devices = false;
    await link.sync(true);
    assert.equal(hx.puts.length, n);
    assert.match(link.status()?.note ?? '', /turned off/);
  } finally {
    await t.hub.stop();
    await hx.close();
  }
});

test('Helix link: which TV a box is on, and Kova’s address', () => {
  const dev = (id: string, room: string, adapter: string, extra: Partial<Device> = {}): Device => ({ id, name: id, room, type: 'tv', capabilities: ['onoff'], adapter, integration: '', address: id, state: {}, ...extra });
  const boxes = [dev('box1', 'lounge', 'helix', { address: 'd1', name: 'Lounge Helix' }), dev('box2', 'den', 'helix', { address: 'd2', name: 'Den Helix' }), dev('box3', 'unassigned', 'helix', { address: 'd3' })];
  // Two TVs in the den: no guess until one is chosen.
  const tvs = [dev('tv1', 'lounge', 'samsung'), dev('tv2', 'den', 'samsung'), dev('tv3', 'den', 'lg')];
  assert.deepEqual(helixScreens([...boxes, ...tvs]).map(s => [s.playerId, s.tvDeviceId]), [['d1', 'tv1']]);
  assert.deepEqual(helixScreens([...boxes, ...tvs], { 'den helix': { tv: 'tv3', input: 'hdmi9' } }).map(s => [s.playerId, s.tvDeviceId, s.helixInput]), [['d1', 'tv1', undefined], ['d2', 'tv3', undefined]]);
  // A box's settings under a name it had before (aliases): still its.
  assert.deepEqual(helixScreens([...boxes, ...tvs], { 'Old den name': { tv: 'tv2' } }, b => b.id === 'box2' ? ['Old den name'] : []).map(s => [s.playerId, s.tvDeviceId]), [['d1', 'tv1'], ['d2', 'tv2']]);

  // One box and one TV in the home: they go together without rooms, and so does the one soundbar.
  const box = dev('box', 'unassigned', 'helix', { address: 'd-0000000000000001', name: 'Helix box' });
  const tv = dev('tv', 'living_room', 'samsungtv', { name: 'TV', capabilities: ['onoff', 'volume', 'input'] });
  const bar = dev('bar', 'living_room', 'smartthings', { type: 'media', name: 'Soundbar', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'] });
  assert.deepEqual(helixScreens([box, tv, bar]).map(s => [s.playerId, s.tvDeviceId, s.soundbarDeviceId]), [['d-0000000000000001', 'tv', 'bar']]);
  // Two TVs (or two boxes): no guess.
  assert.deepEqual(helixScreens([box, tv, dev('tv9', 'bedroom', 'samsungtv')]), []);

  // Kova's address: an IP literal on Helix's network, else a private one, else a tailnet one, else a unique-local IPv6 one.
  const nets = { eth0: [{ family: 'IPv4', address: '10.10.10.5', internal: false }], docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }] } as any;
  assert.equal(kovaAddress('http://10.10.10.101:8090', 8140, nets), 'http://10.10.10.5:8140');
  assert.equal(kovaAddress('http://helix.local:8090', 8140, { docker0: nets.docker0 }), 'http://172.17.0.1:8140');
  assert.equal(kovaAddress('http://helix.local:8090', 8140, { tailscale0: [{ family: 'IPv4', address: '100.95.1.5', internal: false }] } as any), 'http://100.95.1.5:8140');
  assert.equal(kovaAddress('http://helix.local:8090', 8140, { eth0: [{ family: 'IPv6', address: 'fd12:3456:789a::5', internal: false }] } as any), 'http://[fd12:3456:789a::5]:8140');
  assert.equal(kovaAddress('http://helix.local:8090', 8140, { eth0: [{ family: 'IPv4', address: '8.8.8.8', internal: false }] } as any), null);
  assert.equal(kovaUrlProblem('http://192.168.1.5:8140'), null);
  assert.equal(kovaUrlProblem('http://100.95.1.5:8140'), null);
  assert.equal(kovaUrlProblem('http://[fd12::5]:8140'), null);
  assert.match(kovaUrlProblem('http://kova.lan:8140')!, /not a name/);
  assert.match(kovaUrlProblem('http://127.0.0.1:8140', 'http://192.168.1.2:8090')!, /loopback/);
  assert.equal(kovaUrlProblem('http://127.0.0.1:8140', 'http://127.0.0.1:8090'), null);
});

test('Helix boxes: only screens are TVs, not Kova itself, a phone or the desktop app', () => {
  assert.equal(isScreen({ name: 'Helix box 192.168.1.30', client: 'helix-tv' }), true);
  assert.equal(isScreen({ name: 'shell', client: 'helix-desk' }), true);
  assert.equal(isScreen({ name: 'Lounge', client: 'helix-atv' }), true);
  assert.equal(isScreen({ name: 'Old box' }), true);
  assert.equal(isScreen({ name: 'Helix on a laptop', client: 'helix-desktop' }), false);
  assert.equal(isScreen({ name: 'Phone', client: 'helix-mobile' }), false);
  assert.equal(isScreen({ name: 'Kova', client: 'kova/1' }), false);
  assert.equal(isScreen({ name: 'Kova' }), false);
});

/** A Helix box as the Helix adapter announces it; the test switches it offline like Helix's player.offline does. */
class Box implements Adapter {
  id = 'helix'; name = 'Helix'; icon = 'movie'; kind = 'Local' as const; ctx!: AdapterContext;
  async start(ctx: AdapterContext) {
    this.ctx = ctx;
    ctx.announce([{ id: 'helix_lounge_box', name: 'Lounge box', room: 'lounge', type: 'tv', capabilities: ['onoff', 'media', 'pause', 'library'], integration: 'Helix', address: 'd-box1', state: { on: true, online: true } }]);
  }
  async stop() {}
  status() { return { ok: true }; }
  async command() {}
}
class SeenTvs extends Tvs {
  override async command(d: Device, cmd: Command) { this.got.push({ id: d.id, cmd }); return undefined; }
}

async function boxOnTv(screens: Record<string, unknown> = { 'Lounge box': { tv: 'lounge_tv', input: 'hdmi4', soundbar: 'lounge_bar' } }) {
  const t = await testHub(12);
  const tvs = new SeenTvs(), box = new Box();
  await t.hub.reg.addAdapter(tvs);
  await t.hub.reg.addAdapter(box);
  const cfg: Record<string, unknown> = { url: 'http://helix', token: 'hxd', screens };
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-off-'));
  const link = new HelixLink(t.hub, { helix: () => cfg, dataDir: dir, port: () => 8140, debounceMs: 60_000, watchMs: 0 });
  t.hub.screens = () => link.screens().flatMap(s => {
    const b = [...t.hub.reg.devices.values()].find(d => d.adapter === 'helix' && d.address === s.playerId);
    return b ? [{ player: b.id, tv: s.tvDeviceId, input: s.helixInput, soundbar: s.soundbarDeviceId, ...(s.soundbarDeviceId ? { soundbarInputs: [...new Set([s.soundbarTvInput ?? 'tv', s.soundbarAdapterInput ?? 'hdmi1'])] } : {}) }] : [];
  });
  const settle = () => new Promise(r => setTimeout(r, 40));
  const offs = () => tvs.got.filter(g => g.cmd.on === false).map(g => g.id).sort();
  return { t, tvs, box, link, settle, offs, cfg };
}

test('Helix link: the box-offline backstop turns the TV and soundbar off only while they still show the box and nobody switched them', async () => {
  const { t, tvs, box, link, settle, offs } = await boxOnTv();
  const helix = { kind: 'behaviour' as const, id: 'helix-auto', label: 'Helix (switching for what plays)' };
  const person = { kind: 'user' as const, label: 'You' };
  let done = false;
  const carry = (wasOff = false) => carryOverTvOff({
    done: () => done, markDone: () => { done = true; }, wasOff: () => wasOff, graceMs: 1000,
    ideas: () => automationIdeas(t.hub.config.get(), t.hub.reg.devices, t.hub.screens()),
    add: a => { t.hub.config.update(c => { (c.automations ??= []).push({ id: 'carried', ...a }); }); },
    on: fn => { t.hub.reg.on('devices', fn); return () => t.hub.reg.off('devices', fn); },
  });
  try {
    // Turned off in the old setting: nothing carried over, and it's only suggested.
    carry(true);
    assert.equal(done, true);
    assert.equal(t.hub.config.get().automations?.length ?? 0, 0);
    done = false;
    carry();
    const a = t.hub.config.get().automations!;
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].triggers, a[0].conditions], [
      [{ kind: 'device', device: 'helix_lounge_box', to: { online: false } }],
      [{ kind: 'device', device: 'lounge_tv', is: { on: true, input: 'hdmi4', inputByPerson: false } }],
    ]);
    assert.deepEqual(a[0].actions, [
      { kind: 'set', targets: { lounge_tv: { on: false } } },
      { kind: 'if', conditions: [
        { kind: 'device', device: 'lounge_bar', is: { on: true, inputByPerson: false } },
        { kind: 'any', conditions: [{ kind: 'device', device: 'lounge_bar', is: { input: 'tv' } }, { kind: 'device', device: 'lounge_bar', is: { input: 'hdmi1' } }] },
      ], then: [{ kind: 'set', targets: { lounge_bar: { on: false } } }] },
    ]);
    carry();
    assert.equal(t.hub.config.get().automations!.length, 1, 'once only');
    const cycle = async () => { box.ctx.report('helix_lounge_box', { online: true }); await settle(); tvs.got.length = 0; box.ctx.report('helix_lounge_box', { online: false, on: false }); await settle(); };

    // Helix switched the TV to the box (a TV whose input can't be read back); the soundbar is on its eARC: both off.
    await t.hub.reg.command('lounge_tv', { on: true }, helix);
    await t.hub.reg.command('lounge_tv', { input: 'hdmi4' }, helix);
    await t.hub.reg.command('lounge_bar', { on: true }, helix);
    await cycle();
    assert.deepEqual(offs(), ['lounge_bar', 'lounge_tv']);
    assert.ok(t.hub.store.feed(40).some(e => /Lounge box turned offline/.test(e.what)), 'in Activity, with why');

    // Someone switched the TV to another input: left alone, soundbar too.
    tvs.ctx.report('lounge_tv', { on: true });
    tvs.ctx.report('lounge_bar', { on: true });
    await t.hub.reg.command('lounge_tv', { input: 'hdmi1' }, person);
    await cycle();
    assert.deepEqual(offs(), []);
    // …even when they switched it back to the box themselves (a person chose it).
    await t.hub.reg.command('lounge_tv', { input: 'hdmi4' }, person);
    await cycle();
    assert.deepEqual(offs(), []);
    // The TV's own remote put it on the box's input (read back): a person, left alone.
    await t.hub.reg.command('lounge_tv', { input: 'hdmi4' }, helix);
    tvs.ctx.report('lounge_tv', { input: 'hdmi2' });
    tvs.ctx.report('lounge_tv', { input: 'hdmi4' });
    await cycle();
    assert.deepEqual(offs(), []);
    // Helix's own switching again (from another input); the soundbar moved to Bluetooth by someone: the TV goes off,
    // the soundbar plays on.
    tvs.ctx.report('lounge_tv', { input: 'hdmi1' });
    await t.hub.reg.command('lounge_tv', { input: 'hdmi4' }, helix);
    await t.hub.reg.command('lounge_bar', { input: 'bluetooth' }, person);
    await cycle();
    assert.deepEqual(offs(), ['lounge_tv']);

    // The automation switched off: left alone.
    tvs.ctx.report('lounge_tv', { on: true, input: 'hdmi1' });
    await t.hub.reg.command('lounge_tv', { input: 'hdmi4' }, helix);
    t.hub.config.update(c => { c.automations![0].enabled = false; });
    await cycle();
    assert.deepEqual(offs(), []);

    // Coming back (screen.awake) does nothing on Kova's side: Helix sends on/input itself.
    tvs.ctx.report('lounge_tv', { on: false });
    box.ctx.report('helix_lounge_box', { online: true, on: true });
    await settle();
    assert.deepEqual(tvs.got.filter(g => g.cmd.on === true), []);
  } finally {
    link.stop();
    await t.hub.stop();
  }
});

test('Helix link: without the box’s input in settings, the backstop needs Helix to have switched the TV last', async () => {
  const { t, tvs, box, link, settle, offs } = await boxOnTv({ 'Lounge box': { tv: 'lounge_tv' } });
  try {
    const idea = automationIdeas(t.hub.config.get(), t.hub.reg.devices, t.hub.screens()).find(i => i.key.startsWith('tv-off-with:'))!;
    assert.deepEqual(idea.conditions, [{ kind: 'device', device: 'lounge_tv', is: { on: true, inputBy: 'helix-auto' } }]);
    assert.match(idea.why, /Helix switched it/);
    const { key: _k, why: _w, ...a } = idea;
    t.hub.config.update(c => { (c.automations ??= []).push({ id: 'x', ...a, enabled: true }); });
    tvs.ctx.report('lounge_tv', { on: true });
    // Nobody ever switched it through Kova: left alone.
    box.ctx.report('helix_lounge_box', { online: false });
    await settle();
    assert.deepEqual(offs(), []);
    box.ctx.report('helix_lounge_box', { online: true });
    await t.hub.reg.command('lounge_tv', { input: 'hdmi3' }, { kind: 'behaviour', id: 'helix-auto', label: 'Helix' });
    box.ctx.report('helix_lounge_box', { online: false });
    await settle();
    assert.deepEqual(offs(), ['lounge_tv']);
  } finally {
    link.stop();
    await t.hub.stop();
  }
});

test('Helix link: a TV-off automation Kova made before gets today’s conditions; one the owner changed is left alone', async () => {
  const { t, link } = await boxOnTv();
  const screens = t.hub.screens();
  const old: Automation = {
    id: 'tv_off_1', name: 'Lounge TV off when Lounge box shuts down', enabled: false, mode: 'single',
    triggers: [{ kind: 'device', device: 'helix_lounge_box', to: { online: false } }],
    conditions: [{ kind: 'device', device: 'lounge_tv', is: { on: true, input: 'hdmi4' } }],
    actions: [{ kind: 'set', targets: { lounge_tv: { on: false }, lounge_bar: { on: false } } }],
  };
  try {
    const up = upgradeTvOffWithBox(old, screens, t.hub.reg.devices)!;
    assert.deepEqual({ id: up.id, name: up.name, enabled: up.enabled }, { id: 'tv_off_1', name: old.name, enabled: false }, 'the owner’s name and switch kept');
    assert.deepEqual(up.conditions, [{ kind: 'device', device: 'lounge_tv', is: { on: true, input: 'hdmi4', inputByPerson: false } }]);
    assert.equal(up.actions.length, 2);
    assert.equal(upgradeTvOffWithBox({ ...old, conditions: [...old.conditions, { kind: 'mode', modes: ['evening'] }] }, screens, t.hub.reg.devices), null);
    assert.equal(upgradeTvOffWithBox({ ...old, actions: [{ kind: 'set', targets: { lounge_tv: { on: false }, lamp: { on: false } } }] }, screens, t.hub.reg.devices), null);
    // Once, at start, through the config.
    t.hub.config.update(c => { (c.automations ??= []).push(old, { ...old, id: 'mine', conditions: [] }); });
    let done = false;
    upgradeTvOffOnce({
      done: () => done, markDone: () => { done = true; }, graceMs: 1000,
      automations: () => t.hub.config.get().automations ?? [], screens: () => t.hub.screens(), devices: () => t.hub.reg.devices,
      save: a => t.hub.config.update(c => { c.automations = (c.automations ?? []).map(x => x.id === a.id ? a : x); }),
      on: fn => { t.hub.reg.on('devices', fn); return () => t.hub.reg.off('devices', fn); },
    });
    assert.equal(done, true);
    const saved = t.hub.config.get().automations!;
    assert.deepEqual(saved.find(a => a.id === 'tv_off_1')!.conditions, up.conditions);
    assert.deepEqual(saved.find(a => a.id === 'mine')!.conditions, []);
  } finally {
    link.stop();
    await t.hub.stop();
  }
});
