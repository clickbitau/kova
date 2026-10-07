import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayBands } from '../src/logic/day.ts';
import { arcPath, clampTarget, TARGET_MAX, TARGET_MIN } from '../src/logic/climate.ts';

const modes = [
  { id: 'night', name: 'Night', color: '#8aaef0' }, { id: 'day', name: 'Day', color: '#dcd27e' }, { id: 'evening', name: 'Evening', color: '#f2b14c' },
] as never;

test('the day strip: bands as shares of 24 h, the current one marked, same-mode neighbours joined, slivers dropped', () => {
  const b = dayBands({ home: { nowHour: 13 } as never, modes, day: { bands: [
    { modeId: 'night', start: 0, end: 6 }, { modeId: 'day', start: 6, end: 12 }, { modeId: 'day', start: 12, end: 18 },
    { modeId: 'evening', start: 18, end: 18.005 }, { modeId: 'night', start: 18.005, end: 24 },
  ] } });
  assert.deepEqual(b.map(x => x.name), ['Night', 'Day', 'Night']);
  assert.equal(b[1].width, 0.5);
  assert.equal(b[1].current, true);
  assert.equal(b[0].current, false);
  assert.equal(b[1].from, '06:00');
  assert.ok(Math.abs(b.reduce((s, x) => s + x.width, 0) - (1 - 0.005 / 24)) < 1e-9);
});

test('a mode the snapshot doesn’t list still draws, in grey under its id', () => {
  const [b] = dayBands({ home: { nowHour: 1 } as never, modes, day: { bands: [{ modeId: 'party', start: 0, end: 24 }] } });
  assert.equal(b.name, 'party');
  assert.equal(b.color, '#a3a09a');
});

test('the air conditioner’s target stays in its range, in whole degrees', () => {
  assert.equal(clampTarget(TARGET_MIN - 3), TARGET_MIN);
  assert.equal(clampTarget(TARGET_MAX + 1), TARGET_MAX);
  assert.equal(clampTarget(22.6), 23);
});

test('the dial’s arc: empty at the lower left, over the top when more than two thirds full', () => {
  const start = arcPath(100, 100, 90, 0);
  assert.match(start, /^M 36\.36 163\.64 A 90 90 0 0 1 36\.36 163\.64$/);
  assert.match(arcPath(100, 100, 90, 0.5), / 0 0 1 100 10$/, 'half way is straight up, the short way round');
  assert.match(arcPath(100, 100, 90, 1), / 0 1 1 163\.64 163\.64$/, 'full is the lower right, the long way round');
  assert.equal(arcPath(100, 100, 90, 2), arcPath(100, 100, 90, 1));
});

test('every icon the app names is in its icon font (a missing one draws as a question mark)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ICON_CODES } = await import('../src/ui/icon-codes.ts');
  const root = join(import.meta.dirname, '../src');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
  const missing = new Set<string>();
  for (const f of files(root)) {
    if (f.endsWith('icon-codes.ts')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:\bicon|Icon name)=["']([a-z0-9_]+)["']|\bicon: '([a-z0-9_]+)'/g)) {
      const n = m[1] ?? m[2];
      if (!(n in ICON_CODES)) missing.add(`${n} (${f.slice(root.length + 1)})`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('the alerts the hub raises have their icons', async () => {
  const { ICON_CODES } = await import('../src/ui/icon-codes.ts');
  for (const n of ['power_off', 'battery_alert', 'sensor_door', 'cloud_off', 'wifi_off', 'extension_off', 'device_thermostat', 'thermostat', 'ac_unit', 'rainy', 'wb_sunny', 'filter_alt', 'air']) assert.ok(n in ICON_CODES, n);
});
