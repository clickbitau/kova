import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, describeUpdate, manifestInfo, manifestUrl, notesBetween, overrideNeeded, updateError } from '../src/logic/ota.ts';

test('the version and release notes come out of the hub’s update manifest', () => {
  const m = { extra: { expoClient: { version: '0.2.5', extra: { kovaHistory: [{ version: '0.2.5', title: 'New look' }, { version: '0.2.4', title: 'Fixes' }, { nope: 1 }] } } } };
  assert.deepEqual(manifestInfo(m as never), { version: '0.2.5', notes: [{ version: '0.2.5', title: 'New look' }, { version: '0.2.4', title: 'Fixes' }] });
  assert.deepEqual(manifestInfo({ extra: { expoClient: { version: '0.2.5' } } }), { version: '0.2.5', notes: undefined });
  assert.deepEqual(manifestInfo(null), { version: undefined, notes: undefined });
});

test('versions compare part by part, and the notes are the ones between what runs and what came', () => {
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0);
  assert.ok(compareVersions('0.2', '0.2.1') < 0);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  const h = [{ version: '0.2.6', title: 'c' }, { version: '0.2.5', title: 'b' }, { version: '0.2.4', title: 'a' }, { version: '0.2.3', title: 'running' }];
  assert.deepEqual(notesBetween(h, '0.2.3', '0.2.5').map(n => n.title), ['b', 'a']);
  assert.deepEqual(notesBetween(h, '0.2.3').map(n => n.title), ['c', 'b', 'a']);
  assert.deepEqual(notesBetween(h, '0.2.6'), []);
});

test('the update status in words', () => {
  assert.equal(describeUpdate({ state: 'ready', version: '0.2.5' }, '0.2.4').title, 'Kova 0.2.5 is ready');
  assert.equal(describeUpdate({ state: 'ready' }, '0.2.4').title, 'An update is ready');
  assert.equal(describeUpdate({ state: 'current' }, '0.2.4').tone, 'ok');
  assert.equal(describeUpdate({ state: 'checking' }, '0.2.4').tone, 'busy');
  assert.equal(describeUpdate({ state: 'unreachable', error: 'x' }, '0.2.4').sub, 'x');
  assert.equal(describeUpdate({ state: 'unsupported' }, '0.2.4').tone, 'muted');
});

test('why a check failed: the hub not answering, or nothing for this build', () => {
  assert.match(updateError(new Error('Network request failed')), /reach the hub/);
  assert.match(updateError(new Error('Failed to download manifest: 404')), /nothing newer/);
  assert.match(updateError(undefined), /reach the hub/);
  assert.match(updateError(new Error('weird')), /Try again/);
});

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
