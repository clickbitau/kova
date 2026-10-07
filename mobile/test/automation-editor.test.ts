import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CMD_ORDER, FIELD_CAP, addMinutes, bodyOf, carryCommand, changeActionKind, commandWords, conditionText, draftOf, draftSummary, duplicateAt, eventsFor, extrasOf,
  fieldDefault, fieldsFor, firstCommand, flatCommand, freeFields, inputsOf, isOneTime, localNowOf, matchFields, matchWords, mediaChoices, mediaFromKey, mediaKey,
  minutesUntil, monthGrid, newAction, newTrigger, nextSameTime, onceChips, onceProblem, onceState, onceWords, parseStamp, presets, pseudoLabel, pseudoTargets,
  readingsFor, scheduleAgain, scheduleDraft, scheduleLine, scheduleName, sectionsOf, shiftMonth, stampOf, targetInfo, triggerText, untilWords, withField, withMatch,
  zoneWords, zonesOf, ctxOf, canSet, changeKind, newCondition, roomEventsFor, roomNote, roomOptions, roomProblem, withinProblem, FIELD_UNIT, type AutomationView, type Draft, type Names,
} from '../src/logic/automations.ts';

// A home of every kind of device, shaped as the snapshot sends them.
const dev = (id: string, type: string, room: string, capabilities: string[], state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), room, type, capabilities, state, ...extra }) as never;
const devices = [
  dev('lamp', 'light', 'lounge', ['onoff', 'brightness', 'colorTemp', 'color'], { on: true, bri: 40, k: 2700 }),
  dev('plug', 'plug', 'kitchen', ['onoff', 'power', 'energy'], { on: true, power: 12, energy: 0.4 }),
  dev('speaker', 'media', 'kitchen', ['onoff', 'media', 'volume', 'pause', 'queue'], { on: false, vol: 25 }),
  dev('box', 'media', 'lounge', ['onoff', 'media', 'volume', 'pause', 'library'], { on: true }),
  dev('tv', 'tv', 'lounge', ['onoff', 'input', 'mute', 'volume'], { on: true, input: null }),
  dev('bar', 'media', 'lounge', ['onoff', 'input', 'mute', 'sound', 'volume'], { on: true, input: 'tv', sound: 'standard' }),
  dev('ac', 'climate', 'lounge', ['onoff', 'climate', 'zones', 'extras'], { on: true, hvac: 'cool', target: 23, temp: 26, humidity: 55, zones: [{ n: 1, on: true, open: 100 }, { n: 2, on: false, open: 0 }], extras: { eco: false, sleep: true, swing: 3 } }, { zoneNames: { 1: 'Living' } }),
  dev('purifier', 'fan', 'bedroom', ['onoff', 'fanMode', 'purifier'], { on: true, mode: 'Auto', fanLevel: 2, fanLevelMax: 4, pm25: 8 }),
  dev('vac', 'vacuum', 'lounge', ['onoff', 'vacuum', 'battery'], { activity: 'docked', battery: 90 }),
  dev('door', 'camera', 'front', ['events']),
  dev('motion', 'sensor', 'hall', ['events'], { lux: 120 }),
  dev('meter', 'sensor', 'garage', ['power'], { grid: -300, load: 900 }),
  dev('router', 'internet', 'hall', ['onoff']),
];
const rooms = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' }, { id: 'bedroom', name: 'Bedroom', icon: 'bed' }];
const sources = [{ name: 'Rain' }, { name: 'Jazz FM' }];
const music = [{ name: 'Shuffle all', kind: 'all' as const }, { name: 'Loved', kind: 'loved' as const }, { name: 'Dinner', kind: 'playlist' as const }];
const info = (id: string) => targetInfo(id, devices, rooms);
const NOW = '2026-10-07T14:05';
const names: Names = { devices, rooms, people: [{ id: 'sam', name: 'Sam' }], modes: [{ id: 'evening', name: 'Evening' }], overlays: [{ id: 'movie', name: 'Movie' }], automations: [{ id: 'night', name: 'Goodnight' }], now: NOW };
const keys = (l: { key: string }[]) => l.map(f => f.key);

