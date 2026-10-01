import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { INTERNET_ID, WARDEN_SCOPES, WardenAdapter, internetId, type WardenDevice } from '../src/adapters/warden.ts';
import { Presence } from '../src/services/presence.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

function selfSigned(cn: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'warden-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

const until = async (what: string, ok: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !ok(); t += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/** Warden with device records, people, pairing by code and the live feed, over HTTPS like the real box. */
async function fakeWarden() {
  const TOKEN = 'cr_' + 'k'.repeat(64);
  const tablet: WardenDevice = { id: 'dev_tablet', name: 'Aisha’s iPad', class: 'tablet', vendor: 'Apple', macs: ['aa:bb:cc:00:00:01'], ips: ['10.10.0.40'], online: true, paused: false, network: { id: 'lan', name: 'Home' } };
  const phone: WardenDevice = { id: 'dev_phone', name: 'Methel’s iPhone', class: 'phone', owner: 'Methel', macs: ['da:a1:19:6e:02:5f'], ips: ['10.10.0.109'], online: true, paused: false };
  const s = {
    pair: { status: 'pending' as 'pending' | 'approved', collected: false, scopes: [] as string[] },
    devices: [tablet, phone],
    people: [{ id: 'methel', name: 'Methel', devices: ['dev_phone'], presence: { home: true, via: 'Methel’s iPhone' } }, { id: 'sam', name: 'Sam', devices: ['dev_sam'], presence: { home: false } }],
    seen: [] as string[],
    streams: [] as { res: ServerResponse; lastId?: string }[],
    seq: 0,
  };
  const server = https.createServer(selfSigned('warden.test'), (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const u = new URL(req.url!, 'https://x');
      const send = (code: number, j?: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); };
      s.seen.push(`${req.method} ${u.pathname}${raw ? ' ' + raw : ''}`);
      if (u.pathname === '/.well-known/wardenos-gateway') return send(200, { product: 'WardenOS', siteName: 'Methel Home' });
      if (u.pathname === '/api/v1/apps/pair' && req.method === 'POST') {
        s.pair.scopes = body.scopes;
        return send(201, { pairId: 'pr1', code: 'BM5632', pollSecret: 'ps', expiresAt: new Date(Date.now() + 600_000).toISOString(), pollUrl: '/api/v1/apps/pair/pr1' });
      }
      if (u.pathname === '/api/v1/apps/pair/pr1') {
        if (req.headers['x-pair-secret'] !== 'ps') return send(404, { message: 'no such request' });
        if (s.pair.status === 'approved' && !s.pair.collected) { s.pair.collected = true; return send(200, { status: 'approved', token: TOKEN, scopes: s.pair.scopes, role: 'operator' }); }
        return send(200, { status: s.pair.status });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'unauthorized' });
      if (u.pathname === '/api/v1/feed' && /event-stream/.test(String(req.headers.accept))) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('retry: 3000\n\n');
        const st = { res, lastId: req.headers['last-event-id'] as string | undefined };
        s.streams.push(st);
        res.on('close', () => { const i = s.streams.indexOf(st); if (i >= 0) s.streams.splice(i, 1); });
        return;
      }
      if (u.pathname === '/api/v1/dashboard') return send(200, { wanUp: true, clientCount: 2, last24h: { threatsBlocked: 0 } });
      if (u.pathname === '/api/v1/devices') return send(200, { devices: s.devices });
      if (u.pathname === '/api/v1/people') return send(200, { people: s.people });
      const byMac = /^\/api\/v1\/devices\/by-mac\/(.+)$/.exec(u.pathname);
      if (byMac) { const d = s.devices.find(x => x.macs.includes(decodeURIComponent(byMac[1]))); return d ? send(200, d) : send(404, { message: 'no device has that address' }); }
      const pause = /^\/api\/v1\/devices\/([^/]+)\/pause$/.exec(u.pathname);
      if (pause) {
        const d = s.devices.find(x => x.id === pause[1]);
        if (!d) return send(404, { message: 'no device has that ID' });
        d.paused = req.method === 'POST';
        return send(200, d);
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Publish an event to every open stream. */
  const publish = (type: string, data: unknown) => {
    const id = `evt_${++s.seq}`;
    for (const st of s.streams) st.res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, seq: s.seq, type, at: new Date().toISOString(), data })}\n\n`);
  };
  const drop = () => { for (const st of s.streams.splice(0)) st.res.end(); };
  return { url, s, TOKEN, tablet, phone, publish, drop, close: () => new Promise<void>(r => { drop(); server.closeAllConnections(); server.close(() => r()); }) };
}

test('Warden: pair with a code approved at /apps, then follow the live feed, device records and people', { timeout: 30_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-warden-feed-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, lanApps: { wardenPollMs: 50 } });
  try {
    // Pair: Kova asks for its scopes and shows the code Warden shows at /apps.
    const pr = await app.inject({ method: 'POST', url: '/api/integrations/warden/pair', payload: { url: w.url } });
    assert.equal(pr.statusCode, 200, pr.body);
    assert.equal(pr.json().code, 'BM5632');
    assert.match(pr.json().next, /\/apps .*BM5632/);
    assert.deepEqual(w.s.pair.scopes, WARDEN_SCOPES);
    assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/warden/pair' })).json().status, 'pending');
    // An admin approves it; Kova collects its token once and pins Warden's certificate.
    w.s.pair.status = 'approved';
    await until('token saved', () => manager.raw('warden')?.token === w.TOKEN);
    assert.match(String(manager.raw('warden')?.fingerprint), /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/warden/pair' })).json().status, 'approved');

    // Devices on the network come from Warden's device records, with their ids.
    const list = (await app.inject({ method: 'GET', url: '/api/integrations/warden/clients' })).json();
    assert.deepEqual(list.devices[0], { name: 'Aisha’s iPad · tablet · Apple · Home · aa:bb:cc:00:00:01 · 10.10.0.40', deviceId: 'dev_tablet', mac: 'aa:bb:cc:00:00:01', ip: '10.10.0.40', online: true });
    assert.match(list.devices[1].name, /^Methel’s iPhone · Methel’s · phone/);

    // An internet switch set up by MAC (as before) finds its device record, and keeps it when the MAC changes.
    await manager.update('warden', { ...manager.raw('warden'), pollSec: 0, devices: [{ mac: 'aa:bb:cc:00:00:01', name: 'Aisha’s iPad', room: 'lounge' }] });
    const id = internetId('aa:bb:cc:00:00:01');
    const adapter = t.hub.reg.adapters.get('warden') as WardenAdapter;
    await until('feed connected', () => w.s.streams.length === 1 && t.dev(id)?.online === true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(w.s.streams.length, 1, 'the first adapter’s stream closed when the settings changed');
    assert.equal(w.s.streams[0].lastId, undefined, 'starts from now');
    assert.deepEqual(t.dev(id), { on: true, online: true });
    w.tablet.macs = ['f2:00:00:00:00:99', 'aa:bb:cc:00:00:01'];
    await t.hub.engine.command(id, { on: false });
    assert.ok(w.s.seen.includes('POST /api/v1/devices/dev_tablet/pause'), w.s.seen.join('\n'));
    assert.equal(w.tablet.paused, true);

    // Live: the internet drops and comes back.
    w.publish('wan.down', { wan: 'wan1', wanName: 'NBN' });
    await until('internet down', () => t.dev(INTERNET_ID).on === false);
    assert.ok(adapter.status().note?.endsWith('· live'));
    w.publish('wan.up', { wan: 'wan1', wanName: 'NBN', downSeconds: 40 });
    await until('internet up', () => t.dev(INTERNET_ID).on === true);
    const feed = () => t.hub.store.feed(50).map(e => e.what);
    assert.ok(feed().includes('Internet is down') && feed().includes('Internet is back'), feed().join('\n'));

    // Someone unpauses the iPad in the Warden app; it goes offline; a new device joins; an attack is blocked.
    w.publish('pause.changed', { mac: 'f2:00:00:00:00:99', paused: false, deviceId: 'dev_tablet' });
    await until('unpaused', () => t.dev(id).on === true);
    w.publish('device.left', { type: 'device.left', device: { ...w.tablet, online: false } });
    await until('offline', () => t.dev(id).online === false);
    const events: { type: string; data: Record<string, unknown> }[] = [];
    t.hub.reg.on('event', e => events.push({ type: e.type, data: e.data }));
    w.publish('device.new', { type: 'device.new', device: { id: 'dev_new', macs: ['00:14:78:3a:41:0c'], ips: ['10.10.30.41'], vendor: 'TP-Link', class: 'plug', online: true, paused: false, network: { id: 'iot', name: 'IoT', vlan: 30 } } });
    w.publish('threat.blocked', { incidentId: 'i1', title: 'Blocked a login attack on SSH', body: '40 attempts from 203.0.113.9.', level: 'act', count: 40, device: {}, port: 22, mitigated: true });
    w.publish('wan.failover', { wan: 'wan2', wanName: '5G backup', from: 'wan1', fromName: 'NBN' });
    await until('three events', () => events.length === 3);
    assert.deepEqual(events.map(e => [e.type, e.data.title]), [
      ['new-device', 'TP-Link device joined IoT'],
      ['threat', 'Blocked a login attack on SSH'],
      ['internet-failover', 'Switched to 5G backup'],
    ]);
    assert.equal(events[0].data.body, 'A TP-Link plug. Open Warden to name it or block it.');

    // The stream drops: Kova reconnects and carries on from the last event it saw.
    w.drop();
    await until('reconnected', () => w.s.streams.length === 1, 8000);
    assert.equal(w.s.streams[0].lastId, `evt_${w.s.seq}`);
    w.publish('wan.down', {});
    await until('down again', () => t.dev(INTERNET_ID).on === false);

    // Who's home: Methel by Warden's own presence (same name), even with no phone MAC set in Kova.
    const people = t.hub.config.get().people;
    assert.ok(people.some(p => p.name === 'Methel'), people.map(p => p.name).join());
    const methel = people.find(p => p.name === 'Methel')!;
    await t.hub.engine.setPresence(methel.id, false, 'test');
    const presence = new Presence(t.hub, { pollSec: 0 }, { warden: () => manager.raw('warden') });
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people[methel.id]?.home, true);
    presence.stop();
  } finally {
    await app.close();
    await t.hub.stop();
    await w.close();
  }
});

test('Warden presence: a phone is found by any MAC its device record has used', { timeout: 15_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(20);
  try {
    const cfg = { url: w.url, token: w.TOKEN };
    const person = t.hub.config.get().people[0];
    // The phone was set up with the MAC it had then; it has rotated to a new private one since.
    w.phone.macs = ['f2:7c:3b:10:9e:44', 'da:a1:19:6e:02:5f'];
    w.s.people = [];
    await t.hub.engine.setPresence(person.id, false, 'test');
    const presence = new Presence(t.hub, { pollSec: 0, people: { [person.id]: { phones: ['DA-A1-19-6E-02-5F'] } } }, { warden: () => cfg });
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people[person.id]?.home, true);
    assert.match(presence.status().note ?? '', /Router: 1 phone seen/);
    presence.stop();
  } finally {
    await t.hub.stop();
    await w.close();
  }
});
