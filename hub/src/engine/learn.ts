import type { Store, LogEntry } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { Engine } from './engine.ts';
import type { Command, Device, HomeConfig } from '../model/types.ts';
import type { Finding } from './findings.ts';
import { targetLabel } from '../util/describe.ts';
import { localDate, localHour } from '../util/time.ts';

// Learning from what people do. Kova looks at changes someone made by hand
// (in the app, at a wall switch, by voice) and notices two kinds of habit:
//
//  1. "After a mode starts, you always fix something": Evening turns the lamp to
//     78% and most evenings you turn it down to 40% within half an hour. Suggest
//     changing the mode, so you don't have to.
//  2. "At about the same time most days, you do the same thing": the porch light
//     goes off by hand around 22:15. Suggest a moment at 22:15.
//
// Every suggestion is backed by the days it happened on, is shown like any other
// finding (fix / keep as is), and applying it is undoable.

const DAYS = 14;
const MANUAL = new Set(['user', 'device', 'assistant']);
/** How soon after a mode starts a change counts as "fixing" that mode. */
const AFTER_MODE_MS = 30 * 60_000;
/** How close in time-of-day repeated changes must be to count as a habit. */
const HABIT_WINDOW_H = 25 / 60;

export interface Suggestion {
  id: string;
  kind: 'mode-target' | 'moment';
  modeId: string;
  device: string;
  target: Command;
  /** Moments only: local clock time. */
  at?: string;
  days: string[];
  finding: Finding;
}

/** Group values that are "the same thing": on/off exactly, brightness to the nearest 10%. */
function valueKey(c: Command): string | null {
  if (c.on === false) return 'off';
  if (c.bri != null) return `bri${Math.round(c.bri / 10) * 10}`;
  if (c.mode) return `mode:${c.mode}`;
  if (c.media === null) return 'stop';
  if (c.on === true) return 'on';
  return null;
}

function representative(changes: Command[]): Command {
  const briVals = changes.map(c => c.bri).filter((b): b is number => b != null).sort((a, b) => a - b);
  const first = changes[0];
  if (briVals.length) return { on: true, bri: Math.round(briVals[Math.floor(briVals.length / 2)] / 5) * 5 };
  if (first.on === false) return first.media === null ? { on: false, media: null } : { on: false };
  if (first.mode) return { mode: first.mode };
  return { on: true };
}

