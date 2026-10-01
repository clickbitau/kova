import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, chownSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { parseLicenceKey } from './licence-key.ts';
import { pipeline } from 'node:stream/promises';

/**
 * Kova releases from ClickBit's catalog (clickbit-admin), the way Helix's server gets its own
 * (helix server/internal/update and internal/licencecloud). No hub imports: the root updater runs this through
 * src/tools/release.ts as well as the hub.
 *
 * - The licence: a CR1- key ClickBit issues for this hub's ID (hub-id, made once; services/licence-key.ts checks it
 *   offline), then POST /v1/device/activate {licenceKey, siteId: hub ID, deviceFingerprint, productVersion} →
 *   {status, edition, features, deviceToken} (no token, and a reason, when it's revoked, expired or for another hub). The token (a JWT, about an hour) is renewed by activating again with the stored key,
 *   when it's about to expire and when the catalog answers 401. Kept in <KOVA_DATA>/update/licence.json.
 * - Is there a newer Kova: GET /v1/updates/check?product=kova&channel=stable&currentVersion=<v>, Bearer token.
 * - Getting it: POST /v1/updates/download-token {product, channel, version} → {downloadPath, sha256, size}; the
 *   download is refused unless the catalog says what its bytes are, and kept only when they are exactly that.
 * - The bundle (scripts/build-release.sh): parts (hub, web, ota, deploy, root, node_modules), each a tar.gz,
 *   and manifest.json last, with each part's sha256 and size.
 */
export const DEFAULT_CATALOG = 'https://admin.clickbit.com.au/api';
export const NO_TOKEN = 'No device token — install a licence to enable updates';

export interface CatalogOpts {
  url?: string;
  product?: string;
  channel?: string;
  /** The running Kova. */
  version: string;
  /** The running build's commit, when known. */
  gitSha?: string;
  /** <KOVA_DATA>/update */
  dir: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The licence signing key, instead of ClickBit's (tests). */
  pubkey?: string;
  /** Where the hub's ID is kept (default <dir>/hub-id; the hub and the updater use <KOVA_DATA>/hub-id). */
  hubIdFile?: string;
}

export interface LicenceState {
  key?: string;
  deviceFingerprint?: string;
  deviceToken?: string;
  status?: string;
  edition?: string;
  features?: string[];
  activatedAt?: number;
  expiresAt?: string;
  error?: string;
}

export interface Offer { version: string; gitSha?: string; sha256?: string; size?: number; releaseNotes?: string; artifactType?: string; requiresMigration?: boolean }

export class CatalogError extends Error {
  constructor(message: string, readonly code = 0) { super(message); }
}

/** Dotted numbers (1.2.3, 1.2.3.1): is a newer than b? Anything not dotted numbers: not comparable (null). */
export function newer(a: string, b: string): boolean | null {
  const p = (v: string) => /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
  const x = p(a), y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** A JWT's exp, two minutes early (a token that dies mid-request is a dead one). Not a JWT: not stale. */
export function tokenStale(token: string, now: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const exp = Number(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp);
    return exp > 0 && now / 1000 >= exp - 120;
  } catch { return false; }
}

/** Write a file the way the hub (user kova) and the updater (root) can both keep using it. */
function writeShared(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  let owner: { uid: number; gid: number } | null = null;
  try { const s = statSync(existsSync(file) ? file : dirname(file)); owner = { uid: s.uid, gid: s.gid }; } catch { /* new */ }
  writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
  if (owner && process.getuid?.() === 0) { try { chownSync(`${file}.tmp`, owner.uid, owner.gid); } catch { /* best effort */ } }
  renameSync(`${file}.tmp`, file);
}

export class Catalog {
  private lastRefresh = 0;
  constructor(private o: CatalogOpts) {}

  get product() { return this.o.product || 'kova'; }
  get channel() { return this.o.channel || 'stable'; }
  private get base() { return (this.o.url || DEFAULT_CATALOG).replace(/\/+$/, ''); }
  private get now() { return this.o.now?.() ?? Date.now(); }
  private get fetch() { return this.o.fetch ?? fetch; }
  private get licenceFile() { return join(this.o.dir, 'licence.json'); }
  private get badFile() { return join(this.o.dir, 'bad-versions'); }

