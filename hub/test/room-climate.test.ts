import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { RoomClimate, chooseMode, comfortOf, seasonAt, seasonOf, DEFAULT_COMFORT, type Outside } from '../src/engine/room-climate.ts';
import type { HomeConfig } from '../src/model/types.ts';

// Room ACs: "turn on the <room> AC" for a ducted unit, by voice through the bridges or from Ask Kova.
// The demo home's ducted AC (ducted_ac) is off, with zones 1 and 2 left open; zones map to rooms here.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const ZONE_ROOMS = { 1: ['lounge'], 2: ['kitchen'], 3: ['master'], 4: ['baby'], 5: ['office', 'guest'] };
const mapped = (c: HomeConfig) => { c.devices!.ducted_ac = { ...c.devices!.ducted_ac, zoneRooms: structuredClone(ZONE_ROOMS) }; };
const YOU = { kind: 'user' as const, label: 'Google Home' };

const open: (() => Promise<void>)[] = [];
after(async () => { for (const d of open) await d(); });

async function setup(tweak?: (c: HomeConfig) => void, hour = 12, date?: string) {
  const t = await testHub(hour, c => { mapped(c); tweak?.(c); });
  if (date) t.clock.t = at(hour, date);
  let outside: Outside | null = null;
  // The hub's own instance (no forecast in tests) and one with a forecast the test sets.
  const rc = new RoomClimate({
    reg: t.hub.reg, config: t.hub.config, store: t.hub.store, rooms: t.hub.engine.rooms, now: () => t.clock.t,
    apply: (targets, cause) => t.hub.engine.applyMany(targets, cause), outside: () => outside,
  });
  const ac = () => t.hub.reg.get('ducted_ac')!.state;
  const zone = (n: number) => ac().zones!.find(z => z.n === n)!.on;
  const sensor = async (id: string, temp: number) => { t.virtual.physical(id, { temp }); };
  let closed = false;
  const done = async () => { if (closed) return; closed = true; await t.hub.stop(); };
  open.push(done);
  return { ...t, rc, ac, zone, sensor, setOutside: (o: Outside | null) => { outside = o; }, done };
}

// --------------------------------------------------------------- seasons --

test('Seasons follow the hemisphere, and the tropics are warm all year', () => {
  // Southern hemisphere (Perth, Sydney): December is summer, July winter.
  assert.equal(seasonAt(-31.95, 1), 'summer');
  assert.equal(seasonAt(-31.95, 4), 'autumn');
  assert.equal(seasonAt(-31.95, 7), 'winter');
  assert.equal(seasonAt(-33.9, 10), 'spring');
  assert.equal(seasonAt(-33.9, 12), 'summer');
  // Northern (London, New York): the other way round.
  assert.equal(seasonAt(51.5, 1), 'winter');
  assert.equal(seasonAt(51.5, 4), 'spring');
  assert.equal(seasonAt(40.7, 7), 'summer');
  assert.equal(seasonAt(40.7, 10), 'autumn');
  assert.equal(seasonAt(40.7, 12), 'winter');
  // Near the equator (Singapore, Darwin-ish 12°S): warm all year.
  assert.equal(seasonAt(1.35, 7), 'tropical');
  assert.equal(seasonAt(-12.4, 1), 'tropical');
  // From the home's settings and clock (local month): 30 September in Perth is spring; no location, no season.
  assert.equal(seasonOf({ latitude: -31.95, longitude: 115.86, timezone: 'Australia/Perth' }, at(12)), 'spring');
  assert.equal(seasonOf({ latitude: 40.7, longitude: -74, timezone: 'America/New_York' }, Date.parse('2026-01-15T12:00:00Z')), 'winter');
  assert.equal(seasonOf({ latitude: 0, longitude: 0, timezone: 'UTC' }, at(12)), null);
  // The location field wins over the older latitude.
  assert.equal(seasonOf({ latitude: 0, longitude: 0, location: { latitude: 51.5, longitude: 0 }, timezone: 'Europe/London' }, Date.parse('2026-07-01T12:00:00Z')), 'summer');
});

