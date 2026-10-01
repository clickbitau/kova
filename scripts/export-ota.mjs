#!/usr/bin/env node
// An over-the-air release of the phone app: the JavaScript and assets, exported for its current
// native train into ota/<train>/<timestamp>/, which the hub serves (hub/src/api/app-updates.ts).
//
//   node scripts/export-ota.mjs "What changed"   bump PATCH (0.1.2 → 0.1.3), add the history entry, export
//   node scripts/export-ota.mjs --no-bump        export the current version again (e.g. a fresh hub)
//
// Refused when the native code changed since the train was locked (the bundle would reach binaries
// that can't run it) or the versions are off. Keeps the newest --keep (default 2) bundles per train.
// Commit ota/ with the version bump: hubs get it with the next update (git pull or the Docker image).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, loadRegistry, nextUpdate, readJson } from './lib/versioning.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keep = Number(opt('--keep') ?? 2);
const noBump = args.includes('--no-bump');
const title = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--keep').join(' ').trim();
const run = (cmd, a, cwd = ROOT) => execFileSync(cmd, a, { cwd, stdio: 'inherit' });
const die = m => { process.stderr.write(`export-ota: ${m}\n`); process.exit(1); };

const comp = loadRegistry().find(c => c.id === 'mobile');
const appDir = join(ROOT, 'mobile');
if (!noBump && !title) die('say what changed: node scripts/export-ota.mjs "What changed" (or --no-bump)');

run('node', ['scripts/native-fingerprint.mjs', '--check']);
let vf = readJson(comp.versionFile);
if (!noBump) {
  const version = nextUpdate(vf);
  vf = { ...vf, version, history: [{ version, title }, ...vf.history] };
  writeFileSync(join(ROOT, comp.versionFile), JSON.stringify(vf, null, 2) + '\n');
}
run('node', ['scripts/check-versions.mjs']);

const out = mkdtempSync(join(tmpdir(), 'kova-ota-'));
try {
  run('npx', ['expo', 'export', '--platform', 'ios', '--platform', 'android', '--output-dir', out], appDir);
  // The config the manifest carries, with the bundle's own version (app.json keeps the store version).
  const cfg = JSON.parse(execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], { cwd: appDir, encoding: 'utf8' }));
  writeFileSync(join(out, 'expoConfig.json'), JSON.stringify({ ...cfg, version: vf.version }, null, 2) + '\n');
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = join(ROOT, 'ota', vf.train, id);
  mkdirSync(join(ROOT, 'ota', vf.train), { recursive: true });
  cpSync(out, dest, { recursive: true });
  const all = readdirSync(join(ROOT, 'ota', vf.train)).filter(n => existsSync(join(ROOT, 'ota', vf.train, n, 'metadata.json'))).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(ROOT, 'ota', vf.train, old), { recursive: true, force: true });
  process.stdout.write(`\nexport-ota: Kova ${vf.version} for ${vf.train} → ota/${vf.train}/${id}\nCommit mobile/src/version.json and ota/ together.\n`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
