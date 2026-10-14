import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { constants, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { EcovacsAdapter, activityToState, commandFor, continentFor, ecovacsUrls, isJsonVacuum, signParams, toActivity } from '../src/adapters/ecovacs.ts';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const sign = (p: Record<string, string>, extra: Record<string, string>, key: string, secret: string) => {
  const all = { ...p, ...extra };
  delete (all as Record<string, string>).authSign; delete (all as Record<string, string>).authAppkey;
  return md5(key + Object.keys(all).sort().map(k => `${k}=${all[k]}`).join('') + secret);
};

// A fake Ecovacs cloud: account login, auth code, portal login, device list and the IoT command relay
// to one T50 OMNI. Login, auth and portal live under different prefixes to check each base URL is used.
function fakeCloud(email: string, password: string) {
  let token = '';
  let n = 0;
  const bot = { activity: 'docked' as string, battery: 100, speed: 1, customAmount: 28, mode: 0, count: 1, carpet: 1, block: { enable: 0, start: '22:0', end: '8:0' }, station: 0, autoEmpty: 1, life: { brush: 9701, sideBrush: 0, heap: 7200, roundMop: 1424, dustBag: 2727, unitCare: 1260 } as Record<string, number>, mts: 100 };
  // The T50's map: two areas (a kitchen-shaped square and a hall) and their outline, as getMapInfo_V2 / getMapSet_V2 send them.
  const z = (j: unknown) => zstdCompressSync(Buffer.from(JSON.stringify(j))).toString('base64');
  const subsets = z([['0', '', '0', '2', '0', '500', '-500', '1-0-2', ' ', '1'], ['2', 'Hall', '0', '0', '0', '1500', '-500', '1-0-2', ' ', '1']]);
  const info = z([['1', '0;0,0,2;1000,0,2;1000,-1000,2;0,-1000,3-1-0'], ['2', '0;0,0;1000,0;1000,-1000;0,-1000', '2;1000,0;2000,0;2000,-1000;1000,-1000']]);
  const calls: { cmdName: string; data?: unknown; body: Record<string, any>; query: URLSearchParams }[] = [];
  const state = { logins: 0, portalLogins: 0, needsVerify: false, codesSent: 0, verified: 0, expire: () => { token = 'expired-' + token; } };
  // Ecovacs' published key for encrypting the account in the email-verification calls.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const decrypt = (b64: string | null) => privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(String(b64), 'base64')).toString();
  const devices = [
    { did: 'e0001234-aaaa-bbbb-cccc-t50omni00001', name: 'E0001234', class: 'lf3bn4', resource: 'Hrk3', nick: 'Deebot', company: 'eco-ng', deviceName: 'DEEBOT T50 OMNI', status: 1, product_category: 'DEEBOT' },
    { did: 'e0009999-offline0000000002', name: 'E0009999', class: 'lf3bn4', resource: 'Xy12', nick: 'Upstairs', company: 'eco-ng', deviceName: 'DEEBOT T50 OMNI', status: 0 },
    { did: 'legacy01', name: 'E0000001', class: '126', resource: 'atom', nick: 'Old bot', company: 'eco-legacy', deviceName: 'DEEBOT 900' },
    { did: 'winbot01', name: 'W1', class: 'winb', resource: 'w', nick: 'Window', company: 'eco-ng', product_category: 'WINBOT' },
  ];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const q = url.searchParams;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const send = (j: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      const priv = url.pathname.match(/^\/login\/v1\/private\/(\w+)\/EN\/([0-9a-f]{32})\/global_e\/([\d.]+)\/google_play\/1\/([\w/]+)$/);
      if (priv) {
        const [, country, deviceId, version, endpoint] = priv;
        if (version !== '3.14.0') return send({ code: '1011', msg: 'Please update to the latest version to continue.' }); // what Ecovacs says to old apps now
        const params = Object.fromEntries(q);
        const expected = sign(params, { country, deviceId, lang: 'EN', appCode: 'global_e', appVersion: version, channel: 'google_play', deviceType: '1' }, '1520391301804', '6c319b2a5cd3e66e39159c2e28f2fce9');
        assert.equal(q.get('authSign'), expected, `${endpoint} is signed`);
        assert.equal(q.get('authAppkey'), '1520391301804');
        if (endpoint === 'user/login') {
          if (q.get('account') !== email || q.get('password') !== md5(password)) return send({ code: '1005', msg: 'wrong password' });
          if (state.needsVerify) return send({ code: '1013', msg: 'verify this device' });
          state.logins++;
          return send({ code: '0000', msg: 'ok', data: { uid: 'u42', accessToken: 'acc42' } });
        }
        if (endpoint === 'common/getConfig') return send({ code: '0000', data: [{ key: 'PUBLIC.KEY.CONFIG', value: JSON.stringify({ publicKey }) }] });
        if (endpoint === 'user/sendEmailVerifyCode') {
          assert.equal(decrypt(q.get('encryptEmail')), email, 'email encrypted with the published key');
          assert.equal(q.get('verifyType'), 'EMAIL_VERIFY_DEVICE');
          state.codesSent++;
          return send({ code: '0000' });
        }
        if (endpoint === 'user/verifyDevice') {
          assert.equal(decrypt(q.get('encryptAccount')), email);
          if (q.get('verifyCode') !== '123456') return send({ code: '1012', msg: 'wrong code' });
          state.needsVerify = false; state.verified++; state.logins++;
          return send({ code: '0000', data: { uid: 'u42', accessToken: 'acc42' } });
        }
      }
      if (url.pathname === '/auth/v1/global/auth/getAuthCode') {
        const params = Object.fromEntries(q);
        assert.equal(q.get('authSign'), sign(params, { openId: 'global' }, '1520391491841', '77ef58ce3afbe337da74aa8c5ab963a9'), 'auth code is signed');
        if (q.get('uid') !== 'u42' || q.get('accessToken') !== 'acc42' || q.get('bizType') !== 'ECOVACS_IOT') return send({ code: '0001', msg: 'bad token' });
        return send({ code: '0000', data: { authCode: 'code42', ecovacsUid: 'eco42' } });
      }
      if (url.pathname === '/api/users/user.do') {
        assert.equal(body.todo, 'loginByItToken');
        assert.equal(body.country, 'AU');
        assert.equal(body.org, 'ECOWW');
        if (body.token !== 'code42' || body.userId !== 'eco42') return send({ result: 'fail', error: 'bad code' });
        state.portalLogins++;
        token = `tok${++n}`;
        return send({ result: 'ok', userId: 'eco42', resource: body.resource, token, last: '' });
      }
      if (body.auth?.token !== token || body.auth?.userid !== 'eco42' || body.auth?.realm !== 'ecouser.net') return send({ ret: 'fail', errno: 3, error: 'auth error' });
      if (url.pathname === '/api/appsvr/app.do') {
        assert.equal(body.todo, 'GetGlobalDeviceList');
        return send({ code: 0, devices });
      }
      if (url.pathname === '/api/iot/devmanager.do') {
        calls.push({ cmdName: body.cmdName, data: body.payload.body.data, body, query: q });
        if (body.toId !== devices[0].did) return send({ ret: 'fail', errno: 500, debug: 'wait for response timed out' });
        const ok = (data: unknown = undefined) => send({ ret: 'ok', resp: { header: {}, body: { code: 0, msg: 'ok', ...(data ? { data } : {}) } }, id: 'x' });
        const d = body.payload.body.data;
        switch (body.cmdName) {
          case 'getBattery': return ok({ value: bot.battery, isLow: 0 });
          case 'getChargeState': return ok({ isCharging: bot.activity === 'docked' ? 1 : 0, mode: 'slot' });
          case 'getCleanInfo_V2': return ok(
            bot.activity === 'cleaning' ? { trigger: 'app', state: 'clean', cleanState: { router: 'plan', motionState: 'working', content: { type: 'auto' } } }
              : bot.activity === 'paused' ? { trigger: 'app', state: 'clean', cleanState: { motionState: 'pause' } }
                : bot.activity === 'returning' ? { trigger: 'app', state: 'goCharging' }
                  : bot.activity === 'error' ? { trigger: 'alert', state: 'idle' } : { trigger: 'none', state: 'idle' });
          case 'clean_V2': bot.activity = d.act === 'pause' ? 'paused' : d.act === 'stop' ? 'idle' : 'cleaning'; return ok();
          case 'charge': bot.activity = 'returning'; return ok();
          case 'getStationState': return ok({ content: { error: [314], motionState: bot.station ? 1 : 0, type: bot.station }, state: bot.station ? 1 : 0 });
          case 'getError': return ok({ code: [] });
          case 'getStats': return ok({ area: 44, time: 3600, start: '1791949918' });
          case 'getSpeed': return ok({ speed: bot.speed });
          case 'setSpeed': bot.speed = d.speed; return ok();
          case 'getWaterInfo': return ok({ customAmount: bot.customAmount, enable: 1, mopCount: 2, sweepType: 1, type: 1 });
          case 'setWaterInfo': bot.customAmount = d.customAmount; return ok();
          case 'getWorkMode': return ok({ mode: bot.mode });
          case 'setWorkMode': bot.mode = d.mode; return ok();
          case 'getCleanCount': return ok({ count: bot.count });
          case 'setCleanCount': bot.count = d.count; return ok();
          case 'getCarpertPressure': return ok({ enable: bot.carpet });
          case 'setCarpertPressure': bot.carpet = d.enable; return ok();
          case 'getTrueDetect': return ok({ enable: 1, level: 1 });
          case 'getChildLock': return ok({ on: 0 });
          case 'getVolume': return ok({ total: 10, volume: 10 });
          case 'getBreakPoint': return ok({ enable: 1 });
          case 'getBlock': return ok(bot.block);
          case 'setBlock': bot.block = d; return ok();
          case 'getVoiceAssistantState': return ok({ enable: 1, lifeRemind: 1, wakeupWord: 0 });
          case 'getAutoEmpty': return ok({ enable: bot.autoEmpty, frequency: 'auto', intensity: 0, status: 0 });
          case 'getDryingDuration': return ok({ duration: 240 });
          case 'getTotalStats': return ok({ area: 4820, count: 256, time: 446811 });
          case 'getNetInfo': return ok({ ip: '10.0.0.9', rssi: '-50', ssid: 'Home' });
          case 'getOta': return ok({ autoSwitch: 0, supportAuto: 1, status: 'idle', ver: '1.123.127' });
          case 'getLifeSpan': {
            // The real bot fails the whole ask for a part it doesn't have ("format error"), and wants a plain list.
            if (!Array.isArray(d) || d.some((t: string) => !(t in bot.life))) return send({ ret: 'ok', resp: { body: { code: 20003, msg: 'format error' } } });
            return ok(d.map((t: string) => ({ type: t, left: bot.life[t], total: t === 'brush' ? 18000 : t === 'unitCare' ? 1800 : t === 'dustBag' ? 3000 : t === 'heap' ? 7200 : 9000 })));
          }
          case 'resetLifeSpan': bot.life[d.type] = 99999; return ok();
          case 'getCachedMapInfo': return ok({ enable: 1, info: [{ index: 0, mid: '0', using: 0 }, { index: 1, mid: '7808', mts: bot.mts, name: 'Home', using: 1 }] });
          case 'getMapSet_V2': assert.deepEqual(d, { mid: '7808', type: 'ar' }); return ok({ mid: '7808', type: 'ar', subsets });
          case 'getMapInfo_V2': assert.deepEqual(d, { mid: '7808', type: '0' }); return ok({ mid: '7808', info, outlineVer: '1' });
          case 'getPos': assert.deepEqual(d, ['chargePos']); return ok({ chargePos: [{ x: 500, y: -900, a: 0, invalid: 0 }], mid: '7808' });
          case 'stationAction': bot.station = d.type === 4 ? 3 : d.type; return ok();
          case 'setTrueDetect': assert.deepEqual(d, { enable: 0, level: 1 }); return ok();
          case 'playSound': case 'setChildLock': case 'setVolume': return ok();
          case 'setAutoEmpty': bot.autoEmpty = d.enable; return ok();
          default: return send({ ret: 'ok', resp: { body: { code: 20001, msg: 'unknown command' } } });
        }
      }
      res.statusCode = 404; res.end();
    });
  });
  return { server, bot, calls, state };
}