test('set devices: every field a device can do, from its capabilities, in order', () => {
  assert.deepEqual(keys(fieldsFor(info('lamp'))), ['on', 'bri', 'k', 'color']);
  assert.deepEqual(keys(fieldsFor(info('speaker'))), ['on', 'media', 'shuffle', 'paused', 'skip', 'vol', 'volStep']);
  assert.deepEqual(keys(fieldsFor(info('box'))), ['on', 'media', 'paused', 'vol', 'volStep'], 'a library player takes a title, no queue');
  assert.deepEqual(keys(fieldsFor(info('bar'))), ['on', 'vol', 'volStep', 'muted', 'input', 'sound', 'night']);
  assert.deepEqual(keys(fieldsFor(info('ac'))), ['on', 'hvac', 'target', 'fanSpeed', 'zoneSet', 'extras']);
  assert.deepEqual(keys(fieldsFor(info('purifier'))), ['on', 'mode', 'fanLevel', 'display', 'childLock']);
  assert.deepEqual(keys(fieldsFor(info('vac'))), ['on', 'activity']);
  assert.deepEqual(keys(fieldsFor(info('router'))), ['on']);
  // Every settable field of the hub's FIELD_CAP has a place (power and battery are readings only).
  for (const k of Object.keys(FIELD_CAP)) if (k !== 'power' && k !== 'battery' && k !== 'zones') assert.ok((CMD_ORDER as readonly string[]).includes(k), k);
  // A field the command holds always shows, even one the device can't do (so nothing is hidden).
  assert.deepEqual(keys(fieldsFor(info('router'), { on: true, bri: 50 } as never)), ['on', 'bri']);
  assert.deepEqual(keys(freeFields(info('lamp'), { on: true, bri: 50 })), ['k', 'color']);
  assert.equal(fieldsFor(info('purifier')).find(f => f.key === 'fanLevel')?.max, 4, 'fan level up to the purifier’s own max');
});

test('inputs from the device: a soundbar’s, a TV’s, and whatever it reports', () => {
  assert.deepEqual(inputsOf(info('tv')).map(o => o.v), ['tv', 'hdmi1', 'hdmi2', 'hdmi3', 'hdmi4']);
  assert.deepEqual(inputsOf(info('bar')).map(o => o.label), ['TV (eARC)', 'HDMI 1', 'HDMI 2', 'Bluetooth', 'Wi-Fi']);
  assert.equal(inputsOf(info('tv'), 'usb').pop()?.v, 'usb', 'an odd current one is kept');
});

test('groups as targets: all of a type, everything in a room, now and later', () => {
  const p = pseudoTargets(devices, rooms);
  assert.deepEqual(p.slice(0, 3).map(o => o.v), ['type:light', 'type:media', 'type:tv']);
  assert.ok(p.some(o => o.v === 'room:lounge' && o.label === 'Everything in Lounge'));
  assert.equal(pseudoLabel('type:light', rooms), 'All lights');
  const lights = info('type:light');
  assert.equal(lights.pseudo, true);
  assert.deepEqual(lights.devices.map(d => (d as { id: string }).id), ['lamp']);
  assert.deepEqual(keys(fieldsFor(lights)), ['on', 'bri', 'k', 'color']);
  assert.deepEqual(keys(fieldsFor(targetInfo('type:vacuum', [], rooms))), ['on', 'activity'], 'a type the home lacks still has its fields');
  assert.ok(keys(fieldsFor(info('room:lounge'))).includes('hvac'), 'a room can do what anything in it can');
});

test('defaults: what the device is at now, and a first command that is on', () => {
  assert.equal(fieldDefault('bri', info('lamp')), 40);
  assert.equal(fieldDefault('vol', info('speaker')), 25);
  assert.equal(fieldDefault('media', info('speaker'), sources, music), 'Rain');
  assert.deepEqual(fieldDefault('zoneSet', info('ac')), { 1: { on: true, open: 100 } });
  assert.deepEqual(fieldDefault('extras', info('ac')), { eco: true }, 'a switch flips from what it is');
  assert.deepEqual(firstCommand(info('lamp')), { on: true });
  assert.deepEqual(firstCommand(targetInfo('x', [dev('x', 'fan', 'r', ['fanMode'])], [])), { mode: 'Auto' }, 'no on/off: its first setting');
  assert.deepEqual(withField({ on: true, bri: 5 }, 'bri', undefined), { on: true });
  assert.deepEqual(presets(info('lamp'), sources).map(p => p[1]), ['Off', 'On at 10%', 'On at 50%', 'On at 100%', 'Warm white', 'Daylight']);
  assert.deepEqual(presets(info('speaker'), sources, music).map(p => p[1]), ['Stop', 'Pause', 'Play Rain', 'Play Jazz FM', 'Shuffle all music']);
  assert.equal(presets(info('ac'), sources)[0][1], 'Cool to 24°');
  // Swapping devices keeps what the new one can do.
  assert.deepEqual(carryCommand({ on: true, bri: 30, k: 3000 }, info('plug')), { on: true });
  assert.deepEqual(carryCommand({ bri: 30 }, info('router')), { on: true });
});

