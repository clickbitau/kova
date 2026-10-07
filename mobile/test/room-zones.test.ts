import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acOnFor, acState, offersAcOn, roomWords, roomZoneLine, servesLine, sharedWith, suggestionsBody, suggestWords, toggleRoom, visibleZones, WHOLE_HOME,
  zoneCommandWords, zoneOpenAt, zoneRoomsBody, zoneRoomViews, zonesByRoom, zoneSwitch, zoneTargetLabel, zoneTargetOptions, zonedRooms,
} from '../src/logic/zones.ts';
import { devs, groupDevices, roomOffApplies, roomPills } from '../src/logic/devices.ts';
import { devicesIn, placeChoices, placeName } from '../src/logic/customise.ts';
import {
  carryCommand, conditionText, deviceLabel, deviceSections, fieldDefault, fieldsFor, firstCommand, freeFields, presets, pseudoLabel, readingRooms, readingSourceLabel,
  roomReadingsFor, targetInfo, targetText, triggerText, zoneTargets, type Names,
} from '../src/logic/automations.ts';
import type { Device, RoomZone, Snapshot } from '../src/api/types.ts';

const rooms = [
  { id: 'living', name: 'Living', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' },
  { id: 'study', name: 'Study', icon: 'desk' }, { id: 'guest', name: 'Guest room', icon: 'bed' },
];
const d = (id: string, type: Device['type'], room: string, state: Device['state'] = {}, extra: Partial<Device> = {}): Device =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), room, type, capabilities: ['onoff'], adapter: 'x', integration: 'X', address: id, state, ...extra });
const ducted = d('ducted', 'climate', WHOLE_HOME, { on: false, hvac: 'cool', target: 23, zones: [1, 2, 3].map(n => ({ n, on: n === 1, open: n === 1 ? 80 : 0 })) }, {
  capabilities: ['onoff', 'climate', 'zones'], zoneNames: { 1: 'Living', 2: 'Kitchen', 3: 'Study & Guest' }, zoneRooms: { 1: ['living'] }, zoneSuggest: { 2: ['kitchen'], 3: ['study', 'guest'] },
});

test('zones in the air conditioner’s panel: confirmed rooms, and Kova’s suggestion where none is confirmed', () => {
  const v = zoneRoomViews(visibleZones(ducted.state.zones, ducted.zoneNames), ducted, rooms);
  assert.deepEqual(v.map(z => [z.n, z.rooms, z.suggest]), [[1, ['living'], []], [2, [], ['kitchen']], [3, [], ['study', 'guest']]]);
  assert.equal(servesLine(v[0], rooms), 'Living');
  assert.equal(servesLine(v[1], rooms), 'No room yet');
  assert.equal(roomWords(['study', 'guest'], rooms), 'Study and Guest room');
  assert.equal(roomWords(['living', 'kitchen', 'study'], rooms), 'Living, Kitchen and Study');
  assert.equal(roomWords(['gone', 'study'], rooms), 'Study', 'rooms that are gone are left out');
  // A zone's own suggestion is never shown over rooms the owner confirmed.
  assert.deepEqual(zoneRoomViews(visibleZones(ducted.state.zones, ducted.zoneNames), { ...ducted, zoneSuggest: { 1: ['kitchen'] } }, rooms)[0].suggest, []);
});

test('saving a zone’s rooms: one zone at a time, none clears it; “Use suggestions” sends every one still open', () => {
  assert.deepEqual(zoneRoomsBody(3, ['study', 'guest']), { zoneRooms: { 3: ['study', 'guest'] } });
  assert.deepEqual(zoneRoomsBody(3, []), { zoneRooms: { 3: null } });
  assert.deepEqual(toggleRoom(['study'], 'guest'), ['study', 'guest']);
  assert.deepEqual(toggleRoom(['study', 'guest'], 'study'), ['guest']);
  assert.deepEqual(suggestionsBody(ducted, rooms), { zoneRooms: { 2: ['kitchen'], 3: ['study', 'guest'] } });
  assert.deepEqual(suggestionsBody({ ...ducted, zoneSuggest: { 1: ['kitchen'], 4: ['gone'] } }, rooms), null, 'nothing to suggest: no zone confirmed already, no rooms that are gone');
  assert.equal(suggestionsBody({}, rooms), null);
});

const zone = (over: Partial<RoomZone> = {}): RoomZone => ({
  device: 'ducted', deviceName: 'Ducted', n: 3, name: 'Study & Guest', on: true, open: 60, temp: null, rooms: ['study', 'guest'],
  ac: { on: true, hvac: 'cool', target: 23, temp: 24, fanSpeed: 'auto', online: true }, suggest: { hvac: 'cool', target: 24 }, ...over,
});

