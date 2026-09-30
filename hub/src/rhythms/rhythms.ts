import SunCalc from 'suncalc';
import { CalculationMethod, Coordinates, PrayerTimes } from 'adhan';
import type { HomeConfig, Rhythm } from '../model/types.ts';
import { atLocal, parseClock } from '../util/time.ts';

type Place = Pick<HomeConfig, 'timezone' | 'latitude' | 'longitude' | 'prayerMethod'>;

function prayerParams(method?: string) {
  const fn = (CalculationMethod as unknown as Record<string, () => ReturnType<typeof CalculationMethod.MuslimWorldLeague>>)[method ?? 'MuslimWorldLeague'];
  return (fn ?? CalculationMethod.MuslimWorldLeague)();
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
  const times = new PrayerTimes(new Coordinates(place.latitude, place.longitude), new Date(y, m - 1, d), prayerParams(place.prayerMethod));
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
