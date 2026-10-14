// The day strip on Now: the hub's mode bands, ready to draw. Plain TypeScript, so the tests run it under Node.
import type { Snapshot } from '../api/types';

export interface DayBand { modeId: string; name: string; color: string; width: number; current: boolean; from: string }

const hhmm = (h: number) => {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * One band per stretch of the day in a mode, as a share of 24 hours. Bands of the same mode that touch are
 * joined, slivers under a minute dropped, and the band the clock is in now is marked current.
 */
export function dayBands(s: Pick<Snapshot, 'day' | 'modes' | 'home'>): DayBand[] {
  const out: DayBand[] = [];
  const now = s.home.nowHour;
  for (const b of s.day.bands) {
    if (b.end - b.start < 1 / 60) continue;
    const m = s.modes.find(x => x.id === b.modeId);
    const prev = out[out.length - 1];
    const width = (b.end - b.start) / 24;
    const current = now >= b.start && now < b.end;
    if (prev && prev.modeId === b.modeId) { prev.width += width; prev.current ||= current; continue; }
    out.push({ modeId: b.modeId, name: m?.name ?? b.modeId, color: m?.color ?? '#a3a09a', width, current, from: hhmm(b.start) });
  }
  return out;
}

/** A date short, in the home's language: "Wed, Sep 30" or "Wed 30 Sep". Falls back to the hub's own words when it can't. */
export function shortDate(h: Pick<Snapshot['home'], 'date' | 'dateLabel' | 'locale'>): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h.date ?? '');
  if (m) {
    try { return new Intl.DateTimeFormat(h.locale || undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 12))); } catch { /* an engine without this locale */ }
  }
  return h.dateLabel;
}

/** The hour marks under a day strip, as the home writes hours: "06", or "6 AM" with 12-hour clocks. */
export const hourMarks = (hour12?: boolean): string[] => [0, 6, 12, 18, 24].map(h => !hour12 ? String(h).padStart(2, '0') : h % 24 === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`);
