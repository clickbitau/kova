import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertRows, decisionText, groupSensors, isSensor, quietText, roomLine, sensorCard, sensorFlags, sparkPath, timelineRows } from '../src/logic/sensors.ts';
import { devs, groupDevices, stateOf, toggleCommand } from '../src/logic/devices.ts';
import { ctxOf, newCondition, newTrigger, stateOptions, canSet } from '../src/logic/automations.ts';
import { routeFor, NATIVE_PAGES } from '../src/logic/links.ts';
import type { Device, Room, SecurityState, SensorView } from '../src/api/types.ts';

const NOW = Date.UTC(2026, 9, 7, 6, 0);
const rooms: Room[] = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'front', name: 'Front door', icon: 'door_front' }];
const view = (o: Partial<SensorView>): SensorView => ({ id: 'x', name: 'Sensor', room: 'lounge', integration: 'Zigbee', type: 'sensor', kind: 'climate', icon: 'thermostat', hidden: false, outdoor: false, readings: [], battery: null, lowBattery: false, online: true, seenAt: null, seenLabel: null, stale: false, ...o });
const r = (field: string, text: string, value: number | boolean, extra: object = {}) => ({ field, label: field, text, value, unit: '', trend: null, changedAt: null, changedLabel: null, ...extra });

test('a sensor card: the main reading big with its trend, the rest below, battery and offline pills', () => {
  const c = sensorCard(view({ readings: [r('temp', '22.4°', 22.4, { trend: 'up', changedLabel: '14:02' }), r('humidity', '48%', 48), r('battery', '14%', 14)], battery: 14, lowBattery: true, seenAt: NOW - 3 * 60_000 }), NOW);
  assert.deepEqual([c.main, c.sub, c.trend?.[0], c.foot], ['22.4°', '48%', 'trending_up', 'Changed 14:02 · seen 3 min ago']);
  assert.deepEqual(c.pills.map(p => p.text), ['14%']);
  assert.equal(c.pills[0].icon, 'battery_alert');
  assert.match(c.label, /Sensor, 22.4°, humidity 48%, battery 14%/);
  const door = sensorCard(view({ kind: 'contact', readings: [r('open', 'Open', true, { changedLabel: '13:10' })], online: false }), NOW);
  assert.equal(door.live, true, 'an open door stands out');
  assert.equal(door.foot, 'Last 13:10');
  assert.deepEqual(door.pills.map(p => p.text), ['Not responding']);
});

test('sensors by room, in the home’s order, with each room’s climate and activity; hidden only when asked', () => {
  const s = {
    rooms, sensors: [view({ id: 'a', room: 'front', kind: 'contact', readings: [r('open', 'Closed', false)] }), view({ id: 'b', readings: [r('temp', '21°', 21)] }), view({ id: 'h', hidden: true }), view({ id: 'c', room: 'attic' })],
    roomStatus: { lounge: { temp: 21, humidity: 50, lux: null, tempFrom: ['b'], outdoor: false, active: true, occupied: false, last: { kind: 'motion', at: NOW - 120_000, atLabel: '15:58', device: 'm', what: 'm' }, open: [], sensors: 2 } },
  };
  const g = groupSensors(s, { now: NOW });
  assert.deepEqual(g.map(x => [x.name, x.cards.map(c => c.id).join()]), [['Lounge', 'b'], ['Front door', 'a'], ['No room', 'c']]);
  assert.equal(g[0].summary, '21° · 50% humidity · motion 2 min ago');
  assert.equal(groupSensors(s, { showHidden: true })[0].cards.length, 2);
  assert.equal(roomLine(undefined), '');
  const flags = sensorFlags([view({ id: 'a', name: 'Climate', lowBattery: true, battery: 9 }), view({ id: 'b', name: 'Door', online: false, readings: [r('open', 'Open', true)] })], rooms);
  assert.deepEqual(flags.map(f => f.text), ['Climate (Lounge): battery 9%', 'Door isn’t responding', 'Door open']);
});

