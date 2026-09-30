import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from './sdk.ts';
import SunCalc from 'suncalc';
import type { Command, Device } from '../model/types.ts';
import { atLocal, localDate } from '../util/time.ts';

/** A simulated solar inverter: power follows the sun's height, as a real array roughly would. */
export interface SolarSim { id: string; lat: number; lon: number; peakW: number; tz: string }

/** Watts from a panel array at an instant, from the sun's elevation. Exported for tests. */
export function solarWatts(sim: Pick<SolarSim, 'lat' | 'lon' | 'peakW'>, t: number): number {
  const alt = SunCalc.getPosition(new Date(t), sim.lat, sim.lon).altitude;
  return alt <= 0 ? 0 : Math.round(sim.peakW * Math.pow(Math.sin(alt), 1.2));
}

/**
 * Simulated devices. Lets the whole product run with no hardware: for
 * development, tests, demos and the "try Kova" experience.
 */
export class VirtualAdapter implements Adapter {
  id = 'virtual';
  name = 'Virtual devices';
  icon = 'science';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private timer: NodeJS.Timeout | null = null;

  constructor(private devices: DeviceInfo[], private solar?: SolarSim, private now: () => number = Date.now) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.announce(this.devices);
    if (this.solar) {
      this.tickSolar();
      this.timer = setInterval(() => this.tickSolar(), 30_000);
    }
  }

  /** Report the simulated inverter's power now and its energy since local midnight. */
  private tickSolar(): void {
    const s = this.solar!;
    const t = this.now();
    const midnight = atLocal(localDate(t, s.tz), 0, s.tz);
    let wh = 0;
    for (let x = midnight; x < t; x += 300_000) wh += solarWatts(s, x) * (Math.min(300_000, t - x) / 3600_000);
    this.ctx?.report(s.id, { power: solarWatts(s, t), energy: Math.round(wh / 100) / 10, online: true });
  }

  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); }

  async command(_d: Device, _cmd: Command): Promise<void> {
    // A real device would acknowledge here; virtual ones always accept.
  }

  /** Simulate a change made at the device itself (a wall switch, another app). */
  physical(id: string, state: Command): void { this.ctx?.report(id, state); }

  status(): AdapterStatus { return { ok: true, note: `${this.devices.length} simulated devices` }; }
}