test('a room’s zone: its state and the air conditioner’s in a line, and the commands it sends', () => {
  assert.equal(roomZoneLine(zone()), 'Open 60% · AC cool 23°');
  assert.equal(roomZoneLine(zone({ on: false, ac: { ...zone().ac, on: false } })), 'Closed · AC off');
  assert.equal(acState(zone({ ac: { ...zone().ac, online: false } })), 'AC not responding');
  assert.equal(sharedWith(zone(), 'study', rooms), 'Guest room');
  assert.equal(sharedWith(zone({ rooms: ['study'] }), 'study', rooms), '');
  assert.deepEqual(zoneSwitch(zone(), true), { zoneSet: { 3: { on: true } } });
  assert.deepEqual(zoneSwitch(zone(), false), { zoneSet: { 3: { on: false } } }, 'closing a zone never sends the unit off');
  assert.deepEqual(zoneOpenAt(zone(), 47), { zoneSet: { 3: { on: true, open: 45 } } });
  assert.deepEqual(zoneOpenAt(zone(), 1), { zoneSet: { 3: { on: false } } });
  // Open but the unit is off: offered (never done by itself), in the suggested mode.
  const off = zone({ ac: { ...zone().ac, on: false } });
  assert.equal(offersAcOn(off), true);
  assert.equal(offersAcOn(zone()), false);
  assert.equal(offersAcOn({ ...off, on: false }), false);
  assert.deepEqual(acOnFor(off), { on: true, hvac: 'cool', target: 24, zoneSet: { 3: { on: true } } });
  assert.equal(suggestWords(off), 'Cool at 24°');
  assert.deepEqual(Object.keys(zonesByRoom({ study: { zones: [zone()] }, living: { zones: [] }, kitchen: {} } as never)), ['study']);
});

test('the Devices tab: Whole home first, never No room; rooms an air conditioner zone serves stay, with no devices', () => {
  const s = { devices: [ducted, d('lamp', 'light', 'living', { on: true }), d('kettle', 'plug', 'unassigned', { on: false })] } as unknown as Snapshot;
  const all = Object.values(devs(s));
  const g = groupDevices(all, rooms, { zoned: ['study'] });
  assert.deepEqual(g.map(x => [x.id, x.name, x.devices.map(y => y.id)]), [[WHOLE_HOME, 'Whole home', ['ducted']], ['living', 'Living', ['lamp']], ['study', 'Study', []], ['unassigned', 'No room', ['kettle']]]);
  assert.equal(g[0].icon, 'home');
  assert.deepEqual(groupDevices(all, rooms, { zoned: ['study'], q: 'lamp' }).map(x => x.id), ['living'], 'a search shows only matches');
  assert.deepEqual(groupDevices(all, rooms, { zoned: ['study'], type: 'lights' }).map(x => x.id), ['living']);
  assert.deepEqual(groupDevices(all, rooms, { zoned: ['study'], room: 'study' }).map(x => x.id), ['study']);
  assert.deepEqual(groupDevices(all, rooms, { room: WHOLE_HOME }).map(x => x.id), [WHOLE_HOME]);
  assert.deepEqual(roomPills(all, rooms, ['study']).map(p => p.name), ['All rooms', 'Whole home', 'Living', 'Study', 'Other']);
  assert.equal(roomOffApplies({ id: WHOLE_HOME, lightsOn: 2 }), false);
  assert.equal(roomOffApplies({ id: 'living', lightsOn: 1 }), true);
  assert.equal(roomOffApplies({ id: 'living', lightsOn: 0 }), false);
});

test('room pickers: Whole home is a place of its own, apart from the rooms and No room', () => {
  assert.deepEqual(placeChoices(rooms).map(p => p.id), [WHOLE_HOME, 'living', 'kitchen', 'study', 'guest', 'unassigned']);
  assert.deepEqual(placeChoices(rooms, 'porch').map(p => p.id).slice(-2), ['porch', 'unassigned']);
  assert.equal(placeName(WHOLE_HOME, rooms), 'Whole home');
  assert.equal(placeName('study', rooms), 'Study');
  assert.equal(placeName('gone', rooms), 'No room');
  const list = [ducted, d('kettle', 'plug', 'gone')];
  assert.deepEqual(devicesIn(list, rooms, 'unassigned').map(x => x.id), ['kettle']);
  assert.deepEqual(devicesIn(list, rooms, WHOLE_HOME).map(x => x.id), ['ducted']);
  assert.deepEqual(deviceSections([ducted], rooms, '').map(x => x.room), ['Whole home']);
});

