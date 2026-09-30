import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from '../sdk.ts';
import type { Command, Device, DeviceState } from '../../model/types.ts';
import { TuyaConnection, type Dps } from './connection.ts';
import type { Version } from './protocol.ts';

/** A dimmable white light's data points (Tuya "dj" category defaults). */
export interface TuyaLightDps {
  switch: string;
  bri?: string;
  briMin?: number;
  briMax?: number;
  temp?: string;
  tempMax?: number;
  mode?: string;
  kMin?: number;
  kMax?: number;
}

export interface TuyaDeviceConfig {
  /** Tuya device id. */
  id: string;
  host: string;
  /** 16-character local key. */
  key: string;
  version?: Version;
  port?: number;
  /** One Kova device per switch channel: { "1": { name: "Kitchen light", room: "kitchen" } }. */
  switches?: Record<string, { name: string; room: string; type?: 'light' | 'plug'; id?: string }>;
  /** Or: the whole device is one dimmable light. */
  light?: TuyaLightDps & { name: string; room: string; id?: string };
}

export interface TuyaOptions { devices: TuyaDeviceConfig[]; timeoutMs?: number; heartbeatMs?: number }

const switchId = (d: TuyaDeviceConfig, dp: string) => d.switches?.[dp]?.id ?? `tuya_${d.id}_${dp}`;
const lightId = (d: TuyaDeviceConfig) => d.light?.id ?? `tuya_${d.id}_light`;

const scale = (v: number, a0: number, a1: number, b0: number, b1: number) => Math.round(b0 + ((v - a0) / (a1 - a0)) * (b1 - b0));

/** Kova light state → Tuya data points. Exported for tests. */
export function lightToDps(l: TuyaLightDps, cmd: Command): Dps {
  const out: Dps = {};
  if (cmd.on !== undefined) out[l.switch] = !!cmd.on;
  if (cmd.bri != null && l.bri) out[l.bri] = scale(Math.max(1, Math.min(100, cmd.bri)), 1, 100, l.briMin ?? 10, l.briMax ?? 1000);
  if (cmd.k != null && l.temp) {
    const kMin = l.kMin ?? 2700, kMax = l.kMax ?? 6500;
    out[l.temp] = scale(Math.max(kMin, Math.min(kMax, cmd.k)), kMin, kMax, 0, l.tempMax ?? 1000);
  }
  if ((cmd.bri != null || cmd.k != null) && l.mode) out[l.mode] = 'white';
  return out;
}

/** Tuya data points → Kova light state. */
export function dpsToLight(l: TuyaLightDps, dps: Dps): DeviceState {
  const s: DeviceState = {};
  if (typeof dps[l.switch] === 'boolean') s.on = dps[l.switch] as boolean;
  if (l.bri && typeof dps[l.bri] === 'number') s.bri = Math.max(1, scale(dps[l.bri] as number, l.briMin ?? 10, l.briMax ?? 1000, 1, 100));
  if (l.temp && typeof dps[l.temp] === 'number') s.k = scale(dps[l.temp] as number, 0, l.tempMax ?? 1000, l.kMin ?? 2700, l.kMax ?? 6500);
  return s;
}

/**
 * Tuya Wi-Fi devices over the local network (no cloud). Needs each device's
 * id, IP and local key; `tools/import-ha.ts` pulls these from a localtuya setup.
 */
export class TuyaAdapter implements Adapter {
  id = 'tuya';
  name = 'Tuya (local)';
  icon = 'toggle_on';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private conns = new Map<string, TuyaConnection>();
  private cfg = new Map<string, TuyaDeviceConfig>();

  constructor(private opts: TuyaOptions) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const infos: DeviceInfo[] = [];
    for (const d of this.opts.devices) {
      this.cfg.set(d.id, d);
      for (const [dp, s] of Object.entries(d.switches ?? {})) {
        infos.push({ id: switchId(d, dp), name: s.name, room: s.room, type: s.type ?? 'light', integration: 'Tuya (local)', address: `${d.id}/${dp}`, capabilities: ['onoff'] });
      }
      if (d.light) {
        const caps: DeviceInfo['capabilities'] = ['onoff'];
        if (d.light.bri) caps.push('brightness');
        if (d.light.temp) caps.push('colorTemp');
        infos.push({ id: lightId(d), name: d.light.name, room: d.light.room, type: d.light.bri ? 'dimmer' : 'light', integration: 'Tuya (local)', address: `${d.id}/light`, capabilities: caps });
      }
      const c = new TuyaConnection({ id: d.id, host: d.host, key: d.key, version: d.version ?? '3.3', port: d.port, timeoutMs: this.opts.timeoutMs, heartbeatMs: this.opts.heartbeatMs });
      c.on('dps', dps => this.onDps(d, dps));
      c.on('online', on => { for (const i of this.idsOf(d)) ctx.report(i, { online: on }); });
      this.conns.set(d.id, c);
    }
    ctx.announce(infos);
    // Connect in the background; a switch that's offline shouldn't hold up the hub.
    for (const [id, c] of this.conns) {
      c.connect().then(() => c.query()).catch(err => { ctx.log(`${id}: ${err.message}`); c.scheduleReconnect(); });
    }
  }

  private idsOf(d: TuyaDeviceConfig): string[] {
    return [...Object.keys(d.switches ?? {}).map(dp => switchId(d, dp)), ...(d.light ? [lightId(d)] : [])];
  }

  private onDps(d: TuyaDeviceConfig, dps: Dps): void {
    for (const dp of Object.keys(d.switches ?? {})) {
      if (typeof dps[dp] === 'boolean') this.ctx!.report(switchId(d, dp), { on: dps[dp] as boolean, online: true });
    }
    if (d.light) {
      const s = dpsToLight(d.light, dps);
      if (Object.keys(s).length) this.ctx!.report(lightId(d), { ...s, online: true });
    }
  }

  async command(device: Device, cmd: Command): Promise<void> {
    const [devId, part] = device.address.split('/');
    const d = this.cfg.get(devId);
    const c = this.conns.get(devId);
    if (!d || !c) throw new Error(`Unknown Tuya device ${device.id}`);
    const dps: Dps = part === 'light' && d.light ? lightToDps(d.light, cmd) : cmd.on !== undefined ? { [part]: !!cmd.on } : {};
    if (Object.keys(dps).length) await c.set(dps);
  }

  async stop(): Promise<void> { for (const c of this.conns.values()) c.close(); }

  status(): AdapterStatus {
    const all = [...this.conns.values()];
    const off = all.filter(c => !c.online).length;
    if (!all.length) return { ok: false, note: 'No Tuya devices set up' };
    return off ? { ok: false, note: `${off} of ${all.length} not responding` } : { ok: true, note: `${all.length} devices, all local` };
  }
}