test('media: stop, the home’s sources, Helix music, a station, a title', () => {
  const sp = mediaChoices(info('speaker'), sources, music, null).map(o => o.label);
  assert.deepEqual(sp, ['Nothing: stop playing', 'Rain', 'Jazz FM', 'Shuffle all', 'Loved', 'Playlist: Dinner', 'A station from an artist, album or song…']);
  assert.ok(mediaChoices(info('box'), sources, music).some(o => o.v === 'title'));
  assert.equal(mediaKey(null, info('speaker'), sources, music), 'stop');
  assert.equal(mediaKey('Station: Nina Simone', info('speaker'), sources, music), 'station');
  assert.equal(mediaKey('Loved', info('speaker'), sources, music), 'src:Loved');
  assert.equal(mediaKey('Paddington 2', info('box'), sources, music), 'title');
  assert.equal(mediaFromKey('station', 'Rain'), 'Station: ');
  assert.equal(mediaFromKey('station', 'Station: Abba'), 'Station: Abba');
  assert.equal(mediaFromKey('stop', 'Rain'), null);
  assert.equal(mediaFromKey('src:Jazz FM', null), 'Jazz FM');
  assert.ok(mediaChoices(info('speaker'), sources, music, 'Odd stream').some(o => o.label === 'Odd stream'), 'an unknown current one is kept');
});

test('zones and extras from the device', () => {
  assert.deepEqual(zonesOf(info('ac')), [{ n: '1', name: 'Living' }, { n: '2', name: 'Zone 2' }]);
  assert.deepEqual(zonesOf(info('ac'), { 5: { on: true } }).map(z => z.n), ['1', '2', '5']);
  assert.deepEqual(extrasOf(info('ac')).map(e => [e.key, e.kind]), [['eco', 'bool'], ['sleep', 'bool'], ['swing', 'number']]);
  assert.equal(zoneWords({ 1: { on: true, open: 50 }, 2: { on: false } }, { 1: 'Living' }), 'Living on at 50%, zone 2 off');
});

test('a command in words, every field, never “as set”', () => {
  const all = { on: true, bri: 40, k: 2700, color: '#ff0000', hvac: 'cool', target: 23, fanSpeed: 'low', mode: 'Sleep', fanLevel: 2, activity: 'returning', media: 'Station: Abba', shuffle: true, paused: false, skip: 1, vol: 30, volStep: -1, muted: true, input: 'hdmi2', sound: 'surround', night: true, zoneSet: { 1: { on: true, open: 60 } }, display: false, childLock: true, extras: { eco: true, swing: 3 } };
  const w = commandWords(all as never, { 1: 'Living' });
  assert.equal(w, 'on, 40%, 2700K, colour #ff0000, cool, 23°, fan low, Sleep mode, fan level 2, back to the dock, play Station: Abba, shuffled, carry on playing, next song, volume 30%, volume down, muted, input HDMI 2, surround sound, night mode on, Living on at 60%, display off, child lock on, eco on, swing 3');
  assert.equal(commandWords({ on: false, media: null }), 'off, stop playing');
  assert.equal(commandWords({}), 'nothing yet');
  assert.equal(commandWords({ somethingNew: 4 } as never), 'somethingNew 4', 'a field the app doesn’t know yet is still said');
});

test('state matches: a builder over what the device has', () => {
  assert.deepEqual(matchFields(devices[4]).map(f => f.key), ['on', 'online', 'input', 'playing', 'muted']);
  assert.deepEqual(matchFields(devices[6]).map(f => f.key), ['on', 'online', 'hvac']);
  assert.deepEqual(matchFields(devices[8]).map(f => f.key), ['on', 'online', 'activity']);
  assert.deepEqual(matchFields(devices[7]).map(f => f.key), ['on', 'online', 'mode']);
  assert.deepEqual(matchFields(devices[9]).map(f => f.key), ['online'], 'a camera has no on/off to match');
  assert.ok(matchFields(devices[9], { on: true }).some(f => f.key === 'on'), 'a part the match has always shows');
  let m = withMatch(undefined, 'on', true);
  m = withMatch(m, 'input', 'hdmi2');
  m = withMatch(m, 'muted', false);
  assert.deepEqual(m, { on: true, input: 'hdmi2', muted: false });
  assert.equal(matchWords(m), 'on HDMI 2 and not muted');
  assert.equal(withMatch({ on: true }, 'on', undefined), undefined, 'nothing left is no match');
  assert.equal(matchWords({ playing: true, hvac: 'cool', activity: 'cleaning', mode: 'Sleep', online: false }), 'offline and playing and on cool and cleaning and on Sleep');
});

