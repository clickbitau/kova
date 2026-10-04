import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { TuyaAdapter, lightToDps, dpsToLight } from '../src/adapters/tuya/index.ts';

// A fake Tuya switch. Its framing and crypto are written out here independently
// of the adapter's protocol module, so the two check each other.

const KEY = Buffer.from('0123456789abcdef');
const enc = (k: Buffer, b: Buffer, pad = true) => { const c = createCipheriv('aes-128-ecb', k, null); c.setAutoPadding(pad); return Buffer.concat([c.update(b), c.final()]); };
const dec = (k: Buffer, b: Buffer) => { const d = createDecipheriv('aes-128-ecb', k, null); return Buffer.concat([d.update(b), d.final()]); };
const mac = (k: Buffer, b: Buffer) => createHmac('sha256', k).update(b).digest();

function frame(seq: number, cmd: number, payload: Buffer, hk?: Buffer): Buffer {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(0x55aa, 0); h.writeUInt32BE(seq, 4); h.writeUInt32BE(cmd, 8);
  h.writeUInt32BE(payload.length + (hk ? 32 : 4) + 4, 12);
  const body = Buffer.concat([h, payload]);
  const chk = hk ? mac(hk, body) : Buffer.from([0, 0, 0, 0]);
  if (!hk) chk.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([body, chk, Buffer.from([0, 0, 0xaa, 0x55])]);
}

// 3.5 "6699" frames: 18-byte header, then IV + AES-GCM ciphertext + tag, header[4:] as associated data.
function frame35(seq: number, cmd: number, plain: Buffer, k: Buffer): Buffer {
  const h = Buffer.alloc(18);
  h.writeUInt32BE(0x6699, 0); h.writeUInt32BE(seq, 6); h.writeUInt32BE(cmd, 10); h.writeUInt32BE(12 + plain.length + 16, 14);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-128-gcm', k, iv); c.setAAD(h.subarray(4));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([h, iv, ct, c.getAuthTag(), Buffer.from([0, 0, 0x99, 0x66])]);
}
function open35(f: Buffer, k: Buffer): Buffer | null {
  const len = f.readUInt32BE(14);
  const d = createDecipheriv('aes-128-gcm', k, f.subarray(18, 30)); d.setAAD(f.subarray(4, 18)); d.setAuthTag(f.subarray(18 + len - 16, 18 + len));
  try { return Buffer.concat([d.update(f.subarray(30, 18 + len - 16)), d.final()]); } catch { return null; }
}

