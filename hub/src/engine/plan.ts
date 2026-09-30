import type { Device, HomeConfig, Mode, PlanItem, Targets } from '../model/types.ts';
import { resolveRhythm } from '../rhythms/rhythms.ts';
import { addDays, atLocal, localDate } from '../util/time.ts';
import { isLight, isPlayer } from '../util/describe.ts';

/**
 * A "Kova day" runs from the first mode's start (normally sunrise) to the
 * same point the next day. Modes happen in the order they're listed; a mode
 * whose time would land out of order (e.g. sunset after "20:00" in a northern
 * summer) is skipped for that day rather than reordered.
 */
export interface KovaDay {
  date: string;
  start: number;
  end: number;
  modes: { mode: Mode; at: number }[];
  items: PlanItem[];
}

export interface ModeNow {
  mode: Mode;
  since: number;
  until: number;
  next: Mode;
  kovaDate: string;
}

/** Short summary of what a set of targets does: "6 lights on, Lamp 78%". */
export function summarize(targets: Targets, devices: Map<string, Device>): string {
  let lightsOn = 0, lightsOff = 0;
  const dims: string[] = [];
  const play = new Map<string, { n: number; vol?: number | null }>();
  let stop = 0;
  const fans = new Set<string>();
  for (const [id, t] of Object.entries(targets)) {
    const d = devices.get(id);
    if (!d) continue;
    if (isLight(d)) {
      if (t.on === false) lightsOff++;
      else if (t.bri != null && t.bri < 100) dims.push(`${d.name} ${t.bri}%`);
      else lightsOn++;
    } else if (isPlayer(d)) {
      if (t.on === false || t.media === null) stop++;
      else if (t.media) { const p = play.get(t.media) ?? { n: 0, vol: t.vol }; p.n++; play.set(t.media, p); }
    } else if (d.type === 'fan' && t.mode) fans.add(t.mode);
  }
  const parts: string[] = [];
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  if (lightsOff && !lightsOn && !dims.length && lightsOff > 3) parts.push('All lights off');
  else {
    if (lightsOn) parts.push(`${n(lightsOn, 'light', 'lights')} on`);
    if (lightsOff) parts.push(`${n(lightsOff, 'light', 'lights')} off`);
  }
  parts.push(...dims.slice(0, 2));
  for (const [media, p] of play) parts.push(`${media} on ${p.n === 1 ? 'a speaker' : `${p.n} speakers`}${p.vol != null ? ` at ${p.vol}%` : ''}`);
  if (stop) parts.push(`${n(stop, 'speaker stops', 'speakers stop')}`);
  if (fans.size) parts.push(`purifiers to ${[...fans].join(' / ')}`);
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'No device changes';
}

export class Planner {
  private cache = new Map<string, KovaDay>();

  constructor(private cfg: () => HomeConfig, private devices: () => Map<string, Device>) {}

  /** Call whenever modes, moments or devices change. */
  invalidate(): void { this.cache.clear(); }

  private firstStart(date: string): number {
    const c = this.cfg();
    return resolveRhythm(c.modes[0].start, date, c) ?? atLocal(date, 6, c.timezone);
  }

  kovaDay(date: string): KovaDay {
    const hit = this.cache.get(date);
    if (hit) return hit;
    const c = this.cfg();
    const start = this.firstStart(date);
    const end = this.firstStart(addDays(date, 1));
    // Resolve on this date; if that's before where we are in the sequence, try tomorrow's date.
    const place = (r: Mode['start'], after: number): number | null => {
      const t = resolveRhythm(r, date, c);
      if (t != null && t >= after && t < end) return t;
      const t2 = resolveRhythm(r, addDays(date, 1), c);
      if (t2 != null && t2 >= after && t2 < end) return t2;
      return null;
    };
    const modes: KovaDay['modes'] = [{ mode: c.modes[0], at: start }];
    let prev = start;
    for (const m of c.modes.slice(1)) {
      const at = place(m.start, prev);
      if (at == null) continue;
      modes.push({ mode: m, at });
      prev = at;
    }
    const devs = this.devices();
    const modeAtIn = (t: number) => [...modes].reverse().find(x => x.at <= t)?.mode ?? modes[0].mode;
    const items: PlanItem[] = modes.map(({ mode, at }) => ({
      id: `mode:${mode.id}@${date}`, kind: 'mode', refId: mode.id, at, modeId: mode.id,
      label: mode === c.modes[0] ? `${mode.name} starts` : `${mode.name}`,
      what: summarize(mode.targets, devs), targets: mode.targets,
    }));
    for (const mo of c.moments) {
      const at = place(mo.at, start);
      if (at == null) continue;
      items.push({ id: `moment:${mo.id}@${date}`, kind: 'moment', refId: mo.id, at, modeId: modeAtIn(at).id, label: mo.label, what: mo.what, targets: mo.targets });
    }
    items.sort((a, b) => a.at - b.at);
    const day = { date, start, end, modes, items };
    this.cache.set(date, day);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return day;
  }

  kovaDayAt(t: number): KovaDay {
    const date = localDate(t, this.cfg().timezone);
    const kd = this.kovaDay(date);
    return t < kd.start ? this.kovaDay(addDays(date, -1)) : kd;
  }

  modeAt(t: number): ModeNow {
    const kd = this.kovaDayAt(t);
    const i = kd.modes.findLastIndex(x => x.at <= t);
    const cur = kd.modes[Math.max(0, i)];
    const nextEntry = kd.modes[i + 1] ?? this.kovaDay(addDays(kd.date, 1)).modes[0];
    return { mode: cur.mode, since: cur.at, until: nextEntry.at, next: nextEntry.mode, kovaDate: kd.date };
  }

  /** Plan items with from < at <= to. */
  itemsBetween(from: number, to: number): PlanItem[] {
    const tz = this.cfg().timezone;
    const out: PlanItem[] = [];
    for (let d = addDays(localDate(from, tz), -1); d <= localDate(to, tz); d = addDays(d, 1)) {
      out.push(...this.kovaDay(d).items.filter(x => x.at > from && x.at <= to));
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Mode bands for a calendar date, as hours from local midnight. */
  bands(date: string): { modeId: string; start: number; end: number }[] {
    const tz = this.cfg().timezone;
    const from = atLocal(date, 0, tz), to = atLocal(addDays(date, 1), 0, tz);
    const out: { modeId: string; start: number; end: number }[] = [];
    for (const d of [addDays(date, -1), date]) {
      const kd = this.kovaDay(d);
      kd.modes.forEach((m, i) => {
        const a = Math.max(m.at, from), b = Math.min(kd.modes[i + 1]?.at ?? kd.end, to);
        if (b > a) out.push({ modeId: m.mode.id, start: (a - from) / 3600_000, end: (b - from) / 3600_000 });
      });
    }
    return out;
  }
}
