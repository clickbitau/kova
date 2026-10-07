import https from 'node:https';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WardenBmc, WardenDevice } from '../src/adapters/warden.ts';

// A fake Warden OS for the hub's tests (warden-feed, warden-power): device records, people, pairing by code, the live
// feed and the server's BMC, over HTTPS with a self-signed certificate like the real box.

function selfSigned(cn: string): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'warden-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

/** Warden with device records, people, pairing by code, the live feed and the BMC, over HTTPS like the real box. */
export async function fakeWarden() {
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
    /** Warden's version in its discovery document. */
    version: '1.041',
    /** GET /host/bmc: a status code to answer with instead (403 before 1.041 or without network:read, 404 on an older Warden), else this. */
    bmcStatus: 200,
    bmc: { available: false, error: 'no BMC found' } as WardenBmc,
    /** How long a BMC read takes (the real one takes about 4 s). */
    bmcMs: 0,
    bmcReads: 0,
    /** The most BMC reads in flight at once. */
    bmcMaxOpen: 0,
    bmcOpen: 0,
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
      if (u.pathname === '/.well-known/wardenos-gateway') return send(200, { product: 'WardenOS', siteName: 'Methel Home', version: s.version });
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
      if (u.pathname === '/api/v1/host/bmc') {
        s.bmcReads++;
        s.bmcMaxOpen = Math.max(s.bmcMaxOpen, ++s.bmcOpen);
        const answer = JSON.parse(JSON.stringify(s.bmc)), code = s.bmcStatus;
        setTimeout(() => { s.bmcOpen--; code === 200 ? send(200, answer) : send(code, { message: code === 403 ? 'forbidden' : 'not found' }); }, s.bmcMs);
        return;
      }
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