/** A fake Tuya device; with `subs`, a gateway too: messages naming a `cid` are for that sub-device's data points. */
function fakeSwitch(version: '3.3' | '3.4' | '3.5', dps: Record<string, unknown>, subs: Record<string, Record<string, unknown>> = {}) {
  const seen: { cmd: number; json?: unknown }[] = [];
  const errors: string[] = [];
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    let session: Buffer | undefined;
    let localNonce: Buffer | undefined;
    const remoteNonce = randomBytes(16);
    const hk = () => (version === '3.4' ? session ?? KEY : undefined);
    const key = () => session ?? KEY;
    const rc = Buffer.alloc(4);
    let devSeq = 1000; // 3.5 devices number their replies with their own counter
    const push = (seq: number, cmd: number, payload: Buffer) => sock.write(version === '3.5' ? frame35(devSeq++, cmd, payload, key()) : frame(seq, cmd, payload, hk()));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (version === '3.5') {
        while (buf.length >= 18) {
          const len = buf.readUInt32BE(14);
          if (buf.length < 18 + len + 4) break;
          const f = buf.subarray(0, 18 + len + 4);
          buf = buf.subarray(18 + len + 4);
          const cmd = f.readUInt32BE(10);
          if (f.readUInt32BE(0) !== 0x6699) { errors.push('bad prefix'); sock.destroy(); return; }
          const plain = open35(f, key());
          if (!plain) { errors.push(`bad GCM tag on cmd ${cmd}`); sock.destroy(); return; }
          if (cmd === 3) {
            localNonce = plain;
            push(0, 4, Buffer.concat([rc, remoteNonce, mac(KEY, localNonce)]));
            continue;
          }
          if (cmd === 5) {
            if (!plain.equals(mac(KEY, remoteNonce))) { errors.push('bad finish'); sock.destroy(); return; }
            const x = Buffer.alloc(16);
            for (let i = 0; i < 16; i++) x[i] = localNonce![i] ^ remoteNonce[i];
            const c = createCipheriv('aes-128-gcm', KEY, localNonce!.subarray(0, 12));
            session = Buffer.concat([c.update(x), c.final()]).subarray(0, 16);
            continue;
          }
          const body = plain.subarray(0, 3).toString() === '3.5' ? plain.subarray(15) : plain;
          const json = body.length ? JSON.parse(body.toString()) : undefined;
          seen.push({ cmd, json });
          if (cmd === 9) { push(0, 9, rc); continue; }
          if (cmd === 0x10) {
            const cid = json?.cid;
            push(0, 0x10, Buffer.concat([rc, Buffer.from(JSON.stringify({ protocol: 4, data: cid ? { cid, dps: subs[cid] } : { dps } }))]));
            continue;
          }
          if (cmd === 0x0d) {
            const cid = json.data.cid;
            Object.assign(cid ? subs[cid] : dps, json.data.dps);
            push(0, 0x0d, rc);
            push(0, 8, Buffer.concat([rc, Buffer.from('3.5'), Buffer.alloc(12), Buffer.from(JSON.stringify({ protocol: 4, data: cid ? { cid, dps: json.data.dps } : { dps: json.data.dps } }))]));
          }
        }
        return;
      }
      while (buf.length >= 16) {
        const len = buf.readUInt32BE(12);
        if (buf.length < 16 + len) break;
        const f = buf.subarray(0, 16 + len);
        buf = buf.subarray(16 + len);
        const seq = f.readUInt32BE(4), cmd = f.readUInt32BE(8);
        const tl = version === '3.4' ? 32 : 4;
        const body = f.subarray(0, f.length - tl - 4);
        const chk = f.subarray(f.length - tl - 4, f.length - 4);
        const ok = version === '3.4' ? mac(hk()!, body).equals(chk) : (crc32(body) >>> 0) === chk.readUInt32BE(0);
        if (!ok) { errors.push(`bad check on cmd ${cmd}`); sock.destroy(); return; }
        const payload = body.subarray(16);
        if (version === '3.4' && cmd === 3) {
          localNonce = dec(KEY, payload);
          push(seq, 4, Buffer.concat([rc, enc(KEY, Buffer.concat([remoteNonce, mac(KEY, localNonce)]))]));
          continue;
        }
        if (version === '3.4' && cmd === 5) {
          if (!dec(KEY, payload).equals(mac(KEY, remoteNonce))) { errors.push('bad finish'); sock.destroy(); return; }
          const x = Buffer.alloc(16);
          for (let i = 0; i < 16; i++) x[i] = localNonce![i] ^ remoteNonce[i];
          session = enc(KEY, x, false);
          continue;
        }
        let plain: Buffer = version === '3.3' && payload.subarray(0, 3).toString() === '3.3' ? dec(KEY, payload.subarray(15)) : dec(key(), payload);
        if (plain.subarray(0, 3).toString() === version) plain = plain.subarray(15);
        const json = plain.length ? JSON.parse(plain.toString()) : undefined;
        seen.push({ cmd, json });
        if (cmd === 9) { push(seq, 9, rc); continue; }
        if (cmd === 0x0a || cmd === 0x10) {
          const cid = json?.cid;
          push(seq, cmd, Buffer.concat([rc, enc(key(), Buffer.from(JSON.stringify(cid ? { devId: 'dev1', cid, dps: subs[cid] } : { devId: 'dev1', dps })))]));
          continue;
        }
        if (cmd === 7 || cmd === 0x0d) {
          const set = cmd === 7 ? json.dps : json.data.dps;
          const cid = cmd === 7 ? json.cid : json.data.cid;
          Object.assign(cid ? subs[cid] : dps, set);
          push(seq, cmd, rc);
          const status = version === '3.4'
            ? enc(key(), Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12), Buffer.from(JSON.stringify({ protocol: 4, data: cid ? { cid, dps: set } : { dps: set } }))]))
            : Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12), enc(KEY, Buffer.from(JSON.stringify(cid ? { devId: 'dev1', cid, dps: set } : { devId: 'dev1', dps: set })))]);
          push(0, 8, Buffer.concat([rc, status]));
        }
      }
    });
  });
  return { server, seen, dps, errors };
}

