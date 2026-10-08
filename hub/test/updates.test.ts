import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { Updates, UPDATE_STEPS, progressOf } from '../src/services/updates.ts';
import { KOVA_VERSION } from '../src/version.ts';
import { TEST_PUBKEY, mintKey } from './licence-helpers.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

/** What deploy/updater.sh writes after a check. */
function writeStatus(dataDir: string, s: object) {
  mkdirSync(join(dataDir, 'update'), { recursive: true });
  writeFileSync(join(dataDir, 'update', 'status.json'), JSON.stringify(s));
}

test('Hub updates: what’s available, Check now and Update ask the updater, a new version is announced once', async () => {
  const t = await testHub(12);
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-upd-'));
  const said: { title: string; body: string }[] = [];
  const u = new Updates(t.hub, { dataDir, notify: async n => { said.push(n); }, now: () => t.clock.t, everyMs: 0 });
  t.hub.updates = u;
  const app = await buildServer(t.hub, { webRoot });
  try {
    // No updater on this box yet: nothing to ask.
    assert.equal(u.status().updater, false);
    rmSync(join(dataDir, 'update'), { recursive: true, force: true });
    assert.equal((await app.inject({ method: 'POST', url: '/api/update/check' })).statusCode, 400);

    // The updater found a newer Kova.
    writeStatus(dataDir, {
      updater: 1, state: 'idle', checkedAt: 1000, current: { version: KOVA_VERSION, commit: 'aaaaaaa' },
      available: { version: '9.9.9', commit: 'bbbbbbb', behind: 3, changes: ['Helix boxes: follow a box’s new id', 'Warn when a link breaks', 'TV source through SmartThings'] },
    });
    const st = (await app.inject({ method: 'GET', url: '/api/update' })).json();
    assert.deepEqual({ v: st.available.version, cur: st.current, state: st.state, auto: st.auto }, { v: '9.9.9', cur: { version: KOVA_VERSION, commit: 'aaaaaaa' }, state: 'idle', auto: { on: false, hour: 3 } });
    // The snapshot carries it, for the pages and the app.
    assert.equal((await app.inject({ method: 'GET', url: '/api/state' })).json().update.available.version, '9.9.9');

    // Said once, with what's new.
    u.tick(); u.tick();
    assert.equal(said.length, 1);
    assert.equal(said[0].title, 'Kova 9.9.9 is available');
    assert.match(said[0].body, /^Helix boxes: follow a box’s new id; Warn when a link breaks; TV source through SmartThings\. Update from Settings, under Software update\.$/);
    assert.equal((said[0] as { url?: string }).url, '/phone.html?page=settings', 'opens Settings, where Software update is');

    // Update: a request the updater (root) picks up.
    const r = await app.inject({ method: 'POST', url: '/api/update/apply' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(readFileSync(join(dataDir, 'update', 'request'), 'utf8'), 'apply\n');
    assert.equal(r.json().state, 'requested');
    // While it updates: not again.
    rmSync(join(dataDir, 'update', 'request'));
    writeStatus(dataDir, { ...JSON.parse(readFileSync(join(dataDir, 'update', 'status.json'), 'utf8')), state: 'updating' });
    assert.match((await app.inject({ method: 'POST', url: '/api/update/apply' })).json().error, /already updating/);

    // Up to date: nothing to apply, but a check is fine.
    writeStatus(dataDir, { updater: 1, state: 'idle', checkedAt: 2000, current: { version: KOVA_VERSION, commit: 'bbbbbbb' }, available: null });
    assert.match((await app.inject({ method: 'POST', url: '/api/update/apply' })).json().error, /up to date/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/update/check' })).statusCode, 200);
    assert.equal(readFileSync(join(dataDir, 'update', 'request'), 'utf8'), 'check\n');

    // Overnight settings.
    assert.deepEqual((await app.inject({ method: 'PUT', url: '/api/update/settings', payload: { on: true, hour: 2 } })).json(), { auto: { on: true, hour: 2 } });
    assert.equal((await app.inject({ method: 'PUT', url: '/api/update/settings', payload: { hour: 25 } })).statusCode, 400);
  } finally {
    await app.close();
    await t.hub.stop();
  }
});

test('Hub updates: overnight at the hour set, not while something plays; and after an update, how it went, once', async () => {
  const t = await testHub(1);
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-upd-'));
  const said: { title: string; body: string }[] = [];
  const mk = () => new Updates(t.hub, { dataDir, notify: async n => { said.push(n); }, now: () => t.clock.t, everyMs: 0 });
  const u = mk();
  try {
    writeStatus(dataDir, { updater: 1, state: 'idle', current: { version: KOVA_VERSION, commit: 'a' }, available: { version: '9.9.9', commit: 'b', behind: 1, changes: [] } });
    u.setAuto({ on: true, hour: 3 });
    u.tick();
    assert.equal(said.length, 0, 'overnight updates on: no "available" note');
    assert.equal(existsSync(join(dataDir, 'update', 'request')), false, '1 am: not yet');
    // 3 am, but a film is playing: wait.
    t.clock.t = at(3);
    const tv = [...t.hub.reg.devices.values()].find(d => d.type === 'tv' || d.type === 'media')!;
    const was = tv.adapter;
    Object.assign(tv, { adapter: 'helix' }); tv.state.on = true; tv.state.paused = false;
    u.tick();
    assert.equal(existsSync(join(dataDir, 'update', 'request')), false, 'not while something plays');
    tv.state.on = false; Object.assign(tv, { adapter: was });
    u.tick();
    assert.equal(readFileSync(join(dataDir, 'update', 'request'), 'utf8'), 'apply\n');

    // The update rolled back: the hub (old version again) says so once.
    rmSync(join(dataDir, 'update', 'request'));
    writeStatus(dataDir, { updater: 1, state: 'idle', current: { version: KOVA_VERSION, commit: 'a' }, available: null, last: { result: 'rolled-back', from: KOVA_VERSION, to: KOVA_VERSION, at: 5000 } });
    mk().start(); mk().start();
    assert.equal(said.length, 1);
    assert.equal(said[0].title, `Kova ${KOVA_VERSION} is back`);
    // Updated: said once.
    writeStatus(dataDir, { updater: 1, state: 'idle', current: { version: KOVA_VERSION, commit: 'b' }, available: null, last: { result: 'updated', from: '0.5.2', to: KOVA_VERSION, at: 6000 } });
    mk().start(); mk().start();
    assert.equal(said.length, 2);
    assert.equal(said[1].title, `Kova updated to ${KOVA_VERSION}`);
    // Both results are kept, newest first, for Software update's history.
    assert.deepEqual(u.status().history.map(h => [h.result, h.at]), [['updated', 6000], ['rolled-back', 5000]]);
  } finally {
    u.stop();
    await t.hub.stop();
  }
});

test('Hub updates: the licence key is activated with ClickBit from the hub, never shown back, and the updater asked to check', async () => {
  const t = await testHub(12);
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-upd-'));
  const asked: string[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    asked.push(String(url));
    const body = JSON.parse(String(init?.body ?? '{}'));
    return body.siteId === u.catalog.hubId()
      ? new Response(JSON.stringify({ status: 'active', edition: 'home', deviceToken: 'tok' }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Licence not found' }), { status: 403 });
  }) as typeof fetch;
  const u = new Updates(t.hub, { dataDir, now: () => t.clock.t, everyMs: 0, catalog: { url: 'https://catalog.test/api', fetch: fakeFetch, pubkey: TEST_PUBKEY } });
  t.hub.updates = u;
  const app = await buildServer(t.hub, { webRoot });
  try {
    writeStatus(dataDir, { updater: 1, state: 'idle', source: 'release', soft: 'No device token — install a licence to enable updates', current: { version: KOVA_VERSION }, available: null });
    const before = (await app.inject({ method: 'GET', url: '/api/update' })).json();
    assert.deepEqual({ source: before.source, note: before.note, licence: before.licence.installed }, { source: 'release', note: 'No device token — install a licence to enable updates', licence: false });

    // The hub's ID, for the admin issuing the licence.
    const hubId = before.licence.hubId;
    assert.match(hubId, /^KOVA-/);
    const bad = await app.inject({ method: 'PUT', url: '/api/update/licence', payload: { key: mintKey({ site: 'KOVA-AAAA-BBBB-CCCC' }) } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, new RegExp(`for hub KOVA-AAAA-BBBB-CCCC; this hub is ${hubId}`));
    assert.equal(asked.length, 0, 'refused on the hub');

    const key = mintKey({ site: hubId });
    const r = await app.inject({ method: 'PUT', url: '/api/update/licence', payload: { key: ` ${key} ` } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().licence, { hubId, installed: true, activated: true, status: 'active', edition: 'home', features: ['updates'], expiresAt: null, key: `…${key.slice(-4)}`, error: null });
    assert.equal(asked.at(-1), 'https://catalog.test/api/v1/device/activate');
    assert.equal(readFileSync(join(dataDir, 'update', 'request'), 'utf8'), 'check\n');
    // The key and the token stay on the box: not in the API, nor the snapshot.
    const state = (await app.inject({ method: 'GET', url: '/api/state' })).body;
    assert.equal((state + r.body).includes(key), false);
    assert.doesNotMatch(state + r.body, /"tok"/);

    assert.equal((await app.inject({ method: 'DELETE', url: '/api/update/licence' })).json().licence.installed, false);
  } finally {
    await app.close();
    await t.hub.stop();
  }
});

test('progress while it updates: the step from the updater’s log, the restart behind it once the new version answers, going back said', async () => {
  const release = '==> Downloading Kova 0.9.1\n{"sha256":"ab","size":1}\n==> Unpacking kova-0.9.1.tar.gz\n';
  assert.deepEqual(progressOf(release), { step: 1, steps: UPDATE_STEPS, label: 'Unpacking and checking', startedAt: null, rollingBack: false });
  assert.equal(progressOf(release + '==> Backing up /var/lib/kova\n(node) ExperimentalWarning\n').label, 'Backing up your home');
  const switching = release + '==> Backing up /var/lib/kova\n==> Switching from Kova 0.9.0 to 0.9.1\n';
  assert.equal(progressOf(switching, { running: '0.9.0', to: '0.9.1' }).step, 3, 'the old version, about to restart');
  assert.equal(progressOf(switching, { running: '0.9.1', to: '0.9.1' }).label, 'Making sure it started properly', 'the new one answering');
  const back = progressOf(switching + '==> Kova 0.9.1 didn\'t come up: going back to 0.9.0\n==> Restoring /x.tar.gz\n', { running: '0.9.0', to: '0.9.1' });
  assert.equal(back.rollingBack, true);
  assert.equal(back.label, 'Putting your data back as it was');
  // git updates (deploy/update.sh): coloured "==>" lines.
  assert.equal(progressOf('\x1b[1m==>\x1b[0m Backing up /d\n\x1b[1m==>\x1b[0m Pulling (currently a)\n\x1b[1m==>\x1b[0m Restarting kova\n').step, 3);

  const t = await testHub();
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-upd-'));
  const u = new Updates(t.hub, { dataDir, everyMs: 0 });
  try {
    writeStatus(dataDir, { updater: 1, state: 'updating', startedAt: 1000, current: { version: KOVA_VERSION, commit: 'a' }, available: { version: '99.0.0', commit: 'b', behind: 1, changes: [] } });
    assert.equal(u.status().progress?.step, 0, 'started, no log yet');
    writeFileSync(join(dataDir, 'update', 'last-update.log'), '==> Downloading Kova 99.0.0\n==> Unpacking k\n==> Backing up /d\n');
    assert.deepEqual([u.status().progress?.step, u.status().progress?.startedAt], [2, 1000]);
    writeStatus(dataDir, { updater: 1, state: 'idle', current: { version: KOVA_VERSION, commit: 'a' }, available: null });
    assert.equal(u.status().progress, null);
  } finally { u.stop(); await t.hub.stop(); }
});
