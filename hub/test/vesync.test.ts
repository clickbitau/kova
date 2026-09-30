import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { VeSyncAdapter, isCorePurifier, statusToState, toVeSyncMode } from '../src/adapters/vesync.ts';

// A fake VeSync cloud: v1 login, device list, and the bypassV2 relay to one Core300S.
function fakeCloud(email: string, password: string) {
  let token = '';
  let n = 0;
  const purifier = { enabled: false, mode: 'auto', level: 2, display: true, filter_life: 90, air_quality: 1 };
  const calls: { path: string; body: Record<string, any>; headers: http.IncomingHttpHeaders }[] = [];
  const state = { logins: 0, expire: () => { token = 'expired-' + token; } };
  const list = [
    { deviceName: 'Bedroom Purifier', deviceType: 'Core300S', cid: 'vsaqABCDEF0123456789', configModule: 'VeSyncAirBypass', connectionStatus: 'online', deviceStatus: 'off', deviceRegion: 'US' },
    { deviceName: 'Office Purifier', deviceType: 'LAP-C201S-AUSR', cid: 'vsaqOFFLINE000000001', configModule: 'VeSyncAirBypass', connectionStatus: 'offline', deviceRegion: 'US' },
    { deviceName: 'Kettle', deviceType: 'ESO15-TB', cid: 'kettle01', connectionStatus: 'online' },
  ];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ path: req.url!, body, headers: req.headers });
      const send = (j: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      if (req.url === '/cloud/v1/user/login') {
        const ok = body.email === email && body.password === createHash('md5').update(password).digest('hex') && body.method === 'login';
        if (!ok) return send({ code: -11201000, msg: 'password incorrect' });
        state.logins++;
        token = `tok${++n}`;
        return send({ code: 0, msg: 'request success', result: { token, accountID: '4242', countryCode: 'AU' } });
      }
      if (req.headers.tk !== token || body.token !== token || body.accountID !== '4242') return send({ code: -11012022, msg: 'token expired' });
      if (req.url === '/cloud/v1/deviceManaged/devices') return send({ code: 0, result: { list, total: list.length } });
      if (req.url === '/cloud/v2/deviceManaged/bypassV2') {
        assert.equal(body.method, 'bypassV2');
        assert.equal(body.payload.source, 'APP');
        if (body.cid !== list[0].cid) return send({ code: -11300030, msg: 'device offline' });
        const { method, data } = body.payload;
        if (method === 'setSwitch') purifier.enabled = data.enabled;
        if (method === 'setPurifierMode') purifier.mode = data.mode;
        if (method === 'setLevel') { purifier.mode = 'manual'; purifier.level = data.level; }
        if (method === 'setDisplay') purifier.display = data.state;
        return send({ traceId: body.traceId, code: 0, msg: 'request success', result: { code: 0, result: method === 'getPurifierStatus' ? purifier : {}, traceId: body.traceId } });
      }
      res.statusCode = 404; res.end();
    });
  });
  return { server, purifier, calls, state };
}

const bypasses = (calls: { path: string; body: Record<string, any> }[]) =>
  calls.filter(c => c.path === '/cloud/v2/deviceManaged/bypassV2' && c.body.payload.method !== 'getPurifierStatus').map(c => c.body.payload);

