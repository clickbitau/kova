import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { ConnectLifeAdapter, acProperties, acState, connectLifeAuthUrl, exchangeConnectLifeCode } from '../src/adapters/connectlife.ts';
import { changeSentence } from '../src/util/describe.ts';

const you = { kind: 'user' as const, label: 'You' };
const APP = { clientId: 'app1', clientSecret: 's3cret' };

/** The ConnectLife cloud: a split AC, a dehumidifier, signed requests, and OAuth that replaces the refresh token on refresh. */
async function fakeConnectLife() {
  const ac: Record<string, string> = { t_power: '0', t_work_mode: '2', t_temp: '24', t_fan_speed: '0', f_temp_in: '27', t_temp_type: '0',
    aus_zone1_power: '1', aus_zone1_opencontrol: '35', aus_zone2_power: '0', aus_zone2_opencontrol: '0' };
  const sets: Record<string, string>[] = [];
  const tokens: Record<string, string>[] = [];
  const bad: string[] = [];
  let refresh = 'r1', access = 'a0', n = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/oauth/token') {
        const f = Object.fromEntries(new URLSearchParams(body));
        tokens.push(f);
        if (f.client_id !== APP.clientId || f.client_secret !== APP.clientSecret) return send(401, { error: 'invalid_client' });
        if (f.grant_type === 'authorization_code') return f.code === 'c0de' ? send(200, { access_token: 'a-code', refresh_token: 'r1', expires_in: 3600 }) : send(400, { error: 'invalid_grant', error_description: 'bad code' });
        if (f.refresh_token !== refresh) return send(400, { error: 'invalid_grant' });
        refresh = `r${++n}`; access = `a${n}`;
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
      }
      // Every API call is signed with the app secret over method, path and date, with a digest of the body.
      const path = req.url!;
      const signed = `${APP.clientId}\n${req.method} ${path}\ndate: ${req.headers.date}\nhi-params-encrypt: ${APP.clientId}\n`;
      const sign = createHmac('sha256', APP.clientSecret).update(signed).digest('base64');
      if (!String(req.headers.authorization).includes(`signature="${sign}"`)) { bad.push('signature'); return send(403, { resultCode: 1, msg: 'sign invalid' }); }
      if (req.headers.digest !== `SHA-256=${createHash('sha256').update(body).digest('base64')}`) { bad.push('digest'); return send(403, { resultCode: 1, msg: 'digest' }); }
      const token = req.method === 'GET' ? req.headers.accesstoken : JSON.parse(body || '{}').accessToken;
      if (token !== access) return send(401, { resultCode: 1, msg: 'token expired' });
      if (u.pathname === '/clife-svc/pu/get_device_status_list') {
        assert.equal(u.searchParams.get('appId'), APP.clientId);
        return send(200, { resultCode: 0, deviceList: [
          { deviceId: '86100c0090000a1b2c3d4e5f', puid: 'pu-ac-1', deviceNickName: 'Bedroom AC', deviceTypeCode: '009', deviceFeatureCode: '199', offlineState: 1, statusList: { ...ac } },
          { deviceId: 'dehum-1', puid: 'pu-dh', deviceNickName: 'Dehumidifier', deviceTypeCode: '007', deviceFeatureCode: '1', statusList: {} },
        ] });
      }
      if (u.pathname === '/device/pu/property/set' && req.method === 'POST') {
        const j = JSON.parse(body);
        assert.equal(j.puid, 'pu-ac-1');
        sets.push(j.properties);
        Object.assign(ac, j.properties);
        return send(200, { resultCode: 0, kvMap: j.properties });
      }
      send(404, { resultCode: 1, msg: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, ac, sets, tokens, bad, expire: () => { access = 'gone'; }, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('Hisense ConnectLife: air conditioners found, read, and switched, set and fanned through signed requests', async () => {
  const cl = await fakeConnectLife();
  const dir = mkdtempSync(join(tmpdir(), 'kova-cl-'));
  const reg = new Registry(new Store(':memory:'));
  const urls = { token: `${cl.url}/oauth/token`, api: cl.url, ...APP };
  const adapter = new ConnectLifeAdapter({ refreshToken: 'r1', storageDir: dir, pollMs: 0, urls, rooms: { '86100c0090000a1b2c3d4e5f': 'bedroom' } });
  try {
    await reg.addAdapter(adapter);
    // Only the air conditioner, in its room, as a climate device with its state.
    const ids = reg.list().map(d => d.id);
    assert.deepEqual(ids, ['connectlife_0a1b2c3d4e5f']);
    const id = ids[0];
    const d = reg.get(id)!;
    assert.deepEqual({ room: d.room, type: d.type, caps: d.capabilities, name: d.name }, { room: 'bedroom', type: 'climate', caps: ['onoff', 'climate', 'zones'], name: 'Bedroom AC' });
    assert.deepEqual(d.state.zones, [{ n: 1, on: true, open: 35 }, { n: 2, on: false, open: 0 }], 'a ducted unit: its zones');
    assert.deepEqual({ on: d.state.on, hvac: d.state.hvac, target: d.state.target, temp: d.state.temp, fan: d.state.fanSpeed, online: d.state.online },
      { on: false, hvac: 'cool', target: 24, temp: 27, fan: 'auto', online: true });
    assert.deepEqual(adapter.status(), { ok: true, note: '1 air conditioner · cloud' });
    // The refresh token ConnectLife replaced is kept, owner-only.
    const kept = join(dir, 'token.json');
    assert.equal(JSON.parse(readFileSync(kept, 'utf8')).refreshToken, 'r2');
    assert.equal(statSync(kept).mode & 0o777, 0o600);

    // Heat to 22°, then the fan up; then off.
    await reg.command(id, { hvac: 'heat', target: 22 }, you);
    await reg.command(id, { fanSpeed: 'high' }, you);
    await reg.command(id, { on: false }, you);
    assert.deepEqual(cl.sets.splice(0), [{ t_work_mode: '1', t_power: '1', t_temp: '22' }, { t_fan_speed: '8' }, { t_power: '0' }]);
    assert.deepEqual({ on: reg.get(id)!.state.on, hvac: reg.get(id)!.state.hvac, target: reg.get(id)!.state.target, fan: reg.get(id)!.state.fanSpeed }, { on: false, hvac: 'heat', target: 22, fan: 'high' });
    assert.deepEqual(cl.bad, []);

    // Zones: zone 2 on at 60%, then undone.
    const r = await reg.command(id, { zoneSet: { 2: { on: true, open: 60 } } }, you);
    assert.deepEqual(cl.sets.splice(0), [{ aus_zone2_power: '1', aus_zone2_opencontrol: '60' }]);
    assert.deepEqual(reg.get(id)!.state.zones, [{ n: 1, on: true, open: 35 }, { n: 2, on: true, open: 60 }]);
    assert.equal('zoneSet' in reg.get(id)!.state, false, 'the change is not kept as state, the zones are');
    await reg.command(id, r as never, you);
    assert.deepEqual(cl.sets.splice(0), [{ aus_zone1_power: '1', aus_zone1_opencontrol: '35', aus_zone2_power: '0', aus_zone2_opencontrol: '0' }]);

    // The access token ran out: Kova signs in again with the kept refresh token, then the command goes through.
    cl.expire();
    await reg.command(id, { on: true }, you);
    assert.equal(cl.ac.t_power, '1');
    assert.equal(cl.tokens.at(-1)!.refresh_token, 'r2');
  } finally {
    await reg.stop();
    await cl.close();
  }
});

test('ConnectLife linking, units, and what Activity says', async () => {
  const cl = await fakeConnectLife();
  try {
    const urls = { token: `${cl.url}/oauth/token`, ...APP, redirect: 'http://example.test/cb' };
    // The sign-in page carries the app and the redirect; the whole address pasted back works as well as the code.
    const auth = new URL(connectLifeAuthUrl({ authorize: 'https://oauth.example/login', ...urls }));
    assert.deepEqual([auth.origin + auth.pathname, auth.searchParams.get('client_id'), auth.searchParams.get('response_type'), auth.searchParams.get('redirect_uri')], ['https://oauth.example/login', 'app1', 'code', 'http://example.test/cb']);
    assert.deepEqual(await exchangeConnectLifeCode('http://example.test/cb?code=c0de&state=x', urls), { refreshToken: 'r1' });
    assert.equal(cl.tokens.at(-1)!.redirect_uri, 'http://example.test/cb');
    await assert.rejects(exchangeConnectLifeCode('nope', urls), /bad code/);
  } finally { await cl.close(); }

  // Fahrenheit units: read as °C, set in °F; out-of-range targets clamped to what the units take.
  assert.deepEqual(acState({ deviceId: 'x', puid: 'p', statusList: { t_temp_type: '1', t_temp: '75', f_temp_in: '80', t_power: '1', t_work_mode: '4' } }),
    { online: true, on: true, hvac: 'auto', fanSpeed: null, target: 24, temp: 26.5 });
  // ConnectLife's offlineState: 1 is online, 0 offline (as Hisense's own plugin reads it).
  assert.equal(acState({ deviceId: 'x', puid: 'p', offlineState: 1, statusList: {} }).online, true);
  assert.equal(acState({ deviceId: 'x', puid: 'p', offlineState: 0, statusList: {} }).online, false);
  assert.deepEqual(acProperties({ target: 24 }, true), { t_temp: '75' });
  assert.deepEqual(acProperties({ target: 40 }), { t_temp: '32' });
  assert.deepEqual(acProperties({ vol: 3 }), {});

  const ac = { id: 'a', name: 'Bedroom AC', room: 'bedroom', type: 'climate' as const, capabilities: ['onoff', 'climate'] as const, adapter: 'connectlife', state: {} };
  assert.equal(changeSentence(ac as never, {}, { hvac: 'cool', target: 23 }), 'Bedroom AC cooling to 23°');
  assert.equal(changeSentence(ac as never, {}, { target: 21 }), 'Bedroom AC set to 21°');
  assert.equal(changeSentence(ac as never, { on: true }, { on: false }), 'Bedroom AC off');
  assert.equal(changeSentence(ac as never, { zones: [{ n: 1, on: true, open: 35 }, { n: 2, on: false, open: 0 }] }, { zones: [{ n: 1, on: true, open: 35 }, { n: 2, on: true, open: 60 }] }), 'Bedroom AC zone 2 on at 60%');
  assert.deepEqual(acProperties({ zoneSet: { 3: { on: false }, x: { on: true } } }), { aus_zone3_power: '0' }, 'only real zone numbers');
});
