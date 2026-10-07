import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clashText, comfortStep, googleSteps, homekitState, manualCode, matterState, roomAcRow, seasonLine, type RoomAcView } from '../src/logic/voice.ts';

const rooms = [{ id: 'office', name: 'Office' }, { id: 'guest', name: 'Guest room' }, { id: 'den', name: 'Den' }];
const ac = (x: Partial<RoomAcView> = {}): RoomAcView => ({
  room: 'office', name: 'Office', label: 'Office AC', zones: [{ device: 'ac', n: 5, name: 'Office & Guest', shared: ['guest'] }],
  on: false, hvac: null, lastHvac: 'cool', target: 24, temp: 23.5, tempFrom: 'room', humidity: null, fanSpeed: 'auto', online: true, held: null, ...x,
});

test('voice: room AC rows say the zone, who shares it and what it’s doing', () => {
  assert.deepEqual(roomAcRow(ac(), rooms), { title: 'Office AC', sub: 'Office & Guest zone · shared with Guest room', now: 'Off · 23.5° in the room', on: false });
  assert.equal(roomAcRow(ac({ on: true, hvac: 'heat', target: 21 }), rooms).now, 'On, heating to 21°');
  assert.equal(roomAcRow(ac({ on: true, hvac: 'cool', target: 22, held: { target: 22 } }), rooms).now, 'On, cooling to 22° · your setting');
  assert.equal(roomAcRow(ac({ online: false }), rooms).now, 'Not answering');
  assert.equal(roomAcRow(ac({ zones: [{ device: 'ac', n: 2, name: 'Den zone', shared: [] }] }), rooms).sub, 'Den zone');
});

test('voice: the Google Home steps use the home’s own room AC, the clash note names the maker', () => {
  const steps = googleSteps({ rooms: [ac({ label: 'Den AC', name: 'Den' })] });
  assert.equal(steps.length, 3);
  assert.match(steps[1], /“Den AC” goes in the Den/);
  assert.match(googleSteps({ rooms: [] })[1], /its room/);
  assert.match(clashText(['Hisense ConnectLife']).text, /If Hisense ConnectLife is also linked/);
  assert.match(clashText([]).text, /air conditioner’s own app/);
  assert.match(clashText([]).fix, /Kova doesn’t change anything there/);
});

test('voice: season, bridges, codes and comfort steps', () => {
  assert.equal(seasonLine({ season: 'spring', seasonLabel: 'Spring' }).title, 'Spring at your home');
  assert.equal(seasonLine({ season: null, seasonLabel: null }).title, 'No season yet');
  assert.equal(matterState(null).text, 'Checking…');
  assert.equal(matterState({ matter: { enabled: false }, homekit: { enabled: false } }).text, 'Off: turn it on in Integrations');
  assert.equal(matterState({ matter: { enabled: true, commissioned: false }, homekit: { enabled: false } }).text, 'Not paired yet');
  assert.deepEqual(matterState({ matter: { enabled: true, commissioned: true, fabrics: [{ label: '', vendor: 'Google' }, { label: '', vendor: 'Amazon' }] }, homekit: { enabled: false } }), { text: 'Paired with Google and Amazon', paired: true });
  assert.equal(homekitState({ matter: { enabled: false }, homekit: { enabled: true, paired: true } }).text, 'Paired with the Home app');
  assert.equal(manualCode('34970112332'), '3497-011-2332');
  const s = { coolTo: 24, heatTo: 21, fromElsewhere: 'off' as const };
  assert.deepEqual(comfortStep(s, 'coolTo', 0.5), { body: { coolTo: 24.5 } });
  assert.deepEqual(comfortStep(s, 'heatTo', -0.5), { body: { heatTo: 20.5 } });
  assert.equal(comfortStep({ ...s, coolTo: 30 }, 'coolTo', 0.5), null, 'at the top already');
  assert.deepEqual(comfortStep({ ...s, coolTo: 21, heatTo: 21 }, 'coolTo', -0.5), { error: 'Cool to can’t be below heat to' });
});
