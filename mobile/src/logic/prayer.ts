// Prayer times as an opt-in part of Kova: whether they're on, the waqt card on Now, today's times, and the body
// Settings sends (PUT /api/prayer). Free of React Native so the tests run it under plain Node.
import type { PrayerName, PrayerView } from '../api/types';

export const PRAYER_LABEL: Record<PrayerName, string> = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
/** The day's times in order, sunrise among them. */
export const DAY_ORDER: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
/** The five prayers, which take an adjustment. */
export const ADJUSTABLE: PrayerName[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * Are prayer options shown? Only once prayer times are turned on: they're hidden while off, and when the hub
 * doesn't say (an older hub).
 */
export const prayerOn = (s: { prayer?: Pick<PrayerView, 'on'> | null } | null | undefined) => s?.prayer ? s.prayer.on : false;

/** How the home writes the time: its locale (BCP-47) and 12-hour or 24-hour clock. Unset: the phone's own. */
export interface ClockFormat { locale?: string; hour12?: boolean | null }
export const clockFormat = (h: { locale?: string; hour12?: boolean } | undefined): ClockFormat => ({ locale: h?.locale, hour12: h?.hour12 });

/** A Unix time on the home's clock: "18:04", or "6:04 PM" where the home uses a 12-hour clock. */
export function clockAt(ms: number, timezone?: string, fmt: ClockFormat = {}): string {
  const hc = fmt.hour12 == null ? {} : fmt.hour12 ? { hour12: true } : { hourCycle: 'h23' as const };
  try {
    return new Intl.DateTimeFormat(fmt.locale || undefined, { timeZone: timezone || undefined, hour: fmt.hour12 === false ? '2-digit' : 'numeric', minute: '2-digit', ...hc }).format(new Date(ms)).replace(/^24(?=\D)/, '00');
  } catch { /* no time zones here, or an unknown locale */ }
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How long until a time: "in 42 min", "in 1 h 5 min", "in 3 h"; "now" once it's here. Minutes round up, so it never says 0. */
export function countdown(ms: number, now: number): string {
  const m = Math.ceil((ms - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `in ${h} h${r ? ` ${r} min` : ''}`;
}

/** The waqt card: the current prayer, the next with a live countdown and its clock time. Null while off (or not known). */
export interface Waqt { current: string; next: string; /** "Maghrib in 42 min" */ caption: string; /** "in 42 min", or "now" */ left: string; at: string; soon: boolean }
export function waqtOf(p: PrayerView | null | undefined, now: number, timezone?: string, fmt?: ClockFormat): Waqt | null {
  if (!p?.on || !p.next) return null;
  const next = PRAYER_LABEL[p.next.prayer] ?? p.next.prayer;
  const current = p.current ? PRAYER_LABEL[p.current.prayer] ?? p.current.prayer : next;
  const left = countdown(p.next.at, now);
  return { current, next, caption: left === 'now' ? `${next} now` : `${next} ${left}`, left, at: clockAt(p.next.at, timezone, fmt), soon: p.next.at - now <= 15 * 60000 };
}

/** Today's times as rows, in the day's order, with the next one marked. */
export function todayTimes(p: PrayerView | null | undefined, timezone?: string, fmt?: ClockFormat): { prayer: PrayerName; label: string; at: string; next: boolean }[] {
  if (!p?.on || !p.times) return [];
  return DAY_ORDER.filter(k => p.times![k] != null).map(k => ({ prayer: k, label: PRAYER_LABEL[k], at: clockAt(p.times![k], timezone, fmt), next: p.next?.prayer === k }));
}

/** An adjustment kept to what the hub takes: whole minutes, -30 to 30 (0 drops it). */
export const clampAdjust = (n: number) => Math.max(-30, Math.min(30, Math.round(n || 0)));
export function withAdjust(adjust: Partial<Record<PrayerName, number>>, k: PrayerName, n: number): Partial<Record<PrayerName, number>> {
  const o = { ...adjust };
  const v = clampAdjust(n);
  if (v) o[k] = v; else delete o[k];
  return o;
}
export const adjustWords = (n: number | undefined) => !n ? 'As worked out' : `${Math.abs(n)} min ${n > 0 ? 'later' : 'earlier'}`;
/** The adjustments in a line: "Fajr 5 min later · Isha 10 min earlier", or none. */
export const adjustSummary = (a: Partial<Record<PrayerName, number>>) => ADJUSTABLE.filter(k => a[k]).map(k => `${PRAYER_LABEL[k]} ${adjustWords(a[k])}`).join(' · ') || 'None';

export const MADHABS: { id: 'shafi' | 'hanafi'; label: string; sub: string }[] = [
  { id: 'shafi', label: 'Standard', sub: 'Shafi’i, Maliki, Hanbali' },
  { id: 'hanafi', label: 'Hanafi', sub: 'Later Asr' },
];

/** A method's name, from the hub's list. */
export const methodLabel = (p: Pick<PrayerView, 'method' | 'methods'> | undefined) => p ? p.methods.find(m => m.id === p.method)?.label ?? p.method : '';

/** The line under "Prayer times" in Integrations and Settings. */
export function prayerSub(p: PrayerView | undefined): string {
  if (!p) return '';
  if (!p.on) return 'Off · turn on for prayer times in schedules, the call to prayer and Now';
  return [methodLabel(p), p.madhab === 'hanafi' ? 'Hanafi Asr' : ''].filter(Boolean).join(' · ');
}
