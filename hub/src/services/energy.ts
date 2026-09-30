import type { Store } from '../store/db.ts';
import type { Registry } from '../devices/registry.ts';
import { atLocal, localDate, localHour } from '../util/time.ts';

interface Sample { pv: number; grid: number | null; load: number | null; devices: Record<string, number> }

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
  devices: { id: string; name: string; w: number }[];
}

/**
 * Samples power once a minute into the event log and turns the samples into
 * today's numbers for the Energy screen. Works with just an inverter (solar
 * only) and gets richer when a grid meter or smart plugs report too.
 */
export class Energy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private reg: Registry, private tz: () => string, private now: () => number = Date.now) {}

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
    const load = loads.length ? loads.reduce((a, b) => a + b, 0) : grid != null ? Math.max(0, pv + grid) : null;
    const devices: Record<string, number> = {};
    for (const d of ds) if (!d.capabilities.includes('energy') && d.state.power != null) devices[d.id] = d.state.on === false ? 0 : d.state.power;
    return { pv, grid, load, devices };
  }

  sample(): void {
    const available = this.reg.list().some(d => d.capabilities.includes('energy') || d.state.grid != null);
    if (!available) return;
    this.store.append({ kind: 'sample', device: null, feed: null, what: '', data: { ...this.current() }, cause: { kind: 'system', label: 'Energy' } });
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
      available: inverters.length > 0 || cur.grid != null,
      now: { solar: cur.pv, load: cur.load, grid: cur.grid },
      solarKwh: r(solarKwh),
      usedKwh: used == null ? null : r(used),
      fromGridKwh: fromGrid == null ? null : r(fromGrid),
      exportedKwh: exported == null ? null : r(exported),
      hours: hours.map(x => ({ solar: Math.round(x.solar * 100) / 100, use: x.use == null ? null : Math.round(x.use * 100) / 100 })),
      peak,
      devices: Object.entries(cur.devices).map(([id, w]) => ({ id, name: this.reg.get(id)?.name ?? id, w })).sort((a, b) => b.w - a.w),
    };
  }
}