test('readings and events: only what the device has', () => {
  assert.deepEqual(readingsFor(devices[6]).map(o => o.v), ['temp', 'target', 'humidity']);
  assert.deepEqual(readingsFor(devices[10]).map(o => o.v), ['lux']);
  assert.deepEqual(readingsFor(devices[11]).map(o => o.v), ['power', 'grid', 'load']);
  assert.deepEqual(readingsFor(devices[1]).map(o => o.v), ['power', 'energy']);
  assert.ok(readingsFor(devices[1], 'bri').some(o => o.v === 'bri'), 'the current one is kept');
  assert.equal(readingsFor(undefined).length, 12);
  assert.deepEqual(eventsFor(devices[9]).map(o => o.v), ['person', 'motion', 'ring', 'vehicle', 'animal', 'package', 'sound'], 'a smart camera sees vehicles, animals and packages, and hears sounds');
  assert.deepEqual(eventsFor(devices[12]).map(o => o.v), ['internet-down', 'internet-up', 'internet-failover', 'new-device', 'threat']);
  assert.ok(eventsFor(devices[4]).some(o => o.v === 'screen-asleep'));
  assert.ok(eventsFor(devices[3]).some(o => o.v === 'ended') && eventsFor(devices[3]).some(o => o.v === 'resumed'));
  assert.equal(eventsFor(devices[9], 'doorbell-pressed').pop()?.v, 'doorbell-pressed', 'free text kept');
});

test('once: stamps on the home’s clock, words and quick chips', () => {
  assert.equal(addMinutes('2026-10-07T23:50', 15), '2026-10-08T00:05');
  assert.equal(addMinutes('2026-12-31T23:30', 60), '2027-01-01T00:30');
  assert.equal(stampOf(2026, 10, 32, 7, 0), '2026-11-01T07:00');
  assert.equal(parseStamp('2026-10-07T24:00'), null);
  assert.equal(onceWords('2026-10-07T15:30', NOW), 'today at 15:30');
  assert.equal(onceWords('2026-10-08T07:00', NOW), 'tomorrow at 07:00');
  assert.equal(onceWords('2026-10-15T09:00', NOW), 'Thu 15 Oct at 09:00');
  assert.equal(onceWords('2027-01-02T09:00', NOW), 'Sat 2 Jan 2027 at 09:00');
  assert.equal(minutesUntil('2026-10-07T15:30', NOW), 85);
  assert.equal(untilWords('2026-10-07T15:30', NOW), 'in 1 h 25 min');
  assert.equal(untilWords('2026-10-07T14:20', NOW), 'in 15 min');
  assert.equal(untilWords('2026-10-09T14:05', NOW), 'in 2 days');
  assert.equal(untilWords('2026-10-07T14:00', NOW), 'passed');
  assert.deepEqual(onceChips(NOW), [
    { label: 'In 15 min', at: '2026-10-07T14:20' }, { label: 'In 1 h', at: '2026-10-07T15:05' },
    { label: 'Tonight 21:00', at: '2026-10-07T21:00' }, { label: 'Tomorrow 07:00', at: '2026-10-08T07:00' },
  ]);
  assert.deepEqual(onceChips('2026-10-07T21:30').map(c => c.label), ['In 15 min', 'In 1 h', 'Tomorrow 21:00', 'Tomorrow 07:00'], 'after 21:00, tonight has gone');
  assert.equal(onceChips('2026-10-07T23:55')[1].at, '2026-10-08T00:55', 'across midnight');
  assert.equal(nextSameTime('2026-10-01T15:30', NOW), '2026-10-07T15:30');
  assert.equal(nextSameTime('2026-10-01T09:00', NOW), '2026-10-08T09:00');
});

test('once: the calendar month, starting on Sunday', () => {
  const g = monthGrid(2026, 10);
  assert.deepEqual(g[0], [null, null, null, null, 1, 2, 3], '1 Oct 2026 is a Thursday');
  assert.equal(g.flat().filter(Boolean).length, 31);
  assert.equal(g.every(w => w.length === 7), true);
  assert.deepEqual(shiftMonth(2026, 12, 1), [2027, 1]);
  assert.deepEqual(shiftMonth(2026, 1, -1), [2025, 12]);
});

test('once: state, schedule again, and a time that has passed', () => {
  assert.equal(onceState({ kind: 'once', at: '2026-10-07T15:00' }, NOW), 'upcoming');
  assert.equal(onceState({ kind: 'once', at: '2026-10-07T13:00' }, NOW), 'passed');
  assert.equal(onceState({ kind: 'once', at: '2026-10-07T13:00', firedAt: 1 }, NOW), 'done');
  assert.equal(onceState({ kind: 'once', at: '2026-10-07T13:00', firedAt: 1, missed: true }, NOW), 'missed');
  const d: Draft = { name: 'AC off', enabled: false, mode: 'single', triggers: [{ kind: 'once', at: '2026-10-06T15:00', firedAt: 123, missed: true }], conditions: [], actions: [{ kind: 'set', targets: { ac: { on: false } } }] };
  assert.equal(isOneTime(d), true);
  const again = scheduleAgain(d, NOW);
  assert.deepEqual(again.triggers, [{ kind: 'once', at: '2026-10-07T15:00' }], 'firedAt and missed are gone');
  assert.equal(again.enabled, true);
  assert.equal(onceProblem(again, NOW), null);
  assert.equal(onceProblem({ ...d, enabled: true, triggers: [{ kind: 'once', at: '2026-10-07T14:00' }] }, NOW), 'That time has passed: choose a later one');
  assert.equal(onceProblem({ ...d, enabled: false }, NOW), null, 'off, it can keep an old time');
  assert.equal(onceProblem({ ...d, enabled: true, triggers: [{ kind: 'time', at: { kind: 'time', at: '07:00' } }] }, NOW), null, 'not one-time');
  const s = scheduleDraft(NOW);
  assert.deepEqual(s.triggers, [{ kind: 'once', at: '2026-10-07T15:05' }]);
  assert.deepEqual(newTrigger('once', ctxOf({ devices, sources, modes: [], overlays: [], automations: [], now: NOW })), { kind: 'once', at: '2026-10-07T15:05' });
});

