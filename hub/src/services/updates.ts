import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hub } from '../hub.ts';
import { KOVA_COMMIT, KOVA_VERSION } from '../version.ts';
import { isPlayer } from '../util/describe.ts';
import { Catalog } from './release-client.ts';
import { localDate, localHour } from '../util/time.ts';

/**
 * Updating the hub itself. The hub runs as the unprivileged `kova` user, so it can't update itself: a small
 * updater runs as root on the box (deploy/updater.sh, installed by install.sh and update.sh as systemd units).
 *
 * - The updater looks for a newer Kova every 6 hours (kova-update-check.timer) and writes what it found to
 *   <KOVA_DATA>/update/status.json, which this reads. Releases come from ClickBit's catalog with the licence's
 *   device token (services/release-client.ts; the licence key is entered here and kept in update/licence.json for
 *   the updater); a git checkout without a licence still updates from git while boxes move over.
 * - Check now / Update: this writes "check" or "apply" to <KOVA_DATA>/update/request; kova-update.path sees it and
 *   runs the updater, which backs up, pulls, restarts Kova, and goes back to the old version (and the backup) by
 *   itself when the new one doesn't come up healthy.
 * - Overnight updates (off by default): at the hour set, when an update is waiting and nothing is playing.
 * - It says so: a notification when a new version is out (overnight updates off), and after an update, that it
 *   worked or was undone. Each result is kept (the last 20), for Settings → Software update's history.
 */
export interface UpdateStatus {
  /** The updater is installed and has run at least once. */
  updater: boolean;
  state: 'idle' | 'checking' | 'updating' | 'requested';
  /** Where updates come from: ClickBit's release catalog, or (while boxes move over) git. */
  source: 'release' | 'git' | null;
  /** Not an error, but why nothing is offered (no licence yet; a release that was undone here). */
  note: string | null;
  licence: ReturnType<Catalog['licenceView']>;
  current: { version: string; commit?: string };
  available: { version: string; commit: string; behind: number; changes: string[] } | null;
  checkedAt: number | null;
  checkError: string | null;
  last: { result: 'updated' | 'rolled-back' | 'failed'; from: string; to: string; at: number; log?: string[] } | null;
  /** Every update this hub has seen, newest first (the last 20). */
  history: UpdateRecord[];
  /** While it updates: where it is, read from the updater's log as it goes. Null otherwise. */
  progress: UpdateProgress | null;
  auto: { on: boolean; hour: number };
}

export interface UpdateProgress {
  /** The step now (0-based), of `steps`. */
  step: number;
  steps: string[];
  /** The step now, in words ("Backing up your home"); while it goes back, what it's doing. */
  label: string;
  startedAt: number | null;
  /** The new version didn't come up: it's going back to the one before. */
  rollingBack: boolean;
}

/** An update's steps, as Software update shows them. */
export const UPDATE_STEPS = ['Downloading', 'Unpacking and checking', 'Backing up your home', 'Restarting Kova', 'Making sure it started properly'];

/**
 * Where an update is, from the updater's log (deploy/updater.sh, install-release.sh, update.sh write "==> …" steps).
 * `running` is the version this hub runs: once it's the new one, the restart is behind it.
 */
export function progressOf(log: string, o: { startedAt?: number | null; running?: string; to?: string | null } = {}): UpdateProgress {
  let step = 0, rollingBack = false, label = '';
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m = /==>\s*(.*)$/.exec(line);
    if (!m) continue;
    const t = m[1]!;
    if (/^Downloading|^Pulling/.test(t)) step = Math.max(step, 0);
    else if (/^Unpacking|^Installing dependencies/.test(t)) step = Math.max(step, 1);
    else if (/^Backing up/.test(t)) step = Math.max(step, 2);
    else if (/^Switching|^Restarting/.test(t)) step = Math.max(step, 3);
    else if (/is up$/.test(t)) step = 4;
    else if (/didn.t come (up|back)|going back/i.test(t)) { rollingBack = true; label = 'It didn’t start properly: going back to the version before'; }
    else if (/^Restoring/.test(t) && rollingBack) label = 'Putting your data back as it was';
  }
  // This is the new version answering: the restart is done, the updater is checking it.
  if (!rollingBack && o.to && o.running === o.to) step = Math.max(step, 4);
  return { step, steps: UPDATE_STEPS, label: label || UPDATE_STEPS[step]!, startedAt: o.startedAt ?? null, rollingBack };
}

