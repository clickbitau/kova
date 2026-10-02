import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapOpen, visibleZones } from '../src/logic/zones.ts';

test('zones: the ones in use, named or "Zone n"; all on request; openings in steps of 5', () => {
  const zones = [{ n: 1, on: true, open: 35 }, { n: 2, on: false, open: 0 }, { n: 3, on: false, open: 0 }, { n: 4, on: false, open: 20 }];
  assert.deepEqual(visibleZones(zones, { 3: 'Study' }).map(z => [z.n, z.name]), [[1, 'Zone 1'], [3, 'Study'], [4, 'Zone 4']]);
  assert.equal(visibleZones(zones, {}, true).length, 4);
  assert.deepEqual(visibleZones(null), []);
  assert.equal(snapOpen(37), 35);
  assert.equal(snapOpen(140), 100);
});
