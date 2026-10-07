import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivedList, cleanName, combineChoices, devicesIn, favouriteList, groupBody, groupDraftError, groupSyncNote, moveStep, roomDelete, roomGroupError, roomGroups, roomRows, speakerChoices } from '../src/logic/customise.ts';
import { historyRows, hubProgress, updateNotice } from '../src/logic/updates.ts';
import { energyView, kw, kwh, parseWatts, wattsNote } from '../src/logic/energy.ts';
import { groupMembers, loopDone, memberToggle, musicCommand, nowPlaying, pickPlayer, playersOf, playPause, sourceCommand, sourceSub, stationCommand, streamUrlError } from '../src/logic/media.ts';
import { NATIVE_PAGES } from '../src/logic/links.ts';
import { devs } from '../src/logic/devices.ts';
import type { Device, EnergyToday, Room } from '../src/api/types.ts';

const rooms: Room[] = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' }, { id: 'hall', name: 'Hall', icon: 'stairs' }];
const dev = (id: string, type: Device['type'], room: string, state: Device['state'] = {}, extra: Partial<Device> = {}): Device =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), room, type, capabilities: ['onoff'], adapter: 'x', integration: 'X', address: id, state, ...extra });

// ------------------------------------------------------------ customise ---

test('names are tidied the way the hub keeps them', () => {
  assert.equal(cleanName('  Back   garden '), 'Back garden');
  assert.equal(cleanName('x'.repeat(50)).length, 40);
  assert.equal(cleanName('   '), '');
});

