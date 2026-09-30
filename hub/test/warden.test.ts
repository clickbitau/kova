import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { INTERNET_ID, WardenAdapter, internetId } from '../src/adapters/warden.ts';
import { Presence } from '../src/services/presence.ts';
import { Notifier } from '../src/services/notify.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

function selfSigned(cn: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'warden-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

/** A fake Warden OS: the parts of /api/v1 Kova uses, over HTTPS with a self-signed certificate like the real box. */
async function fakeWarden() {
  const s = {
    wanUp: true,
    paused: new Set<string>(),
    incidents: [] as Record<string, unknown>[],
    clients: [] as { mac: string; name?: string; hostname?: string; ip?: string; lastSeenAt?: string; online: boolean }[],
    tokens: [] as { name: string; role: string }[],
    seen: [] as string[],
  };
  const TOKEN = 'cr_' + 'a'.repeat(64);
  const server = https.createServer(selfSigned('warden.test'), (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const u = new URL(req.url!, 'https://x');
      const auth = req.headers.authorization ?? '';
      const send = (code: number, j?: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); };
      s.seen.push(`${req.method} ${u.pathname}`);
      if (u.pathname === '/.well-known/wardenos-gateway') return send(200, { product: 'WardenOS', siteName: 'Methel Home', apiBase: '/api/v1' });
      if (u.pathname === '/api/v1/login') {
        if (body?.username === 'admin' && body?.password === 'right') return send(200, { session: { token: 'sess1', role: 'admin' } });
        return send(401, { message: 'invalid username or password' });
      }
      if (u.pathname === '/api/v1/logout') return send(204);
      if (u.pathname === '/api/v1/tokens' && req.method === 'POST') {
        if (auth !== 'Bearer sess1') return send(401, { message: 'unauthorized' });
        s.tokens.push(body);
        return send(201, { id: 't1', token: TOKEN, name: body.name, role: body.role });
      }
      if (auth !== `Bearer ${TOKEN}`) return send(401, { message: 'unauthorized' });
      if (u.pathname === '/api/v1/dashboard') return send(200, { wanUp: s.wanUp, clientCount: s.clients.length, last24h: { threatsBlocked: 3 } });
      if (u.pathname === '/api/v1/events') {
        const since = Date.parse(u.searchParams.get('since') ?? '1970-01-01T00:00:00Z');
        return send(200, { incidents: s.incidents.filter(i => Date.parse(i.updatedAt as string) > since), open: 0 });
      }
      if (u.pathname === '/api/v1/site') return send(200, { people: [{ id: 'paused-devices', devices: [...s.paused] }] });
      if (u.pathname === '/api/v1/clients') return send(200, { clients: s.clients, usageWindowSeconds: 86400 });
      const m = /^\/api\/v1\/clients\/([^/]+)\/pause$/.exec(u.pathname);
      if (m) {
        const mac = decodeURIComponent(m[1]);
        if (req.method === 'POST') s.paused.add(mac); else s.paused.delete(mac);
        return send(200, { mac, paused: req.method === 'POST', pausedMacs: [...s.paused] });
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, s, TOKEN, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function fakeNtfy() {
  const got: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(200); res.end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('Warden: link once, internet status and alerts, pause a device’s internet, phones for who’s home', async () => {
  const w = await fakeWarden();
  const ntfy = await fakeNtfy();
  const t = await testHub(12);
  const dir = mkdtempSync(join(tmpdir(), 'kova-warden-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const app = await buildServer(t.hub, { webRoot, integrations: manager });
  const notifier = new Notifier(t.hub, { ntfy: { url: ntfy.url, topic: 'kova' }, checkSec: 0 }, { dataDir: dir });
  notifier.start();
  try {
    // Linking: a wrong password says so; the right one makes a Kova token (operator) and keeps no password.
    const bad = await app.inject({ method: 'POST', url: '/api/integrations/warden/link', payload: { url: w.url, username: 'admin', password: 'wrong' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /didn’t accept that sign-in/);
    const ok = await app.inject({ method: 'POST', url: '/api/integrations/warden/link', payload: { url: w.url, username: 'admin', password: 'right' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(ok.json().linked, /Methel Home/);
    assert.ok(!ok.body.includes(w.TOKEN), 'the token never goes back to the browser');
    assert.deepEqual(w.s.tokens, [{ name: 'Kova', role: 'operator' }]);
    assert.ok(w.s.seen.includes('POST /api/v1/logout'), 'the sign-in session is closed again');
    const saved = manager.raw('warden')!;
    assert.equal(saved.token, w.TOKEN);
    assert.match(saved.fingerprint ?? '', /^[0-9A-F:]{95}$/, 'the certificate is pinned');
    assert.ok(!JSON.stringify(manager.config).includes('right'), 'no password stored');
    assert.equal(t.hub.reg.get(INTERNET_ID)?.state.on, true);

    // Internet switches: the owner picks a device; off pauses it in Warden.
    // (Saved from the app's form: the token comes back as "••••" and the pinned certificate isn't on the form; both are kept.)
    await manager.update('warden', { url: saved.url, token: '••••', devices: [{ mac: 'AA-BB-CC-DD-EE-01', name: 'Aisha’s iPad', room: 'lounge' }] });
    assert.deepEqual([manager.raw('warden')!.token, manager.raw('warden')!.fingerprint], [w.TOKEN, saved.fingerprint]);
    const ipad = internetId('aa:bb:cc:dd:ee:01');
    assert.equal(t.hub.reg.get(ipad)?.type, 'internet');
    await t.hub.engine.command(ipad, { on: false });
    assert.ok(w.s.paused.has('aa:bb:cc:dd:ee:01'));
    assert.equal(t.dev(ipad).on, false);
    // Unpaused in Warden: Kova follows on the next read.
    w.s.paused.clear();
    const adapter = t.hub.reg.adapters.get('warden') as WardenAdapter;
    await adapter.poll();
    assert.equal(t.dev(ipad).on, true, JSON.stringify(adapter.status()));

    // The internet drops, a new device joins, Warden blocks an attack: events, Activity and notifications.
    w.s.wanUp = false;
    const now = new Date(Date.now() + 1000).toISOString();
    w.s.incidents.push({ id: 'i1', kind: 'device.new', level: 'know', title: 'A new device joined: Galaxy-S24', body: 'It’s on Main.', openedAt: now, updatedAt: now, count: 1 });
    w.s.incidents.push({ id: 'i2', kind: 'attack', level: 'act', title: 'Warden blocked an attack on the NAS', body: 'Someone tried 40 passwords.', openedAt: now, updatedAt: now, count: 1 });
    w.s.incidents.push({ id: 'i3', kind: 'update', level: 'record', title: 'Updated', openedAt: now, updatedAt: now, count: 1 });
    await adapter.poll();
    await adapter.poll(); // the same incidents again are not news
    await notifier.idle();
    assert.equal(t.dev(INTERNET_ID).on, false);
    const titles = ntfy.got.map(n => n.title);
    assert.deepEqual(titles, ['The internet is down', 'A new device joined: Galaxy-S24', 'Warden blocked an attack on the NAS']);
    assert.ok(t.hub.store.feed(40).some(e => e.what === 'Internet is down'));
    w.s.wanUp = true;
    await adapter.poll();
    await notifier.idle();
    assert.equal(ntfy.got.at(-1)!.title, 'The internet is back');

    // Devices on the network, for picking phones and internet switches.
    w.s.clients = [
      { mac: 'aa:bb:cc:dd:ee:02', name: 'Methel’s iPhone', ip: '10.10.0.52', lastSeenAt: new Date().toISOString(), online: true },
      { mac: 'aa:bb:cc:dd:ee:09', hostname: 'old-laptop', lastSeenAt: new Date(Date.now() - 3600_000).toISOString(), online: true },
    ];
    const list = (await app.inject({ method: 'GET', url: '/api/integrations/warden/clients' })).json();
    assert.deepEqual(list.devices.map((d: { name: string }) => d.name), ['Methel’s iPhone · aa:bb:cc:dd:ee:02 · 10.10.0.52', 'old-laptop · aa:bb:cc:dd:ee:09 · not seen lately']);

    // Who's home: a phone Warden saw lately is home; one it hasn't seen for a while is away.
    const presence = new Presence(t.hub, { people: { methel: { phones: ['AA:BB:CC:DD:EE:02'] } }, pollSec: 0, awayAfterMin: 0 }, { warden: () => manager.raw('warden') });
    await t.hub.engine.setPresence('methel', false, 'test');
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, true);
    w.s.clients[0].lastSeenAt = new Date(Date.now() - 3600_000).toISOString();
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, false);
    assert.match(presence.status().note ?? '', /Router: 0 phones seen/);
    presence.stop();

    // A certificate that changed since linking is refused.
    await manager.update('warden', { ...manager.raw('warden'), fingerprint: 'AB:'.repeat(31) + 'AB' });
    const a2 = t.hub.reg.adapters.get('warden') as WardenAdapter;
    await a2.poll();
    assert.match(a2.status().note ?? '', /different certificate/);
  } finally {
    await notifier.stop();
    await app.close();
    await t.hub.stop();
    await w.close();
    await ntfy.close();
  }
});