const home = [ducted, { ...d('lamp', 'light', 'living'), capabilities: ['onoff', 'brightness'] }];
const names: Names = { devices: home, rooms, people: [], modes: [], overlays: [], automations: [] };

test('automations: “<Room> zone” targets, for the rooms a zone serves', () => {
  assert.deepEqual(zoneTargets(home, rooms), [{ v: 'zone:living', label: 'Living zone' }]);
  assert.deepEqual(zonedRooms([{ ...ducted, archived: true }], rooms), [], 'an archived unit serves no room');
  assert.deepEqual(zoneTargetOptions([{ ...ducted, zoneRooms: { 1: ['living'], 3: ['study', 'guest'] } }], rooms).map(o => o.v), ['zone:living', 'zone:study', 'zone:guest']);
  assert.equal(pseudoLabel('zone:living', rooms), 'Living zone');
  assert.equal(zoneTargetLabel('zone:gone', rooms), 'gone zone');
  assert.equal(deviceLabel('zone:living', home, rooms), 'Living zone');
  const t = targetInfo('zone:living', home, rooms);
  assert.equal(t.type, 'zone');
  assert.deepEqual(t.devices.map(x => x.id), ['ducted'], 'the unit serving the room');
  assert.equal(targetInfo('zone:gone', home, rooms).missing, true);
  assert.equal(targetInfo('zone:study', home, rooms).devices.length, 0, 'no zone serves it yet');
  // Its fields are the zone's: open or closed, how far, and the unit's mode, set temperature, fan and power.
  assert.deepEqual(fieldsFor(t).map(f => f.key), ['on', 'open', 'hvac', 'target', 'fanSpeed', 'ac']);
  assert.deepEqual(fieldsFor(t).slice(0, 2).map(f => [f.label, f.kind, f.yes ?? f.unit]), [['Zone', 'bool', 'Open'], ['How far open', 'number', '%']]);
  assert.deepEqual(freeFields(t, { on: true }).map(f => f.key), ['open', 'hvac', 'target', 'fanSpeed', 'ac']);
  assert.deepEqual(firstCommand(t), { on: true });
  assert.equal(fieldDefault('open', t), 100);
  assert.equal(fieldDefault('ac', t), true);
  assert.equal(fieldDefault('target', t), 23, 'the unit’s set temperature now');
  assert.deepEqual(presets(t, []).map(p => p[1]), ['Open', 'Open 50%', 'Closed', 'Open, cool to 24°', 'Open, heat to 21°']);
  // Swapping a device for a zone keeps what a zone can do, and back.
  assert.deepEqual(carryCommand({ on: true, hvac: 'heat', target: 21, bri: 50 } as never, t), { on: true, hvac: 'heat', target: 21 });
  assert.deepEqual(carryCommand({ bri: 50 } as never, t), { on: true });
  assert.deepEqual(carryCommand({ on: true, open: 50 } as never, targetInfo('lamp', home, rooms)), { on: true });
  // In words, as the hub says them.
  assert.equal(targetText('zone:living', { on: true, open: 50, hvac: 'cool', target: 23 } as never, names), 'Living zone: open 50%, AC cool 23°');
  assert.equal(zoneCommandWords({ on: false }), 'closed');
  assert.equal(zoneCommandWords({ ac: false }), 'AC off');
  assert.equal(zoneCommandWords({ on: true, ac: true }), 'open, AC on');
});

test('automations: a room’s temperature as a reading, for numeric triggers and conditions', () => {
  const status = { living: { temp: 22.5, humidity: 50, lux: null }, kitchen: { temp: null, humidity: null, lux: null } };
  assert.deepEqual(readingRooms(rooms, status), [{ v: 'room:living', label: 'Living temperature' }]);
  assert.deepEqual(readingRooms(rooms, status, 'room:kitchen').map(o => o.v), ['room:living', 'room:kitchen'], 'the one it reads is kept');
  assert.deepEqual(roomReadingsFor(status.living).map(o => o.v), ['temp', 'humidity']);
  assert.deepEqual(roomReadingsFor(undefined).map(o => o.v), ['temp']);
  assert.deepEqual(roomReadingsFor(undefined, 'lux').map(o => o.v), ['temp', 'lux']);
  assert.equal(readingSourceLabel('room:living', home, rooms), 'Living');
  assert.equal(readingSourceLabel('lamp', home, rooms), 'Living · Lamp');
  assert.equal(triggerText({ kind: 'numeric', device: 'room:living', field: 'temp', above: 25 }, names), 'Living temperature goes above 25');
  assert.equal(conditionText({ kind: 'numeric', device: 'room:living', field: 'temp', below: 18 }, names), 'Living temperature is below 18');
});
