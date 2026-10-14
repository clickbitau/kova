import { clockStyle } from './locale.ts';
// Wall-clock helpers for a home's timezone, without a date library.

interface Parts { y: number; m: number; d: number; h: number; mi: number; s: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): Parts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Local calendar date ("YYYY-MM-DD") of an instant in the home's timezone. */
export function localDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Local hour of day as a float (19.5 = 19:30). */
export function localHour(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return p.h + p.mi / 60 + p.s / 3600;
}

/** The instant at which the wall clock in `tz` reads `hour` on `date`. */
export function atLocal(date: string, hour: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + Math.round(hour * 3600_000);
  const first = guess - offsetMs(guess, tz);
  // Re-check once so DST transitions land on the right side.
  return guess - offsetMs(first, tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** The time of an instant in the home's timezone, as the home writes it: "15:30", or "3:30 pm" with 12-hour clocks. */
export function clock(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return clockStyle().hour12 ? hm12(p.h, p.mi) : `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** A wall-clock time ("15:30", as settings keep it) as the home writes it. */
export function clockWords(at: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  return m && clockStyle().hour12 ? hm12(Number(m[1]), Number(m[2])) : at;
}
/** A 12-hour time the way the home's language writes it: "3:30 PM" (US), "3:30 pm" (UK, Australia). */
const hm12 = (h: number, mi: number) => {
  try { return new Intl.DateTimeFormat(clockStyle().locale, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, h, mi)).replace(/\u202f|\u00a0/g, ' '); }
  catch { return `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; }
};

export function parseClock(at: string): number {
  const [h, m] = at.split(':').map(Number);
  return h + (m || 0) / 60;
}

/** A local date and time ("2026-10-08T15:30"), as one-time schedules keep it. */
export const LOCAL_STAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** The local date and time of an instant in `tz`, to the minute. */
export function localStamp(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${localDate(ms, tz)}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** The instant a local date and time ("2026-10-08T15:30") falls at in `tz`; null when it isn't one. */
export function stampAt(stamp: string, tz: string): number | null {
  const m = LOCAL_STAMP.exec(stamp);
  if (!m) return null;
  const ms = atLocal(m[1]!, Number(m[2]) + Number(m[3]) / 60, tz);
  return Number.isFinite(ms) ? ms : null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When something happened, as a list shows it: "15:30" today, "yesterday at 15:30", "Mon 12 Oct at 15:30" before. */
export function pastWords(ms: number, now: number, tz: string): string {
  const day = localDate(ms, tz), today = localDate(now, tz);
  if (day === today) return clock(ms, tz);
  const at = clock(ms, tz);
  if (day === addDays(today, -1)) return `yesterday at ${at}`;
  const [y, mo, d] = day.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo! - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''} at ${at}`;
}

/** A local date and time in words, near `now`: "today at 15:30", "tomorrow at 07:00", "Thu 15 Oct at 09:00". */
export function stampWords(stamp: string, now: number, tz: string): string {
  const m = LOCAL_STAMP.exec(stamp);
  if (!m) return stamp;
  const date = m[1]!, time = `${m[2]}:${m[3]}`, today = localDate(now, tz);
  if (date === today) return `today at ${time}`;
  if (date === addDays(today, 1)) return `tomorrow at ${time}`;
  const [y, mo, d] = date.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo! - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''} at ${time}`;
}