async function setup(version: '3.3' | '3.4' | '3.5') {
  const fake = fakeSwitch(version, { '1': false, '2': true });
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  const reg = new Registry(new Store(':memory:'));
  const tuya = new TuyaAdapter({ devices: [{ id: 'dev1', host: '127.0.0.1', port, key: KEY.toString(), version, switches: { '1': { name: 'Kitchen light', room: 'kitchen' }, '2': { name: 'Dining light', room: 'kitchen' } } }] });
  await reg.addAdapter(tuya);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(fn()); };
  return { fake, reg, tuya, until, done: async () => { await reg.stop(); fake.server.close(); } };
}

for (const version of ['3.3', '3.4', '3.5'] as const) {
  test(`Tuya ${version}: reads state, switches a channel, hears the device's report`, async () => {
    const { fake, reg, until, done } = await setup(version);
    try {
      await until(() => reg.get('tuya_dev1_2')?.state.on === true);
      assert.equal(reg.get('tuya_dev1_1')!.state.on, false);
      assert.equal(reg.get('tuya_dev1_1')!.room, 'kitchen');
      await reg.command('tuya_dev1_1', { on: true }, { kind: 'user', label: 'You' });
      assert.equal(fake.dps['1'], true);
      assert.ok(fake.seen.some(s => s.cmd === (version === '3.3' ? 7 : 0x0d)));
      await until(() => reg.get('tuya_dev1_1')!.state.on === true);
      assert.deepEqual(fake.errors, []);
      assert.equal(reg.adapters.get('tuya')!.status().ok, true);
    } finally { await done(); }
  });
}

for (const version of ['3.4', '3.5'] as const) {
  test(`Tuya: wrong local key fails the ${version} handshake instead of hanging`, async () => {
    const fake = fakeSwitch(version, { '1': false });
    await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
    const port = (fake.server.address() as AddressInfo).port;
    const { TuyaConnection } = await import('../src/adapters/tuya/connection.ts');
    const c = new TuyaConnection({ id: 'dev1', host: '127.0.0.1', port, key: 'ffffffffffffffff', version, timeoutMs: 500 });
    await assert.rejects(c.connect());
    c.close();
    fake.server.close();
  });
}

for (const version of ['3.3', '3.4', '3.5'] as const) {
  test(`Tuya ${version}: Zigbee lights behind a gateway, through the gateway's connection`, async () => {
    const fake = fakeSwitch(version, {}, { a1b2: { '1': false }, c3d4: { '20': true, '22': 500 } });
    await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
    const port = (fake.server.address() as AddressInfo).port;
    const reg = new Registry(new Store(':memory:'));
    const tuya = new TuyaAdapter({ devices: [
      { id: 'gw1', host: '127.0.0.1', port, key: KEY.toString(), version, name: 'Zigbee gateway' },
      { id: 'zb1', host: '', key: '', gateway: 'gw1', cid: 'a1b2', switches: { '1': { name: 'Porch LED', room: 'porch', id: 'porch_led' } } },
      { id: 'zb2', host: '', key: '', gateway: 'gw1', cid: 'c3d4', light: { switch: '20', bri: '22', briMin: 10, briMax: 1000, name: 'Desk LED', room: 'office', id: 'desk_led' } },
    ] });
    await reg.addAdapter(tuya);
    const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(f()); };
    try {
      assert.deepEqual(reg.list().map(d => d.id).sort(), ['desk_led', 'porch_led'], 'the gateway itself is no device');
      // Each sub-device's state, asked for by node id.
      await until(() => reg.get('porch_led')!.state.on === false && reg.get('desk_led')!.state.on === true);
      await reg.command('porch_led', { on: true }, { kind: 'user', label: 'You' });
      await until(() => reg.get('porch_led')!.state.on === true);
      const ctl = fake.seen.filter(x => x.cmd === 7 || x.cmd === 0x0d).at(-1)!.json as { cid?: string; data?: { cid?: string } };
      assert.equal(ctl.cid ?? ctl.data?.cid, 'a1b2', 'the command names the light');
      assert.equal(reg.get('desk_led')!.state.on, true, 'the other light is untouched');
      assert.equal(tuya.status().ok, true);
      assert.match(tuya.status().note!, /2 devices/);
    } finally { await reg.stop(); fake.server.close(); }
  });
}

