import { createDecipheriv, createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// Getting Home Assistant's configuration into Kova, without Home Assistant running:
//  - a backup file from Settings → System → Backups (a .tar holding homeassistant.tar.gz,
//    which is encrypted with the backup's encryption key since HA 2025.1), or
//  - a tar / tar.gz of the config folder, or
//  - the config folder itself (or its .storage folder) on the machine Kova runs on.
// Only the handful of files the importer needs are kept; the history database and
// everything else is streamed past without being stored.

/** Registries and settings under .storage/ that the importer reads. */
export const STORAGE_FILES = [
  'core.config_entries', 'core.device_registry', 'core.area_registry', 'core.entity_registry',
  'core.config', 'core.restore_state', 'person', 'application_credentials',
] as const;
/** Files at the top of the config folder. */
export const CONFIG_FILES = ['automations.yaml', 'scripts.yaml', 'scenes.yaml', '.HA_VERSION'] as const;
const MAX_FILE = 32 * 1024 * 1024;

export interface HaFiles {
  storage: Record<string, Buffer>;
  config: Record<string, Buffer>;
  /** From backup.json, when the source was a Home Assistant backup. */
  backup?: { name?: string; date?: string; haVersion?: string; protected?: boolean };
}

export class ImportError extends Error {
  constructor(message: string, readonly code: 'needs-key' | 'wrong-key' | 'not-ha' | 'bad-archive' | 'not-found') { super(message); }
}

// ------------------------------------------------------------ streaming bytes --

class Bytes {
  private buf = Buffer.alloc(0);
  private done = false;
  constructor(private it: AsyncIterator<Buffer>) {}
  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(r.value)]) : Buffer.from(r.value);
    }
    return this.buf.length >= n;
  }
  async read(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Up to n bytes, as they arrive, without holding them all. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length && !(await this.fill(1))) throw new ImportError('The file ends too early: is the upload complete?', 'bad-archive');
      const c = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(c.length);
      left -= c.length;
      yield c;
    }
  }
  async peek(n: number): Promise<Buffer> { await this.fill(n); return this.buf.subarray(0, n); }
  /** Everything that's left. */
  async *rest(): AsyncGenerator<Buffer> {
    if (this.buf.length) { yield this.buf; this.buf = Buffer.alloc(0); }
    for (;;) { const r = await this.it.next(); if (r.done) return; yield Buffer.from(r.value); }
  }
}

const cstr = (b: Buffer, off: number, len: number) => { const s = b.subarray(off, off + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
const oct = (b: Buffer, off: number, len: number) => {
  // Big sizes use base-256 (high bit set), as Python's tarfile writes them for files over 8 GB.
  if (b[off] & 0x80) { let v = 0; for (let i = 1; i < len; i++) v = v * 256 + b[off + i]; return v; }
  return parseInt(cstr(b, off, len).trim() || '0', 8);
};

/**
 * Walk a tar stream. For each regular file, `onFile` gets its path, size and a stream of its bytes;
 * whatever it doesn't read is skipped. Handles GNU long names and PAX headers.
 */
async function walkTar(src: AsyncIterable<Buffer>, onFile: (name: string, size: number, body: AsyncGenerator<Buffer>) => Promise<void>): Promise<number> {
  const r = new Bytes(src[Symbol.asyncIterator]());
  let longName: string | undefined, files = 0;
  for (;;) {
    const h = await r.read(512);
    if (!h || h.every(x => x === 0)) return files;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== oct(h, 148, 8)) {
      if (files === 0) throw new ImportError('That isn’t a Home Assistant backup or a tar archive.', 'not-ha');
      throw new ImportError('The archive is damaged (bad tar header).', 'bad-archive');
    }
    const size = oct(h, 124, 12), type = String.fromCharCode(h[156] || 48);
    const padded = size + ((512 - (size % 512)) % 512);
    if (type === 'L' || type === 'x') {
      const meta = Buffer.concat(await collect(r.take(padded))).subarray(0, size);
      if (type === 'L') longName = cstr(meta, 0, meta.length);
      else for (const m of meta.toString('utf8').matchAll(/^\d+ path=(.*)$/gm)) longName = m[1];
      continue;
    }
    const prefix = cstr(h, 345, 155);
    const name = (longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))).replace(/^\.\//, '');
    longName = undefined;
    const body = r.take(size);
    if (type === '0' || type === '\0') { files++; await onFile(name, size, body); }
    for await (const _ of body) { /* skip what wasn't read */ }
    const pad = padded - size;
    if (pad) for await (const _ of r.take(pad)) { /* padding */ }
  }
}

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer[]> { const out: Buffer[] = []; for await (const c of it) out.push(c); return out; }

/** Transparently gunzip a stream that starts with the gzip magic. */
async function* maybeGunzip(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const r = new Bytes(src[Symbol.asyncIterator]());
  const head = await r.peek(2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const gz = Readable.from(r.rest()).pipe(createGunzip());
    try { for await (const c of gz) yield c as Buffer; } catch (e) { throw new ImportError(`The archive is damaged: ${e instanceof Error ? e.message : e}`, 'bad-archive'); }
  } else yield* r.rest();
}

// ------------------------------------------------------ encrypted backups --

// Home Assistant encrypts the inside of a backup with SecureTar: AES-128-CBC over the gzip'd tar.
// The key is SHA-256 of the backup's encryption key, repeated 100 times, first 16 bytes; the IV is
// SHA-256 of key + a 16-byte salt from the file, also 100 times. Version 2 files start with a
// "SecureTar" header before the salt. Rather than trust one layout, try each and keep the one
// whose first block decrypts to a gzip header.
const sha100 = (b: Buffer) => { let x = b; for (let i = 0; i < 100; i++) x = createHash('sha256').update(x).digest(); return x.subarray(0, 16); };
export const secureTarKey = (password: string) => sha100(Buffer.from(password, 'utf8'));

