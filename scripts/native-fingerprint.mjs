#!/usr/bin/env node
// The phone app's native surface, pinned to its train (runtimeVersion).
//
// A JavaScript bundle under ota/<train>/ is only ever offered to a binary that asks for exactly that
// train, which is only safe while "same train" means "same native code". mobile/native-lock.json
// records the train and a fingerprint of everything the binary is built from: native dependencies
// (mobile/package.json minus scripts/js-only-deps.txt, at the versions package-lock.json resolves),
// app.json's native config and the images it names, and every tracked file under the native
// directories (release/components.json nativeDirs).
//
//   --check (default)  fail when the fingerprint moved but the train didn't: that bundle would reach
//                      binaries that can't run it. Run before every over-the-air export.
//   --print            {mobile: {runtimeVersion, fingerprint}} as JSON; store-release.mjs records it
//                      with every store build, for rule 3 (no native change, no store build).
//   --write            record the current fingerprint for the current train. store-release.mjs does it
//                      when the train moves; by hand only while no binary on that train has shipped.
//
// Usage: node scripts/native-fingerprint.mjs [--check|--print|--write]
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, fingerprintOf, loadRegistry, loadStoreBuilds, nativeInputs, readJson } from './lib/versioning.mjs';

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--print') ? 'print' : 'check';
const comp = loadRegistry().find(c => c.id === 'mobile');
const train = readJson(comp.appJson).expo.runtimeVersion;
const inputs = nativeInputs(comp);
const fingerprint = fingerprintOf(inputs);

if (mode === 'print') {
  process.stdout.write(JSON.stringify({ mobile: { runtimeVersion: train, fingerprint } }) + '\n');
} else if (mode === 'write') {
  const shipped = loadStoreBuilds().trains?.[train] ?? [];
  if (shipped.length && !process.argv.includes('--force')) {
    process.stderr.write(`${train} already has store builds (${shipped.map(b => b.build).join(', ')}): its native code is fixed. Start a new train: node scripts/store-release.mjs mobile\n`);
    process.exit(1);
  }
  writeFileSync(join(ROOT, comp.nativeLock), JSON.stringify({ runtimeVersion: train, fingerprint, inputs }, null, 2) + '\n');
  process.stdout.write(`${comp.nativeLock}: ${train} ${fingerprint.slice(0, 12)}\n`);
} else {
  const lock = existsSync(join(ROOT, comp.nativeLock)) ? readJson(comp.nativeLock) : null;
  const problems = [];
  if (!lock) problems.push(`${comp.nativeLock} is missing: node scripts/native-fingerprint.mjs --write`);
  else if (lock.runtimeVersion !== train) problems.push(`${comp.nativeLock} is for ${lock.runtimeVersion}, but app.json's train is ${train}`);
  else if (lock.fingerprint !== fingerprint) {
    const changed = [...new Set([...Object.keys(inputs), ...Object.keys(lock.inputs ?? {})])].filter(k => inputs[k] !== lock.inputs?.[k]).sort();
    problems.push(`native code changed on ${train} (${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', …' : ''}). Bundles for ${train} would reach binaries that can't run them: start a new train with node scripts/store-release.mjs mobile`);
  }
  if (problems.length) { for (const p of problems) process.stderr.write(`native-fingerprint: ${p}\n`); process.exit(1); }
  process.stdout.write(`native-fingerprint: ${train} ok (${fingerprint.slice(0, 12)})\n`);
}
