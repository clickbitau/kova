import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { importFromCloud, mergeCloudDevices, TuyaCloud } from '../src/adapters/tuya/cloud.ts';
import { discover, parseBroadcast } from '../src/adapters/tuya/discover.ts';
import { lightFromSpec, switchesFromSpec, lightToDps, dpsToLight, type TuyaDpSpec, type TuyaOptions } from '../src/adapters/tuya/index.ts';
import { table } from '../src/tools/tuya-keys.ts';
import { buildServer } from '../src/api/server.ts';
import { testHub } from './helpers.ts';

// ------------------------------------------------ fake Tuya OpenAPI --
// The signature is recomputed here from Tuya's documented recipe, independently of cloud.ts.

const CLIENT_ID = 'kovaclientid123';
const SECRET = 'kovasecret0123456789abcdef';
const KEYS = { tv: 'tvkey0123456789a', bed: 'bedkey0123456789', kitchen: 'NEWkitchenkey012', laundry: 'laundrykey012345', sl3: 'sl3key0123456789' };

const v2LightSpec = {
  category: 'dj',
  functions: [
    { code: 'switch_led', dp_id: 20, type: 'Boolean', values: '{}' },
    { code: 'work_mode', dp_id: 21, type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
    { code: 'bright_value_v2', dp_id: 22, type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
    { code: 'temp_value_v2', dp_id: 23, type: 'Integer', values: '{"min":0,"max":1000,"scale":0,"step":1}' },
    { code: 'colour_data_v2', dp_id: 24, type: 'Json', values: '{"h":{"min":0,"scale":0,"unit":"","max":360,"step":1},"s":{"min":0,"scale":0,"unit":"","max":1000,"step":1},"v":{"min":0,"scale":0,"unit":"","max":1000,"step":1}}' },
  ],
  status: [{ code: 'switch_led', dp_id: 20, type: 'Boolean', values: '{}' }],
};
// A v1 strip whose spec comes from the iot-03 endpoint, which has no dp_id.
const v1LightSpec = {
  category: 'dd',
  functions: [
    { code: 'switch_led', type: 'Boolean', values: '{}' },
    { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
    { code: 'bright_value', type: 'Integer', values: '{"min":25,"max":255,"scale":0,"step":1}' },
    { code: 'colour_data', type: 'Json', values: '{"h":{"min":0,"max":360},"s":{"min":0,"max":255},"v":{"min":0,"max":255}}' },
  ],
  status: [],
};
const twoGangSpec = { category: 'kg', functions: [{ code: 'switch_1', dp_id: 1, type: 'Boolean', values: '{}' }, { code: 'switch_2', dp_id: 2, type: 'Boolean', values: '{}' }], status: [{ code: 'countdown_1', dp_id: 7, type: 'Integer', values: '{}' }] };

function fakeCloud() {
  const calls: string[] = [];
  const errors: string[] = [];
  let tokens = 0;
  let current = '';
  let expiredOnce = false;
  const ok = (result: unknown) => ({ success: true, t: Date.now(), result });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = req.url!;
      const h = req.headers as Record<string, string>;
      const token = h.access_token ?? '';
      const stringToSign = `${req.method}\n${createHash('sha256').update(body).digest('hex')}\n\n${url}`;
      const expected = createHmac('sha256', SECRET).update(CLIENT_ID + token + h.t + (h.nonce ?? '') + stringToSign).digest('hex').toUpperCase();
      const send = (j: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
      calls.push(`${req.method} ${url}`);
      if (h.client_id !== CLIENT_ID || h.sign_method !== 'HMAC-SHA256' || h.sign !== expected) { errors.push(`bad sign on ${url}`); return send({ success: false, code: 1004, msg: 'sign invalid' }); }
      const [path, q = ''] = url.split('?');
      const keys = q ? q.split('&').map(p => p.split('=')[0]) : [];
      if (keys.join() !== [...keys].sort().join()) errors.push(`unsorted query on ${url}`);
      if (path === '/v1.0/token') {
        if (token) errors.push('token request carried a token');
        if (q !== 'grant_type=1') errors.push('bad token query');
        tokens++;
        current = `tok${tokens}`;
        return send(ok({ access_token: current, expire_time: 7200, refresh_token: 'r', uid: 'projectuid' }));
      }
      if (token !== current) { errors.push(`stale token on ${url}`); return send({ success: false, code: 1010, msg: 'token invalid' }); }
      if (path === '/v1.0/iot-01/associated-users/devices') {
        if (!q.includes('last_row_key=')) {
          return send(ok({ has_more: true, last_row_key: 'page2', total: 6, devices: [
            { id: 'bf8f4ee96e37c51fd3h6zd', name: 'TV Unit Light', local_key: KEYS.tv, ip: '203.0.113.7', category: 'dj', product_name: 'Smart Lighting', online: true, uid: 'eu123' },
            { id: 'bf21ef686e116a96c7dud5', name: 'Bedroom LED', local_key: KEYS.bed, ip: '203.0.113.7', category: 'dd', product_name: 'Smart Lighting', online: true, uid: 'eu123' },
            { id: 'bf209b09a9baaec758qwlo', name: 'Kitchen Switch', local_key: KEYS.kitchen, ip: '203.0.113.7', category: 'kg', product_name: 'Smart Switch', online: true, uid: 'eu123' },
          ] }));
        }
        return send(ok({ has_more: false, last_row_key: 'page3', devices: [
          { id: 'bf5379dd22bbfba8fbi72m', name: 'Laundry Switch', local_key: KEYS.laundry, ip: '192.168.1.219', category: 'kg', product_name: '2 Gang Wi-Fi Touch Switch', online: true, uid: 'eu123' },
          { id: 'bf8543c7df7a9b2f59cknm', name: 'Smart Lighting 3', ip: '203.0.113.7', category: 'dj', product_name: 'Smart Lighting', online: false, uid: 'eu123' },
          { id: 'a4c138zigbee0001', name: 'Door sensor', local_key: 'zzzzzzzzzzzzzzzz', category: 'mcs', node_id: 'a4c138', gateway_id: 'bfd2f3de48cd1a8966flvu', uid: 'eu123' },
          { id: 'bfthermostat00001', name: 'Thermostat', local_key: 'tttttttttttttttt', category: 'wk', uid: 'eu123' },
        ] }));
      }
      if (path === '/v1.3/iot-03/devices') {
        // Only asked for because Smart Lighting 3 came back without its key.
        return send(ok({ has_more: false, list: [{ id: 'bf8543c7df7a9b2f59cknm', name: 'Smart Lighting 3', local_key: KEYS.sl3, category: 'dj' }] }));
      }
      const m = /^\/v1\.(?:[01])\/(?:iot-03\/)?devices\/([^/]+)\/specifications?$/.exec(path);
      if (m) {
        const id = m[1];
        if (path.startsWith('/v1.1/') && id === 'bf8f4ee96e37c51fd3h6zd' && !expiredOnce) { expiredOnce = true; current = 'expired'; return send({ success: false, code: 1010, msg: 'token invalid' }); }
        if (id === 'bf21ef686e116a96c7dud5') return path.includes('iot-03') ? send(ok(v1LightSpec)) : send({ success: false, code: 2009, msg: 'not support this device' });
        if (id === 'bf8f4ee96e37c51fd3h6zd' || id === 'bf8543c7df7a9b2f59cknm') return send(ok(v2LightSpec));
        if (id === 'bf209b09a9baaec758qwlo' || id === 'bf5379dd22bbfba8fbi72m') return send(ok(twoGangSpec));
        return send({ success: false, code: 2009, msg: 'not support this device' });
      }
      errors.push(`unexpected ${url}`);
      send({ success: false, code: 404, msg: 'no such api' });
    });
  });
  return { server, calls, errors, tokens: () => tokens };
}