async function* decryptSecureTar(src: AsyncIterable<Buffer>, password: string): AsyncGenerator<Buffer> {
  const r = new Bytes(src[Symbol.asyncIterator]());
  const head = Buffer.from(await r.peek(96));
  const magic = head.subarray(0, 9).toString('latin1') === 'SecureTar';
  const layouts = magic ? [32, 16] : [0];
  const keys = [...new Set([password, password.replace(/[-\s]/g, ''), password.trim()])].filter(Boolean).map(secureTarKey);
  for (const saltAt of layouts) {
    const salt = head.subarray(saltAt, saltAt + 16), first = head.subarray(saltAt + 16, saltAt + 32);
    if (first.length < 16) continue;
    for (const key of keys) {
      const iv = sha100(Buffer.concat([key, salt]));
      const d = createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
      const block = d.update(first);
      if (block[0] !== 0x1f || block[1] !== 0x8b) continue;
      await r.read(saltAt + 16);
      const decipher = createDecipheriv('aes-128-cbc', key, iv);
      yield* Readable.from(r.rest()).pipe(decipher) as AsyncIterable<Buffer>;
      return;
    }
  }
  throw new ImportError(magic || keys.length ? 'That encryption key doesn’t open this backup.' : 'This backup is encrypted.', 'wrong-key');
}

// ------------------------------------------------------------------ public --

/** Which kept file a path inside an archive is, if any. */
function classify(path: string): { kind: 'storage' | 'config'; name: string } | null {
  const parts = path.split('/').filter(p => p && p !== '.');
  const base = parts[parts.length - 1];
  if (parts.length >= 2 && parts[parts.length - 2] === '.storage' && (STORAGE_FILES as readonly string[]).includes(base)) return { kind: 'storage', name: base };
  // Config files only at the top of the config folder (optionally under data/ or homeassistant/ or config/).
  const top = parts.filter(p => !['data', 'homeassistant', 'config'].includes(p));
  if (top.length === 1 && (CONFIG_FILES as readonly string[]).includes(base)) return { kind: 'config', name: base };
  return null;
}

/**
 * Read a Home Assistant backup (or a tar / tar.gz of the config folder) from a stream.
 * `key` is the backup's encryption key, needed for encrypted backups.
 */
export async function readHaArchive(src: AsyncIterable<Buffer>, key?: string): Promise<HaFiles> {
  const out: HaFiles = { storage: {}, config: {} };
  const keep = async (path: string, size: number, body: AsyncGenerator<Buffer>) => {
    const c = classify(path);
    if (!c || size > MAX_FILE) return;
    out[c.kind][c.name] = Buffer.concat(await collect(body));
  };
  let inner = false;
  await walkTar(maybeGunzip(src), async (name, size, body) => {
    const base = basename(name);
    if (base === 'backup.json' && size < 1_000_000) {
      try {
        const j = JSON.parse(Buffer.concat(await collect(body)).toString('utf8'));
        out.backup = { name: j.name, date: j.date, haVersion: j.homeassistant?.version ?? j.homeassistant_version, protected: !!j.protected };
      } catch { /* not a backup manifest */ }
      return;
    }
    if (/^homeassistant\.tar(\.gz)?$/.test(base)) {
      inner = true;
      // The bytes decide: gzip or a plain tar is readable as is; anything else is SecureTar.
      const r = new Bytes(body);
      const head = await r.peek(512);
      const isGzip = head[0] === 0x1f && head[1] === 0x8b;
      const isTar = head.subarray(257, 262).toString('latin1') === 'ustar';
      let stream: AsyncIterable<Buffer> = r.rest();
      if (!isGzip && !isTar) {
        if (!key) throw new ImportError('This backup is encrypted. Enter its encryption key (Settings → System → Backups → the ⋮ menu → Show encryption key).', 'needs-key');
        stream = decryptSecureTar(stream, key);
      }
      const plain = maybeGunzip(stream);
      await walkTar(plain, keep);
      // The inner tar ends before its stream does (padding); drain it so the outer archive stays in step.
      for await (const _ of plain) { /* rest of the inner archive */ }
      return;
    }
    await keep(name, size, body);
  });
  if (!Object.keys(out.storage).length) {
    throw new ImportError(inner ? 'The backup doesn’t contain Home Assistant’s .storage folder. Make a backup that includes Home Assistant settings.' : 'No Home Assistant configuration found in that file.', 'not-ha');
  }
  return out;
}

/** Read the files from a Home Assistant config folder (or its .storage folder) on this machine. */
export function readHaFolder(dir: string): HaFiles {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ImportError(`${dir} isn’t a folder on the hub.`, 'not-found');
  const storageDir = existsSync(join(dir, '.storage')) ? join(dir, '.storage') : basename(dir) === '.storage' ? dir : null;
  if (!storageDir) throw new ImportError(`No .storage folder in ${dir}. Point Kova at Home Assistant’s config folder.`, 'not-ha');
  const configDir = storageDir === dir ? join(dir, '..') : dir;
  const out: HaFiles = { storage: {}, config: {} };
  for (const f of STORAGE_FILES) { const p = join(storageDir, f); if (existsSync(p) && statSync(p).size <= MAX_FILE) out.storage[f] = readFileSync(p); }
  for (const f of CONFIG_FILES) { const p = join(configDir, f); if (existsSync(p) && statSync(p).size <= MAX_FILE) out.config[f] = readFileSync(p); }
  if (!out.storage['core.config_entries']) throw new ImportError(`${storageDir} has no core.config_entries: is it Home Assistant’s?`, 'not-ha');
  return out;
}