const same = (a: Command | undefined, b: Command) => !!a && valueKey(a) === valueKey(b) && (a.bri == null || b.bri == null || Math.abs(a.bri - b.bri) < 10);
const hhmm = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60 / 5) * 5 % 60).padStart(2, '0')}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Learner {
  constructor(private engine: Engine, private store: Store, private config: ConfigStore, private devices: () => Map<string, Device>) {}

  private manualChanges(from: number, to: number): LogEntry[] {
    return this.store.between(from, to, 'state').filter(e => e.device && MANUAL.has(e.cause.kind));
  }

  private memo: { key: string; cfg: HomeConfig; out: Suggestion[] } | null = null;

  /**
   * What to suggest from the last two weeks of history. Reading it is the slow part of every state snapshot (and
   * the hub sends one on each change), so the answer is kept until something it reads changes: the home's config,
   * a new manual change or mode start, the devices, or ten minutes passing (the window moves).
   */
  suggestions(): Suggestion[] {
    const cfg = this.config.get();
    const key = `${this.store.addedOf('state')}|${this.store.addedOf('mode')}|${this.devices().size}|${Math.floor(this.engine.now() / 600_000)}`;
    if (this.memo && this.memo.cfg === cfg && this.memo.key === key) return this.memo.out;
    const out = this.compute(cfg);
    this.memo = { key, cfg, out };
    return out;
  }

  private compute(cfg: HomeConfig): Suggestion[] {
    const tz = cfg.timezone;
    const now = this.engine.now();
    const from = now - DAYS * 86400_000;
    const devices = this.devices();
    const changes = this.manualChanges(from, now + 1);
    if (changes.length < 3) return [];
    const modeStarts = this.store.between(from, now + 1, 'mode').filter(e => !e.data.skipped);
    const out: Suggestion[] = [];
    const explained = new Set<number>();

    // 1. Corrections right after a mode starts (the latest one, if several started together).
    const byModeDevice = new Map<string, { modeId: string; device: string; entries: LogEntry[] }>();
    for (const c of changes) {
      const start = modeStarts.findLast(s => s.ts <= c.ts);
      if (!start || c.ts > start.ts + AFTER_MODE_MS) continue;
      const modeId = String(start.data.modeId);
      const k = `${modeId}|${c.device}|${valueKey(c.data.patch as Command)}`;
      const g = byModeDevice.get(k) ?? { modeId, device: c.device!, entries: [] };
      g.entries.push(c);
      byModeDevice.set(k, g);
    }
    for (const g of byModeDevice.values()) {
      const d = devices.get(g.device);
      const mode = cfg.modes.find(m => m.id === g.modeId);
      const days = [...new Set(g.entries.map(e => localDate(e.ts, tz)))];
      if (!d || !mode || days.length < 3 || valueKey(g.entries[0].data.patch as Command) == null) continue;
      const target = representative(g.entries.map(e => e.data.patch as Command));
      if (same(mode.targets[g.device], target)) continue;          // already done
      const runs = modeStarts.filter(s => s.data.modeId === g.modeId).length;
      g.entries.forEach(e => explained.add(e.id));
      const id = `learn:mode:${g.modeId}:${g.device}:${valueKey(target)}`;
      const had = mode.targets[g.device];
      out.push({
        id, kind: 'mode-target', modeId: g.modeId, device: g.device, target, days,
        finding: {
          id, modeId: g.modeId, kind: 'Learned from you', icon: 'auto_awesome', tone: 'check',
          title: had ? `${mode.name} could set ${this.name(d, cfg)} the way you like it` : `${mode.name} could handle ${this.name(d, cfg)} for you`,
          body: `On ${plural(days.length, 'day')} of the last ${DAYS} (${mode.name} ran ${plural(runs, 'time')}), you changed it to “${targetLabel(d, target)}” within half an hour of ${mode.name} starting${had ? `, instead of “${targetLabel(d, had)}”` : ''}.`,
          fix: had ? `Make it ${targetLabel(d, target).replace(`${d.name} `, '')}` : `Add to ${mode.name}`, alt: 'Not now',
        },
      });
    }

    // 2. Same change at about the same time of day, on several days.
    const byDeviceValue = new Map<string, LogEntry[]>();
    for (const c of changes) {
      if (explained.has(c.id)) continue;
      const vk = valueKey(c.data.patch as Command);
      if (!vk) continue;
      const k = `${c.device}|${vk}`;
      byDeviceValue.set(k, [...(byDeviceValue.get(k) ?? []), c]);
    }
    for (const entries of byDeviceValue.values()) {
      const d = devices.get(entries[0].device!);
      if (!d) continue;
      // Find the densest window of time-of-day (hours wrap at midnight).
      const hours = entries.map(e => ({ e, h: localHour(e.ts, tz) }));
      let best: typeof hours = [];
      for (const a of hours) {
        const near = hours.filter(b => Math.min(Math.abs(a.h - b.h), 24 - Math.abs(a.h - b.h)) <= HABIT_WINDOW_H);
        if (near.length > best.length) best = near;
      }
      const days = [...new Set(best.map(x => localDate(x.e.ts, tz)))];
      if (days.length < 4) continue;
      const sorted = best.map(x => x.h).sort((a, b) => a - b);
      const at = hhmm(sorted[Math.floor(sorted.length / 2)]);
      const target = representative(best.map(x => x.e.data.patch as Command));
      // Already planned at about that time?
      const planned = cfg.moments.some(m => m.at.kind === 'time' && m.targets[d.id] && same(m.targets[d.id], target) && Math.abs(Number(m.at.at.slice(0, 2)) * 60 + Number(m.at.at.slice(3)) - (Number(at.slice(0, 2)) * 60 + Number(at.slice(3)))) <= 30);
      if (planned) continue;
      const modeId = this.engine.planner.modeAt(best[0].e.ts).mode.id;
      const id = `learn:moment:${d.id}:${at.replace(':', '')}:${valueKey(target)}`;
      out.push({
        id, kind: 'moment', modeId, device: d.id, target, at, days,
        finding: {
          id, modeId, kind: 'Learned from you', icon: 'auto_awesome', tone: 'check',
          title: `You ${this.verb(d, target)} ${this.name(d, cfg)} around ${at}`,
          body: `You did it by hand on ${plural(days.length, 'day')} of the last ${DAYS}, always within about 25 minutes of ${at}. Kova can do it for you at ${at}.`,
          fix: `Do it at ${at}`, alt: 'Not now',
        },
      });
    }
    const dismissed = new Set(cfg.dismissedFindings);
    return out.filter(s => !dismissed.has(s.id)).sort((a, b) => b.days.length - a.days.length);
  }

  private name(d: Device, cfg: HomeConfig): string {
    const room = cfg.rooms.find(r => r.id === d.room)?.name;
    return `the ${room ? `${room.toLowerCase()} ` : ''}${d.name.toLowerCase()}`;
  }

  private verb(d: Device, t: Command): string {
    if (t.on === false) return 'turn off';
    if (t.bri != null) return `set to ${t.bri}%`;
    if (t.mode) return `switch to ${t.mode}`;
    return d.type === 'media' ? 'start' : 'turn on';
  }

  /** Apply a suggestion. Returns a function that undoes it. */
  apply(id: string): () => void {
    const s = this.suggestions().find(x => x.id === id);
    if (!s) throw new Error('That suggestion no longer applies');
    if (s.kind === 'mode-target') {
      return this.config.update(c => { const m = c.modes.find(x => x.id === s.modeId); if (m) m.targets[s.device] = s.target; });
    }
    const d = this.devices().get(s.device)!;
    const momentId = `learned_${s.device}_${s.at!.replace(':', '')}`;
    return this.config.update(c => {
      c.moments = c.moments.filter(m => m.id !== momentId);
      c.moments.push({ id: momentId, label: `${d.name} ${s.target.on === false ? 'off' : 'on'}`, what: `${targetLabel(d, s.target)} · learned from you`, at: { kind: 'time', at: s.at! }, targets: { [s.device]: s.target } });
    });
  }
}