async function setup(password = 'hunter2', opts: Record<string, unknown> = {}) {
  const fake = fakeCloud('me@example.com', 'hunter2');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  const ev = new EcovacsAdapter({
    email: 'me@example.com', password, country: 'au', pollMs: 0, refreshMs: 0,
    urls: { login: `${base}/login`, auth: `${base}/auth`, portal: `${base}/api` }, ...opts,
  });
  await reg.addAdapter(ev);
  const done = async () => { await reg.stop(); fake.server.close(); };
  return { fake, reg, ev, done };
}

const core = (s: import('../src/model/types.ts').DeviceState) => ({ on: s.on, activity: s.activity, battery: s.battery, online: s.online });
const sent = (calls: { cmdName: string; data?: unknown }[]) => calls.filter(c => !c.cmdName.startsWith('get')).map(c => ({ cmdName: c.cmdName, data: c.data }));

test('Ecovacs: logs in, lists vacuums, and reports activity and battery', async () => {
  const { fake, reg, ev, done } = await setup('hunter2', { rooms: { Deebot: 'living_room' }, ids: { Deebot: 'living_vacuum' } });
  try {
    assert.equal(fake.state.logins, 1);
    assert.equal(fake.state.portalLogins, 1);
    assert.deepEqual(reg.list().map(d => d.id).sort(), ['ecovacs_ne0000000002', 'living_vacuum'], 'JSON DEEBOTs only: no legacy bot, no Winbot');
    const d = reg.get('living_vacuum')!;
    assert.equal(d.type, 'vacuum');
    assert.equal(d.name, 'Deebot');
    assert.equal(d.room, 'living_room');
    assert.equal(d.integration, 'Ecovacs DEEBOT T50 OMNI');
    assert.deepEqual(d.capabilities, ['onoff', 'vacuum', 'battery']);
    assert.deepEqual(core(d.state), { on: false, activity: 'docked', battery: 100, online: true });
    const up = reg.get('ecovacs_ne0000000002')!;
    assert.equal(up.state.online, false, 'status 0 in the device list = offline');
    assert.equal(up.room, 'unassigned');
    assert.equal(ev.status().ok, false);
    assert.match(ev.status().note!, /1 of 2 offline/);

    // Started from the Ecovacs app: shows up on the next poll.
    fake.bot.activity = 'cleaning'; fake.bot.battery = 64;
    await ev.poll();
    assert.deepEqual(core(reg.get(d.id)!.state), { on: true, activity: 'cleaning', battery: 64, online: true });
    fake.bot.activity = 'paused';
    await ev.poll();
    assert.deepEqual(core(reg.get(d.id)!.state), { on: false, activity: 'paused', battery: 64, online: true });
    fake.bot.activity = 'error';
    await ev.poll();
    assert.equal(reg.get(d.id)!.state.activity, 'error');
  } finally { await done(); }
});