test('Comfort settings: defaults, and out-of-range values ignored', () => {
  assert.deepEqual(comfortOf(undefined), DEFAULT_COMFORT);
  assert.deepEqual(comfortOf({ coolTo: 23, heatTo: 22 }), { coolTo: 23, heatTo: 22 });
  assert.deepEqual(comfortOf({ coolTo: 45, heatTo: 5 }), DEFAULT_COMFORT);
});

test('Choosing the mode: the room, then the season, then the weather, with deadbands', () => {
  const c = DEFAULT_COMFORT; // cool to 24, heat to 21
  const m = (room: number | null, season: Parameters<typeof chooseMode>[0]['season'], outside: Outside | null = null) => chooseMode({ room, outside, season, comfort: c }).hvac;
  // A clearly warm or cold room decides in spring and autumn.
  assert.equal(m(25, 'spring'), 'cool');
  assert.equal(m(20, 'autumn'), 'heat');
  // Inside the deadband the room alone doesn't: spring and autumn go by the weather.
  assert.equal(m(24.5, 'autumn', { temp: 12, high: 16, low: 8 }), 'heat', 'a cold day');
  assert.equal(m(21, 'spring', { temp: 27, high: 31, low: 18 }), 'cool', 'a hot day');
  // A mild day: the room against the middle of the comfortable band (22.5°).
  assert.equal(m(23, 'spring', { temp: 20, high: 22, low: 14 }), 'cool');
  assert.equal(m(22, 'autumn', { temp: 20, high: 22, low: 14 }), 'heat');
  // Summer cools and winter heats, unless the room is far the other way.
  assert.equal(m(22, 'summer'), 'cool');
  assert.equal(m(20, 'summer'), 'cool', 'a cool room in summer still cools: 1° under heat-to isn’t enough against the season');
  assert.equal(m(18, 'summer'), 'heat', 'really cold in summer');
  assert.equal(m(23, 'winter'), 'heat');
  assert.equal(m(26, 'winter'), 'heat', '2° over cool-to isn’t enough in winter');
  assert.equal(m(27, 'winter'), 'cool', 'really hot in winter');
  assert.equal(m(21, 'tropical'), 'cool');
  // Nothing to go on.
  assert.equal(m(null, 'summer'), 'cool');
  assert.equal(m(null, 'winter'), 'heat');
  assert.equal(m(null, 'autumn'), 'heat');
  assert.equal(m(null, 'spring'), 'cool');
  assert.equal(m(null, null), 'cool');
  assert.equal(m(null, null, { temp: 10, high: 12, low: 5 }), 'heat', 'no season (no location): the weather');
  // The reason is said in words.
  assert.match(chooseMode({ room: 26, outside: null, season: 'spring', comfort: c }).why, /room is 26°/);
  assert.match(chooseMode({ room: null, outside: null, season: 'summer', comfort: c }).why, /summer/);
});

// ------------------------------------------------------------------ hub --

test('Room ACs: one per room a zone serves, named for the room, temperature from the room', async () => {
  const h = await setup();
  const rooms = h.rc.rooms();
  assert.deepEqual(rooms.map(r => r.label), ['Lounge AC', 'Kitchen AC', 'Office AC', 'Master bed AC', 'Baby room AC', 'Guest room AC']);
  const office = rooms.find(r => r.room === 'office')!;
  assert.deepEqual(office.zones, [{ device: 'ducted_ac', n: 5, name: 'Office & Guest', shared: ['guest'] }]);
  const lounge = h.rc.view('lounge')!;
  assert.equal(lounge.on, false, 'the zone is open but the unit is off');
  assert.equal(lounge.temp, 22.4, 'the lounge’s sensor');
  assert.equal(lounge.tempFrom, 'room');
  assert.equal(h.rc.view('kitchen')!.temp, 22.9, 'the kitchen’s motion sensor reads the temperature too');
  assert.equal(h.rc.view('office')!.temp, 23.5, 'nothing reads the office: the unit’s own reading');
  assert.equal(h.rc.view('office')!.tempFrom, 'unit');
  assert.equal(h.rc.view('music'), null, 'no zone mapped to the music room');
  await h.done();
});

