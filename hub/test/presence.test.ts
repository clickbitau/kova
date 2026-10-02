import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { Presence, PHONE, ROUTER, PING, probe } from '../src/services/presence.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const MIN = 60_000;

function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'opncert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=OPNsense.localdomain'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } catch { return null; }
}
const CERT = selfSigned();

/** A fake OPNsense API: GET /api/diagnostics/interface/getArp with basic auth, over self-signed HTTPS when openssl is around. */
async function fakeOpnsense() {
  const arp: { mac: string; ip: string; intf: string; expired: boolean; permanent: boolean; type: string; manufacturer: string; hostname: string }[] = [];
  let calls = 0;
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Basic ' + Buffer.from('k3y:s3cret').toString('base64')) { res.writeHead(401); res.end('{"status":401}'); return; }
    if (req.url === '/api/diagnostics/interface/getArp') { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(arp)); return; }
    res.writeHead(404); res.end('{}');
  };
  const server = CERT ? https.createServer(CERT, handler) : http.createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `${CERT ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const phone = (mac: string, ip: string) => ({ mac, ip, intf: 'igb1', expired: false, permanent: false, type: 'ethernet', manufacturer: 'Apple, Inc.', hostname: '' });
  return { url, arp, phone, calls: () => calls, close: () => new Promise<void>(r => server.close(() => r())) };
}

const METHEL_MAC = 'AA:BB:CC:00:11:22';

async function setup(awayAfterMin = 10, away: string[] = []) {
  const opn = await fakeOpnsense();
  const t = await testHub(12);
  for (const id of away) await t.hub.engine.setPresence(id, false, 'test');
  const presence = new Presence(t.hub, {
    people: { methel: { phones: [METHEL_MAC] }, brishti: { phones: ['aa:bb:cc:00:33:44'] } },
    opnsense: { url: opn.url, key: 'k3y', secret: 's3cret', insecureTls: true },
    awayAfterMin, pollSec: 0,
  });
  presence.start();
  const lastPresence = () => t.hub.store.feed(50).find(e => e.kind === 'presence');
  const done = async () => { presence.stop(); await t.hub.stop(); await opn.close(); };
  return { ...t, opn, presence, lastPresence, done };
}

test('Presence (router): phone appears → home at once; gone → away only after the debounce', async () => {
  const { hub, clock, opn, presence, lastPresence, done } = await setup(10, ['methel']);
  try {
    // Nothing on the network yet.
    await presence.poll();
    assert.ok(opn.calls() >= 1, 'polled the OPNsense API');
    assert.equal(hub.engine.people.methel.home, false);

    // Methel's phone joins Wi-Fi (the router shows MACs lower case; config was upper case).
    opn.arp.push(opn.phone(METHEL_MAC.toLowerCase(), '10.10.30.5'));
    await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'home immediately');
    assert.equal(lastPresence()?.cause.label, ROUTER);
    assert.match(presence.status().note ?? '', /Router: 1 phone seen/);

    // The phone sleeps and drops off Wi-Fi: not away yet.
    opn.arp.length = 0;
    clock.t += 1 * MIN; await presence.poll();
    clock.t += 8 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'still home 9 min after it disappeared');
    // It comes back briefly: the clock restarts.
    opn.arp.push(opn.phone(METHEL_MAC, '10.10.30.5'));
    clock.t += 30_000; await presence.poll();
    opn.arp.length = 0;
    clock.t += 9 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'the reappearance reset the debounce');
    clock.t += 1 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false, 'away after 10 min gone');
    assert.equal(lastPresence()?.what, 'Methel left home');

    // An expired ARP entry doesn't count.
    opn.arp.push({ ...opn.phone(METHEL_MAC, '10.10.30.5'), expired: true });
    clock.t += MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false);
  } finally { await done(); }
});

test('Presence: a phone automation "left" beats the router for 15 minutes; "arrived" wins at once', async () => {
  const { hub, clock, opn, presence, lastPresence, done } = await setup(10);
  try {
    opn.arp.push(opn.phone(METHEL_MAC, '10.10.30.5'));
    await presence.poll();
    assert.equal(hub.engine.people.methel.home, true);

    // Driving off: the Shortcut says "left" while the phone is still on Wi-Fi.
    await presence.report('methel', false);
    assert.equal(hub.engine.people.methel.home, false);
    assert.equal(lastPresence()?.cause.label, PHONE);
    for (let i = 0; i < 5; i++) { clock.t += MIN; await presence.poll(); }
    assert.equal(hub.engine.people.methel.home, false, 'router still sees the phone, but "left" wins');

    // Wi-Fi drops as the car leaves, flaps back within the window: still away.
    opn.arp.length = 0; clock.t += MIN; await presence.poll();
    opn.arp.push(opn.phone(METHEL_MAC, '10.10.30.5')); clock.t += MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false, 'within 15 min of "left"');

    // After the window, a real return is seen by the router.
    opn.arp.length = 0; clock.t += 20 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false);
    opn.arp.push(opn.phone(METHEL_MAC, '10.10.30.5')); clock.t += MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'back home after the window');
    assert.equal(lastPresence()?.cause.label, ROUTER);

    // A stale ARP entry right after "left" doesn't flip someone back home at 15 min…
    await presence.report('methel', false);
    clock.t += 16 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false, 'a continuous ARP sighting since "left" may be stale');
    // …but still listed well past any stale entry, the phone is really here: the "left" was wrong.
    clock.t += 30 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'still listed 45 min after "left"');

    // "Arrived" from the phone wins immediately, even while the router hasn't seen anything.
    await presence.report('brishti', false);
    clock.t += 20 * MIN; await presence.poll();
    assert.equal(hub.engine.people.brishti.home, false);
    await presence.report('brishti', true);
    assert.equal(hub.engine.people.brishti.home, true);
    clock.t += MIN; await presence.poll();
    assert.equal(hub.engine.people.brishti.home, true, 'the phone gets the usual 10 min to join Wi-Fi after an arrival');
    clock.t += 10 * MIN; await presence.poll();
    assert.equal(hub.engine.people.brishti.home, false, 'then the router decides again');
  } finally { await done(); }
});

test('Presence (ping): TCP probe to the phone; accepted or refused = present, timeout = absent', async t => {
  // A fake iPhone lockdownd port that accepts connections.
  const phone = net.createServer(s => s.destroy());
  await new Promise<void>(r => phone.listen(0, '127.0.0.1', r));
  const port = (phone.address() as AddressInfo).port;
  // A closed port refuses: something is there.
  const closed = net.createServer();
  await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>(r => closed.close(() => r()));
  assert.equal(await probe('127.0.0.1', port, 500), true);
  assert.equal(await probe('127.0.0.1', closedPort, 500), true, 'connection refused counts as present');
  // Something that doesn't answer at all (sandboxes sometimes refuse instead, so find one that times out).
  let blackhole: string | null = null;
  for (const ip of ['10.255.255.1', '192.0.2.1', '198.51.100.7', '203.0.113.9']) if (!(await probe(ip, port, 150))) { blackhole = ip; break; }
  if (!blackhole) { t.diagnostic('no unreachable address in this environment; skipping the absent half'); await new Promise<void>(r => phone.close(() => r())); return; }

  const { hub, clock } = await testHub(12);
  await hub.engine.setPresence('methel', false, 'test');
  const hosts: Record<string, string> = { methel: '127.0.0.1' };
  const presence = new Presence(hub, { pingHosts: hosts, probePort: port, probeTimeoutMs: 150, awayAfterMin: 10, pollSec: 0 });
  presence.start();
  try {
    await presence.poll();
    assert.equal(hub.engine.people.methel.home, true);
    assert.equal(hub.store.feed(10).find(e => e.kind === 'presence')?.cause.label, PING);
    hosts.methel = blackhole;
    clock.t += 5 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, true, 'debounced');
    clock.t += 6 * MIN; await presence.poll();
    assert.equal(hub.engine.people.methel.home, false);
    assert.match(presence.status().note ?? '', /Ping: 0 of 1 reachable/);
  } finally {
    presence.stop(); await hub.stop();
    await new Promise<void>(r => phone.close(() => r()));
  }
});

test('Presence API: per-person key works without the master token; missing or wrong key is rejected', async () => {
  const { hub } = await testHub(12);
  const presence = new Presence(hub, { pollSec: 0 });
  presence.start();
  const app = await buildServer(hub, { webRoot, token: 'master', presence });
  try {
    // Setup needs the master token.
    assert.equal((await app.inject({ url: '/api/presence/setup' })).statusCode, 401);
    const setup = (await app.inject({ url: '/api/presence/setup', headers: { authorization: 'Bearer master', host: 'kova.lan:8140' } })).json();
    const m = setup.people.find((p: { id: string }) => p.id === 'methel');
    const b = setup.people.find((p: { id: string }) => p.id === 'brishti');
    assert.ok(m.key && b.key && m.key !== b.key);
    assert.match(m.leaveUrl, /^http:\/\/kova\.lan:8140\/api\/people\/methel\/presence\?key=.+&home=0$/);

    // No token, no key.
    assert.equal((await app.inject({ method: 'POST', url: '/api/people/methel/presence', payload: { home: false } })).statusCode, 401);
    // Someone else's key.
    assert.equal((await app.inject({ method: 'POST', url: `/api/people/methel/presence?key=${encodeURIComponent(b.key)}&home=0` })).statusCode, 401);
    // A key doesn't open anything else.
    assert.equal((await app.inject({ url: `/api/state?key=${encodeURIComponent(m.key)}` })).statusCode, 401);
    assert.equal(hub.engine.people.methel.home, true);

    // The Shortcut's leave URL, as-is (POST, no body).
    const left = await app.inject({ method: 'POST', url: new URL(m.leaveUrl).pathname + new URL(m.leaveUrl).search });
    assert.equal(left.statusCode, 200);
    assert.equal(hub.engine.people.methel.home, false);
    assert.equal(hub.store.feed(5).find(e => e.kind === 'presence')?.cause.label, PHONE);
    // Arrive with a JSON body instead.
    const arrived = await app.inject({ method: 'POST', url: `/api/people/methel/presence?key=${encodeURIComponent(m.key)}`, payload: { home: true } });
    assert.equal(arrived.statusCode, 200);
    assert.equal(hub.engine.people.methel.home, true);
    // The master token still works for any person.
    assert.equal((await app.inject({ method: 'POST', url: '/api/people/brishti/presence', headers: { authorization: 'Bearer master' }, payload: { home: false } })).statusCode, 200);
    assert.equal(hub.engine.people.brishti.home, false);
    // Keys survive a restart (kept in the store).
    assert.equal(new Presence(hub, {}).keyFor('methel'), m.key);
  } finally {
    await app.close(); presence.stop(); await hub.stop();
  }
});

test('Presence: what already covers each person, so the app only asks for location when nothing else can', async () => {
  const t = await testHub(12);
  try {
    // Nothing set up: only the phone could tell.
    assert.deepEqual(new Presence(t.hub, {}, {}).coveredBy('methel'), []);
    // A router that sees one person's phone, and a network check for another.
    const opn = new Presence(t.hub, { opnsense: { url: 'https://router', key: 'k', secret: 's' }, people: { methel: { phones: ['aa:bb:cc:dd:ee:01'] } }, pingHosts: { brishti: '192.0.2.9' } }, {});
    assert.deepEqual(opn.coveredBy('methel'), ['your router']);
    assert.deepEqual(opn.coveredBy('brishti'), ['a network check']);
    // Warden linked: it knows whose devices are whose, for everyone.
    const w = new Presence(t.hub, {}, { warden: () => ({ url: 'https://warden', token: 't' }) as never });
    assert.deepEqual(w.coveredBy('brishti'), ['Warden']);
    assert.deepEqual(new Presence(t.hub, {}, { warden: () => undefined }).coveredBy('brishti'), [], 'Warden not linked yet');
  } finally { await t.hub.stop(); }
});