test('the home’s clock: localNow from the hub, else from its time and timezone, never the phone’s', () => {
  assert.equal(localNowOf({ localNow: '2026-10-07T21:05' }), '2026-10-07T21:05');
  assert.equal(localNowOf({ home: { now: Date.UTC(2026, 9, 7, 12, 0), timezone: 'Australia/Perth' } }), '2026-10-07T20:00');
  assert.equal(localNowOf({ home: { now: Date.UTC(2026, 9, 7, 23, 30), timezone: 'UTC' } }), '2026-10-07T23:30');
});

test('a one-time schedule’s name and line', () => {
  const d: Draft = { name: '', enabled: true, mode: 'single', triggers: [{ kind: 'once', at: '2026-10-07T15:00' }], conditions: [], actions: [{ kind: 'set', targets: { ac: { on: false } } }] };
  assert.equal(scheduleName(d, names), 'Ac off at 15:00');
  assert.equal(scheduleName({ ...d, triggers: [{ kind: 'once', at: '2026-10-08T07:00' }], actions: [{ kind: 'notify', message: 'Bins out' }] }, names), 'Bins out tomorrow at 07:00');
  assert.equal(scheduleName({ ...d, triggers: [{ kind: 'once', at: '2026-10-15T09:00' }] }, names), 'Ac off on Thu 15 Oct at 09:00');
  const v = (x: Partial<AutomationView>): AutomationView => ({ id: 'a', name: 'n', enabled: true, mode: 'single', conditions: [], actions: [], lastRun: null, running: 0, triggers: [{ kind: 'once', at: '2026-10-07T15:30' }], oneTime: true, ...x });
  assert.deepEqual(scheduleLine(v({ nextAt: 1, nextLabel: 'today at 15:30' }), NOW), { text: 'Today at 15:30 · in 1 h 25 min', tone: 'amber' });
  assert.deepEqual(scheduleLine(v({ enabled: false }), NOW), { text: 'Off · today at 15:30', tone: 'stone' });
  assert.deepEqual(scheduleLine(v({ done: true, triggers: [{ kind: 'once', at: '2026-10-07T09:00', firedAt: 5 }] }), NOW), { text: 'Ran today at 09:00', tone: 'green' });
  assert.equal(scheduleLine(v({ done: true, triggers: [{ kind: 'once', at: '2026-10-06T09:00', firedAt: 5, missed: true }] }), NOW).tone, 'red');
});

test('the list in sections: scheduled soonest first, automations, done', () => {
  const v = (id: string, x: Partial<AutomationView>): AutomationView => ({ id, name: id, enabled: true, mode: 'single', conditions: [], actions: [], lastRun: null, running: 0, triggers: [{ kind: 'time', at: { kind: 'time', at: '07:00' } }], ...x });
  const once = (at: string, firedAt?: number) => [{ kind: 'once' as const, at, ...(firedAt ? { firedAt } : {}) }];
  const l = [
    v('daily', {}),
    v('later', { oneTime: true, done: false, nextAt: 2000, triggers: once('2026-10-08T07:00') }),
    v('soon', { oneTime: true, done: false, nextAt: 1000, triggers: once('2026-10-07T15:00') }),
    v('off', { oneTime: true, done: false, enabled: false, nextAt: null, triggers: once('2026-10-07T14:30') }),
    v('old', { oneTime: true, done: true, enabled: false, triggers: once('2026-10-06T09:00', 10) }),
    v('older', { oneTime: true, done: true, enabled: false, triggers: once('2026-10-05T09:00', 5) }),
    v('legacy', { triggers: once('2026-10-09T09:00') }),
  ];
  const s = sectionsOf(l);
  assert.deepEqual(s.scheduled.map(a => a.id), ['soon', 'later', 'legacy', 'off']);
  assert.deepEqual(s.regular.map(a => a.id), ['daily']);
  assert.deepEqual(s.done.map(a => a.id), ['old', 'older']);
});

