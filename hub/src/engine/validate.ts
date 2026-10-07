import type { Command, Device, Rhythm } from '../model/types.ts';
import { fitCommand } from '../util/describe.ts';

// Checks for anything a person edits: rhythms and device targets.

const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const SUN = ['sunrise', 'sunset', 'dawn', 'dusk'];

export function validRhythm(r: unknown): r is Rhythm {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  const off = x.offsetMin === undefined || (typeof x.offsetMin === 'number' && Math.abs(x.offsetMin) <= 240);
  if (x.kind === 'time') return typeof x.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.at);
  if (x.kind === 'sun') return SUN.includes(String(x.event)) && off;
  if (x.kind === 'prayer') return PRAYERS.includes(String(x.prayer)) && off;
  return false;
}

const OFFSET_MAX = 240;

/** Minutes either side of a sun or prayer time, from the shapes models and people send: offsetMin, offset, minutes, before/after. */
function offsetOf(x: Record<string, unknown>): number | undefined | null {
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
  for (const k of ['offsetMin', 'offset', 'offsetMinutes', 'offset_min', 'minutes', 'mins']) {
    if (x[k] === undefined || x[k] === null || x[k] === '') continue;
    const n = num(x[k]);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  // { before: 15 } is 15 minutes before; { after: 15 } after. Only when one is given.
  const b = num(x.before), a = num(x.after);
  if (Number.isFinite(b) && x.after === undefined) return -Math.abs(Math.round(b));
  if (Number.isFinite(a) && x.before === undefined) return Math.abs(Math.round(a));
  return undefined;
}

/** "sunset", "sunset-15", "sunset + 30", "15 min before sunset", "30 minutes after sunrise", "isha+10". */
function rhythmWords(s: string): Rhythm | undefined {
  const named = (w: string, off?: number): Rhythm | undefined => {
    const o = off ? { offsetMin: off } : {};
    if (SUN.includes(w)) return { kind: 'sun', event: w as 'sunrise', ...o };
    if (PRAYERS.includes(w)) return { kind: 'prayer', prayer: w as 'fajr', ...o };
    return undefined;
  };
  let m = /^([a-z]+)\s*([+-])\s*(\d{1,3})\s*(m|min|mins|minutes?)?$/.exec(s);
  if (m) return named(m[1]!, (m[2] === '-' ? -1 : 1) * Number(m[3]));
  m = /^(\d{1,3})\s*(m|min|mins|minutes?)\s+(before|after)\s+([a-z]+)$/.exec(s);
  if (m) return named(m[4]!, (m[3] === 'before' ? -1 : 1) * Number(m[1]));
  m = /^(an?|one) hour\s+(before|after)\s+([a-z]+)$/.exec(s);
  if (m) return named(m[3]!, m[2] === 'before' ? -60 : 60);
  return named(s);
}

/**
 * A Rhythm given loosely — "21:00", "9:05", "sunset", "isha", "sunset-15", "15 min before sunset", or an object:
 * the full one, or a near miss ({kind:'sun', event:'sunset', offset:-15}, {event:'sunset', before:15},
 * {kind:'time', at:'sunset-15'}, {kind:'prayer', event:'isha'}). Undefined when it can't be read; an offset
 * beyond four hours is not read.
 */
export function rhythm(r: unknown): Rhythm | undefined {
  if (typeof r === 'string') {
    const s = r.trim().toLowerCase().replace(/\s+/g, ' ');
    const hm = /^(\d{1,2}):([0-5]\d)$/.exec(s);
    if (hm && Number(hm[1]) <= 23) return { kind: 'time', at: `${hm[1]!.padStart(2, '0')}:${hm[2]}` };
    const out = rhythmWords(s);
    return out && validRhythm(out) ? out : undefined;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const x = r as Record<string, unknown>;
  if (x.kind === 'time' && validRhythm(r)) return { kind: 'time', at: String(x.at) };
  if (x.kind === 'time' || (x.kind === undefined && x.at !== undefined)) {
    const inner = rhythm(x.at);
    if (!inner) return undefined;
    const off = offsetOf(x);
    if (off && inner.kind !== 'time') return rhythm({ ...inner, offsetMin: (inner.offsetMin ?? 0) + off });
    return inner;
  }
  const word = String(x.event ?? x.prayer ?? x.sun ?? (x.kind !== 'sun' && x.kind !== 'prayer' ? x.kind : '') ?? '').trim().toLowerCase();
  const base = rhythmWords(word);
  if (!base || base.kind === 'time') return undefined;
  const off = offsetOf(x);
  if (off === null) return undefined;
  const total = (base.offsetMin ?? 0) + (off ?? 0);
  const out: Rhythm = base.kind === 'sun' ? { kind: 'sun', event: base.event, ...(total ? { offsetMin: total } : {}) } : { kind: 'prayer', prayer: base.prayer, ...(total ? { offsetMin: total } : {}) };
  return validRhythm(out) ? out : undefined;
}

/** Does this look like a sun or prayer time (a trigger or condition sent as a bare rhythm)? */
export function isRhythmShape(v: unknown): boolean {
  if (typeof v === 'string') return !!rhythm(v);
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  const k = String(x.kind ?? '').toLowerCase();
  return k === 'sun' || k === 'prayer' || SUN.includes(k) || PRAYERS.includes(k) || (!x.kind && (SUN.includes(String(x.event)) || PRAYERS.includes(String(x.prayer ?? x.event))));
}

/** An offset that's out of range, for the error. */
export const OFFSET_LIMIT = OFFSET_MAX;

/** Clean a target so it only sets things the device can do, in range. Throws on nonsense. */
export function cleanTarget(d: Device, cmd: Command): Command {
  const c = fitCommand(d, cmd);
  if (c.bri != null) c.bri = Math.max(1, Math.min(100, Math.round(Number(c.bri))));
  if (c.vol != null) c.vol = Math.max(0, Math.min(100, Math.round(Number(c.vol))));
  if (c.zoneSet != null) {
    if (typeof c.zoneSet !== 'object') throw new Error('Zones must be { "1": { on, open } }');
    const z: NonNullable<Command['zoneSet']> = {};
    for (const [n, v] of Object.entries(c.zoneSet)) {
      if (!/^[1-9]\d?$/.test(n) || !v || typeof v !== 'object') throw new Error(`Zone ${n} isn’t valid`);
      z[n] = { ...(typeof v.on === 'boolean' ? { on: v.on } : {}), ...(v.open != null ? { open: Math.max(0, Math.min(100, Math.round(Number(v.open)))) } : {}) };
    }
    c.zoneSet = z;
  }
  if (c.extras != null) {
    if (typeof c.extras !== 'object' || Array.isArray(c.extras)) throw new Error('Extras must be { name: value }');
    const ex: NonNullable<Command['extras']> = {};
    for (const [k, v] of Object.entries(c.extras)) {
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v)) ex[k] = v;
    }
    if (Object.keys(ex).length) c.extras = ex; else delete c.extras;
  }
  if (c.k != null) c.k = Math.max(1500, Math.min(9000, Math.round(Number(c.k))));
  if (c.color != null && !/^#[0-9a-f]{6}$/i.test(String(c.color))) throw new Error('Colour must be #rrggbb');
  if (!Object.keys(c).length) throw new Error(`${d.name} can't do that`);
  return c;
}
