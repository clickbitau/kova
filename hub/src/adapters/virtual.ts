import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo, Snapshot } from './sdk.ts';
import SunCalc from 'suncalc';
import type { Command, Device, DeviceState } from '../model/types.ts';
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
  private life: NodeJS.Timeout | null = null;
  /** Each simulated sensor's resting reading, so drift stays near it. */
  private base = new Map<string, { temp?: number; humidity?: number }>();

  /** `simulate`: the demo home's sensors drift and motion comes and goes (off in tests, which move things themselves). */
  constructor(private devices: DeviceInfo[], private solar?: SolarSim, private now: () => number = Date.now, private o: { simulate?: boolean } = {}) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.announce(this.devices);
    if (this.solar) {
      this.tickSolar();
      this.timer = setInterval(() => this.tickSolar(), 30_000);
    }
    if (this.o.simulate) {
      for (const d of this.devices) if (d.type === 'sensor' && d.state) this.base.set(d.id, { temp: d.state.temp ?? undefined, humidity: d.state.humidity ?? undefined });
      this.life = setInterval(() => this.tickLife(), 60_000);
      this.life.unref?.();
    }
  }

  /** The demo home living a little: temperatures and humidity wander near where they started, motion comes and goes. */
  private tickLife(): void {
    const jitter = (v: number, base: number, step: number, span: number) => Math.round(Math.max(base - span, Math.min(base + span, v + (Math.random() - 0.5) * 2 * step)) * 10) / 10;
    for (const d of this.devices) {
      const b = this.base.get(d.id);
      if (!b) continue;
      const patch: Record<string, number | boolean> = {};
      if (b.temp != null) patch.temp = jitter(this.last(d.id, 'temp') ?? b.temp, b.temp, 0.2, 1.5);
      if (b.humidity != null) patch.humidity = Math.round(jitter(this.last(d.id, 'humidity') ?? b.humidity, b.humidity, 1, 6));
      if (d.state && typeof d.state.motion === 'boolean') {
        const on = Math.random() < 0.12;
        patch.motion = on;
      }
      if (Object.keys(patch).length) { this.seen.set(d.id, { ...(this.seen.get(d.id) ?? {}), ...patch }); this.ctx?.report(d.id, patch); }
    }
  }

  private seen = new Map<string, Record<string, number | boolean>>();
  private last(id: string, f: string): number | undefined { const v = this.seen.get(id)?.[f]; return typeof v === 'number' ? v : undefined; }

  /**
   * A demo camera's picture: a drawn scene with the camera's name and the time, so timelines and cards show
   * something without a real camera.
   */
  async snapshot(d: Device): Promise<Snapshot> {
    if (d.type !== 'camera') throw new Error('Not a camera');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: this.solar?.tz }).formatToParts(new Date(this.now())).map(p => [p.type, p.value]));
    const hh = parts.hour, mm = parts.minute, ss = parts.second;
    const night = Number(hh) < 6 || Number(hh) >= 19;
    const sky = night ? ['#1b2333', '#0e121b'] : ['#4d6b8a', '#9fb4c4'];
    const door = /door|front|bell/i.test(`${d.id} ${d.name} ${d.room}`);
    const esc = (x: string) => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>
<radialGradient id="l" cx="0.3" cy="0.2" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="${night ? 0.18 : 0.08}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="640" height="360" fill="url(#s)"/>
${door
    ? `<rect x="0" y="230" width="640" height="130" fill="${night ? '#22252b' : '#5b5f63'}"/><rect x="250" y="70" width="140" height="170" rx="4" fill="${night ? '#3a2c22' : '#7a5636'}"/><circle cx="370" cy="160" r="5" fill="#d9b25f"/><rect x="200" y="60" width="240" height="12" fill="${night ? '#2c2f36' : '#c8c3ba'}"/>`
    : `<rect x="0" y="250" width="640" height="110" fill="${night ? '#2a2420' : '#8a7a68'}"/><rect x="60" y="120" width="180" height="110" rx="6" fill="${night ? '#23262c' : '#d8d2c8'}"/><rect x="420" y="90" width="120" height="160" rx="4" fill="${night ? '#30343b' : '#b9b2a6'}"/><rect x="300" y="190" width="90" height="60" rx="8" fill="${night ? '#3b3f47' : '#6e6a64'}"/>`}
<g fill="${night ? '#0b0c0f' : '#2b2d31'}" opacity="0.92"><circle cx="${door ? 320 : 470}" cy="${door ? 128 : 150}" r="22"/><rect x="${door ? 292 : 442}" y="${door ? 152 : 174}" width="56" height="${door ? 88 : 80}" rx="22"/></g>
<rect width="640" height="360" fill="url(#l)"/>
<rect x="0" y="0" width="640" height="34" fill="#000" opacity="0.45"/>
<text x="14" y="23" font-family="monospace" font-size="15" fill="#f1efea">${esc(d.name)} · demo</text>
<text x="626" y="23" font-family="monospace" font-size="15" fill="#f1efea" text-anchor="end">${hh}:${mm}:${ss}</text>
</svg>`;
    return { contentType: 'image/svg+xml', body: Buffer.from(svg) };
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

  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); if (this.life) clearInterval(this.life); }

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    // A real device would acknowledge here; virtual ones always accept. A ducted unit reports its zones back after a
    // change to some of them, as a real one does.
    if (cmd.zoneSet && Array.isArray(d.state.zones)) {
      return { zones: d.state.zones.map(z => {
        const c = cmd.zoneSet![String(z.n)];
        if (!c) return z;
        const on = c.on ?? z.on;
        return { ...z, on, open: c.open != null ? c.open : on && !z.on && !z.open ? 100 : !on ? 0 : z.open };
      }) };
    }
  }

  /** Simulate a change made at the device itself (a wall switch, another app). */
  physical(id: string, state: Command): void { this.ctx?.report(id, state); }

  status(): AdapterStatus { return { ok: true, note: `${this.devices.length} simulated devices` }; }
}

