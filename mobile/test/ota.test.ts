import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestUrl, overrideNeeded } from '../src/logic/ota.ts';

test('updates come from the connected hub', () => {
  assert.equal(manifestUrl('http://10.0.0.5:8140/'), 'http://10.0.0.5:8140/api/app/manifest');
  assert.equal(manifestUrl(' https://kova.lan '), 'https://kova.lan/api/app/manifest');
});

test('the updater’s address is written only when the hub changes', () => {
  const url = manifestUrl('http://10.0.0.5:8140');
  assert.equal(overrideNeeded(url, null), true);
  assert.equal(overrideNeeded(url, url), false);
  assert.equal(overrideNeeded(manifestUrl('http://10.0.0.6:8140'), url), true);
  assert.equal(overrideNeeded('', url), false);
});
