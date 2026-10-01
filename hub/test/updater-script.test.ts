import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Catalog } from '../src/services/release-client.ts';
import { TEST_PUBKEY, mintKey } from './licence-helpers.ts';

const deploy = resolve(import.meta.dirname, '../../deploy');
const repo = resolve(import.meta.dirname, '../..');
const isRoot = process.getuid?.() === 0;
// Kova's /api/health, from whichever Kova $KOVA_DIR/current is; down when that's the version in $BROKEN.
const CURL = `v=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$KOVA_DIR/current/hub/package.json" 2>/dev/null || node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$KOVA_DIR/hub/package.json"); [[ "$v" == "\${BROKEN:-none}" ]] && exit 7; echo "{\\"ok\\":true,\\"version\\":\\"$v\\"}"`;

/**
 * deploy/updater.sh and deploy/update.sh against real git repositories: a "GitHub" (bare) and the box's checkout.
 * systemctl, npm, journalctl and curl are stand-ins on PATH; curl answers like Kova's /api/health unless the
 * checkout's version is one the test marks broken.
 */
test('Updater: finds a newer Kova, updates to it, and goes back by itself when the new one doesn’t come up', { skip: !isRoot && 'update.sh runs as root', timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'kova-updater-'));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const origin = join(root, 'origin.git'), work = join(root, 'dev'), kova = join(root, 'kova'), data = join(root, 'data'), bin = join(root, 'bin');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  const release = (version: string, msg: string) => {
    mkdirSync(join(work, 'hub'), { recursive: true });
    mkdirSync(join(work, 'deploy', 'systemd'), { recursive: true });
    writeFileSync(join(work, 'hub', 'package.json'), JSON.stringify({ name: 'kova-hub', version }));
    for (const f of ['update.sh', 'updater.sh', 'install-updater.sh']) copyFileSync(join(deploy, f), join(work, 'deploy', f));
    for (const f of readdirSync(join(deploy, 'systemd'))) copyFileSync(join(deploy, 'systemd', f), join(work, 'deploy', 'systemd', f));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', 'origin', 'main');
  };
  release('1.0.0', 'First');
  git(root, 'clone', '-q', '-b', 'main', origin, kova);

  // Stand-ins. curl is "healthy" unless the checkout is the version in $BROKEN.
  mkdirSync(bin);
  const shim = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim('systemctl', 'echo "systemctl $*" >> "$SHIM_LOG"');
  shim('journalctl', 'true');
  shim('npm', 'echo "npm $*" >> "$SHIM_LOG"');
  shim('curl', CURL);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KOVA_DIR: kova, KOVA_DATA: data, KOVA_ENV_FILE: join(root, 'kova.env'), KOVA_HEALTH_WAIT: '2', KOVA_SYSTEMD_DIR: join(root, 'units'), SHIM_LOG: join(root, 'shim.log') };
  mkdirSync(join(root, 'units'));
  const run = (cmd: string, extra: Record<string, string> = {}) => spawnSync('bash', [join(kova, 'deploy', 'updater.sh'), cmd], { env: { ...env, ...extra }, encoding: 'utf8' });
  const status = () => JSON.parse(readFileSync(join(data, 'update', 'status.json'), 'utf8'));
  const version = () => JSON.parse(readFileSync(join(kova, 'hub', 'package.json'), 'utf8')).version;

  // Up to date.
  assert.equal(run('check').status, 0);
  assert.deepEqual({ updater: status().updater, available: status().available, current: status().current.version }, { updater: 1, available: null, current: '1.0.0' });

  // A newer Kova on GitHub: found, with what's new.
  release('1.1.0', 'Warn when a link breaks');
  run('check');
  assert.deepEqual({ v: status().available.version, behind: status().available.behind, changes: status().available.changes }, { v: '1.1.0', behind: 1, changes: ['Warn when a link breaks'] });

  // The Update button: the hub writes "apply"; the updater updates, restarts Kova, and says how it went.
  writeFileSync(join(data, 'update', 'request'), 'apply\n');
  const r = run('request');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(version(), '1.1.0');
  assert.deepEqual({ result: status().last.result, from: status().last.from, to: status().last.to, available: status().available, state: status().state }, { result: 'updated', from: '1.0.0', to: '1.1.0', available: null, state: 'idle' });
  assert.match(readFileSync(join(root, 'shim.log'), 'utf8'), /systemctl restart kova/);
  // …and installed its own units on the way (the Update button and the 6-hourly check).
  assert.deepEqual(readdirSync(join(root, 'units')).sort(), ['kova-update-check.service', 'kova-update-check.timer', 'kova-update.path', 'kova-update.service']);
  assert.match(readFileSync(join(root, 'units', 'kova-update.path'), 'utf8'), new RegExp(`PathExists=${data}/update/request`));

  // A version that doesn't come up: back to the one before, by itself.
  release('1.2.0', 'Something broken');
  run('check');
  const bad = run('apply', { BROKEN: '1.2.0' });
  assert.equal(bad.status, 0);
  assert.equal(version(), '1.1.0', 'back on the version before');
  assert.equal(status().last.result, 'rolled-back');
  assert.match(readFileSync(join(data, 'update', 'last-update.log'), 'utf8'), /going back to/);
  // It's still offered (fixed or not, the owner decides).
  assert.equal(status().available.version, '1.2.0');
});

