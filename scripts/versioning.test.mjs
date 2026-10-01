// One test per rule of docs/VERSIONING.md: node --test scripts/versioning.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appProblems, buildNumberProblems, lastStoreFingerprint, nextTrain, nextUpdate, storeBuildProblems } from './lib/versioning.mjs';

const P = 'kova-mobile';
const app = (store, runtime) => ({ expo: { version: store, runtimeVersion: runtime } });
const vf = (o = {}) => ({ train: 'kova-mobile-0', store: '0.1.0', version: '0.1.0', history: [{ version: '0.1.0', title: 'First' }], ...o });

test('a good app passes', () => {
  assert.deepEqual(appProblems({ version: vf(), appJson: app('0.1.0', 'kova-mobile-0'), prefix: P }), []);
  const v = vf({ version: '0.1.2', history: [{ version: '0.1.2', title: 'b' }, { version: '0.1.1', title: 'a' }, { version: '0.1.0', title: 'First' }] });
  assert.deepEqual(appProblems({ version: v, appJson: app('0.1.0', 'kova-mobile-0'), prefix: P }), []);
});

test('rule 1: a store binary is X.Y.0, and app.json agrees about version and train', () => {
  assert.match(appProblems({ version: vf({ store: '0.1.1', version: '0.1.1', history: [{ version: '0.1.1', title: 'x' }] }), appJson: app('0.1.1', 'kova-mobile-0'), prefix: P }).join(), /not X\.Y\.0/);
  assert.match(appProblems({ version: vf(), appJson: app('0.2.0', 'kova-mobile-0'), prefix: P }).join(), /app\.json version 0\.2\.0/);
  assert.match(appProblems({ version: vf(), appJson: app('0.1.0', 'kova-mobile-1'), prefix: P }).join(), /runtimeVersion kova-mobile-1/);
});

test('rule 2: over the air only PATCH moves', () => {
  const v = vf({ version: '0.2.1', history: [{ version: '0.2.1', title: 'x' }, { version: '0.1.0', title: 'First' }] });
  assert.match(appProblems({ version: v, appJson: app('0.1.0', 'kova-mobile-0'), prefix: P }).join(), /only PATCH moves/);
  assert.equal(nextUpdate(vf({ version: '0.1.4' })), '0.1.5');
});

test('rule 3: no native change, no store build', () => {
  const record = { trains: { 'kova-mobile-0': [{ build: 1, platform: 'ios', fingerprint: 'aaa' }], 'kova-mobile-1': [] }, approved: { mobile: [] } };
  const v = vf({ train: 'kova-mobile-1', store: '0.2.0', version: '0.2.0' });
  assert.equal(lastStoreFingerprint(record, 'kova-mobile-1', P).build, 1);
  assert.match(storeBuildProblems({ version: v, record, prefix: P, fingerprint: 'aaa', lock: { runtimeVersion: 'kova-mobile-1', fingerprint: 'aaa' } }).join(), /no native change, no store build/);
  assert.deepEqual(storeBuildProblems({ version: v, record, prefix: P, fingerprint: 'bbb', lock: { runtimeVersion: 'kova-mobile-1', fingerprint: 'bbb' } }), []);
  // A native change after the train was locked needs the next train first.
  assert.match(storeBuildProblems({ version: v, record, prefix: P, fingerprint: 'ccc', lock: { runtimeVersion: 'kova-mobile-1', fingerprint: 'bbb' } }).join(), /start a new train/);
  // A rebuild on the same train (nothing shipped on an earlier one) passes.
  assert.deepEqual(storeBuildProblems({ version: vf(), record: { trains: { 'kova-mobile-0': [{ build: 1, platform: 'ios', fingerprint: 'aaa' }] }, approved: {} }, prefix: P, fingerprint: 'aaa', lock: { runtimeVersion: 'kova-mobile-0', fingerprint: 'aaa' } }), []);
});

test('rule 4: never reuse an approved version; versions only go up', () => {
  const record = { trains: { 'kova-mobile-1': [] }, approved: { mobile: [{ version: '1.0.0', build: 7 }] } };
  const v = vf({ train: 'kova-mobile-1', store: '1.0.0', version: '1.0.0' });
  assert.match(storeBuildProblems({ version: v, record, prefix: P, fingerprint: 'x', lock: { runtimeVersion: 'kova-mobile-1', fingerprint: 'x' } }).join(), /never reuse an approved version/);
  assert.match(appProblems({ version: vf(), appJson: app('0.1.0', 'kova-mobile-0'), prefix: P, approved: [{ version: '1.0.0' }] }).join(), /below approved 1\.0\.0/);
  const down = vf({ version: '0.1.1', history: [{ version: '0.1.1', title: 'b' }, { version: '0.1.2', title: 'a' }] });
  assert.match(appProblems({ version: down, appJson: app('0.1.0', 'kova-mobile-0'), prefix: P }).join(), /only go up/);
});

test('rule 5: a new App Store line is a new MAJOR at X.0.0; a native build is MINOR + 1', () => {
  assert.deepEqual(nextTrain(vf(), P), { train: 'kova-mobile-1', store: '0.2.0' });
  assert.deepEqual(nextTrain(vf({ train: 'kova-mobile-3', store: '0.4.0' }), P, { major: true }), { train: 'kova-mobile-4', store: '1.0.0' });
});

test('rule 7: build numbers only go up, per platform', () => {
  const ok = { trains: { 'kova-mobile-0': [{ build: 1, platform: 'ios' }, { build: 1, platform: 'android' }], 'kova-mobile-1': [{ build: 2, platform: 'ios' }] } };
  assert.deepEqual(buildNumberProblems(ok, P), []);
  const bad = { trains: { 'kova-mobile-0': [{ build: 3, platform: 'ios' }], 'kova-mobile-1': [{ build: 2, platform: 'ios' }] } };
  assert.match(buildNumberProblems(bad, P).join(), /not above 3/);
});
