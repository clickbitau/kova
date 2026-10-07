import type { Store, LogEntry } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { Engine } from './engine.ts';
import type { Command, Device, HomeConfig, Rhythm, Targets } from '../model/types.ts';
import type { Finding } from './findings.ts';
import { targetLabel } from '../util/describe.ts';
import { localDate, localHour } from '../util/time.ts';
import { rhythmPhrase } from '../rhythms/rhythms.ts';
import { LEARN, learnAutomations, personIds, sunFit, type AutoKind, type AutoSuggestion, type Evidence } from './learn-automations.ts';

// Learning from what people do. Kova looks at changes someone made by hand (in the app, at a wall switch, by voice,
// with a remote) and notices habits:
//
//  1. "After a mode starts, you always fix something": Evening turns the lamp to 78% and most evenings you turn it
//     down to 40% within half an hour. Suggest changing the mode, so you don't have to.
//  2. "At about the same time most days, you do the same thing": the porch light goes off by hand around 22:15.
//     Suggest a moment at 22:15 (or one that follows sunset, when the time moves with it).
//  3. Automations that are late or early, corrected, or undone, and new ones from things you do one after the other
//     (learn-automations.ts).
//
// Every suggestion is backed by the days it happened on, is shown like any other finding, and applying it is
// undoable. "Not now" puts one off for a week; "Don't suggest again" for good. Settings can turn learning off.

const DAYS = 14;
/** How long "Not now" puts a suggestion off. */
export const SNOOZE_MS = 7 * 86400_000;
/** How soon after a mode starts a change counts as "fixing" that mode. */
const AFTER_MODE_MS = 30 * 60_000;
/** How close in time-of-day repeated changes must be to count as a habit. */
const HABIT_WINDOW_H = 25 / 60;

export interface Suggestion {
  id: string;
  kind: 'mode-target' | 'moment' | AutoKind;
  modeId: string;
  device: string;
  target: Command;
  /** Moments only: local clock time. */
  at?: string;
  /** Moments that follow the sun instead of the clock. */
  rhythm?: Rhythm;
  automationId?: string;
  days: string[];
  finding: Finding;
  /** For automations: the change, made inside a config update. */
  edit?: (c: HomeConfig) => void;
}

