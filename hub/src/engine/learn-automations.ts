import type { LogEntry } from '../store/db.ts';
import type { Automation, Command, Condition, Device, HomeConfig, NumericField, Rhythm, Targets, Trigger } from '../model/types.ts';
import { resolveRhythm, rhythmPhrase } from '../rhythms/rhythms.ts';
import { addDays, clock, localDate, localHour } from '../util/time.ts';
import { PSEUDO_TARGET } from '../util/describe.ts';
import { isCamera, isSensor } from '../util/sensors.ts';

// Learning about automations from what people do by hand. Five habits, each only with enough evidence:
//
//  1. Late or early: you do by hand what an automation would do a bit later, most days ("Rain at bedtime"
//     plays at 22:00, but you start it around 21:15). Move its time, or start it on what comes just before.
//  2. Corrected: soon after an automation sets something, you change it the same way most times (it leaves the
//     office strip at 10%, you take it to 5–7%). Change its value to yours.
//  3. Undone: you turn off or stop what an automation did, most times. Add the condition that explains when (only
//     while the TV is off, only on weekdays), or pause it.
//  4. Chains: A, then B by hand within minutes, on many days (the TV turns off, you turn the lamp off). Make "when A,
//     do B".
//  5. Drift: the time you do something moves with sunset or sunrise. Follow the sun instead of a fixed time.
//
// Everything here only reads the event log and the home's settings. Suggestions are shown as findings; nothing
// changes until the owner applies one, and applying is undoable.

export const LEARN = {
  /** How far back automations are compared with what people do. */
  WINDOW_DAYS: 21,
  /** Least number of days a pattern must be seen on, by kind. */
  MIN_DAYS_TIME: 4,
  MIN_DAYS_VALUE: 3,
  MIN_DAYS_UNDO: 3,
  MIN_DAYS_CHAIN: 4,
  /** Share of the days it could have happened on that it did. */
  SHARE: 0.6,
  /** Doing it by hand this long before an automation's time still counts as "early". */
  EARLY_MIN: 180,
  /** A move of less than this isn't worth suggesting. */
  MIN_SHIFT_MIN: 10,
  /** Most early times must be within this of their median. */
  SPREAD_MIN: 40,
  /** A change to what an automation set counts as correcting it within this long (and before anything else sets it). */
  CORRECT_MIN: 120,
  /** Turning off what an automation did within this long counts as undoing it. */
  UNDO_MIN: 20,
  /** B within this long after A, for a chain. */
  CHAIN_MIN: 10,
  /** Device reports within this long of a command Kova sent are the device catching up, not a person. */
  ECHO_S: 45,
};

/** Causes that are a person: the app, a voice assistant, Ask Kova, Undo. Device reports are checked separately. */
const PERSON = new Set(['user', 'assistant', 'undo']);
/** Overlays during which the home isn't its usual self: those days teach nothing. */
const UNUSUAL = /guest|away|holiday|vacation|party/i;
/** Fields a person changes that mean something (not a song changing, a reading, the device going offline). */
const MEANINGFUL = ['on', 'bri', 'media', 'vol', 'mode', 'hvac', 'target', 'paused'];

export type AutoKind = 'auto-time' | 'auto-trigger' | 'auto-value' | 'auto-condition' | 'auto-pause' | 'chain';

/** One line of evidence: the day and what happened. */
export interface Evidence { day: string; text: string }

export interface AutoSuggestion {
  id: string;
  kind: AutoKind;
  automationId?: string;
  device: string;
  days: string[];
  /** When it happened, for the mode it falls in. */
  at: number;
  title: string;
  body: string;
  fix: string;
  done: string;
  evidence: Evidence[];
  /** Other ways to apply it, as suggestions of their own (shown on the same card). */
  more?: AutoSuggestion[];
  /** The change, made inside a config update. */
  edit: (c: HomeConfig) => void;
  /** Log entries this explains, so the simpler habits don't suggest the same thing again. */
  explains: number[];
}

export interface LearnCtx {
  cfg: HomeConfig;
  now: number;
  devices: Map<string, Device>;
  /** Resolve "type:light" / "room:x" targets to devices, as the registry does at run time. */
  expand: (t: Targets) => Record<string, Command>;
  /** State changes, runs and presence in the window, oldest first. */
  state: LogEntry[];
  runs: LogEntry[];
  presence: LogEntry[];
  /** Earliest time each automation is known to have existed (its run history), if any. */
  firstSeen?: (automationId: string) => number | undefined;
}

// ------------------------------------------------------------------ helpers --

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const round5 = (m: number) => Math.round(m / 5) * 5;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hhmm = (min: number) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const minutesOf = (ms: number, tz: string) => Math.floor(localHour(ms, tz) * 60 + 1e-6);
const patchOf = (e: LogEntry) => (e.data.patch ?? {}) as Command;
const prevOf = (e: LogEntry) => (e.data.prev ?? {}) as Command;
const ranByHand = (e: LogEntry) => e.cause.kind === 'automation' && /run by hand/i.test(e.cause.detail ?? '');

/** "Fri 3 Oct" in the home's timezone. */
export function dayLabel(date: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '').replace(/\bSept\b/, 'Sep');
}

/** A device report that's only the device catching up with a command, or drifting by a step: not a person. */
function isEcho(e: LogEntry, lastCommand: Map<string, number>): boolean {
  const p = patchOf(e), prev = prevOf(e);
  const keys = Object.keys(p).filter(k => MEANINGFUL.includes(k));
  if (!keys.length) return true;
  const sent = lastCommand.get(e.device!);
  if (sent != null && e.ts - sent <= LEARN.ECHO_S * 1000) return true;
  // Only numbers moving by a step or two (a dimmer's rounding, a speaker's volume reading).
  return keys.every(k => typeof (p as Record<string, unknown>)[k] === 'number' && typeof (prev as Record<string, unknown>)[k] === 'number'
    && Math.abs((p as Record<string, number>)[k] - (prev as Record<string, number>)[k]) <= 2);
}

/**
 * Which state changes a person made: the app, Ask Kova, a voice assistant, Undo, and changes reported by the device
 * itself (a wall switch, its own remote, another app) unless they're the device catching up with Kova.
 */
