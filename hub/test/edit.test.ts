import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, DATE } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

test('editing modes: start time, targets, undo, validation', async () => {
  const { hub, advance, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    // Wind down at 21:00 instead of 20:00, and the kitchen ceiling off in it.
    let r = await app.inject({ method: 'PUT', url: '/api/modes/wind', payload: { start: { kind: 'time', at: '21:00' } } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/kitchen_ceiling', payload: { target: { on: false } } });
    assert.equal(r.statusCode, 200);
    // Dim the lamp less, and reject a nonsense target.
    await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/lamp', payload: { target: { on: true, bri: 250 } } });
    assert.equal(hub.config.get().modes.find(m => m.id === 'wind')!.targets.lamp.bri, 100, 'clamped');
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/doorbell', payload: { target: { on: true } } });
    assert.equal(r.statusCode, 400, "a camera can't be switched on");
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind', payload: { start: { kind: 'time', at: '25:00' } } });
    assert.equal(r.statusCode, 400);

    const s = (await app.inject({ url: '/api/state' })).json();
    const wind = s.modes.find((m: { id: string }) => m.id === 'wind');
    assert.equal(wind.startLabel, '21:00');
    assert.ok(wind.targets.some((t: { deviceId: string; label: string }) => t.deviceId === 'kitchen_ceiling' && t.label === 'Ceiling off'));

    await advance(19);
    await advance(20.5);
    assert.equal(hub.engine.modeId, 'evening', 'still Evening at 20:30 now');
    await advance(21.01);
    assert.equal(hub.engine.modeId, 'wind');
    assert.equal(dev('kitchen_ceiling').on, false);

    // Removing a target, then undoing it.
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/kitchen_ceiling', payload: { target: null } });
    assert.ok(!hub.config.get().modes.find(m => m.id === 'wind')!.targets.kitchen_ceiling);
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.ok(hub.config.get().modes.find(m => m.id === 'wind')!.targets.kitchen_ceiling);
  } finally { await app.close(); await hub.stop(); }
});

test('moments, overlays and stream addresses', async () => {
  const { hub, advance, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'POST', url: '/api/moments', payload: { label: 'Porch off', at: { kind: 'time', at: '22:15' }, targets: { front_1: { on: false } } } });
    assert.equal(r.statusCode, 200);
    const id = r.json().id;
    await advance(19); await advance(22.3);
    assert.equal(dev('front_1').on, false);
    assert.ok(hub.engine.planner.kovaDay(DATE).items.some(i => i.refId === id));
    r = await app.inject({ method: 'DELETE', url: `/api/moments/${id}` });
    assert.ok(!hub.config.get().moments.some(m => m.id === id));

    r = await app.inject({ method: 'PUT', url: '/api/overlays/movie/targets/dining', payload: { target: { on: false } } });
    assert.deepEqual(hub.config.get().overlays.find(o => o.id === 'movie')!.targets.dining, { on: false });

    r = await app.inject({ method: 'PUT', url: '/api/sources/Tarateel', payload: { url: 'https://stream.example/tarateel.mp3' } });
    assert.equal(hub.config.get().sources.find(s => s.name === 'Tarateel')!.url, 'https://stream.example/tarateel.mp3');
    r = await app.inject({ method: 'PUT', url: '/api/sources/Bad', payload: { url: 'ftp://nope' } });
    assert.equal(r.statusCode, 400);
  } finally { await app.close(); await hub.stop(); }
});

test('modes that point at missing devices are flagged and can be cleaned up', async () => {
  const { hub } = await testHub(12);
  hub.config.update(c => { c.modes.find(m => m.id === 'evening')!.targets.old_switch = { on: true }; });
  const f = hub.checker.findings().find(x => x.id === 'missing:evening');
  assert.ok(f);
  assert.match(f.title, /Evening uses 1 device Kova can’t find/);
  hub.checker.fix(f.id);
  assert.ok(!hub.config.get().modes.find(m => m.id === 'evening')!.targets.old_switch);
  await hub.stop();
});

test('media sources: repeat on and off without touching the address; a bad address is refused', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'PUT', url: '/api/sources/Rain%20sounds', payload: { url: 'https://sounds.example/rain-1h.mp3' } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: 'PUT', url: '/api/sources/Rain%20sounds', payload: { loop: true } });
    const rain = () => hub.config.get().sources.find(s => s.name === 'Rain sounds')!;
    assert.deepEqual([rain().url, rain().loop], ['https://sounds.example/rain-1h.mp3', true]);
    assert.equal(hub.reg.sourceLoops('Rain sounds'), true);
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.equal(rain().loop, undefined);
    r = await app.inject({ method: 'PUT', url: '/api/sources/Rain%20sounds', payload: { loop: 'yes' } });
    assert.equal(r.statusCode, 400);
    r = await app.inject({ method: 'PUT', url: '/api/sources/Rain%20sounds', payload: { url: 'ftp://x' } });
    assert.equal(r.statusCode, 400);
  } finally { await app.close(); await hub.stop(); }
});