test('Ecovacs: on/off start, resume and dock with the exact JSON commands', async () => {
  const { fake, reg, ev, done } = await setup('hunter2', { ids: { Deebot: 'vac' } });
  try {
    fake.calls.length = 0;
    await reg.command('vac', { on: true }, { kind: 'user', label: 'You' });
    assert.deepEqual(sent(fake.calls), [{ cmdName: 'clean_V2', data: { act: 'start', content: { type: 'auto' } } }]);
    const c = fake.calls.find(x => x.cmdName === 'clean_V2')!;
    assert.equal(c.body.toId, 'e0001234-aaaa-bbbb-cccc-t50omni00001');
    assert.equal(c.body.toType, 'lf3bn4');
    assert.equal(c.body.toRes, 'Hrk3');
    assert.equal(c.body.payloadType, 'j');
    assert.equal(c.body.td, 'q');
    assert.equal(c.body.payload.header.pri, '1');
    assert.equal(c.query.get('did'), 'e0001234-aaaa-bbbb-cccc-t50omni00001');
    assert.equal(c.query.get('mid'), 'lf3bn4');
    assert.deepEqual(core(reg.get('vac')!.state), { on: true, activity: 'cleaning', battery: 100, online: true });
    assert.equal(fake.bot.activity, 'cleaning');

    fake.calls.length = 0;
    await reg.command('vac', { on: false }, { kind: 'user', label: 'You' });
    assert.deepEqual(sent(fake.calls), [{ cmdName: 'charge', data: { act: 'go' } }]);
    assert.equal(reg.get('vac')!.state.activity, 'returning');

    // Paused in the app → tapping resumes rather than starting over.
    fake.bot.activity = 'paused';
    await ev.poll();
    fake.calls.length = 0;
    await reg.command('vac', { on: true }, { kind: 'user', label: 'You' });
    assert.deepEqual(sent(fake.calls), [{ cmdName: 'clean_V2', data: { act: 'resume' } }]);

    fake.calls.length = 0;
    await reg.command('vac', { activity: 'paused' }, { kind: 'user', label: 'You' });
    assert.deepEqual(sent(fake.calls), [{ cmdName: 'clean_V2', data: { act: 'pause' } }]);

    // Getters carry no data.
    await ev.poll();
    const getter = fake.calls.find(x => x.cmdName === 'getBattery')!;
    assert.equal(getter.data, undefined);

    await assert.rejects(reg.command('ecovacs_ne0000000002', { on: true }, { kind: 'user', label: 'You' }), /timed out/);
  } finally { await done(); }
});