  licence(): LicenceState {
    try { return JSON.parse(readFileSync(this.licenceFile, 'utf8')) as LicenceState; } catch { return {}; }
  }

  private saveLicence(s: LicenceState): void { writeShared(this.licenceFile, `${JSON.stringify(s, null, 2)}\n`); }

  /**
   * This hub's ID: what an admin issues a Kova licence for (the key's "site", sent as siteId). Made once, kept apart
   * from the licence so forgetting a key doesn't change it: KOVA- and 12 base32 characters in groups of four.
   */
  hubId(): string {
    const f = this.o.hubIdFile ?? join(this.o.dir, 'hub-id');
    try { const id = readFileSync(f, 'utf8').trim(); if (/^KOVA-[A-Z0-9-]+$/.test(id)) return id; } catch { /* first time */ }
    const A = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
    const c = [...randomBytes(12)].map(b => A[b % 32]).join('');
    const id = `KOVA-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
    writeShared(f, `${id}\n`);
    return id;
  }

  /** What the hub shows: never the key or the token. */
  licenceView(): { hubId: string; installed: boolean; activated: boolean; status: string | null; edition: string | null; features: string[]; expiresAt: string | null; key: string | null; error: string | null } {
    const l = this.licence();
    return {
      hubId: this.hubId(), installed: !!l.key, activated: !!l.deviceToken, status: l.status ?? null, edition: l.edition ?? null, features: l.features ?? [],
      expiresAt: l.expiresAt ?? null, key: l.key ? `…${l.key.slice(-4)}` : null, error: l.error ?? null,
    };
  }

  private fingerprint(): string {
    const l = this.licence();
    if (l.deviceFingerprint) return l.deviceFingerprint;
    const fp = randomBytes(16).toString('hex');
    this.saveLicence({ ...l, deviceFingerprint: fp });
    return fp;
  }

  /**
   * Check the key offline, then exchange it for a device token (and remember both). A new key that fails changes
   * nothing installed; the installed key failing (revoked, expired) is kept with the reason, for the owner to see.
   */
  async activate(key = this.licence().key ?? ''): Promise<LicenceState> {
    key = key.trim();
    if (!key) throw new CatalogError('No licence key');
    const installed = key === this.licence().key;
    const refused = (message: string, code = 0) => {
      if (installed) this.saveLicence({ ...this.licence(), deviceToken: undefined, error: message });
      return new CatalogError(message, code);
    };
    const hubId = this.hubId();
    let claim;
    try { claim = parseLicenceKey(key, { hubId, now: this.now, pubkey: this.o.pubkey }); } catch (e) { throw refused((e as Error).message); }
    const fp = this.fingerprint();
    let out: { status?: string; edition?: string; features?: string[]; deviceToken?: string | null; reason?: string };
    try {
      out = await this.json('POST', `${this.base}/v1/device/activate`, null, { licenceKey: key, siteId: hubId, deviceFingerprint: fp, productVersion: this.o.version });
    } catch (e) {
      // ClickBit refused it: said. ClickBit down: nothing changes.
      if (e instanceof CatalogError && e.code >= 400 && e.code < 500) throw refused(`ClickBit refused the licence: ${e.message}`, e.code);
      throw e;
    }
    if (!out.deviceToken) {
      const why = out.reason === 'site_mismatch' ? `it was issued for another hub (this one is ${hubId})` : out.reason ?? out.status ?? 'no reason given';
      throw refused(`ClickBit didn’t activate the licence: ${why}`);
    }
    const s: LicenceState = {
      ...this.licence(), key, deviceFingerprint: fp, deviceToken: out.deviceToken.trim(), status: out.status, edition: out.edition ?? claim.edition,
      features: out.features ?? claim.features, expiresAt: claim.expiresAt, activatedAt: this.now, error: undefined,
    };
    this.saveLicence(s);
    return s;
  }

  forget(): void { rmSync(this.licenceFile, { force: true }); }

  /** The token, renewed first when it's about to expire (at most once a minute; a stale one beats none). */
  async token(): Promise<string> {
    const l = this.licence();
    if (!l.deviceToken) {
      if (l.key && !l.error && this.now - this.lastRefresh > 60_000) {
        this.lastRefresh = this.now;
        try { return (await this.activate(l.key)).deviceToken ?? ''; } catch { return ''; }
      }
      return '';
    }
    if (tokenStale(l.deviceToken, this.now) && l.key && this.now - this.lastRefresh > 60_000) {
      this.lastRefresh = this.now;
      try { return (await this.activate(l.key)).deviceToken ?? l.deviceToken; } catch { return l.deviceToken; }
    }
    return l.deviceToken;
  }

  private async json<T>(method: string, url: string, token: string | null, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await this.fetch(url, {
        method, signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new CatalogError(`The release catalog can’t be reached: ${(e as Error).message}`);
    }
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) throw new CatalogError(`${r.status} ${String(j.error ?? j.message ?? (text.slice(0, 120) || r.statusText))}`, r.status);
    return j as T;
  }

  /** One authenticated call; on a 401, renew the token by activating again and try once more. */
  private async authed<T>(method: string, url: string, body?: unknown): Promise<T> {
    let token = await this.token();
    try {
      return await this.json<T>(method, url, token, body);
    } catch (e) {
      if (e instanceof CatalogError && e.code === 403) throw new CatalogError(`The licence isn’t active for Kova updates (${e.message})`, 403);
      if (!(e instanceof CatalogError) || e.code !== 401) throw e;
      let why = 'the catalog refused it';
      if (this.licence().key) {
        try {
          this.lastRefresh = this.now;
          token = (await this.activate()).deviceToken ?? '';
          if (token) {
            try { return await this.json<T>(method, url, token, body); } catch (e2) {
              if (!(e2 instanceof CatalogError) || e2.code !== 401) throw e2;
              why = 'the catalog refused the renewed token too';
            }
          }
        } catch (e3) { why = `renewing it failed: ${(e3 as Error).message}`; }
      }
      throw new CatalogError(`Updates can’t be checked: the device token expired (${why}). Check the licence key in Integrations → Kova updates.`, 401);
    }
  }

  badVersions(): string[] {
    try { return readFileSync(this.badFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean); } catch { return []; }
  }

  /** The same build as the one running: same commit, or the same version. */
  sameBuild(o: Offer): boolean {
    return (!!o.gitSha && !!this.o.gitSha && (o.gitSha.startsWith(this.o.gitSha) || this.o.gitSha.startsWith(o.gitSha))) || o.version === this.o.version;
  }

  /**
   * A newer Kova on the channel, or null. `soft` is a state to show that isn't a failure (no licence yet; a release
   * that rolled back here). Errors (the catalog down, a refused token) throw.
   */
  async check(): Promise<{ offer: Offer | null; soft?: string }> {
    if (!(await this.token())) {
      const l = this.licence();
      return { offer: null, soft: l.key && l.error ? `The licence key was refused (${l.error})` : NO_TOKEN };
    }
    const q = new URLSearchParams({ product: this.product, channel: this.channel, currentVersion: this.o.version });
    const c = await this.authed<{ updateAvailable?: boolean } & Partial<Offer>>('GET', `${this.base}/v1/updates/check?${q}`);
    if (!c.updateAvailable || !c.version) return { offer: null };
    const offer: Offer = { version: String(c.version), gitSha: c.gitSha, sha256: c.sha256, size: c.size, releaseNotes: c.releaseNotes, artifactType: c.artifactType, ...(c.requiresMigration ? { requiresMigration: true } : {}) };
    if (this.sameBuild(offer) || newer(offer.version, this.o.version) === false) return { offer: null };
    if (this.badVersions().includes(offer.version)) return { offer: null, soft: `Kova ${offer.version} was undone on this box after it didn’t start; waiting for a newer one` };
    return { offer };
  }

  /** Download a version to `out`, and keep it only when its bytes are exactly what the catalog says. */
  async download(version: string, out: string): Promise<{ sha256: string; size: number }> {
    const t = await this.authed<{ downloadPath?: string; url?: string; sha256?: string; size?: number }>('POST', `${this.base}/v1/updates/download-token`, { product: this.product, channel: this.channel, version });
    const want = { sha256: (t.sha256 ?? '').toLowerCase(), size: Number(t.size ?? 0) };
    // Listed before it can say what its bytes are: still being uploaded. Wait for the next check.
    if (!/^[0-9a-f]{64}$/.test(want.sha256) || !(want.size > 0)) throw new CatalogError(`Kova ${version} is listed without a sha256 and size — not downloading it until it is`);
    const path = t.downloadPath ?? t.url ?? '';
    if (!path) throw new CatalogError('The catalog gave no download link');
    // downloadPath is absolute from the origin ("/api/v1/updates/download?…"), not from the /api base.
    const url = /^https?:\/\//.test(path) ? path : new URL(path, new URL(this.base).origin).toString();
    const r = await this.fetch(url, { signal: AbortSignal.timeout(30 * 60_000) }).catch(e => { throw new CatalogError(`Download failed: ${(e as Error).message}`); });
    if (!r.ok || !r.body) throw new CatalogError(`Download failed: ${r.status} ${r.statusText}`, r.status);
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.part`;
    const h = createHash('sha256');
    let size = 0;
    const src = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream);
    src.on('data', (c: Buffer) => {
      size += c.length; h.update(c);
      if (size > want.size) src.destroy(new CatalogError(`Download is bigger than the ${want.size} bytes the catalog listed`));
    });
    try {
      await pipeline(src, createWriteStream(tmp, { mode: 0o600 }));
    } catch (e) { rmSync(tmp, { force: true }); throw e instanceof CatalogError ? e : new CatalogError(`Download failed: ${(e as Error).message}`); }
    const got = { sha256: h.digest('hex'), size };
    if (got.size !== want.size || got.sha256 !== want.sha256) {
      rmSync(tmp, { force: true });
      throw new CatalogError(`Kova ${version} didn’t verify: got ${got.size} bytes, sha256 ${got.sha256.slice(0, 12)}…, the catalog says ${want.size} bytes, ${want.sha256.slice(0, 12)}…`);
    }
    renameSync(tmp, out);
    return got;
  }
}

