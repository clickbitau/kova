import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync, chownSync, closeSync, constants, createReadStream, openSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { tarStream, untar, type TarSource } from '../util/tar.ts';
import { acquireLock } from '../util/lock.ts';
import { addDays, atLocal, localDate, zonedParts } from '../util/time.ts';
import type { NewLogEntry } from '../store/db.ts';

/**
 * Backups of everything a home can't get back by itself: the database (event
 * log, config, device state, assistant settings), integrations.json (device
 * keys), home.json, every pairing folder, the cloud sign-ins, the floor plan
 * and the hub's identity (hub-id and its licence). Restored onto a new machine,
 * it is the same hub. One `.tar.gz` per backup in `<KOVA_DATA>/backups/`,
 * owner-only, newest N kept. Left out on purpose: backups/ itself, loops/ and
 * frames/ (made again by themselves), and the updater's status and logs.
 */

/** Folders under KOVA_DATA that hold pairings and fabrics (losing them means re-pairing devices), and the owner's announcement clips. */
export const PAIRING_DIRS = ['homekit', 'homekit-controller', 'matter', 'matter-bridge', 'samsungtv', 'push', 'clips'] as const;
/** Cloud sign-ins and other state that would otherwise mean signing in or setting up again. */
export const STATE_DIRS = ['connectlife', 'ecovacs', 'smartthings', 'helix', 'photos', 'archive'] as const;
/**
 * The hub's identity: hub-id (its licence is issued for it), the key Helix uses to reach it, and the keys of
 * the home-network certificates phones already trust.
 */
export const DATA_FILES = ['integrations.json', 'home.json', 'hub-id', 'helix-link.json', 'tls-keys.json'] as const;
/** The updater's folder: only the licence is backed up, and a restore puts back only that file. */
const UPDATE_DIR = 'update';
const UPDATE_KEPT = ['licence.json'];
/** aircast's folder also holds logs; only its config is backed up. */
const AIRCAST_DIR = 'aircast';
const DB = 'kova.db';
const MANIFEST = 'manifest.json';
const FORMAT = 1;

/** Everything a restore may replace in the data folder. */
const RESTORABLE = new Set<string>([DB, ...DATA_FILES, ...PAIRING_DIRS, ...STATE_DIRS, AIRCAST_DIR, UPDATE_DIR]);
/** Always replaced, even when the backup doesn't have them (every backup has always covered these). */
const REPLACED = [DB, `${DB}-wal`, `${DB}-shm`, 'integrations.json', 'home.json', ...PAIRING_DIRS, AIRCAST_DIR];
/** Replaced only when the backup has them, so restoring an older backup doesn't take away what it never held. */
const REPLACED_IF_IN = [...DATA_FILES, ...STATE_DIRS].filter(n => !REPLACED.includes(n));

export const BACKUP_NAME = /^kova-backup-\d{8}-\d{6}(?:-\d+)?\.tar\.gz$/;

export interface BackupInfo { name: string; size: number; ts: number }

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => BACKUP_NAME.test(n)).map(name => {
    const st = statSync(join(dir, name));
    return { name, size: st.size, ts: Math.floor(st.mtimeMs) };
  }).sort((a, b) => b.ts - a.ts || b.name.localeCompare(a.name));
}

/** Delete all but the newest `keep` backups. Returns what was removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  const old = listBackups(dir).slice(Math.max(1, keep));
  for (const b of old) rmSync(join(dir, b.name), { force: true });
  return old.map(b => b.name);
}

function stampName(dir: string, now: number, tz: string): string {
  const p = zonedParts(now, tz);
  const two = (n: number) => String(n).padStart(2, '0');
  const base = `kova-backup-${p.y}${two(p.m)}${two(p.d)}-${two(p.h)}${two(p.mi)}${two(p.s)}`;
  let name = `${base}.tar.gz`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.tar.gz`;
  return name;
}

/** A consistent copy of a live database, as a single self-contained file. */
async function snapshotDb(db: DatabaseSync, dest: string): Promise<void> {
  if (typeof (sqlite as { backup?: unknown }).backup === 'function') {
    // SQLite's online backup API; rate -1 copies every page in one step, so the copy is one point in time.
    await sqlite.backup(db, dest, { rate: -1 });
  } else {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }
  const copy = new DatabaseSync(dest);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    const ok = (copy.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
    if (ok !== 'ok') throw new Error(`Database copy failed its check: ${ok}`);
  } finally { copy.close(); }
}