test('Ecovacs: logs in again once when the portal token expires', async () => {
  const { fake, reg, done } = await setup('hunter2', { ids: { Deebot: 'vac' } });
  try {
    assert.equal(fake.state.portalLogins, 1);
    fake.state.expire();
    await reg.command('vac', { on: true }, { kind: 'user', label: 'You' });
    assert.equal(fake.state.logins, 2);
    assert.equal(fake.state.portalLogins, 2);
    assert.equal(fake.bot.activity, 'cleaning');
  } finally { await done(); }
});

test('Ecovacs: a new device is verified with the code Ecovacs emails, asked for once', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  fake.state.needsVerify = true;
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const urls = { login: `${base}/login`, auth: `${base}/auth`, portal: `${base}/api` };
  const reg = new Registry(new Store(':memory:'));
  const first = new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0 });
  await reg.addAdapter(first);
  try {
    assert.equal(fake.state.codesSent, 1, 'Ecovacs was asked to email a code');
    assert.match(first.status().note!, /emailed you a code/);
    await first.poll();
    assert.equal(fake.state.codesSent, 1, 'not asked again while waiting for the code');
  } finally { await reg.stop(); }
  // The owner enters the code in the setup; the adapter restarts with it.
  const reg2 = new Registry(new Store(':memory:'));
  const second = new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0, verifyCode: ' 123456 ' });
  await reg2.addAdapter(second);
  try {
    assert.equal(fake.state.verified, 1);
    assert.doesNotMatch(second.status().note!, /code|login failed/, 'signed in');
    assert.ok(reg2.list().length > 0, 'vacuums listed after verifying');
  } finally { await reg2.stop(); fake.server.close(); }
});

