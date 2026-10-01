import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Updates for the Kova phone app, served by the hub it's connected to (the same model as Helix
 * Server's appota): the app's JavaScript and assets come off the box on the LAN, so an update
 * works with the internet down, and nothing goes through Expo's cloud.
 *
 * This speaks Expo's updates protocol, which is what expo-updates on the phone asks with:
 * https://docs.expo.dev/technical-specs/expo-updates-1/
 *
 * A bundle is a directory made by `expo export` (scripts/export-ota.mjs), under its native train:
 *
 *   ota/<runtimeVersion>/<updateId>/
 *       metadata.json        the export's own list of files, per platform
 *       expoConfig.json      the app config, with the bundle's own version (0.1.3)
 *       _expo/static/js/…    the JavaScript
 *       assets/…             images and fonts
 *
 * The runtime version in the path is the contract: a bundle only goes to a binary built from the
 * same native code (scripts/native-fingerprint.mjs keeps the train honest). The newest update id
 * (they're timestamps) wins, so rolling back is removing a directory.
 *
 * Unauthenticated on purpose, like Helix's: expo-updates keeps each download with the URL and
 * headers it came from and only launches one whose headers still match, so a token in them would
 * strand every update the day the token changes. The bundle is the app's own code, nothing secret.
 */

export interface UpdateAsset { hash: string; key: string; contentType: string; fileExtension: string; url: string }
export interface UpdateManifest {
  id: string; createdAt: string; runtimeVersion: string;
  launchAsset: UpdateAsset; assets: UpdateAsset[];
  metadata: Record<string, unknown>; extra: Record<string, unknown>;
}
interface Built { manifest: UpdateManifest; files: Map<string, string>; dir: string }

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', json: 'application/json', js: 'application/javascript', hbc: 'application/javascript',
};
const typeOf = (ext: string) => TYPES[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';

/** A UUID (version 5 layout) from content, so the same bundle always has the same id wherever it's published. */
export function contentUuid(parts: string[]): string {
  const h = createHash('sha1').update('kova-ota-content-v1').update('\0');
  for (const p of parts) h.update(p).update('\0');
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export class AppUpdates {
  private cache = new Map<string, { mtime: number; built: Built }>();
  constructor(readonly dir: string) {}

  /** Trains with at least one bundle. */
  published(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(n => SAFE.test(n) && this.updates(n).length > 0).sort();
  }

  private updates(runtime: string): string[] {
    const d = join(this.dir, runtime);
    if (!SAFE.test(runtime) || !existsSync(d)) return [];
    return readdirSync(d).filter(n => SAFE.test(n) && existsSync(join(d, n, 'metadata.json'))).sort();
  }

  /** The newest bundle for this train and platform, or null when there's none. */
  latest(runtime: string, platform: string): Built | null {
    if (!SAFE.test(platform)) return null;
    for (const u of this.updates(runtime).reverse()) {
      const b = this.build(runtime, u, platform);
      if (b) return b;
    }
    return null;
  }

  /** The bundle a phone was offered (for its assets). */
  find(runtime: string, update: string, platform: string): Built | null {
    return SAFE.test(runtime) && SAFE.test(update) && SAFE.test(platform) ? this.build(runtime, update, platform) : null;
  }

  private build(runtime: string, update: string, platform: string): Built | null {
    const dir = join(this.dir, runtime, update);
    const metaFile = join(dir, 'metadata.json');
    let mtime: number;
    try { mtime = statSync(metaFile).mtimeMs; } catch { return null; }
    const key = `${runtime}/${update}/${platform}`;
    const hit = this.cache.get(key);
    if (hit && hit.mtime === mtime) return hit.built;
    let meta: { fileMetadata?: Record<string, { bundle: string; assets?: { path: string; ext: string }[] }> };
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { return null; }
    // One export holds both platforms; the other platform's JavaScript would crash the app, so never guess.
    const files = meta.fileMetadata?.[platform];
    if (!files?.bundle) return null;
    const asset = (rel: string, contentType: string, ext: string): UpdateAsset => {
      const body = readFileSync(join(dir, rel));
      const base = rel.split('/').pop()!;
      // Required on every asset (it names the cached file): the export's own ext, else from the type, else the path.
      const fileExt = ext || Object.entries(TYPES).find(([, t]) => t === contentType)?.[0] || (base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '');
      return {
        hash: createHash('sha256').update(body).digest('base64url'),
        // `expo export` names every file after its content hash, so the base name is a stable key.
        key: base.replace(/\.[^.]*$/, ''),
        contentType,
        fileExtension: fileExt ? `.${fileExt.replace(/^\./, '')}` : '',
        url: '',
      };
    };
    try {
      const fileMap = new Map<string, string>();
      const launchAsset = asset(files.bundle, 'application/javascript', '');
      fileMap.set(launchAsset.key, files.bundle);
      const assets = (files.assets ?? []).map(a => { const x = asset(a.path, typeOf(a.ext), a.ext); fileMap.set(x.key, a.path); return x; });
      let expoClient: Record<string, unknown> | undefined;
      try { expoClient = JSON.parse(readFileSync(join(dir, 'expoConfig.json'), 'utf8')); } catch { /* optional */ }
      const id = contentUuid([runtime, platform, launchAsset.key, launchAsset.hash, ...assets.map(a => `${a.key}:${a.hash}:${a.fileExtension}`).sort(), expoClient ? JSON.stringify(expoClient) : '']);
      const manifest: UpdateManifest = {
        id, createdAt: new Date(mtime).toISOString(), runtimeVersion: runtime,
        launchAsset, assets, metadata: {}, extra: expoClient ? { expoClient } : {},
      };
      const built = { manifest, files: fileMap, dir };
      this.cache.set(key, { mtime, built });
      return built;
    } catch {
      return null; // a file the export lists is missing: not a usable bundle
    }
  }
}

/** The manifest with asset URLs pointing back at the address the phone used. */
export function withUrls(b: Built, base: string, update: string): UpdateManifest {
  const at = (key: string) => `${base}/api/app/assets/${encodeURIComponent(b.manifest.runtimeVersion)}/${encodeURIComponent(update)}/${encodeURIComponent(key)}`;
  return {
    ...b.manifest,
    launchAsset: { ...b.manifest.launchAsset, url: at(b.manifest.launchAsset.key) },
    assets: b.manifest.assets.map(a => ({ ...a, url: at(a.key) })),
  };
}

const baseUrl = (req: FastifyRequest) => {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
};

export function registerAppUpdateRoutes(app: FastifyInstance, store: AppUpdates): void {
  app.get('/api/app/manifest', async (req, reply) => {
    const runtime = String(req.headers['expo-runtime-version'] ?? '').trim();
    const platform = String(req.headers['expo-platform'] ?? '').trim();
    if (!runtime || !platform) return reply.code(400).send({ error: 'An update check has to say which runtime version and platform it is for' });
    reply.header('expo-protocol-version', '1').header('expo-sfv-version', '0').header('cache-control', 'private, max-age=0');
    const b = store.latest(runtime, platform);
    // Nothing for this train is the ordinary case: the app keeps the bundle it has.
    if (!b) return reply.code(204).send();
    // The phone says what it runs; the same bundle again would only be downloaded and discarded.
    const current = String(req.headers['expo-current-update-id'] ?? '').trim().toLowerCase();
    if (current && current === b.manifest.id) return reply.code(204).send();
    const update = b.dir.split(/[\\/]/).pop()!;
    return reply.header('content-type', 'application/json').send(withUrls(b, baseUrl(req), update));
  });

  app.get<{ Params: { runtime: string; update: string; key: string }; Querystring: { platform?: string } }>('/api/app/assets/:runtime/:update/:key', async (req, reply) => {
    const { runtime, update, key } = req.params;
    for (const platform of ['ios', 'android']) {
      const b = store.find(runtime, update, platform);
      // The key picks a file the export listed; it never becomes a path itself.
      const rel = b?.files.get(key);
      if (!b || !rel) continue;
      const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1) : '';
      const type = b.manifest.launchAsset.key === key ? 'application/javascript' : b.manifest.assets.find(a => a.key === key)?.contentType ?? typeOf(ext);
      reply.header('cache-control', 'public, max-age=31536000, immutable').header('content-type', type);
      return reply.send(readFileSync(join(b.dir, rel)));
    }
    return reply.code(404).send({ error: 'No such asset' });
  });
}