export function personIds(state: LogEntry[], devices: Map<string, Device>, sources: string[] = []): Set<number> {
  const known = new Set(sources.map(norm));
  const out = new Set<number>();
  const lastCommand = new Map<string, number>();
  for (const e of state) {
    if (!e.device) continue;
    if (e.cause.kind !== 'device') lastCommand.set(e.device, e.ts);
    const d = devices.get(e.device);
    if (!d || isSensor(d) || isCamera(d)) continue;
    if (PERSON.has(e.cause.kind)) { out.add(e.id); continue; }
    if (e.cause.kind !== 'device' || isEcho(e, lastCommand)) continue;
    // Players report what they play all day (a cast from a phone, a film ending, the next episode): only a TV
    // turned on or off at its remote, or a sound Kova knows by name, is something a person did that Kova can repeat.
    const p = patchOf(e);
    if (d.type === 'media' || d.type === 'tv') {
      const named = typeof p.media === 'string' && known.has(norm(p.media));
      const power = d.type === 'tv' && typeof p.on === 'boolean' && p.media === undefined;
      if (!named && !power) continue;
    }
    out.add(e.id);
  }
  return out;
}

/** Does this change do what the command does (start that sound, turn it on, turn it off)? */
export function achieves(p: Command, c: Command): boolean {
  if (typeof c.media === 'string' && c.media) return typeof p.media === 'string' && norm(p.media) === norm(c.media);
  if (c.on === false || c.media === null) return p.on === false || p.media === null;
  if (c.on === true && c.bri != null) return (p.on === true && p.bri == null) || (p.bri != null && Math.abs(p.bri - c.bri) <= 10);
  if (c.on === true) return p.on === true;
  if (c.hvac) return p.hvac === c.hvac;
  if (c.mode) return p.mode === c.mode;
  return false;
}

/** Does this change take back what the command did (turn off what it turned on, stop what it started)? */
export function reverses(p: Command, c: Command): boolean {
  if (c.on === true || (typeof c.media === 'string' && c.media)) return p.on === false || p.media === null || p.paused === true;
  if (c.on === false) return p.on === true;
  return false;
}

const VERB = (c: Command, d?: Device) => c.on === false || c.media === null ? 'turned off' : typeof c.media === 'string' && c.media ? 'started' : d && (d.type === 'media' || d.type === 'tv') ? 'started' : 'turned on';

/** The top-level "set" steps of an automation, device by device (pseudo targets resolved). */
function setEffects(a: Automation, x: LearnCtx): { index: number; device: string; cmd: Command; explicit: boolean }[] {
  const out: { index: number; device: string; cmd: Command; explicit: boolean }[] = [];
  a.actions.forEach((s, index) => {
    if (s.kind !== 'set') return;
    for (const [id, c] of Object.entries(x.expand(s.targets))) out.push({ index, device: id, cmd: c, explicit: id in s.targets });
  });
  return out;
}

/** Who's home and which overlays were on, over the window, to leave out times the home wasn't itself. */
class Context {
  private overlays: { id: string; name: string; from: number; to: number }[] = [];
  private presence: { person: string; home: boolean; ts: number }[] = [];
  readonly unusualDays = new Set<string>();

  /** When people did things by hand: someone doing things is home, whatever the phones say. */
  private personTimes: number[] = [];

  constructor(private x: LearnCtx, person?: Set<number>) {
    this.personTimes = person ? x.state.filter(e => person.has(e.id)).map(e => e.ts) : [];
    const open = new Map<string, number>();
    for (const r of x.runs) {
      const id = r.data.overlay as string | undefined;
      if (!id || r.cause.kind !== 'overlay') continue;
      if (/ended$/.test(r.cause.label)) { const from = open.get(id); if (from != null) { this.add(id, from, r.ts); open.delete(id); } }
      else open.set(id, r.ts);
    }
    for (const [id, from] of open) this.add(id, from, x.now);
    this.presence = x.presence.filter(p => typeof p.data.person === 'string').map(p => ({ person: p.data.person as string, home: !!p.data.home, ts: p.ts }));
  }

  private add(id: string, from: number, to: number) {
    const name = this.x.cfg.overlays.find(o => o.id === id)?.name ?? id;
    // Started by mistake and ended at once: it didn't change the day.
    if (to - from < 15 * 60_000) return;
    this.overlays.push({ id, name, from, to });
    if (UNUSUAL.test(id) || UNUSUAL.test(name)) for (let d = localDate(from, this.x.cfg.timezone); d <= localDate(to, this.x.cfg.timezone); d = addDays(d, 1)) this.unusualDays.add(d);
  }

  overlayAt(t: number): string | null { return this.overlays.find(o => o.from <= t && t < o.to)?.id ?? null; }

  /** Anyone home at t. Unknown (no presence history) counts as home. */
  anyoneHome(t: number): boolean {
    const people = new Map<string, boolean>();
    for (const p of this.presence) { if (p.ts > t) break; people.set(p.person, p.home); }
    if (!people.size) return true;
    // People never seen leaving or arriving yet: their first entry says where they weren't before it.
    for (const p of this.presence) if (!people.has(p.person) && p.ts > t) people.set(p.person, !p.home);
    return [...people.values()].some(Boolean);
  }

  /** Someone did something by hand within two hours of t. */
  private active(t: number): boolean {
    const w = 2 * 3600_000;
    let lo = 0, hi = this.personTimes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.personTimes[m] < t - w) lo = m + 1; else hi = m; }
    return lo < this.personTimes.length && this.personTimes[lo] <= t + w;
  }

  /** A time to learn from: not on a Guests or Away day, no overlay on, someone home (or doing things here). */
  usual(t: number): boolean {
    return !this.unusualDays.has(localDate(t, this.x.cfg.timezone)) && !this.overlayAt(t) && (this.anyoneHome(t) || this.active(t));
  }
}