test('Turning a room AC on and off: its zone only, a sensible mode, others’ mode kept, the last zone turns the unit off', async () => {
  const h = await setup();
  // 30 September in Perth: spring. Master bed 21.2°, mild outside: heat, to the heat-to temperature, fan auto.
  h.setOutside({ temp: 19, high: 21, low: 12 });
  const r = await h.rc.apply('master', { on: true }, YOU);
  assert.ok(r.changed.includes('ducted_ac'));
  assert.equal(h.ac().on, true);
  assert.equal(h.ac().hvac, 'heat');
  assert.equal(h.ac().target, 21);
  assert.equal(h.ac().fanSpeed, 'auto');
  assert.equal(h.zone(3), true, 'the master bed’s zone opens');
  assert.equal(h.zone(1), false, 'zones left open while the unit was off close: only the room that asked gets air');
  assert.equal(h.zone(2), false);
  assert.equal(h.rc.view('master')!.on, true);
  assert.equal(h.rc.view('lounge')!.on, false);
  const log = h.hub.store.between(0, Number.MAX_SAFE_INTEGER, 'run').at(-1)!;
  assert.equal(log.cause.label, 'Google Home');
  assert.match(log.cause.detail!, /Master bed AC on, heat to 21°/);

  // A warm room asks while the unit heats for the master bed: its zone opens, nobody's mode flips.
  await h.sensor('baby_climate', 27);
  await h.rc.apply('baby', { on: true }, YOU);
  assert.equal(h.zone(4), true);
  assert.equal(h.ac().hvac, 'heat', 'kept: the master bed is still being heated');
  assert.equal(h.ac().target, 21);
  assert.equal(h.zone(3), true);

  // "On" again changes nothing.
  assert.deepEqual((await h.rc.apply('baby', { on: true }, YOU)).changed, []);

  // Off: only that zone; the unit stays on for the master bed.
  await h.rc.apply('baby', { on: false }, YOU);
  assert.equal(h.zone(4), false);
  assert.equal(h.ac().on, true);
  // The last open zone closing turns the unit off.
  await h.rc.apply('master', { on: false }, YOU);
  assert.equal(h.zone(3), false);
  assert.equal(h.ac().on, false);
  await h.done();
});

test('Explicit settings are done as asked, hold, and come back with the room’s next “on”', async () => {
  const h = await setup();
  h.setOutside({ temp: 30, high: 33, low: 20 });
  // A hot day: cooling to 24 by default.
  await h.rc.apply('lounge', { on: true }, YOU);
  assert.equal(h.ac().hvac, 'cool');
  assert.equal(h.ac().target, 24);
  // "Set the lounge AC to 22": the person's choice.
  await h.rc.apply('lounge', { target: 22 }, YOU);
  assert.equal(h.ac().target, 22);
  assert.deepEqual(h.rc.view('lounge')!.held, { target: 22 });
  // Another room on: the unit keeps 22 (never fight the person).
  await h.rc.apply('kitchen', { on: true }, YOU);
  assert.equal(h.ac().target, 22);
  assert.equal(h.ac().hvac, 'cool');
  // "Fan high" and "heat mode" from the lounge: as asked; a new mode without a temperature gets that mode's comfortable one.
  await h.rc.apply('lounge', { fanSpeed: 'high' }, YOU);
  assert.equal(h.ac().fanSpeed, 'high');
  await h.rc.apply('lounge', { hvac: 'heat' }, YOU);
  assert.equal(h.ac().hvac, 'heat');
  assert.equal(h.ac().target, 21);
  await h.rc.apply('lounge', { hvac: 'cool', target: 23 }, YOU);
  assert.deepEqual(h.rc.view('lounge')!.held, { hvac: 'cool', target: 23, fanSpeed: 'high' });
  // Off ends the hold; the choice is remembered.
  await h.rc.apply('kitchen', { on: false }, YOU);
  await h.rc.apply('lounge', { on: false }, YOU);
  assert.equal(h.ac().on, false);
  assert.equal(h.rc.view('lounge')!.held, null);
  assert.equal(h.rc.remembered('lounge')!.held, false);
  // A cool day now, but the lounge's next "on" brings back its own choice: cool 23, fan high.
  h.setOutside({ temp: 12, high: 15, low: 8 });
  await h.rc.apply('lounge', { on: true }, YOU);
  assert.deepEqual([h.ac().hvac, h.ac().target, h.ac().fanSpeed], ['cool', 23, 'high']);
  await h.rc.apply('lounge', { on: false }, YOU);
  // Another room isn't affected by the lounge's choice: the policy picks heat for the cool day.
  await h.rc.apply('kitchen', { on: true }, YOU);
  assert.deepEqual([h.ac().hvac, h.ac().target, h.ac().fanSpeed], ['heat', 21, 'auto']);
  await h.rc.apply('kitchen', { on: false }, YOU);
  // An explicit mode while the room is off turns it on in that mode.
  await h.rc.apply('master', { hvac: 'dry' }, YOU);
  assert.deepEqual([h.ac().on, h.ac().hvac, h.zone(3)], [true, 'dry', true]);
  await h.rc.apply('master', { hvac: 'off' }, YOU);
  assert.equal(h.ac().on, false, 'mode off is off');
  await h.done();
});

