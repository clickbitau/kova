// The Energy screen: today's numbers from the snapshot (hub services/energy.ts) turned into what the screen shows.
// Free of React Native so the tests run it under plain Node.
import type { EnergyToday } from '../api/types';

/** Watts the way the screen writes them: 450 W, 2.4 kW, or a dash. Direction is shown elsewhere, so no sign. */
export const kw = (w: number | null | undefined) => w == null ? '—' : Math.abs(w) >= 1000 ? `${(Math.abs(w) / 1000).toFixed(1)} kW` : `${Math.round(Math.abs(w))} W`;
export const kwh = (x: number | null | undefined) => x == null ? '—' : `${x.toFixed(1)} kWh`;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export interface EnergyStat { id: string; label: string; value: string; sub: string; tone: 'amber' | 'bone' | 'blue' | 'green' | 'muted' }
export interface EnergyBar { hour: number; solar: number; use: number | null; later: boolean }
export interface EnergyDevice { id: string; name: string; w: number; value: string; share: number; estimated: boolean }

export interface EnergyView {
  available: boolean;
  /** The line under the title. */
  sub: string;
  /** One sentence about right now. */
  insight: string;
  producing: boolean;
  now: { solar: string; load: string; grid: string; gridLabel: string; gridDir: 'in' | 'out' | null; hasSolar: boolean };
  stats: EnergyStat[];
  /** 24 hours as shares of the busiest hour (0–1); hours still to come are `later`. */
  bars: EnergyBar[];
  /** The busiest hour, in kWh, for the chart's scale. */
  max: number;
  hasUse: boolean;
  hasHistory: boolean;
  peak: string | null;
  devices: EnergyDevice[];
  foot: string;
}

/** An inverter's figure, or none. The hub reports solar as 0 when there's no inverter at all. */
const solarSource = (e: EnergyToday, inverter: boolean) => inverter || e.solarKwh > 0 || e.now.solar > 0;

/**
 * Everything the Energy screen says. `inverter` is the name of what reports solar or the meter (an integration's
 * name), if there is one; `nowHour` is the home's local hour, for dimming the hours to come.
 */
