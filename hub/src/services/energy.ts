import type { Store } from '../store/db.ts';
import type { Registry } from '../devices/registry.ts';
import type { Device, DeviceSettings } from '../model/types.ts';
import { atLocal, localDate, localHour } from '../util/time.ts';

interface Sample { pv: number; grid: number | null; load: number | null; devices: Record<string, number>; est?: Record<string, number> }

/**
 * About how much a device draws while it's on, for devices with no meter: typical figures, so the Energy page shows
 * where the power goes before (or without) a meter. The owner's own figure (`devices.<id>.watts`) wins. Null: no idea
 * (a plug with no meter could have anything on it).
 */
export function typicalWatts(d: Device): number | null {
  if (d.adapter === 'virtual' || d.type === 'internet' || d.type === 'sensor' || d.type === 'vacuum') return null;
  if (d.type === 'camera') return 4;
  if (d.state.on !== true) return 0;
  switch (d.type) {
    case 'tv': return d.adapter === 'helix' ? 25 : 110;
    case 'media': return d.capabilities.includes('sound') ? 35 : 8;
    case 'light': return 9;
    case 'dimmer': return Math.max(1, Math.round(9 * (d.state.bri ?? 100) / 100));
    case 'fan': return 30;
    default: return null;
  }
}

export interface EnergyToday {
  /** False until something that produces or meters energy is connected. */
  available: boolean;
  now: { solar: number; load: number | null; grid: number | null };
  solarKwh: number;
  usedKwh: number | null;
  fromGridKwh: number | null;
  exportedKwh: number | null;
  /** 24 hours of kWh. `use` is null when no meter reports home consumption. */
  hours: { solar: number; use: number | null }[];
  peak: { w: number; hour: number } | null;
  /** Home use includes estimates (no meter for the whole home). */
  estimated?: boolean;
  /** Now, by device: measured, or `estimated` from what's on. */
  devices: { id: string; name: string; w: number; estimated?: true }[];
}

/**
 * Samples power once a minute into the event log and turns the samples into
 * today's numbers for the Energy screen. Works with just an inverter (solar
 * only) and gets richer when a grid meter or smart plugs report too.
 */
export class Energy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private reg: Registry, private tz: () => string, private now: () => number = Date.now, private settings: () => Record<string, DeviceSettings> = () => ({})) {}

  /** A device's draw with no meter: the owner's figure while it's on, else the typical one. */
  private estimate(d: Device): number | null {
    const own = this.settings()[d.id]?.watts;
    if (own != null && d.adapter !== 'virtual') return d.type === 'camera' || d.state.on === true ? own : 0;
    return typicalWatts(d);
  }

  start(intervalMs = 60_000): void {
    if (intervalMs > 0) this.timer = setInterval(() => this.sample(), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private current(): Sample {
    const ds = this.reg.list();
    const inverters = ds.filter(d => d.capabilities.includes('energy'));
    const pv = inverters.reduce((w, d) => w + (d.state.power ?? 0), 0);
    const grids = ds.map(d => d.state.grid).filter((g): g is number => g != null);
    const loads = ds.map(d => d.state.load).filter((l): l is number => l != null);
    const grid = grids.length ? grids.reduce((a, b) => a + b, 0) : null;
    const devices: Record<string, number> = {}, est: Record<string, number> = {};
    for (const d of ds) {
      if (d.capabilities.includes('energy')) continue;
      if (d.state.power != null) devices[d.id] = d.state.on === false ? 0 : d.state.power;
      else { const w = this.estimate(d); if (w != null) est[d.id] = w; }
    }
    // Home use from a meter, else solar plus grid, else what the plugs measure and the rest is about.
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    const counted = Object.keys(devices).length + Object.keys(est).length;
    const load = loads.length ? loads.reduce((a, b) => a + b, 0) : grid != null ? Math.max(0, pv + grid) : counted ? Math.round(sum(devices) + sum(est)) : null;
    return { pv, grid, load, devices, est };
  }

  sample(): void {
    if (!this.available(this.current())) return;
    this.store.append({ kind: 'sample', device: null, feed: null, what: '', data: { ...this.current() }, cause: { kind: 'system', label: 'Energy' } });
  }

  /** Anything to show: an inverter, a grid meter, a plug that measures, or devices Kova can estimate. */
  private available(cur: Sample): boolean {
    return this.reg.list().some(d => d.capabilities.includes('energy')) || cur.grid != null || Object.keys(cur.devices).length > 0 || Object.keys(cur.est ?? {}).length > 0;
  }

  today(): EnergyToday {
    const tz = this.tz();
    const t = this.now();
    const start = atLocal(localDate(t, tz), 0, tz);
    const samples = this.store.between(start, t + 1, 'sample');
    const cur = this.current();
    const inverters = this.reg.list().filter(d => d.capabilities.includes('energy'));
    const hours = Array.from({ length: 24 }, () => ({ solar: 0, use: null as number | null }));
    let used: number | null = null, fromGrid: number | null = null, exported: number | null = null, integratedSolar = 0;
    let peak: EnergyToday['peak'] = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i].data as unknown as Sample;
      const next = samples[i + 1]?.ts ?? Math.min(t, samples[i].ts + 60_000);
      const h = Math.min(next - samples[i].ts, 5 * 60_000) / 3600_000;   // cap gaps (hub was off)
      const hour = Math.floor(localHour(samples[i].ts, tz));
      const pvKwh = (s.pv * h) / 1000;
      hours[hour].solar += pvKwh;
      integratedSolar += pvKwh;
      if (!peak || s.pv > peak.w) peak = { w: s.pv, hour };
      if (s.load != null) {
        hours[hour].use = (hours[hour].use ?? 0) + (s.load * h) / 1000;
        used = (used ?? 0) + (s.load * h) / 1000;
      }
      if (s.grid != null) {
        fromGrid = (fromGrid ?? 0) + (Math.max(0, s.grid) * h) / 1000;
        exported = (exported ?? 0) + (Math.max(0, -s.grid) * h) / 1000;
      }
    }
    // The inverter's own daily counter is more accurate than our sampling when it has one.
    const counter = inverters.map(d => d.state.energy).filter((e): e is number => e != null);
    const solarKwh = counter.length ? counter.reduce((a, b) => a + b, 0) : integratedSolar;
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      available: this.available(cur),
      // Home use is partly about: no grid or home meter, so it's the plugs that measure plus estimates.
      estimated: !inverters.some(d => d.state.load != null) && cur.grid == null && this.reg.list().every(d => d.state.load == null) && Object.keys(cur.est ?? {}).length > 0,
      now: { solar: cur.pv, load: cur.load, grid: cur.grid },
      solarKwh: r(solarKwh),
      usedKwh: used == null ? null : r(used),
      fromGridKwh: fromGrid == null ? null : r(fromGrid),
      exportedKwh: exported == null ? null : r(exported),
      hours: hours.map(x => ({ solar: Math.round(x.solar * 100) / 100, use: x.use == null ? null : Math.round(x.use * 100) / 100 })),
      peak,
      devices: [
        ...Object.entries(cur.devices).map(([id, w]) => ({ id, name: this.reg.get(id)?.name ?? id, w })),
        ...Object.entries(cur.est ?? {}).filter(([, w]) => w > 0).map(([id, w]) => ({ id, name: this.reg.get(id)?.name ?? id, w, estimated: true as const })),
      ].sort((a, b) => b.w - a.w),
    };
  }
}
