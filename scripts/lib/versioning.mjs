// The versioning standard (docs/VERSIONING.md), as pure functions over the files, so every
// script enforces the same rules and scripts/versioning.test.mjs can test each one.
//
//   MAJOR.MINOR.PATCH = App Store line . native store build . over-the-air update
//   1. A store binary is X.Y.0; a new native build bumps MINOR (or MAJOR for a new App Store line).
//   2. Over-the-air updates only bump PATCH, above their binary's X.Y.0.
//   3. No native change, no store build.
//   4. Never reuse an approved version; versions only go up.
//   7. Build numbers only go up, per platform.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const readJson = (p, root = ROOT) => JSON.parse(readFileSync(join(root, p), 'utf8'));

export function loadRegistry(root = ROOT) { return readJson('release/components.json', root).components; }
export function loadStoreBuilds(root = ROOT) { return readJson('release/store-builds.json', root); }

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** The train a store version builds on (rule 6): <prefix>-<MAJOR>.<MINOR>, so 0.1.0 is kova-mobile-0.1. */
export function trainFor(store, prefix) {
  const v = parseVersion(store);
  return v ? `${prefix}-${v[0]}.${v[1]}` : null;
}
/** [MAJOR, MINOR] from a train name, or null. */
export function trainLine(train, prefix) {
  const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.(\\d+)$`).exec(String(train ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
/** Trains in version order. */
const byLine = prefix => (a, b) => { const x = trainLine(a, prefix) ?? [-1, -1], y = trainLine(b, prefix) ?? [-1, -1]; return x[0] - y[0] || x[1] - y[1]; };

/** Rules 1, 2 and 4 on the app's version file and app.json. */
export function appProblems({ version: vf, appJson, prefix, approved = [] }) {
  const out = [];
  const expo = appJson?.expo ?? {};
  const store = vf.store, v = vf.version;
  if (!parseVersion(store) || parseVersion(store)[2] !== 0) out.push(`store version ${store} is not X.Y.0 (rule 1)`);
  if (expo.version !== store) out.push(`app.json version ${expo.version} is not the store version ${store}`);
  // Rule 6: the train names the version line it builds (kova-mobile-0.1 builds 0.1.0).
  if (trainFor(store, prefix) && vf.train !== trainFor(store, prefix)) out.push(`train ${vf.train} is not ${trainFor(store, prefix)}: the train is ${prefix}-<MAJOR>.<MINOR> of the store version (rule 6)`);
  if (expo.runtimeVersion !== vf.train) out.push(`app.json runtimeVersion ${expo.runtimeVersion} is not the train ${vf.train}`);
  const pv = parseVersion(v), ps = parseVersion(store);
  if (!pv) out.push(`version ${v} is not X.Y.Z`);
  else if (ps && (pv[0] !== ps[0] || pv[1] !== ps[1])) out.push(`version ${v} is not an update of the store version ${store}: over the air only PATCH moves (rule 2)`);
  const hist = vf.history ?? [];
  if (!hist.length || hist[0].version !== v) out.push(`history doesn't start with the current version ${v}`);
  for (let i = 0; i + 1 < hist.length; i++) {
    if (!(compareVersions(hist[i].version, hist[i + 1].version) > 0)) out.push(`history goes ${hist[i + 1].version} → ${hist[i].version}: versions only go up (rule 4)`);
  }
  for (const h of hist) if (!String(h.title ?? '').trim()) out.push(`history ${h.version} has no title`);
  // Rule 4: never below an approved version (the approved one itself is fine: its updates go out over the air).
  for (const a of approved) if (compareVersions(store, a.version) < 0) out.push(`store version ${store} is below approved ${a.version} (rule 4)`);
  return out;
}

/** Rule 7: build numbers only go up, per platform, in train order. */
export function buildNumberProblems(record, prefix) {
  const out = [];
  const trains = Object.keys(record.trains ?? {}).sort(byLine(prefix));
  const last = {};
  for (const t of trains) {
    for (const b of record.trains[t]) {
      const n = Number(b.build);
      if (!Number.isFinite(n)) { out.push(`${t}: build ${b.build} is not a number`); continue; }
      if (last[b.platform] !== undefined && !(n > last[b.platform])) out.push(`${t}: ${b.platform} build ${b.build} is not above ${last[b.platform]} (rule 7)`);
      last[b.platform] = n;
    }
  }
  return out;
}

