import SunCalc from 'suncalc';
import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from 'adhan';
import type { HomeConfig, PrayerName, Rhythm } from '../model/types.ts';
import { addDays, atLocal, localDate, parseClock } from '../util/time.ts';

type Place = Pick<HomeConfig, 'timezone' | 'latitude' | 'longitude' | 'prayerMethod'> & Partial<Pick<HomeConfig, 'prayer'>>;

function prayerParams(place: Pick<Place, 'prayerMethod' | 'prayer'>) {
  const fn = (CalculationMethod as unknown as Record<string, () => ReturnType<typeof CalculationMethod.MuslimWorldLeague>>)[place.prayerMethod ?? 'MuslimWorldLeague'];
  const p = (fn ?? CalculationMethod.MuslimWorldLeague)();
  if (place.prayer?.madhab === 'hanafi') p.madhab = Madhab.Hanafi;
  for (const [k, v] of Object.entries(place.prayer?.adjust ?? {})) if (typeof v === 'number' && k in p.adjustments) (p.adjustments as Record<string, number>)[k] = v;
  return p;
}

/** The calculation methods Kova offers, with their names. */
export const PRAYER_METHOD_LABELS: Record<string, string> = {
  MuslimWorldLeague: 'Muslim World League', Egyptian: 'Egyptian General Authority', Karachi: 'University of Islamic Sciences, Karachi',
  UmmAlQura: 'Umm al-Qura, Makkah', Dubai: 'Dubai', MoonsightingCommittee: 'Moonsighting Committee', NorthAmerica: 'ISNA (North America)',
  Kuwait: 'Kuwait', Qatar: 'Qatar', Singapore: 'Singapore (MUIS)', Tehran: 'Tehran', Turkey: 'Diyanet (Turkey)',
};

export const PRAYER_NAMES: Record<PrayerName, string> = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
const ORDER: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

/** A local date's six times (Fajr … Isha, with sunrise), Unix ms. */
export function prayerDay(date: string, place: Place): Partial<Record<PrayerName, number>> {
  const out: Partial<Record<PrayerName, number>> = {};
  for (const p of ORDER) { const t = resolveRhythm({ kind: 'prayer', prayer: p }, date, place); if (t != null) out[p] = t; }
  return out;
}

/**
 * The waqt now: today's times, the one that has begun (before Fajr: yesterday's Isha) and the next (after Isha:
 * tomorrow's Fajr). Sunrise counts as a time, so the next after Fajr is Sunrise.
 */
export function prayerNow(now: number, place: Place): { times: Partial<Record<PrayerName, number>>; current: { prayer: PrayerName; at: number } | null; next: { prayer: PrayerName; at: number } | null } {
  const today = localDate(now, place.timezone);
  const times = prayerDay(today, place);
  const list = ORDER.filter(p => times[p] != null).map(p => ({ prayer: p, at: times[p]! }));
  const past = list.filter(x => x.at <= now), ahead = list.filter(x => x.at > now);
  let current = past[past.length - 1] ?? null;
  if (!current) { const y = prayerDay(addDays(today, -1), place); if (y.isha != null) current = { prayer: 'isha', at: y.isha }; }
  let next = ahead[0] ?? null;
  if (!next) { const t = prayerDay(addDays(today, 1), place); if (t.fajr != null) next = { prayer: 'fajr', at: t.fajr }; }
  return { times, current, next };
}

/** Resolve a rhythm to an instant on a local calendar date. Returns null if it doesn't happen (polar day/night). */
export function resolveRhythm(r: Rhythm, date: string, place: Place): number | null {
  const offset = ('offsetMin' in r ? r.offsetMin ?? 0 : 0) * 60_000;
  if (r.kind === 'time') return atLocal(date, parseClock(r.at), place.timezone);
  if (r.kind === 'sun') {
    const noon = atLocal(date, 12, place.timezone);
    const t = SunCalc.getTimes(new Date(noon), place.latitude, place.longitude);
    const d = { sunrise: t.sunrise, sunset: t.sunset, dawn: t.dawn, dusk: t.dusk }[r.event];
    const ms = d?.getTime();
    return ms == null || Number.isNaN(ms) ? null : ms + offset;
  }
  // adhan reads the calendar components of the Date in the process timezone.
  const [y, m, d] = date.split('-').map(Number);
  const times = new PrayerTimes(new Coordinates(place.latitude, place.longitude), new Date(y, m - 1, d), prayerParams(place));
  const ms = times[r.prayer]?.getTime();
  return ms == null || Number.isNaN(ms) ? null : ms + offset;
}

/** Short label for a rhythm: "20:00", "10 min before sunset", "Fajr". */
export function rhythmLabel(r: Rhythm): string {
  if (r.kind === 'time') return r.at;
  const name = r.kind === 'sun' ? r.event : r.prayer[0].toUpperCase() + r.prayer.slice(1);
  const off = r.offsetMin ?? 0;
  if (!off) return r.kind === 'sun' ? (r.event === 'sunrise' || r.event === 'sunset' ? `At ${name}` : name) : name;
  return `${Math.abs(off)} min ${off < 0 ? 'before' : 'after'} ${name}`;
}

/** Lower-case variant used mid-sentence ("ends at sunrise"). */
export function rhythmPhrase(r: Rhythm): string {
  const l = rhythmLabel(r);
  return l.startsWith('At ') ? l.slice(3) : l;
}
