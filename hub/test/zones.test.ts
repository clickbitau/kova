import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { checkAutomation } from '../src/engine/automation-check.ts';
import { roomReading, sensibleMode, suggestZoneRooms, zoneCommands } from '../src/util/zones.ts';
import { WHOLE_HOME, type HomeConfig, type Room } from '../src/model/types.ts';

// Whole-home climate: a ducted air conditioner serving the whole home, its zones tied to rooms, rooms showing and
// controlling their zone, and Ask Kova, automations, modes and overlays reaching a room's zone.
// The demo home's ducted AC (ducted_ac) has six zones: Lounge, Kitchen, Master, Baby, Office & Guest, Music.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const ZONE_ROOMS = { 1: ['lounge'], 2: ['kitchen'], 3: ['master'], 4: ['baby'], 5: ['office', 'guest'] };
const mapped = (c: HomeConfig) => { c.devices!.ducted_ac = { ...c.devices!.ducted_ac, zoneRooms: structuredClone(ZONE_ROOMS) }; };

// A failed assertion mustn't leave a hub running (the test file would never end).
const open: (() => Promise<void>)[] = [];
after(async () => { for (const d of open) await d(); });

/** The demo AC as if its zones had been linked by name once and the owner then cleared them: tests start unlinked. */
const unlinked = (c: HomeConfig) => { const s = c.devices?.ducted_ac; if (s?.zoneNames) s.zoneRoomsAuto = { ...s.zoneNames }; };