/** The last store build's native fingerprint on a train before `train` (rule 3 compares against it). */
export function lastStoreFingerprint(record, train, prefix) {
  const order = byLine(prefix);
  const earlier = Object.keys(record.trains ?? {}).filter(t => trainLine(t, prefix) && order(t, train) < 0).sort(order).reverse();
  for (const t of earlier) {
    const withFp = record.trains[t].filter(b => b.fingerprint);
    if (withFp.length) return { train: t, ...withFp[withFp.length - 1] };
  }
  return null;
}

/** Rules 3 and 4 before a store build of the current train. */
export function storeBuildProblems({ version: vf, record, prefix, fingerprint, lock }) {
  const out = [];
  if (!lock || lock.runtimeVersion !== vf.train) out.push(`native-lock.json is for ${lock?.runtimeVersion ?? 'nothing'}, not ${vf.train}`);
  else if (lock.fingerprint !== fingerprint) out.push(`native code changed since ${vf.train} was locked: start a new train first (node scripts/store-release.mjs mobile)`);
  for (const a of record.approved?.mobile ?? []) {
    if (!(compareVersions(vf.store, a.version) > 0)) out.push(`store version ${vf.store} was already approved or is below approved ${a.version}: never reuse an approved version (rule 4)`);
  }
  const last = lastStoreFingerprint(record, vf.train, prefix);
  if (last && last.fingerprint === fingerprint) out.push(`native code is the same as build ${last.build} on ${last.train}: no native change, no store build; ship it over the air (rule 3)`);
  return out;
}

/** The next train and store version: MINOR + 1, or a new MAJOR (a new App Store line). */
export function nextTrain(vf, prefix, { major = false } = {}) {
  const [X, Y] = parseVersion(vf.store);
  const store = major ? `${X + 1}.0.0` : `${X}.${Y + 1}.0`;
  return { train: trainFor(store, prefix), store };
}

/** The next over-the-air version on this train: PATCH + 1 above what runs now. */
export function nextUpdate(vf) {
  const [X, Y, Z] = parseVersion(vf.version);
  return `${X}.${Y}.${Z + 1}`;
}

// ------------------------------------------------------------ native fingerprint --

const sha = s => createHash('sha256').update(s).digest('hex');

/** Every input a binary is built from: native dependencies, app.json's native config and the native files. */
export function nativeInputs(comp, root = ROOT) {
  const appDir = dirname(comp.appJson);
  const inputs = {};
  const pkg = readJson(join(appDir, 'package.json'), root);
  const lock = existsSync(join(root, appDir, 'package-lock.json')) ? readJson(join(appDir, 'package-lock.json'), root) : { packages: {} };
  const jsOnly = new Set(readFileSync(join(root, 'scripts/js-only-deps.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) {
    if (jsOnly.has(dep)) continue;
    const resolved = lock.packages?.[`node_modules/${dep}`]?.version ?? pkg.dependencies[dep];
    inputs[`dependency ${dep}`] = sha(`${dep}@${resolved}`);
  }
  // app.json minus what doesn't reach the binary: the version (a store build stamps it) and the train itself.
  const { version: _v, runtimeVersion: _r, extra: _e, owner: _o, ...native } = readJson(comp.appJson, root).expo;
  inputs['app.json native config'] = sha(stable(native));
  // Image files the native config names (icon, splash, notification icon): a new icon needs a new binary.
  for (const ref of [...new Set(JSON.stringify(native).match(/\.\/assets\/[^"]+/g) ?? [])].sort()) {
    const p = join(appDir, ref);
    if (existsSync(join(root, p))) inputs[p] = sha(readFileSync(join(root, p)));
  }
  const tracked = execFileSync('git', ['ls-files', '-z', ...comp.nativeDirs], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of tracked.sort()) {
    if ((comp.nativeExclude ?? []).some(x => f.startsWith(x))) continue;
    inputs[f] = sha(readFileSync(join(root, f)));
  }
  return inputs;
}

export function fingerprintOf(inputs) {
  return sha(Object.keys(inputs).sort().map(k => `${k}\0${inputs[k]}`).join('\n'));
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
