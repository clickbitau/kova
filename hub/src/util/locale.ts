import type { HomeConfig } from '../model/types.ts';

// How the home writes dates and times: its locale (day before month or after, the words) and 12- or 24-hour clocks.
// Set from the home's settings (`locale`, `hour12`); before the owner chooses, a guess from where the home is.

/** The home's locale: what the owner chose, else English the way the home's region writes dates. */
export function homeLocale(c: Pick<HomeConfig, 'locale' | 'timezone'>): string {
  if (c.locale) return c.locale;
  return /^America\/(?!Argentina|Sao_Paulo|Santiago|Bogota|Lima|Caracas|Montevideo|Asuncion|La_Paz)/.test(c.timezone) ? 'en-US' : 'en-GB';
}

/** Whether the home's clocks are 12-hour: the owner's choice, else its locale's habit. */
export function homeHour12(c: Pick<HomeConfig, 'locale' | 'timezone' | 'hour12'>): boolean {
  if (typeof c.hour12 === 'boolean') return c.hour12;
  try { return new Intl.DateTimeFormat(homeLocale(c), { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1') ?? false; } catch { return false; }
}

let style = { locale: 'en-GB', hour12: false, timezone: 'UTC' };
/** Follow the home's settings (the hub calls it on start and whenever the settings change). */
export function useHomeStyle(c: Pick<HomeConfig, 'locale' | 'timezone' | 'hour12'>): void { style = { locale: homeLocale(c), hour12: homeHour12(c), timezone: c.timezone || 'UTC' }; }
export const clockStyle = () => style;
/** The home's timezone, for an integration's cloud that wants it (a robot's schedules, an account's region). */
export const homeZone = () => style.timezone;
/** How far ahead of UTC the home's clock is now, in minutes (Perth: 480, New York in summer: −240). */
export function homeOffsetMinutes(now = Date.now()): number {
  try {
    const v = new Intl.DateTimeFormat('en', { timeZone: style.timezone, timeZoneName: 'longOffset' }).formatToParts(now).find(x => x.type === 'timeZoneName')?.value ?? '';
    const m = /([+-])(\d{2}):?(\d{2})?/.exec(v);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  } catch { return 0; }
}

/** A date in the home's way of writing it: "Wed 14 Oct", "Wed, Oct 14". Month names are never cut odd ("Sept"). */
export function dateWords(ms: number, tz: string, o: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return new Date(ms).toLocaleDateString(style.locale, { ...o, timeZone: tz }).replace(/\bSept\b/, 'Sep');
}