test('zone names: set, cleared, shown in the snapshot; refused for a device without zones', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    await hub.reg.addAdapter({
      id: 'ducted', name: 'Ducted', icon: 'ac_unit', kind: 'Cloud', async stop() {}, status: () => ({ ok: true }), async command() {},
      async start(ctx) { ctx.announce([{ id: 'ac', name: 'AC', room: 'lounge', type: 'climate', capabilities: ['onoff', 'climate', 'zones'], integration: 'Ducted', address: 'ac', state: { zones: [{ n: 1, on: true, open: 35 }] } }]); },
    });
    let r = await app.inject({ method: 'PATCH', url: '/api/devices/ac/settings', payload: { zoneNames: { 1: 'Living', 2: 'Bedrooms' } } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: 'PATCH', url: '/api/devices/ac/settings', payload: { zoneNames: { 2: null } } });
    const s = (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual(s.devices.find((d: { id: string }) => d.id === 'ac').zoneNames, { 1: 'Living' });
    r = await app.inject({ method: 'PATCH', url: '/api/devices/lamp/settings', payload: { zoneNames: { 1: 'x' } } });
    assert.match(r.json().error, /has no zones/);
    r = await app.inject({ method: 'PATCH', url: '/api/devices/ac/settings', payload: { zoneNames: { abc: 'x' } } });
    assert.equal(r.statusCode, 400);
  } finally { await app.close(); await hub.stop(); }
});

test('home settings: name, location, timezone, prayer method and the doorbell pause; only what is sent changes', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/home', payload });
    let r = await put({ latitude: -33.8688, longitude: 151.2093, timezone: 'Australia/Sydney', prayerMethod: 'Karachi', pauseForDoorbell: false });
    assert.equal(r.statusCode, 200, r.body);
    const c = hub.config.get();
    assert.deepEqual([c.latitude, c.longitude, c.timezone, c.prayerMethod, c.pauseForDoorbell, c.name], [-33.8688, 151.2093, 'Australia/Sydney', 'Karachi', false, 'The Ahmeds']);
    const s = (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual([s.home.prayerMethod, s.home.pauseForDoorbell, s.home.timezone], ['Karachi', false, 'Australia/Sydney']);
    const firstUndo = r.json().undo;
    r = await put({ location: { latitude: -31.95, longitude: 115.86, radiusM: 220, source: 'phone' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(hub.config.get().location, { latitude: -31.95, longitude: 115.86, radiusM: 220, source: 'phone', updatedAt: hub.engine.now() });
    const s2 = (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual(s2.home.location, { latitude: -31.95, longitude: 115.86, radiusM: 220, source: 'phone', updatedAt: hub.engine.now() });
    r = await put({ location: { radiusM: 260 } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(hub.config.get().location, { latitude: -31.95, longitude: 115.86, radiusM: 260, source: 'phone', updatedAt: hub.engine.now() });
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    await app.inject({ method: 'POST', url: `/api/undo/${firstUndo}` });
    assert.equal(hub.config.get().timezone, 'Australia/Perth');
    for (const [bad, msg] of [[{ timezone: 'Mars/Base' }, /isn’t a timezone/], [{ latitude: 10 }, /together/], [{ latitude: 100, longitude: 0 }, /−90 to 90/], [{ location: { latitude: -31, longitude: 115, radiusM: 20 } }, /radiusM/], [{ location: { latitude: -31, longitude: 115, source: 'gps' } }, /source/], [{ prayerMethod: 'Lunar' }, /one of/], [{ name: '  ' }, /name/]] as const) {
      r = await put(bad);
      assert.equal(r.statusCode, 400);
      assert.match(r.json().error, msg);
    }
  } finally { await app.close(); await hub.stop(); }
});

test('address: saved with its location, cleared with null; searching needs enough of it', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'PUT', url: '/api/home', payload: { address: '1 Example Street, Exampletown', latitude: -31.9, longitude: 115.8 } });
    assert.equal(r.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/state' })).json().home.address, '1 Example Street, Exampletown');
    await app.inject({ method: 'PUT', url: '/api/home', payload: { address: null } });
    assert.equal(hub.config.get().address, undefined);
    r = await app.inject({ url: '/api/geocode?q=ab' });
    assert.match(r.json().error, /Type more/);
  } finally { await app.close(); await hub.stop(); }
});
