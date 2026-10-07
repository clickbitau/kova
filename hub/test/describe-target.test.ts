import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetLabel } from '../src/util/describe.ts';
import type { Device } from '../src/model/types.ts';

const dev = (type: Device['type'], name: string, capabilities: Device['capabilities'] = []): Device =>
  ({ id: name.toLowerCase(), name, room: 'lounge', type, capabilities, adapter: 'x', integration: 'x', address: 'x', state: {} });

test('target words say every setting, not only the first', () => {
  const ac = dev('climate', 'AC');
  assert.equal(targetLabel(ac, { on: true, hvac: 'cool', target: 23 }), 'AC cool 23°', 'simple ones are unchanged');
  assert.equal(targetLabel(ac, { on: true, hvac: 'cool', target: 23, fanSpeed: 'low', zoneSet: { 1: { on: false } }, extras: { eco: true } }), 'AC cool 23° · fan low, zone 1 off, eco on');
  const bar = dev('media', 'Soundbar', ['media', 'volume']);
  assert.equal(targetLabel(bar, { input: 'tv', muted: true }), 'Soundbar to TV, muted');
  assert.equal(targetLabel(bar, { on: true, media: 'Rain', vol: 30, input: 'hdmi1', night: true }), 'Soundbar · Rain 30% · to HDMI1, night mode on');
  const pur = dev('fan', 'Purifier');
  assert.equal(targetLabel(pur, { mode: 'Sleep', childLock: true, display: false }), 'Purifier on Sleep · child lock on, display off');
  assert.equal(targetLabel(dev('light', 'Lamp'), { on: true, bri: 40 }), 'Lamp 40%');
});
