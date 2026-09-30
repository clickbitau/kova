import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeState, homeStateKey, widgetModel, widgetSnapshot } from '../src/logic/extensions.ts';
import type { Snapshot } from '../src/api/types.ts';

const snap = {
  home: { name: 'The Ahmeds', timezone: 'Australia/Perth', now: 1000, nowHour: 19, date: '2026-09-30', dateLabel: '', clock: '19:00' },
  rooms: [],
  favourites: ['lamp', 'speaker'],
  speakerGroups: [],
  people: [],
  devices: [
    { id: 'lamp', name: 'Lamp', room: 'lounge', type: 'dimmer', capabilities: ['onoff', 'brightness'], adapter: 'x', integration: 'X', address: 'a', state: { on: true, bri: 78 } },
    { id: 'ceiling', name: 'Ceiling', room: 'lounge', type: 'light', capabilities: ['onoff'], adapter: 'x', integration: 'X', address: 'b', state: { on: true } },
    { id: 'speaker', name: 'Speaker', room: 'kitchen', type: 'media', capabilities: ['onoff', 'media', 'volume'], adapter: 'x', integration: 'X', address: 'c', state: { on: true, media: 'Radio' } },
  ],
  modes: [
    { id: 'evening', name: 'Evening', color: '#f2b14c', icon: 'wb_twilight', startLabel: '', endLabel: '', nextId: 'wind', start: 18, groups: [], test: { days: [], text: '' } },
    { id: 'wind', name: 'Wind down', color: '#e08a6b', icon: 'bedtime', startLabel: '', endLabel: '', nextId: 'evening', start: 20, groups: [], test: { days: [], text: '' } },
  ],
  current: { modeId: 'evening', since: 500, until: 5000, untilLabel: '20:00', nextId: 'wind', overlay: null },
  day: { bands: [] },
  upcoming: [
    { id: 'moment:rain', t: '19:30', label: 'Rain sounds', what: 'Master speaker plays Rain', modeId: 'evening', skipped: true },
    { id: 'mode:wind', t: '20:00', label: 'Wind down', what: 'Lamp to 5%', modeId: 'wind', skipped: false },
  ],
  overlays: [{ id: 'movie', name: 'Movie', icon: 'movie', endsLabel: 'Ends when the TV turns off' }],
  sources: [], findings: [], activity: [], integrations: [], weather: null, energy: null,
} as unknown as Snapshot;

test('the Live Activity: mode, lights on, the next change that isn’t skipped, and its plan id for Skip', () => {
  const h = homeState(snap);
  assert.deepEqual(h, {
    mode: 'Evening', modeColor: '#f2b14c', modeIcon: 'wb_twilight', lightsOn: 2, since: 500, nextAt: 5000,
    nextLabel: '20:00 Wind down', nextWhat: 'Lamp to 5%', nextId: 'mode:wind', overlay: null,
  });
  assert.equal(homeStateKey(h), homeStateKey({ ...h, since: 9 }), 'only a real change updates the activity');
  assert.notEqual(homeStateKey(h), homeStateKey({ ...h, lightsOn: 3 }));
});

test('widgets: the favourites with their state, and a small snapshot for iOS', () => {
  const m = widgetModel(snap);
  assert.equal(m.mode, 'Evening');
  assert.equal(m.lightsOn, 2);
  assert.deepEqual(m.favourites.map(f => [f.name, f.label, f.on]), [['Lamp', 'On · 78%', true], ['Speaker', 'Playing Radio', true]]);
  const w = widgetSnapshot(snap);
  assert.deepEqual(Object.keys(w).sort(), ['current', 'devices', 'favourites', 'home', 'modes', 'overlays', 'upcoming']);
  assert.deepEqual(w.devices[0].state, { on: true, bri: 78, media: undefined, paused: undefined, online: undefined });
});