test('Tuya 3.5: a colour light on the v2 data points, end to end', async () => {
  const fake = fakeSwitch('3.5', { '20': true, '21': 'white', '22': 1000, '23': 0, '24': '000003e803e8' });
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  const reg = new Registry(new Store(':memory:'));
  const light = { switch: '20', mode: '21', bri: '22', temp: '23', colour: '24', colourFormat: 'hsv16' as const, colourMax: 1000 };
  await reg.addAdapter(new TuyaAdapter({ devices: [{ id: 'dev1', host: '127.0.0.1', port, key: KEY.toString(), version: '3.5', light: { ...light, name: 'TV Unit Light', room: 'lounge', id: 'tv_unit_light' } }] }));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(fn()); };
  try {
    await until(() => reg.get('tv_unit_light')?.state.bri === 100);
    assert.deepEqual(reg.get('tv_unit_light')!.capabilities, ['onoff', 'brightness', 'colorTemp', 'color']);
    assert.equal(reg.get('tv_unit_light')!.state.k, 2700);
    await reg.command('tv_unit_light', { color: '#0000ff', bri: 50 }, { kind: 'user', label: 'You' });
    assert.equal(fake.dps['21'], 'colour');
    assert.equal(fake.dps['24'], '00f003e801f4');
    await until(() => reg.get('tv_unit_light')!.state.color === '#0000ff');
    assert.equal(reg.get('tv_unit_light')!.state.bri, 50);
    assert.deepEqual(fake.errors, []);
  } finally { await reg.stop(); fake.server.close(); }
});

test('Tuya light data points map both ways', () => {
  const l = { switch: '20', bri: '22', temp: '23', mode: '21' };
  assert.deepEqual(lightToDps(l, { on: true, bri: 100, k: 6500 }), { '20': true, '22': 1000, '23': 1000, '21': 'white' });
  assert.deepEqual(lightToDps(l, { bri: 1, k: 2700 }), { '22': 10, '23': 0, '21': 'white' });
  assert.deepEqual(dpsToLight(l, { '20': false, '22': 500, '23': 500 }), { on: false, bri: 50, k: 4600 });
});

test('a light whose spec guessed the wrong dps re-points to the ones the device reports', async () => {
  // The cloud spec gave no dp ids, so the import guessed the v2 layout (20/22) — but the device speaks v1 (1/3).
  const fake = fakeSwitch('3.5', { '1': false, '3': 478 });
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new TuyaAdapter({ devices: [{ id: 'dev1', host: '127.0.0.1', port, key: KEY.toString(), version: '3.5', light: { switch: '20', bri: '22', briMin: 10, briMax: 1000, name: 'Office LED', room: 'office', id: 'office_led' } }] }));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(fn()); };
  try {
    await until(() => reg.get('office_led')?.state.on === false);
    assert.equal(reg.get('office_led')!.state.bri, 48, 'brightness comes from the real dp');
    await reg.command('office_led', { on: true, bri: 50 }, { kind: 'user', label: 'You' });
    await until(() => fake.dps['1'] === true);
    assert.equal(fake.dps['3'], 500, 'commands go to the device dps, not the guessed ones');
  } finally { await reg.stop(); fake.server.close(); }
});