test('A remembered choice is for its season, and comfort settings change the defaults', async () => {
  const h = await setup(c => { c.roomClimate = { coolTo: 23, heatTo: 22 }; });
  await h.rc.apply('office', { hvac: 'cool', target: 20 }, YOU);
  await h.rc.apply('office', { on: false }, YOU);
  // Spring then; a winter's day in Perth now: the summer-ish choice isn't brought back.
  h.clock.t = at(12, '2026-07-15');
  await h.rc.apply('office', { on: true }, YOU);
  assert.deepEqual([h.ac().hvac, h.ac().target], ['heat', 22], 'winter heats, to the owner’s heat-to');
  assert.equal(h.zone(5), true);
  await h.done();
});

test('Turned on elsewhere with every zone closed: off by default; with the setting, rooms where someone is, else ask', async () => {
  const h = await setup();
  const notes: string[] = [];
  h.rc.notify = async n => { notes.push(n.title); };
  // Close every zone, unit off.
  await h.hub.engine.command('ducted_ac', { on: false, zoneSet: Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [String(n), { on: false }])) }, { kind: 'user', label: 'You' });
  h.clock.t += 10 * 60_000;
  // The maker's app (or its Google link) turns it on: by default Kova leaves it.
  h.virtual.physical('ducted_ac', { on: true, hvac: 'cool' });
  await new Promise(r => setImmediate(r));
  assert.ok(h.ac().zones!.every(z => !z.on));
  assert.deepEqual(notes, []);
  h.virtual.physical('ducted_ac', { on: false });

  h.hub.config.update(c => { c.roomClimate = { fromElsewhere: 'rooms' }; });
  // Someone in the kitchen (its motion sensor).
  h.virtual.physical('kitchen_motion', { motion: true });
  h.virtual.physical('ducted_ac', { on: true, hvac: 'cool' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.zone(2), true, 'the kitchen’s zone opens');
  assert.equal(h.zone(1), false);
  assert.equal(h.ac().hvac, 'cool', 'the mode it was turned on in is kept');
  const run = h.hub.store.between(0, Number.MAX_SAFE_INTEGER, 'run').at(-1)!;
  assert.match(run.cause.detail!, /Kitchen/);

  // Nobody anywhere: ask on the phones.
  await h.hub.engine.command('ducted_ac', { on: false, zoneSet: { 2: { on: false } } }, { kind: 'user', label: 'You' });
  h.virtual.physical('kitchen_motion', { motion: false });
  h.clock.t += 60 * 60_000;
  h.virtual.physical('ducted_ac', { on: true });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(h.ac().zones!.every(z => !z.on));
  assert.deepEqual(notes, ['Ducted AC is on with every zone closed']);

  // Kova's own change is never mistaken for one from elsewhere.
  h.virtual.physical('ducted_ac', { on: false });
  await h.hub.engine.command('ducted_ac', { on: true }, { kind: 'user', label: 'You' });
  await h.hub.engine.command('ducted_ac', { on: false }, { kind: 'user', label: 'You' });
  h.virtual.physical('ducted_ac', { on: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(notes.length, 1, 'Kova sent a command to the unit a moment ago');
  await h.done();
});

// --------------------------------------------------------- api and asks --

test('Room AC settings, the snapshot, and Ask Kova', async () => {
  const h = await setup();
  const app = await buildServer(h.hub, { webRoot, ai: { timeoutMs: 3000 } });
  open.push(() => app.close());
  const state = async () => (await app.inject({ url: '/api/state' })).json();
  let s = await state();
  assert.equal(s.roomClimate.season, 'spring');
  assert.equal(s.roomClimate.seasonLabel, 'Spring');
  assert.deepEqual(s.roomClimate.settings, { coolTo: 24, heatTo: 21, fromElsewhere: 'off' });
  assert.deepEqual(s.roomClimate.rooms.map((r: { label: string }) => r.label), ['Lounge AC', 'Kitchen AC', 'Office AC', 'Master bed AC', 'Baby room AC', 'Guest room AC']);
  assert.deepEqual(s.roomClimate.bridges, { matter: false, homekit: false });
  assert.deepEqual((await app.inject({ url: '/api/room-climate/pairing' })).json(), { matter: { enabled: false }, homekit: { enabled: false } });

  const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/room-climate', payload });
  assert.equal((await put({ coolTo: 23.5, heatTo: 20, fromElsewhere: 'rooms' })).statusCode, 200);
  s = await state();
  assert.deepEqual(s.roomClimate.settings, { coolTo: 23.5, heatTo: 20, fromElsewhere: 'rooms' });
  assert.equal((await put({ coolTo: 40 })).statusCode, 400);
  assert.equal((await put({ coolTo: 20, heatTo: 22 })).statusCode, 400, 'cool-to below heat-to');
  assert.equal((await put({ fromElsewhere: 'sometimes' })).statusCode, 400);
  assert.equal((await put({ coolTo: null, heatTo: null, fromElsewhere: 'off' })).statusCode, 200);
  assert.deepEqual((await state()).roomClimate.settings, { coolTo: 24, heatTo: 21, fromElsewhere: 'off' });

  // A room AC on and off from the apps.
  const r = await app.inject({ method: 'POST', url: '/api/room-climate/office', payload: { on: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(h.zone(5), true);
  assert.equal(h.ac().on, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/room-climate/music', payload: { on: true } })).statusCode, 400);
  await app.inject({ method: 'POST', url: '/api/room-climate/office', payload: { on: false } });
  assert.equal(h.ac().on, false);

  // Ask Kova: "in here" without knowing the room asks which one.
  const ask = async (text: string) => (await app.inject({ method: 'POST', url: '/api/ask', payload: { text } })).json();
  const a = await ask('turn on the AC in here');
  assert.match(a.text, /Which room/);
  assert.deepEqual(a.actions.map((x: { label: string }) => x.label), ['Lounge', 'Kitchen', 'Office', 'Master bed', 'Baby room', 'Guest room']);
  assert.equal(h.ac().on, false, 'nothing done yet');
  const pick = a.actions.find((x: { label: string }) => x.label === 'Master bed').action;
  const done = (await app.inject({ method: 'POST', url: '/api/ask/act', payload: { action: pick } })).json();
  assert.match(done.text, /Master bed AC on\. The AC is (heating|cooling) to \d+°/);
  assert.equal(h.zone(3), true);
  assert.match((await ask('turn the aircon off')).text, /Which room/);
  // With the room named, the policy runs: the master bed is on, so the lounge keeps its mode.
  const mode = h.ac().hvac;
  await ask('turn on the AC in the lounge');
  assert.equal(h.zone(1), true);
  assert.equal(h.ac().hvac, mode);
  await h.done();
});
