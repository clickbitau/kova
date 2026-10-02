import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { deviceName } from '../src/services/sessions.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const MASTER = 'master-key-for-tests-0123456789abcdef';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

test('signing a browser in with a code approved by someone signed in; its own key; signing out', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: MASTER });
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  try {
    // No key: the home is closed; asking for a code is open.
    assert.equal((await app.inject({ url: '/api/state' })).statusCode, 401);
    let r = await app.inject({ method: 'POST', url: '/api/login/start', headers: { 'user-agent': CHROME_MAC } });
    assert.equal(r.statusCode, 200);
    const { id, code } = r.json();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.deepEqual((await app.inject({ url: `/api/login/poll/${id}` })).json(), { state: 'waiting' });

    // Approving needs to be signed in; a wrong code is refused.
    assert.equal((await app.inject({ method: 'POST', url: '/api/login/approve', payload: { code } })).statusCode, 401);
    r = await app.inject({ method: 'POST', url: '/api/login/approve', headers: as(MASTER), payload: { code: 'AAAA-AAAA' } });
    assert.match(r.json().error, /isn’t right/);
    r = await app.inject({ method: 'POST', url: '/api/login/approve', headers: as(MASTER), payload: { code: code.toLowerCase().replace('-', ' ') } });
    assert.deepEqual(r.json(), { ok: true, name: 'Chrome on Mac' });

    // The browser gets its own key, once.
    r = await app.inject({ url: `/api/login/poll/${id}` });
    const key = r.json().token as string;
    assert.equal(r.json().state, 'approved');
    assert.notEqual(key, MASTER);
    assert.deepEqual((await app.inject({ url: `/api/login/poll/${id}` })).json(), { state: 'expired' }, 'handed out once');
    assert.equal((await app.inject({ url: '/api/state', headers: as(key) })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/boot.js?token=${encodeURIComponent(key)}` })).statusCode, 200, 'the boot script takes it as ?token=');

    // Listed (this one marked), stored only as a hash; a signed-in browser can sign another in.
    const list = (await app.inject({ url: '/api/sessions', headers: as(key) })).json().sessions;
    assert.deepEqual(list.map((s: { name: string; current?: boolean }) => [s.name, !!s.current]), [['Chrome on Mac', true]]);
    assert.ok(!JSON.stringify(t.hub.store.get('web-sessions')).includes(key));

    // Signing out: the key stops working.
    await app.inject({ method: 'POST', url: '/api/logout', headers: as(key) });
    assert.equal((await app.inject({ url: '/api/state', headers: as(key) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/sessions/nope', headers: as(MASTER) })).statusCode, 404);
  } finally { await app.close(); await t.hub.stop(); }
});

test('device names for the session list', () => {
  assert.equal(deviceName(CHROME_MAC), 'Chrome on Mac');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
  assert.equal(deviceName(''), 'A browser');
});
