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

function fakeSwitch(version: '3.3' | '3.4', dps: Record<string, unknown>) {
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
    const push = (seq: number, cmd: number, payload: Buffer) => sock.write(frame(seq, cmd, payload, hk()));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
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
        let plain = version === '3.3' && payload.subarray(0, 3).toString() === '3.3' ? dec(KEY, payload.subarray(15)) : dec(key(), payload);
        if (plain.subarray(0, 3).toString() === version) plain = plain.subarray(15);
        const json = plain.length ? JSON.parse(plain.toString()) : undefined;
        seen.push({ cmd, json });
        if (cmd === 9) { push(seq, 9, rc); continue; }
        if (cmd === 0x0a || cmd === 0x10) {
          push(seq, cmd, Buffer.concat([rc, enc(key(), Buffer.from(JSON.stringify({ devId: 'dev1', dps })))]));
          continue;
        }
        if (cmd === 7 || cmd === 0x0d) {
          const set = cmd === 7 ? json.dps : json.data.dps;
          Object.assign(dps, set);
          push(seq, cmd, rc);
          const status = version === '3.4'
            ? enc(key(), Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12), Buffer.from(JSON.stringify({ protocol: 4, data: { dps: set } }))]))
            : Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12), enc(KEY, Buffer.from(JSON.stringify({ devId: 'dev1', dps: set })))]);
          push(0, 8, Buffer.concat([rc, status]));
        }
      }
    });
  });
  return { server, seen, dps, errors };
}

async function setup(version: '3.3' | '3.4') {
  const fake = fakeSwitch(version, { '1': false, '2': true });
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  const reg = new Registry(new Store(':memory:'));
  const tuya = new TuyaAdapter({ devices: [{ id: 'dev1', host: '127.0.0.1', port, key: KEY.toString(), version, switches: { '1': { name: 'Kitchen light', room: 'kitchen' }, '2': { name: 'Dining light', room: 'kitchen' } } }] });
  await reg.addAdapter(tuya);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(fn()); };
  return { fake, reg, tuya, until, done: async () => { await reg.stop(); fake.server.close(); } };
}

for (const version of ['3.3', '3.4'] as const) {
  test(`Tuya ${version}: reads state, switches a channel, hears the device's report`, async () => {
    const { fake, reg, until, done } = await setup(version);
    try {
      await until(() => reg.get('tuya_dev1_2')?.state.on === true);
      assert.equal(reg.get('tuya_dev1_1')!.state.on, false);
      assert.equal(reg.get('tuya_dev1_1')!.room, 'kitchen');
      await reg.command('tuya_dev1_1', { on: true }, { kind: 'user', label: 'You' });
      assert.equal(fake.dps['1'], true);
      assert.ok(fake.seen.some(s => s.cmd === (version === '3.4' ? 0x0d : 7)));
      await until(() => reg.get('tuya_dev1_1')!.state.on === true);
      assert.deepEqual(fake.errors, []);
      assert.equal(reg.adapters.get('tuya')!.status().ok, true);
    } finally { await done(); }
  });
}

test('Tuya: wrong local key fails the 3.4 handshake instead of hanging', async () => {
  const fake = fakeSwitch('3.4', { '1': false });
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const port = (fake.server.address() as AddressInfo).port;
  const { TuyaConnection } = await import('../src/adapters/tuya/connection.ts');
  const c = new TuyaConnection({ id: 'dev1', host: '127.0.0.1', port, key: 'ffffffffffffffff', version: '3.4', timeoutMs: 500 });
  await assert.rejects(c.connect());
  c.close();
  fake.server.close();
});

test('Tuya light data points map both ways', () => {
  const l = { switch: '20', bri: '22', temp: '23', mode: '21' };
  assert.deepEqual(lightToDps(l, { on: true, bri: 100, k: 6500 }), { '20': true, '22': 1000, '23': 1000, '21': 'white' });
  assert.deepEqual(lightToDps(l, { bri: 1, k: 2700 }), { '22': 10, '23': 0, '21': 'white' });
  assert.deepEqual(dpsToLight(l, { '20': false, '22': 500, '23': 500 }), { on: false, bri: 50, k: 4600 });
});
