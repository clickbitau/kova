import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneSettings, phoneSettingsLine, regionOf } from '../src/logic/setup.ts';
import { shortDate } from '../src/logic/day.ts';
import { askSuggestions } from '../src/logic/ask.ts';
import { energySource, hasSolarPower } from '../src/logic/energy.ts';
import { deg, fromDisplay, setFahrenheit, stepTarget, toDisplay, unitLabel } from '../src/logic/climate.ts';

test('first run: the phone’s region decides °F, and the settings are a plain body', () => {
  assert.equal(regionOf('en-US'), 'US');
  assert.equal(regionOf('en-AU'), 'AU');
  assert.equal(regionOf('fr'), 'FR');
  const p = phoneSettings();
  assert.equal(typeof p.locale, 'string');
  assert.equal(typeof p.hour12, 'boolean');
  assert.equal(typeof p.fahrenheit, 'boolean');
  assert.match(phoneSettingsLine({ locale: 'en-US', hour12: true, fahrenheit: true, timezone: 'America/New_York' }), /12-hour · °F · America\/New York$/);
});

test('dates: short, in the home’s language, from its date; the hub’s words when there’s no date', () => {
  assert.equal(shortDate({ date: '2026-09-30', dateLabel: 'Wednesday 30 Sept', locale: 'en-GB' }), 'Wed 30 Sept');
  assert.match(shortDate({ date: '2026-09-30', dateLabel: 'x', locale: 'en-US' }), /^Wed, Sep 30$/);
  assert.match(shortDate({ date: '2026-09-30', dateLabel: 'x', locale: 'de-DE' }), /^Mi\.?,? 30\. Sept?\.?$/);
  assert.equal(shortDate({ date: '', dateLabel: 'Wednesday 30 Sept' }), 'Wednesday 30 Sept');
});

test('ask: suggestions come from the home’s rooms and lights, with plain ones when it has none', () => {
  const dev = (id: string, name: string, room: string, type: string, on = false, caps: string[] = []) => ({ id, name, room, type, capabilities: caps, state: { on } });
  const s = {
    rooms: [{ id: 'den', name: 'Den', icon: 'x' }, { id: 'hall', name: 'Hall', icon: 'x' }],
    devices: [dev('a', 'Hall light', 'hall', 'light', true), dev('b', 'Reading lamp', 'hall', 'dimmer', false, ['brightness'])],
  } as never;
  assert.deepEqual(askSuggestions(s), ['What’s happening tonight?', 'Who’s home?', 'Turn off the hall', 'Reading lamp to 30%', 'Why is the hall light on?', 'I’m leaving']);
  assert.deepEqual(askSuggestions({ rooms: [], devices: [] }), ['What’s happening tonight?', 'Who’s home?', 'What’s on?', 'I’m leaving']);
});

test('energy: the source is whatever integration owns the device that reports energy', () => {
  const s = {
    devices: [{ id: 'p', capabilities: ['power'], integration: 'tapo' }, { id: 'inv', capabilities: ['power', 'energy'], integration: 'sungrow' }],
    integrations: [{ id: 'tapo', name: 'Tapo' }, { id: 'sungrow', name: 'Sungrow' }],
    energy: null,
  } as never;
  assert.equal(energySource(s), 'Sungrow');
  assert.equal(hasSolarPower(s), true);
  assert.equal(energySource({ devices: [], integrations: [] }), null);
  assert.equal(hasSolarPower({ devices: [], integrations: [], energy: null }), false);
});

test('temperatures: kept in °C, shown and stepped in °F where the home reads °F', () => {
  setFahrenheit(false);
  assert.equal(deg(23.5), '23.5°');
  assert.equal(unitLabel(), '°C');
  assert.equal(stepTarget(24, 1), 25);
  setFahrenheit(true);
  try {
    assert.equal(deg(22), '72°');
    assert.equal(unitLabel(), '°F');
    assert.equal(toDisplay(0), 32);
    assert.equal(fromDisplay(72), 22);
    assert.equal(fromDisplay(73), 23);
    // Each tap is a whole °F, and reads back as that.
    let c = 22;
    for (let i = 0; i < 5; i++) { const n = stepTarget(c, 1); assert.equal(toDisplay(n), toDisplay(c) + 1); c = n; }
    assert.equal(stepTarget(32, 1), 32, 'kept in the dial’s range');
  } finally { setFahrenheit(false); }
});
