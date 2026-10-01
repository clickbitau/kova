import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { SamsungTvAdapter, inputKey, keyMessage, magicPacket, parseInfo, remoteUrl, renderingControlUrl, volumeSteps, type SamsungTvOptions } from '../src/adapters/samsung-tv.ts';

// `ws` comes with @fastify/websocket; the fake TV uses it so the adapter's own WebSocket client is tested against another implementation.
const { WebSocketServer } = (await import('ws' as string)) as { WebSocketServer: any };

/** A self-signed certificate made now, or null when openssl isn't installed (then the fake TV uses plain ws://). */
function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tvcert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=SmartViewSDK'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } catch { return null; }
}
const CERT = selfSigned();

const DMR = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/upnp/control/ConnectionManager1</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service>
</serviceList></device></root>`;

/** A fake QA55S90D: info + DLNA over HTTP, the remote over (w)ss. */
async function fakeTv() {
  const tv = { power: 'on' as 'on' | 'standby', vol: 12, failSetVolume: false, token: 'T-123', prompts: 0, keys: [] as string[], urls: [] as string[], soap: [] as string[] };
  const web = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/api/v2/') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ name: '[TV] Samsung S90D', device: { PowerState: tv.power, name: '[TV] Samsung S90D', modelName: 'QA55S90DAWXXY', wifiMac: 'a0:d7:f3:11:22:33', type: 'Samsung SmartTV' } }));
      }
      if (req.url === '/dmr') return res.end(DMR);
      if (req.url === '/upnp/control/RenderingControl1') {
        const action = String(req.headers.soapaction).split('#')[1].replace('"', '');
        tv.soap.push(action);
        if (action === 'GetVolume') return res.end(`<s:Envelope><s:Body><u:GetVolumeResponse><CurrentVolume>${tv.vol}</CurrentVolume></u:GetVolumeResponse></s:Body></s:Envelope>`);
        if (action === 'SetVolume') {
          if (tv.failSetVolume) { res.statusCode = 500; return res.end(); }
          tv.vol = Number(body.match(/<DesiredVolume>(\d+)</)![1]);
          return res.end('<s:Envelope><s:Body><u:SetVolumeResponse/></s:Body></s:Envelope>');
        }
      }
      res.statusCode = 404; res.end();
    });
  });
  const remote = CERT ? https.createServer(CERT) : http.createServer();
  const wss = new WebSocketServer({ server: remote });
  wss.on('connection', (sock: any, req: http.IncomingMessage) => {
    tv.urls.push(req.url!);
    const u = new URL(req.url!, 'http://x');
    assert.equal(u.pathname, '/api/v2/channels/samsung.remote.control');
    const token = u.searchParams.get('token');
    if (token && token !== tv.token) { sock.send(JSON.stringify({ event: 'ms.channel.unauthorized' })); sock.close(); return; }
    if (!token) tv.prompts++; // the TV shows "Allow Kova?"; this one says yes straight away
    sock.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'c1', clients: [], ...(token ? {} : { token: tv.token }) } }));
    sock.on('message', (m: Buffer) => {
      const j = JSON.parse(m.toString());
      assert.equal(j.method, 'ms.remote.control');
      assert.deepEqual({ ...j.params, DataOfCmd: undefined }, { Cmd: 'Click', DataOfCmd: undefined, Option: 'false', TypeOfRemote: 'SendRemoteKey' });
      tv.keys.push(j.params.DataOfCmd);
    });
  });
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => remote.listen(0, '127.0.0.1', r));
  const wol = dgram.createSocket('udp4');
  const packets: Buffer[] = [];
  wol.on('message', m => packets.push(m));
  await new Promise<void>(r => wol.bind(0, '127.0.0.1', r));
  const ports = { info: (web.address() as AddressInfo).port, dlna: (web.address() as AddressInfo).port, remote: (remote.address() as AddressInfo).port };
  const close = () => {
    for (const c of wss.clients) c.terminate();
    wss.close(); remote.closeAllConnections(); remote.close(); web.closeAllConnections(); web.close(); wol.close();
  };
  return { tv, ports, wol: { address: '127.0.0.1', port: (wol.address() as AddressInfo).port }, packets, close };
}

const until = async (what: string, ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 10)); }
};

const opts = (f: Awaited<ReturnType<typeof fakeTv>>, storageDir: string, extra: Partial<SamsungTvOptions> = {}): SamsungTvOptions => ({
  tvs: [{ host: '127.0.0.1', room: 'lounge', id: 'lounge_tv' }], storageDir, pollMs: 0, ports: f.ports, secure: !!CERT,
  wol: f.wol, keyDelayMs: 0, pairTimeoutMs: 2000, timeoutMs: 1000, ...extra,
});
const you = { kind: 'user' as const, label: 'You' };

test('Samsung TV: pairs, saves the token, reads power and volume, sets volume, switches off, and reuses the token', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  const dir = mkdtempSync(join(tmpdir(), 'tv-'));
  const reg = new Registry(new Store(':memory:'));
  const a = new SamsungTvAdapter(opts(f, dir));
  try {
    await reg.addAdapter(a);
    const d = reg.get('lounge_tv')!;
    assert.equal(d.type, 'tv');
    assert.equal(d.name, '[TV] Samsung S90D');
    assert.equal(d.integration, 'Samsung QA55S90DAWXXY');
    assert.deepEqual(d.capabilities, ['onoff', 'volume', 'input']);
    assert.equal(d.state.on, true);
    assert.equal(d.state.online, true);
    assert.equal(d.state.vol, 12);

    // Starting with the TV on asks for permission straight away; the token is kept owner-only.
    const file = join(dir, 'tokens.json');
    await until('token file', () => existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { '127.0.0.1': 'T-123' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(f.tv.prompts, 1);
    assert.ok(f.tv.urls[0].includes(`name=${encodeURIComponent(Buffer.from('Kova').toString('base64'))}`));

    await reg.command(d.id, { vol: 30 }, you);
    assert.equal(f.tv.vol, 30, 'DLNA SetVolume');
    assert.deepEqual(f.tv.keys, []);

    await reg.command(d.id, { on: false }, you);
    await until('KEY_POWER', () => f.tv.keys.length === 1);
    assert.deepEqual(f.tv.keys, ['KEY_POWER']);
    await reg.stop();

    // A restart: the saved token is sent, and the TV doesn't ask again.
    const reg2 = new Registry(new Store(':memory:'));
    await reg2.addAdapter(new SamsungTvAdapter(opts(f, dir)));
    await reg2.command('lounge_tv', { on: false }, you);
    await until('second KEY_POWER', () => f.tv.keys.length === 2);
    assert.equal(f.tv.prompts, 1);
    assert.ok(f.tv.urls.at(-1)!.includes('token=T-123'));
    await reg2.stop();
  } finally { await reg.stop(); f.close(); }
});

test('Samsung TV: on when in standby sends Wake-on-LAN to the MAC it reported', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  f.tv.power = 'standby';
  const reg = new Registry(new Store(':memory:'));
  const a = new SamsungTvAdapter(opts(f, mkdtempSync(join(tmpdir(), 'tv-'))));
  try {
    await reg.addAdapter(a);
    assert.equal(reg.get('lounge_tv')!.state.on, false);
    assert.equal(reg.get('lounge_tv')!.state.online, true);
    await reg.command('lounge_tv', { on: true }, you);
    await until('magic packet', () => f.packets.length === 1);
    assert.deepEqual(f.packets[0], Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from('a0d7f3112233', 'hex'))]));
    assert.equal(f.tv.urls.length, 0, 'no remote connection while off');
    assert.deepEqual(f.tv.keys, []);

    // Then it comes on: the next poll says so.
    f.tv.power = 'on';
    await a.poll();
    assert.equal(reg.get('lounge_tv')!.state.on, true);
  } finally { await reg.stop(); f.close(); }
});

test('Samsung TV: an input asked for straight after "on" waits for the TV to wake (Helix sends them back to back)', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  f.tv.power = 'standby';
  const reg = new Registry(new Store(':memory:'));
  const a = new SamsungTvAdapter(opts(f, mkdtempSync(join(tmpdir(), 'tv-')), { wakeCheckMs: 50, wakeWaitMs: 5000 }));
  try {
    await reg.addAdapter(a);
    await reg.command('lounge_tv', { on: true }, you);
    // The TV boots a moment later.
    setTimeout(() => { f.tv.power = 'on'; }, 300);
    await reg.command('lounge_tv', { input: 'hdmi2' }, you);
    await until('KEY_HDMI2', () => f.tv.keys.length === 1);
    assert.deepEqual(f.tv.keys, ['KEY_HDMI2']);
  } finally { await reg.stop(); f.close(); }
});

test('Samsung TV: input presses the HDMI / TV key every time, and refuses while off', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  const reg = new Registry(new Store(':memory:'));
  const a = new SamsungTvAdapter(opts(f, mkdtempSync(join(tmpdir(), 'tv-'))));
  try {
    await reg.addAdapter(a);
    await reg.command('lounge_tv', { input: 'hdmi2' }, you);
    await until('KEY_HDMI2', () => f.tv.keys.length === 1);
    assert.equal(reg.get('lounge_tv')!.state.input, null, 'not kept: the TV cannot be asked');
    // Someone used the TV's own remote since; asking again presses the key again.
    await reg.command('lounge_tv', { input: 'hdmi2' }, you);
    await reg.command('lounge_tv', { input: 'tv' }, you);
    await until('three keys', () => f.tv.keys.length === 3);
    assert.deepEqual(f.tv.keys, ['KEY_HDMI2', 'KEY_HDMI2', 'KEY_TV']);
    await assert.rejects(reg.command('lounge_tv', { input: 'hdmi9' }, you), /Unknown TV input/);

    f.tv.power = 'standby';
    await a.poll();
    await assert.rejects(reg.command('lounge_tv', { input: 'hdmi1' }, you), /is off/);
  } finally { await reg.stop(); f.close(); }
});

test('Samsung TV: falls back to volume keys when DLNA SetVolume fails', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  f.tv.failSetVolume = true;
  const reg = new Registry(new Store(':memory:'));
  try {
    await reg.addAdapter(new SamsungTvAdapter(opts(f, mkdtempSync(join(tmpdir(), 'tv-')))));
    await reg.command('lounge_tv', { vol: 15 }, you);
    await until('three volume-up presses', () => f.tv.keys.length === 3);
    assert.deepEqual(f.tv.keys, ['KEY_VOLUP', 'KEY_VOLUP', 'KEY_VOLUP']);
  } finally { await reg.stop(); f.close(); }
});

test('Samsung TV: an unreachable TV is off and offline', { timeout: 15_000 }, async () => {
  const f = await fakeTv();
  f.close(); // nothing listening any more
  const reg = new Registry(new Store(':memory:'));
  const a = new SamsungTvAdapter(opts(f, mkdtempSync(join(tmpdir(), 'tv-')), { tvs: [{ host: '127.0.0.1', room: 'lounge', name: 'Lounge TV', id: 'lounge_tv' }] }));
  try {
    await reg.addAdapter(a);
    const d = reg.get('lounge_tv')!;
    assert.equal(d.name, 'Lounge TV');
    assert.equal(d.state.on, false);
    assert.equal(d.state.online, false);
    await assert.rejects(reg.command('lounge_tv', { on: true }, you), /MAC/, 'no MAC known yet');
  } finally { await reg.stop(); }
});

test('Samsung TV helpers', () => {
  assert.equal(remoteUrl('10.0.0.20', 8002, 'Kova', 'abc'), 'wss://10.0.0.20:8002/api/v2/channels/samsung.remote.control?name=S292YQ%3D%3D&token=abc');
  assert.equal(remoteUrl('10.0.0.20', 8002, 'Kova', undefined, false), 'ws://10.0.0.20:8002/api/v2/channels/samsung.remote.control?name=S292YQ%3D%3D');
  assert.deepEqual(JSON.parse(keyMessage('KEY_POWER')), { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_POWER', Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  assert.equal(inputKey('hdmi1'), 'KEY_HDMI1');
  assert.equal(inputKey('hdmi4'), 'KEY_HDMI4');
  assert.equal(inputKey('tv'), 'KEY_TV');
  assert.throws(() => inputKey('hdmi5'));
  const p = magicPacket('AA-BB-CC-DD-EE-FF');
  assert.equal(p.length, 102);
  assert.equal(p.subarray(96).toString('hex'), 'aabbccddeeff');
  assert.throws(() => magicPacket('nope'));
  assert.deepEqual(volumeSteps(20, 17), { key: 'KEY_VOLDOWN', n: 3 });
  assert.deepEqual(parseInfo({ device: { PowerState: 'standby', modelName: 'X' } }).on, false);
  assert.deepEqual(parseInfo({ device: {} }).on, true, 'older TVs without PowerState are on when they answer');
  assert.equal(renderingControlUrl(DMR), '/upnp/control/RenderingControl1');
});