async function setup(tweak?: (c: HomeConfig) => void, hour = 12, link = false) {
  const t = await testHub(hour, c => { if (!link) unlinked(c); tweak?.(c); });
  const app = await buildServer(t.hub, { webRoot, ai: { timeoutMs: 3000 } });
  const patch = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/devices/${id}/settings`, payload: payload as object });
  const state = async () => (await app.inject({ url: '/api/state' })).json();
  const ask = async (text: string) => (await app.inject({ method: 'POST', url: '/api/ask', payload: { text } })).json();
  const zone = (n: number) => t.hub.reg.get('ducted_ac')!.state.zones!.find(z => z.n === n)!;
  let closed = false;
  const done = async () => { if (closed) return; closed = true; await app.close(); await t.hub.stop(); };
  open.push(done);
  return { ...t, app, patch, state, ask, zone, done };
}

test('Suggested zone rooms come from the zone names, several rooms per zone, nothing when unclear', () => {
  const rooms: Room[] = [
    { id: 'living_room', name: 'Living Room', icon: 'weekend' }, { id: 'main_bed', name: 'Main Bed', icon: 'bed' },
    { id: 'media', name: 'Media Room', icon: 'tv' }, { id: 'nursery', name: 'Nursery', icon: 'crib' },
    { id: 'study', name: 'Study', icon: 'desk' }, { id: 'guest_room', name: 'Guest Room', icon: 'single_bed' },
    { id: 'spare_bed', name: 'Spare Bed', icon: 'single_bed' },
  ];
  assert.deepEqual(suggestZoneRooms({ 1: 'Living', 2: 'Main Bed', 3: 'Media', 4: 'nursery', 5: 'Study & Guest', 6: 'Bed', 7: 'Zone 7', 8: 'Study and Media Room' }, rooms), {
    1: ['living_room'], 2: ['main_bed'], 3: ['media'], 4: ['nursery'], 5: ['study', 'guest_room'], 8: ['study', 'media'],
  }, '"Bed" could be either bedroom, so no guess');
});

test('Whole home: the reserved place, the settings route, and room ids that can’t take it', async () => {
  const h = await setup();
  assert.equal(h.hub.reg.get('ducted_ac')!.room, WHOLE_HOME, 'the demo unit serves the whole home');
  // Into a room and back to the whole home.
  assert.equal((await h.patch('ducted_ac', { room: 'lounge' })).statusCode, 200);
  assert.equal(h.hub.reg.get('ducted_ac')!.room, 'lounge');
  assert.equal((await h.patch('ducted_ac', { room: WHOLE_HOME })).statusCode, 200);
  assert.equal(h.hub.reg.get('ducted_ac')!.room, WHOLE_HOME);
  // Any device can be marked as serving the whole home.
  assert.equal((await h.patch('lounge_purifier', { room: WHOLE_HOME })).statusCode, 200);
  assert.equal(h.hub.reg.get('lounge_purifier')!.room, WHOLE_HOME);
  // A room called "Whole home" gets an id of its own.
  const r = (await h.app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'Whole home' } })).json();
  assert.notEqual(r.id, WHOLE_HOME);
  await h.done();
});

test('Zone rooms: validated, merged by zone, cleared, and dropped with a deleted room', async () => {
  const h = await setup();
  const cfg = () => h.hub.config.get().devices!.ducted_ac!;
  assert.equal((await h.patch('lamp', { zoneRooms: { 1: ['lounge'] } })).statusCode, 400, 'only zoned devices');
  assert.match((await h.patch('ducted_ac', { zoneRooms: { x: ['lounge'] } })).json().error, /zoneRooms is/);
  assert.match((await h.patch('ducted_ac', { zoneRooms: [] })).json().error, /zoneRooms is/);
  assert.match((await h.patch('ducted_ac', { zoneRooms: { 1: ['nowhere'] } })).json().error, /unknown room nowhere/);
  assert.match((await h.patch('ducted_ac', { zoneRooms: { 1: [3] } })).json().error, /room ids/);

  const ok = await h.patch('ducted_ac', { zoneRooms: { 1: 'lounge', 5: ['office', 'guest', 'office'] } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(cfg().zoneRooms, { 1: ['lounge'], 5: ['office', 'guest'] }, 'one room alone is a list; repeats go');
  assert.equal(cfg().zoneNames?.[1], 'Lounge', 'names are kept');
  await h.patch('ducted_ac', { zoneRooms: { 2: ['kitchen'], 5: [] } });
  assert.deepEqual(cfg().zoneRooms, { 1: ['lounge'], 2: ['kitchen'] }, 'merged by zone; [] clears a zone');
  // Undo puts it back.
  const u = (await h.patch('ducted_ac', { zoneRooms: null })).json();
  assert.equal(cfg().zoneRooms, undefined);
  await h.app.inject({ method: 'POST', url: `/api/undo/${u.undo}` });
  assert.deepEqual(cfg().zoneRooms, { 1: ['lounge'], 2: ['kitchen'] });
  // Deleting a room takes it out of the zones.
  await h.patch('ducted_ac', { zoneRooms: { 6: ['music', 'kitchen'] } });
  await h.patch('music_light', { room: 'kitchen' }); await h.patch('music_speaker', { room: 'kitchen' });
  assert.equal((await h.app.inject({ method: 'DELETE', url: '/api/rooms/music', payload: {} })).statusCode, 200);
  assert.deepEqual(cfg().zoneRooms, { 1: ['lounge'], 2: ['kitchen'], 6: ['kitchen'] });
  await h.done();
});

test('The state: suggestions for unconfirmed zones, each room’s zone, and a whole-home unit only counts through zones', async () => {
  const h = await setup();
  let s = await h.state();
  const ac = () => s.devices.find((d: { id: string }) => d.id === 'ducted_ac');
  assert.equal(ac().room, WHOLE_HOME);
  assert.deepEqual(ac().zoneRooms, {});
  assert.deepEqual(ac().zoneSuggest, { 1: ['lounge'], 2: ['kitchen'], 3: ['master'], 4: ['baby'], 5: ['office', 'guest'], 6: ['music'] });
  assert.deepEqual(s.roomStatus.lounge.zones, [], 'nothing until the owner confirms');
  // The office has no thermometer: the unit's own reading (the whole home's air) isn't the office's.
  assert.equal(s.roomStatus.office.temp, null);

  await h.patch('ducted_ac', { zoneRooms: { 1: ['lounge'], 5: ['office', 'guest'] } });
  s = await h.state();
  assert.deepEqual(ac().zoneRooms, { 1: ['lounge'], 5: ['office', 'guest'] });
  assert.deepEqual(Object.keys(ac().zoneSuggest), ['2', '3', '4', '6'], 'confirmed zones aren’t suggested again');
  const lz = s.roomStatus.lounge.zones;
  assert.equal(lz.length, 1);
  assert.deepEqual({ ...lz[0], suggest: undefined }, {
    device: 'ducted_ac', deviceName: 'Ducted AC', n: 1, name: 'Lounge', on: true, open: 100, temp: null, rooms: ['lounge'],
    ac: { on: false, hvac: 'cool', target: 23, temp: 23.5, fanSpeed: 'auto', online: true }, suggest: undefined,
  });
  assert.deepEqual(s.roomStatus.guest.zones.map((z: { n: number; rooms: string[] }) => [z.n, z.rooms]), [[5, ['office', 'guest']]]);
  // A zone with its own thermometer is the room's temperature when nothing in the room measures it.
  await h.hub.reg.command('ducted_ac', { zones: h.hub.reg.get('ducted_ac')!.state.zones!.map(z => z.n === 5 ? { ...z, temp: 21.5 } : z) }, { kind: 'user', label: 'You' });
  s = await h.state();
  assert.equal(s.roomStatus.office.temp, 21.5);
  assert.deepEqual(s.roomStatus.office.tempFrom, ['ducted_ac']);
  assert.equal(s.roomStatus.lounge.temp, 22.4, 'a sensor in the room wins');
  await h.done();
});

test('A sensible mode for a room: cool when warm, heat when cool, else what the unit did, at a comfortable set point', () => {
  assert.deepEqual(sensibleMode({ hvac: 'dry', target: 30 }, 27), { hvac: 'cool', target: 24 });
  assert.deepEqual(sensibleMode({ hvac: 'cool', target: 22 }, 26), { hvac: 'cool', target: 22 });
  assert.deepEqual(sensibleMode({ hvac: 'cool', target: 30 }, 17), { hvac: 'heat', target: 21 });
  assert.deepEqual(sensibleMode({ hvac: 'heat', target: 20 }, 22), { hvac: 'heat', target: 20 });
  assert.deepEqual(sensibleMode({}, null), { hvac: 'auto', target: 23 });
});

test('Zone targets resolve to the unit serving the room, merge, and close the unit with its last zone', async () => {
  const h = await setup(mapped);
  const reg = h.hub.reg;
  assert.deepEqual(reg.expandTargets({ 'zone:lounge': { on: true, open: 50 } as never }), { ducted_ac: { zoneSet: { 1: { on: true, open: 50 } } } });
  assert.deepEqual(reg.expandTargets({ 'zone:office': { hvac: 'cool', target: 22 } as never }), { ducted_ac: { on: true, hvac: 'cool', target: 22 } }, 'a mode turns the unit on');
  assert.deepEqual(reg.expandTargets({ 'zone:lounge': { open: 0 } as never }), { ducted_ac: { zoneSet: { 1: { on: false } } } }, '0% is closed');
  assert.deepEqual(reg.expandTargets({ 'zone:lounge': { on: true } as never, 'zone:guest': { on: true, open: 40 } as never }),
    { ducted_ac: { zoneSet: { 1: { on: true }, 5: { on: true, open: 40 } } } }, 'zones of one unit merge');
  assert.deepEqual(reg.expandTargets({ 'zone:music': { on: true } as never }), {}, 'no zone serves the music room');
  assert.deepEqual(zoneCommands('lounge', { on: true, ac: false }, reg.list(), h.hub.config.get().devices!), { ducted_ac: { zoneSet: { 1: { on: true } }, on: false } });

  // Running: open the lounge to 50% with the unit cooling; then close the zones one by one.
  await h.hub.engine.applyMany({ 'zone:lounge': { on: true, open: 50, hvac: 'cool' } as never }, { kind: 'user', label: 'You' });
  assert.deepEqual([h.zone(1).on, h.zone(1).open], [true, 50]);
  assert.equal(reg.get('ducted_ac')!.state.on, true);
  assert.equal(reg.get('ducted_ac')!.state.hvac, 'cool');
  await h.hub.engine.applyMany({ 'zone:lounge': { on: false } as never }, { kind: 'user', label: 'You' });
  assert.equal(h.zone(1).on, false);
  assert.equal(reg.get('ducted_ac')!.state.on, true, 'the kitchen zone is still open');
  const last = await h.hub.engine.applyMany({ 'zone:kitchen': { on: false } as never }, { kind: 'user', label: 'You' });
  assert.equal(h.zone(2).on, false);
  assert.equal(reg.get('ducted_ac')!.state.on, false, 'with no zone open the unit goes off');
  // Undo brings the zone and the unit back.
  await h.hub.engine.undo(last.undo);
  assert.equal(h.zone(2).on, true);
  assert.equal(reg.get('ducted_ac')!.state.on, true);
  await h.done();
});

test('Room off, lights off and "everything in a room" never touch a whole-home unit', async () => {
  const h = await setup(mapped);
  await h.hub.engine.applyMany({ ducted_ac: { on: true, hvac: 'cool' } }, { kind: 'user', label: 'You' });
  await h.app.inject({ method: 'POST', url: '/api/rooms/lounge/off', payload: { what: 'all' } });
  await h.app.inject({ method: 'POST', url: '/api/lights/off' });
  await h.hub.engine.applyMany({ 'room:lounge': { on: false } }, { kind: 'user', label: 'You' });
  await h.hub.engine.applyMany({ 'type:light': { on: false } }, { kind: 'user', label: 'You' });
  assert.equal(h.hub.reg.get('ducted_ac')!.state.on, true);
  assert.equal(h.zone(1).on, true);
  await h.done();
});

test('Automations: a room’s zone as a target, checked; a room’s temperature from the zone as a trigger and condition', async () => {
  const h = await setup(mapped);
  const x = { device: (id: string) => h.hub.reg.get(id), cfg: h.hub.config.get() };
  const a = checkAutomation({ name: 'Cool the office', triggers: [{ kind: 'numeric', device: 'room:office', field: 'temp', above: 25 }],
    conditions: [{ kind: 'numeric', room: 'guest', field: 'temp', above: 20 }], actions: [{ kind: 'set', targets: { 'zone:office': { on: true, open: '60', hvac: 'cool', target: 23 } } }] }, x);
  assert.deepEqual(a.actions[0], { kind: 'set', targets: { 'zone:office': { on: true, open: 60, hvac: 'cool', target: 23 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(a.conditions[0])), { kind: 'numeric', device: 'room:guest', field: 'temp', above: 20 });
  assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'set', targets: { 'zone:nowhere': { on: true } } }] }, x), /Unknown room/);
  assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'set', targets: { 'zone:office': { bri: 50 } } }] }, x), /bri isn’t something a zone can do/);
  assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'set', targets: { 'zone:office': { hvac: 'warm' } } }] }, x), /isn’t a climate mode/);
  assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'numeric', device: 'room:office', field: 'power', above: 1 }], actions: [{ kind: 'stop' }] }, x), /A room has a temperature/);

  // Saved and run: the office zone's own thermometer crosses 25°.
  const res = await h.app.inject({ method: 'POST', url: '/api/automations', payload: { name: a.name, triggers: a.triggers, conditions: a.conditions, actions: a.actions } });
  assert.equal(res.statusCode, 200, res.body);
  const s = (await h.state()).automations.find((y: { name: string }) => y.name === 'Cool the office');
  assert.match(s.triggerLabels[0], /^Office temperature goes above 25/);
  assert.match(s.actionLabels[0], /Office zone open 60%, AC cool 23°/);
  const withTemp = (t: number) => h.hub.reg.get('ducted_ac')!.state.zones!.map(z => z.n === 5 ? { ...z, temp: t } : z);
  h.virtual.physical('ducted_ac', { zones: withTemp(24) });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.zone(5).on, false);
  h.virtual.physical('ducted_ac', { zones: withTemp(26) });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual([h.zone(5).on, h.zone(5).open], [true, 60]);
  assert.equal(h.hub.reg.get('ducted_ac')!.state.hvac, 'cool');
  assert.equal(h.hub.reg.get('ducted_ac')!.state.on, true);
  assert.equal(roomReading('office', 'temp', h.hub.reg.list(), h.hub.config.get().devices!).value, 26);
  await h.done();
});

test('Modes and overlays hold zone settings per room; an overlay puts the zones back when it ends', async () => {
  const h = await setup(mapped);
  const put = await h.app.inject({ method: 'PUT', url: `/api/modes/night/targets/${encodeURIComponent('zone:master')}`, payload: { target: { on: true, open: 70 } } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(h.hub.config.get().modes.find(m => m.id === 'night')!.targets['zone:master'], { on: true, open: 70 });
  assert.equal((await h.app.inject({ method: 'PUT', url: `/api/modes/night/targets/${encodeURIComponent('zone:nowhere')}`, payload: { target: { on: true } } })).statusCode, 400);
  const s = await h.state();
  const row = s.modes.find((m: { id: string }) => m.id === 'night').targets.find((t: { deviceId: string }) => t.deviceId === 'zone:master');
  assert.deepEqual([row.name, row.label, row.missing], ['Master bed zone', 'Master bed zone open 70%', false]);
  assert.ok(!s.findings.some((f: { id: string }) => f.id === 'missing:night'), 'a zone target isn’t a missing device');
  // The mode runs it.
  await h.advance(23.6);
  assert.deepEqual([h.zone(3).on, h.zone(3).open], [true, 70]);

  // An overlay that closes the lounge zone; ending it opens it again.
  await h.app.inject({ method: 'PUT', url: '/api/overlays/movie', payload: { targets: { 'zone:lounge': { on: false } } } });
  await h.hub.engine.startOverlay('movie');
  assert.equal(h.zone(1).on, false);
  await h.hub.engine.endOverlay('user');
  assert.equal(h.zone(1).on, true);
  await h.done();
});

test('Ask Kova, built in: cool a room, turn off the AC in a room, open a zone to a percentage', async () => {
  const h = await setup(mapped);
  const ac = () => h.hub.reg.get('ducted_ac')!.state;
  // The unit is off; opening a zone says so and offers to turn it on.
  let r = await h.ask('open the guest zone to 50%');
  assert.match(r.text, /^Done\. Guest room zone: open 50%\. The AC is off\./);
  assert.deepEqual([h.zone(5).on, h.zone(5).open], [true, 50]);
  assert.equal(ac().on, false);
  assert.match(r.actions[0].label, /^Turn the AC on · /);

  r = await h.ask('cool the master bed');
  assert.match(r.text, /Master bed zone: cool\. The AC is cooling to 23°\./);
  assert.equal(h.zone(3).on, true);
  assert.deepEqual([ac().on, ac().hvac], [true, 'cool']);

  r = await h.ask('turn off the AC in the baby room');
  assert.equal(h.zone(4).on, false);
  assert.equal(ac().on, true, 'one room never turns the whole AC off');
  // Words that name a zone by its own name ("the master zone").
  r = await h.ask('close the master zone');
  assert.equal(h.zone(3).on, false);
  r = await h.ask('set the lounge zone to 30%');
  assert.deepEqual([h.zone(1).on, h.zone(1).open], [true, 30]);
  // "the baby room ac" isn't the baby room's lights.
  await h.hub.engine.command('baby_light', { on: true });
  r = await h.ask('turn the baby room ac on');
  assert.equal(h.hub.reg.get('baby_light')!.state.on, true);
  assert.equal(h.zone(4).on, true);
  // A room no zone serves.
  r = await h.ask('turn on the ac in the laundry');
  assert.match(r.text, /No air conditioner zone serves the Laundry yet/);
  // The understood chips.
  const p = (await h.app.inject({ method: 'POST', url: '/api/ask/parse', payload: { text: 'cool the lounge' } })).json();
  assert.deepEqual(p.chips, ['Cool', 'Lounge zone']);
  // "open the garage door" stays a door.
  assert.notEqual((await h.app.inject({ method: 'POST', url: '/api/ask/parse', payload: { text: 'open the garage door' } })).json().kind, 'zone');
  await h.done();
});

test('Ask Kova, built in: "turn on the AC in" a room turns the unit on in a sensible mode', async () => {
  const h = await setup(mapped);
  // The lounge is warm.
  h.virtual.physical('lounge_climate', { temp: 27 });
  await h.hub.engine.command('ducted_ac', { hvac: 'heat', target: 28 });
  const r = await h.ask('turn on the ac in the lounge');
  const ac = h.hub.reg.get('ducted_ac')!.state;
  assert.deepEqual([ac.on, ac.hvac, ac.target], [true, 'cool', 24]);
  assert.match(r.text, /The AC is cooling to 24°/);
  await h.done();
});

// ------------------------------------------------------------------ the AI --

interface Received { body: { messages: { role: string; content: string }[] } }
async function fakeModel(replies: unknown[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push({ body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies[Math.min(received.length - 1, replies.length - 1)]));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise<void>(ok => server.close(() => ok())) };
}
const toolCall = (name: string, args: unknown) => ({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (text: string) => ({ id: 'c2', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

test('The AI: the context lists zones with their rooms, and set_devices takes a room zone or a room id in zoneSet', async () => {
  const fake = await fakeModel([
    toolCall('set_devices', { devices: [{ id: 'zone:office', on: true, open: 40, set: { hvac: 'cool', target: 22 } }] }), say('Cooling the office.'),
    toolCall('set_devices', { devices: [{ id: 'ducted_ac', set: { zoneSet: { master: { on: true } } } }] }), say('Master bed zone is open.'),
    toolCall('set_devices', { devices: [{ id: 'zone:music', on: true }] }), say('Which zone serves the music room?'),
  ]);
  const h = await setup(mapped);
  await h.app.inject({ method: 'PUT', url: '/api/assistant/settings', payload: { engine: 'local', local: { url: fake.url, model: 'm' } } });

  let r = await h.ask('make the study nice and cold please');
  assert.equal(r.text, 'Cooling the office.');
  const sys = fake.received[0].body.messages.find(m => m.role === 'system')!.content;
  assert.match(sys, /AC zones by room/);
  assert.match(sys, /- zone:office → ducted_ac zone 5 \(Office & Guest\): closed; the AC is off/);
  assert.match(sys, /"id":"ducted_ac","type":"climate","name":"Ducted AC","room":"whole_home"/);
  assert.match(sys, /"zone":5,"name":"Office & Guest","rooms":\["office","guest"\]/);
  assert.deepEqual([h.zone(5).on, h.zone(5).open], [true, 40]);
  assert.deepEqual([h.hub.reg.get('ducted_ac')!.state.on, h.hub.reg.get('ducted_ac')!.state.hvac, h.hub.reg.get('ducted_ac')!.state.target], [true, 'cool', 22]);
  assert.ok(r.undo);

  r = await h.ask('let some air into the big bedroom');
  assert.equal(h.zone(3).on, true, 'a room id in zoneSet is that room’s zone');

  r = await h.ask('cool the music room');
  const tool = JSON.parse(fake.received[5].body.messages.find(m => m.role === 'tool')!.content);
  assert.equal(tool.ok, false);
  assert.match(tool.error, /No air conditioner zone serves music/);
  await h.done(); await fake.close();
});

test('Zones named like rooms link to them by themselves, once; a link the owner removes stays removed', async () => {
  const h = await setup(undefined, 12, true);
  const s = () => h.hub.config.get().devices!.ducted_ac!;
  // The demo AC's zones are Lounge, Kitchen, Master, Baby, Office & Guest and Music.
  assert.deepEqual(s().zoneRooms, { 1: ['lounge'], 2: ['kitchen'], 3: ['master'], 4: ['baby'], 5: ['office', 'guest'], 6: ['music'] });
  assert.ok(h.hub.store.between(0, Number.MAX_SAFE_INTEGER).some(e => /Zone 5 \(“Office & Guest”\) serves/.test(e.what)), 'said in Activity');
  // The owner clears zone 1: it isn't linked again.
  assert.equal((await h.patch('ducted_ac', { zoneRooms: { 1: [] } })).statusCode, 200);
  h.hub.linkNamedZones();
  assert.equal(s().zoneRooms?.['1'], undefined);
  // Renamed to another room's name: that's new, so it links.
  assert.equal((await h.patch('ducted_ac', { zoneNames: { 1: 'Kitchen' } })).statusCode, 200);
  assert.deepEqual(s().zoneRooms?.['1'], ['kitchen']);
  await h.done();
});