test('Ecovacs: the session survives a restart, and the email ask is rate-limited', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  fake.state.needsVerify = true;
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const urls = { login: `${base}/login`, auth: `${base}/auth`, portal: `${base}/api` };
  const dir = mkdtempSync(join(tmpdir(), 'kova-eco-'));
  try {
    // First boot asks once; a "restart" before the code arrives does not email again.
    const reg = new Registry(new Store(':memory:'));
    await reg.addAdapter(new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0, storageDir: dir }));
    assert.equal(fake.state.codesSent, 1);
    await reg.stop();
    const reg2 = new Registry(new Store(':memory:'));
    const second = new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0, storageDir: dir });
    await reg2.addAdapter(second);
    assert.equal(fake.state.codesSent, 1, 'rate limited across restarts');
    assert.match(second.status().note!, /minutes ago/);
    await reg2.stop();
    // The code verifies the device; the session is saved, so the next restart needs no login at all.
    const reg3 = new Registry(new Store(':memory:'));
    await reg3.addAdapter(new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0, verifyCode: '123456', storageDir: dir }));
    assert.equal(fake.state.verified, 1);
    await reg3.stop();
    const { logins, portalLogins } = fake.state;
    const reg4 = new Registry(new Store(':memory:'));
    await reg4.addAdapter(new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', urls, pollMs: 0, storageDir: dir }));
    assert.equal(fake.state.logins, logins, 'no account login: session restored');
    assert.equal(fake.state.portalLogins, portalLogins);
    assert.ok(reg4.list().length > 0);
    await reg4.stop();
  } finally { fake.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Ecovacs: a wrong password is reported, not thrown, and not retried', async () => {
  const { fake, reg, ev, done } = await setup('nope');
  try {
    assert.equal(reg.list().length, 0);
    assert.equal(ev.status().ok, false);
    assert.match(ev.status().note!, /Wrong Ecovacs email or password/);
    await ev.poll();
    assert.equal(fake.state.logins, 0);
    assert.equal(fake.calls.length, 0);
  } finally { await done(); }
});

