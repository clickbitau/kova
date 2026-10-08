import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { Notifier, LIGHTS_OFF_URL } from '../src/services/notify.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pushcert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=push.example'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } catch { return null; }
}
const CERT = selfSigned();
// Push services are always HTTPS; the fake one uses a self-signed certificate.
const insecure = new https.Agent({ rejectUnauthorized: false });

interface Got { path: string; headers: http.IncomingHttpHeaders; body: Buffer }

/** A fake push service (like web.push.apple.com): records requests; paths starting /gone answer 410. */
async function fakePushService() {
  const got: Got[] = [];
  const server = https.createServer(CERT!, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url!.startsWith('/gone') ? 410 : 201);
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A fake ntfy server: records JSON publishes. */
async function fakeNtfy() {
  const got: { headers: http.IncomingHttpHeaders; json: Record<string, any> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({ headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A browser-side subscription: its own P-256 key pair and auth secret, so the test can decrypt what arrives. */
function browserSubscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    /** RFC 8291 (Web Push message encryption) + RFC 8188 (aes128gcm), done by hand. */
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idlen = body[20];
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
      const ecdhSecret = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, ecdhSecret);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]);
      const ikm = hmac(prkKey, keyInfo);
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      // Last record: content, then 0x02, then zero padding.
      let end = plain.length - 1;
      while (end > 0 && plain[end] === 0) end--;
      assert.equal(plain[end], 2, 'last-record padding delimiter');
      return plain.subarray(0, end).toString('utf8');
    },
  };
}

async function setup(hour: number, opts: ConstructorParameters<typeof Notifier>[1] = {}) {
  const t = await testHub(hour);
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-notify-'));
  const ntfy = await fakeNtfy();
  const notifier = new Notifier(t.hub, { ntfy: { url: ntfy.url, topic: 'kova-home', token: 'tk_test' }, publicUrl: 'https://kova.example.com', ringSettleMs: 30, everyoneOutGraceSec: 0, checkSec: 0, ...opts }, { dataDir, pushAgent: insecure });
  notifier.start();
  const done = async () => { await notifier.stop(); await t.hub.stop(); await ntfy.close(); };
  return { ...t, dataDir, ntfy, notifier, done };
}