export function energyView(e: EnergyToday | null | undefined, nowHour: number, inverter?: string | null): EnergyView {
  const E: EnergyToday = e ?? { available: false, now: { solar: 0, load: null, grid: null }, solarKwh: 0, usedKwh: null, fromGridKwh: null, exportedKwh: null, hours: [], peak: null, devices: [] };
  const hasSolar = solarSource(E, !!inverter);
  const producing = E.now.solar > 0;
  const hours = E.hours.length === 24 ? E.hours : Array.from({ length: 24 }, () => ({ solar: 0, use: null }));
  const max = Math.max(0.3, ...hours.map(x => Math.max(x.solar, x.use ?? 0)));
  const nowH = Math.floor(nowHour);
  const bars = hours.map((x, hour) => ({ hour, solar: x.solar / max, use: x.use == null ? null : x.use / max, later: hour > nowH }));
  const hasUse = hours.some(x => x.use != null);
  const hasHistory = hours.some(x => x.solar > 0 || (x.use ?? 0) > 0);
  const own = E.usedKwh && E.usedKwh > 0 ? Math.round(Math.min(100, Math.max(0, (E.solarKwh - (E.exportedKwh ?? 0)) / E.usedKwh * 100))) : null;
  const peak = E.peak && E.peak.w > 0 ? `Peak ${kw(E.peak.w)} at ${hh(E.peak.hour)}` : null;
  const stats: EnergyStat[] = [
    ...(hasSolar ? [{ id: 'solar', label: 'Solar made', value: kwh(E.solarKwh), tone: 'amber' as const, sub: peak ?? (E.solarKwh > 0 ? 'From the inverter’s daily counter' : 'Nothing yet today') }] : []),
    { id: 'used', label: 'Home used', value: kwh(E.usedKwh), tone: E.usedKwh == null ? 'muted' : 'bone', sub: E.usedKwh == null ? 'Needs a grid meter' : E.estimated ? 'About: from what’s on' : own != null && hasSolar ? `${own}% from your own solar` : 'Today so far' },
    { id: 'grid', label: 'From the grid', value: kwh(E.fromGridKwh), tone: E.fromGridKwh == null ? 'muted' : 'blue', sub: E.fromGridKwh == null ? 'Needs a grid meter' : 'Bought today' },
    ...(hasSolar || E.exportedKwh != null ? [{ id: 'export', label: 'Sent back', value: kwh(E.exportedKwh), tone: E.exportedKwh == null ? 'muted' as const : 'green' as const, sub: E.exportedKwh == null ? 'Needs a grid meter' : 'Solar you didn’t use' }] : []),
  ];
  const top = Math.max(1, ...E.devices.map(d => d.w));
  const devices = E.devices.filter(d => d.w > 0).map(d => ({ id: d.id, name: d.name, w: d.w, value: `${d.estimated ? 'about ' : ''}${kw(d.w)}`, share: d.w / top, estimated: !!d.estimated }));
  const insight = !E.available ? 'Nothing reports energy yet. Connect a solar inverter, a grid meter or plugs that measure power.'
    : E.estimated && !E.solarKwh ? `About ${kw(E.now.load ?? 0)} in use now${devices[0] ? `, most of it ${devices[0].name}` : ''}. A plug that measures power makes it exact.`
    : producing ? `Producing ${kw(E.now.solar)} now${E.now.load != null && E.now.solar > E.now.load ? ', more than the home is using: a good time to run the dishwasher or the laundry.' : '.'}`
    : E.solarKwh > 0 ? `Solar made ${kwh(E.solarKwh)} today and has stopped for the day.`
    : hasSolar ? 'Solar hasn’t started yet today.'
    : `${kw(E.now.load ?? 0)} in use now.`;
  return {
    available: E.available,
    sub: !E.available ? 'Connect a solar inverter or a grid meter' : E.estimated ? 'Today so far · about, from what’s on' : `Today so far${inverter ? ` · ${inverter}` : ''}`,
    insight,
    producing,
    now: {
      solar: kw(E.now.solar), load: kw(E.now.load), grid: kw(E.now.grid), hasSolar,
      gridLabel: E.now.grid == null ? 'Grid' : E.now.grid < 0 ? 'To the grid' : 'From the grid',
      gridDir: E.now.grid == null || E.now.grid === 0 ? null : E.now.grid < 0 ? 'out' : 'in',
    },
    stats, bars, max, hasUse, hasHistory, peak, devices,
    foot: E.devices.length ? `${E.devices.length === 1 ? '1 device reports power or has a figure' : `${E.devices.length} devices report power or have a figure`}. A whole-home meter or plugs that measure fill in the rest.`
      : 'Nothing reports its own power yet. Plugs that measure energy or a whole-home meter fill this in.',
  };
}

/** The figure typed for what a device draws: a whole number of watts the hub takes (0–10000), or empty for none. */
export function parseWatts(text: string): { ok: true; watts: number | null } | { ok: false; why: string } {
  const t = text.trim().replace(/\s*w$/i, '');
  if (!t) return { ok: true, watts: null };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { ok: false, why: 'Watts are a number, like 60' };
  if (n > 10_000) return { ok: false, why: 'That’s more than 10,000 W' };
  return { ok: true, watts: Math.round(n) };
}

/** What the screen says Kova counts for a device with no meter, while it's on. */
export function wattsNote(d: { watts?: number | null; typicalWatts?: number | null }): string {
  if (d.watts != null) return `${d.watts} W while on · your figure`;
  if (d.typicalWatts != null) return `About ${d.typicalWatts} W while on · Kova’s guess`;
  return 'Not counted: Kova has no figure for it';
}
