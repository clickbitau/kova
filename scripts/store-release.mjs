#!/usr/bin/env node
// Moving the phone app between store builds (docs/VERSIONING.md).
//
//   node scripts/store-release.mjs mobile [--major] ["What's new"]
//       Start the next native train for a new store binary: kova-mobile-<n+1>, store version MINOR + 1
//       (X.Y.0), or with --major a new App Store line (X+1.0.0). Updates app.json (version,
//       runtimeVersion), mobile/src/version.json and mobile/native-lock.json. Refused when the native
//       code is the same as the last store build's: ship it over the air instead (rule 3).
//
//   node scripts/store-release.mjs --shipped mobile <build> --platform ios|android --channel testflight|appstore|play-internal|play-production [--date YYYY-MM-DD]
//       Record a binary DockBit uploaded, with its store version and native fingerprint. Build numbers
//       only go up per platform (rule 7); an approved version is never built again (rule 4).
//
//   node scripts/store-release.mjs --approved mobile <version> <build> [--date YYYY-MM-DD]
//       Record an App Review approval. Approved versions only go up (rule 4).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildNumberProblems, compareVersions, fingerprintOf, lastStoreFingerprint, loadRegistry, loadStoreBuilds, nativeInputs, nextTrain, readJson } from './lib/versioning.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const die = m => { process.stderr.write(`store-release: ${m}\n`); process.exit(1); };
const write = (p, v) => writeFileSync(join(ROOT, p), JSON.stringify(v, null, 2) + '\n');
const today = () => opt('--date') ?? new Date().toISOString().slice(0, 10);

const comp = loadRegistry().find(c => c.id === 'mobile');
const record = loadStoreBuilds();
const vf = readJson(comp.versionFile);

if (args[0] === '--shipped') {
  const [, app, build] = args;
  if (app !== 'mobile') die(`'${app}' is not an app (mobile)`);
  const platform = opt('--platform'), channel = opt('--channel') ?? 'testflight';
  if (!/^\d+$/.test(build ?? '') || !['ios', 'android'].includes(platform)) die('usage: --shipped mobile <build> --platform ios|android --channel <channel>');
  if ((record.approved?.mobile ?? []).some(a => compareVersions(vf.store, a.version) <= 0)) die(`${vf.store} was already approved (or is below an approved version): start a new train first (rule 4)`);
  const fingerprint = fingerprintOf(nativeInputs(comp));
  (record.trains[vf.train] ??= []).push({ build: Number(build), platform, channel, version: vf.store, fingerprint, date: today() });
  const p = buildNumberProblems(record, comp.trainPrefix);
  if (p.length) die(p.join('; '));
  write('release/store-builds.json', record);
  process.stdout.write(`recorded ${platform} build ${build} (${vf.store}, ${vf.train}, ${channel})\n`);
} else if (args[0] === '--approved') {
  const [, app, version, build] = args;
  if (app !== 'mobile') die(`'${app}' is not an app (mobile)`);
  const list = (record.approved.mobile ??= []);
  if (list.some(a => compareVersions(version, a.version) <= 0)) die(`${version} is not above every approved version (${list.map(a => a.version).join(', ')}) (rule 4)`);
  list.push({ version, build: Number(build), date: today() });
  write('release/store-builds.json', record);
  process.stdout.write(`recorded approval of ${version} (build ${build})\n`);
} else if (args[0] === 'mobile') {
  const major = args.includes('--major');
  const title = args.slice(1).filter(a => !a.startsWith('--')).join(' ').trim() || (major ? 'A new App Store version' : 'A new store build');
  const fingerprint = fingerprintOf(nativeInputs(comp));
  const shippedHere = record.trains[vf.train] ?? [];
  const last = shippedHere.filter(b => b.fingerprint).at(-1) ?? lastStoreFingerprint(record, vf.train, comp.trainPrefix);
  if (!major && last && last.fingerprint === fingerprint) die(`native code is the same as build ${last.build}: no native change, no store build; ship it over the air (node scripts/export-ota.mjs "…") (rule 3)`);
  if (!shippedHere.length && !major) die(`${vf.train} has no store build yet: build it as it is (node scripts/native-fingerprint.mjs --write records native changes until then)`);
  const next = nextTrain(vf, comp.trainPrefix, { major });
  const appJson = readJson(comp.appJson);
  appJson.expo.version = next.store;
  appJson.expo.runtimeVersion = next.train;
  write(comp.appJson, appJson);
  write(comp.versionFile, { ...vf, train: next.train, store: next.store, version: next.store, history: [{ version: next.store, title }, ...vf.history] });
  record.trains[next.train] ??= [];
  write('release/store-builds.json', record);
  const inputs = nativeInputs(comp);
  write(comp.nativeLock, { runtimeVersion: next.train, fingerprint: fingerprintOf(inputs), inputs });
  process.stdout.write(`mobile: ${vf.train} ${vf.store} → ${next.train} ${next.store}. Build it, then record it with --shipped.\n`);
} else {
  die('usage: store-release.mjs mobile [--major] ["title"] | --shipped mobile <build> --platform ios|android --channel <c> | --approved mobile <version> <build>');
}