test('sensors are not devices: no tile on Devices, nothing to toggle, their readings as their state', () => {
  const dev = (id: string, type: string, kind: string | undefined, state: object): Device => ({ id, name: id, room: 'lounge', type: type as Device['type'], kind: kind as Device['kind'], capabilities: [], adapter: 'x', integration: 'x', address: id, state });
  const all = Object.values(devs({ devices: [dev('lamp', 'light', 'device', { on: true }), dev('t', 'sensor', 'sensor', { temp: 21.5, humidity: 40 }), dev('meter', 'plug', 'sensor', { power: 120 }), dev('old', 'sensor', undefined, { open: true })] }));
  assert.deepEqual(groupDevices(all, rooms, {}).flatMap(g => g.devices.map(d => d.id)), ['lamp'], 'a power meter is a sensor too, by the hub’s kind');
  assert.equal(isSensor({ type: 'sensor' }), true, 'older hubs: by type');
  const t = all.find(d => d.id === 't')!;
  assert.deepEqual(stateOf(t), ['21.5° · 40%', '#7fd4a0']);
  assert.equal(stateOf(all.find(d => d.id === 'old')!)[0], 'Open');
  assert.equal(toggleCommand(t, []), null);
  assert.equal(canSet({ type: 'plug', kind: 'sensor' }), false);
});

test('camera alerts: which kinds apply, the camera’s own choice, the room’s or the default', () => {
  const sec: SecurityState = {
    quiet: { from: '22:00', to: '07:00' }, cooldownMin: 5, rooms: {}, quietNow: false, outdoorRooms: ['front'], recent: [], decisions: [],
    devices: { bell: { outdoor: true, outdoorSet: false, alerts: { person: { when: 'always', from: 'default' }, ring: { when: 'always', from: 'device' }, motion: { when: 'never', from: 'room' } } }, door: { outdoor: true, outdoorSet: false, alerts: { opened: { when: 'away', from: 'default' } } } },
  };
  const bell = { id: 'bell', type: 'camera' as const, name: 'Doorbell', integration: 'Google Nest Doorbell', state: {} };
  const rows = alertRows(bell, sec);
  assert.deepEqual(rows.slice(0, 2).map(x => [x.kind, x.value, x.note]), [['person', '', 'Kova’s default: always'], ['ring', 'always', 'Set for this one']]);
  assert.equal(rows.find(x => x.kind === 'motion')!.note, 'The room’s choice: never');
  assert.ok(!rows.some(x => x.kind === 'opened'));
  assert.deepEqual(alertRows({ id: 'door', type: 'sensor', name: 'Door', integration: 'z', state: { open: false } }, sec).map(x => x.kind), ['opened']);
  assert.ok(!alertRows({ ...bell, integration: 'Google Nest Camera', name: 'Camera' }, sec).some(x => x.kind === 'ring'), 'only doorbells ring');
  assert.equal(quietText(sec), '22:00 to 07:00: only the doorbell, and anything while nobody’s home');
  assert.equal(decisionText({ at: 0, atLabel: '', room: 'front', device: 'bell', kind: 'person', sent: false, why: 'quiet hours' }, rooms), 'A person in Front door: not sent, quiet hours');
});

test('timelines and charts: rows with their pictures, and a day of readings as a path', () => {
  const rows = timelineRows([{ id: 4, at: NOW, t: '14:40', room: 'front', roomName: 'Front door', device: 'bell', kind: 'ring', source: 'camera', outdoor: true, what: 'Doorbell rang', icon: 'doorbell', frame: '/api/frames/bell/4' }, { id: 5, at: NOW, t: '14:41', room: 'front', roomName: null, device: 'door', kind: 'opened', source: 'sensor', outdoor: true, what: 'Door opened', icon: '', frame: null }]);
  assert.deepEqual(rows.map(x => [x.where, x.icon, x.frame]), [['Front door', 'doorbell', '/api/frames/bell/4'], ['No room · sensor', 'sensor_door', null]]);
  const p = sparkPath([[0, 20], [1, 22], [2, 21]], 100, 40)!;
  assert.deepEqual([p.min, p.max], [20, 22]);
  assert.match(p.line, /^M2.0 36.0 L50.0 6.0 L98.0 21.0$/);
  assert.equal(sparkPath([[0, 1]], 100, 40), null);
});

test('automations on the phone: room triggers and conditions, sensor states; notification links to Sensors', () => {
  const ctx = ctxOf({ devices: [], sources: [], modes: [], overlays: [], automations: [], rooms });
  assert.deepEqual(newTrigger('room', ctx), { kind: 'room', room: 'lounge', event: 'motion' });
  assert.deepEqual(newCondition('room', ctx), { kind: 'room', room: 'lounge', active: true, withinMin: 10 });
  assert.ok(stateOptions().some(o => o.label === 'open') && stateOptions().some(o => o.label === 'detecting motion'));
  assert.equal(NATIVE_PAGES[routeFor('/phone.html?page=sensors').page!], 'Sensors');
});
