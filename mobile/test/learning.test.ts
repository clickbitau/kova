import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLabel, findingCall, findingTag, findingToast, learnedRows, whyQuestion } from '../src/logic/learning.ts';
import type { Finding } from '../src/api/types.ts';

const modes = [{ id: 'wind', name: 'Wind down', color: '#ef8f6e' }] as never;
const learned: Finding = {
  id: 'learn:auto-time:rain_bed:2115', modeId: 'wind', kind: 'Learned from you', icon: 'auto_awesome', tone: 'check',
  title: '“Rain at bedtime” could start at 21:15', body: 'It runs at 22:00…', fix: 'Move it to 21:15', alt: 'Not now', never: 'Don’t suggest again',
  done: 'Rain at bedtime now starts at 21:15', learned: true, automationId: 'rain_bed', evidence: [{ day: 'Fri 2 Oct', text: '21:10 · you started it by hand' }],
};
const check: Finding = { id: 'stays-on:lamp:night', modeId: 'wind', kind: 'Check', icon: 'lightbulb', tone: 'check', title: 'Lamp stays on', body: '…', fix: 'Turn it off', alt: 'Keep it on' };

test('a learned suggestion’s card is tagged with its automation; a mode check with its mode', () => {
  assert.deepEqual(findingTag(learned, { modes, automations: [{ id: 'rain_bed', name: 'Rain at bedtime' }] }), { text: 'Rain at bedtime', color: null });
  assert.deepEqual(findingTag(check, { modes }), { text: 'Wind down', color: '#ef8f6e' });
  assert.deepEqual(findingTag({ ...learned, automationId: 'gone' }, { modes, automations: [] }), { text: 'Wind down', color: '#ef8f6e' }, 'its automation gone: the mode');
});

test('Not now puts a learned one off (snooze); on a mode check it keeps things as they are; never and restore', () => {
  assert.equal(findingCall(learned, 'alt'), '/api/findings/learn%3Aauto-time%3Arain_bed%3A2115/snooze');
  assert.equal(findingCall(check, 'alt'), '/api/findings/stays-on%3Alamp%3Anight/dismiss');
  assert.equal(findingCall(learned, 'never'), '/api/findings/learn%3Aauto-time%3Arain_bed%3A2115/dismiss');
  assert.equal(findingCall(learned, 'fix', 'learn:auto-trigger:x'), '/api/findings/learn%3Aauto-trigger%3Ax/fix', 'another way, by its own id');
  assert.equal(findingCall(learned, 'restore'), '/api/findings/learn%3Aauto-time%3Arain_bed%3A2115/restore');
  assert.equal(findingToast(learned, 'alt'), 'Kova will ask again in a week');
  assert.equal(findingToast(check, 'alt'), 'Kept as is');
  assert.equal(findingToast(learned, 'fix'), 'Rain at bedtime now starts at 21:15');
  assert.equal(findingToast(check, 'fix', 'Night'), 'Night updated');
  assert.equal(findingToast(learned, 'never'), 'Kova won’t suggest that again');
});

test('the days link and the question for Ask Kova', () => {
  assert.equal(evidenceLabel(6, false), 'See the 6 days');
  assert.equal(evidenceLabel(1, false), 'See the 1 day');
  assert.equal(evidenceLabel(6, true), 'Hide the days');
  assert.equal(whyQuestion({ title: 'When the TV turns off, turn off the lamp?' }), 'Why do you suggest “When the TV turns off, turn off the lamp”?');
});

test('What Kova has learned: where each stands, and what tapping does', () => {
  const rows = learnedRows({ on: true, items: [
    { ...learned, status: 'new' },
    { ...learned, id: 'b', automationId: undefined, status: 'later', until: Date.UTC(2026, 9, 14, 4) },
    { ...learned, id: 'c', status: 'never' },
  ] }, 'Australia/Perth');
  assert.deepEqual(rows.map(r => [r.status, r.action, r.tone]), [
    ['Waiting in Worth a look', 'review', 'amber'],
    ['Put off until Wed 14 Oct', 'restore', 'stone'],
    ['You said not to suggest it', 'restore', 'stone'],
  ]);
  assert.equal(rows[0].automationId, 'rain_bed');
  assert.deepEqual(learnedRows(undefined), []);
});
