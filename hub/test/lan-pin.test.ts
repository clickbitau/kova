import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { lanJson, resetLearnedKeys, spkiSha256 } from '../src/util/lan-http.ts';

/** A self-signed certificate for `key` (made if not given). */
function cert(dir: string, name: string, key?: string): { key: string; cert: string } {
  const k = key ?? join(dir, `${name}.key`);
  if (!key) execFileSync('openssl', ['genrsa', '-out', k, '2048'], { stdio: 'ignore' });
  const c = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-new', '-x509', '-key', k, '-out', c, '-days', '30', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  return { key: k, cert: c };
}

test('LAN pinning: a reissued certificate with the same key is still trusted; a different key is not', async t => {
  let dir: string;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); dir = mkdtempSync(join(tmpdir(), 'kova-pin-')); } catch { t.skip('no openssl'); return; }
  const data = mkdtempSync(join(tmpdir(), 'kova-data-'));
  const was = process.env.KOVA_DATA;
  process.env.KOVA_DATA = data;
  resetLearnedKeys();
  const first = cert(dir, 'appliance');
  const reissued = cert(dir, 'appliance-2', first.key);
  const other = cert(dir, 'impostor');
  const server = https.createServer({ key: readFileSync(first.key), cert: readFileSync(first.cert) }, (_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"ok":true}'); });
  const use = (c: { key: string; cert: string }) => server.setSecureContext({ key: readFileSync(c.key), cert: readFileSync(c.cert) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const fp = (p: string) => new X509Certificate(readFileSync(p)).fingerprint256;
  try {
    const pinned = fp(first.cert);
    // Linked: the certificate matches, and its key is learned (owner-only file).
    assert.deepEqual((await lanJson(url, { fingerprint: pinned })).json, { ok: true });
    assert.equal(statSync(join(data, 'tls-keys.json')).mode & 0o777, 0o600);
    // Reissued with the same key: still trusted, though the certificate changed.
    use(reissued);
    const r = await lanJson(url, { fingerprint: pinned });
    assert.notEqual(r.fingerprint, pinned);
    // A different key: refused.
    use(other);
    await assert.rejects(lanJson(url, { fingerprint: pinned }), /different certificate and key/);
    // Pinning the key itself (no learning needed).
    resetLearnedKeys();
    use(reissued);
    const key = spkiSha256({ raw: new X509Certificate(readFileSync(first.cert)).raw });
    assert.deepEqual((await lanJson(url, { fingerprint: 'AA:BB', publicKeySha256: key })).json, { ok: true });
  } finally {
    server.close();
    if (was === undefined) delete process.env.KOVA_DATA; else process.env.KOVA_DATA = was;
    resetLearnedKeys();
  }
});
