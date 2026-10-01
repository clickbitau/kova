import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_PUBKEY, mintKey } from './licence-helpers.ts';
import { parseLicenceKey } from '../src/services/licence-key.ts';
import { Catalog, NO_TOKEN, newer, nodeFits, tokenStale, verifyBundle, type Manifest } from '../src/services/release-client.ts';

const jwt = (exp: number) => ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');

/** clickbit-admin as far as Kova uses it: activate, check, download-token, download. */
function fakeCatalog(o: { bundle: Buffer; version: string; gitSha?: string; notes?: string; sha256?: string | null }) {
  const seen: { method: string; path: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let tokens = 0;
  const valid = new Set<string>();
  const state = { expireNext: false, forbid: false, revoked: new Set<string>() };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, 'http://x');
    seen.push({ method: req.method!, path: url.pathname + url.search, auth: req.headers.authorization, body });
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const authed = () => {
      const t = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (state.expireNext) { state.expireNext = false; valid.delete(t); }
      return valid.has(t);
    };
    if (url.pathname === '/api/v1/device/activate') {
      if (state.revoked.has(body.licenceKey)) return send(200, { status: 'revoked', features: [], edition: 'home', deviceToken: null });
      const site = JSON.parse(Buffer.from(String(body.licenceKey).slice(4).split('.')[0], 'base64url').toString()).site;
      if (site !== body.siteId) return send(200, { status: 'active', deviceToken: null, reason: 'site_mismatch' });
      const t = `tok${++tokens}.${Buffer.from(JSON.stringify({ exp: 9e9 })).toString('base64url')}.s`;
      valid.add(t);
      return send(200, { status: 'active', edition: 'home', features: ['updates'], deviceToken: t });
    }
    if (url.pathname === '/api/v1/updates/check') {
      if (state.forbid) return send(403, { error: 'Licence is not active for product kova' });
      if (!authed()) return send(401, { error: 'Expired deviceToken' });
      return send(200, { updateAvailable: true, version: o.version, gitSha: o.gitSha, releaseNotes: o.notes, artifactType: 'tar.gz' });
    }
    if (url.pathname === '/api/v1/updates/download-token') {
      if (!authed()) return send(401, { error: 'Expired deviceToken' });
      const sha = o.sha256 === undefined ? createHash('sha256').update(o.bundle).digest('hex') : o.sha256;
      return send(200, { token: 'dl', downloadPath: `/api/v1/updates/download?token=dl&version=${body.version}`, ...(sha ? { sha256: sha, size: o.bundle.length } : {}) });
    }
    if (url.pathname === '/api/v1/updates/download' && url.searchParams.get('token') === 'dl') { res.writeHead(200); res.end(o.bundle); return; }
    send(404, { error: 'no' });
  });
  return new Promise<{ url: string; seen: typeof seen; state: typeof state; close: () => void }>(ok => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    ok({ url: `http://127.0.0.1:${a.port}/api`, seen, state, close: () => server.close() });
  }));
}

test('Releases: newer() and token expiry read like Helix’s', () => {
  assert.equal(newer('0.7.0', '0.6.10'), true);
  assert.equal(newer('0.6.1', '0.6.1'), false);
  assert.equal(newer('1.2.3.1', '1.2.3'), true);
  assert.equal(newer('abc1234', '0.6.1'), null);
  assert.equal(tokenStale(jwt(1000), 999_000), true, 'within two minutes of exp');
  assert.equal(tokenStale(jwt(10_000), 1_000_000), false);
  assert.equal(tokenStale('not-a-jwt', 0), false);
});

