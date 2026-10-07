import type { ConfigStore } from '../engine/config.ts';
import type { HomeConfig, PrayerName, PrayerSettings } from '../model/types.ts';
import { PRAYER_METHOD_LABELS, prayerNow } from '../rhythms/rhythms.ts';

// Prayer times as an integration of their own (Integrations → Prayer times), off unless the owner turns it on. While
// it's off, nothing about prayer shows: no waqt card on Now, no prayer triggers in the editors or Ask Kova, no adhan
// choices. Schedules already set by a prayer time keep running whether it's on or off (rhythms resolve as before).

export const DEFAULT_METHOD = 'MuslimWorldLeague';
const ALL: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

/** Is a prayer time used anywhere in the home: a mode's start, a moment, an overlay's end, an automation? */
export function homeUsesPrayer(c: HomeConfig): boolean {
  return JSON.stringify([c.modes, c.moments, c.overlays, c.automations ?? []]).includes('"kind":"prayer"');
}

/**
 * Once, for a home from before prayer times were an integration: on when the home already uses a prayer time, or
 * its prayer method was changed from the default (someone cared), so nothing it does stops showing.
 */
export function migratePrayer(config: ConfigStore): void {
  const c = config.get();
  if (c.prayer) return;
  const on = homeUsesPrayer(c) || (!!c.prayerMethod && c.prayerMethod !== DEFAULT_METHOD);
  config.update(x => { x.prayer = { on }; });
}

export const prayerOn = (c: Pick<HomeConfig, 'prayer'>) => !!c.prayer?.on;

/** What the screens show (the snapshot's `prayer`): the settings, and while on, today's times and the waqt now. */
export function prayerView(c: HomeConfig, now: number) {
  const p = c.prayer ?? { on: false };
  const base = {
    on: !!p.on, method: c.prayerMethod ?? DEFAULT_METHOD,
    methods: Object.entries(PRAYER_METHOD_LABELS).map(([id, label]) => ({ id, label })),
    madhab: p.madhab ?? 'shafi', adjust: p.adjust ?? {}, adhan: p.adhan ?? {},
  };
  if (!p.on) return base;
  const w = prayerNow(now, c);
  return { ...base, times: w.times, ...(w.current ? { current: w.current } : {}), ...(w.next ? { next: w.next } : {}) };
}

export interface PrayerPatch {
  on?: boolean; method?: string; madhab?: 'shafi' | 'hanafi';
  adjust?: Partial<Record<PrayerName, number | null>>;
  adhan?: { media?: string | null; fajr?: string | null };
}

/** Apply a change from the Prayer times panel. Throws with a sentence a person can act on. */
export function applyPrayer(c: HomeConfig, b: PrayerPatch, mediaProblem: (m: string) => string | null): void {
  if (b.on !== undefined && typeof b.on !== 'boolean') throw new Error('on must be true or false');
  if (b.method !== undefined && !(b.method in PRAYER_METHOD_LABELS)) throw new Error(`The calculation method is one of ${Object.keys(PRAYER_METHOD_LABELS).join(', ')}`);
  if (b.madhab !== undefined && b.madhab !== 'shafi' && b.madhab !== 'hanafi') throw new Error('The Asr method is shafi (standard) or hanafi');
  const adjust: Partial<Record<PrayerName, number>> = { ...(c.prayer?.adjust ?? {}) };
  for (const [k, v] of Object.entries(b.adjust ?? {})) {
    if (!ALL.includes(k as PrayerName)) throw new Error(`${k} isn’t a prayer time`);
    if (v === null || v === 0) { delete adjust[k as PrayerName]; continue; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < -30 || v > 30) throw new Error(`${k}: adjust by whole minutes, -30 to 30`);
    adjust[k as PrayerName] = v;
  }
  const adhan = { ...(c.prayer?.adhan ?? {}) };
  for (const k of ['media', 'fajr'] as const) {
    const v = b.adhan?.[k];
    if (v === undefined) continue;
    if (v === null || v === '') { delete adhan[k]; continue; }
    if (typeof v !== 'string') throw new Error('Choose the call to prayer by its name');
    const bad = mediaProblem(v);
    if (bad) throw new Error(`The call to prayer: ${bad}`);
    adhan[k] = v;
  }
  if (adhan.fajr && adhan.fajr === adhan.media) delete adhan.fajr;
  const next: PrayerSettings = { on: b.on ?? !!c.prayer?.on };
  const madhab = b.madhab ?? c.prayer?.madhab;
  if (madhab && madhab !== 'shafi') next.madhab = madhab;
  if (Object.keys(adjust).length) next.adjust = adjust;
  if (Object.keys(adhan).length) next.adhan = adhan;
  c.prayer = next;
  if (b.method) c.prayerMethod = b.method;
}
