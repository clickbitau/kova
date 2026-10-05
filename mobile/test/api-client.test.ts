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