test('Releases: no licence → the soft note; a licence activates, the catalog offers a newer Kova, it downloads and verifies', async () => {
  const bundle = Buffer.from('a release, as bytes');
  const cat = await fakeCatalog({ bundle, version: '0.7.0', gitSha: 'bbbbbbbbbb', notes: '- Releases from ClickBit\n- Faster cameras' });
  const dir = mkdtempSync(join(tmpdir(), 'kova-rel-'));
  const c = new Catalog({ url: cat.url, version: '0.6.1', gitSha: 'aaaaaaa', dir, pubkey: TEST_PUBKEY });
  try {
    assert.deepEqual(await c.check(), { offer: null, soft: NO_TOKEN });
    assert.equal(cat.seen.length, 0, 'nothing asked without a licence');

    // The hub's ID: made once, the same from then on (another Catalog on the same folder: the updater).
    const hubId = c.hubId();
    assert.match(hubId, /^KOVA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(new Catalog({ url: cat.url, version: '0.6.1', dir }).hubId(), hubId);

    // Keys that can't be used here are refused on the hub, before asking ClickBit.
    await assert.rejects(c.activate('KOVA-NOT-A-KEY'), /doesn’t look like a licence key/);
    await assert.rejects(c.activate(mintKey({ site: hubId }).replace(/.$/, 'A') + 'A'), /signature doesn’t check out/);
    await assert.rejects(c.activate(mintKey({ site: hubId, product: 'helix' })), /This licence is for helix, not Kova/);
    await assert.rejects(c.activate(mintKey({ site: 'KOVA-AAAA-BBBB-CCCC' })), new RegExp(`This licence is for hub KOVA-AAAA-BBBB-CCCC; this hub is ${hubId}`));
    await assert.rejects(c.activate(mintKey({ site: hubId, expiresAt: '2020-01-01T00:00:00Z' })), /expired on 2020-01-01/);
    assert.equal(cat.seen.length, 0);
    assert.equal(c.licenceView().installed, false, 'a refused new key changes nothing');

    // The right one: activated with the hub's ID as siteId.
    const key = mintKey({ site: hubId, expiresAt: '2030-01-01T00:00:00Z' });
    await c.activate(key);
    const act = cat.seen.at(-1)!;
    assert.equal(act.path, '/api/v1/device/activate');
    assert.deepEqual({ k: act.body!.licenceKey, site: act.body!.siteId, v: act.body!.productVersion, fp: typeof act.body!.deviceFingerprint }, { k: key, site: hubId, v: '0.6.1', fp: 'string' });
    assert.deepEqual(c.licenceView(), { hubId, installed: true, activated: true, status: 'active', edition: 'home', features: ['updates'], expiresAt: '2030-01-01T00:00:00Z', key: `…${key.slice(-4)}`, error: null });

    const r = await c.check();
    assert.deepEqual(r.offer, { version: '0.7.0', gitSha: 'bbbbbbbbbb', sha256: undefined, size: undefined, releaseNotes: '- Releases from ClickBit\n- Faster cameras', artifactType: 'tar.gz' });
    const chk = cat.seen.at(-1)!;
    assert.equal(chk.path, '/api/v1/updates/check?product=kova&channel=stable&currentVersion=0.6.1');
    assert.match(chk.auth!, /^Bearer tok1\./);

    // The token expired: renewed by activating again with the stored key, and the call goes through.
    cat.state.expireNext = true;
    assert.equal((await c.check()).offer?.version, '0.7.0');
    assert.deepEqual(cat.seen.slice(-3).map(s => s.path.split('?')[0]), ['/api/v1/updates/check', '/api/v1/device/activate', '/api/v1/updates/check']);
    assert.match(cat.seen.at(-1)!.auth!, /^Bearer tok2\./);

    // Download: the bytes the catalog listed, at the origin's downloadPath.
    const out = join(dir, 'kova-0.7.0.tar.gz');
    const got = await c.download('0.7.0', out);
    assert.equal(got.size, bundle.length);
    assert.deepEqual(readFileSync(out), bundle);
    assert.deepEqual(cat.seen.at(-2)!.body, { product: 'kova', channel: 'stable', version: '0.7.0' });

    // The same build as the one running, or one undone here before: not offered.
    assert.equal((await new Catalog({ url: cat.url, version: '0.7.0', dir }).check()).offer, null);
    assert.equal((await new Catalog({ url: cat.url, version: '0.6.9', gitSha: 'bbbbbbb', dir }).check()).offer, null);
    writeFileSync(join(dir, 'bad-versions'), '0.7.0\n');
    assert.deepEqual(await c.check(), { offer: null, soft: 'Kova 0.7.0 was undone on this box after it didn’t start; waiting for a newer one' });

    // 403: the licence isn't active for Kova.
    cat.state.forbid = true;
    await assert.rejects(c.check(), /The licence isn’t active for Kova updates \(403 Licence is not active for product kova\)/);
    cat.state.forbid = false;

    // Revoked: renewing the token fails, the hub says why, and stops asking until a key is entered again.
    cat.state.revoked.add(key); cat.state.expireNext = true;
    await assert.rejects(c.check(), /renewing it failed: ClickBit didn’t activate the licence: revoked/);
    assert.deepEqual({ a: c.licenceView().activated, e: c.licenceView().error }, { a: false, e: 'ClickBit didn’t activate the licence: revoked' });
    const asked = cat.seen.length;
    assert.deepEqual(await c.check(), { offer: null, soft: 'The licence key was refused (ClickBit didn’t activate the licence: revoked)' });
    assert.equal(cat.seen.length, asked);

    // A key ClickBit bound to another hub (site_mismatch).
    const other = new Catalog({ url: cat.url, version: '0.6.1', dir: mkdtempSync(join(tmpdir(), 'kova-rel-')), pubkey: TEST_PUBKEY });
    await assert.rejects(other.activate(mintKey({})), new RegExp(`issued for another hub \\(this one is ${other.hubId()}\\)`));
    assert.equal(other.licenceView().installed, false);
  } finally { cat.close(); }
});

test('Releases: a download that isn’t what the catalog says is thrown away; one listed without a sha256 isn’t downloaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-rel-'));
  for (const [sha, why] of [['0'.repeat(64), /didn’t verify/], [null, /without a sha256 and size/]] as const) {
    const cat = await fakeCatalog({ bundle: Buffer.from('tampered'), version: '0.7.0', sha256: sha });
    try {
      const c = new Catalog({ url: cat.url, version: '0.6.1', dir, pubkey: TEST_PUBKEY });
      await c.activate(mintKey({ site: c.hubId() }));
      await assert.rejects(c.download('0.7.0', join(dir, 'x.tar.gz')), why);
      assert.equal(existsSync(join(dir, 'x.tar.gz')), false);
      assert.equal(existsSync(join(dir, 'x.tar.gz.part')), false);
    } finally { cat.close(); }
  }
});

