#!/usr/bin/env node
// pack-release.mjs — the last step of build-release.sh: turn the part tarballs into the release artifact, and never
// expose a half-made one (the same order as Helix's scripts/pack-release.mjs):
//
//   node scripts/pack-release.mjs --parts DIR --version V --commit SHA --out dist/kova-release.tar.gz
//
//   1. every part (DIR/<name>.tar.gz) is hashed (sha256 + size) as it finally is;
//   2. manifest.json is written, and goes into the tar LAST — a truncated download never has a manifest, and the
//      hub refuses a bundle without one (hub/src/services/release-client.ts verifyBundle);
//   3. the tar is written to a temp name beside the output and read back: manifest last, every part present at
//      exactly its manifest size and sha256, nothing unlisted;
//   4. only then is it renamed over the output, followed by <out>.sha256.
//
// Any failure leaves the previous artifact untouched and exits non-zero.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
for (const k of ['parts', 'version', 'commit', 'out']) if (!args[k]) { console.error(`pack-release: --${k} is required`); process.exit(64); }

const REQUIRED = ['root', 'hub', 'web', 'ota', 'deploy'];
const sha256 = p => { const b = fs.readFileSync(p); return { sha256: createHash('sha256').update(b).digest('hex'), size: b.length }; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const hubPkg = JSON.parse(fs.readFileSync(path.join(root, 'hub/package.json'), 'utf8'));

const files = fs.readdirSync(args.parts).filter(f => f.endsWith('.tar.gz')).sort();
const parts = {};
for (const f of files) parts[f.replace(/\.tar\.gz$/, '')] = { file: f, ...sha256(path.join(args.parts, f)) };
for (const p of REQUIRED) if (!parts[p]) throw new Error(`pack-release: no ${p} part in ${args.parts}`);

const manifest = {
  product: 'kova',
  version: args.version,
  gitSha: args.commit,
  builtAt: new Date().toISOString(),
  node: {
    min: String(hubPkg.engines?.node ?? '22').replace(/^[^\d]*/, ''),
    // node_modules was installed by this Node: native modules need the same ABI, OS and CPU on the box.
    ...(parts.node_modules ? { abi: process.versions.modules, platform: process.platform, arch: process.arch } : {}),
  },
  parts,
};
fs.writeFileSync(path.join(args.parts, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const out = path.resolve(args.out);
const tmp = `${out}.tmp-${process.pid}`;
try {
  execFileSync('tar', ['-czf', tmp, '-C', args.parts, ...files, 'manifest.json']);
  // Read it back.
  const listed = execFileSync('tar', ['-tzf', tmp], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (listed.at(-1) !== 'manifest.json') throw new Error('manifest.json is not the last entry');
  const unlisted = listed.filter(f => f !== 'manifest.json' && !files.includes(f));
  if (unlisted.length) throw new Error(`unlisted entries: ${unlisted.join(', ')}`);
  const check = fs.mkdtempSync(path.join(os.tmpdir(), 'kova-pack-'));
  try {
    execFileSync('tar', ['-xzf', tmp, '-C', check]);
    const m = JSON.parse(fs.readFileSync(path.join(check, 'manifest.json'), 'utf8'));
    for (const [name, p] of Object.entries(m.parts)) {
      const got = sha256(path.join(check, p.file));
      if (got.sha256 !== p.sha256 || got.size !== p.size) throw new Error(`part ${name} doesn't match the manifest after packing`);
    }
  } finally { fs.rmSync(check, { recursive: true, force: true }); }
  fs.renameSync(tmp, out);
  const whole = sha256(out);
  fs.writeFileSync(`${out}.sha256.tmp`, `${whole.sha256}  ${path.basename(out)}\n`);
  fs.renameSync(`${out}.sha256.tmp`, `${out}.sha256`);
  console.log(`${path.basename(out)}: Kova ${args.version} (${args.commit.slice(0, 7)}), ${whole.size} bytes, sha256 ${whole.sha256}`);
  for (const [name, p] of Object.entries(parts)) console.log(`   ${name.padEnd(13)} ${String(p.size).padStart(10)}  ${p.sha256}`);
} catch (e) {
  fs.rmSync(tmp, { force: true });
  console.error(`pack-release: ${e.message} — release refused`);
  process.exit(1);
}