// ---------------------------------------------------------------- bundles --

export const PARTS = ['root', 'hub', 'web', 'ota', 'deploy'] as const;

export interface Manifest {
  product: string;
  version: string;
  gitSha: string;
  builtAt?: string;
  node: { min: string; abi?: string; platform?: string; arch?: string };
  /** Each part: a tar.gz beside manifest.json. node_modules is optional (without it the box runs npm ci). */
  parts: Record<string, { file: string; sha256: string; size: number }>;
}

export async function sha256File(p: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const c of createReadStream(p)) { h.update(c as Buffer); size += (c as Buffer).length; }
  return { sha256: h.digest('hex'), size };
}

/** An unpacked bundle (the outer tar): its manifest, and every part exactly as listed. Throws what's wrong. */
export async function verifyBundle(dir: string): Promise<Manifest> {
  let m: Manifest;
  try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest; } catch { throw new Error('The release has no readable manifest.json'); }
  if (!m.version || !m.parts || typeof m.parts !== 'object') throw new Error('manifest.json lists no version or parts');
  for (const p of PARTS) if (!m.parts[p]) throw new Error(`manifest.json lists no ${p} part`);
  for (const [name, part] of Object.entries(m.parts)) {
    if (!/^[\w.-]+\.tar\.gz$/.test(part.file)) throw new Error(`Part ${name}: bad file name ${part.file}`);
    const f = join(dir, part.file);
    if (!existsSync(f)) throw new Error(`Part ${name} (${part.file}) is missing`);
    const got = await sha256File(f);
    if (got.sha256 !== part.sha256 || got.size !== part.size) throw new Error(`Part ${name} (${part.file}) doesn’t match the manifest: sha256 ${got.sha256.slice(0, 12)}…, ${got.size} bytes`);
  }
  return m;
}

/** Does this box's Node run the bundle (and its node_modules as built)? */
export function nodeFits(m: Manifest, node = { version: process.versions.node, abi: process.versions.modules, platform: process.platform as string, arch: process.arch as string }): { runs: boolean; modules: boolean } {
  const runs = newer(m.node.min, node.version) !== true;
  const modules = !!m.parts.node_modules && (!m.node.abi || m.node.abi === node.abi) && (!m.node.platform || m.node.platform === node.platform) && (!m.node.arch || m.node.arch === node.arch);
  return { runs, modules };
}
