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
import { HelixLink, SOUNDBAR_INPUTS, SOUNDBAR_MODES, TV_INPUTS, helixScreens, kovaAddress } from '../src/services/helix-link.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';
import type { Command, Device } from '../src/model/types.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

/** Helix Server: boxes, and PUT /v1/integrations/kova like the real one. */
async function fakeHelix() {
  const TOKEN = 'hxd_' + 'c'.repeat(64);
  const puts: { auth?: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      if (req.url === '/v1/boxes') return send(200, { boxes: [{ id: 'd-lounge', name: 'Lounge Helix', online: true }, { id: 'd-bed', name: 'Bedroom Helix', online: true }] });
      if (/^\/v1\/boxes\/[^/]+\/state$/.test(req.url!)) return send(200, { mode: 'browse' });
      if (req.method === 'PUT' && req.url === '/v1/integrations/kova') {
        puts.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        return send(200, { linked: true, reachable: true });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN, puts, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A Samsung-like TV in the lounge and one in the bedroom. */
class Tvs implements Adapter {
  id = 'tvs'; name = 'TVs'; icon = 'tv'; kind = 'Local' as const;
  got: { id: string; cmd: Command }[] = [];
  async start(ctx: AdapterContext) {
    ctx.announce([
      { id: 'lounge_tv', name: 'Lounge TV', room: 'lounge', type: 'tv', capabilities: ['onoff', 'volume', 'input'], integration: 'Samsung', address: '10.0.0.20', state: { on: false, online: true } },
      { id: 'bedroom_tv', name: 'Bedroom TV', room: 'bedroom', type: 'tv', capabilities: ['onoff', 'input'], integration: 'Samsung', address: '10.0.0.21', state: { on: false, online: true } },
      { id: 'lounge_bar', name: 'Soundbar', room: 'lounge', type: 'media', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'], integration: 'Samsung soundbar', address: 'st-1', state: { on: false, online: true, vol: 12, input: 'tv' } },
    ]);
  }
  async stop() {}
  status() { return { ok: true }; }
  // Like the Samsung adapter: a TV can't say its input, so it isn't kept.
  async command(d: Device, cmd: Command) { this.got.push({ id: d.id, cmd }); if (d.type === 'tv' && cmd.input) return { input: null }; }
}

test('Helix link: after pairing Kova tells Helix where it is, a token and which TV each box is on; the token only reaches those TVs', async () => {
  const hx = await fakeHelix();
  const t = await testHub(12, c => { if (!c.rooms.some(r => r.id === 'bedroom')) c.rooms.push({ id: 'bedroom', name: 'Bedroom', icon: 'bed' }); });
  const tvs = new Tvs();
  await t.hub.reg.addAdapter(tvs);
  const dir = mkdtempSync(join(tmpdir(), 'kova-helix-link-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const link = new HelixLink(t.hub, { helix: () => manager.raw('helix'), dataDir: dir, port: () => 8140, debounceMs: 0 });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, token: 'master', helixLink: link });
  try {
    // The token is made once, kept to the owner, and survives a restart.
    assert.match(link.token, /^kvh_[0-9a-f]{48}$/);
    assert.equal(statSync(join(dir, 'helix-link.json')).mode & 0o777, 0o600);
    assert.equal(new HelixLink(t.hub, { helix: () => undefined, dataDir: dir, port: () => 8140 }).token, link.token);
    assert.equal(JSON.parse(readFileSync(join(dir, 'helix-link.json'), 'utf8')).token, link.token);

    // Not paired: nothing is sent.
    await link.sync();
    assert.equal(hx.puts.length, 0);

    // Paired, boxes in rooms: each box gets the one TV in its room; the box's input comes from settings.
    await manager.update('helix', { url: hx.url, token: hx.TOKEN, pollSec: 0, kovaUrl: 'http://10.0.0.5:8140', rooms: { 'Lounge Helix': 'lounge', 'Bedroom Helix': 'bedroom' }, screens: { 'Lounge Helix': { input: 'hdmi2' } } });
    await link.sync();
    assert.equal(hx.puts.length, 1);
    assert.equal(hx.puts[0].auth, `Bearer ${hx.TOKEN}`);
    assert.deepEqual(hx.puts[0].body, {
      url: 'http://10.0.0.5:8140', token: link.token,
      screens: [
        { playerId: 'd-bed', tvDeviceId: 'bedroom_tv', tvName: 'Bedroom TV', inputs: TV_INPUTS },
        // The soundbar in the TV's room goes with it, with the inputs Helix may pick and the one the box is wired to.
        {
          playerId: 'd-lounge', tvDeviceId: 'lounge_tv', tvName: 'Lounge TV', helixInput: 'hdmi2', inputs: TV_INPUTS,
          soundbarDeviceId: 'lounge_bar', soundbarName: 'Soundbar', soundbarInputs: SOUNDBAR_INPUTS, soundbarModes: SOUNDBAR_MODES, soundbarNight: true,
          soundbarTvInput: 'tv', soundbarAdapterInput: 'hdmi1',
        },
      ],
    });
    assert.deepEqual(link.status(), { ok: true, note: 'Helix turns on 2 TVs through Kova' });

    // Nothing changed: not sent again. A box moves rooms: sent again.
    await link.sync();
    assert.equal(hx.puts.length, 1);
    await manager.update('helix', { ...manager.raw('helix'), rooms: { 'Lounge Helix': 'lounge', 'Bedroom Helix': 'kitchen' } });
    await link.sync();
    assert.equal(hx.puts.length, 2);
    assert.deepEqual(hx.puts[1].body.screens.map((s: { playerId: string }) => s.playerId), ['d-lounge']);

    // Helix calls back with its token: the lounge TV turns on and changes input.
    const helix = { authorization: `Bearer ${link.token}` };
    const on = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { on: true } });
    assert.equal(on.statusCode, 200, on.body);
    const inp = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: helix, payload: { input: 'hdmi2' } });
    assert.equal(inp.statusCode, 200, inp.body);
    assert.deepEqual(tvs.got, [{ id: 'lounge_tv', cmd: { on: true } }, { id: 'lounge_tv', cmd: { input: 'hdmi2' } }]);
    // The soundbar under it: Helix sends one command at a time, by its own names (D98.11).
    for (const payload of [{ on: true }, { volumeStep: 1 }, { volume: 20 }, { mute: true }, { input: 'hdmi1' }, { mode: 'surround' }, { nightMode: true }]) {
      const r = await app.inject({ method: 'POST', url: '/api/devices/lounge_bar', headers: helix, payload });
      assert.equal(r.statusCode, 200, `${JSON.stringify(payload)} ${r.body}`);
    }
    assert.deepEqual(tvs.got.filter(g => g.id === 'lounge_bar').map(g => g.cmd), [{ on: true }, { volStep: 1 }, { vol: 20 }, { muted: true }, { input: 'hdmi1' }, { sound: 'surround' }, { night: true }]);
    for (const payload of [{ media: 'Radio' }, { volume: 20, mute: true }, { input: 'hdmi9' }, { volumeStep: 5 }, { mode: 'loud' }, { vol: 20 }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/devices/lounge_bar', headers: helix, payload })).statusCode, 403, JSON.stringify(payload));
    }
    tvs.got = tvs.got.filter(g => g.id !== 'lounge_bar');
    // Helix switching by itself marks it; Kova says who changed each input last, so Helix never switches back someone's choice.
    const auto = await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: { ...helix, 'x-helix-origin': 'auto' }, payload: { input: 'hdmi2' } });
    assert.equal(auto.statusCode, 200, auto.body);
    tvs.got.pop();
    // Its /api/state lists the linked TVs and soundbars only, by Helix's names.
    const st = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    const at = (id: string) => st.devices.find((d: { id: string }) => d.id === id).state;
    assert.equal(at('lounge_tv').inputChangedBy, 'helix-auto');
    assert.equal(typeof at('lounge_tv').inputChangedAt, 'number');
    assert.equal(at('lounge_bar').inputChangedBy, 'Helix remote');
    for (const d of st.devices) delete d.state.inputChangedAt;
    assert.deepEqual(st, { devices: [
      { id: 'lounge_tv', name: 'Lounge TV', type: 'tv', state: { on: true, online: true, input: 'hdmi2', inputChangedBy: 'helix-auto' } },
      { id: 'lounge_bar', name: 'Soundbar', type: 'soundbar', state: { on: true, online: true, input: 'hdmi1', volume: 20, muted: true, mode: 'surround', nightMode: true, inputChangedBy: 'Helix remote' } },
    ] });
    // Someone changes the TV's input in Kova's app: Helix sees it wasn't its own switching.
    await app.inject({ method: 'POST', url: '/api/devices/lounge_tv', headers: { authorization: 'Bearer master' }, payload: { input: 'hdmi3' } });
    tvs.got.pop();
    const st2 = (await app.inject({ method: 'GET', url: '/api/state', headers: helix })).json();
    assert.deepEqual([st2.devices[0].state.input, st2.devices[0].state.inputChangedBy], ['hdmi3', 'You']);

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

test('Helix link: which TV a box is on, and Kova’s address', () => {
  const dev = (id: string, room: string, adapter: string, extra: Partial<Device> = {}): Device => ({ id, name: id, room, type: 'tv', capabilities: ['onoff'], adapter, integration: '', address: id, state: {}, ...extra });
  const boxes = [dev('box1', 'lounge', 'helix', { address: 'd1', name: 'Lounge Helix' }), dev('box2', 'den', 'helix', { address: 'd2', name: 'Den Helix' }), dev('box3', 'unassigned', 'helix', { address: 'd3' })];
  // Two TVs in the den: no guess until one is chosen.
  const tvs = [dev('tv1', 'lounge', 'samsung'), dev('tv2', 'den', 'samsung'), dev('tv3', 'den', 'lg')];
  assert.deepEqual(helixScreens([...boxes, ...tvs]).map(s => [s.playerId, s.tvDeviceId]), [['d1', 'tv1']]);
  assert.deepEqual(helixScreens([...boxes, ...tvs], { 'den helix': { tv: 'tv3', input: 'hdmi9' } }).map(s => [s.playerId, s.tvDeviceId, s.helixInput]), [['d1', 'tv1', undefined], ['d2', 'tv3', undefined]]);

  // One box and one TV in the home: they go together without rooms, and so does the one soundbar.
  const kam = dev('kam', 'unassigned', 'helix', { address: 'addr:10.10.30.224', name: 'Helix box 10.10.30.224' });
  const s90d = dev('s90d', 'living_room', 'samsungtv', { name: 'S90D', capabilities: ['onoff', 'volume', 'input'] });
  const q930b = dev('q930b', 'living_room', 'smartthings', { type: 'media', name: 'Soundbar Q930B', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'] });
  assert.deepEqual(helixScreens([kam, s90d, q930b]).map(s => [s.playerId, s.tvDeviceId, s.soundbarDeviceId]), [['addr:10.10.30.224', 's90d', 'q930b']]);
  // Two TVs (or two boxes): no guess.
  assert.deepEqual(helixScreens([kam, s90d, dev('tv9', 'bedroom', 'samsungtv')]), []);

  const nets = { eth0: [{ family: 'IPv4', address: '10.10.10.5', internal: false }], docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }] } as any;
  assert.equal(kovaAddress('http://10.10.10.101:8090', 8140, nets), 'http://10.10.10.5:8140');
  assert.equal(kovaAddress('http://helix.local:8090', 8140, { docker0: nets.docker0 }), 'http://172.17.0.1:8140');
});

test('Helix boxes: only screens are TVs, not Kova itself, a phone or the desktop app', () => {
  assert.equal(isScreen({ name: 'Helix box 10.10.30.224', client: 'helix-tv' }), true);
  assert.equal(isScreen({ name: 'kam-lx', client: 'helix-desk' }), true);
  assert.equal(isScreen({ name: 'Lounge', client: 'helix-atv' }), true);
  assert.equal(isScreen({ name: 'Old box' }), true);
  assert.equal(isScreen({ name: 'Helix on macbookpro', client: 'helix-desktop' }), false);
  assert.equal(isScreen({ name: 'Phone', client: 'helix-mobile' }), false);
  assert.equal(isScreen({ name: 'Kova', client: 'kova/1' }), false);
  assert.equal(isScreen({ name: 'Kova' }), false);
});

test('Helix boxes: a box that gets a stable id is followed, and the old entry goes, so it stays one screen', async () => {
  let boxes = [
    { id: 'addr:10.10.30.224', name: '', client: 'helix-tv', address: '10.10.30.224', online: true },
    { id: 'd-f319d15f52060c18', name: 'Helix on macbookpro', client: 'helix-desktop', online: true },
    { id: 'd-kova', name: 'Kova', client: 'kova/1', online: true },
  ];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/boxes' ? { boxes } : { mode: 'browse' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { HelixAdapter } = await import('../src/adapters/helix.ts');
  const t = await testHub(12);
  const tvs = new Tvs();
  await t.hub.reg.addAdapter(tvs);
  const helix = new HelixAdapter({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'hxd_x', pollSec: 0, feed: false, boxesSec: 0 });
  try {
    await t.hub.reg.addAdapter(helix);
    const screens = () => helixScreens(t.hub.reg.devices.values()).map(s => s.playerId);
    const boxIds = () => t.hub.reg.list().filter(d => d.adapter === 'helix').map(d => d.address);
    // Only the TV box is a box: not the desktop app, not Kova.
    assert.deepEqual(boxIds(), ['addr:10.10.30.224']);
    // The box gets its stable id (and its paired name): Kova follows it, and the address-based entry goes.
    boxes = [{ id: 'd-f2c33be4dd4e34ab', name: 'kam-lx', client: 'helix-tv', address: '10.10.30.224', online: true }, ...boxes.slice(1)];
    await helix.refreshBoxes();
    assert.deepEqual(boxIds(), ['d-f2c33be4dd4e34ab']);
    // Same name, new id: announced again with it.
    boxes = [{ ...boxes[0], id: 'd-f2c33be4dd4e34ab-2' }, ...boxes.slice(1)];
    await helix.refreshBoxes();
    assert.deepEqual(boxIds(), ['d-f2c33be4dd4e34ab-2']);
    assert.equal(screens().length <= 1, true);
  } finally {
    await t.hub.stop();
    server.close();
  }
});