/** Where a suggestion stands with the owner: new, put off (Not now), or not wanted (Don't suggest again). */
export type LearnedStatus = 'new' | 'later' | 'never';

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
  constructor(private engine: Engine, private store: Store, private config: ConfigStore, private devices: () => Map<string, Device>,
    private expand: (t: Targets) => Record<string, Command> = t => ({ ...t })) {}

  private memo: { key: string; cfg: HomeConfig; out: Suggestion[]; at: number } | null = null;
  /** Busy moments (a ramp, a device reporting every second) don't recompute more often than this. */
  private static readonly REST_MS = 30_000;

  /** Learning is on unless the owner turned it off in Settings. */
  get on(): boolean { return this.config.get().learnFromYou !== false; }

  /**
   * Everything the history suggests, put off and unwanted ones included. Reading it is the slow part of every state
   * snapshot (and the hub sends one on each change), so the answer is kept until something it reads changes: the
   * home's config, a new change, run or arrival, the devices, or ten minutes passing (the window moves).
   */
  all(): Suggestion[] {
    const cfg = this.config.get();
    if (cfg.learnFromYou === false) return [];
    const key = `${this.store.addedOf('state')}|${this.store.addedOf('mode')}|${this.store.addedOf('run')}|${this.store.addedOf('presence')}|${this.devices().size}|${Math.floor(this.engine.now() / 600_000)}`;
    const now = this.engine.now();
    if (this.memo && this.memo.cfg === cfg && (this.memo.key === key || (now >= this.memo.at && now - this.memo.at < Learner.REST_MS))) return this.memo.out;
    const out = this.compute(cfg);
    this.memo = { key, cfg, out, at: now };
    return out;
  }

  /** What to suggest now: not dismissed for good, not put off. */
  suggestions(): Suggestion[] {
    return this.all().filter(s => this.status(s.id) === 'new');
  }

  status(id: string): LearnedStatus {
    const cfg = this.config.get();
    if (cfg.dismissedFindings.includes(id)) return 'never';
    const until = cfg.snoozedFindings?.[id];
    return until != null && until > this.engine.now() ? 'later' : 'new';
  }

  /** Everything learned, with where each stands, for "What Kova has learned" in Settings. */
  view(): { on: boolean; items: (Finding & { status: LearnedStatus; until?: number })[] } {
    const snoozed = this.config.get().snoozedFindings ?? {};
    return {
      on: this.on,
      items: this.all().map(s => ({ ...s.finding, status: this.status(s.id), ...(this.status(s.id) === 'later' ? { until: snoozed[s.id] } : {}) })),
    };
  }

  /** A suggestion (or one of its other ways) by id. */
  find(id: string): Suggestion | undefined {
    for (const s of this.all()) {
      if (s.id === id) return s;
      const m = (s as Suggestion & { more?: Suggestion[] }).more?.find(x => x.id === id);
      if (m) return m;
    }
    return undefined;
  }

  /** "Why do you suggest this?": the suggestion and its evidence, in words. */
  explain(id: string): string | null {
    const s = this.find(id);
    if (!s) return null;
    const ev = (s.finding.evidence ?? []).slice(-8).map(e => `${e.day}: ${e.text}`).join('; ');
    return `${s.finding.title}. ${s.finding.body}${ev ? ` The days: ${ev}.` : ''}`;
  }

  private compute(cfg: HomeConfig): Suggestion[] {
    const tz = cfg.timezone;
    const now = this.engine.now();
    const devices = this.devices();
    const wide = now - LEARN.WINDOW_DAYS * 86400_000;
    const state = this.store.between(wide, now + 1, 'state');
    const runs = this.store.between(wide, now + 1, 'run');
    const presence = this.store.between(wide, now + 1, 'presence');
    const person = personIds(state, devices, cfg.sources.map(m => m.name));
    const out: Suggestion[] = [];
    const explained = new Set<number>();

    // Automations: late or early, corrected, undone; and new ones from chains.
    const firstRun = (id: string) => { const h = this.engine.automations.history(id); return h.length ? Math.min(...h.map(r => r.at)) : undefined; };
    const autos = learnAutomations({ cfg, now, devices, expand: this.expand, state, runs, presence, firstSeen: firstRun });
    const asSuggestion = (a: AutoSuggestion): Suggestion => {
      const modeId = this.engine.planner.modeAt(a.at).mode.id;
      const s: Suggestion & { more?: Suggestion[] } = {
        id: a.id, kind: a.kind, modeId, device: a.device, target: {}, automationId: a.automationId, days: a.days, edit: a.edit,
        finding: this.finding(a.id, modeId, a.title, a.body, a.fix, a.done, a.evidence, a.automationId),
      };
      if (a.more?.length) {
        s.more = a.more.map(asSuggestion);
        s.finding.more = s.more.map(m => ({ id: m.id, title: m.finding.title, body: m.finding.body, fix: m.finding.fix, done: m.finding.done }));
      }
      return s;
    };
    for (const a of autos) { a.explains.forEach(id => explained.add(id)); out.push(asSuggestion(a)); }

    const from = now - DAYS * 86400_000;
    const changes = state.filter(e => e.ts >= from && person.has(e.id));
    const modeStarts = this.store.between(from, now + 1, 'mode').filter(e => !e.data.skipped);

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
      const runsOf = modeStarts.filter(s => s.data.modeId === g.modeId).length;
      g.entries.forEach(e => explained.add(e.id));
      const id = `learn:mode:${g.modeId}:${g.device}:${valueKey(target)}`;
      const had = mode.targets[g.device];
      out.push({
        id, kind: 'mode-target', modeId: g.modeId, device: g.device, target, days,
        finding: {
          ...this.finding(id, g.modeId,
            had ? `${mode.name} could set ${this.name(d, cfg)} the way you like it` : `${mode.name} could handle ${this.name(d, cfg)} for you`,
            `On ${plural(days.length, 'day')} of the last ${DAYS} (${mode.name} ran ${plural(runsOf, 'time')}), you changed it to “${targetLabel(d, target)}” within half an hour of ${mode.name} starting${had ? `, instead of “${targetLabel(d, had)}”` : ''}.`,
            had ? `Make it ${targetLabel(d, target).replace(`${d.name} `, '')}` : `Add to ${mode.name}`, `${mode.name} updated`,
            g.entries.map(e => ({ day: this.day(e.ts), text: `${this.clock(e.ts)} · ${String(e.what)}` }))),
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
      // Already planned at about that time (a moment, or an automation at that time)?
      const near = (hm: string) => Math.abs(Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) - (Number(at.slice(0, 2)) * 60 + Number(at.slice(3)))) <= 30;
      const planned = cfg.moments.some(m => m.at.kind === 'time' && m.targets[d.id] && same(m.targets[d.id], target) && near(m.at.at))
        || (cfg.automations ?? []).some(a => a.enabled && a.triggers.some(t => t.kind === 'time' && t.at.kind === 'time' && near(t.at.at))
          && a.actions.some(s => s.kind === 'set' && same(this.expand(s.targets)[d.id], target)));
      if (planned) continue;
      // The time moves with sunset or sunrise: follow it instead.
      const sun = sunFit(best.map(x => x.e.ts), { cfg: cfg });
      const when = sun ? rhythmPhrase(sun) : at;
      const modeId = this.engine.planner.modeAt(best[0].e.ts).mode.id;
      const id = `learn:moment:${d.id}:${at.replace(':', '')}:${valueKey(target)}`;
      out.push({
        id, kind: 'moment', modeId, device: d.id, target, at, rhythm: sun ?? undefined, days,
        finding: this.finding(id, modeId,
          `You ${this.verb(d, target)} ${this.name(d, cfg)} around ${sun ? when : at}`,
          sun ? `You did it by hand on ${plural(days.length, 'day')} of the last ${DAYS}, and the time moved with ${sun.event}: about ${when}. Kova can do it for you then, as ${sun.event} moves through the year.`
            : `You did it by hand on ${plural(days.length, 'day')} of the last ${DAYS}, always within about 25 minutes of ${at}. Kova can do it for you at ${at}.`,
          sun ? `Do it ${when}` : `Do it at ${at}`, 'Added to your day',
          best.sort((p, q) => p.e.ts - q.e.ts).map(x => ({ day: this.day(x.e.ts), text: `${this.clock(x.e.ts)} · ${String(x.e.what)}` }))),
      });
    }
    return out.sort((a, b) => b.days.length - a.days.length);
  }

  private day(ts: number): string {
    return new Date(ts).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: this.config.get().timezone }).replace(',', '').replace(/\bSept\b/, 'Sep');
  }

  private clock(ts: number): string { const h = localHour(ts, this.config.get().timezone); return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60 + 1e-6)).padStart(2, '0')}`; }

  private finding(id: string, modeId: string, title: string, body: string, fix: string, done: string, evidence: Evidence[], automationId?: string): Finding {
    return { id, modeId, kind: 'Learned from you', icon: 'auto_awesome', tone: 'check', title, body, fix, alt: 'Not now', never: 'Don’t suggest again', done, learned: true, evidence, ...(automationId ? { automationId } : {}) };
  }

  private name(d: Device, cfg: HomeConfig): string {
    const room = cfg.rooms.find(r => r.id === d.room)?.name;
    // "the bedroom OLED", not "the master bed bedroom OLED": the room only when the name doesn't already say where.
    const says = room && room.toLowerCase().split(/\s+/).some(w => w.length >= 3 && d.name.toLowerCase().includes(w.slice(0, 3)));
    return `the ${room && !says ? `${room.toLowerCase()} ` : ''}${d.name.toLowerCase()}`;
  }

  private verb(d: Device, t: Command): string {
    if (t.on === false) return 'turn off';
    if (t.bri != null) return `set to ${t.bri}%`;
    if (t.mode) return `switch to ${t.mode}`;
    return d.type === 'media' ? 'start' : 'turn on';
  }

  /** Apply a suggestion (or one of its other ways). Returns a function that undoes it. */
  apply(id: string): () => void {
    const s = this.find(id);
    if (!s) throw new Error('That suggestion no longer applies');
    if (s.edit) {
      if (s.automationId && !(this.config.get().automations ?? []).some(a => a.id === s.automationId)) throw new Error('That automation is gone');
      return this.config.update(c => s.edit!(c));
    }
    if (s.kind === 'mode-target') {
      return this.config.update(c => { const m = c.modes.find(x => x.id === s.modeId); if (m) m.targets[s.device] = s.target; });
    }
    const d = this.devices().get(s.device)!;
    const momentId = `learned_${s.device}_${s.at!.replace(':', '')}`;
    return this.config.update(c => {
      c.moments = c.moments.filter(m => m.id !== momentId);
      c.moments.push({ id: momentId, label: `${d.name} ${s.target.on === false ? 'off' : 'on'}`, what: `${targetLabel(d, s.target)} · learned from you`, at: s.rhythm ?? { kind: 'time', at: s.at! }, targets: { [s.device]: s.target } });
    });
  }

  /** "Not now": hide it for a week. */
  snooze(id: string): () => void {
    const until = this.engine.now() + SNOOZE_MS;
    return this.config.update(c => { c.snoozedFindings = { ...(c.snoozedFindings ?? {}), [id]: until }; });
  }

  /** Suggest it again (from "What Kova has learned"): neither put off nor dismissed. */
  restore(id: string): () => void {
    return this.config.update(c => {
      c.dismissedFindings = c.dismissedFindings.filter(x => x !== id);
      if (c.snoozedFindings) { const { [id]: _, ...rest } = c.snoozedFindings; c.snoozedFindings = rest; }
    });
  }
}

export { LEARN };
