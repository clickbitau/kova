#!/usr/bin/env node
// The versioning gate (docs/VERSIONING.md).
//
//   node scripts/check-versions.mjs                       every component's version and history, the
//                                                         app against rules 1, 2, 4 and 7
//   node scripts/check-versions.mjs --against <ref>       also: every component changed since <ref> bumped
//                                                         its version (what a pull request must pass)
//   node scripts/check-versions.mjs --store-build mobile  the gate before a store build (DockBit): the
//                                                         native lock is current, the store version was
//                                                         never approved, and the native code differs from
//                                                         the last store build's on an earlier train (rule 3)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, appProblems, buildNumberProblems, fingerprintOf, loadRegistry, loadStoreBuilds, nativeInputs, parseVersion, readJson, storeBuildProblems } from './lib/versioning.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const against = opt('--against');
const storeBuild = opt('--store-build');

const components = loadRegistry();
const record = loadStoreBuilds();
const problems = [];
const versionOf = (c, at) => {
  if (at === undefined) return readJson(c.versionFile).version;
  try { return JSON.parse(execFileSync('git', ['show', `${at}:${c.versionFile}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).version; } catch { return undefined; }
};

for (const c of components) {
  const v = versionOf(c);
  if (!parseVersion(v)) problems.push(`${c.id}: version ${v} in ${c.versionFile} is not X.Y.Z`);
  if (c.id !== 'mobile') continue;
  const vf = readJson(c.versionFile);
  for (const p of appProblems({ version: vf, appJson: readJson(c.appJson), prefix: c.trainPrefix, approved: record.approved?.mobile ?? [] })) problems.push(`mobile: ${p}`);
  for (const p of buildNumberProblems(record, c.trainPrefix)) problems.push(`mobile: ${p}`);
}

if (against) {
  const changed = execFileSync('git', ['diff', '--name-only', `${against}...HEAD`], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const c of components) {
    const touched = changed.filter(f => c.paths.some(p => f === p || f.startsWith(p)));
    if (!touched.length) continue;
    if (versionOf(c) === versionOf(c, against)) problems.push(`${c.id}: ${touched.length} file(s) changed since ${against} (${touched.slice(0, 3).join(', ')}…) without a version bump in ${c.versionFile}`);
  }
}

if (storeBuild) {
  const c = components.find(x => x.id === storeBuild && x.appJson);
  if (!c) problems.push(`--store-build: '${storeBuild}' is not an app (${components.filter(x => x.appJson).map(x => x.id).join(', ')})`);
  else {
    const lock = existsSync(join(ROOT, c.nativeLock)) ? readJson(c.nativeLock) : null;
    for (const p of storeBuildProblems({ version: readJson(c.versionFile), record, prefix: c.trainPrefix, fingerprint: fingerprintOf(nativeInputs(c)), lock })) problems.push(`${c.id}: ${p}`);
  }
}

if (problems.length) {
  process.stderr.write('Version problems:\n');
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
const mobile = readJson('mobile/src/version.json');
process.stdout.write(`versions ok: ${components.map(c => `${c.id} ${versionOf(c)}`).join(', ')} (mobile store ${mobile.store} on ${mobile.train})${storeBuild ? `; ${storeBuild} may have a store build` : ''}\n`);