/** Whether this process can open a file for reading (a file left behind by root, say, it can't). */
export function canRead(path: string): boolean {
  try { closeSync(openSync(path, constants.O_RDONLY)); return true; } catch { return false; }
}

interface Walk { out: TarSource[]; skipped: string[]; readable: (path: string) => boolean }

/** A file or folder this process can't read is left out and named in `skipped`, rather than failing the backup. */
function walk(root: string, rel: string, w: Walk, filter: (name: string) => boolean = () => true): void {
  const abs = join(root, rel);
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (st.isDirectory()) {
    let names: string[];
    try { names = readdirSync(abs).sort(); } catch { w.skipped.push(rel); return; }
    w.out.push({ name: rel, type: 'dir', mode: 0o700, mtimeMs: st.mtimeMs });
    for (const n of names) walk(root, `${rel}/${n}`, w, filter);
  } else if (st.isFile() && filter(rel)) {
    if (!w.readable(abs)) { w.skipped.push(rel); return; }
    w.out.push({ name: rel, type: 'file', mode: 0o600, mtimeMs: st.mtimeMs, path: abs, size: st.size });
  }
  // Symlinks, sockets and the like are left out on purpose.
}

export interface CreateBackupOptions {
  /** The live database connection (or any connection to kova.db). */
  db: DatabaseSync;
  dataDir: string;
  /** Where backups go; defaults to `<dataDir>/backups`. */
  dir?: string;
  now?: number;
  /** For the file name, which uses the home's local time. */
  timezone?: string;
  version?: string;
  reason?: string;
  /** Whether a file can be read; for tests (root reads everything). */
  readable?: (path: string) => boolean;
}

/** Make one backup and return it. Doesn't prune. */
export async function createBackup(o: CreateBackupOptions): Promise<BackupInfo & { path: string; skipped: string[] }> {
  const dir = o.dir ?? join(o.dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const now = o.now ?? Date.now();
  const tz = o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = stampName(dir, now, tz);
  const stage = mkdtempSync(join(dir, '.stage-'));
  const partial = join(dir, `.${name}.partial`);
  try {
    const dbCopy = join(stage, DB);
    await snapshotDb(o.db, dbCopy);

    const entries: TarSource[] = [];
    const w: Walk = { out: entries, skipped: [], readable: o.readable ?? canRead };
    const included: string[] = [DB];
    const dbSt = statSync(dbCopy);
    entries.push({ name: DB, type: 'file', mode: 0o600, mtimeMs: dbSt.mtimeMs, path: dbCopy, size: dbSt.size });
    for (const f of DATA_FILES) {
      const before = entries.length;
      walk(o.dataDir, f, w);
      if (entries.length > before) included.push(f);
    }
    for (const d of [...PAIRING_DIRS, ...STATE_DIRS]) {
      const before = entries.length;
      walk(o.dataDir, d, w);
      if (entries.length > before) included.push(d);
    }
    let before = entries.length;
    walk(o.dataDir, AIRCAST_DIR, w, rel => rel.endsWith('.xml'));
    if (entries.length > before) included.push(AIRCAST_DIR);
    before = entries.length;
    walk(o.dataDir, UPDATE_DIR, w, rel => UPDATE_KEPT.some(f => rel === `${UPDATE_DIR}/${f}`));
    if (entries.length > before) included.push(UPDATE_DIR);

    const manifest = Buffer.from(JSON.stringify({ format: FORMAT, app: 'kova', version: o.version ?? null, createdAt: new Date(now).toISOString(), reason: o.reason ?? null, contents: included, ...(w.skipped.length ? { skipped: w.skipped } : {}) }, null, 2) + '\n');
    entries.unshift({ name: MANIFEST, type: 'file', mode: 0o600, mtimeMs: now, data: manifest });

    await pipeline(Readable.from(tarStream(entries)), createGzip({ level: 6 }), createWriteStream(partial, { mode: 0o600 }));
    chmodSync(partial, 0o600);
    const final = join(dir, name);
    renameSync(partial, final);
    const st = statSync(final);
    return { name, size: st.size, ts: Math.floor(st.mtimeMs), path: final, skipped: w.skipped };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(partial, { force: true });
  }
}

/** "HH:MM" → hour as a float; "off" / "" → null. */
export function parseBackupTime(s: string | undefined, fallback = '03:10'): number | null {
  const v = (s ?? fallback).trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`KOVA_BACKUP_TIME must be HH:MM or "off", not "${s}"`);
  return +m[1] + +m[2] / 60;
}