test('Notify: doorbell ring → ntfy and an encrypted Web Push (RFC 8291), logged to Activity', { skip: !CERT && 'needs openssl for the fake push service' }, async () => {
  const push = await fakePushService();
  const { hub, ntfy, notifier, dataDir, done } = await setup(20.5);
  try {
    // VAPID keys are made on first run, owner-only.
    const vapidFile = join(dataDir, 'push', 'vapid.json');
    assert.equal(statSync(vapidFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(vapidFile, 'utf8')).publicKey, notifier.vapid.publicKey);

    const phone = browserSubscription(`${push.base}/push/v1/abc123`);
    notifier.subscribe(phone.subscription);
    const frontOn = [hub.reg.get('front_1')!.state.on, hub.reg.get('front_2')!.state.on];
    assert.deepEqual(frontOn, [false, false], 'front lights start off in Wind down');

    hub.reg.deviceEvent('doorbell', 'ring');
    await notifier.idle();

    // ntfy got a JSON publish with the token.
    assert.equal(ntfy.got.length, 1);
    const n = ntfy.got[0];
    assert.equal(n.headers.authorization, 'Bearer tk_test');
    assert.equal(n.json.topic, 'kova-home');
    assert.equal(n.json.title, 'Someone’s at the front door');
    assert.match(n.json.message, /^Doorbell rang\. Light the way turned on .+ and .+\.$/);
    assert.deepEqual(n.json.tags, ['bell']);

    // The push service got one encrypted request with VAPID auth.
    assert.equal(push.got.length, 1);
    const p = push.got[0];
    assert.equal(p.path, '/push/v1/abc123');
    assert.equal(p.headers['content-encoding'], 'aes128gcm');
    assert.equal(p.headers['content-type'], 'application/octet-stream');
    assert.ok(Number(p.headers.ttl) > 0);
    assert.equal(p.headers.urgency, 'high');
    assert.match(String(p.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.ok(String(p.headers.authorization).endsWith(`k=${notifier.vapid.publicKey}`));
    assert.ok(!p.body.includes(Buffer.from('front door')), 'payload is not in the clear');
    const msg = JSON.parse(phone.decrypt(p.body));
    assert.equal(msg.title, 'Someone’s at the front door');
    assert.equal(msg.body, n.json.message);
    assert.equal(msg.url, '/phone.html?cam=doorbell');
    assert.deepEqual(msg.actions, [{ action: 'view-camera', title: 'View camera', url: '/phone.html?cam=doorbell' }]);

    const logged = hub.store.feed(20).find(e => e.kind === 'system' && e.what === 'Notified: Someone’s at the front door');
    assert.ok(logged, 'logged to Activity');
    assert.equal(logged!.feed, 'system');
    assert.equal(logged!.data.push, 1);
    assert.equal(logged!.data.ntfy, true);

    // Same keys on the next start.
    const again = new Notifier(hub, {}, { dataDir });
    assert.equal(again.vapid.publicKey, notifier.vapid.publicKey);
  } finally { await done(); await push.close(); }
});

test('Notify: a 404/410 from the push service removes the subscription', { skip: !CERT && 'needs openssl for the fake push service' }, async () => {
  const push = await fakePushService();
  const { notifier, done } = await setup(12, { ntfy: undefined });
  try {
    notifier.subscribe(browserSubscription(`${push.base}/push/live`).subscription, 'methel');
    notifier.subscribe(browserSubscription(`${push.base}/gone/old-phone`).subscription);
    assert.equal(notifier.subscriptions().length, 2);
    const r = await notifier.notify({ title: 'Hello', body: 'Test' });
    assert.deepEqual(r, { push: 1, ntfy: false, removed: 1, app: 0 });
    assert.deepEqual(notifier.subscriptions().map(s => s.subscription.endpoint), [`${push.base}/push/live`]);
    // Targeted at someone else: a subscription tied to Methel doesn't get it.
    push.got.length = 0;
    await notifier.notify({ title: 'For Brishti', body: '…', people: ['brishti'] });
    assert.equal(push.got.length, 0);
  } finally { await done(); await push.close(); }
});

test('Notify: "everyone’s out with lights on" fires once, with a turn-them-off action', async () => {
  const { hub, ntfy, notifier, done } = await setup(20.5);
  try {
    for (const id of ['kitchen_ceiling', 'lamp', 'porch']) if (hub.reg.get(id)) await hub.engine.command(id, { on: true });
    const lightsOn = hub.reg.list().filter(d => (d.type === 'light' || d.type === 'dimmer') && d.state.on).length;
    assert.ok(lightsOn > 1);
    await hub.engine.setPresence('methel', false, 'test');
    await notifier.idle();
    assert.equal(ntfy.got.length, 0, 'Brishti is still home');
    await hub.engine.setPresence('brishti', false, 'test');
    await notifier.idle();
    const out = ntfy.got.filter(g => /^Everyone’s out/.test(g.json.title));
    assert.equal(out.length, 1);
    assert.equal(out[0].json.title, `Everyone’s out, ${lightsOn} lights are on`);
    assert.equal(out[0].json.click, `https://kova.example.com${LIGHTS_OFF_URL}`);
    assert.deepEqual(out[0].json.actions, [{ action: 'view', label: 'Turn them off', url: `https://kova.example.com${LIGHTS_OFF_URL}` }]);
    // More changes while everyone's out don't repeat it.
    await hub.engine.command('dining', { on: true });
    await hub.engine.setPresence('methel', false, 'test');
    await notifier.idle();
    assert.equal(ntfy.got.filter(g => /^Everyone’s out/.test(g.json.title)).length, 1);

    // The action's endpoint turns every light off.
    const app = await buildServer(hub, { webRoot, notifier });
    const r = (await app.inject({ method: 'POST', url: '/api/lights/off' })).json();
    assert.ok(r.changed.length >= lightsOn);
    assert.equal(hub.reg.list().filter(d => (d.type === 'light' || d.type === 'dimmer') && d.state.on).length, 0);
    await app.close();

    // Someone comes home (Light the way turns the garage and front lights on) and leaves again:
    // those lights turn themselves off, so there's nothing to tell anyone.
    await hub.engine.setPresence('methel', true, 'test');
    assert.equal(hub.reg.get('garage_light')!.state.on, true);
    await hub.engine.setPresence('methel', false, 'test');
    await notifier.idle();
    assert.equal(ntfy.got.filter(g => /^Everyone’s out/.test(g.json.title)).length, 1);
  } finally { await done(); }
});

test('Notify: a device offline for more than 10 minutes, once', async () => {
  const { hub, clock, virtual, ntfy, notifier, done } = await setup(12);
  try {
    virtual.physical('kitchen_ceiling', { online: false });
    notifier.checkDevices();
    clock.t += 9 * 60_000; notifier.checkDevices();
    await notifier.idle();
    assert.equal(ntfy.got.length, 0);
    clock.t += 2 * 60_000; notifier.checkDevices();
    notifier.checkDevices();
    await notifier.idle();
    assert.equal(ntfy.got.length, 1);
    assert.equal(ntfy.got[0].json.title, `${hub.reg.get('kitchen_ceiling')!.name} isn’t responding`);
    assert.deepEqual(ntfy.got[0].json.tags, ['warning']);
    // Back, then gone again: a new episode, with its own 10 minutes.
    virtual.physical('kitchen_ceiling', { online: true });
    virtual.physical('kitchen_ceiling', { online: false });
    clock.t += 5 * 60_000; notifier.checkDevices();
    await notifier.idle();
    assert.equal(ntfy.got.length, 1, 'the offline clock restarted');
    clock.t += 6 * 60_000; notifier.checkDevices();
    await notifier.idle();
    assert.equal(ntfy.got.length, 2);
  } finally { await done(); }
});

test('Notify: a link that worked and broke (Helix, SmartThings…) after 5 minutes, once, and when it’s back', async () => {
  const { hub, clock, ntfy, notifier, done } = await setup(12);
  const helix = { ok: true, note: '1 box · live' };
  hub.services.push({ id: 'helix-link', name: 'Helix TVs', icon: 'tv', kind: 'Local', status: () => helix });
  // Never set up: not news.
  hub.services.push({ id: 'never', name: 'SmartThings', icon: 'speaker', kind: 'Cloud', status: () => ({ ok: false, note: 'Not linked yet' }) });
  try {
    notifier.checkLinks();
    Object.assign(helix, { ok: false, note: 'Can’t reach Helix Server: connect ECONNREFUSED' });
    notifier.checkLinks();
    clock.t += 4 * 60_000; notifier.checkLinks();
    await notifier.idle();
    assert.equal(ntfy.got.length, 0, 'a blip isn’t news');
    clock.t += 2 * 60_000; notifier.checkLinks(); notifier.checkLinks();
    await notifier.idle();
    assert.equal(ntfy.got.length, 1);
    assert.equal(ntfy.got[0].json.title, 'Kova lost Helix TVs');
    assert.match(ntfy.got[0].json.message, /^Can’t reach Helix Server: connect ECONNREFUSED\./);
    Object.assign(helix, { ok: true, note: '1 box · live' });
    notifier.checkLinks(); notifier.checkLinks();
    await notifier.idle();
    assert.equal(ntfy.got.length, 2);
    assert.equal(ntfy.got[1].json.title, 'Helix TVs is back');
  } finally { await done(); }
});

test('Notify: rules can be turned off; nothing is logged without a channel', async () => {
  const { hub, ntfy, notifier, done } = await setup(20.5, { rules: { doorbell: false } });
  try {
    hub.reg.deviceEvent('doorbell', 'ring');
    await notifier.idle();
    assert.equal(ntfy.got.length, 0);
  } finally { await done(); }
  const t = await testHub(12);
  const bare = new Notifier(t.hub, {}, { dataDir: mkdtempSync(join(tmpdir(), 'kova-notify-')) });
  const r = await bare.notify({ title: 'Nobody listening', body: '' });
  assert.deepEqual(r, { push: 0, ntfy: false, removed: 0, app: 0 });
  assert.equal(t.hub.store.feed(10).filter(e => e.what.startsWith('Notified')).length, 0);
  await t.hub.stop();
});

test('Notify API: VAPID key and subscribe', async () => {
  const { hub, notifier, done } = await setup(12, { ntfy: undefined });
  const app = await buildServer(hub, { webRoot, notifier, token: 'master' });
  try {
    const auth = { authorization: 'Bearer master' };
    assert.equal((await app.inject({ url: '/api/push/vapid' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/push/vapid', headers: auth })).json().publicKey, notifier.vapid.publicKey);
    const bad = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: auth, payload: { subscription: { endpoint: 'http://insecure/x', keys: { p256dh: 'a', auth: 'b' } } } });
    assert.equal(bad.statusCode, 400);
    const sub = browserSubscription('https://web.push.apple.com/abc').subscription;
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: auth, payload: { subscription: sub, personId: 'methel' } })).statusCode, 200);
    // Subscribing again replaces, not duplicates.
    await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: auth, payload: { subscription: sub } });
    assert.equal(notifier.subscriptions().length, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: auth, payload: { subscription: sub, personId: 'nobody' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: auth, payload: { endpoint: sub.endpoint } })).json().ok, true);
    assert.equal(notifier.subscriptions().length, 0);
  } finally { await app.close(); await done(); }
});