export interface UpdateRecord { result: 'updated' | 'rolled-back' | 'failed'; from: string; to: string; at: number }

/** Where an update notification opens: Settings, where Software update is. */
export const UPDATE_URL = '/phone.html?page=settings';
const HISTORY_MAX = 20;

interface Raw {
  updater?: number; state?: string; source?: string; soft?: string | null; checkedAt?: number; checkError?: string[] | null;
  current?: { version: string; commit: string };
  available?: UpdateStatus['available'];
  last?: UpdateStatus['last'];
  startedAt?: number;
}

type Notify = (n: { title: string; body: string; tag: string; url?: string }) => Promise<unknown>;

export class Updates {
  private dir: string;
  private timer: NodeJS.Timeout | null = null;
  private lastAutoDay = '';

  readonly catalog: Catalog;

  constructor(private hub: Hub, private o: { dataDir: string; notify?: Notify; now?: () => number; everyMs?: number; catalog?: { url?: string; channel?: string; product?: string; fetch?: typeof fetch; pubkey?: string } }) {
    this.dir = join(o.dataDir, 'update');
    this.catalog = new Catalog({ ...o.catalog, version: KOVA_VERSION, dir: this.dir, hubIdFile: join(o.dataDir, 'hub-id'), now: o.now });
  }

  /** Install the licence key: activated with ClickBit now, so a wrong key is said here, then the updater checks. */
  async setLicence(key: string): Promise<UpdateStatus> {
    if (!key.trim()) throw new Error('Enter the licence key');
    await this.catalog.activate(key);
    try { this.request('check'); } catch { /* no updater yet: the status says so */ }
    this.hub.emit('changed');
    return this.status();
  }

  forgetLicence(): UpdateStatus {
    this.catalog.forget();
    this.hub.emit('changed');
    return this.status();
  }

  private get now() { return this.o.now?.() ?? Date.now(); }

  private raw(): Raw | null {
    try { return JSON.parse(readFileSync(join(this.dir, 'status.json'), 'utf8')) as Raw; } catch { return null; }
  }

  private requested(): string | null {
    try { return readFileSync(join(this.dir, 'request'), 'utf8').trim() || null; } catch { return null; }
  }

  autoSettings(): UpdateStatus['auto'] {
    const a = this.hub.store.get<{ on?: boolean; hour?: number }>('autoUpdate') ?? {};
    return { on: !!a.on, hour: Number.isInteger(a.hour) && a.hour! >= 0 && a.hour! < 24 ? a.hour! : 3 };
  }

  setAuto(a: { on?: boolean; hour?: number }): UpdateStatus['auto'] {
    const cur = this.autoSettings();
    if (a.hour !== undefined && !(Number.isInteger(a.hour) && a.hour >= 0 && a.hour < 24)) throw new Error('hour must be 0–23');
    const next = { on: a.on ?? cur.on, hour: a.hour ?? cur.hour };
    this.hub.store.set('autoUpdate', next);
    this.hub.emit('changed');
    return next;
  }

