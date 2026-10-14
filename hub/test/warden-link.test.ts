import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { testHub } from './helpers.ts';
import { WardenLink, houseMode, kovaDevicesForWarden, wardenRef } from '../src/services/warden-link.ts';
import { wardenFeed } from '../src/adapters/warden.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';
import type { Command, Device } from '../src/model/types.ts';

/** Warden's /integrations/kova/* and /power-cycles, recording what Kova sends. */
async function fakeWarden() {
  const s = { got: [] as { method: string; path: string; body: any }[], deny: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== 'Bearer tok') return send(401, { error: 'unauthorised' });
      if (s.deny) return send(403, { error: "this app's access does not cover that" });
      const path = req.url!.replace(/^\/api\/v1/, '');
      s.got.push({ method: req.method!, path, body });
      if (path === '/integrations/kova/devices') return send(200, { devices: body, matched: body.map((d: any) => ({ kovaId: d.kovaId, ...(d.ip === '192.168.1.41' ? { deviceId: 'dev_lamp' } : {}) })) });
      if (path === '/integrations/kova/access') return send(200, { waiting: true });
      if (path.startsWith('/survey')) return send(404, { error: 'not found' }); // a Warden without the Wi-Fi survey
      send(200, { ok: true });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const last = (path: string) => s.got.filter(g => g.path === path).at(-1);
  return { url, s, last, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

class Lan implements Adapter {
  id = 'tapo'; name = 'Tapo'; icon = 'power'; kind = 'Local' as const;
  got: string[] = [];
  async start(ctx: AdapterContext) {
    ctx.announce([
      { id: 'lounge_lamp', name: 'Lounge lamp', room: 'lounge', type: 'plug', capabilities: ['onoff'], integration: 'Tapo P100', address: '192.168.1.41', state: { on: true, online: true } },
      { id: 'hallway_plug', name: 'Hallway plug', room: 'lounge', type: 'plug', capabilities: ['onoff'], integration: 'Tapo P110', address: '10.10.0.200', state: { on: true, online: true } },
    ]);
  }
  async stop() {}
  status() { return { ok: true }; }
  async command(d: Device, c: Command) { this.got.push(`${d.id} ${c.on ? 'on' : 'off'}`); }
}

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  for (let i = 0; i < ms && !ok(); i += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test('Warden link: Kova shares its devices, people, house mode, hub and plugs, and only what changed', async () => {
  const w = await fakeWarden();
  const t = await testHub(12);
  const lan = new Lan();
  await t.hub.reg.addAdapter(lan);
  const cfg = { url: w.url, token: 'tok', outlets: [{ plug: 'hallway_plug', powers: '52-54-00-CC-00-01', role: 'modem' }, { plug: 'nope', powers: 'dev_x' }] };
  let clock = Date.parse('2026-10-01T09:00:00Z');
  const link = new WardenLink(t.hub, { warden: () => cfg, port: () => 8140, people: () => ({ alex: { wardenPerson: 'person-alex' }, jordan: {} }), debounceMs: 0, now: () => clock });
  try {
    await link.sync();
    // Devices Kova reaches on the LAN, by IP, with kind, room and the port Kova uses; simulated devices aren't sent.
    const devs = w.last('/integrations/kova/devices')!.body;
    assert.deepEqual(devs, [
      { kovaId: 'hallway_plug', ip: '10.10.0.200', name: 'Hallway plug', manufacturer: 'Tapo', model: 'Tapo P110', kind: 'plug', room: 'Lounge', controls: [{ protocol: 'tcp', port: 80 }] },
      { kovaId: 'lounge_lamp', ip: '192.168.1.41', name: 'Lounge lamp', manufacturer: 'Tapo', model: 'Tapo P100', kind: 'plug', room: 'Lounge', controls: [{ protocol: 'tcp', port: 80 }] },
    ]);
    assert.deepEqual(w.last('/integrations/kova/people')!.body, [{ kovaPersonId: 'alex', wardenPersonId: 'person-alex' }]);
    // The plug that feeds the modem; a plug Kova doesn't have is left out.
    assert.deepEqual(w.last('/integrations/kova/outlets')!.body, [{ outletId: 'hallway_plug', name: 'Hallway plug', room: 'Lounge', powers: { mac: '52:54:00:cc:00:01' }, canCycle: true, role: 'modem' }]);
    assert.match(w.last('/integrations/kova/hub')!.body.ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.deepEqual(w.last('/integrations/kova/mode')!.body, { mode: 'home' });
    assert.deepEqual(link.status(), { ok: true, note: 'Warden knows 2 of Kova’s devices (1 matched) · house mode home · access rule waiting for your Warden admin' });

    // Nothing changed: nothing re-sent.
    const n = w.s.got.filter(g => g.method === 'PUT').length;
    await link.sync();
    assert.equal(w.s.got.filter(g => g.method === 'PUT').length, n);
    // A device is renamed: only the device list goes again.
    t.hub.reg.get('lounge_lamp')!.name = 'Reading lamp';
    await link.sync();
    assert.deepEqual(w.s.got.filter(g => g.method === 'PUT').slice(n).map(g => g.path), ['/integrations/kova/devices']);
    // Everyone leaves: the house is away. And the mode is re-sent every 6 hours even when it hasn't changed.
    for (const id of Object.keys(t.hub.engine.people)) await t.hub.engine.setPresence(id, false, 'test');
    await link.sync();
    assert.deepEqual(w.last('/integrations/kova/mode')!.body, { mode: 'away' });
    const modes = w.s.got.filter(g => g.path === '/integrations/kova/mode').length;
    clock += 7 * 3600_000;
    await link.sync();
    assert.equal(w.s.got.filter(g => g.path === '/integrations/kova/mode').length, modes + 1);

    // A phone arrives: Warden hears it, under the Warden person it's mapped to.
    await link.presence('alex', true, 'Phone automation');
    assert.deepEqual(w.last('/integrations/kova/presence')!.body, { person: 'person-alex', kovaPersonName: 'Alex', home: true, at: new Date(clock).toISOString(), source: 'geofence' });

    // A token from before the integration permission: say so plainly.
    w.s.deny = true;
    t.hub.reg.get('lounge_lamp')!.name = 'Lamp';
    await link.sync();
    assert.match(link.status()!.note, /Pair with Warden again/);
    assert.equal(link.status()!.ok, false);
  } finally {
    await t.hub.stop();
    await w.close();
  }
});

test('Warden link: a restart request switches the plug off, waits, on, and answers', { timeout: 20_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(12);
  const lan = new Lan();
  await t.hub.reg.addAdapter(lan);
  const cfg = { url: w.url, token: 'tok', outlets: [{ plug: 'hallway_plug', powers: '52:54:00:cc:00:01' }, { plug: 'lounge_lamp', powers: 'dev_tv', canCycle: false }] };
  const link = new WardenLink(t.hub, { warden: () => cfg, port: () => 8140, debounceMs: 60_000 });
  link.start();
  try {
    const req = (id: string, outletId: string, extra: Record<string, unknown> = {}) => wardenFeed.emit('event', {
      id: `evt_${id}`, seq: 1, type: 'power.cycle_requested', at: new Date().toISOString(),
      data: { requestId: id, deviceId: 'dev_ap', deviceName: 'Hallway AP', outletId, outletName: 'Hallway plug', reason: 'unresponsive', offSeconds: 1, expiresAt: new Date(Date.now() + 120_000).toISOString(), ...extra },
    });
    const t0 = Date.now();
    req('pc_1', 'hallway_plug');
    await until('answered', () => !!w.last('/power-cycles/pc_1'));
    assert.deepEqual(lan.got, ['hallway_plug off', 'hallway_plug on']);
    assert.ok(Date.now() - t0 >= 1000, 'waited offSeconds');
    assert.deepEqual(w.last('/power-cycles/pc_1')!.body, { status: 'done' });
    // Activity is written around the answer, not necessarily before it: wait for it rather than assume (busy build machines).
    await until('in Activity', () => t.hub.store.feed(20).some(e => e.what === 'Restarted Hallway AP by switching Hallway plug off and on'));

    // The same request again (a replay after reconnecting): nothing happens twice.
    req('pc_1', 'hallway_plug');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(lan.got.length, 2);
    // A plug that mustn't be cut, or one Kova doesn't know: refused, never switched.
    req('pc_2', 'lounge_lamp');
    req('pc_3', 'kitchen_plug');
    await until('refused', () => !!w.last('/power-cycles/pc_2') && !!w.last('/power-cycles/pc_3'));
    assert.equal(w.last('/power-cycles/pc_2')!.body.status, 'refused');
    assert.equal(w.last('/power-cycles/pc_3')!.body.status, 'refused');
    // Run out before Kova saw it: never acted on.
    req('pc_4', 'hallway_plug', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(lan.got.length, 2);
    assert.equal(w.last('/power-cycles/pc_4'), undefined);
  } finally {
    link.stop();
    await t.hub.stop();
    await w.close();
  }
});

test('Warden link helpers', () => {
  assert.deepEqual(wardenRef('dev_7qk2'), { deviceId: 'dev_7qk2' });
  assert.deepEqual(wardenRef('AA-BB-CC-DD-EE-FF'), { mac: 'aa:bb:cc:dd:ee:ff' });
  assert.deepEqual(wardenRef('10.0.0.9'), { ip: '10.0.0.9' });
  assert.equal(wardenRef('lounge'), null);
  assert.equal(houseMode(['Evening'], true), 'home');
  assert.equal(houseMode(['Night', 'night'], true), 'night');
  assert.equal(houseMode(['Evening'], false), 'away');
  assert.equal(houseMode(['Morning', '', 'vacation', 'Holiday'], false), 'vacation');
  const dev = (x: Partial<Device>): Device => ({ id: 'x', name: 'X', room: 'r', type: 'light', capabilities: [], adapter: 'tuya', integration: 'Tuya', address: '', state: {}, ...x });
  assert.deepEqual(kovaDevicesForWarden([
    dev({ id: 'a', address: '10.0.0.5' }),
    dev({ id: 'b', address: 'aa:bb:cc:dd:ee:ff', type: 'internet', adapter: 'other' }),
    dev({ id: 'c', address: 'http://10.0.0.7:8080', adapter: 'owntone' }),
    dev({ id: 'd', address: 'cloud-123', adapter: 'nest' }),
    dev({ id: 'e', address: '10.0.0.8', adapter: 'virtual' }),
    dev({ id: 'f', address: '10.0.0.9', hidden: true }),
  ], () => undefined, id => id === 'tuya' ? 'Tuya' : undefined).map(d => [d.kovaId, d.ip ?? d.mac, d.kind ?? '']), [['a', '10.0.0.5', 'light'], ['b', 'aa:bb:cc:dd:ee:ff', ''], ['c', '10.0.0.7', 'light']]);
});

test('Warden link: the floor plan goes to Warden’s Wi-Fi survey, with how well Warden hears each placed Wi-Fi device there', async () => {
  // A Warden with the survey: one floor of its own already there, and a phone-shaped device it hears.
  const floors: any[] = [{ id: 'f1', name: 'Upstairs', widthMeters: 5, heightMeters: 5, rooms: [], aps: [] }];
  const samples: any[] = [{ id: 's0', note: 'walked by hand' }, { id: 's1', note: 'Kova: Old reading' }];
  const got: { method: string; path: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const path = req.url!.replace(/^\/api\/v1/, '');
      got.push({ method: req.method!, path, body });
      if (path === '/integrations/kova/devices') return send(200, { matched: body.map((d: any) => ({ kovaId: d.kovaId, ...(d.kovaId === 'lounge_lamp' ? { deviceId: 'dev_lamp' } : {}) })) });
      if (path === '/survey/floors' && req.method === 'GET') return send(200, { floors });
      if (path === '/survey/floors' && req.method === 'POST') { const f = { id: 'f2', ...body, rooms: [], aps: [] }; floors.push(f); return send(201, f); }
      if (path === '/survey/floors/f2' && req.method === 'GET') return send(200, { ...floors[1], aps: [{ id: 'ap1', label: 'Hall AP', x: 3, y: 3 }] });
      if (path === '/survey/floors/f2' && req.method === 'PUT') { Object.assign(floors[1], body); return send(200, floors[1]); }
      if (path === '/devices?online=true') return send(200, { devices: [{ id: 'dev_lamp', online: true, connection: { medium: 'wireless', ssid: 'Home', band: '5', rssi: -61 } }] });
      if (path === '/survey/floors/f2/samples' && req.method === 'GET') return send(200, { samples });
      if (path.startsWith('/survey/floors/f2/samples/') && req.method === 'DELETE') return send(204, {});
      send(200, { ok: true });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const t = await testHub(12);
  await t.hub.reg.addAdapter(new Lan());
  t.hub.config.update(c => { c.floorPlan = { widthM: 10, heightM: 8, walls: 'concrete', rooms: [{ id: 'a', name: 'Lounge', room: 'lounge', points: [[0, 0], [6, 0], [6, 4], [0, 4]] }], places: { lounge_lamp: [2, 1.5] } }; });
  const link = new WardenLink(t.hub, { warden: () => ({ url, token: 'tok' }), port: () => 8140, debounceMs: 0 });
  try {
    await link.sync();
    // A floor of Kova's own, made once; Warden's access point on it kept.
    assert.deepEqual(got.filter(g => g.path === '/survey/floors' && g.method === 'POST').map(g => g.body), [{ name: 'The Parkers (from Kova)', widthMeters: 10, heightMeters: 8 }]);
    const put = got.find(g => g.path === '/survey/floors/f2' && g.method === 'PUT')!.body;
    assert.deepEqual(put.rooms, [{ id: 'a', name: 'Lounge', points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }] }]);
    assert.deepEqual(put.aps, [{ id: 'ap1', label: 'Hall AP', x: 3, y: 3 }]);
    // Kova's old reading goes, the hand-walked one stays, and the lamp is heard at its spot.
    assert.deepEqual(got.filter(g => g.method === 'DELETE').map(g => g.path), ['/survey/floors/f2/samples/s1']);
    assert.deepEqual(got.find(g => g.path === '/survey/floors/f2/samples' && g.method === 'POST')!.body, { samples: [{ ssid: 'Home', band: '5', x: 2, y: 1.5, rssi: -61, source: 'gateway', note: 'Kova: Lounge lamp' }] });
    assert.match(link.status()!.note, /floor plan shared with Wi-Fi from 1 device/);
    // Nothing changed and not half an hour yet: the floor isn't sent again.
    const n = got.length;
    await link.sync();
    assert.equal(got.slice(n).filter(g => g.path.startsWith('/survey')).length, 0);
  } finally { link.stop(); await t.hub.stop(); await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); }
});