test('moving a room or a favourite one step, and not past either end', () => {
  assert.deepEqual(moveStep(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveStep(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.equal(moveStep(['a', 'b'], 'a', -1), null);
  assert.equal(moveStep(['a', 'b'], 'b', 1), null);
  assert.equal(moveStep(['a', 'b'], 'z', 1), null);
});

test('rooms count their devices; deleting one moves its devices to another room', () => {
  const ds = [dev('lamp', 'light', 'lounge'), dev('tv', 'tv', 'lounge'), dev('kettle', 'plug', 'kitchen')];
  assert.deepEqual(roomRows(rooms, ds).map(r => r.sub), ['2 devices', '1 device', 'No devices yet']);
  assert.deepEqual(roomDelete('hall', rooms, ds), { inside: 0, moveTo: null, body: {}, confirm: 'Delete Hall? It has no devices.' }, 'an empty room just goes');
  const d = roomDelete('lounge', rooms, ds);
  assert.deepEqual(d.body, { moveTo: 'unassigned' }, 'to no room by default');
  assert.equal(d.confirm, 'Delete Lounge? Its 2 devices go to No room, until you give them a room.');
  assert.deepEqual(roomDelete('lounge', rooms, ds, 'hall').body, { moveTo: 'hall' }, 'or a room picked instead');
  assert.equal(roomDelete('kitchen', rooms, ds, 'hall').confirm, 'Delete Kitchen? Its device goes to Hall.');
  assert.deepEqual(roomDelete('lounge', rooms, ds, 'lounge').body, { moveTo: 'unassigned' }, 'never into itself');
  assert.deepEqual(roomDelete('lounge', [rooms[0]], ds).body, { moveTo: 'unassigned' }, 'the only room can go too');
});

test('groups of rooms: their rooms by name, and what stops one being saved', () => {
  const g = roomGroups({ Downstairs: ['lounge', 'kitchen', 'gone'], Hallways: ['hall'] }, rooms);
  assert.deepEqual(g, [{ name: 'Downstairs', rooms: ['lounge', 'kitchen'], roomNames: ['Lounge', 'Kitchen'] }, { name: 'Hallways', rooms: ['hall'], roomNames: ['Hall'] }]);
  assert.deepEqual(roomGroups(undefined, rooms), []);
  const groups = { Downstairs: ['lounge'] };
  assert.equal(roomGroupError('', ['lounge'], groups, rooms), 'Give the group a name');
  assert.equal(roomGroupError('downstairs', ['lounge'], groups, rooms), 'There’s already a group called Downstairs');
  assert.equal(roomGroupError('downstairs', ['lounge'], groups, rooms, 'Downstairs'), null, 'its own name is fine when editing');
  assert.equal(roomGroupError('Kitchen', ['lounge'], groups, rooms), 'Kitchen is already a room’s name');
  assert.equal(roomGroupError('Upstairs', [], groups, rooms), 'Pick at least one room');
  assert.equal(roomGroupError(' Upstairs ', ['hall'], groups, rooms), null);
});

test('archived devices: listed on their own, out of rooms, favourites and speaker choices; what a device can combine with', () => {
  const ds = [dev('lamp', 'light', 'lounge'), dev('old', 'light', 'lounge', {}, { archived: true }), dev('spk', 'media', 'lounge', {}, { archived: true }), dev('g', 'media', 'lounge', {}, { adapter: 'groups' }), dev('tv', 'tv', 'lounge'), dev('soundbar', 'media', 'lounge')];
  assert.deepEqual(archivedList(ds).map(d => d.id), ['old', 'spk']);
  assert.deepEqual(devicesIn(ds, rooms, 'lounge').map(d => d.id), ['g', 'lamp', 'soundbar', 'tv']);
  assert.deepEqual(roomRows(rooms, ds)[0].sub, '4 devices');
  assert.deepEqual(favouriteList(['old', 'lamp'], ds).map(d => d.id), ['lamp']);
  assert.ok(!speakerChoices(ds, rooms).some(d => d.id === 'spk'));
  assert.deepEqual(combineChoices('tv', ds, []).map(d => d.id), ['lamp', 'soundbar'], 'not itself, groups or archived ones');
  assert.deepEqual(combineChoices('tv', ds, [{ members: ['soundbar', 'x'] }]).map(d => d.id), ['lamp'], 'not one already combined');
  assert.deepEqual(combineChoices('tv', ds, [], 'SOUND').map(d => d.id), ['soundbar'], 'searched by name');
});

test('software update: progress, history and the note on More', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  assert.equal(hubProgress({ state: 'idle', available: null }), null);
  assert.match(hubProgress({ state: 'updating', available: { version: '0.7.48', behind: 2, changes: [] } })!, /^Installing Kova 0\.7\.48\. It backs up first/);
  assert.equal(hubProgress({ state: 'requested', available: null }), 'Asked the hub. It starts in a moment.');
  const rows = historyRows({ last: null, history: [{ result: 'rolled-back', from: '0.7.46', to: '0.7.47', at: now - 2 * 86_400_000 }, { result: 'updated', from: '0.7.45', to: '0.7.46', at: now - 3_600_000 }] }, now);
  assert.deepEqual(rows.map(r => [r.title, r.tone]), [['Updated 0.7.45 → 0.7.46', 'ok'], ['Went back to 0.7.46', 'warn']], 'newest first');
  assert.match(rows[0].sub, /1 h ago$/);
  assert.deepEqual(historyRows({ last: { result: 'failed', from: '0.7.40', to: '0.7.41', at: now }, history: undefined }, now).map(r => r.title), ['Update to 0.7.41 failed'], 'an older hub: just the last one');
  assert.deepEqual(historyRows({ last: null, history: [] }, now), []);
  assert.equal(updateNotice({ state: 'idle', available: { version: '0.7.48', behind: 1, changes: [] } }, { state: 'current' }), 'Kova 0.7.48 is ready to install on your hub');
  assert.equal(updateNotice(null, { state: 'ready', version: '0.2.23' }), 'App update 0.2.23 ready: restart to use it');
  assert.equal(updateNotice({ state: 'idle', available: null }, { state: 'current' }), null);
});

test('favourites keep their order and drop devices that are gone; devices by room, the rest under no room', () => {
  const ds = [dev('lamp', 'light', 'lounge'), dev('kettle', 'plug', 'kitchen'), dev('old', 'light', 'shed')];
  assert.deepEqual(favouriteList(['kettle', 'gone', 'lamp'], ds).map(d => d.id), ['kettle', 'lamp']);
  assert.deepEqual(favouriteList(null, ds), []);
  assert.deepEqual(devicesIn(ds, rooms, 'lounge').map(d => d.id), ['lamp']);
  assert.deepEqual(devicesIn(ds, rooms, 'unassigned').map(d => d.id), ['old']);
});

test('speaker groups: who can be in one, what’s missing, the body, and how they’ll sync', () => {
  const ds = [dev('b', 'media', 'kitchen', {}, { adapter: 'cast' }), dev('a', 'media', 'lounge', {}, { adapter: 'cast' }), dev('g', 'media', 'lounge', {}, { adapter: 'groups' }), dev('lamp', 'light', 'lounge'), dev('s', 'media', 'kitchen', {}, { adapter: 'sonos' })];
  assert.deepEqual(speakerChoices(ds, rooms).map(d => d.id), ['b', 's', 'a'], 'speakers only, not groups, by room then name');
  assert.equal(groupDraftError({ name: ' ', members: ['a', 'b'], room: '' }), 'Give the group a name');
  assert.equal(groupDraftError({ name: 'Down', members: ['a', 'a'], room: '' }), 'Pick at least two speakers');
  assert.equal(groupDraftError({ name: 'Down', members: ['a', 'b'], room: '' }), null);
  assert.deepEqual(groupBody({ name: ' Down  stairs', members: ['a', 'b', 'a'], room: '' }, false), { name: 'Down stairs', members: ['a', 'b'] });
  assert.deepEqual(groupBody({ name: 'Down', members: ['a', 'b'], room: '' }, true), { name: 'Down', members: ['a', 'b'], room: null }, 'editing clears the room back to automatic');
  assert.deepEqual(groupBody({ name: 'Down', members: ['a', 'b'], room: 'lounge' }, false).room, 'lounge');
  const [a, b, , , so] = ds;
  assert.equal(groupSyncNote([a], ['a']).tone, 'muted');
  assert.equal(groupSyncNote([a, b], ['a', 'b'], { members: ['b', 'a'], sync: 'perfect', castGroup: 'Down' }).title, 'Perfect sync');
  assert.match(groupSyncNote([a, b], ['a', 'b']).text, /Google Home app/);
  assert.match(groupSyncNote([a, so], ['a', 's']).text, /Different brands/);
});

// --------------------------------------------------------------- energy ---

const E = (o: Partial<EnergyToday> = {}): EnergyToday => ({
  available: true, now: { solar: 2400, load: 900, grid: -1500 }, solarKwh: 6.4, usedKwh: 4, fromGridKwh: 1, exportedKwh: 2.4,
  hours: Array.from({ length: 24 }, (_, h) => ({ solar: h >= 7 && h <= 17 ? 1.2 : 0, use: h === 18 ? 2.4 : 0.3 })), peak: { w: 3100, hour: 12 },
  devices: [{ id: 'tv', name: 'TV', w: 110, estimated: true }, { id: 'fridge', name: 'Fridge', w: 220 }, { id: 'off', name: 'Off', w: 0 }], ...o,
});

test('watts and kWh as the screen writes them', () => {
  assert.equal(kw(450.4), '450 W');
  assert.equal(kw(-2400), '2.4 kW');
  assert.equal(kw(null), '—');
  assert.equal(kwh(6.44), '6.4 kWh');
  assert.equal(kwh(null), '—');
});

test('energy with solar and a grid meter: flows, totals, the chart scaled to the busiest hour, devices by draw', () => {
  const v = energyView(E(), 13.5, 'GoodWe');
  assert.equal(v.sub, 'Today so far · GoodWe');
  assert.deepEqual(v.now, { solar: '2.4 kW', load: '900 W', grid: '1.5 kW', gridLabel: 'To the grid', gridDir: 'out', hasSolar: true });
  assert.match(v.insight, /more than the home is using/);
  assert.deepEqual(v.stats.map(s => [s.id, s.value]), [['solar', '6.4 kWh'], ['used', '4.0 kWh'], ['grid', '1.0 kWh'], ['export', '2.4 kWh']]);
  assert.equal(v.stats[0].sub, 'Peak 3.1 kW at 12:00');
  assert.equal(v.stats[1].sub, '100% from your own solar');
  assert.equal(v.max, 2.4);
  assert.equal(v.bars[18].use, 1);
  assert.equal(v.bars[12].solar, 0.5);
  assert.equal(v.bars[13].later, false);
  assert.equal(v.bars[14].later, true);
  assert.deepEqual(v.devices.map(d => [d.id, d.value, d.share]), [['tv', 'about 110 W', 0.5], ['fridge', '220 W', 1]], 'devices drawing nothing are left out');
});

test('energy from estimates only, and none at all', () => {
  const v = energyView(E({ now: { solar: 0, load: 330, grid: null }, solarKwh: 0, usedKwh: 1.1, fromGridKwh: null, exportedKwh: null, peak: null, estimated: true }), 20, null);
  assert.equal(v.now.hasSolar, false);
  assert.deepEqual(v.stats.map(s => s.id), ['used', 'grid'], 'no solar or sent-back cards without an inverter');
  assert.equal(v.stats[1].sub, 'Needs a grid meter');
  assert.match(v.insight, /^About 330 W in use now, most of it TV/);
  const none = energyView(null, 9);
  assert.equal(none.available, false);
  assert.equal(none.hasHistory, false);
  assert.equal(none.bars.length, 24);
});

test('a device’s watts: a whole number up to 10,000, or empty for Kova’s own figure', () => {
  assert.deepEqual(parseWatts(' 60 W'), { ok: true, watts: 60 });
  assert.deepEqual(parseWatts('7,5'), { ok: true, watts: 8 });
  assert.deepEqual(parseWatts(''), { ok: true, watts: null });
  assert.equal(parseWatts('lots').ok, false);
  assert.equal(parseWatts('-3').ok, false);
  assert.equal(parseWatts('20000').ok, false);
  assert.equal(wattsNote({ watts: 140, typicalWatts: 110 }), '140 W while on · your figure');
  assert.equal(wattsNote({ watts: null, typicalWatts: 110 }), 'About 110 W while on · Kova’s guess');
  assert.match(wattsNote({ watts: null, typicalWatts: null }), /Not counted/);
});

// ---------------------------------------------------------------- media ---

const media = (id: string, state: Device['state'], caps: string[] = ['onoff', 'media', 'volume']) => dev(id, 'media', 'lounge', state, { capabilities: caps });
const home = devs({ devices: [
  media('kitchen', { on: true, media: 'Loved', vol: 40, shuffle: true, track: { title: 'Song', artist: 'Band' } }, ['onoff', 'media', 'volume', 'queue', 'pause']),
  media('den', { on: false, vol: 20 }),
  media('group_down', { on: true, media: 'Loved', shuffle: true }, ['onoff', 'media', 'volume', 'queue']),
  dev('lamp', 'light', 'lounge'),
  media('hidden', { on: false }, ['onoff']),
] });
home.hidden.hidden = true;
const group = { id: 'down', deviceId: 'group_down', members: ['kitchen', 'den', 'gone'] };

test('players and groups apart; the one shown is the one picked, else what’s playing', () => {
  const { players, groups } = playersOf(home, [group]);
  assert.deepEqual(players.map(d => d.id), ['den', 'kitchen']);
  assert.deepEqual(groups.map(d => d.id), ['group_down']);
  assert.equal(pickPlayer(players)?.id, 'kitchen');
  assert.equal(pickPlayer(players, 'den')?.id, 'den');
  assert.equal(pickPlayer(players, 'nope')?.id, 'kitchen');
  assert.equal(pickPlayer([]), undefined);
});

test('now playing: the song on a queue, else the player and what it plays', () => {
  const k = nowPlaying(home.kitchen, 'Kitchen');
  assert.deepEqual([k.title, k.sub, k.queue, k.playing], ['Song', 'Band · Loved · shuffled', true, true]);
  const d = nowPlaying(home.den, 'Den');
  assert.deepEqual([d.title, d.sub, d.queue, d.playing], ['Den', 'Den · Nothing playing', false, false]);
});

test('play and pause: pause when it can, stop when it can’t, start the first source when idle', () => {
  const src = [{ name: 'Rain' }];
  assert.deepEqual(playPause(home.kitchen, src).cmd, { paused: true });
  assert.deepEqual(playPause(home.group_down, src).cmd, { on: false, media: null });
  assert.deepEqual(playPause(home.den, src).cmd, { on: true, media: 'Rain', vol: 20 });
  assert.deepEqual(sourceCommand(home.den, { name: 'Jazz' }), { cmd: { on: true, media: 'Jazz', vol: 20 }, done: 'Playing Jazz on Den' });
});

test('a speaker group: each speaker in or out; out stops it, back in plays what the group plays at its own volume', () => {
  const ms = groupMembers(group, home);
  assert.deepEqual(ms.map(m => [m.d.id, m.in]), [['kitchen', true], ['den', false]], 'missing speakers are left out');
  assert.deepEqual(memberToggle(home.kitchen, home.group_down), { cmd: { on: false, media: null }, done: 'Kitchen left Group_down' });
  assert.deepEqual(memberToggle(home.den, home.group_down), { cmd: { on: true, media: 'Loved', shuffle: true, vol: 20 }, done: 'Den joined Group_down' });
  assert.deepEqual(memberToggle(home.den, { ...home.group_down, on: false }), { error: 'Play something on Group_down first' });
});

test('Helix music only on speakers that play a queue; stations always shuffle', () => {
  assert.deepEqual(musicCommand(home.kitchen, { name: 'Shuffle all', kind: 'all' }, false), { cmd: { on: true, media: 'Shuffle all', shuffle: true }, done: 'Playing Shuffle all on Kitchen' });
  assert.deepEqual(musicCommand(home.kitchen, { name: 'Focus', kind: 'playlist' }, true).done ?? '', 'Playing Focus on shuffle on Kitchen');
  assert.deepEqual(musicCommand(home.kitchen, { name: 'Focus', kind: 'playlist' }, false), { cmd: { on: true, media: 'Focus', shuffle: false }, done: 'Playing Focus on Kitchen' });
  assert.ok('error' in musicCommand(home.den, { name: 'Loved', kind: 'loved' }, false));
  assert.deepEqual(stationCommand(home.kitchen, ' Miles '), { cmd: { on: true, media: 'Station: Miles', shuffle: true }, done: 'Playing a station from Miles on Kitchen' });
  assert.equal(stationCommand(home.kitchen, '  '), null);
});

test('sources: the stream address, the line under one, and the repeat toast', () => {
  assert.equal(streamUrlError('https://example.com/rain.mp3'), null);
  assert.equal(streamUrlError(''), null, 'empty clears it');
  assert.equal(streamUrlError('example.com'), 'Use an http(s) stream address');
  assert.deepEqual(sourceSub({ name: 'Rain', icon: 'x' }), { text: 'No stream address yet', missing: true });
  assert.deepEqual(sourceSub({ name: 'Rain', icon: 'x', url: 'https://example.com/rain.mp3', loop: true }), { text: 'Repeats · example.com', missing: false });
  assert.equal(sourceSub({ name: 'Rain', icon: 'x', url: 'http://example.com:8000/live' }).text, 'Plays once · example.com:8000');
  assert.equal(loopDone({ name: 'Rain' }, true), 'Rain repeats until you stop it');
  assert.equal(loopDone({ name: 'Rain' }, false), 'Rain plays once');
});

test('notification links open the app’s own screens for these pages', () => {
  assert.equal(NATIVE_PAGES.energy, 'Energy');
  assert.equal(NATIVE_PAGES.media, 'Media');
  assert.equal(NATIVE_PAGES.customise, 'Customise');
  assert.equal(NATIVE_PAGES.settings, 'Settings', 'hub update notifications open Settings, where Software update is');
  assert.equal(NATIVE_PAGES.integrations, 'Integrations');
});