/** Device on or off at t, from the log (undefined when the log doesn't say). */
function onAt(state: LogEntry[], device: string, t: number): boolean | undefined {
  let v: boolean | undefined;
  for (const e of state) {
    if (e.ts >= t) break;
    if (e.device !== device) continue;
    const p = patchOf(e);
    if (typeof p.on === 'boolean') v = p.on;
  }
  return v;
}

// ---------------------------------------------------------------- 5. drift --

/**
 * Times that move with the sun: over these days, does the time someone does it follow sunset (or sunrise) better than
 * the clock? Needs the sun to have moved enough over the days to tell.
 */
export function sunFit(times: number[], x: Pick<LearnCtx, 'cfg'>): Extract<Rhythm, { kind: 'sun' }> | null {
  if (times.length < 6) return null;
  const tz = x.cfg.timezone;
  const mins = times.map(t => minutesOf(t, tz));
  const event = median(mins) >= 12 * 60 ? 'sunset' as const : 'sunrise' as const;
  const sun = times.map(t => resolveRhythm({ kind: 'sun', event }, localDate(t, tz), x.cfg));
  if (sun.some(s => s == null)) return null;
  const sunMin = sun.map(s => minutesOf(s!, tz));
  if (Math.max(...sunMin) - Math.min(...sunMin) < 8) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mx = mean(sunMin), my = mean(mins);
  const sxx = sunMin.reduce((a, v) => a + (v - mx) ** 2, 0);
  const slope = sunMin.reduce((a, v, i) => a + (v - mx) * (mins[i] - my), 0) / sxx;
  const offsets = mins.map((m, i) => m - sunMin[i]);
  const mad = (xs: number[]) => { const md = median(xs); return median(xs.map(v => Math.abs(v - md))); };
  if (slope < 0.5 || slope > 1.5) return null;
  if (mad(offsets) > 0.6 * mad(mins) || mad(offsets) > 12) return null;
  const off = round5(median(offsets));
  return off ? { kind: 'sun', event, offsetMin: off } : { kind: 'sun', event };
}

const rhythmWords = (r: Rhythm) => r.kind === 'time' ? r.at : rhythmPhrase(r);

// ------------------------------------------------------------- the learner --

export function learnAutomations(x: LearnCtx): AutoSuggestion[] {
  const person = personIds(x.state, x.devices, x.cfg.sources.map(m => m.name));
  const ctx = new Context(x, person);
  const out: AutoSuggestion[] = [];
  for (const a of x.cfg.automations ?? []) {
    if (!a.enabled) continue;
    out.push(...timing(a, x, ctx, person), ...corrections(a, x, ctx, person), ...undoing(a, x, ctx, person));
  }
  out.push(...chains(x, ctx, person, new Set(out.flatMap(s => s.explains))));
  return out;
}

/** The days an automation existed in the window, from the first sign of it. */
function firstDay(a: Automation, x: LearnCtx): number | undefined {
  const fromLog = Math.min(
    x.runs.find(r => r.data.automation === a.id)?.ts ?? Infinity,
    x.state.find(e => e.cause.kind === 'automation' && e.cause.id === a.id)?.ts ?? Infinity,
    x.firstSeen?.(a.id) ?? Infinity,
  );
  return Number.isFinite(fromLog) ? fromLog : undefined;
}