test('Notify choices: per kind, every time / at most every N hours / never; held ones counted and said; Warden’s attacks every 6 h by default', async () => {
  const { hub, clock, ntfy, notifier, done } = await setup(12);
  const threat = () => notifier.notify({ title: 'Password guessing on rdp-host is being blocked', body: '143 tries in 10 minutes.', tag: 'warden-threat' });
  try {
    // Out of the box: the first goes, the next ones within 6 hours are held.
    await threat(); clock.t += 10 * 60_000; await threat(); clock.t += 10 * 60_000; const held = await threat();
    assert.equal(ntfy.got.length, 1);
    assert.equal(held.held, 1);
    assert.equal(hub.store.feed(50).filter(e => e.what.startsWith('Notified: Password')).length, 1, 'held ones aren’t in Activity');
    // Six hours on: it goes, saying how many there were.
    clock.t += 6 * 3_600_000;
    await threat();
    assert.equal(ntfy.got.length, 2);
    assert.equal(ntfy.got[1]!.json.message, '143 tries in 10 minutes. And 2 more like this in the last 6 hours.');
    // Never: none; a test always goes.
    notifier.prefs.set(undefined, 'threats', 'off');
    clock.t += 7 * 3_600_000; await threat();
    assert.equal(ntfy.got.length, 2);
    await notifier.notify({ title: 'Kova notifications work', body: '', tag: 'test' });
    assert.equal(ntfy.got.length, 3);
    // The doorbell (every time by default) isn't touched by any of that.
    await notifier.notify({ title: 'Ring', body: '', tag: 'ring-doorbell' }); await notifier.notify({ title: 'Ring', body: '', tag: 'ring-doorbell' });
    assert.equal(ntfy.got.length, 5);
  } finally { await done(); }
});