// What the assistant makes, with every kind of part and mixed fields: it has to open, read right and save as it was.
const AI: Draft = {
  name: 'Evening, the long way', description: 'Made by Kova', enabled: true, mode: 'restart',
  triggers: [
    { kind: 'device', device: 'tv', to: { on: true, input: 'hdmi2' }, from: { on: false }, forSec: 120 },
    { kind: 'numeric', device: 'ac', field: 'humidity', above: 70, forSec: 600 },
    { kind: 'numeric', device: 'meter', field: 'grid', below: -500 },
    { kind: 'event', device: 'door', event: 'person' },
    { kind: 'event', device: 'box', event: 'screen-asleep' },
    { kind: 'time', at: { kind: 'sun', event: 'sunset', offsetMin: -15 }, days: [1, 2, 3, 4, 5] },
    { kind: 'once', at: '2026-10-08T07:00' },
    { kind: 'every', minutes: 30 },
    { kind: 'presence', event: 'last-leaves' },
    { kind: 'mode', mode: 'evening' },
    { kind: 'overlay', overlay: 'movie', event: 'ends' },
    { kind: 'hub', event: 'start' },
  ],
  conditions: [
    { kind: 'any', conditions: [{ kind: 'presence', who: 'sam', home: true }, { kind: 'not', conditions: [{ kind: 'overlay', active: true }] }] },
    { kind: 'time', after: { kind: 'prayer', prayer: 'maghrib' }, before: { kind: 'time', at: '23:00' } },
    { kind: 'device', device: 'speaker', is: { playing: false, online: true } },
  ],
  actions: [
    { kind: 'set', targets: {
      'type:light': { on: true, bri: 35, k: 2400 },
      'room:kitchen': { on: false },
      speaker: { on: true, media: 'Station: Nina Simone', shuffle: true, vol: 20 },
      box: { on: true, media: 'Paddington 2' },
      bar: { input: 'tv', muted: false, sound: 'surround', night: true },
      ac: { on: true, hvac: 'cool', target: 23, fanSpeed: 'low', zoneSet: { 1: { on: true, open: 60 }, 2: { on: false } }, extras: { eco: true } },
      purifier: { on: true, mode: 'Sleep', display: false, childLock: true },
      vac: { activity: 'returning' },
    } },
    { kind: 'ramp', targets: { lamp: { bri: 80 } }, field: 'bri', from: 10, to: 80, overSec: 1800, stepSec: 60 },
    { kind: 'wait', until: { kind: 'all', conditions: [{ kind: 'numeric', device: 'ac', field: 'temp', below: 24 }, { kind: 'mode', modes: ['evening'] }] }, timeoutSec: 900, stopOnTimeout: true },
    { kind: 'if', conditions: [{ kind: 'device', device: 'bar', is: { muted: true } }], then: [{ kind: 'notify', title: 'Sound', message: 'The soundbar is muted', people: ['sam'] }], else: [{ kind: 'repeat', times: 2, actions: [{ kind: 'set', targets: { speaker: { skip: 1 } } }, { kind: 'delay', seconds: 90 }] }] },
    { kind: 'overlay', overlay: 'movie', op: 'start' },
    { kind: 'run', automation: 'night' },
    { kind: 'stop' },
  ],
};