/** Next instant after `now` at which the home's wall clock reads `hour`. */
export function nextRun(now: number, hour: number, tz: string): number {
  const today = localDate(now, tz);
  const t = atLocal(today, hour, tz);
  return t > now ? t : atLocal(addDays(today, 1), hour, tz);
}

export interface BackupsOptions {
  db: DatabaseSync;
  dataDir: string;
  dir?: string;
  /** Hour of day (home time) for the nightly backup; null turns it off. */
  hour?: number | null;
  keep?: number;
  timezone: () => string;
  now?: () => number;
  version?: string;
  /** Writes to the Activity feed. */
  log?: (e: NewLogEntry) => void;
  /** Called before each backup (the hub flushes device state here). */
  beforeBackup?: () => void;
  /** Called after each backup, so the UI refreshes. */
  onChange?: () => void;
  /** How often to check whether the nightly backup is due. */
  checkMs?: number;
  /** Whether a file can be read; for tests. */
  readable?: (path: string) => boolean;
}

/** "tls-keys.json", "a, b and c", "a, b and 3 more". */
function listWords(items: string[]): string {
  const shown = items.length > 3 ? [...items.slice(0, 2), `${items.length - 2} more`] : items;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
}

/** The nightly schedule, retention and status for the Integrations screen. */
export class Backups {
  readonly dir: string;
  readonly keep: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupInfo> | null = null;
  private lastError: { ts: number; error: string } | null = null;
  /** What the last backup couldn't read (and so left out). */
  private lastSkipped: string[] = [];
  nextAt: number | null = null;

  constructor(private o: BackupsOptions) {
    this.dir = o.dir ?? join(o.dataDir, 'backups');
    this.keep = Math.max(1, o.keep ?? 14);
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }

  start(): void {
    const hour = this.o.hour === undefined ? 3 + 10 / 60 : this.o.hour;
    if (hour === null) return;
    this.nextAt = nextRun(this.now(), hour, this.o.timezone());
    // Checked on an interval rather than one long timeout so clock changes and sleep don't skip a night.
    this.timer = setInterval(() => {
      const now = this.now();
      if (this.nextAt === null || now < this.nextAt) return;
      this.nextAt = nextRun(now, hour, this.o.timezone());
      this.run('nightly').catch(() => { /* logged in run() */ });
    }, this.o.checkMs ?? 30_000);
    this.timer.unref();
  }

  /** Stop the schedule and wait for a backup in progress. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.running?.catch(() => {});
  }

  list(): BackupInfo[] { return listBackups(this.dir); }

  /** Path of a backup by name, or null if the name isn't one of ours. */
  file(name: string): string | null {
    if (!BACKUP_NAME.test(name)) return null;
    const p = join(this.dir, name);
    return existsSync(p) ? p : null;
  }

