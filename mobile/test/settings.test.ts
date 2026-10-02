import { test } from 'node:test';
import assert from 'node:assert/strict';
import { methodName, searchZones, timezones, zoneLabel } from '../src/logic/settings.ts';

test('settings: timezones listed and searched, the current one always there; prayer method names', () => {
  const zs = timezones('Mars/Olympus');
  assert.equal(zs[0], 'Mars/Olympus');
  assert.ok(zs.includes('Australia/Perth'));
  assert.deepEqual(searchZones(['America/New_York', 'Australia/Perth'], 'new york'), ['America/New_York']);
  assert.equal(searchZones(['A', 'B'], ' ').length, 2);
  assert.equal(zoneLabel('America/New_York'), 'America / New York');
  assert.equal(methodName('Karachi'), 'University of Islamic Sciences, Karachi');
  assert.equal(methodName(undefined), 'Muslim World League');
});
