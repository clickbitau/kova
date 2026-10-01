import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { appLink, cleanRemote, connectAddresses, helloId, isLocalHost, localAddresses } from '../src/api/app-link.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const nets = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  wlan0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
} as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>;

test('Connect addresses: each private interface, then the remote one; containers and tunnels left out', () => {
  assert.deepEqual(localAddresses(8140, nets), ['http://192.168.1.20:8140', 'http://10.0.0.7:8140']);
  assert.equal(cleanRemote(' https://kova.example.ts.net/ '), 'https://kova.example.ts.net');
  assert.equal(cleanRemote('ftp://x'), null);
  assert.equal(cleanRemote('not a url'), null);
  assert.ok(isLocalHost('192.168.1.20') && isLocalHost('kova.local') && isLocalHost('kova'));
  assert.ok(!isLocalHost('kova.example.ts.net') && !isLocalHost('localhost') && !isLocalHost('100.101.102.103'));

  // Opened on the LAN by name: that name first, then the interfaces, then the remote address.
  const lan = connectAddresses({ headers: { host: 'kova.local:8140' }, protocol: 'http' }, 8140, 'https://kova.example.ts.net', nets);
  assert.deepEqual(lan, [
    { url: 'http://kova.local:8140', kind: 'local' },
    { url: 'http://192.168.1.20:8140', kind: 'local' },
    { url: 'http://10.0.0.7:8140', kind: 'local' },
    { url: 'https://kova.example.ts.net', kind: 'remote' },
  ]);
  // Opened over the remote address: it's listed once, as remote.
  const away = connectAddresses({ headers: { host: 'kova.example.ts.net', 'x-forwarded-proto': 'https' }, protocol: 'http' }, 8140, 'https://kova.example.ts.net', nets);
  assert.deepEqual(away.map(a => a.kind), ['local', 'local', 'remote']);
  // A reverse proxy the hub wasn't told about still counts as a way in.
  const proxy = connectAddresses({ headers: { host: 'home.example.com', 'x-forwarded-proto': 'https' }, protocol: 'http' }, 8140, undefined, nets);
  assert.deepEqual(proxy.at(-1), { url: 'https://home.example.com', kind: 'remote' });

  assert.equal(appLink('http://192.168.1.20:8140', 'sekret', { alt: ['http://192.168.1.20:8140', 'https://kova.example.ts.net'], hubId: 'abc' }),
    'kova://connect?url=http%3A%2F%2F192.168.1.20%3A8140&token=sekret&hub=abc&alt=https%3A%2F%2Fkova.example.ts.net');
});

test('Connect addresses: /api/hello needs no token and gives nothing away; the address list and the code need the token', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: 'sekret', hubId: () => 'KOVA-TEST-0000-0001', remoteUrl: () => 'https://kova.example.ts.net/' });
  try {
    const hello = await app.inject({ method: 'GET', url: '/api/hello' });
    assert.equal(hello.statusCode, 200);
    const h = hello.json();
    assert.deepEqual(Object.keys(h).sort(), ['hubId', 'kova', 'version']);
    assert.equal(h.kova, true);
    assert.equal(h.hubId, helloId('KOVA-TEST-0000-0001'));
    assert.notEqual(h.hubId, 'KOVA-TEST-0000-0001', 'an opaque fingerprint, not the licence ID');
    assert.doesNotMatch(hello.body, /sekret/);

    assert.equal((await app.inject({ method: 'GET', url: '/api/connect/addresses' })).statusCode, 401);
    const auth = { authorization: 'Bearer sekret', host: '192.168.1.20:8140' };
    const r = (await app.inject({ method: 'GET', url: '/api/connect/addresses', headers: auth })).json();
    assert.equal(r.hubId, h.hubId);
    assert.deepEqual(r.addresses[0], { url: 'http://192.168.1.20:8140', kind: 'local' });
    assert.deepEqual(r.addresses.at(-1), { url: 'https://kova.example.ts.net', kind: 'remote' });

    const link = (await app.inject({ method: 'GET', url: '/api/app-link', headers: auth })).json();
    const u = new URL(link.link);
    assert.equal(u.searchParams.get('url'), 'http://192.168.1.20:8140');
    assert.equal(u.searchParams.get('token'), 'sekret');
    assert.equal(u.searchParams.get('hub'), h.hubId);
    assert.ok(u.searchParams.getAll('alt').includes('https://kova.example.ts.net'));
    assert.ok(!u.searchParams.getAll('alt').includes('http://192.168.1.20:8140'), 'the first address is not repeated');
  } finally {
    await app.close();
    await t.hub.stop();
  }
});

test('Connect addresses: a hub with no ID says so, and no remote address is listed when none is set', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, hubId: () => null, remoteUrl: () => undefined });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/hello' })).json().hubId, null);
    const r = (await app.inject({ method: 'GET', url: '/api/connect/addresses', headers: { host: '192.168.1.20:8140' } })).json();
    assert.ok(r.addresses.every((a: { kind: string }) => a.kind === 'local'));
  } finally {
    await app.close();
    await t.hub.stop();
  }
});