  /** Make a backup now. Concurrent calls share the one in progress. */
  run(reason: 'nightly' | 'manual' = 'manual'): Promise<BackupInfo> {
    if (this.running) return this.running;
    const p = (async () => {
      const started = this.now();
      try {
        this.o.beforeBackup?.();
        const b = await createBackup({ db: this.o.db, dataDir: this.o.dataDir, dir: this.dir, now: started, timezone: this.o.timezone(), version: this.o.version, reason, readable: this.o.readable });
        const pruned = pruneBackups(this.dir, this.keep);
        this.lastError = null;
        this.lastSkipped = b.skipped;
        this.o.log?.({
          kind: 'system', device: null, feed: 'system',
          what: `${reason === 'nightly' ? 'Nightly backup' : 'Backup'} finished · ${formatSize(b.size)}${b.skipped.length ? ` · couldn’t read ${listWords(b.skipped)}` : ''}`,
          data: { backup: b.name, size: b.size, pruned, ...(b.skipped.length ? { skipped: b.skipped } : {}) }, cause: { kind: 'system', label: 'Kova system' },
        });
        return { name: b.name, size: b.size, ts: b.ts };
      } catch (err) {
        this.lastError = { ts: this.now(), error: err instanceof Error ? err.message : String(err) };
        this.o.log?.({
          kind: 'system', device: null, feed: 'system', what: `${reason === 'nightly' ? 'Nightly backup' : 'Backup'} failed`,
          data: { backup: null, error: this.lastError.error }, cause: { kind: 'system', label: 'Kova system' },
        });
        throw err;
      } finally {
        this.running = null;
        this.o.onChange?.();
      }
    })();
    this.running = p;
    return p;
  }

  /** For the Integrations screen. */
  status(): { ok: boolean; note: string } {
    const tz = this.o.timezone();
    const when = (ts: number) => {
      const today = localDate(this.now(), tz);
      const d = localDate(ts, tz);
      const p = zonedParts(ts, tz);
      const hm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
      if (d === today) return `today ${hm}`;
      if (d === addDays(today, -1)) return `yesterday ${hm}`;
      return `${d} ${hm}`;
    };
    const last = this.list()[0];
    if (this.lastError && (!last || this.lastError.ts >= last.ts)) return { ok: false, note: `Last backup failed: ${this.lastError.error}` };
    const sched = this.nextAt === null ? 'nightly backups off' : `next ${when(this.nextAt)}`;
    if (!last) return { ok: true, note: `No backup yet · ${sched}` };
    const stale = this.nextAt !== null && this.now() - last.ts > 36 * 3600_000;
    // Something the hub can't read (a file root left behind, say) is missing from the backup: say so, so it gets fixed.
    const missing = this.lastSkipped.length ? ` · couldn’t read ${listWords(this.lastSkipped)}, so it’s not in the backup` : '';
    return { ok: !stale && !missing, note: `Last backup ${when(last.ts)} · ${formatSize(last.size)}${missing} · keeping ${this.keep} · ${sched}` };
  }
}

// ------------------------------------------------------------- restore --

export interface RestoreResult {
  /** Top-level items put back into the data folder. */
  restored: string[];
  /** Where the replaced files went (so a restore can itself be undone). */
  aside: string | null;
  manifest: { format: number; version: string | null; createdAt: string; contents: string[] };
}

function safeName(name: string): string {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new Error(`Refusing unsafe path in backup: ${JSON.stringify(name)}`);
  const parts = name.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error(`Refusing unsafe path in backup: ${JSON.stringify(name)}`);
  if (parts[0] !== MANIFEST && !RESTORABLE.has(parts[0])) throw new Error(`Unexpected item in backup: ${JSON.stringify(parts[0])}`);
  if ((parts[0] === MANIFEST || parts[0] === DB || (DATA_FILES as readonly string[]).includes(parts[0])) && parts.length > 1) throw new Error(`Unexpected item in backup: ${JSON.stringify(name)}`);
  if (parts[0] === UPDATE_DIR && parts.length > 1 && (parts.length > 2 || !UPDATE_KEPT.includes(parts[1]))) throw new Error(`Unexpected item in backup: ${JSON.stringify(name)}`);
  return name;
}

function chownTree(path: string, uid: number, gid: number): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chownSync(path, uid, gid);
  if (st.isDirectory()) for (const n of readdirSync(path)) chownTree(join(path, n), uid, gid);
}