test('an assistant-made automation opens, reads right and saves unchanged', () => {
  const d = draftOf({ id: 'x', ...AI });
  assert.deepEqual(bodyOf(d), AI, 'round trip is lossless');
  // Every field of every target has a control: nothing is left as an unrepresentable "as set".
  const set = d.actions[0] as Extract<Draft['actions'][number], { kind: 'set' }>;
  for (const [id, cmd] of Object.entries(set.targets)) {
    const shown = fieldsFor(targetInfo(id, devices, rooms), cmd).filter(f => f.key in cmd).map(f => f.key);
    assert.deepEqual(shown.sort(), Object.keys(cmd).sort(), id);
    for (const f of fieldsFor(targetInfo(id, devices, rooms), cmd)) assert.ok(['bool', 'number', 'choice', 'color', 'media', 'zones', 'extras'].includes(f.kind));
    assert.doesNotMatch(commandWords(cmd), /as set|nothing yet|\{/, id);
  }
  const s = draftSummary(d, names);
  assert.match(s.when, /^Tv turns on HDMI 2 from off for 2 min, or Ac humidity goes above 70 for 10 min, or Meter grid power goes below -500/);
  assert.match(s.when, /Door sees a person, or Box screen goes to sleep, or at 15 min before sunset on weekdays, or once, tomorrow at 07:00/);
  assert.match(s.onlyIf, /^Either Sam is home or not \(an overlay is on\), and between Maghrib and 23:00, and Speaker is online and not playing$/);
  assert.match(s.then, /^Set All lights: on, 35%, 2400K; set Everything in Kitchen: off; set Speaker: on, play Station: Nina Simone, shuffled, volume 20%/);
  assert.match(s.then, /Ac: on, cool, 23°, fan low, Living on at 60%, zone 2 off, eco on/);
  assert.match(s.then, /ramp Lamp brightness from 10 to 80 over 30 min, then wait until Ac temperature is below 24 and in Evening \(at most 15 min, else stop\)/);
  assert.match(s.then, /if Bar is muted, notify Sam: “Sound: The soundbar is muted”; otherwise 2 times: set Speaker: next song, then wait 1 min 30 s/);
  assert.match(s.then, /start Movie, then run Goodnight, then stop$/);
  assert.match(s.sentence, /^When .*, only if .*: set All lights/);
});

test('the assistant’s { set: {...} } spelling is flattened as the hub does', () => {
  assert.deepEqual(flatCommand({ on: true, set: { childLock: true } } as never), { on: true, childLock: true });
  const d = draftOf({ name: 'x', triggers: [], conditions: [], actions: [{ kind: 'if', conditions: [], then: [{ kind: 'set', targets: { purifier: { set: { display: false } } as never } }] }] });
  assert.deepEqual(d.actions[0], { kind: 'if', conditions: [], then: [{ kind: 'set', targets: { purifier: { display: false } } }] });
});

test('steps: changing kind keeps what carries over; duplicate puts a copy after', () => {
  const c = ctxOf({ devices, sources, modes: [], overlays: [], automations: [], now: NOW });
  assert.equal(c.rampDevice, 'lamp');
  assert.deepEqual(newAction('ramp', c), { kind: 'ramp', targets: { lamp: { bri: 100 } }, field: 'bri', to: 100, overSec: 1800, stepSec: 60 });
  const r = changeActionKind({ kind: 'set', targets: { lamp: { on: true }, 'type:light': { on: true } } }, newAction('ramp', c));
  assert.deepEqual(Object.keys((r as { targets: object }).targets), ['lamp', 'type:light']);
  assert.deepEqual(changeActionKind({ kind: 'if', conditions: [], then: [{ kind: 'stop' }] }, newAction('repeat', c)), { kind: 'repeat', times: 2, actions: [{ kind: 'stop' }] });
  const d = duplicateAt({ l: [{ a: 1 }, { b: 2 }] }, ['l', 0]);
  assert.deepEqual(d.l, [{ a: 1 }, { a: 1 }, { b: 2 }]);
  assert.notEqual(d.l[0], d.l[1], 'a copy, not the same object');
});

test('words for parts the summary folds to', () => {
  assert.equal(triggerText({ kind: 'once', at: '2026-10-07T13:00', firedAt: 1 }, names), 'once, today at 13:00 (done)');
  assert.equal(triggerText({ kind: 'presence', event: 'arrives', person: 'sam' }, names), 'Sam comes home');
  assert.equal(conditionText({ kind: 'mode', modes: [] }, names), 'in a mode (pick one)');
  assert.equal(draftSummary({ name: '', enabled: true, mode: 'single', triggers: [], conditions: [], actions: [] }, names).sentence, 'Add what starts it, then what it does.');
});

// Sensors and cameras: they only report. Room triggers and conditions are what they tell.
const sensorHome = [
  dev('lamp', 'light', 'hall', ['onoff', 'brightness'], { on: false, bri: 40 }),
  dev('pir', 'sensor', 'hall', [], { motion: false, lux: 30, battery: 80 }, { kind: 'sensor', name: 'Hall motion' }),
  dev('contact', 'sensor', 'front', [], { open: false }, { kind: 'sensor', name: 'Front door sensor' }),
  dev('bell', 'camera', 'front', ['events'], {}, { kind: 'camera', name: 'Doorbell', integration: 'Google Nest Doorbell' }),
  dev('yardcam', 'camera', 'yard', ['events'], {}, { kind: 'camera', name: 'Yard camera', integration: 'Google Nest Camera' }),
  dev('meter', 'plug', 'hall', ['power', 'energy'], { power: 120 }, { kind: 'sensor', name: 'Meter' }),
  dev('air', 'sensor', 'bedroom', [], { pm25: 12, temp: 21 }, { kind: 'sensor', name: 'Air' }),
];
const sensorRooms = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'hall', name: 'Hall', icon: 'door_sliding' }, { id: 'front', name: 'Front door', icon: 'door_front' }, { id: 'yard', name: 'Yard', icon: 'yard' }];
const sNames: Names = { ...names, devices: sensorHome, rooms: sensorRooms };