/**
 * Releases from ClickBit's catalog: a fake clickbit-admin serves bundles packed by scripts/pack-release.mjs; the box
 * starts as a pre-release install (a plain folder, `current` → "."), gets a licence, takes a release beside the
 * running one, and goes back to it by itself when the next one doesn't come up.
 */
test('Updater: releases from the catalog — licence, check, download, install beside, switch, and back when it fails', { skip: !isRoot && 'install-release.sh runs as root', timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kova-rel-updater-'));
  const kova = join(root, 'kova'), data = join(root, 'data'), bin = join(root, 'bin'), units = join(root, 'units');
  // A Kova the way release.ts needs it: the hub's code, the deploy scripts, dependencies.
  const tree = (dir: string, version: string) => {
    mkdirSync(join(dir, 'hub'), { recursive: true });
    cpSync(join(repo, 'hub', 'src'), join(dir, 'hub', 'src'), { recursive: true });
    writeFileSync(join(dir, 'hub', 'package.json'), JSON.stringify({ name: '@kova/hub', version, type: 'module' }));
    cpSync(deploy, join(dir, 'deploy'), { recursive: true });
    for (const d of ['web', 'ota']) { mkdirSync(join(dir, d), { recursive: true }); writeFileSync(join(dir, d, 'x'), version); }
    writeFileSync(join(dir, 'package.json'), '{"name":"kova","private":true}');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  };
  tree(kova, '1.0.0');
  symlinkSync('.', join(kova, 'current'));
  const bundles = new Map<string, Buffer>();
  // What the catalog says each release's bytes are (set when it's published).
  const listed = new Map<string, Buffer>();
  const publish = (version: string) => {
    const t = join(root, `build-${version}`), parts = join(t, 'parts');
    tree(join(t, 'tree'), version); mkdirSync(parts);
    const part = (name: string, ...paths: string[]) => execFileSync('tar', ['-czf', join(parts, `${name}.tar.gz`), '-C', join(t, 'tree'), ...paths]);
    part('root', 'package.json', 'package-lock.json'); part('hub', 'hub'); part('web', 'web'); part('ota', 'ota'); part('deploy', 'deploy'); part('node_modules', 'node_modules');
    execFileSync('node', [join(repo, 'scripts', 'pack-release.mjs'), '--parts', parts, '--version', version, '--commit', `${version.replace(/\./g, '')}0000000`, '--out', join(t, 'kova-release.tar.gz')]);
    bundles.set(version, readFileSync(join(t, 'kova-release.tar.gz')));
    listed.set(version, bundles.get(version)!);
  };

  let latest = '';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = new URL(req.url!, 'http://x');
    const send = (j: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (url.pathname === '/api/v1/device/activate') return send({ status: 'active', edition: 'home', deviceToken: JSON.parse(raw).siteId ? 'tok' : null });
    if (req.headers.authorization !== 'Bearer tok' && url.pathname !== '/api/v1/updates/download') return send({ error: 'Expired deviceToken' }, 401);
    if (url.pathname === '/api/v1/updates/check') {
      const cur = url.searchParams.get('currentVersion');
      return send(latest && latest !== cur ? { updateAvailable: true, version: latest, releaseNotes: `- Kova ${latest}\n- From the catalog` } : { updateAvailable: false });
    }
    if (url.pathname === '/api/v1/updates/download-token') {
      const v = JSON.parse(raw).version, b = listed.get(v)!;
      return send({ token: 'd', downloadPath: `/api/v1/updates/download?v=${v}`, sha256: createHash('sha256').update(b).digest('hex'), size: b.length });
    }
    if (url.pathname === '/api/v1/updates/download') { res.writeHead(200); res.end(bundles.get(url.searchParams.get('v')!)); return; }
    send({ error: 'no' }, 404);
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const catalogUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;

  mkdirSync(bin); mkdirSync(units);
  const shim = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim('systemctl', 'echo "systemctl $*" >> "$SHIM_LOG"');
  shim('journalctl', 'true');
  shim('npm', 'echo "npm $*" >> "$SHIM_LOG"');
  shim('curl', CURL);
  // The pre-release kova.service: install-updater.sh moves it onto `current`.
  writeFileSync(join(units, 'kova.service'), `[Service]\nWorkingDirectory=${kova}/hub\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KOVA_DIR: kova, KOVA_DATA: data, KOVA_ENV_FILE: join(root, 'kova.env'), KOVA_HEALTH_WAIT: '2', KOVA_SYSTEMD_DIR: units, SHIM_LOG: join(root, 'shim.log'), KOVA_UPDATE_URL: catalogUrl, KOVA_LICENCE_PUBKEY: TEST_PUBKEY };
  const run = (cmd: string, extra: Record<string, string> = {}) => new Promise<{ status: number | null; out: string }>(ok => {
    const p = spawn('bash', [join(kova, 'current', 'deploy', 'updater.sh'), cmd], { env: { ...env, ...extra } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', status => ok({ status, out }));
  });
  const status = () => JSON.parse(readFileSync(join(data, 'update', 'status.json'), 'utf8'));
  const running = () => JSON.parse(readFileSync(join(kova, 'current', 'hub', 'package.json'), 'utf8')).version;

  try {
    // No licence yet: nothing asked, and the hub says why.
    await run('check');
    assert.deepEqual({ source: status().source, soft: status().soft, available: status().available }, { source: 'release', soft: 'No device token — install a licence to enable updates', available: null });

    // The licence (what PUT /api/update/licence does), then a newer Kova in the catalog.
    const hubCatalog = new Catalog({ url: catalogUrl, version: '1.0.0', dir: join(data, 'update'), hubIdFile: join(data, 'hub-id'), pubkey: TEST_PUBKEY });
    await hubCatalog.activate(mintKey({ site: hubCatalog.hubId() }));
    publish('1.1.0'); latest = '1.1.0';
    await run('check');
    assert.deepEqual({ v: status().available.version, changes: status().available.changes, soft: status().soft, err: status().checkError }, { v: '1.1.0', changes: ['Kova 1.1.0', 'From the catalog'], soft: null, err: null });

    // The Update button: downloaded, verified, unpacked beside the running one, switched to, up.
    writeFileSync(join(data, 'update', 'request'), 'apply\n');
    const r = await run('request');
    assert.equal(r.status, 0, r.out);
    const log = readFileSync(join(data, 'update', 'last-update.log'), 'utf8');
    assert.equal(readlinkSync(join(kova, 'current')), 'releases/1.1.0', log);
    assert.equal(running(), '1.1.0');
    assert.deepEqual({ result: status().last.result, from: status().last.from, to: status().last.to, available: status().available }, { result: 'updated', from: '1.0.0', to: '1.1.0', available: null });
    assert.equal(JSON.parse(readFileSync(join(kova, 'releases', '1.1.0', 'manifest.json'), 'utf8')).version, '1.1.0');
    assert.equal(existsSync(join(data, 'update', 'kova-1.1.0.tar.gz')), false, 'the download is cleaned up');
    // The units run the release's updater now; kova.service runs whatever `current` is.
    assert.match(readFileSync(join(units, 'kova-update.service'), 'utf8'), new RegExp(`ExecStart=/bin/bash ${kova}/current/deploy/updater.sh request`));
    assert.match(readFileSync(join(units, 'kova.service'), 'utf8'), new RegExp(`WorkingDirectory=${kova}/current/hub`));
    assert.match(readFileSync(join(root, 'shim.log'), 'utf8'), /systemctl restart kova/);

    // A release that doesn't come up: back on 1.1.0 by itself, and 1.2.0 isn't offered again.
    publish('1.2.0'); latest = '1.2.0';
    const bad = await run('apply', { BROKEN: '1.2.0' });
    assert.equal(bad.status, 0, bad.out);
    assert.equal(readlinkSync(join(kova, 'current')), 'releases/1.1.0');
    assert.equal(status().last.result, 'rolled-back');
    assert.match(readFileSync(join(data, 'update', 'last-update.log'), 'utf8'), /going back to 1\.1\.0/);
    assert.equal(readFileSync(join(data, 'update', 'bad-versions'), 'utf8'), '1.2.0\n');
    assert.deepEqual({ available: status().available, soft: status().soft }, { available: null, soft: 'Kova 1.2.0 was undone on this box after it didn’t start; waiting for a newer one' });

    // A bundle tampered with after the catalog listed it: refused, nothing changes.
    publish('1.3.0'); latest = '1.3.0';
    const b = bundles.get('1.3.0')!; const evil = Buffer.from(b); evil[evil.length - 10] ^= 0xff;
    bundles.set('1.3.0', evil);
    const t = await run('apply');
    assert.equal(t.status, 0);
    assert.equal(status().last.result, 'failed');
    assert.match(readFileSync(join(data, 'update', 'last-update.log'), 'utf8'), /Kova 1\.3\.0 didn’t verify/);
    assert.equal(readlinkSync(join(kova, 'current')), 'releases/1.1.0');
    assert.equal(existsSync(join(kova, 'releases', '1.3.0')), false);
  } finally {
    server.close();
  }
});