/**
 * Put a backup back into a data folder. The hub must not be running (checked
 * with the lock file). Everything is unpacked and checked in a staging folder
 * first; only then are the current files moved aside (into
 * `.pre-restore-<time>/`) and the restored ones renamed into place, each
 * rename atomic. If anything fails part-way, the moves are undone.
 */
export async function restoreBackup(archive: string, dataDir: string, opts: { force?: boolean } = {}): Promise<RestoreResult> {
  if (!existsSync(archive)) throw new Error(`No such backup: ${archive}`);
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireLock(dataDir, 'restore', opts);
  const stage = mkdtempSync(join(dataDir, '.restore-'));
  try {
    // 1. Unpack into the staging folder, refusing anything outside the allowlist.
    let manifest: RestoreResult['manifest'] | undefined;
    const src = createReadStream(archive).pipe(createGunzip());
    for await (const e of untar(src as AsyncIterable<Buffer>)) {
      const name = safeName(e.name);
      const dest = join(stage, name);
      if (e.type === 'dir') { mkdirSync(dest, { recursive: true, mode: 0o700 }); continue; }
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, e.data, { mode: 0o600 });
      if (name === MANIFEST) manifest = JSON.parse(e.data.toString('utf8'));
    }
    if (!manifest || manifest.format !== FORMAT) throw new Error('Not a Kova backup (missing or unknown manifest.json)');
    if (!existsSync(join(stage, DB))) throw new Error('Backup has no kova.db');

    // 2. Check the database before touching anything.
    const check = new DatabaseSync(join(stage, DB));
    try {
      const r = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (r !== 'ok') throw new Error(`kova.db in the backup is damaged: ${r}`);
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name);
      if (!tables.includes('events') || !tables.includes('kv')) throw new Error('kova.db in the backup is not a Kova database');
    } finally { check.close(); }
    rmSync(join(stage, MANIFEST), { force: true });
    rmSync(join(stage, `${DB}-journal`), { force: true });

    // 3. Swap: current items aside, restored items in.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = join(dataDir, `.pre-restore-${stamp}`);
    const movedOut: string[] = [];
    const movedIn: string[] = [];
    const incoming = readdirSync(stage);
    // The updater's folder keeps its status and logs: only the files a backup holds go in (update/licence.json).
    const inUpdate = incoming.includes(UPDATE_DIR) ? readdirSync(join(stage, UPDATE_DIR)).map(f => `${UPDATE_DIR}/${f}`) : [];
    const swapIn = [...incoming.filter(n => n !== UPDATE_DIR), ...inUpdate];
    const swapOut = [...REPLACED, ...REPLACED_IF_IN.filter(n => incoming.includes(n)), ...inUpdate];
    try {
      for (const n of swapOut) {
        if (!existsSync(join(dataDir, n))) continue;
        mkdirSync(dirname(join(aside, n)), { recursive: true, mode: 0o700 });
        renameSync(join(dataDir, n), join(aside, n));
        movedOut.push(n);
      }
      if (inUpdate.length) mkdirSync(join(dataDir, UPDATE_DIR), { recursive: true, mode: 0o700 });
      for (const n of swapIn) {
        renameSync(join(stage, n), join(dataDir, n));
        movedIn.push(n);
      }
    } catch (err) {
      for (const n of movedIn) rmSync(join(dataDir, n), { recursive: true, force: true });
      for (const n of movedOut) renameSync(join(aside, n), join(dataDir, n));
      if (movedOut.length) rmSync(aside, { recursive: true, force: true });
      throw err;
    }

    // Run as root (e.g. from the installer's shell)? Give the files to whoever owns the data folder.
    if (process.getuid?.() === 0) {
      const { uid, gid } = statSync(dataDir);
      try {
        if (uid !== 0 || gid !== 0) for (const n of incoming) chownTree(join(dataDir, n), uid, gid);
      } catch (err) { console.warn(`Restored, but couldn't hand the files to uid ${uid}: ${String(err)}`); }
    }
    return { restored: incoming, aside: movedOut.length ? aside : null, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    lock.release();
  }
}
