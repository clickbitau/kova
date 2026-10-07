import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustSummary, clockAt, countdown, prayerSub, todayTimes, waqtOf, withAdjust } from '../src/logic/prayer.ts';
import { waqtCard } from '../src/logic/glance.ts';
import type { PrayerView } from '../src/api/types.ts';

const tz = 'UTC';
const at = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
const p = (over: Partial<PrayerView> = {}): PrayerView => ({
  on: true, method: 'MuslimWorldLeague', methods: [{ id: 'MuslimWorldLeague', label: 'Muslim World League' }], madhab: 'shafi', adjust: {}, adhan: {},
  times: { fajr: at(4, 50), sunrise: at(6, 10), dhuhr: at(12, 5), asr: at(15, 30), maghrib: at(18, 4), isha: at(19, 20) },
  current: { prayer: 'asr', at: at(15, 30) }, next: { prayer: 'maghrib', at: at(18, 4) }, ...over,
});

test('waqt: the prayer now, the next with a countdown, and its time on the home’s clock', () => {
  const w = waqtOf(p(), at(17, 22), tz)!;
  assert.deepEqual(w, { current: 'Asr', next: 'Maghrib', caption: 'Maghrib in 42 min', left: 'in 42 min', at: '18:04', soon: false });
  assert.equal(waqtOf(p(), at(17, 55), tz)!.soon, true);
  assert.equal(waqtOf(p(), at(18, 4), tz)!.caption, 'Maghrib now');
  assert.equal(waqtOf(p({ on: false }), at(17, 22), tz), null, 'nothing while off');
  assert.equal(waqtOf(p({ next: undefined }), at(17, 22), tz), null);
  assert.equal(waqtOf(undefined, 0, tz), null);
  // After Isha: tomorrow's Fajr, still counting.
  const late = waqtOf(p({ current: { prayer: 'isha', at: at(19, 20) }, next: { prayer: 'fajr', at: at(28, 50) } }), at(22, 0), tz)!;
  assert.equal(late.caption, 'Fajr in 6 h 50 min');
  assert.equal(late.at, '04:50');
  const card = waqtCard(w)!;
  assert.deepEqual([card.label, card.value, card.caption, card.sub], ['Prayer', 'Asr', 'Maghrib 18:04', 'In 42 min']);
  assert.equal(waqtCard(null), null);
});

test('countdowns round up, so it never says 0 min', () => {
  assert.equal(countdown(at(12, 0) + 30_000, at(12, 0)), 'in 1 min');
  assert.equal(countdown(at(13, 0), at(12, 0)), 'in 1 h');
  assert.equal(countdown(at(13, 5), at(12, 0)), 'in 1 h 5 min');
  assert.equal(countdown(at(12, 0), at(12, 1)), 'now');
  assert.equal(clockAt(at(9, 7), 'Asia/Kolkata'), '14:37');
});

test('today’s times in order with the next marked; adjustments kept to ±30 min', () => {
  const t = todayTimes(p(), tz);
  assert.deepEqual(t.map(x => `${x.label} ${x.at}${x.next ? ' next' : ''}`), ['Fajr 04:50', 'Sunrise 06:10', 'Dhuhr 12:05', 'Asr 15:30', 'Maghrib 18:04 next', 'Isha 19:20']);
  assert.deepEqual(todayTimes(p({ on: false }), tz), []);
  assert.deepEqual(withAdjust({ fajr: 2 }, 'isha', 45), { fajr: 2, isha: 30 });
  assert.deepEqual(withAdjust({ fajr: 2 }, 'fajr', 0), {});
  assert.equal(adjustSummary({ fajr: 5, isha: -10 }), 'Fajr 5 min later · Isha 10 min earlier');
  assert.equal(adjustSummary({}), 'None');
  assert.equal(prayerSub(p({ madhab: 'hanafi' })), 'Muslim World League · Hanafi Asr');
  assert.match(prayerSub(p({ on: false })), /^Off/);
});
