import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLocation, DISCLOSURE, type LocationAsk, type LocationStage, type PermissionState } from '../src/logic/location-consent.ts';

/** A fake phone: permissions as given, every call recorded in order, the disclosure answered from a list. */
function phone(o: { fg?: PermissionState; bg?: PermissionState; fgAnswer?: PermissionState; bgAnswer?: PermissionState; answers?: boolean[] }) {
  const calls: string[] = [];
  const answers = [...(o.answers ?? [])];
  const a: LocationAsk = {
    getForeground: async () => { calls.push('getFg'); return o.fg ?? { granted: false, canAskAgain: true }; },
    getBackground: async () => { calls.push('getBg'); return o.bg ?? { granted: false, canAskAgain: true }; },
    requestForeground: async () => { calls.push('PROMPT fg'); return o.fgAnswer ?? { granted: true }; },
    requestBackground: async () => { calls.push('PROMPT bg'); return o.bgAnswer ?? { granted: true }; },
    disclose: async (s: LocationStage) => { calls.push(`disclose ${s}`); return answers.shift() ?? true; },
  };
  return { a, calls };
}

/** Every system prompt comes straight after Kova's own disclosure for it. */
const promptsFollowDisclosure = (calls: string[]) => calls.forEach((c, i) => {
  if (c === 'PROMPT fg') assert.equal(calls[i - 1], 'disclose foreground');
  if (c === 'PROMPT bg') assert.equal(calls[i - 1], 'disclose background');
});

test('first time: disclosure, foreground prompt, disclosure again, then the background upgrade', async () => {
  const { a, calls } = phone({});
  assert.deepEqual(await askLocation('background', a), { ok: true });
  assert.deepEqual(calls, ['getFg', 'disclose foreground', 'PROMPT fg', 'getBg', 'disclose background', 'PROMPT bg']);
  promptsFollowDisclosure(calls);
});

test('Not now on the disclosure: no system prompt at all', async () => {
  const { a, calls } = phone({ answers: [false] });
  const r = await askLocation('background', a);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'declined');
  assert.ok(!calls.some(c => c.startsWith('PROMPT')));
});

test('Not now before the upgrade: the background prompt is never shown', async () => {
  const { a, calls } = phone({ answers: [true, false] });
  const r = await askLocation('background', a);
  assert.equal(!r.ok && r.reason, 'declined');
  assert.equal(!r.ok && r.stage, 'background');
  assert.ok(calls.includes('PROMPT fg'));
  assert.ok(!calls.includes('PROMPT bg'));
});

test('foreground already allowed (e.g. Settings used it once): the upgrade still gets its own disclosure', async () => {
  const { a, calls } = phone({ fg: { granted: true } });
  assert.deepEqual(await askLocation('background', a), { ok: true });
  assert.deepEqual(calls, ['getFg', 'getBg', 'disclose background', 'PROMPT bg']);
});

test('every attempt shows it again: nothing is remembered between tries', async () => {
  for (let i = 0; i < 3; i++) {
    const { a, calls } = phone({ answers: [false] });
    await askLocation('background', a);
    assert.equal(calls.filter(c => c.startsWith('disclose')).length, 1);
  }
});

test('all already allowed: nothing to ask, so nothing shown', async () => {
  const { a, calls } = phone({ fg: { granted: true }, bg: { granted: true } });
  assert.deepEqual(await askLocation('background', a), { ok: true });
  assert.deepEqual(calls, ['getFg', 'getBg']);
});

test('refused, or blocked in Settings: says where to change it, and never prompts when it can’t', async () => {
  let p = phone({ fgAnswer: { granted: false, canAskAgain: true } });
  let r = await askLocation('background', p.a);
  assert.equal(!r.ok && r.reason, 'denied');
  p = phone({ fg: { granted: false, canAskAgain: false } });
  r = await askLocation('background', p.a);
  assert.equal(!r.ok && r.reason, 'blocked');
  assert.ok(!p.calls.some(c => c.startsWith('PROMPT') || c.startsWith('disclose')));
  p = phone({ fg: { granted: true }, bgAnswer: { granted: false, canAskAgain: false } });
  r = await askLocation('background', p.a);
  assert.equal(!r.ok && r.reason, 'blocked');
  assert.match(!r.ok ? r.why : '', /all the time/);
});

test('one-off use (where the home is): its own disclosure, and never the background prompt', async () => {
  const { a, calls } = phone({});
  assert.deepEqual(await askLocation('once', a), { ok: true });
  assert.deepEqual(calls, ['getFg', 'disclose once', 'PROMPT fg']);
});

test('the disclosure uses Play’s required wording', () => {
  for (const s of [DISCLOSURE.lead, DISCLOSURE.background.lead]) {
    assert.match(s, /collects location data/);
    assert.match(s, /arrive and leave home/);
    assert.match(s, /even when the app is closed or not in use/);
  }
  const all = JSON.stringify(DISCLOSURE.points);
  assert.match(all, /your own Kova hub/);
  assert.match(all, /home.*away/);
  assert.equal(DISCLOSURE.cta, 'Continue');
  assert.equal(DISCLOSURE.no, 'Not now');
});