test('Licence keys: CR1- payload and Ed25519 signature, the ClickBit key compiled in', () => {
  const k = mintKey({ site: 'KOVA-AAAA-BBBB-CCCC', features: ['updates', 'remote'] });
  assert.deepEqual(parseLicenceKey(k, { hubId: 'KOVA-AAAA-BBBB-CCCC', pubkey: TEST_PUBKEY }).features, ['updates', 'remote']);
  // Under ClickBit's real key, a key signed by another one doesn't verify.
  assert.throws(() => parseLicenceKey(k, { hubId: 'KOVA-AAAA-BBBB-CCCC' }), /signature doesn’t check out/);
  assert.throws(() => parseLicenceKey(mintKey({ product: undefined }), { hubId: 'x', pubkey: TEST_PUBKEY }), /isn’t a Kova licence/);
});

test('Releases: a bundle is checked part by part against manifest.json; its node_modules used only on a matching Node', async () => {
  const d = mkdtempSync(join(tmpdir(), 'kova-bundle-'));
  const parts: Manifest['parts'] = {};
  for (const p of ['root', 'hub', 'web', 'ota', 'deploy']) {
    mkdirSync(join(d, 'src', p), { recursive: true });
    writeFileSync(join(d, 'src', p, 'f'), p);
    execFileSync('tar', ['-czf', join(d, `${p}.tar.gz`), '-C', join(d, 'src'), p]);
    const b = readFileSync(join(d, `${p}.tar.gz`));
    parts[p] = { file: `${p}.tar.gz`, sha256: createHash('sha256').update(b).digest('hex'), size: b.length };
  }
  const m: Manifest = { product: 'kova', version: '0.7.0', gitSha: 'b', node: { min: '22.13', abi: '127', platform: 'linux', arch: 'x64' }, parts };
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(m));
  assert.equal((await verifyBundle(d)).version, '0.7.0');
  writeFileSync(join(d, 'web.tar.gz'), 'changed');
  await assert.rejects(verifyBundle(d), /Part web \(web.tar.gz\) doesn’t match the manifest/);

  const node = { version: '22.20.0', abi: '127', platform: 'linux', arch: 'x64' };
  assert.deepEqual(nodeFits(m, node), { runs: true, modules: false }, 'no node_modules part: npm ci');
  const withModules = { ...m, parts: { ...parts, node_modules: parts.root } };
  assert.deepEqual(nodeFits(withModules, node), { runs: true, modules: true });
  assert.deepEqual(nodeFits(withModules, { ...node, abi: '131' }), { runs: true, modules: false });
  assert.deepEqual(nodeFits(withModules, { ...node, version: '22.12.0' }), { runs: false, modules: true });
});
