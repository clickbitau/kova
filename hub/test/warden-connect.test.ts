import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { UNREACHABLE, WARDEN_SCOPES, parseWardenConnect } from '../src/adapters/warden.ts';
import { asksForKova, kovaRecords, wardensIn } from '../src/services/mdns-announce.ts';
import { fakeWarden } from './fake-warden.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const codeOf = (j: object) => `wardenconnect:1:${Buffer.from(JSON.stringify(j)).toString('base64url')}`;

test('Warden connection code: read in plain words, or refused in plain words', () => {
  assert.throws(() => parseWardenConnect('hello'), /isn’t a Warden connection code/);
  assert.throws(() => parseWardenConnect(codeOf({ v: 1, u: [] })), /incomplete/);
  const key = 'ab'.repeat(32);
  const c = parseWardenConnect(`  ${codeOf({ v: 1, u: ['https://warden.tail1.ts.net/', 'https://10.0.0.1'], id: 'gw', n: 'Home', pk: key, i: 'inv', s: 'sec', sc: ['events'] })} `);
  assert.deepEqual(c, { urls: ['https://warden.tail1.ts.net', 'https://10.0.0.1'], id: 'gw', name: 'Home', key: 'AB:'.repeat(31) + 'AB', invite: 'inv.sec', scopes: ['events'] });
  // The same key in base64 is the same pin.
  assert.equal(parseWardenConnect(codeOf({ v: 1, u: ['https://x'], id: 'gw', pk: Buffer.from(key, 'hex').toString('base64url'), i: 'a', s: 'b' })).key, c.key);
  assert.throws(() => parseWardenConnect(codeOf({ v: 1, u: ['https://x'], id: 'gw', pk: 'short', i: 'a', s: 'b' })), /key isn’t one Kova can check/);
});

test('Warden connection code: the first address that is this Warden takes it, Kova keeps the token, the key and what was granted', { timeout: 30_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-warden-connect-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, lanApps: { wardenPollMs: 50, wardenConnectTimeoutMs: 1500 } });
  const connect = (code: string) => app.inject({ method: 'POST', url: '/api/integrations/warden/connect', payload: { code } });
  try {
    // The admin ticked everything but the network's health.
    const sc = WARDEN_SCOPES.filter(x => x !== 'network:read');
    w.s.invites.set('inv1.sec1', { sc, used: false });
    // Its tailnet name first (not answering here), then its home address.
    const good = { v: 1, u: ['https://127.0.0.1:1', w.url], id: 'gw_test', n: 'Alex Home', pk: w.key, i: 'inv1', s: 'sec1', sc };

    // A code whose key isn't this Warden's, or for another router: Kova says it can't reach it, and the invite is untouched.
    let r = await connect(codeOf({ ...good, pk: 'cd'.repeat(32) }));
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, UNREACHABLE);
    r = await connect(codeOf({ ...good, id: 'gw_other' }));
    assert.equal(r.json().error, UNREACHABLE);
    assert.equal(w.s.invites.get('inv1.sec1')!.used, false);
    assert.ok(!w.s.seen.some(x => x.startsWith('POST /api/v1/apps/pair')), 'no invite sent to a router Kova couldn’t check');

    r = await connect(codeOf(good));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().linked, `Warden (Alex Home) at ${w.url}`);
    const saved = manager.raw('warden')!;
    assert.equal(saved.url, w.url);
    assert.equal(saved.token, w.TOKEN);
    assert.equal(saved.publicKeySha256, w.key.toUpperCase().match(/../g)!.join(':'));
    assert.deepEqual(saved.scopes, sc, 'what was granted is kept: the status can say what needs connecting again');
    assert.ok(w.s.seen.some(x => x.startsWith('POST /api/v1/apps/pair') && x.includes('"invite":"inv1.sec1"')));
    assert.ok(t.hub.reg.adapters.has('warden'), 'Kova is connected');
    // It talks to Warden with only the key pinned (no certificate fingerprint): Warden's dashboard comes in.
    assert.match(r.json().status, /Internet up/);

    // Used: Warden's own words, and no other address tried after Warden has had it.
    const posts = w.s.seen.filter(x => x.startsWith('POST /api/v1/apps/pair')).length;
    r = await connect(codeOf(good));
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /already used/);
    assert.equal(w.s.seen.filter(x => x.startsWith('POST /api/v1/apps/pair')).length, posts + 1);

    // Warden's link lands on Integrations → Warden; the code stays in the fragment, which never reaches the hub.
    const land = await app.inject({ url: '/integrations/warden' });
    assert.equal(land.statusCode, 302);
    assert.equal(land.headers.location, '/?setup=warden');
  } finally { await app.close(); await t.hub.stop(); await w.close(); }
});

test('Kova on the network: _kova._tcp with its id, name, version, where Warden’s link lands; and a Warden heard', () => {
  const r = kovaRecords({ id: () => 'KOVA-AB12-CD34-EF56', name: () => 'Alex Home', version: '0.7.113', port: () => 8140, addresses: () => ['10.0.0.5'] });
  assert.equal(r.instance, 'Alex Home._kova._tcp.local');
  assert.deepEqual(r.txt, { id: 'KOVA-AB12-CD34-EF56', name: 'Alex Home', v: '0.7.113', path: '/integrations/warden', proto: 'http' });
  const srv = r.answers.find(a => a.type === 'SRV')!;
  assert.deepEqual(srv.data, { port: 8140, target: 'kova-ab12-cd34-ef56.local', priority: 0, weight: 0 });
  assert.deepEqual(r.answers.find(a => a.type === 'A')!.data, '10.0.0.5');
  assert.ok(asksForKova({ name: '_kova._tcp.local', type: 'PTR' }, r));
  assert.ok(asksForKova({ name: 'kova-ab12-cd34-ef56.local', type: 'A' }, r));
  assert.ok(!asksForKova({ name: '_googlecast._tcp.local', type: 'PTR' }, r));

  const heard = wardensIn([
    { name: '_warden._tcp.local', type: 'PTR', data: 'Alex Home._warden._tcp.local' },
    { name: 'Alex Home._warden._tcp.local', type: 'SRV', data: { port: 443, target: 'warden.local' } },
    { name: 'Alex Home._warden._tcp.local', type: 'TXT', data: [Buffer.from('name=Alex Home')] },
    { name: 'warden.local', type: 'A', data: '10.0.0.1' },
  ]);
  assert.deepEqual(heard, [{ name: 'Alex Home', url: 'https://10.0.0.1' }]);
});
