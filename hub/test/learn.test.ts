import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub, DATE } from './helpers.ts';
import { addDays } from '../src/util/time.ts';
import type { Cause } from '../src/model/types.ts';

const you: Cause = { kind: 'user', label: 'You' };
const wall: Cause = { kind: 'device', label: 'At the switch' };

/** Live `n` days after today, calling `each` on every day once the day's modes up to 19:00 have run on time. */
async function days(n: number, advance: (h: number, d?: string) => Promise<void>, each: (date: string) => Promise<void>) {
  for (let k = 1; k <= n; k++) {
    const date = addDays(DATE, k);
    for (const h of [0, 3, 6, 9, 12, 15, 18, 19]) await advance(h, date);
    await each(date);
  }
}

test('learns that you always turn the lamp up after Wind down starts', async () => {
  const { hub, advance, dev } = await testHub(12);
  await days(4, advance, async date => {
    await advance(20.05, date);          // Wind down: lamp to 5%
    await advance(20.2, date);
    await hub.reg.command('lamp', { on: true, bri: 40 }, you);
  });
  const s = hub.checker.learner.suggestions().find(x => x.kind === 'mode-target');
  assert.ok(s, 'a mode suggestion');
  assert.equal(s.id, 'learn:mode:wind:lamp:bri40');
  assert.deepEqual(s.target, { on: true, bri: 40 });
  assert.equal(s.days.length, 4);
  assert.match(s.finding.body, /within half an hour of Wind down starting, instead of/);
  assert.ok(hub.checker.findings().some(f => f.id === s.id));

  const undo = hub.checker.fix(s.id);
  assert.deepEqual(hub.config.get().modes.find(m => m.id === 'wind')!.targets.lamp, { on: true, bri: 40 });
  assert.ok(!hub.checker.findings().some(f => f.id === s.id), 'gone once applied');
  undo();
  assert.equal(hub.config.get().modes.find(m => m.id === 'wind')!.targets.lamp.bri, 5);
  assert.equal(dev('lamp').bri, 40);
  await hub.stop();
});

test('learns a time-of-day habit and offers a moment', async () => {
  const { hub, advance } = await testHub(12);
  const times = [22.2, 22.3, 22.1, 22.25, 22.4];
  await days(5, advance, async date => {
    const t = times.shift()!;
    await advance(20.02, date);          // Wind down starts on time
    await advance(21, date);
    await hub.reg.command('office_light', { on: true }, you);
    await advance(t, date);
    await hub.reg.command('office_light', { on: false }, wall);
  });
  const s = hub.checker.learner.suggestions().find(x => x.kind === 'moment' && x.device === 'office_light' && x.target.on === false);
  assert.ok(s, 'a moment suggestion');
  assert.equal(s.at, '22:15');
  assert.equal(s.days.length, 5);
  assert.match(s.finding.title, /turn off the office ceiling around 22:15/);
  // Turning it on at 21:00 is a habit too.
  assert.ok(hub.checker.learner.suggestions().some(x => x.kind === 'moment' && x.target.on === true && x.at === '21:00'));

  const undo = hub.checker.fix(s.id);
  const m = hub.config.get().moments.find(x => x.id === 'learned_office_light_2215');
  assert.ok(m);
  assert.deepEqual(m.at, { kind: 'time', at: '22:15' });
  assert.deepEqual(m.targets, { office_light: { on: false } });
  assert.ok(!hub.checker.learner.suggestions().some(x => x.id === s.id), 'already planned now');
  undo();
  assert.ok(!hub.config.get().moments.some(x => x.id === 'learned_office_light_2215'));
  await hub.stop();
});

test('needs enough days, ignores what Kova did itself, and respects Not now', async () => {
  const { hub, advance } = await testHub(12);
  await days(3, advance, async date => {
    await advance(22.25, date);
    await hub.reg.command('office_light', { on: true }, { kind: 'moment', label: 'Something' });
    await hub.reg.command('office_light', { on: false }, you);
    await hub.reg.command('office_strip', { on: true }, { kind: 'moment', label: 'Something' });
    await hub.reg.command('office_strip', { on: false }, { kind: 'moment', label: 'Something' });
  });
  assert.deepEqual(hub.checker.learner.suggestions().filter(x => x.kind === 'moment'), [], '3 days is not a habit yet');
  await advance(22.25, addDays(DATE, 4));
  await hub.reg.command('office_light', { on: true }, { kind: 'moment', label: 'Something' });
  await hub.reg.command('office_light', { on: false }, you);
  const s = hub.checker.learner.suggestions().find(x => x.device === 'office_light');
  assert.ok(s);
  assert.ok(!hub.checker.learner.suggestions().some(x => x.device === 'office_strip'));
  hub.checker.dismiss(s.id);
  assert.ok(!hub.checker.findings().some(f => f.id === s.id));
  await hub.stop();
});
