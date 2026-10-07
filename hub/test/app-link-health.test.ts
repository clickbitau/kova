import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

// What the phone app's link to the hub (mobile/src/logic/link.ts) relies on: it can sign itself in again by code
// under its own name, a refused key is a plain 401 it can tell from "nothing answered", and the state snapshot is
// cheap enough that the hub answers /api/hello quickly while it sends them.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const MASTER = 'master-key-for-tests-0123456789abcdef';

test('the phone app signs in again by code, under the name it gives', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: MASTER });
  try {
    let r = await app.inject({ method: 'POST', url: '/api/login/start', payload: { name: 'Kova app on iPhone' } });
    const { id, code } = r.json();
    r = await app.inject({ method: 'POST', url: '/api/login/approve', headers: { authorization: `Bearer ${MASTER}` }, payload: { code } });
    assert.deepEqual(r.json(), { ok: true, name: 'Kova app on iPhone' });
    const key = (await app.inject({ url: `/api/login/poll/${id}` })).json().token as string;
    // Its key works for requests and the socket's ?token=; signed out, it's refused with the hub's own 401.
    assert.equal((await app.inject({ url: '/api/connect/addresses', headers: { authorization: `Bearer ${key}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/state?token=${encodeURIComponent(key)}` })).statusCode, 200);
    const sid = (await app.inject({ url: '/api/sessions', headers: { authorization: `Bearer ${MASTER}` } })).json().sessions[0].id as string;
    await app.inject({ method: 'DELETE', url: `/api/sessions/${sid}`, headers: { authorization: `Bearer ${MASTER}` } });
    r = await app.inject({ url: '/api/connect/addresses', headers: { authorization: `Bearer ${key}` } });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.json(), { error: 'unauthorised' });
    // /api/hello still answers without a key, so the app knows the hub is there and it's the key that's wrong.
    assert.equal((await app.inject({ url: '/api/hello' })).statusCode, 200);

    // A name is plain and short; without one it's named from the user agent as before.
    r = await app.inject({ method: 'POST', url: '/api/login/start', payload: { name: '  <b>A\nvery long name for a phone that goes on and on</b> ' } });
    await app.inject({ method: 'POST', url: '/api/login/approve', headers: { authorization: `Bearer ${MASTER}` }, payload: { code: r.json().code } });
    const names = (await app.inject({ url: '/api/sessions', headers: { authorization: `Bearer ${MASTER}` } })).json().sessions.map((s: { name: string }) => s.name);
    assert.ok(names.includes('bA very long name for a phone that goes'), names.join(' | '));
    r = await app.inject({ method: 'POST', url: '/api/login/start', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' } });
    assert.equal(r.statusCode, 200);
  } finally {
    await app.close();
    t.hub.stop();
  }
});

test('the history behind findings is read again only when it changes', async () => {
  const t = await testHub(12);
  try {
    const learner = t.hub.checker.learner;
    const first = learner.all();
    assert.equal(learner.all(), first, 'nothing changed: the same answer, not read again');
    // A manual change is new history: read again, though not more than every 30 s (a ramp changes things every minute,
    // a device may report every second).
    t.hub.store.append({ kind: 'state', device: 'lounge_lamp', feed: 'device', what: 'Lamp on', data: { patch: { on: true } }, cause: { kind: 'user', label: 'You' }, ts: at(12) });
    assert.equal(learner.all(), first, 'resting');
    t.clock.t += 31_000;
    assert.notEqual(learner.all(), first);
    const second = learner.all();
    // So is a change to the home's config (a suggestion taken or dismissed changes it), at once.
    t.hub.config.update(c => { c.dismissedFindings = [...c.dismissedFindings, 'x']; });
    assert.notEqual(learner.all(), second);
    // Other events (samples, device events) don't count.
    const third = learner.all();
    t.clock.t += 31_000;
    t.hub.store.append({ kind: 'sample', device: null, feed: null, what: '', data: {}, cause: { kind: 'system', label: 'Kova' } });
    assert.equal(learner.all(), third);
  } finally {
    t.hub.stop();
  }
});
