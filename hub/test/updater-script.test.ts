import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const deploy = resolve(import.meta.dirname, '../../deploy');
const isRoot = process.getuid?.() === 0;

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
  shim('curl', `v=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "${kova}/hub/package.json"); [[ "$v" == "\${BROKEN:-none}" ]] && exit 7; echo '{"ok":true}'`);
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
