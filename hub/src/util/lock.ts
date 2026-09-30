import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * `<KOVA_DATA>/kova.lock`: says a hub (or a restore) is using this data folder.
 * The holder touches it every 30 s. A lock is live when it was touched in the
 * last 90 s and, on this machine, its process still exists. That rule survives
 * crashes (the lock goes stale on its own) and containers (where the pid
 * belongs to another namespace, so only the heartbeat counts).
 */
export const LOCK_FILE = 'kova.lock';
const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;

export interface LockInfo { pid: number; host: string; startedAt: number; what: string }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Who holds the data folder right now, or null if nobody does. */
export function lockHolder(dataDir: string, now = Date.now()): LockInfo | null {
  const file = join(dataDir, LOCK_FILE);
  if (!existsSync(file)) return null;
  let info: LockInfo;
  try { info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo; } catch { return null; }
  const fresh = now - statSync(file).mtimeMs < STALE_MS;
  if (!fresh) return null;
  if (info.host === hostname()) {
    // Our own pid on a lock older than this process: left over from before a restart (e.g. pid 1 in a container).
    const leftover = info.pid === process.pid && info.startedAt < Date.now() - process.uptime() * 1000;
    if (leftover || !alive(info.pid)) return null;
  }
  return info;
}

export interface HeldLock { release(): void }

/** Take the lock, or throw if another live process holds it (unless `force`, for a lock you know is left over). */
export function acquireLock(dataDir: string, what: 'hub' | 'restore', opts: { force?: boolean } = {}): HeldLock {
  mkdirSync(dataDir, { recursive: true });
  const holder = lockHolder(dataDir);
  if (holder && !opts.force) throw new LockedError(holder);
  const file = join(dataDir, LOCK_FILE);
  const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: Date.now(), what };
  writeFileSync(file, JSON.stringify(info) + '\n', { mode: 0o600 });
  const timer = setInterval(() => { try { const t = new Date(); utimesSync(file, t, t); } catch { /* folder gone */ } }, HEARTBEAT_MS);
  timer.unref();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        const cur = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
        if (cur.pid === info.pid && cur.startedAt === info.startedAt) rmSync(file, { force: true });
      } catch { /* already gone */ }
    },
  };
}

export class LockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(`The Kova data folder is in use by ${holder.what === 'restore' ? 'a restore' : 'a running hub'} (pid ${holder.pid} on ${holder.host}, since ${new Date(holder.startedAt).toISOString()})`);
  }
}