test('VeSync: logs in, lists purifiers, reports status, and sends power and mode commands', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  const vs = new VeSyncAdapter({ email: 'me@example.com', password: 'hunter2', baseUrl, pollMs: 0, devices: { 'Bedroom Purifier': { room: 'bedroom', id: 'bedroom_purifier' } } });
  await reg.addAdapter(vs);
  try {
    const list = reg.list();
    assert.deepEqual(list.map(d => d.id).sort(), ['bedroom_purifier', 'vesync_ine000000001'].sort(), 'Core purifiers only, no kettle');
    const d = reg.get('bedroom_purifier')!;
    assert.equal(d.type, 'fan');
    assert.equal(d.room, 'bedroom');
    assert.equal(d.integration, 'Levoit Core300S');
    assert.deepEqual(d.state, { on: false, mode: 'Auto', online: true });
    const off = list.find(x => x.id !== 'bedroom_purifier')!;
    assert.equal(off.state.online, false);
    assert.equal(off.room, 'unassigned');

    await reg.command(d.id, { on: true, mode: 'Sleep' }, { kind: 'user', label: 'You' });
    assert.deepEqual(bypasses(fake.calls), [
      { method: 'setSwitch', source: 'APP', data: { enabled: true, id: 0 } },
      { method: 'setPurifierMode', source: 'APP', data: { mode: 'sleep' } },
    ]);
    assert.equal(fake.purifier.enabled, true);
    assert.equal(fake.purifier.mode, 'sleep');

    fake.calls.length = 0;
    await reg.command(d.id, { mode: 'Manual' }, { kind: 'user', label: 'You' });
    assert.deepEqual(bypasses(fake.calls), [{ method: 'setLevel', source: 'APP', data: { id: 0, level: 2, type: 'wind' } }], 'manual keeps the last fan speed');

    fake.calls.length = 0;
    await reg.command(d.id, { on: false }, { kind: 'user', label: 'You' });
    assert.deepEqual(bypasses(fake.calls), [{ method: 'setSwitch', source: 'APP', data: { enabled: false, id: 0 } }]);
    const c = fake.calls[0];
    assert.equal(c.body.cid, 'vsaqABCDEF0123456789');
    assert.equal(c.body.configModule, 'VeSyncAirBypass');
    assert.equal(c.headers.accountid, '4242');

    // A change made in the VeSync app shows up on the next poll.
    fake.purifier.enabled = true; fake.purifier.mode = 'auto';
    await vs.poll();
    assert.deepEqual(reg.get(d.id)!.state, { on: true, mode: 'Auto', online: true });
    await assert.rejects(reg.command(d.id, { mode: 'Turbo' }, { kind: 'user', label: 'You' }));
    assert.equal(vs.status().ok, false, 'one purifier is offline');
  } finally { await reg.stop(); fake.server.close(); }
});

test('VeSync: logs in again once when the token expires', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new VeSyncAdapter({ email: 'me@example.com', password: 'hunter2', baseUrl, pollMs: 0 }));
  try {
    assert.equal(fake.state.logins, 1);
    fake.state.expire();
    const id = reg.list().find(d => d.name === 'Bedroom Purifier')!.id;
    await reg.command(id, { on: true }, { kind: 'user', label: 'You' });
    assert.equal(fake.state.logins, 2);
    assert.equal(fake.purifier.enabled, true);
  } finally { await reg.stop(); fake.server.close(); }
});

test('VeSync: a wrong password is reported, not thrown', async () => {
  const fake = fakeCloud('me@example.com', 'hunter2');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  const vs = new VeSyncAdapter({ email: 'me@example.com', password: 'nope', baseUrl, pollMs: 0 });
  await reg.addAdapter(vs);
  try {
    assert.equal(reg.list().length, 0);
    assert.equal(vs.status().ok, false);
    assert.match(vs.status().note!, /login failed/);
  } finally { await reg.stop(); fake.server.close(); }
});

test('VeSync helpers', () => {
  assert.ok(isCorePurifier('Core300S'));
  assert.ok(isCorePurifier('LAP-C301S-WJP'));
  assert.ok(isCorePurifier('Core600S'));
  assert.ok(!isCorePurifier('LV-PUR131S'));
  assert.equal(toVeSyncMode('Sleep'), 'sleep');
  assert.equal(toVeSyncMode('Turbo'), null);
  assert.deepEqual(statusToState({ enabled: true, mode: 'manual', level: 3 }), { on: true, mode: 'Manual', online: true });
});
