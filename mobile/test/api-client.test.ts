import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_TIMEOUT_MS, call, HubError } from '../src/api/client.ts';

const cfg = { url: 'http://kova.test:8140', token: 't' };

test('API calls can use a longer per-request timeout for Ask Kova', async () => {
  const original = globalThis.fetch;
  let aborted = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })), 20);
    init?.signal?.addEventListener('abort', () => {
      aborted++;
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  })) as typeof fetch;
  try {
    assert.equal(ASK_TIMEOUT_MS, 120_000);
    const ok = await call<{ ok: boolean }>(cfg, 'POST', '/api/ask', { text: 'complicated' }, 60);
    assert.equal(ok.ok, true);
    await assert.rejects(call(cfg, 'POST', '/api/ask', { text: 'complicated' }, 5), (e: unknown) => {
      assert.ok(e instanceof HubError);
      assert.equal(e.timedOut, true);
      assert.match(e.message, /didn’t answer in time/);
      return true;
    });
    assert.equal(aborted, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed request says which kind of trouble it is: nothing answered, signed out, or the hub said no', async () => {
  const original = globalThis.fetch;
  const answer = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch; };
  try {
    answer(401, { error: 'unauthorised' });
    await assert.rejects(call(cfg, 'GET', '/api/state'), (e: unknown) => {
      assert.ok(e instanceof HubError);
      assert.equal(e.problem, 'signedOut');
      assert.match(e.message, /didn’t accept this phone’s key/);
      return true;
    });
    // A route's own 401 with its own reason isn't the hub signing this phone out.
    answer(401, { error: 'wrong key for this person' });
    await assert.rejects(call(cfg, 'POST', '/api/people/x/presence'), (e: unknown) => e instanceof HubError && e.problem === 'hub' && e.message === 'wrong key for this person');
    answer(503, { error: 'Starting up' });
    await assert.rejects(call(cfg, 'GET', '/api/state'), (e: unknown) => e instanceof HubError && e.problem === 'hub' && e.status === 503);
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    await assert.rejects(call(cfg, 'GET', '/api/state'), (e: unknown) => e instanceof HubError && e.problem === 'unreachable' && !e.timedOut);
  } finally {
    globalThis.fetch = original;
  }
});