async function withCloud<T>(fn: (baseUrl: string, fake: ReturnType<typeof fakeCloud>) => Promise<T>): Promise<T> {
  const fake = fakeCloud();
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`, fake); } finally { fake.server.close(); }
}

const EXISTING: TuyaOptions = {
  devices: [{
    id: 'bf209b09a9baaec758qwlo', host: '192.168.1.230', key: 'oldkitchenkey012', version: '3.3',
    switches: { '1': { name: 'Corridor In', room: 'corridor', type: 'light', id: 'corridor_in' }, '2': { name: 'Kitchen Light', room: 'kitchen', type: 'light', id: 'kitchen_ceiling' } },
  }],
};
const ROOMS = [{ id: 'bedroom', name: 'Bedroom' }, { id: 'laundry', name: 'Laundry' }, { id: 'kitchen', name: 'Kitchen' }, { id: 'living_room', name: 'Living Room' }];

// ---------------------------------------------------------- UDP --

const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();
function broadcast33(json: object): Buffer {
  const c = createCipheriv('aes-128-ecb', UDP_KEY, null);
  const enc = Buffer.concat([c.update(JSON.stringify(json)), c.final()]);
  const payload = Buffer.concat([Buffer.alloc(4), enc]); // return code, then the encrypted JSON
  const h = Buffer.alloc(16);
  h.writeUInt32BE(0x55aa, 0); h.writeUInt32BE(0, 4); h.writeUInt32BE(0x13, 8); h.writeUInt32BE(payload.length + 8, 12);
  const body = Buffer.concat([h, payload]);
  const tail = Buffer.alloc(8); tail.writeUInt32BE(crc32(body) >>> 0, 0); tail.writeUInt32BE(0xaa55, 4);
  return Buffer.concat([body, tail]);
}
function broadcast35(json: object): Buffer {
  const plain = Buffer.from(JSON.stringify(json));
  const h = Buffer.alloc(18);
  h.writeUInt32BE(0x6699, 0); h.writeUInt32BE(1, 6); h.writeUInt32BE(0x13, 10); h.writeUInt32BE(12 + plain.length + 16, 14);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-128-gcm', UDP_KEY, iv); c.setAAD(h.subarray(4));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([h, iv, ct, c.getAuthTag(), Buffer.from([0, 0, 0x99, 0x66])]);
}
async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>(r => s.bind(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}
/** Send a datagram every 50 ms until stopped (discovery may bind a moment later). */
function keepSending(port: number, msgs: Buffer[]) {
  const s = dgram.createSocket('udp4');
  const t = setInterval(() => { for (const m of msgs) s.send(m, port, '127.0.0.1'); }, 50);
  return () => { clearInterval(t); s.close(); };
}

// -------------------------------------------------------- tests --

test('Tuya cloud: signed token + device list + specs merge into integrations, keeping rooms and ids', async () => {
  await withCloud(async (baseUrl, fake) => {
    const port = await freeUdpPort();
    const stop = keepSending(port, [broadcast33({ ip: '192.168.1.240', gwId: 'bf8f4ee96e37c51fd3h6zd', active: 2, ability: 0, encrypt: true, productKey: 'keyabc', version: '3.5' })]);
    let r;
    try {
      r = await importFromCloud({ clientId: CLIENT_ID, secret: SECRET, baseUrl, existing: EXISTING, rooms: ROOMS, discoverMs: 800, discoverPorts: [port] });
    } finally { stop(); }
    assert.deepEqual(fake.errors, []);
    assert.equal(fake.tokens(), 2, 'fetched a new token after "token invalid"');
    assert.ok(fake.calls.includes('GET /v1.0/iot-01/associated-users/devices?last_row_key=page2&size=50'), 'second page requested with sorted query');
    assert.ok(fake.calls.some(c => c.startsWith('GET /v1.3/iot-03/devices?last_row_key=') || c === 'GET /v1.3/iot-03/devices?page_size=75&source_id=eu123&source_type=tuyaUser'));

    const by = (id: string) => r.tuya.devices.find(d => d.id === id)!;
    // Existing switch: new key, same host, rooms and Kova ids.
    const kitchen = by('bf209b09a9baaec758qwlo');
    assert.equal(kitchen.key, KEYS.kitchen);
    assert.equal(kitchen.host, '192.168.1.230');
    assert.deepEqual(kitchen.switches, EXISTING.devices[0].switches);
    assert.equal(EXISTING.devices[0].key, 'oldkitchenkey012', 'input not mutated');
    // TV Unit Light: v2 light from the spec's dp_ids; IP and version from the LAN broadcast (not the cloud's public IP).
    const tv = by('bf8f4ee96e37c51fd3h6zd');
    assert.equal(tv.host, '192.168.1.240');
    assert.equal(tv.version, '3.5');
    assert.equal(tv.key, KEYS.tv);
    assert.deepEqual(tv.light, { switch: '20', mode: '21', bri: '22', briMin: 10, briMax: 1000, temp: '23', tempMin: 0, tempMax: 1000, colour: '24', colourFormat: 'hsv16', colourMax: 1000, name: 'TV Unit Light', room: 'unassigned', id: 'tuya_tv_unit_light' });
    // Bedroom LED: v1 strip, DPs from the standard v1 numbering since that spec has no dp_id.
    const bed = by('bf21ef686e116a96c7dud5');
    assert.deepEqual(bed.light, { switch: '1', mode: '2', bri: '3', briMin: 25, briMax: 255, colour: '5', colourFormat: 'rgb8', colourMax: 255, name: 'Bedroom LED', room: 'bedroom', id: 'bedroom_led' });
    assert.equal(bed.host, '', 'no LAN IP known');
    // Laundry: new 2-gang switch, private cloud IP accepted.
    const laundry = by('bf5379dd22bbfba8fbi72m');
    assert.equal(laundry.host, '192.168.1.219');
    assert.deepEqual(laundry.switches, { '1': { name: 'Laundry Switch 1', room: 'laundry', type: 'light', id: 'laundry_switch_1' }, '2': { name: 'Laundry Switch 2', room: 'laundry', type: 'light', id: 'laundry_switch_2' } });
    // Smart Lighting 3: key filled in from the per-user listing.
    assert.equal(by('bf8543c7df7a9b2f59cknm').key, KEYS.sl3);
    // Skipped: the Zigbee sub-device and the thermostat.
    assert.equal(r.tuya.devices.length, 5);
    const st = Object.fromEntries(r.devices.map(d => [d.name, d.status]));
    assert.deepEqual(st, { 'TV Unit Light': 'added', 'Bedroom LED': 'added', 'Kitchen Switch': 'updated', 'Laundry Switch': 'added', 'Smart Lighting 3': 'added', 'Door sensor': 'skipped', Thermostat: 'skipped' });
    // The report and its table never carry keys.
    const out = JSON.stringify(r.devices) + table(r.devices);
    for (const k of Object.values(KEYS)) assert.ok(!out.includes(k), 'no key in the report');
  });
});

test('Tuya cloud: a wrong secret is reported, and a uid lists that user\'s devices', async () => {
  await withCloud(async (baseUrl, fake) => {
    await assert.rejects(new TuyaCloud({ clientId: CLIENT_ID, secret: 'wrong', baseUrl }).listDevices(), /sign invalid/);
    fake.errors.length = 0;
    const list = await new TuyaCloud({ clientId: CLIENT_ID, secret: SECRET, baseUrl }).listDevices('eu123');
    // /v1.0/users/{uid}/devices isn't served by the fake, so it falls back to v1.3 iot-03.
    assert.deepEqual(list.map(d => d.id), ['bf8543c7df7a9b2f59cknm']);
    assert.ok(fake.calls.includes('GET /v1.0/users/eu123/devices'));
  });
});

test('Tuya cloud import over the API writes integrations.json (0600) and returns no keys', async () => {
  await withCloud(async baseUrl => {
    const dir = mkdtempSync(join(tmpdir(), 'kova-tuya-'));
    const path = join(dir, 'integrations.json');
    writeFileSync(path, JSON.stringify({ tuya: EXISTING, cast: { rooms: { Speaker: 'kitchen' } } }));
    const { hub } = await testHub();
    const app = await buildServer(hub, { webRoot: resolve(import.meta.dirname, '../../web'), integrationsPath: path, tuyaCloud: { baseUrl, discoverMs: 0 } });
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/integrations/tuya/cloud-import', payload: {} });
      assert.equal(bad.statusCode, 400);
      const res = await app.inject({ method: 'POST', url: '/api/integrations/tuya/cloud-import', payload: { clientId: CLIENT_ID, secret: SECRET, region: 'eu' } });
      assert.equal(res.statusCode, 200, res.body);
      for (const k of Object.values(KEYS)) assert.ok(!res.body.includes(k));
      assert.equal(res.json().devices.length, 7);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(saved.cast, { rooms: { Speaker: 'kitchen' } }, 'other integrations kept');
      assert.equal(saved.tuya.devices.find((d: { id: string }) => d.id === 'bf209b09a9baaec758qwlo').switches['2'].id, 'kitchen_ceiling');
      assert.equal(saved.tuya.devices.find((d: { id: string }) => d.id === 'bf21ef686e116a96c7dud5').key, KEYS.bed);
    } finally { await app.close(); await hub.stop(); }
  });
});

test('tuya-keys CLI: prints a table without keys and merges into integrations.json', async () => {
  await withCloud(async baseUrl => {
    const dir = mkdtempSync(join(tmpdir(), 'kova-tuya-cli-'));
    const path = join(dir, 'integrations.json');
    writeFileSync(path, JSON.stringify({ tuya: EXISTING }));
    writeFileSync(join(dir, 'home.json'), JSON.stringify({ rooms: ROOMS }));
    const cli = resolve(import.meta.dirname, '../src/tools/tuya-keys.ts');
    const out = await new Promise<string>((res, rej) => execFile(process.execPath, ['--import', 'tsx', cli, '--base-url', baseUrl, '--merge', path, '--no-discover'], {
      env: { ...process.env, TUYA_CLIENT_ID: CLIENT_ID, TUYA_SECRET: SECRET }, timeout: 30_000,
    }, (err, stdout, stderr) => (err ? rej(new Error(`${err.message}\n${stderr}`)) : res(stdout + stderr))));
    assert.match(out, /TV Unit Light/);
    assert.match(out, /1 updated/);
    for (const k of Object.values(KEYS)) assert.ok(!out.includes(k), 'no key printed');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as TuyaOptions & { tuya: TuyaOptions };
    assert.equal(saved.tuya.devices.length, 5);
    assert.equal(saved.tuya.devices.find(d => d.id === 'bf21ef686e116a96c7dud5')!.light!.room, 'bedroom');
  });
});

test('Tuya discovery: hears an encrypted broadcast on a configurable port', async () => {
  const port = await freeUdpPort();
  const stop = keepSending(port, [
    broadcast33({ ip: '192.168.1.230', gwId: 'bf209b09a9baaec758qwlo', active: 2, encrypt: true, productKey: 'k1', version: '3.3' }),
    broadcast35({ ip: '192.168.1.241', gwId: 'bf35device000001', version: '3.5' }),
    Buffer.from('not tuya at all'),
  ]);
  const t0 = Date.now();
  let found;
  try { found = await discover({ ports: [port], address: '127.0.0.1', durationMs: 5000, want: ['bf209b09a9baaec758qwlo', 'bf35device000001'] }); } finally { stop(); }
  assert.ok(Date.now() - t0 < 4000, 'stops early once every wanted device is heard');
  assert.deepEqual(found.get('bf209b09a9baaec758qwlo'), { id: 'bf209b09a9baaec758qwlo', ip: '192.168.1.230', version: '3.3', productKey: 'k1' });
  assert.deepEqual(found.get('bf35device000001'), { id: 'bf35device000001', ip: '192.168.1.241', version: '3.5' });
  // 3.1 devices broadcast plain JSON on 6666.
  const h = Buffer.alloc(16); const json = Buffer.from(JSON.stringify({ ip: '10.0.0.5', gwId: 'old31', version: '3.1' }));
  h.writeUInt32BE(0x55aa, 0); h.writeUInt32BE(json.length + 12, 12);
  assert.deepEqual(parseBroadcast(Buffer.concat([h, Buffer.alloc(4), json, Buffer.alloc(8)])), { id: 'old31', ip: '10.0.0.5', version: '3.1' });
  // With nothing broadcasting, discovery just ends after its duration.
  const quick = await discover({ ports: [port], durationMs: 100 });
  assert.equal(quick.size, 0);
});

test('Tuya light specs map to data points (v1 and v2) and colour round-trips', () => {
  const v2 = lightFromSpec([{ code: 'switch_led', dp: 20 }, { code: 'work_mode', dp: 21 }, { code: 'bright_value_v2', dp: 22, values: { min: 10, max: 1000 } }, { code: 'temp_value_v2', dp: 23, values: { min: 0, max: 1000 } }, { code: 'colour_data_v2', dp: 24, values: { h: { max: 360 }, s: { max: 1000 }, v: { max: 1000 } } }])!;
  assert.deepEqual(v2, { switch: '20', mode: '21', bri: '22', briMin: 10, briMax: 1000, temp: '23', tempMin: 0, tempMax: 1000, colour: '24', colourFormat: 'hsv16', colourMax: 1000 });
  // No dp_id and only _v2 codes → standard v2 numbering.
  assert.equal(lightFromSpec([{ code: 'switch_led' }, { code: 'bright_value_v2' }])!.switch, '20');
  const v1 = lightFromSpec([{ code: 'switch_led' }, { code: 'work_mode' }, { code: 'bright_value', values: { min: 25, max: 255 } }, { code: 'temp_value', values: { min: 0, max: 255 } }, { code: 'colour_data' }])!;
  assert.deepEqual(v1, { switch: '1', mode: '2', bri: '3', briMin: 25, briMax: 255, temp: '4', tempMin: 0, tempMax: 255, colour: '5', colourFormat: 'rgb8', colourMax: 255 });
  assert.equal(lightFromSpec([{ code: 'switch_1', dp: 1 }]), null);
  assert.deepEqual(switchesFromSpec([{ code: 'switch_2', dp: 2, type: 'Boolean' }, { code: 'switch_1', dp: 1, type: 'Boolean' }, { code: 'switch_led', dp: 20 }, { code: 'countdown_1', dp: 7 }] as TuyaDpSpec[]), ['1', '2']);

  // v2: white
  assert.deepEqual(lightToDps(v2, { on: true, bri: 100, k: 6500 }), { '20': true, '22': 1000, '23': 1000, '21': 'white' });
  // v2: colour → hhhhssssvvvv, and back
  const orange = lightToDps(v2, { color: '#ff8000', bri: 80 });
  assert.deepEqual(orange, { '24': '001e03e80320', '21': 'colour' });
  assert.deepEqual(dpsToLight(v2, { '20': true, ...orange }), { on: true, color: '#ff8000', bri: 80, k: null });
  // Dimming a light that shows a colour keeps the colour.
  assert.deepEqual(lightToDps(v2, { bri: 40 }, { color: '#ff8000', k: null, bri: 80 }), { '24': '001e03e80190', '21': 'colour' });
  // Back in white mode the colour clears.
  assert.deepEqual(dpsToLight(v2, { '20': true, '21': 'white', '22': 1000, '23': 0, '24': '001e03e80320' }), { on: true, bri: 100, k: 2700, color: null });
  // v1: rrggbb + hhhh + ss + vv, and back
  const green = lightToDps(v1, { color: '#00ff00' });
  assert.deepEqual(green, { '5': '00ff000078ffff', '2': 'colour' });
  assert.deepEqual(dpsToLight(v1, { '1': true, ...green }), { on: true, color: '#00ff00', bri: 100, k: null });
  assert.deepEqual(lightToDps(v1, { bri: 100, k: 2700 }), { '3': 255, '4': 0, '2': 'white' });
  assert.deepEqual(dpsToLight(v1, { '2': 'white', '3': 25, '4': 255 }), { bri: 1, k: 6500, color: null });
  // JSON colour ({"h","s","v"}), as some firmware reports it.
  const j = { ...v2, colourFormat: 'json' as const };
  const blue = lightToDps(j, { color: '#0000ff', bri: 50 });
  assert.deepEqual(blue, { '24': '{"h":240,"s":1000,"v":500}', '21': 'colour' });
  assert.deepEqual(dpsToLight(j, blue), { color: '#0000ff', bri: 50, k: null });
});

test('Tuya merge: a light that already exists keeps its name, room and id but takes the spec\'s data points', () => {
  const existing: TuyaOptions = { devices: [{ id: 'bfL', host: '192.168.1.50', key: 'kkkkkkkkkkkkkkkk', light: { switch: '1', name: 'TV Unit Light', room: 'living_room', id: 'lounge_tv_light' } }] };
  const { tuya, devices } = mergeCloudDevices(existing, [{ id: 'bfL', name: 'TV Unit Light', key: 'nnnnnnnnnnnnnnnn', category: 'dj', spec: [{ code: 'switch_led', dp: 20 }, { code: 'colour_data_v2', dp: 24 }] }]);
  assert.deepEqual(tuya.devices[0].light, { switch: '20', colour: '24', colourFormat: 'hsv16', colourMax: 1000, name: 'TV Unit Light', room: 'living_room', id: 'lounge_tv_light' });
  assert.equal(tuya.devices[0].key, 'nnnnnnnnnnnnnnnn');
  assert.equal(devices[0].status, 'updated');
  assert.equal(devices[0].as, 'light (colour)');
});

test('Tuya cloud import: a Zigbee gateway becomes a connection, and the lights behind it are added with their node id', () => {
  const spec = [{ code: 'switch_led', dp: 20, type: 'Boolean' }, { code: 'bright_value_v2', dp: 22, type: 'Integer', values: { min: 10, max: 1000 } }];
  const { tuya, devices } = mergeCloudDevices(undefined, [
    { id: 'gw1', name: 'Zigbee Gateway', key: 'gatewaykey012345', ip: '10.10.30.128', category: 'wg2' },
    { id: 'zb1', name: 'Porch LED', category: 'dj', sub: true, nodeId: 'a1b2', gatewayId: 'gw1', spec },
    { id: 'zb2', name: 'Lost LED', category: 'dj', sub: true, spec },
    { id: 'gw2', name: 'Unused gateway', key: 'otherkey01234567', category: 'wg2' },
  ], { rooms: [{ id: 'porch', name: 'Porch' }] });
  const gw = tuya.devices.find(d => d.id === 'gw1')!;
  assert.equal(gw.host, '10.10.30.128');
  assert.equal(gw.light ?? gw.switches, undefined, 'the gateway is only a connection');
  const zb = tuya.devices.find(d => d.id === 'zb1')!;
  assert.equal(zb.gateway, 'gw1');
  assert.equal(zb.cid, 'a1b2');
  assert.equal(zb.light?.switch, '20');
  assert.equal(zb.light?.room, 'porch');
  assert.equal(devices.find(d => d.id === 'zb1')!.status, 'added');
  assert.equal(devices.find(d => d.id === 'gw1')!.as, 'gateway');
  assert.equal(devices.find(d => d.id === 'zb2')!.status, 'skipped', 'no gateway or node id');
  assert.equal(devices.find(d => d.id === 'gw2')!.status, 'skipped', 'a gateway nothing sits behind is left out');
});
