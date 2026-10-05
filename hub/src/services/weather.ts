import { EventEmitter } from 'node:events';
import type { HomeConfig } from '../model/types.ts';
import { localDate } from '../util/time.ts';

/** Now, outside. Feels-like, humidity (%), wind (km/h) and UV when met.no gives them. */
export interface WeatherNow { temp: number; text: string; icon: string; feels?: number; humidity?: number; wind?: number; uv?: number }

/**
 * The rest of today, outside: high and low, the strongest UV, and rain: when it's expected to start (the first hour
 * with at least 0.2 mm), how much in all, and the chance when the forecast gives one (met.no does for some regions).
 */
export interface WeatherToday { high: number; low: number; uvMax: number | null; rain: { from: number; mm: number; chance: number | null } | null }

// Met.no symbol codes → short text and a Material Symbols icon.
const SYMBOLS: [RegExp, string, string][] = [
  [/thunder/, 'Storms', 'thunderstorm'],
  [/snow|sleet/, 'Snow', 'weather_snowy'],
  [/rain/, 'Rain', 'rainy'],
  [/fog/, 'Fog', 'foggy'],
  [/clearsky_night/, 'Clear', 'bedtime'],
  [/clearsky|fair_day/, 'Sunny', 'sunny'],
  [/fair_night/, 'Clear', 'bedtime'],
  [/partlycloudy/, 'Partly cloudy', 'partly_cloudy_day'],
  [/cloudy/, 'Cloudy', 'cloud'],
];

interface Step {
  time: string;
  data: {
    instant: { details: Record<string, number> };
    next_1_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number; probability_of_precipitation?: number } };
    next_6_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number; probability_of_precipitation?: number; air_temperature_max?: number; air_temperature_min?: number } };
  };
}

/** Today (the home's local date) from met.no's timeseries: now, and the day's high, low, UV and rain from `now` on. */
export function summarise(steps: Step[], now: number, tz: string): { current: WeatherNow; today: WeatherToday } | null {
  const first = steps.find(s => Date.parse(s.time) + 3600_000 > now) ?? steps[0];
  if (!first) return null;
  const d = first.data.instant.details;
  const code = first.data.next_1_hours?.summary.symbol_code ?? first.data.next_6_hours?.summary.symbol_code ?? 'cloudy';
  const [, text, icon] = SYMBOLS.find(([re]) => re.test(code)) ?? [null, 'Cloudy', 'cloud'];
  const r = (v: number | undefined) => (typeof v === 'number' ? Math.round(v) : undefined);
  const current: WeatherNow = {
    temp: Math.round(d.air_temperature), text, icon,
    ...(d.apparent_air_temperature != null ? { feels: r(d.apparent_air_temperature) } : {}),
    ...(d.relative_humidity != null ? { humidity: r(d.relative_humidity) } : {}),
    ...(d.wind_speed != null ? { wind: Math.round(d.wind_speed * 3.6) } : {}),
    ...(d.ultraviolet_index_clear_sky != null ? { uv: Math.round(d.ultraviolet_index_clear_sky * 10) / 10 } : {}),
  };
  const today = localDate(now, tz);
  const day = steps.filter(s => localDate(Date.parse(s.time), tz) === today);
  const temps = day.map(s => s.data.instant.details.air_temperature).filter((t): t is number => typeof t === 'number');
  const uvs = day.map(s => s.data.instant.details.ultraviolet_index_clear_sky).filter((t): t is number => typeof t === 'number');
  // Rain from now to the end of today, hour by hour.
  const ahead = day.filter(s => Date.parse(s.time) + 3600_000 > now);
  let rain: WeatherToday['rain'] = null;
  for (const s of ahead) {
    const n1 = s.data.next_1_hours?.details;
    const mm = n1?.precipitation_amount ?? 0;
    const wet = mm >= 0.2 || /rain|sleet|thunder/.test(s.data.next_1_hours?.summary.symbol_code ?? '');
    if (!wet) continue;
    if (!rain) rain = { from: Math.max(Date.parse(s.time), now), mm: 0, chance: null };
    rain.mm += mm;
    if (typeof n1?.probability_of_precipitation === 'number') rain.chance = Math.max(rain.chance ?? 0, Math.round(n1.probability_of_precipitation));
  }
  if (rain) rain.mm = Math.round(rain.mm * 10) / 10;
  return {
    current,
    today: {
      high: temps.length ? Math.round(Math.max(...temps)) : current.temp,
      low: temps.length ? Math.round(Math.min(...temps)) : current.temp,
      uvMax: uvs.length ? Math.round(Math.max(...uvs) * 10) / 10 : null,
      rain,
    },
  };
}

/**
 * Weather from the free met.no API (fine for commercial use, with a User-Agent). Refreshes every 30 minutes, and again
 * when the home's location changes; keeps the last forecast when offline.
 */
export class Weather extends EventEmitter<{ changed: [] }> {
  current: WeatherNow | null = null;
  today: WeatherToday | null = null;
  private steps: Step[] = [];
  private timer: NodeJS.Timeout | null = null;
  private place: Pick<HomeConfig, 'latitude' | 'longitude' | 'timezone'> | null = null;

  constructor(private now: () => number = Date.now) { super(); }

  start(cfg: Pick<HomeConfig, 'latitude' | 'longitude' | 'timezone'>): void {
    this.place = { latitude: cfg.latitude, longitude: cfg.longitude, timezone: cfg.timezone };
    void this.load();
    if (this.timer) clearInterval(this.timer);
    // Every 30 minutes: fetch again (met.no updates hourly); in between, today's view follows the clock.
    this.timer = setInterval(() => void this.load(), 30 * 60_000);
    this.timer.unref?.();
  }

  /** The home moved (Settings): forecast for the new place now. */
  moved(cfg: Pick<HomeConfig, 'latitude' | 'longitude' | 'timezone'>): void {
    const p = this.place;
    if (p && p.latitude === cfg.latitude && p.longitude === cfg.longitude && p.timezone === cfg.timezone) return;
    this.start(cfg);
  }

  /** Recompute "today" from the forecast held (the clock moved on). */
  refresh(): void {
    if (!this.place || !this.steps.length) return;
    const s = summarise(this.steps, this.now(), this.place.timezone);
    if (s) { this.current = s.current; this.today = s.today; }
  }

  private async load(): Promise<void> {
    const p = this.place;
    if (!p || (!p.latitude && !p.longitude)) return;
    try {
      const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${p.latitude.toFixed(3)}&lon=${p.longitude.toFixed(3)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Kova (https://github.com/clickbitau/kova)' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const j = await res.json() as { properties: { timeseries: Step[] } };
      this.steps = j.properties.timeseries ?? [];
      this.refresh();
      this.emit('changed');
    } catch { /* offline: keep the last forecast */ }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
