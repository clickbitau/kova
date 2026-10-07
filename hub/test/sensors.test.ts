import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { kindOf, readingsOf, sensorKind, isOutdoor, alertWhen, cleanAlerts } from '../src/util/sensors.ts';
import { insights, glance, type InsightInputs } from '../src/services/insights.ts';
import type { Device } from '../src/model/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const dev = (id: string, type: string, caps: string[], state: Record<string, unknown> = {}, extra: Partial<Device> = {}) =>
  ({ id, name: id, room: 'lounge', type, adapter: 'x', capabilities: caps, integration: 'x', address: id, state, ...extra } as unknown as Device);

test('what counts as a sensor: no controllable capability, only readings or events', () => {
  assert.equal(kindOf(dev('t', 'sensor', ['events'])), 'sensor');
  assert.equal(kindOf(dev('meter', 'plug', ['power', 'energy'])), 'sensor', 'a power meter with nothing to switch');
  assert.equal(kindOf(dev('inv', 'sensor', ['power', 'energy'])), 'sensor', 'a solar inverter');
  assert.equal(kindOf(dev('ac', 'climate', ['onoff', 'climate'], { temp: 23 })), 'device', 'an AC with a temperature stays a device');
  assert.equal(kindOf(dev('plug', 'plug', ['onoff', 'power'], { power: 40 })), 'device', 'a plug that measures stays a device');
  assert.equal(kindOf(dev('st', 'sensor', ['events', 'onoff', 'extras'])), 'sensor', 'a TV’s light sensor (its switch only enables sensing)');
  assert.equal(kindOf(dev('cam', 'camera', ['events'])), 'camera');
  assert.equal(kindOf(dev('light', 'light', ['onoff'])), 'device');
});

test('sensor readings in words, with units, and what kind of sensor it is', () => {
  const c = dev('c', 'sensor', ['events', 'battery'], { temp: 22.44, humidity: 48.2, battery: 86 });
  assert.deepEqual(readingsOf(c).map(r => r.text), ['22.4°', '48%', '86%']);
  assert.equal(sensorKind(c), 'climate');
  assert.equal(sensorKind(dev('m', 'sensor', [], { motion: false, lux: 30 })), 'motion');
  assert.deepEqual(readingsOf(dev('d', 'sensor', [], { open: true })).map(r => [r.label, r.text]), [['Contact', 'Open']]);
  assert.equal(sensorKind(dev('warden_internet', 'sensor', ['events'], { on: false })), 'network');
  assert.equal(readingsOf(dev('warden_internet', 'sensor', ['events'], { on: false }))[0].text, 'Down');
  assert.equal(readingsOf(dev('inv', 'sensor', ['power', 'energy'], { power: 2450, energy: 7.36 })).map(r => r.text).join(' '), '2.5 kW 7.4 kWh');
});

test('inside or outside, and when an event alerts: the device, then the room, then Kova’s defaults', () => {
  const cfg = { rooms: [{ id: 'front', name: 'Front door', icon: 'door_front' }, { id: 'lounge', name: 'Lounge', icon: 'weekend' }], devices: {} as Record<string, object>, security: { rooms: {} as Record<string, object> } };
  const bell = dev('bell', 'camera', ['events'], {}, { name: 'Doorbell', room: 'lounge', integration: 'Google Nest Doorbell' });
  const cam = dev('cam', 'camera', ['events'], {}, { name: 'Camera', room: 'lounge' });
  const porch = dev('porch', 'camera', ['events'], {}, { name: 'Camera', room: 'front' });
  assert.equal(isOutdoor(bell, cfg), true, 'a doorbell is outside wherever it’s put');
  assert.equal(isOutdoor(cam, cfg), false);
  assert.equal(isOutdoor(porch, cfg), true, 'from the room');
  assert.equal(alertWhen(porch, 'person', cfg), 'always', 'someone at the door');
  assert.equal(alertWhen(cam, 'person', cfg), 'away', 'inside: only while nobody’s home');
  assert.equal(alertWhen(cam, 'motion', cfg), 'away');
  assert.equal(alertWhen(porch, 'motion', cfg), 'never', 'trees and cars move outside');
  assert.equal(alertWhen(cam, 'vehicle', cfg), 'never');
  cfg.security.rooms.lounge = { motion: 'never' };
  assert.equal(alertWhen(cam, 'motion', cfg), 'never', 'the room’s choice');
  cfg.devices.cam = { alerts: { motion: 'always' }, outdoor: true };
  assert.equal(alertWhen(cam, 'motion', cfg), 'always', 'the camera’s own choice wins');
  assert.equal(isOutdoor(cam, cfg), true);
  assert.throws(() => cleanAlerts({ person: 'sometimes' }), /always, away or never/);
  assert.throws(() => cleanAlerts({ dragon: 'always' }), /isn’t an event/);
  assert.deepEqual(cleanAlerts({ person: 'away', motion: null }), { person: 'away' });
});

