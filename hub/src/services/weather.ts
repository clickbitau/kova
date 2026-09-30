import { EventEmitter } from 'node:events';
import type { HomeConfig } from '../model/types.ts';

export interface WeatherNow { temp: number; text: string; icon: string }

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

/** Current conditions from the free Met.no API. Refreshes every 30 minutes; stays null if offline. */
export class Weather extends EventEmitter<{ changed: [] }> {
  current: WeatherNow | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(cfg: Pick<HomeConfig, 'latitude' | 'longitude'>): void {
    const load = async () => {
      try {
        const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${cfg.latitude.toFixed(3)}&lon=${cfg.longitude.toFixed(3)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Kova/0.1 github.com/clickbitau/kova' }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return;
        const j = await res.json() as { properties: { timeseries: { data: { instant: { details: { air_temperature: number } }; next_1_hours?: { summary: { symbol_code: string } } } }[] } };
        const first = j.properties.timeseries[0]?.data;
        if (!first) return;
        const code = first.next_1_hours?.summary.symbol_code ?? 'cloudy';
        const [, text, icon] = SYMBOLS.find(([re]) => re.test(code)) ?? [null, 'Cloudy', 'cloud'];
        this.current = { temp: Math.round(first.instant.details.air_temperature), text, icon };
        this.emit('changed');
      } catch { /* offline: keep the last reading */ }
    };
    void load();
    this.timer = setInterval(load, 30 * 60_000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
