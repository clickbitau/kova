import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { TapoAdapter, hexToHs, hsToHex } from '../src/adapters/tapo.ts';

// A fake Tapo L535 bulb speaking KLAP v2, written out independently of the adapter.
const H = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const S1 = (s: string) => createHash('sha1').update(s).digest();

function fakeBulb(user: string, pass: string) {
  const auth = H(S1(user), S1(pass));
  const info: Record<string, unknown> = { device_id: '80225A7C0E1D2F3A4B5C6D7E8F901234', model: 'L535', nickname: Buffer.from('Lamp').toString('base64'), device_on: false, brightness: 50, color_temp: 2700, color_temp_range: [2500, 6500], hue: 0, saturation: 100 };
  let local: Buffer, remote: Buffer, key: Buffer, iv: Buffer, sig: Buffer;
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/app/handshake1') {
        local = body; remote = randomBytes(16);
        res.setHeader('set-cookie', 'TP_SESSIONID=ABC123;TIMEOUT=86400');
        res.end(Buffer.concat([remote, H(local, remote, auth)]));
        return;
      }
      if (req.headers.cookie !== 'TP_SESSIONID=ABC123') { res.statusCode = 403; res.end(); return; }
      if (url.pathname === '/app/handshake2') {
        if (!body.equals(H(remote, local, auth))) { res.statusCode = 403; res.end(); return; }
        const lh = Buffer.concat([local, remote, auth]);
        key = H(Buffer.from('lsk'), lh).subarray(0, 16); iv = H(Buffer.from('iv'), lh).subarray(0, 12); sig = H(Buffer.from('ldk'), lh).subarray(0, 28);
        res.end();
        return;
      }
      const seq = Number(url.searchParams.get('seq'));
      const sb = Buffer.alloc(4); sb.writeInt32BE(seq);
      const ivs = Buffer.concat([iv, sb]);
      assert.ok(body.subarray(0, 32).equals(H(sig, sb, body.subarray(32))), 'bad signature');
      const d = createDecipheriv('aes-128-cbc', key, ivs);
      const req2 = JSON.parse(Buffer.concat([d.update(body.subarray(32)), d.final()]).toString());
      calls.push(req2.method);
      if (req2.method === 'set_device_info') Object.assign(info, req2.params);
      const out = JSON.stringify({ error_code: 0, result: req2.method === 'get_device_info' ? info : {} });
      const c = createCipheriv('aes-128-cbc', key, ivs);
      const enc = Buffer.concat([c.update(out), c.final()]);
      res.end(Buffer.concat([H(sig, sb, enc), enc]));
    });
  });
  return { server, info, calls };
}

test('Tapo: KLAP handshake, reads the bulb, sets brightness, warmth and colour', async () => {
  const fake = fakeBulb('me@example.com', 'secret');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new TapoAdapter({ username: 'me@example.com', password: 'secret', devices: [{ host, room: 'lounge' }], pollMs: 0 }));
  try {
    const d = reg.list()[0];
    assert.equal(d.name, 'Lamp');
    assert.equal(d.type, 'dimmer');
    assert.deepEqual(d.capabilities, ['onoff', 'brightness', 'colorTemp', 'color']);
    assert.equal(d.state.on, false);
    assert.equal(d.state.k, 2700);
    await reg.command(d.id, { on: true, bri: 78, k: 3000 }, { kind: 'user', label: 'You' });
    assert.equal(fake.info.device_on, true);
    assert.equal(fake.info.brightness, 78);
    assert.equal(fake.info.color_temp, 3000);
    await reg.command(d.id, { color: '#0096ff' }, { kind: 'user', label: 'You' });
    assert.equal(fake.info.color_temp, 0);
    assert.equal(fake.info.hue, 205);
  } finally { await reg.stop(); fake.server.close(); }
});

test('Tapo: wrong password is reported, not thrown', async () => {
  const fake = fakeBulb('me@example.com', 'secret');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  const tapo = new TapoAdapter({ username: 'me@example.com', password: 'wrong', devices: [{ host, room: 'lounge' }], pollMs: 0 });
  await reg.addAdapter(tapo);
  assert.equal(reg.list().length, 0);
  assert.equal(tapo.status().ok, false);
  await reg.stop(); fake.server.close();
});

test('hue/saturation conversions round-trip', () => {
  assert.deepEqual(hexToHs('#ff0000'), { hue: 0, saturation: 100 });
  assert.deepEqual(hexToHs('#0096ff'), { hue: 205, saturation: 100 });
  assert.equal(hsToHex(120, 100), '#00ff00');
  assert.equal(hsToHex(205, 100), '#0095ff');
});