const nameOf = (x: LearnCtx, id: string) => {
  const d = x.devices.get(id);
  if (!d) return id;
  const room = x.cfg.rooms.find(r => r.id === d.room)?.name;
  // "the bedroom TV", not "the master bed bedroom TV": the room only when the name doesn't already say where.
  const says = room && norm(room).split(' ').some(w => w.length >= 3 && norm(d.name).includes(w.slice(0, 3)));
  return room && !says ? `the ${room.toLowerCase()} ${d.name.toLowerCase()}` : `the ${d.name.toLowerCase()}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --------------------------------------------------------- 1. late or early --

function timing(a: Automation, x: LearnCtx, ctx: Context, person: Set<number>): AutoSuggestion[] {
  const tz = x.cfg.timezone;
  if (!a.triggers.length || !a.triggers.every(t => t.kind === 'time')) return [];
  if (a.triggers.length !== 1) return [];
  const tr = a.triggers[0] as Extract<Trigger, { kind: 'time' }>;
  if (tr.at.kind === 'prayer') return [];
  const effects = setEffects(a, x).filter(e => e.cmd.on !== undefined || typeof e.cmd.media === 'string');
  if (!effects.length) return [];
  const first = firstDay(a, x);
  if (first == null) return [];
  const dueOn = (date: string) => {
    if (tr.days?.length) { const [y, m, d] = date.split('-').map(Number); if (!tr.days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) return null; }
    return resolveRhythm(tr.at, date, x.cfg);
  };
  // Each day it was due: did someone do it by hand first (or run it by hand)?
  const eligible: string[] = [];
  const early: { date: string; t: number; how: string; ids: number[] }[] = [];
  const effectDevices = new Set(effects.map(e => e.device));
  const runsByHand = x.runs.filter(r => r.data.automation === a.id && ranByHand(r));
  for (let date = localDate(first, tz); date <= localDate(x.now, tz); date = addDays(date, 1)) {
    const T = dueOn(date);
    if (T == null || T > x.now || T < first - 3 * 3600_000) continue;
    if (!ctx.usual(T)) continue;
    eligible.push(date);
    const from = T - LEARN.EARLY_MIN * 60_000;
    const byHand = runsByHand.find(r => r.ts >= from && r.ts < T);
    const manual = x.state.find(e => e.ts >= from && e.ts < T && person.has(e.id) && effectDevices.has(e.device!)
      && effects.some(f => f.device === e.device && achieves(patchOf(e), f.cmd)));
    const hit = [byHand, manual].filter((e): e is LogEntry => !!e).sort((p, q) => p.ts - q.ts)[0];
    if (hit) early.push({ date, t: hit.ts, how: hit === byHand ? 'ran it by hand' : `${VERB(effects.find(f => f.device === hit.device)!.cmd, x.devices.get(hit.device!))} it by hand`, ids: [hit.id] });
  }
  if (early.length < LEARN.MIN_DAYS_TIME || early.length < LEARN.SHARE * eligible.length) return [];
  const offsets = early.map(e => (e.t - dueOn(e.date)!) / 60_000);
  const med = median(offsets);
  if (Math.abs(med) < LEARN.MIN_SHIFT_MIN) return [];
  if (offsets.filter(o => Math.abs(o - med) <= LEARN.SPREAD_MIN).length < 0.75 * offsets.length) return [];

  const due = dueOn(early[early.length - 1].date)!;
  const dueClock = minutesOf(due, tz);
  const typical = round5(dueClock + med);
  const times = early.map(e => e.t);
  const sun = tr.at.kind === 'time' ? sunFit(times, x) : null;
  const newAt: Rhythm = sun ?? (tr.at.kind === 'sun' ? { ...tr.at, offsetMin: round5((tr.at.offsetMin ?? 0) + med) } : { kind: 'time', at: hhmm(typical) });
  const atWords = rhythmWords(newAt);
  const was = rhythmWords(tr.at);
  const clocks = early.map(e => minutesOf(e.t, tz));
  const range = `${hhmm(Math.min(...clocks))}–${hhmm(Math.max(...clocks))}`;
  const main = effects[0];
  const doing = VERB(main.cmd, x.devices.get(main.device));
  const evidence = early.map(e => ({ day: dayLabel(e.date, tz), text: `${clock(e.t, tz)} · you ${e.how}` }));
  const days = early.map(e => e.date);
  const explains = early.flatMap(e => e.ids);
  const earlier = med < 0;
  const id = `learn:auto-time:${a.id}:${newAt.kind === 'time' ? newAt.at.replace(':', '') : `${newAt.event}${newAt.offsetMin ?? 0}`}`;
  const s: AutoSuggestion = {
    id, kind: 'auto-time', automationId: a.id, device: main.device, days, at: early[early.length - 1].t, evidence, explains,
    title: sun ? `“${a.name}” could follow ${sun.event}` : `“${a.name}” could start at ${atWords}`,
    body: `It runs at ${was}, but on ${early.length} of the last ${plural(eligible.length, 'day')} you ${doing} it ${earlier ? 'earlier' : 'later'} by hand, around ${hhmm(typical)} (${range}).`
      + (sun ? ` Your time moves with ${sun.event}: about ${rhythmWords(sun)}.` : ''),
    fix: sun ? `Start ${atWords}` : `Move it to ${atWords}`,
    done: `${a.name} now starts ${sun ? atWords : `at ${atWords}`}`,
    edit: c => { const y = c.automations?.find(q => q.id === a.id); const t = y?.triggers.find(q => q.kind === 'time') as Extract<Trigger, { kind: 'time' }> | undefined; if (t) t.at = newAt; },
  };
  // A better trigger: something that happens just before you do it, on most of those days and rarely otherwise.
  const better = betterTrigger(a, x, early, eligible.map(d => dueOn(d)!), effectDevices);
  if (better) s.more = [better];
  return [s];
}

function betterTrigger(a: Automation, x: LearnCtx, early: { date: string; t: number }[], dues: number[], skip: Set<string>): AutoSuggestion | undefined {
  const tz = x.cfg.timezone;
  const BEFORE = 20 * 60_000;
  type Cand = { key: string; trigger: Trigger; words: string; at: (from: number, to: number) => number[] };
  const cands = new Map<string, Cand>();
  for (const e of x.state) {
    const d = e.device ? x.devices.get(e.device) : undefined;
    if (!d || skip.has(d.id) || isSensor(d) || isCamera(d) || d.type === 'internet') continue;
    const p = patchOf(e), prev = prevOf(e);
    if (typeof p.on !== 'boolean' || prev.on !== !p.on) continue;
    const key = `${d.id}|${p.on}`;
    if (!cands.has(key)) {
      const on = p.on;
      cands.set(key, { key, trigger: { kind: 'device', device: d.id, to: { on } }, words: `${nameOf(x, d.id)} turns ${on ? 'on' : 'off'}`,
        at: (from, to) => x.state.filter(q => q.device === d.id && q.ts >= from && q.ts < to && patchOf(q).on === on && prevOf(q).on === !on).map(q => q.ts) });
    }
  }
  for (const r of x.runs) {
    const id = r.data.overlay as string | undefined;
    if (!id || r.cause.kind !== 'overlay' || /ended$/.test(r.cause.label) || cands.has(`overlay|${id}`)) continue;
    const name = x.cfg.overlays.find(o => o.id === id)?.name ?? id;
    cands.set(`overlay|${id}`, { key: `overlay|${id}`, trigger: { kind: 'overlay', overlay: id, event: 'starts' }, words: `${name} starts`,
      at: (from, to) => x.runs.filter(q => q.data.overlay === id && q.cause.kind === 'overlay' && !/ended$/.test(q.cause.label) && q.ts >= from && q.ts < to).map(q => q.ts) });
  }
  let best: { c: Cand; hits: { date: string; t: number; lead: number }[] } | undefined;
  for (const c of cands.values()) {
    const hits = early.flatMap(e => { const ts = c.at(e.t - BEFORE, e.t); return ts.length ? [{ date: e.date, t: ts[ts.length - 1], lead: (e.t - ts[ts.length - 1]) / 60_000 }] : []; });
    if (hits.length < 0.75 * early.length || hits.length < LEARN.MIN_DAYS_TIME) continue;
    // It mustn't happen much more often in those evenings than you do it.
    const all = dues.reduce((n, T) => n + c.at(T - LEARN.EARLY_MIN * 60_000, T + 60 * 60_000).length, 0);
    if (all > 1.5 * hits.length) continue;
    if (!best || hits.length > best.hits.length) best = { c, hits };
  }
  if (!best) return undefined;
  const clocks = early.map(e => minutesOf(e.t, tz));
  const after = hhmm(Math.floor((Math.min(...clocks) - 30) / 5) * 5);
  const before = hhmm(Math.ceil((minutesOf(dues[dues.length - 1], tz) + 60) / 5) * 5);
  const trig = best.c.trigger;
  const lead = Math.max(1, Math.round(median(best.hits.map(h => h.lead))));
  const id = `learn:auto-trigger:${a.id}:${best.c.key.replace('|', ':')}`;
  return {
    id, kind: 'auto-trigger', automationId: a.id, device: (trig as { device?: string }).device ?? '', days: best.hits.map(h => h.date), at: best.hits[best.hits.length - 1].t,
    evidence: best.hits.map(h => ({ day: dayLabel(h.date, tz), text: `${clock(h.t, tz)} · ${best!.c.words}, ${plural(Math.round(h.lead), 'min')} before you did it` })),
    explains: [],
    title: `“${a.name}” could start when ${best.c.words}`,
    body: `On ${best.hits.length} of those days, ${best.c.words} about ${plural(lead, 'minute')} before you did it. It would start then (between ${after} and ${before}), and still at its usual time if that doesn’t happen.`,
    fix: `Start when ${best.c.words.replace(/^the /, 'the ')}`,
    done: `${a.name} now starts when ${best.c.words}`,
    edit: c => {
      const y = c.automations?.find(q => q.id === a.id);
      if (!y) return;
      if (!y.triggers.some(q => JSON.stringify(q) === JSON.stringify(trig))) y.triggers.unshift(trig);
      y.conditions.push({ kind: 'time', after: { kind: 'time', at: after }, before: { kind: 'time', at: before } });
    },
  };
}

// ------------------------------------------------------------- 2. corrected --

const STEP: Partial<Record<NumericField, number>> = { bri: 5, vol: 5, target: 0.5 };
const MIN_DIFF: Partial<Record<NumericField, number>> = { bri: 5, vol: 5, target: 1 };
const UNIT: Partial<Record<NumericField, string>> = { bri: '%', vol: '%', target: '°' };
const FIELD_WORD: Partial<Record<NumericField, string>> = { bri: 'brightness', vol: 'volume', target: 'set temperature' };

function corrections(a: Automation, x: LearnCtx, ctx: Context, person: Set<number>): AutoSuggestion[] {
  const tz = x.cfg.timezone;
  // Steps that set a number on a device: set with bri/vol/target, or a ramp.
  type Step = { index: number; field: NumericField; device: string; value: number; ramp: boolean; explicit: boolean; only: boolean; from?: number };
  const steps: Step[] = [];
  a.actions.forEach((s, index) => {
    if (s.kind === 'set') {
      const exp = x.expand(s.targets);
      for (const [id, c] of Object.entries(exp)) for (const f of ['bri', 'vol', 'target'] as NumericField[]) {
        const v = (c as Record<string, unknown>)[f];
        if (typeof v === 'number') steps.push({ index, field: f, device: id, value: v, ramp: false, explicit: id in s.targets, only: Object.keys(s.targets).length === 1 });
      }
    }
    if (s.kind === 'ramp' && STEP[s.field]) {
      // Ramp targets carry no value of their own ({}): give them the field, so "type:light" finds its dimmers.
      const withField = Object.fromEntries(Object.entries(s.targets).map(([k, c]) => [k, { ...c, [s.field]: s.to }]));
      for (const id of Object.keys(x.expand(withField))) steps.push({ index, field: s.field, device: id, value: s.toFor?.[id] ?? s.to, ramp: true, explicit: id in s.targets, only: Object.keys(s.targets).length === 1 && id in s.targets, from: s.from });
    }
  });
  if (!steps.length) return [];
  const out: AutoSuggestion[] = [];
  const byDev = new Map<string, Step[]>();
  for (const s of steps) byDev.set(`${s.device}|${s.field}`, [...(byDev.get(`${s.device}|${s.field}`) ?? []), s]);
  for (const [key, devSteps] of byDev) {
    const [device, field] = key.split('|') as [string, NumericField];
    const log = x.state.filter(e => e.device === device);
    // Days the automation set this, and the person's changes after it.
    const setDays = new Set<string>();
    const days = new Map<string, { steps: { t: number; v: number }[]; lastAuto: number; step?: Step; ids: number[] }>();
    let lastOther: LogEntry | undefined;
    for (const e of log) {
      const p = patchOf(e) as Record<string, unknown>;
      if (!person.has(e.id)) {
        // The device catching up doesn't count as anyone setting it.
        if (e.cause.kind === 'device') continue;
        lastOther = e;
        if (e.cause.kind === 'automation' && e.cause.id === a.id && typeof p[field] === 'number' && ctx.usual(e.ts)) setDays.add(localDate(e.ts, tz));
        continue;
      }
      if (typeof p[field] !== 'number' || !lastOther || lastOther.cause.kind !== 'automation' || lastOther.cause.id !== a.id) continue;
      if (e.ts - lastOther.ts > LEARN.CORRECT_MIN * 60_000 || !ctx.usual(e.ts)) continue;
      const lastV = (patchOf(lastOther) as Record<string, unknown>)[field];
      const date = localDate(lastOther.ts, tz);
      const day = days.get(date) ?? { steps: [], lastAuto: typeof lastV === 'number' ? lastV : NaN, ids: [] };
      day.steps.push({ t: e.ts, v: p[field] as number });
      day.ids.push(e.id);
      if (typeof lastV === 'number') day.step = pickStep(devSteps, lastV) ?? day.step;
      days.set(date, day);
    }
    if (days.size < LEARN.MIN_DAYS_VALUE || days.size < LEARN.SHARE * setDays.size) continue;
    // Which step they correct: the one most days point at.
    const votes = new Map<number, number>();
    for (const d of days.values()) if (d.step) votes.set(d.step.index, (votes.get(d.step.index) ?? 0) + 1);
    const idx = [...votes.entries()].sort((p, q) => q[1] - p[1] || q[0] - p[0])[0]?.[0];
    const step = devSteps.find(s => s.index === idx) ?? devSteps[devSteps.length - 1];
    const finals = [...days.values()].map(d => d.steps[d.steps.length - 1].v);
    const unit = STEP[field]!;
    const want = Math.round(median(finals) / unit) * unit;
    if (Math.abs(want - step.value) < MIN_DIFF[field]!) continue;
    const below = finals.filter(v => v < step.value).length, above = finals.length - below;
    if (Math.max(below, above) < 0.8 * finals.length) continue;
    const lo = Math.min(...finals), hi = Math.max(...finals);
    if (hi - lo > (field === 'target' ? 4 : 35)) continue;
    // Gradual: several steps the same way over a few minutes, most days.
    const gradual = [...days.values()].filter(d => {
      const vs = d.steps.map(s => s.v);
      const mono = vs.every((v, i) => !i || (want < step.value ? v <= vs[i - 1] : v >= vs[i - 1]));
      return vs.length >= 3 && mono && d.steps[d.steps.length - 1].t - d.steps[0].t >= 3 * 60_000;
    });
    const asRamp = !step.ramp && gradual.length >= LEARN.SHARE * days.size;
    const overSec = asRamp ? Math.max(300, round5(median(gradual.map(d => (d.steps[d.steps.length - 1].t - d.steps[0].t) / 60_000))) * 60) : 0;
    const u = UNIT[field]!;
    const dev = nameOf(x, device);
    const rangeText = lo === hi ? `${lo}${u}` : `${lo}–${hi}${u}`;
    const sorted = [...days.entries()].sort((p, q) => p[0] < q[0] ? -1 : 1);
    const id = `learn:auto-value:${a.id}:${device}:${field}${String(want).replace('.', '_')}`;
    const fixWords = asRamp ? `Ease it to ${want}${u} over ${Math.round(overSec / 60)} min` : `Make it ${want}${u}`;
    out.push({
      id, kind: 'auto-value', automationId: a.id, device, days: sorted.map(d => d[0]), at: sorted[sorted.length - 1][1].steps[0].t,
      evidence: sorted.map(([date, d]) => ({ day: dayLabel(date, tz), text: `${clock(d.steps[0].t, tz)} · ${d.steps.length > 1 ? `${d.steps.map(s => `${s.v}${u}`).join(' → ')}` : `${d.steps[0].v}${u}`}${Number.isFinite(d.lastAuto) ? `, after it set ${d.lastAuto}${u}` : ''}` })),
      explains: sorted.flatMap(([, d]) => d.ids),
      title: `“${a.name}” could leave ${dev} at ${want}${u}`,
      body: `On ${days.size} of the ${plural(Math.max(setDays.size, days.size), 'day')} it set ${dev}, you changed the ${FIELD_WORD[field]} to ${rangeText} soon after${step.ramp ? ` (its ramp ends at ${step.value}${u})` : ` (it sets ${step.value}${u})`}.${asRamp ? ' You do it gradually, so Kova would ease it down the same way.' : ''}`,
      fix: fixWords,
      done: `${a.name} now takes ${dev.replace(/^the /, 'the ')} to ${want}${u}`,
      edit: c => editValue(c, a.id, step, want, asRamp ? overSec : 0, x),
    });
  }
  return out;
}

/** The step a value came from: an exact match first, else a ramp passing through it (the later step wins). */
function pickStep<S extends { index: number; value: number; ramp: boolean; from?: number }>(steps: S[], v: number): S | undefined {
  const exact = steps.filter(s => s.value === v);
  if (exact.length) return exact[exact.length - 1];
  const through = steps.filter(s => s.ramp && v >= Math.min(s.value, s.from ?? 0) && v <= Math.max(s.value, s.from ?? 100));
  return through[through.length - 1];
}

function editValue(c: HomeConfig, automationId: string, step: { index: number; field: NumericField; device: string; ramp: boolean; explicit: boolean; only: boolean }, want: number, overSec: number, x: LearnCtx): void {
  const a = c.automations?.find(q => q.id === automationId);
  const s = a?.actions[step.index];
  if (!a || !s) return;
  if (s.kind === 'ramp') {
    if (step.only) { s.to = want; for (const k of Object.keys(s.targets)) if ((s.targets[k] as Record<string, unknown>)[step.field] !== undefined) (s.targets[k] as Record<string, unknown>)[step.field] = want; }
    else s.toFor = { ...(s.toFor ?? {}), [step.device]: want };
    return;
  }
  if (s.kind !== 'set') return;
  if (overSec) {
    a.actions.splice(step.index + 1, 0, { kind: 'ramp', targets: { [step.device]: {} }, field: step.field, to: want, overSec, stepSec: 60 });
    return;
  }
  const base = step.explicit ? s.targets[step.device] : x.expand(s.targets)[step.device];
  // Added after a "type:light" target, so it wins for this one device.
  s.targets[step.device] = { ...(base ?? {}), [step.field]: want };
}

// --------------------------------------------------------------- 3. undone --

function undoing(a: Automation, x: LearnCtx, ctx: Context, person: Set<number>): AutoSuggestion[] {
  const tz = x.cfg.timezone;
  const out: AutoSuggestion[] = [];
  const seen = new Set<string>();
  for (const eff of setEffects(a, x)) {
    if (!(eff.cmd.on === true || eff.cmd.on === false || (typeof eff.cmd.media === 'string' && eff.cmd.media))) continue;
    if (seen.has(eff.device)) continue;
    seen.add(eff.device);
    const log = x.state.filter(e => e.device === eff.device);
    // One run per day: the automation's first change that day.
    const runs: { date: string; t: number; undone?: LogEntry }[] = [];
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e.cause.kind !== 'automation' || e.cause.id !== a.id || ranByHand(e) || !achieves(patchOf(e), eff.cmd)) continue;
      const date = localDate(e.ts, tz);
      if (runs.some(r => r.date === date) || !ctx.usual(e.ts)) continue;
      let undone: LogEntry | undefined;
      for (let j = i + 1; j < log.length && log[j].ts - e.ts <= LEARN.UNDO_MIN * 60_000; j++) {
        const q = log[j];
        if (person.has(q.id)) { if (reverses(patchOf(q), eff.cmd)) { undone = q; break; } continue; }
        if (q.cause.kind !== 'device' && !(q.cause.kind === 'automation' && q.cause.id === a.id)) break;
      }
      runs.push({ date, t: e.ts, undone });
    }
    const undone = runs.filter(r => r.undone), kept = runs.filter(r => !r.undone);
    if (undone.length < LEARN.MIN_DAYS_UNDO || undone.length < LEARN.SHARE * runs.length) continue;
    const dev = nameOf(x, eff.device);
    const how = eff.cmd.on === false ? 'turned it back on' : typeof eff.cmd.media === 'string' ? 'stopped it' : 'turned it off';
    const evidence = runs.map(r => ({ day: dayLabel(r.date, tz), text: r.undone ? `${clock(r.t, tz)} it ${VERB(eff.cmd, x.devices.get(eff.device))} ${dev}, ${clock(r.undone.ts, tz)} you ${how}` : `${clock(r.t, tz)} it ${VERB(eff.cmd, x.devices.get(eff.device))} ${dev}, you left it` }));
    const days = undone.map(r => r.date);
    const explains = undone.map(r => r.undone!.id);
    const base = `On ${undone.length} of the ${plural(runs.length, 'day')} it ${VERB(eff.cmd, x.devices.get(eff.device))} ${dev}, you ${how} within ${LEARN.UNDO_MIN} minutes`;
    const why = explain(a, x, ctx, undone.map(r => r.t), kept.map(r => r.t), eff.device);
    if (why) {
      const id = `learn:auto-condition:${a.id}:${eff.device}:${why.key}`;
      out.push({
        id, kind: 'auto-condition', automationId: a.id, device: eff.device, days, at: undone[undone.length - 1].t, evidence, explains,
        title: `“${a.name}” could run only ${why.when}`,
        body: `${base}, each time ${why.then}. On the days ${why.otherwise}, you left it.`,
        fix: `Only ${why.when}`,
        done: `${a.name} now runs only ${why.when}`,
        edit: c => { const y = c.automations?.find(q => q.id === a.id); if (y && !y.conditions.some(q => JSON.stringify(q) === JSON.stringify(why.condition))) y.conditions.push(why.condition); },
      });
    } else {
      const id = `learn:auto-pause:${a.id}:${eff.device}`;
      out.push({
        id, kind: 'auto-pause', automationId: a.id, device: eff.device, days, at: undone[undone.length - 1].t, evidence, explains,
        title: `You usually undo “${a.name}”`,
        body: `${base}. Nothing Kova can see explains when you keep it, so you may not need it. Pausing keeps it, switched off.`,
        fix: 'Pause it',
        done: `${a.name} paused`,
        edit: c => { const y = c.automations?.find(q => q.id === a.id); if (y) y.enabled = false; },
      });
    }
  }
  return out;
}

/** A condition that tells the undone runs from the kept ones: a TV on, an overlay on, the weekend. */
function explain(a: Automation, x: LearnCtx, ctx: Context, undone: number[], kept: number[], device: string): { key: string; condition: Condition; when: string; then: string; otherwise: string } | null {
  if (kept.length < 2) return null;
  const tz = x.cfg.timezone;
  const share = (ts: number[], f: (t: number) => boolean) => ts.filter(f).length / ts.length;
  const target = x.devices.get(device);
  // Someone watching a TV (in the same room first).
  const tvs = [...x.devices.values()].filter(d => (d.type === 'tv' || d.capabilities.includes('library')) && d.id !== device)
    .sort((p, q) => Number(q.room === target?.room) - Number(p.room === target?.room));
  for (const tv of tvs) {
    const on = (t: number) => onAt(x.state, tv.id, t) === true;
    if (share(undone, on) >= 0.8 && share(kept, t => !on(t)) >= 0.8) {
      const n = nameOf(x, tv.id);
      return { key: `tv-off:${tv.id}`, condition: { kind: 'device', device: tv.id, is: { on: false } }, when: `when nobody’s watching ${n}`, then: `${n} was on`, otherwise: `it was off` };
    }
  }
  // An overlay that was on.
  for (const o of x.cfg.overlays) {
    const on = (t: number) => ctx.overlayAt(t) === o.id;
    if (share(undone, on) >= 0.8 && share(kept, t => !on(t)) >= 0.8)
      return { key: `overlay-off:${o.id}`, condition: { kind: 'overlay', overlay: o.id, active: false }, when: `when ${o.name} is off`, then: `${o.name} was on`, otherwise: `it wasn’t` };
  }
  // The weekend.
  const weekend = (t: number) => { const [y, m, d] = localDate(t, tz).split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 || w === 6; };
  if (share(undone, weekend) >= 0.8 && share(kept, t => !weekend(t)) >= 0.8)
    return { key: 'weekdays', condition: { kind: 'time', days: [1, 2, 3, 4, 5] }, when: 'on weekdays', then: 'it was the weekend', otherwise: 'it was a weekday' };
  if (share(undone, t => !weekend(t)) >= 0.8 && share(kept, weekend) >= 0.8)
    return { key: 'weekends', condition: { kind: 'time', days: [0, 6] }, when: 'at weekends', then: 'it was a weekday', otherwise: 'it was the weekend' };
  void a;
  return null;
}

// --------------------------------------------------------------- 4. chains --

const chainKey = (c: Command): string | null => {
  if (c.on === false) return 'off';
  if (typeof c.media === 'string' && c.media) return `media:${norm(c.media)}`;
  if (c.media === null) return 'off';
  if (c.bri != null) return `bri${Math.round(c.bri / 10) * 10}`;
  if (c.on === true) return 'on';
  return null;
};

function chains(x: LearnCtx, ctx: Context, person: Set<number>, explained: Set<number>): AutoSuggestion[] {
  const tz = x.cfg.timezone;
  // A: a device turning on or off (anyone, any cause), once per flip.
  const flips: { device: string; on: boolean; ts: number }[] = [];
  const lastFlip = new Map<string, number>();
  for (const e of x.state) {
    const d = e.device ? x.devices.get(e.device) : undefined;
    if (!d || isSensor(d) || isCamera(d) || d.type === 'internet') continue;
    const p = patchOf(e), prev = prevOf(e);
    if (typeof p.on !== 'boolean' || prev.on !== !p.on) continue;
    const k = `${d.id}|${p.on}`;
    if (e.ts - (lastFlip.get(k) ?? -Infinity) < 60_000) continue;
    lastFlip.set(k, e.ts);
    flips.push({ device: d.id, on: p.on, ts: e.ts });
  }
  type Pair = { date: string; a: number; b: LogEntry };
  const pairs = new Map<string, Pair[]>();
  for (const e of x.state) {
    if (!person.has(e.id) || explained.has(e.id) || !ctx.usual(e.ts)) continue;
    const d = x.devices.get(e.device!);
    if (!d || d.hidden) continue;
    const bk = chainKey(patchOf(e));
    if (!bk) continue;
    for (const f of flips) {
      if (f.device === e.device || f.ts > e.ts - 5_000 || f.ts < e.ts - LEARN.CHAIN_MIN * 60_000) continue;
      // A device reporting a change half a minute after another turned off is most likely HDMI-CEC, not a person.
      if (e.cause.kind === 'device' && e.ts - f.ts < 30_000) continue;
      const key = `${f.device}|${f.on}|${e.device}|${bk}`;
      const list = pairs.get(key) ?? [];
      const date = localDate(e.ts, tz);
      if (!list.some(p => p.date === date)) list.push({ date, a: f.ts, b: e });
      pairs.set(key, list);
    }
  }
  const out: AutoSuggestion[] = [];
  const usedB = new Set<string>();
  const ranked = [...pairs.entries()].filter(([, l]) => l.length >= LEARN.MIN_DAYS_CHAIN).sort((p, q) => q[1].length - p[1].length);
  for (const [key, list] of ranked) {
    const [aDev, aOn, bDev, bk] = key.split('|');
    const on = aOn === 'true';
    if (usedB.has(`${bDev}|${bk}`)) continue;
    const aEvents = flips.filter(f => f.device === aDev && f.on === on && ctx.usual(f.ts));
    const aDays = new Set(aEvents.map(f => localDate(f.ts, tz)));
    if (list.length < LEARN.SHARE * aDays.size || list.length < 0.5 * aEvents.length) continue;
    // Already an automation for it?
    if ((x.cfg.automations ?? []).some(q => q.triggers.some(t => t.kind === 'device' && t.device === aDev && t.to?.on === on)
      && q.actions.some(s => s.kind === 'set' && Object.keys(x.expand(s.targets)).includes(bDev)))) continue;
    const target = representative(list.map(p => patchOf(p.b)));
    // An automation already does B (at a time, say): when it runs is the timing suggestion's business, not a new one.
    if ((x.cfg.automations ?? []).some(q => q.enabled && setEffects(q, x).some(e => e.device === bDev && achieves(target, e.cmd)))) continue;
    usedB.add(`${bDev}|${bk}`);
    const aName = nameOf(x, aDev), bName = nameOf(x, bDev);
    const verb = target.on === false || target.media === null ? 'turn off' : typeof target.media === 'string' ? `play ${target.media} on` : target.bri != null ? `set ${target.bri}% on` : 'turn on';
    const gaps = list.map(p => (p.b.ts - p.a) / 60_000);
    const clocks = list.map(p => minutesOf(p.b.ts, tz));
    const condition = timeBand(clocks);
    const name = `When ${aName.replace(/^the /, '')} turns ${on ? 'on' : 'off'}, ${verb} ${bName.replace(/^the /, '')}`;
    const autoId = `learned_${aDev}_${on ? 'on' : 'off'}_${bDev}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const id = `learn:chain:${aDev}:${on ? 'on' : 'off'}:${bDev}:${bk}`;
    const g = Math.max(1, Math.round(median(gaps)));
    out.push({
      id, kind: 'chain', device: bDev, days: list.map(p => p.date), at: list[list.length - 1].b.ts,
      evidence: list.map(p => ({ day: dayLabel(p.date, tz), text: `${clock(p.a, tz)} ${aName} turned ${on ? 'on' : 'off'}, ${clock(p.b.ts, tz)} you did ${bName}` })),
      explains: list.map(p => p.b.id),
      title: `When ${aName} turns ${on ? 'on' : 'off'}, ${verb} ${bName}?`,
      body: `On ${list.length} of the ${plural(aDays.size, 'day')} ${aName} turned ${on ? 'on' : 'off'}, you did ${bName} by hand about ${plural(g, 'minute')} later${condition ? `, always between ${condition.words}` : ''}. Kova can do it for you.`,
      fix: 'Make this automation',
      done: `${name}: added`,
      edit: c => {
        c.automations ??= [];
        c.automations = c.automations.filter(q => q.id !== autoId);
        c.automations.push({
          id: autoId, name, description: 'Learned from what you do by hand', enabled: true, mode: 'single',
          triggers: [{ kind: 'device', device: aDev, to: { on } }],
          conditions: condition ? [condition.condition] : [],
          actions: [{ kind: 'set', targets: { [bDev]: target } }],
        });
      },
    });
  }
  return out;
}

