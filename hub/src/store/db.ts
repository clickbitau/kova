import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cause } from '../model/types.ts';

/**
 * Activity categories, matching the Activity screen filters.
 * auto = modes, moments, overlays, behaviours; people = presence; device = direct
 * changes; system = hub and integration events.
 */
export type FeedType = 'auto' | 'people' | 'device' | 'system';

export interface LogEntry {
  id: number;
  ts: number;
  /** state | mode | run | presence | device_event | system | skip */
  kind: string;
  device: string | null;
  /** Shown in the activity feed when set. */
  feed: FeedType | null;
  what: string;
  data: Record<string, unknown>;
  cause: Cause;
}

export type NewLogEntry = Omit<LogEntry, 'id' | 'ts'> & { ts?: number };

/** The hub's single SQLite file: the event log plus a small key/value store. */
export class Store {
  readonly db: DatabaseSync;
  /** How many entries of each kind were added since the hub started: a cheap "has this changed?" for caches. */
  private added = new Map<string, number>();

  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device TEXT,
        feed TEXT,
        what TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        cause TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_device ON events(device, ts);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind, ts);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  append(e: NewLogEntry): LogEntry {
    const ts = e.ts ?? this.now();
    const r = this.db.prepare('INSERT INTO events (ts, kind, device, feed, what, data, cause) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ts, e.kind, e.device, e.feed, e.what, JSON.stringify(e.data), JSON.stringify(e.cause));
    this.added.set(e.kind, (this.added.get(e.kind) ?? 0) + 1);
    return { ...e, ts, id: Number(r.lastInsertRowid) };
  }

  private rows(sql: string, ...args: (string | number | null)[]): LogEntry[] {
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(r => ({
      id: r.id as number, ts: r.ts as number, kind: r.kind as string, device: r.device as string | null,
      feed: r.feed as FeedType | null, what: r.what as string,
      data: JSON.parse(r.data as string), cause: JSON.parse(r.cause as string),
    }));
  }

  /** Most recent feed entries, newest first. */
  feed(limit = 50): LogEntry[] {
    return this.rows('SELECT * FROM events WHERE feed IS NOT NULL ORDER BY ts DESC, id DESC LIMIT ?', limit);
  }

  /** Last state change for a device. */
  lastStateChange(device: string): LogEntry | undefined {
    return this.rows("SELECT * FROM events WHERE kind = 'state' AND device = ? ORDER BY ts DESC, id DESC LIMIT 1", device)[0];
  }

  /** Entries of this kind added since the hub started (changes whenever one is). */
  addedOf(kind: string): number { return this.added.get(kind) ?? 0; }

  between(from: number, to: number, kind?: string): LogEntry[] {
    return kind
      ? this.rows('SELECT * FROM events WHERE ts >= ? AND ts < ? AND kind = ? ORDER BY ts, id', from, to, kind)
      : this.rows('SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts, id', from, to);
  }

  /** Last entry of a kind before an instant (e.g. presence before a mode started). */
  lastBefore(kind: string, ts: number, device?: string): LogEntry | undefined {
    return device
      ? this.rows('SELECT * FROM events WHERE kind = ? AND device = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1', kind, device, ts)[0]
      : this.rows('SELECT * FROM events WHERE kind = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1', kind, ts)[0];
  }

  firstTs(): number | undefined {
    const r = this.db.prepare('SELECT MIN(ts) AS t FROM events').get() as { t: number | null };
    return r.t ?? undefined;
  }

  get<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) as T : undefined;
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  close(): void { this.db.close(); }
}