test('Ecovacs helpers', () => {
  assert.equal(continentFor('AU'), 'ww');
  assert.equal(continentFor('de'), 'eu');
  assert.equal(continentFor('us'), 'na');
  assert.deepEqual(ecovacsUrls('au'), { login: 'https://gl-au-api.ecovacs.com', auth: 'https://gl-au-openapi.ecovacs.com', portal: 'https://portal-ww.ecouser.net/api' });
  assert.equal(ecovacsUrls('de').portal, 'https://portal-eu.ecouser.net/api');
  assert.deepEqual(ecovacsUrls('cn'), { login: 'https://gl-cn-api.ecovacs.cn', auth: 'https://gl-cn-openapi.ecovacs.cn', portal: 'https://portal.ecouser.net/api' });
  const s = signParams({ b: '2', a: '1' }, { c: '3' }, { key: 'K', secret: 'S' });
  assert.deepEqual(s, { b: '2', a: '1', authAppkey: 'K', authSign: md5('Ka=1b=2c=3S') });
  assert.equal(toActivity({ state: 'clean', cleanState: { motionState: 'working' } }, false), 'cleaning');
  assert.equal(toActivity({ state: 'clean', cleanState: { motionState: 'goCharging' } }, false), 'returning');
  assert.equal(toActivity({ state: 'idle' }, true), 'docked');
  assert.equal(toActivity({ state: 'idle' }, false), 'idle');
  assert.equal(toActivity({ trigger: 'alert', state: 'idle' }, true), 'error');
  assert.deepEqual(activityToState('docked', 100), { on: false, activity: 'docked', online: true, battery: 100 });
  assert.deepEqual(commandFor({ on: true }, 'docked'), { name: 'clean_V2', data: { act: 'start', content: { type: 'auto' } } });
  assert.deepEqual(commandFor({ activity: 'idle' }, 'cleaning'), { name: 'clean_V2', data: { act: 'stop' } });
  assert.equal(commandFor({ battery: 5 }, 'docked'), null);
  assert.ok(isJsonVacuum({ did: 'x', class: 'c', resource: 'r', company: 'eco-ng' }));
  assert.ok(!isJsonVacuum({ did: 'x', class: 'c', resource: 'r', company: 'eco-legacy' }));
});