test('sensors are not devices: their own kind in the snapshot, out of device counts, readings in each room', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  try {
    const s = (await app.inject({ url: '/api/state' })).json();
    const kinds = Object.fromEntries(s.devices.map((d: { id: string; kind: string }) => [d.id, d.kind]));
    assert.equal(kinds.lounge_climate, 'sensor');
    assert.equal(kinds.solar_inverter, 'sensor');
    assert.equal(kinds.doorbell, 'camera');
    assert.equal(kinds.lamp, 'device');
    // The sensors list: every sensor with readings, battery and state.
    const baby = s.sensors.find((x: { id: string }) => x.id === 'baby_climate');
    assert.deepEqual([baby.kind, baby.icon, baby.readings[0].text, baby.battery, baby.lowBattery, baby.online], ['climate', 'thermostat', '23.1°', 14, true, true]);
    assert.ok(!s.sensors.some((x: { id: string }) => x.id === 'lamp'), 'devices aren’t sensors');
    // Integration counts: devices and sensors apart.
    const v = s.integrations.find((i: { id: string }) => i.id === 'virtual');
    assert.deepEqual([v.devices, v.sensors], [28, 7]);
    // Room climate comes from the room's sensors.
    assert.deepEqual([s.roomStatus.lounge.temp, s.roomStatus.lounge.humidity, s.roomStatus.lounge.sensors], [22.4, 48, 1]);
    assert.equal(s.roomStatus.front.outdoor, true);
    // At a glance, inside: rooms with a temperature, with humidity.
    assert.ok(s.glance.inside.some((x: { name: string; temp: number; humidity: number }) => x.name === 'Lounge' && x.temp === 22.4 && x.humidity === 48));
    assert.ok(!s.glance.inside.some((x: { room: string }) => x.room === 'front'), 'outdoor rooms aren’t inside');
    // Battery low on a sensor is still worth saying.
    assert.ok(s.insights.some((i: { id: string }) => i.id === 'battery:baby_climate'));
  } finally { await app.close(); await t.hub.stop(); }
});

test('sensor readings are quiet: no Activity entries for temperatures or motion; a door opening is shown; trends and last changed', async () => {
  const t = await testHub(12);
  try {
    const before = t.hub.store.feed(200).length;
    t.virtual.physical('lounge_climate', { temp: 22.6 });
    t.virtual.physical('kitchen_motion', { motion: true });
    t.virtual.physical('kitchen_motion', { motion: false });
    assert.equal(t.hub.store.feed(200).length, before, 'readings and motion stay out of Activity');
    t.virtual.physical('front_contact', { open: true });
    const top = t.hub.store.feed(1)[0];
    assert.deepEqual([top.what, top.feed], ['Front door sensor opened', 'people']);
    // An hour of warming: a rising trend, and when it last changed.
    for (let i = 1; i <= 5; i++) { t.clock.t = at(12 + i * 0.25); t.virtual.physical('lounge_climate', { temp: 22.6 + i * 0.3 }); }
    const v = t.hub.sensors.view(t.hub.reg.get('lounge_climate')!, t.hub.config.get());
    const temp = v.readings.find(r => r.field === 'temp')!;
    assert.equal(temp.trend, 'up');
    assert.equal(temp.changedLabel, '13:15');
    assert.equal(v.seenLabel, '13:15');
    assert.ok(t.hub.sensors.history('lounge_climate', 'temp').length >= 5, 'a point per quarter hour');
  } finally { await t.hub.stop(); }
});

