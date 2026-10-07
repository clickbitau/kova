import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appName, startSignIn, waitForSignIn } from '../src/logic/signin.ts';

// Signing the phone in again by code: ask the hub for one, wait while someone signed in approves it.

type Call = { url: string; method?: string; body?: string };

function hub(script: Array<{ status?: number; body?: unknown } | 'down'>) {
  const calls: Call[] = [];
  let i = 0;
  const f = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const step = script[Math.min(i++, script.length - 1)];
    if (step === 'down') throw new TypeError('Network request failed');
    return { ok: (step.status ?? 200) < 400, status: step.status ?? 200, json: async () => step.body };
  };
  return { f, calls };
}

test('the phone names itself', () => {
  assert.equal(appName('ios'), 'Kova app on iPhone');
  assert.equal(appName('android'), 'Kova app on Android');
  assert.equal(appName('web'), 'Kova app');
});

test('a code, then the key once it is approved; a moment the hub is away is waited out', async () => {
  const h = hub([{ body: { id: 'abc', code: 'ABCD-EFGH', expiresAt: Date.now() + 60_000 } }]);
  const c = await startSignIn('http://hub', 'Kova app on iPhone', h.f);
  assert.equal(c.code, 'ABCD-EFGH');
  assert.equal(h.calls[0].url, 'http://hub/api/login/start');
  assert.equal(h.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(h.calls[0].body!), { name: 'Kova app on iPhone' });

  const w = hub([{ body: { state: 'waiting' } }, 'down', { body: { state: 'waiting' } }, { body: { state: 'approved', token: 'new-key' } }]);
  const key = await waitForSignIn('http://hub', c, { fetch: w.f, sleep: async () => {} });
  assert.equal(key, 'new-key');
  assert.equal(w.calls.length, 4);
  assert.equal(w.calls[0].url, 'http://hub/api/login/poll/abc');
});

test('a code that runs out, or waiting given up, is null', async () => {
  const c = { id: 'abc', code: 'ABCD-EFGH', expiresAt: Date.now() + 60_000 };
  assert.equal(await waitForSignIn('http://hub', c, { fetch: hub([{ body: { state: 'expired' } }]).f, sleep: async () => {} }), null);
  let n = 0;
  assert.equal(await waitForSignIn('http://hub', c, { fetch: hub([{ body: { state: 'waiting' } }]).f, sleep: async () => {}, cancelled: () => ++n > 3 }), null);
  let t = 0;
  assert.equal(await waitForSignIn('http://hub', { ...c, expiresAt: 100 }, { fetch: hub([{ body: { state: 'waiting' } }]).f, sleep: async () => { t += 2000; }, now: () => t }), null);
});

test('a hub that gives no code says so', async () => {
  await assert.rejects(startSignIn('http://hub', 'x', hub([{ status: 404, body: {} }]).f), /didn’t give a sign-in code \(HTTP 404\)/);
});