test('Ecovacs: everything the robot reports — how it cleans, station, wear, totals, settings, map areas', async () => {
  const { reg, ev, done } = await setup('hunter2', { ids: { Deebot: 'vac' } });
  try {
    const r = reg.get('vac')!.state.robot!;
    assert.equal(r.suction, 'max');
    assert.equal(r.mode, 'both');
    assert.equal(r.water, 28);
    assert.equal(r.waterMax, 50);
    assert.equal(r.passes, 1);
    assert.equal(r.mop, true);
    assert.equal(r.station, 'idle');
    assert.deepEqual(r.problems, [], 'an optional station module not fitted (314) is no problem');
    assert.deepEqual(r.last, { area: 44, minutes: 60 });
    assert.deepEqual(r.totals, { area: 4820, hours: 124, count: 256 });
    assert.deepEqual(r.parts!.map(p => [p.id, p.left]), [['brush', 54], ['sideBrush', 0], ['heap', 100], ['roundMop', 16], ['dustBag', 91], ['unitCare', 70]], 'learned part by part: the bot has no cleaning-solution part');
    assert.equal(r.parts![0]!.name, 'Main brush');
    assert.equal(r.parts![0]!.hoursLeft, 162);
    assert.deepEqual(r.areas, [{ id: '0', name: '' }, { id: '2', name: 'Hall' }]);
    assert.deepEqual(r.settings, { carpetBoost: true, obstacles: true, childLock: false, voice: 10, voiceMax: 10, resume: true, quiet: { on: false, start: '22:00', end: '08:00' }, voiceAssistant: true, autoUpdate: false, autoEmpty: true, dryMinutes: 240 });
    assert.equal(r.firmware, '1.123.127');
    assert.equal(r.wifi, -50);
    assert.equal(r.map, true);
    assert.equal(reg.get('vac')!.state.extras, null, 'no extras any more: it all has a place in robot');
    const map = ev.floorMap(reg.get('vac')!)!;
    assert.deepEqual(map.areas.map(a => [a.id, a.path, a.x, a.y]), [['0', 'M0 0L20 0L20 20L0 20Z', 10, 10], ['2', 'M20 0L40 0L40 20L20 20Z', 30, 10]]);
    assert.equal(map.walls, 'M0 0L20 0L20 20M0 20L0 0', 'a doorway leaves a gap');
    assert.deepEqual(map.dock, { x: 10, y: 18 });
    assert.deepEqual(map.viewBox, [-4, -4, 48, 28]);
  } finally { await done(); }
});