test('Notify choices: each person their own (falling back to the household’s), forgotten with them; the API', async () => {
  const { NotifyPrefs, kindOf, cleanPref } = await import('../src/services/notify-prefs.ts');
  const t = await testHub(12);
  try {
    const p = new NotifyPrefs(t.hub.store);
    assert.deepEqual(['ring-front', 'security-hall-person', 'everyone-out', 'offline-x', 'link-adapter:helix', 'internet', 'warden-new-device', 'warden-threat', 'power-router', 'automation-a1', 'kova-update', 'insight-filter', 'test', undefined].map(kindOf),
      ['doorbell', 'camera', 'everyoneOut', 'offline', 'links', 'internet', 'newDevice', 'threats', 'power', 'automations', 'updates', 'home', null, null]);
    assert.equal(cleanPref('6'), 6);
    assert.throws(() => cleanPref(3), /every 6 hours/);
    assert.throws(() => p.set('sam', 'nope', 'on'), /isn’t a kind/);
    p.set(undefined, 'doorbell', 'off');
    assert.equal(p.of('sam').doorbell, 'off', 'no choice of their own: the household’s');
    p.set('sam', 'doorbell', 'on');
    assert.equal(p.of('sam').doorbell, 'on');
    assert.equal(p.of(undefined).doorbell, 'off');
    assert.equal(p.of('sam').threats, 6, 'the default');
    // Held per person: Sam's gate doesn't hold back the household's.
    p.set('sam', 'home', 1); p.set(undefined, 'home', 1);
    assert.equal(p.gate('sam', 'home', 0).send, true);
    assert.equal(p.gate('sam', 'home', 1000).send, false);
    assert.equal(p.gate('*', 'home', 1000).send, true);
    assert.deepEqual(p.gate('sam', 'home', 3_600_000 + 1), { send: true, more: { n: 1, hours: 1 } });
    p.forget('sam');
    assert.equal(p.of('sam').doorbell, 'off');
  } finally { await t.hub.stop(); }

  const { hub, notifier, done } = await setup(12, { ntfy: undefined, rules: { network: false } });
  const app = await buildServer(hub, { webRoot, notifier, token: 'master' });
  try {
    const auth = { authorization: 'Bearer master' };
    const v = (await app.inject({ url: '/api/notify/prefs', headers: auth })).json();
    assert.equal(v.who, null);
    assert.equal(v.canHousehold, true);
    assert.equal(v.prefs.threats, 6);
    assert.ok(v.kinds.some((k: { id: string }) => k.id === 'doorbell'));
    assert.deepEqual(v.offForAll, ['internet', 'newDevice', 'threats', 'power'], 'Warden’s alerts switched off for the home');
    const r = await app.inject({ method: 'PUT', url: '/api/notify/prefs', headers: auth, payload: { kind: 'offline', value: 24 } });
    assert.equal(r.json().prefs.offline, 24);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/notify/prefs', headers: auth, payload: { kind: 'offline', value: 5 } })).statusCode, 400);
  } finally { await app.close(); await done(); }
});

test('Notify: a removed (hidden) device going offline is never said; one said already isn’t said again after a restart', async () => {
  const { hub, clock, virtual, ntfy, notifier, dataDir, done } = await setup(12);
  try {
    hub.config.update(c => { c.devices = { ...(c.devices ?? {}), kitchen_ceiling: { ...(c.devices?.kitchen_ceiling ?? {}), hidden: true } }; });
    hub.reg.reapplySettings();
    virtual.physical('kitchen_ceiling', { online: false });
    virtual.physical('lounge_main', { online: false });
    notifier.checkDevices();
    clock.t += 11 * 60_000; notifier.checkDevices();
    await notifier.idle();
    assert.deepEqual(ntfy.got.map(g => g.json.title), [`${hub.reg.get('lounge_main')!.name} isn’t responding`]);
    // Kova restarts (an update): the lamp, still offline, isn't news again.
    const again = new Notifier(hub, { ntfy: { url: ntfy.url, topic: 'kova-home' }, checkSec: 0 }, { dataDir });
    again.checkDevices(); clock.t += 11 * 60_000; again.checkDevices();
    await again.idle();
    assert.equal(ntfy.got.length, 1);
  } finally { await done(); }
});