test('sensor settings: rename, move room and hide work like any device; outdoor and alerts are for cameras and sensors only', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  try {
    const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/devices/${id}/settings`, payload });
    assert.equal((await patch('kitchen_motion', { name: 'Hall motion', room: 'lounge', hidden: true })).statusCode, 200);
    const d = t.hub.reg.get('kitchen_motion')!;
    assert.deepEqual([d.name, d.room, d.hidden], ['Hall motion', 'lounge', true]);
    assert.equal((await patch('front_contact', { outdoor: false, alerts: { opened: 'always' } })).statusCode, 200);
    assert.deepEqual(t.hub.config.get().devices!.front_contact, { outdoor: false, alerts: { opened: 'always' } });
    assert.equal((await patch('front_contact', { alerts: { opened: null } })).statusCode, 200);
    assert.deepEqual(t.hub.config.get().devices!.front_contact, { outdoor: false }, 'null clears a kind');
    assert.equal((await patch('lamp', { outdoor: true })).statusCode, 400, 'a lamp isn’t a camera or sensor');
    assert.equal((await patch('front_contact', { alerts: { person: 'maybe' } })).statusCode, 400);
    // Sensors take no commands: nothing to change.
    const r = (await app.inject({ method: 'POST', url: '/api/devices/lounge_climate', payload: { on: true } })).json();
    assert.equal(t.hub.reg.get('lounge_climate')!.state.on, undefined);
    assert.ok(r.undo);
  } finally { await app.close(); await t.hub.stop(); }
});

test('insights: a door left open, too hot in a room by its sensor, offline sensors said as sensors', () => {
  const base = (devices: Device[], extra: Partial<InsightInputs> = {}): InsightInputs => ({
    devices, cfg: { rooms: [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'yard', name: 'Yard', icon: 'yard' }], timezone: 'Australia/Perth', devices: {} }, now: at(12), weather: null, failing: [], offlineSince: new Map(), ...extra,
  });
  const list = insights(base([
    dev('door', 'sensor', [], { open: true, online: true }, { name: 'Back door' }),
    dev('hot', 'sensor', [], { temp: 31, online: true }, { name: 'Climate sensor' }),
    dev('out', 'sensor', [], { temp: 38, online: true }, { name: 'Yard sensor', room: 'yard' }),
    dev('s1', 'sensor', [], { online: false }), dev('s2', 'sensor', [], { online: false }),
  ], { openSince: new Map([['door', at(11.5)]]), offlineSince: new Map([['s1', at(10)], ['s2', at(10)]]) }));
  const by = Object.fromEntries(list.map(i => [i.id.split(':')[0], i]));
  assert.equal(by.open.title, 'Back door (Lounge) has been open 30 min');
  assert.equal(by['indoor-hot'].title, 'It’s 31° in the Lounge');
  assert.ok(!list.some(i => i.id === 'indoor-hot:out'), 'outside isn’t inside');
  assert.equal(by.offline.title, '2 sensors aren’t responding');
  const g = glance(base([dev('hot', 'sensor', [], { temp: 21, humidity: 40, online: true }), dev('ac', 'climate', ['onoff', 'climate'], { temp: 25, online: true })]));
  assert.deepEqual(g.inside, [{ name: 'Lounge', room: 'lounge', temp: 21, humidity: 40, device: 'hot' }], 'the sensor wins over the AC for the room');
});