test('Ecovacs: rooms to clean, how, station jobs, wear reset and settings — the exact commands', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const settings: Record<string, import('../src/model/types.ts').DeviceSettings> = { vac: { areaRooms: { '0': 'kitchen', '2': 'hall' } } };
  const reg = new Registry(new Store(':memory:'), () => undefined, () => settings);
  reg.roomName = id => ({ kitchen: 'Kitchen', hall: 'Hall', study: 'Study' } as Record<string, string>)[id] ?? id;
  const ev = new EcovacsAdapter({ email: 'me@example.com', password: 'hunter2', country: 'au', pollMs: 0, refreshMs: 0, ids: { Deebot: 'vac' }, urls: { login: `${base}/login`, auth: `${base}/auth`, portal: `${base}/api` } });
  await reg.addAdapter(ev);
  const you = { kind: 'user' as const, label: 'You' };
  try {
    fake.calls.length = 0;
    await reg.command('vac', { robotSet: { rooms: ['kitchen'], suction: 'max+', mode: 'mopAfter', water: 99, passes: 2 } }, you);
    assert.deepEqual(sent(fake.calls), [
      { cmdName: 'setSpeed', data: { speed: 2 } }, { cmdName: 'setWorkMode', data: { mode: 3 } }, { cmdName: 'setWaterInfo', data: { customAmount: 50 } },
      { cmdName: 'setCleanCount', data: { count: 2 } }, { cmdName: 'clean_V2', data: { act: 'start', content: { type: 'spotArea', value: '0' } } },
    ], 'how first, then where: the kitchen is area 0');
    const s = reg.get('vac')!.state;
    assert.equal(s.activity, 'cleaning');
    assert.equal(s.on, true);
    assert.equal(s.robot!.suction, 'max+');
    assert.equal(s.robot!.water, 50);
    await assert.rejects(reg.command('vac', { robotSet: { rooms: ['study'] } }, you), /doesn’t know where Study is on its map/);

    fake.calls.length = 0;
    await reg.command('vac', { robotSet: { station: 'empty' } }, you);
    await reg.command('vac', { robotSet: { station: 'wash' } }, you);
    await reg.command('vac', { robotSet: { station: 'dry' } }, you);
    await reg.command('vac', { robotSet: { locate: true } }, you);
    await reg.command('vac', { robotSet: { resetPart: 'sideBrush' } }, you);
    await reg.command('vac', { robotSet: { settings: { obstacles: false, carpetBoost: false, quiet: { on: true, start: '21:30', end: '07:05' }, childLock: true, voice: 4, autoEmpty: false } } }, you);
    assert.deepEqual(sent(fake.calls), [
      { cmdName: 'stationAction', data: { act: 1, type: 1 } }, { cmdName: 'stationAction', data: { act: 1, type: 4 } }, { cmdName: 'stationAction', data: { act: 1, type: 2 } },
      { cmdName: 'playSound', data: { count: 1, sid: 30 } }, { cmdName: 'resetLifeSpan', data: { type: 'sideBrush' } },
      { cmdName: 'setCarpertPressure', data: { enable: 0 } }, { cmdName: 'setTrueDetect', data: { enable: 0, level: 1 } }, { cmdName: 'setChildLock', data: { on: 1 } }, { cmdName: 'setVolume', data: { volume: 4 } },
      { cmdName: 'setBlock', data: { enable: 1, start: '21:30', end: '7:5' } }, { cmdName: 'setAutoEmpty', data: { enable: 0 } },
    ]);
    assert.equal(reg.get('vac')!.state.robot!.settings!.childLock, true);
    assert.equal(reg.get('vac')!.state.robot!.parts!.find(p => p.id === 'sideBrush')!.left, 100);
    // What it was told is in Activity, in words.
    const log = (reg as unknown as { store: Store }).store.feed(20).map(e => e.what);
    assert.ok(log.some((w: string) => /empty the dust bin/.test(w)), log.join(' | '));
    // Read back on the next poll: the station is busy, the block is on.
    await ev.poll();
    assert.equal(reg.get('vac')!.state.robot!.settings!.quiet!.start, '21:30');
  } finally { await reg.stop(); fake.server.close(); }
});

test('Robot commands are checked, and said in words', async () => {
  const { cleanRobotSet, robotWords, resolveRooms, areaName } = await import('../src/util/robot.ts');
  assert.deepEqual(cleanRobotSet({ rooms: 'kitchen', suction: 'Max Plus', passes: '2' }), { rooms: ['kitchen'], suction: 'max+', passes: 2 });
  assert.deepEqual(cleanRobotSet({ suction: 'strong' }), { suction: 'max' });
  assert.throws(() => cleanRobotSet({ mode: 'sweep' }), /Mode is/);
  assert.throws(() => cleanRobotSet({ settings: { laser: true } }), /Unknown robot setting laser/);
  assert.throws(() => cleanRobotSet({ settings: { quiet: { on: true, start: '25:00' } } }), /HH:MM/);
  assert.throws(() => cleanRobotSet({}), /asks for nothing/);
  assert.equal(robotWords({ rooms: ['Kitchen', 'Hall'], suction: 'max', mode: 'mop' }), 'cleans Kitchen and Hall, suction Max, mop only');
  assert.equal(robotWords({ station: 'wash' }), 'wash the mop');
  const d = { name: 'Robot', state: { robot: { areas: [{ id: '1', name: '' }, { id: '4', name: '' }] } } };
  assert.deepEqual(resolveRooms(d, { rooms: ['k'], suction: 'max' }, { '1': 'k', '4': 'k', '9': 'k' }, x => x), { suction: 'max', areas: ['1', '4'] }, 'a room in two areas cleans both; an area the map lost is left out');
  assert.equal(areaName('4', d.state.robot.areas, {}, x => x), 'Area B');
  assert.equal(areaName('4', d.state.robot.areas, { '4': 'k' }, () => 'Kitchen'), 'Kitchen');
});
