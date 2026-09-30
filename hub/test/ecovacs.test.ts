import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
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
  const bot = { activity: 'docked' as string, battery: 100 };
  const calls: { cmdName: string; data?: unknown; body: Record<string, any>; query: URLSearchParams }[] = [];
  const state = { logins: 0, portalLogins: 0, expire: () => { token = 'expired-' + token; } };
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
      const login = url.pathname.match(/^\/login\/v1\/private\/(\w+)\/EN\/([0-9a-f]{32})\/global_e\/1\.6\.3\/google_play\/1\/user\/login$/);
      if (login) {
        const params = Object.fromEntries(q);
        const expected = sign(params, { country: login[1], deviceId: login[2], lang: 'EN', appCode: 'global_e', appVersion: '1.6.3', channel: 'google_play', deviceType: '1' }, '1520391301804', '6c319b2a5cd3e66e39159c2e28f2fce9');
        assert.equal(q.get('authSign'), expected, 'login is signed');
        assert.equal(q.get('authAppkey'), '1520391301804');
        if (q.get('account') !== email || q.get('password') !== md5(password)) return send({ code: '1005', msg: 'wrong password' });
        state.logins++;
        return send({ code: '0000', msg: 'ok', data: { uid: 'u42', accessToken: 'acc42' } });
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
    assert.deepEqual(d.state, { on: false, activity: 'docked', battery: 100, online: true });
    const up = reg.get('ecovacs_ne0000000002')!;
    assert.equal(up.state.online, false, 'status 0 in the device list = offline');
    assert.equal(up.room, 'unassigned');
    assert.equal(ev.status().ok, false);
    assert.match(ev.status().note!, /1 of 2 offline/);

    // Started from the Ecovacs app: shows up on the next poll.
    fake.bot.activity = 'cleaning'; fake.bot.battery = 64;
    await ev.poll();
    assert.deepEqual(reg.get(d.id)!.state, { on: true, activity: 'cleaning', battery: 64, online: true });
    fake.bot.activity = 'paused';
    await ev.poll();
    assert.deepEqual(reg.get(d.id)!.state, { on: false, activity: 'paused', battery: 64, online: true });
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
    assert.deepEqual(reg.get('vac')!.state, { on: true, activity: 'cleaning', battery: 100, online: true });
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
  assert.deepEqual(ecovacsUrls('au'), { login: 'https://gl-au-api.ecovacs.com', auth: 'https://gl-au-openapi.ecovacs.com', portal: 'https://api-app.dc-ww.ww.ecouser.net/api' });
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