  /** Results kept so far, with the updater's latest added when it isn't yet. */
  private history(last: UpdateStatus['last']): UpdateRecord[] {
    const kept = this.hub.store.get<UpdateRecord[]>('updateHistory') ?? [];
    if (!last || kept.some(h => h.at === last.at)) return kept;
    return [{ result: last.result, from: last.from, to: last.to, at: last.at }, ...kept].sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX);
  }

  /** Keep the updater's latest result in the history. */
  private remember(last: UpdateStatus['last']): void {
    if (!last) return;
    const kept = this.hub.store.get<UpdateRecord[]>('updateHistory') ?? [];
    if (kept.some(h => h.at === last.at)) return;
    this.hub.store.set('updateHistory', this.history(last));
  }

  status(): UpdateStatus {
    const r = this.raw();
    const req = this.requested();
    const updating = !req && r?.state === 'updating';
    let log = '';
    if (updating) { try { log = readFileSync(join(this.dir, 'last-update.log'), 'utf8').slice(-20_000); } catch { /* not yet */ } }
    return {
      updater: !!r?.updater,
      state: req ? 'requested' : (r?.state === 'checking' || r?.state === 'updating' ? r.state : 'idle'),
      source: r?.source === 'release' || r?.source === 'git' ? r.source : null,
      note: r?.soft ?? null,
      licence: this.catalog.licenceView(),
      // The running code's version; the updater's commit when it describes this version.
      current: { version: KOVA_VERSION, ...(r?.current?.version === KOVA_VERSION && r.current.commit ? { commit: r.current.commit } : KOVA_COMMIT ? { commit: KOVA_COMMIT.slice(0, 7) } : {}) },
      available: r?.available && r.available.version !== undefined && (r.available.behind ?? 0) > 0 ? r.available : null,
      checkedAt: r?.checkedAt ?? null,
      checkError: r?.checkError?.length ? r.checkError.join(' ').slice(0, 300) : null,
      last: r?.last ?? null,
      history: this.history(r?.last ?? null),
      progress: updating ? progressOf(log, { startedAt: r?.startedAt ?? null, running: KOVA_VERSION, to: r?.available?.version ?? null }) : null,
      auto: this.autoSettings(),
    };
  }

  /** Ask the updater (root, outside the hub) to look for a newer Kova, or to update. */
  request(what: 'check' | 'apply'): UpdateStatus {
    const st = this.status();
    if (!st.updater && !existsSync(this.dir)) throw new Error('The updater isn’t installed on this box: run deploy/update.sh once (it installs it)');
    if (st.state === 'updating') throw new Error('Kova is already updating');
    if (what === 'apply' && !st.available) throw new Error('Kova is up to date');
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'request'), `${what}\n`, { mode: 0o640 });
    this.hub.emit('changed');
    return this.status();
  }

  start(): void {
    this.announceResult();
    const every = this.o.everyMs ?? 60_000;
    if (every > 0) { this.timer = setInterval(() => this.tick(), every); this.timer.unref?.(); }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Once a minute: say when a new version is out, and update overnight when that's on. */
  tick(): void {
    const st = this.status();
    this.remember(st.last);
    const said = this.hub.store.get<string>('updateAnnounced');
    if (st.available && said !== st.available.version) {
      this.hub.store.set('updateAnnounced', st.available.version);
      this.hub.emit('changed');
      if (!st.auto.on) {
        void this.o.notify?.({
          title: `Kova ${st.available.version} is available`,
          body: [st.available.changes.slice(0, 3).join('; '), 'Update from Settings, under Software update.'].filter(Boolean).join('. '),
          tag: 'kova-update', url: UPDATE_URL,
        });
      }
    }
    if (st.auto.on && st.available && st.state === 'idle') {
      const tz = this.hub.config.get().timezone;
      const day = localDate(this.now, tz), hour = localHour(this.now, tz);
      const playing = [...this.hub.reg.devices.values()].some(d => isPlayer(d) && d.state.on && !d.state.paused && d.adapter !== 'virtual');
      if (hour === st.auto.hour && this.lastAutoDay !== day && !playing) {
        this.lastAutoDay = day;
        try { this.request('apply'); } catch { /* said in status */ }
      }
    }
  }

  /** After an update (this is the new hub starting, or the old one again): say how it went, once. */
  private announceResult(): void {
    const last = this.status().last;
    this.remember(last);
    if (!last || this.hub.store.get<number>('updateResultSaid') === last.at) return;
    this.hub.store.set('updateResultSaid', last.at);
    const n = last.result === 'updated'
      ? { title: `Kova updated to ${last.to}`, body: `From ${last.from}. A backup was made first.` }
      : last.result === 'rolled-back'
        ? { title: `Kova ${last.from} is back`, body: 'The update didn’t start properly, so Kova went back to the version before, with its data. Nothing to do; it will be offered again.' }
        : { title: 'Kova couldn’t update', body: `${(last.log ?? []).slice(-1)[0] ?? 'See the update log on the box'} (Kova ${last.from} is still running).` };
    void this.o.notify?.({ ...n, tag: 'kova-update', url: UPDATE_URL });
  }
}
