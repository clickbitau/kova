import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { Notifier } from '../src/services/notify.ts';
import { appLink, lanBase } from '../src/api/app-link.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

/** A fake Expo push service: records messages; tokens containing "gone" are no longer registered. */
async function fakeExpo() {
  const got: Record<string, any>[][] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const msgs = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { to: string }[];
      got.push(msgs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: msgs.map(m => m.to.includes('gone') ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' }) }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/push`, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('Phone app: register for notifications, get them (per person), drop phones that are gone', async () => {
  const expo = await fakeExpo();
  const t = await testHub(12);
  const dir = mkdtempSync(join(tmpdir(), 'kova-app-'));
  const notifier = new Notifier(t.hub, { expo: { url: expo.url }, checkSec: 0 }, { dataDir: dir });
  notifier.start();
  const app = await buildServer(t.hub, { webRoot, notifier });
  try {
    const reg = (body: object) => app.inject({ method: 'POST', url: '/api/push/app', payload: body });
    assert.equal((await reg({ token: 'not-a-token' })).statusCode, 400);
    assert.equal((await reg({ token: 'ExponentPushToken[abc]', personId: 'nobody' })).statusCode, 400);
    assert.equal((await reg({ token: 'ExponentPushToken[methel1]', personId: 'methel', name: 'Methel’s iPhone', platform: 'ios' })).statusCode, 200);
    assert.equal((await reg({ token: 'ExponentPushToken[brishti1]', personId: 'brishti' })).statusCode, 200);
    assert.equal((await reg({ token: 'ExponentPushToken[gone1]' })).statusCode, 200);
    assert.equal(notifier.appPhones().length, 3);

    // Everyone gets a general notification, with the link the app opens on a tap.
    const r = await notifier.notify({ title: 'Someone’s at the front door', body: 'Doorbell rang.', url: '/phone.html?cam=doorbell', tag: 'ring-doorbell' });
    assert.equal(r.app, 2);
    assert.equal(r.removed, 1, 'the phone Expo says is gone is dropped');
    assert.deepEqual(expo.got[0].map(m => m.to).sort(), ['ExponentPushToken[brishti1]', 'ExponentPushToken[gone1]', 'ExponentPushToken[methel1]']);
    assert.equal(expo.got[0][0].title, 'Someone’s at the front door');
    assert.equal(expo.got[0][0].data.url, '/phone.html?cam=doorbell');
    assert.deepEqual(notifier.appPhones().map(a => a.token).sort(), ['ExponentPushToken[brishti1]', 'ExponentPushToken[methel1]']);

    // One person's notification goes to their phone only (and phones with nobody set).
    await notifier.notify({ title: 'For Methel', body: 'x', people: ['methel'] });
    assert.deepEqual(expo.got[1].map(m => m.to), ['ExponentPushToken[methel1]']);
    assert.match(notifier.status().note ?? '', /2 phones subscribed/);

    assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/push/app', payload: { token: 'ExponentPushToken[methel1]' } })).json(), { ok: true });
    assert.equal(notifier.appPhones().length, 1);
  } finally {
    await notifier.stop();
    await app.close();
    await t.hub.stop();
    await expo.close();
  }
});

test('Phone app: the connect code carries a reachable address and the token; the snapshot has the home’s location', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: 'sekret' });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/app-link' })).statusCode, 401, 'only for callers who have the token');
    const r = await app.inject({ method: 'GET', url: '/api/app-link', headers: { authorization: 'Bearer sekret', host: '192.168.1.20:8140' } });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.url, 'http://192.168.1.20:8140');
    // (Then the hub's other addresses as alt=…, which depend on this machine's interfaces.)
    assert.ok(j.link.startsWith('kova://connect?url=http%3A%2F%2F192.168.1.20%3A8140&token=sekret'), j.link);
    assert.match(j.qrSvg, /^<svg/);
    const st = (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer sekret' } })).json();
    assert.deepEqual(st.home.location, { latitude: t.hub.config.get().latitude, longitude: t.hub.config.get().longitude });
  } finally {
    await app.close();
    await t.hub.stop();
  }
  // Opened on the hub itself (localhost): the code uses the hub's LAN address instead.
  const nets = { eth0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }] } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
  assert.equal(lanBase({ headers: { host: 'localhost:8140' }, protocol: 'http' }, 8140, nets), 'http://10.0.0.7:8140');
  assert.equal(lanBase({ headers: { host: 'kova.example.com', 'x-forwarded-proto': 'https' }, protocol: 'http' }, 8140, nets), 'https://kova.example.com');
  assert.equal(appLink('http://10.0.0.7:8140'), 'kova://connect?url=http%3A%2F%2F10.0.0.7%3A8140');
});