/** Every time inside a part of the day (≤ 6 h): a time condition around it, an hour either side. */
function timeBand(clocks: number[]): { condition: Condition; words: string } | null {
  // Find the smallest arc covering all times (they may cross midnight).
  const s = [...clocks].sort((a, b) => a - b);
  let gap = 0, at = 0;
  for (let i = 0; i < s.length; i++) { const g = (i + 1 < s.length ? s[i + 1] : s[0] + 1440) - s[i]; if (g > gap) { gap = g; at = i; } }
  const start = s[(at + 1) % s.length], end = s[at];
  const span = ((end - start) + 1440) % 1440;
  if (span > 6 * 60) return null;
  const after = hhmm(Math.floor((start - 60) / 5) * 5), before = hhmm(Math.ceil((end + 60) / 5) * 5);
  return { condition: { kind: 'time', after: { kind: 'time', at: after }, before: { kind: 'time', at: before } }, words: `${hhmm(start)} and ${hhmm(end)}` };
}

function representative(changes: Command[]): Command {
  const media = changes.find(c => typeof c.media === 'string' && c.media)?.media;
  if (media) return { on: true, media };
  const bri = changes.map(c => c.bri).filter((b): b is number => b != null);
  if (bri.length) return { on: true, bri: round5(median(bri)) };
  if (changes[0].on === false || changes[0].media === null) return changes[0].media === null ? { on: false, media: null } : { on: false };
  return { on: true };
}

