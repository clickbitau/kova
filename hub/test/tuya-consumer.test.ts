import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { ConsumerApi, importFromSession, qrPoll, qrStart, LINK_CLIENT_ID, type ConsumerSession } from '../src/adapters/tuya/consumer.ts';
import { mergeCloudDevices } from '../src/adapters/tuya/cloud.ts';
import { buildServer } from '../src/api/server.ts';
import { testHub } from './helpers.ts';

// ------------------------------------------------ fake Smart Life link + consumer API --
// Decryption and signature are recomputed here from the documented recipe, independently of consumer.ts.

const GATEWAY = 'bfd2f3de48cd1a8966flvu';

const secretOf = (rid: string, refresh: string) => createHmac('sha256', rid).update(createHash('md5').update(rid + refresh).digest('hex')).digest('hex').slice(0, 16);
const hashKeyOf = (rid: string, refresh: string) => createHash('md5').update(rid + refresh).digest('hex');

function enc(raw: string, secret: string): string {
  const nonce = Buffer.from('aabbccddeeff', 'utf8');
  const c = createCipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), nonce);
  return nonce.toString('base64') + Buffer.concat([c.update(raw, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
function dec(encdata: string, secret: string): string {
  const buf = Buffer.from(encdata, 'base64');
  const d = createDecipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

const DJ_SPEC = {
  category: 'dj',
  functions: [
    { code: 'switch_led', dp_id: 20, type: 'Boolean', values: '{}' },
    { code: 'bright_value_v2', dp_id: 22, type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: 'colour_data_v2', dp_id: 24, type: 'Json', values: '{"h":{"min":0,"max":360},"s":{"min":0,"max":1000},"v":{"min":0,"max":1000}}' },
  ],
  status: [{ code: 'switch_led', dp_id: 20, type: 'Boolean', values: '{}' }],
};

function fakeTuya(consumerBase: () => string) {
  let approved = false;
  let access = 'access1';
  let curRefresh = 'refresh0123456789ab';
  let refreshes = 0;
  const calls: string[] = [];
  const errors: string[] = [];
  const ok = (result: unknown) => ({ success: true, t: Date.now(), result });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = req.url!;
      const h = req.headers as Record<string, string>;
      calls.push(`${req.method} ${url.split('?')[0]}`);
      const send = (j: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };

      // The unauthenticated QR-link half.
      if (url.startsWith('/v1.0/m/life/home-assistant/qrcode/tokens')) {
        if (req.method === 'POST') {
          const q = new URLSearchParams(url.split('?')[1]);
          if (q.get('clientid') !== LINK_CLIENT_ID) errors.push('wrong clientid');
          if (q.get('usercode') !== 'CxUwQLo') errors.push('wrong usercode');
          if (q.get('schema') !== 'haauthorize') errors.push('wrong schema');
          return send(ok({ qrcode: 'qrtoken1' }));
        }
        if (!approved) return send({ success: false, code: 'waiting', msg: 'not scanned yet' });
        return send(ok({ uid: 'uid1', expire_time: 7200, access_token: access, refresh_token: 'refresh0123456789ab', endpoint: consumerBase() }));
      }

      // The signed, encrypted consumer half. Every request is verified and answered the way Tuya does.
      const rid = h['x-requestid'] ?? '';
      const secret = secretOf(rid, curRefresh);
      const hashKey = hashKeyOf(rid, curRefresh);
      const u = new URL(url, 'http://x');
      const qEnc = u.searchParams.get('encdata') ?? '';
      const bEnc = body ? (JSON.parse(body).encdata ?? '') : '';
      const signStr = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
        .map(k => [k, h[k.toLowerCase()] ?? ''] as const)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${v}`).join('||') + qEnc + bEnc;
      const want = createHmac('sha256', Buffer.from(hashKey, 'utf8')).update(signStr).digest('hex');
      if (h['x-sign'] !== want) { errors.push(`bad sign on ${u.pathname}`); return send({ success: false, code: 1004, msg: 'sign invalid' }); }
      if (h['x-appkey'] !== LINK_CLIENT_ID) errors.push('wrong appKey');
      const reply = (result: unknown) => send(ok(enc(JSON.stringify(result), secret)));

      if (u.pathname === `/v1.0/m/token/${curRefresh}`) {
        refreshes++;
        access = `access${1 + refreshes}`;
        curRefresh = `refresh${refreshes}rotated`;
        return reply({ uid: 'uid1', expireTime: 7200, accessToken: access, refreshToken: curRefresh });
      }
      if (h['x-token'] !== access) return send({ success: false, code: 1010, msg: 'token invalid' });

      if (u.pathname === '/v1.0/m/life/users/homes') return reply([{ ownerId: '99127', name: 'The Ahmeds' }]);
      if (u.pathname === '/v1.0/m/life/ha/home/devices') {
        const params = JSON.parse(dec(qEnc, secret));
        if (String(params.homeId) !== '99127') errors.push('wrong homeId');
        return reply([
          { id: GATEWAY, name: 'Zigbee Gateway', local_key: 'gwkey0123456789a', category: 'wg2', product_name: 'Gateway', online: true, ip: '203.0.113.9' },
          { id: 'a4c138zigbee0002', name: 'Bedroom LED', local_key: 'bedkey0123456789', category: 'dj', product_name: 'LED strip', sub: true, node_id: 'a4c13802', gateway_id: GATEWAY, online: true },
          { id: 'a4c138zigbee0003', name: 'TV Unit LED', local_key: 'tvukey0123456789', category: 'dj', product_name: 'LED strip', sub: true, node_id: 'a4c13803', gateway_id: GATEWAY, online: true },
          { id: 'a4c138zigbee0004', name: 'Office LED', local_key: 'offkey0123456789', category: 'dj', product_name: 'LED strip', sub: true, node_id: 'a4c13804', gateway_id: GATEWAY, online: true },
        ]);
      }
      const spec = /^\/v1\.1\/m\/life\/([^/]+)\/specifications$/.exec(u.pathname);
      if (spec) return reply(DJ_SPEC);
      errors.push(`unexpected ${u.pathname}`);
      send({ success: false, code: 404, msg: 'no such api' });
    });
  });
  return { server, calls, errors, approve: () => { approved = true; }, refreshes: () => refreshes };
}

async function withTuya<T>(fn: (base: string, fake: ReturnType<typeof fakeTuya>) => Promise<T>): Promise<T> {
  let base = '';
  const fake = fakeTuya(() => base);
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  try { return await fn(base, fake); } finally { fake.server.close(); }
}

const REFRESH = 'refresh0123456789ab';
const session: ConsumerSession = { endpoint: '', userCode: 'CxUwQLo', uid: 'uid1', accessToken: 'access1', refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 };

test('Tuya link: QR mint asks for the HA schema with the account’s user code', async () => {
  await withTuya(async (base, fake) => {
    const qr = await qrStart('CxUwQLo', undefined, base);
    assert.equal(qr, 'qrtoken1');
    assert.deepEqual(fake.errors, []);
  });
});

test('Tuya link: poll is null until scanned, then yields the session', async () => {
  await withTuya(async (base, fake) => {
    assert.equal(await qrPoll('qrtoken1', 'CxUwQLo', undefined, base), null);
    fake.approve();
    const hit = await qrPoll('qrtoken1', 'CxUwQLo', undefined, base);
    assert.ok(hit);
    assert.equal(hit.session.uid, 'uid1');
    assert.equal(hit.session.accessToken, 'access1');
    assert.equal(hit.session.refreshToken, 'refresh0123456789ab');
    assert.equal(hit.session.endpoint, base);
    assert.equal(hit.session.userCode, 'CxUwQLo');
    assert.ok(hit.session.expiresAt > Date.now());
  });
});

test('Consumer API: signed encrypted calls list homes, devices with keys, and specifications', async () => {
  await withTuya(async (base, fake) => {
    const { devices } = await importFromSession({ ...session, endpoint: base });
    assert.equal(devices.length, 4);
    const gw = devices.find(d => d.id === GATEWAY);
    assert.ok(gw);
    assert.equal(gw.key, 'gwkey0123456789a');
    const subs = devices.filter(d => d.sub);
    assert.equal(subs.length, 3);
    assert.deepEqual(subs.map(s => s.nodeId).sort(), ['a4c13802', 'a4c13803', 'a4c13804']);
    assert.ok(subs.every(s => s.gatewayId === GATEWAY && s.key));
    assert.ok(subs.every(s => (s.spec ?? []).length === 3), 'each sub-device fetched its specification');
    assert.deepEqual(fake.errors, []);
  });
});

test('Consumer import merges into a tuya section: gateway plus its sub-devices', async () => {
  await withTuya(async (base, fake) => {
    const { devices } = await importFromSession({ ...session, endpoint: base });
    const { tuya, devices: report } = mergeCloudDevices(undefined, devices);
    const gw = tuya.devices.find(d => d.id === GATEWAY);
    assert.ok(gw, 'the gateway itself is a device entry');
    const subs = tuya.devices.filter(d => d.gateway === GATEWAY);
    assert.equal(subs.length, 3);
    for (const s of subs) {
      assert.ok(s.cid, 'sub-device carries its node id as cid');
      assert.ok(s.light, 'LED sub-devices mapped as lights');
      assert.ok(s.light!.id, 'each got a Kova id');
    }
    assert.equal(report.filter(r => r.status === 'added').length, 4);
    assert.deepEqual(fake.errors, []);
  });
});

test('Consumer API: a dead access token refreshes first, and the rotated session is kept', async () => {
  await withTuya(async (base, fake) => {
    const api = new ConsumerApi({ ...session, endpoint: base, expiresAt: 0 });
    const homes = await api.homes();
    assert.equal(homes[0].id, '99127');
    assert.equal(fake.refreshes(), 1);
    assert.equal(api.session.accessToken, 'access2');
    assert.equal(api.session.refreshToken, 'refresh1rotated');
    assert.deepEqual(fake.errors, []);
  });
});

test('QR link over the API: shows a scannable code, polls, imports the devices and keeps the session', async () => {
  await withTuya(async (base, fake) => {
    const dir = mkdtempSync(join(tmpdir(), 'kova-tuya-link-'));
    const path = join(dir, 'integrations.json');
    const { hub } = await testHub();
    const app = await buildServer(hub, { webRoot: resolve(import.meta.dirname, '../../web'), integrationsPath: path, tuyaCloud: { discoverMs: 0 }, tuyaLink: { base } });
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/integrations/tuya/qr-pair', payload: {} });
      assert.equal(bad.statusCode, 400);
      const start = await app.inject({ method: 'POST', url: '/api/integrations/tuya/qr-pair', payload: { userCode: 'CxUwQLo' } });
      assert.equal(start.statusCode, 200);
      const first = start.json() as { code?: string; qrSvg?: string; next?: string };
      assert.equal(first.code, 'qrtoken1');
      assert.ok(first.qrSvg?.includes('<svg'), 'a scannable SVG came back');
      assert.ok(first.next?.includes('Smart Life'));

      const pending = await app.inject({ method: 'GET', url: '/api/integrations/tuya/qr-pair' });
      assert.equal((pending.json() as { status: string }).status, 'pending');

      fake.approve();
      const done = await app.inject({ method: 'GET', url: '/api/integrations/tuya/qr-pair' });
      const body = done.json() as { status: string; devices?: { id: string; status: string }[] };
      assert.equal(body.status, 'approved');
      assert.equal(body.devices?.filter(d => d.status === 'added').length, 4);

      const saved = JSON.parse(readFileSync(path, 'utf8')) as { tuya?: { devices?: { id: string; gateway?: string; cid?: string; key?: string }[]; session?: { accessToken?: string; refreshToken?: string; endpoint?: string } } };
      const gw = saved.tuya?.devices?.find(d => d.id === GATEWAY);
      assert.ok(gw);
      assert.equal(gw!.key, 'gwkey0123456789a');
      assert.equal(saved.tuya?.devices?.filter(d => d.gateway === GATEWAY).length, 3);
      assert.equal(saved.tuya?.session?.accessToken, 'access1', 'the session is kept for a later pull');
      assert.equal(saved.tuya?.session?.endpoint, base);
      assert.deepEqual(fake.errors, []);
    } finally { await app.close(); }
  });
});