test('room triggers: the events the room’s cameras and sensors can tell, in words', () => {
  assert.deepEqual(roomEventsFor('hall', sensorHome).map(o => o.v), ['motion'], 'a motion sensor: motion');
  assert.deepEqual(roomEventsFor('front', sensorHome).map(o => o.v), ['motion', 'person', 'ring', 'opened', 'closed', 'package', 'vehicle', 'animal', 'sound'], 'a doorbell rings; a door sensor opens and closes');
  assert.ok(!roomEventsFor('yard', sensorHome).some(o => o.v === 'ring'), 'only doorbells ring');
  assert.equal(roomEventsFor('lounge', sensorHome).length, 9, 'nothing there yet: everything');
  assert.equal(roomEventsFor('hall', sensorHome, 'opened').pop()?.v, 'opened', 'the current one is kept');
  assert.equal(triggerText({ kind: 'room', room: 'hall', event: 'motion' }, sNames), 'there’s motion in Hall');
  assert.equal(triggerText({ kind: 'room', room: 'front', event: 'opened' }, sNames), 'a door or window opens in Front door');
  assert.equal(draftSummary({ name: 'x', enabled: true, mode: 'single', triggers: [{ kind: 'room', room: 'front', event: 'package' }], conditions: [], actions: [] }, sNames).when, 'A package is seen in Front door');
  assert.deepEqual(roomNote('front', sensorHome), { text: 'From Front door sensor and Doorbell.', warn: false });
  assert.equal(roomNote('lounge', sensorHome)?.warn, true, 'nothing reports there: said so');
  assert.equal(roomProblem('', sensorRooms), 'Choose a room.');
  assert.equal(roomProblem('attic', sensorRooms), 'That room is gone: choose another.');
  assert.equal(roomProblem('hall', sensorRooms), undefined);
  assert.equal(roomOptions(sensorRooms, 'attic').pop()?.label, 'attic (missing)');
  // New ones start on the first room with a camera or sensor; a device event becomes its room's.
  const ctx = ctxOf({ devices: sensorHome, sources: [], modes: [], overlays: [], automations: [], rooms: sensorRooms });
  assert.equal(ctx.room, 'hall');
  assert.deepEqual(changeKind({ kind: 'event', device: 'bell', event: 'person' }, newTrigger('room', ctx), { devices: sensorHome, rooms: sensorRooms }), { kind: 'room', room: 'front', event: 'person' });
});

test('room conditions: some activity lately, or all still for a while', () => {
  const ctx = ctxOf({ devices: sensorHome, sources: [], modes: [], overlays: [], automations: [], rooms: sensorRooms });
  assert.deepEqual(newCondition('room', ctx), { kind: 'room', room: 'hall', active: true, withinMin: 10 });
  assert.equal(conditionText({ kind: 'room', room: 'hall', active: true, withinMin: 10 }, sNames), 'there’s been activity in Hall in the last 10 min');
  assert.equal(conditionText({ kind: 'room', room: 'hall', active: false, withinMin: 90 }, sNames), 'no activity in Hall for 1 h 30 min');
  assert.equal(conditionText({ kind: 'room', room: 'hall', active: false }, sNames), 'no activity in Hall for 10 min', 'the hub’s default');
  assert.equal(withinProblem(0), 'Within 1 to 1440 minutes.');
  assert.equal(withinProblem(30), undefined);
});

test('sensors and cameras only report: never set, never in a group, their states and readings offered', () => {
  assert.deepEqual(sensorHome.filter(canSet).map(d => (d as { id: string }).id), ['lamp'], 'a power meter is a sensor by the hub’s kind');
  assert.deepEqual(pseudoTargets(sensorHome, sensorRooms).map(o => o.v), ['type:light', 'room:hall']);
  assert.deepEqual(targetInfo('room:hall', sensorHome, sensorRooms).devices.map(d => d.id), ['lamp'], 'a room group never reaches its sensors');
  assert.deepEqual(targetInfo('type:plug', sensorHome, sensorRooms).devices, [], 'nor does a type group');
  assert.deepEqual(matchFields(sensorHome[1]).map(f => f.key), ['motion', 'online'], 'no power to match on a sensor');
  assert.deepEqual(matchFields(sensorHome[2]).map(f => f.key), ['open', 'online']);
  assert.ok(!matchFields(sensorHome[0]).some(f => f.key === 'motion'));
  assert.equal(conditionText({ kind: 'device', device: 'pir', is: { motion: false } }, sNames), 'Hall motion is clear of motion');
  assert.equal(triggerText({ kind: 'device', device: 'contact', to: { open: true }, forSec: 300 }, sNames), 'Front door sensor turns open for 5 min');
  assert.deepEqual(readingsFor(sensorHome[6]).map(o => o.v), ['temp', 'pm25']);
  assert.equal(FIELD_UNIT.pm25, 'µg/m³');
  assert.equal(triggerText({ kind: 'numeric', device: 'air', field: 'pm25', above: 25 }, sNames), 'Air PM2.5 goes above 25');
  assert.deepEqual(eventsFor(sensorHome[1]).map(o => o.v), ['person', 'motion']);
});
