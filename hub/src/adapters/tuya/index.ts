import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from '../sdk.ts';
import type { Command, Device, DeviceState } from '../../model/types.ts';
import { TuyaConnection, type Dps } from './connection.ts';
import { VERSIONS, type Version } from './protocol.ts';

/**
 * A light's data points. Tuya lights come in two generations:
 *   v1: 1 switch, 2 work_mode, 3 bright_value 25–255, 4 temp_value 0–255, 5 colour_data "rrggbbhhhhssvv"
 *   v2: 20 switch_led, 21 work_mode, 22 bright_value_v2 10–1000, 23 temp_value_v2 0–1000, 24 colour_data_v2 "hhhhssssvvvv"
 * `lightFromSpec` fills this in from the device's cloud specification.
 */
export interface TuyaLightDps {
  switch: string;
  bri?: string;
  briMin?: number;
  briMax?: number;
  temp?: string;
  tempMin?: number;
  tempMax?: number;
  mode?: string;
  kMin?: number;
  kMax?: number;
  colour?: string;
  /** How colour is written: 'hsv16' = hhhhssssvvvv (v2), 'rgb8' = rrggbbhhhhssvv (v1), 'json' = {"h":…,"s":…,"v":…}. Reading detects the format. */
  colourFormat?: 'hsv16' | 'rgb8' | 'json';
  /** Top of the s and v scales for colour (1000 for v2, 255 for v1). */
  colourMax?: number;
}

export interface TuyaDeviceConfig {
  /** Tuya device id. */
  id: string;
  /** LAN IP. Empty when it isn't known yet: the device stays offline until it's filled in. */
  host: string;
  /** 16-character local key. */
  key: string;
  version?: Version;
  port?: number;
  /** Name in the Tuya app, and its category and product (from the cloud import; informational). */
  name?: string;
  category?: string;
  product?: string;
  /** One Kova device per switch channel: { "1": { name: "Kitchen light", room: "kitchen" } }. */
  switches?: Record<string, { name: string; room: string; type?: 'light' | 'plug'; id?: string }>;
  /** Or: the whole device is one light (dimmable, warmth and colour as its data points allow). */
  light?: TuyaLightDps & { name: string; room: string; id?: string };
  /**
   * A Zigbee (or BLE mesh) sub-device: reached through this gateway, the `id` of another entry in
   * the list, and addressed there by `cid` (its node id). It has no host or key of its own.
   * A gateway is an ordinary entry with its host and key; it needs no switches or light itself.
   */
  gateway?: string;
  cid?: string;
}

export interface TuyaOptions { devices: TuyaDeviceConfig[]; timeoutMs?: number; heartbeatMs?: number }

const switchId = (d: TuyaDeviceConfig, dp: string) => d.switches?.[dp]?.id ?? `tuya_${d.id}_${dp}`;
const lightId = (d: TuyaDeviceConfig) => d.light?.id ?? `tuya_${d.id}_light`;

const scale = (v: number, a0: number, a1: number, b0: number, b1: number) => Math.round(b0 + ((v - a0) / (a1 - a0)) * (b1 - b0));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ------------------------------------------------------------ colour --

/** '#rrggbb' → hue 0–360, saturation and value 0–1. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

/** Hue 0–360, saturation and value 0–1 → '#rrggbb'. */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

const hx = (n: number, w: number) => Math.round(n).toString(16).padStart(w, '0');

/** Encode a colour (h 0–360, s and v 0–1) the way a light's colour data point expects. */
export function encodeColour(l: TuyaLightDps, h: number, s: number, v: number): string {
  const fmt = l.colourFormat ?? 'hsv16';
  const max = l.colourMax ?? (fmt === 'rgb8' ? 255 : 1000);
  if (fmt === 'json') return JSON.stringify({ h: Math.round(h), s: Math.round(s * max), v: Math.round(v * max) });
  if (fmt === 'rgb8') return hsvToHex(h, s, v).slice(1) + hx(h, 4) + hx(s * 255, 2) + hx(v * 255, 2);
  return hx(h, 4) + hx(s * max, 4) + hx(v * max, 4);
}

/** Read a colour data point in any of the three formats → h 0–360, s and v 0–1. */
export function decodeColour(l: TuyaLightDps, raw: string): { h: number; s: number; v: number } | null {
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { h?: number; s?: number; v?: number };
      const max = l.colourMax ?? 1000;
      return { h: Number(j.h ?? 0), s: clamp(Number(j.s ?? 0) / max, 0, 1), v: clamp(Number(j.v ?? 0) / max, 0, 1) };
    } catch { return null; }
  }
  if (!/^[0-9a-f]+$/i.test(t)) return null;
  if (t.length === 12) {
    const max = l.colourMax && l.colourMax !== 255 ? l.colourMax : 1000;
    return { h: parseInt(t.slice(0, 4), 16), s: clamp(parseInt(t.slice(4, 8), 16) / max, 0, 1), v: clamp(parseInt(t.slice(8, 12), 16) / max, 0, 1) };
  }
  if (t.length === 14) return { h: parseInt(t.slice(6, 10), 16), s: parseInt(t.slice(10, 12), 16) / 255, v: parseInt(t.slice(12, 14), 16) / 255 };
  if (t.length === 6) return hexToHsv(t);
  return null;
}

// ------------------------------------------------------------ lights --

/**
 * Kova light command → Tuya data points. `current` is the light's state now: a brightness
 * change on a light showing a colour dims the colour instead of switching it to white.
 */
export function lightToDps(l: TuyaLightDps, cmd: Command, current: DeviceState = {}): Dps {
  const out: Dps = {};
  if (cmd.on !== undefined) out[l.switch] = !!cmd.on;
  const colourCmd = !!l.colour && (!!cmd.color || (cmd.k == null && cmd.bri != null && !!current.color && current.k == null));
  if (colourCmd) {
    const { h, s } = hexToHsv(cmd.color ?? current.color!);
    const v = clamp(cmd.bri ?? current.bri ?? 100, 1, 100) / 100;
    out[l.colour!] = encodeColour(l, h, s, v);
    if (l.mode) out[l.mode] = 'colour';
    return out;
  }
  if (cmd.bri != null && l.bri) out[l.bri] = scale(clamp(cmd.bri, 1, 100), 1, 100, l.briMin ?? 10, l.briMax ?? 1000);
  if (cmd.k != null && l.temp) {
    const kMin = l.kMin ?? 2700, kMax = l.kMax ?? 6500;
    out[l.temp] = scale(clamp(cmd.k, kMin, kMax), kMin, kMax, l.tempMin ?? 0, l.tempMax ?? 1000);
  }
  if ((cmd.bri != null || cmd.k != null) && l.mode) out[l.mode] = 'white';
  return out;
}

/** Tuya data points → Kova light state. Pass every known data point: the work mode decides between colour and white. */
export function dpsToLight(l: TuyaLightDps, dps: Dps): DeviceState {
  const s: DeviceState = {};
  if (typeof dps[l.switch] === 'boolean') s.on = dps[l.switch] as boolean;
  const mode = l.mode ? dps[l.mode] : undefined;
  const colour = l.colour && typeof dps[l.colour] === 'string' ? decodeColour(l, dps[l.colour] as string) : null;
  if (colour && (mode === 'colour' || (!l.mode && !l.bri))) {
    s.color = hsvToHex(colour.h, colour.s, 1);
    s.bri = clamp(Math.round(colour.v * 100), 1, 100);
    s.k = null;
    return s;
  }
  if (l.bri && typeof dps[l.bri] === 'number') s.bri = clamp(scale(dps[l.bri] as number, l.briMin ?? 10, l.briMax ?? 1000, 1, 100), 1, 100);
  if (l.temp && typeof dps[l.temp] === 'number') s.k = scale(dps[l.temp] as number, l.tempMin ?? 0, l.tempMax ?? 1000, l.kMin ?? 2700, l.kMax ?? 6500);
  if (l.colour && mode !== undefined) s.color = null;
  return s;
}

// ------------------------------------------------------ cloud specs --

/** One data point from a device's cloud specification. `values` is the parsed JSON from the spec. */
export interface TuyaDpSpec { code: string; dp?: number; type?: string; values?: Record<string, unknown> }

// Standard DP numbers, for when a specification doesn't say (the iot-03 endpoint leaves dp_id out).
const V2_DPS: Record<string, number> = { switch_led: 20, work_mode: 21, bright_value_v2: 22, temp_value_v2: 23, colour_data_v2: 24 };
const V1_DPS: Record<string, number> = { switch_led: 1, led_switch: 1, work_mode: 2, bright_value: 3, temp_value: 4, colour_data: 5 };

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** A light's data points from its specification, or null when it isn't a light. */
export function lightFromSpec(spec: TuyaDpSpec[]): TuyaLightDps | null {
  const by = new Map(spec.map(d => [d.code, d]));
  const v2 = spec.some(d => d.code.endsWith('_v2'));
  const pick = (...codes: string[]) => codes.map(c => by.get(c)).find(Boolean);
  const dpOf = (d: TuyaDpSpec | undefined): string | undefined => {
    if (!d) return undefined;
    const n = d.dp ?? (v2 ? V2_DPS[d.code] ?? V1_DPS[d.code] : V1_DPS[d.code] ?? V2_DPS[d.code]);
    return n == null ? undefined : String(n);
  };
  const sw = dpOf(pick('switch_led', 'led_switch'));
  if (!sw) return null;
  const l: TuyaLightDps = { switch: sw };
  const bri = pick('bright_value_v2', 'bright_value');
  if (bri && dpOf(bri)) {
    const v1 = bri.code === 'bright_value' && !v2;
    l.bri = dpOf(bri);
    l.briMin = num(bri.values?.min) ?? (v1 ? 25 : 10);
    l.briMax = num(bri.values?.max) ?? (v1 ? 255 : 1000);
  }
  const temp = pick('temp_value_v2', 'temp_value');
  if (temp && dpOf(temp)) {
    l.temp = dpOf(temp);
    l.tempMin = num(temp.values?.min) ?? 0;
    l.tempMax = num(temp.values?.max) ?? (temp.code === 'temp_value' && !v2 ? 255 : 1000);
  }
  const mode = dpOf(pick('work_mode'));
  if (mode) l.mode = mode;
  const colour = pick('colour_data_v2', 'colour_data');
  if (colour && dpOf(colour)) {
    l.colour = dpOf(colour);
    // The spec's s/v ranges tell the generations apart: 0–1000 is the 12-hex v2 format, 0–255 the 14-hex v1 format.
    const sub = (k: string) => num((colour.values?.[k] as Record<string, unknown> | undefined)?.max);
    const sMax = sub('s') ?? sub('v');
    const isV1 = sMax != null ? sMax <= 255 : colour.code === 'colour_data' && !v2;
    l.colourFormat = isV1 ? 'rgb8' : 'hsv16';
    l.colourMax = isV1 ? 255 : sMax ?? 1000;
  }
  return l;
}

/** Switch channels (switch, switch_1, switch_2 …) in a specification → their DP numbers. */
export function switchesFromSpec(spec: TuyaDpSpec[]): string[] {
  const out: string[] = [];
  for (const d of spec) {
    const m = /^switch(?:_(\d+))?$/.exec(d.code);
    if (!m || (d.type && !/bool/i.test(d.type))) continue;
    const dp = String(d.dp ?? (m[1] ? Number(m[1]) : 1));
    if (!out.includes(dp)) out.push(dp);
  }
  return out.sort((a, b) => Number(a) - Number(b));
}

/**
 * Tuya Wi-Fi devices over the local network (no cloud). Needs each device's
 * id, IP and local key: `tools/import-ha.ts` pulls these from a localtuya setup,
 * `tools/tuya-keys.ts` from the Tuya IoT cloud (once).
 */
export class TuyaAdapter implements Adapter {
  id = 'tuya';
  name = 'Tuya (local)';
  icon = 'toggle_on';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private conns = new Map<string, TuyaConnection>();
  private cfg = new Map<string, TuyaDeviceConfig>();
  /** Every data point each device has reported, so a partial report can be read in context. */
  private known = new Map<string, Dps>();
  private unreachable: string[] = [];
  /** Gateway id → its sub-devices by node id. */
  private subs = new Map<string, Map<string, TuyaDeviceConfig>>();

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
        if (d.light.bri || d.light.colour) caps.push('brightness');
        if (d.light.temp) caps.push('colorTemp');
        if (d.light.colour) caps.push('color');
        infos.push({ id: lightId(d), name: d.light.name, room: d.light.room, type: d.light.bri || d.light.colour ? 'dimmer' : 'light', integration: 'Tuya (local)', address: `${d.id}/light`, capabilities: caps });
      }
      if (d.gateway) {
        // Behind a gateway: wired up once every gateway's connection exists (below).
        if (!d.cid) { ctx.log(`${d.name ?? d.id}: behind gateway ${d.gateway} but no node id (cid); it stays offline`); this.unreachable.push(d.id); continue; }
        if (!this.subs.has(d.gateway)) this.subs.set(d.gateway, new Map());
        this.subs.get(d.gateway)!.set(d.cid, d);
        continue;
      }
      const version = d.version ?? '3.3';
      if (!d.host || !d.key || !VERSIONS.includes(version)) {
        const why = !d.host ? 'no IP address yet' : !d.key ? 'no local key' : `protocol ${version} not supported`;
        ctx.log(`${d.name ?? d.id}: ${why}; it stays offline`);
        this.unreachable.push(d.id);
        continue;
      }
      const c = new TuyaConnection({ id: d.id, host: d.host, key: d.key, version, port: d.port, timeoutMs: this.opts.timeoutMs, heartbeatMs: this.opts.heartbeatMs });
      // A gateway's reports name the sub-device they're from; its own carry no cid.
      c.on('dps', (dps, cid) => {
        if (!cid) { this.onDps(d, dps); return; }
        const sub = this.subs.get(d.id)?.get(cid);
        if (sub) this.onDps(sub, dps);
      });
      c.on('online', on => { for (const x of [d, ...this.subs.get(d.id)?.values() ?? []]) for (const i of this.idsOf(x)) ctx.report(i, { online: on }); });
      this.conns.set(d.id, c);
    }
    for (const [gw, subs] of this.subs) {
      if (this.conns.has(gw)) continue;
      for (const sub of subs.values()) {
        ctx.log(`${sub.name ?? sub.id}: its gateway ${gw} isn't set up for local control; it stays offline`);
        this.unreachable.push(sub.id);
      }
      this.subs.delete(gw);
    }
    ctx.announce(infos);
    for (const id of this.unreachable) for (const i of this.idsOf(this.cfg.get(id)!)) ctx.report(i, { online: false });
    // Connect in the background; a switch that's offline shouldn't hold up the hub.
    for (const [id, c] of this.conns) {
      const d = this.cfg.get(id)!;
      const subs = [...this.subs.get(id)?.values() ?? []];
      const own = this.idsOf(d).length > 0;
      c.connect()
        // A gateway: ask each sub-device for its state (a plain gateway has none of its own to read).
        .then(async () => {
          if (own || !subs.length) await c.query();
          for (const sub of subs) await c.query(sub.cid).then(dps => { if (Object.keys(dps).length) this.onDps(sub, dps); }).catch(err => ctx.log(`${sub.name ?? sub.id}: ${err.message}`));
        })
        .catch(err => { ctx.log(`${id}: ${err.message}`); c.scheduleReconnect(); });
    }
  }

  private idsOf(d: TuyaDeviceConfig): string[] {
    return [...Object.keys(d.switches ?? {}).map(dp => switchId(d, dp)), ...(d.light ? [lightId(d)] : [])];
  }

  /** A spec that leaves out dp ids means the light's dps were guessed; what the device reports is the truth. */
  private remapLight(d: TuyaDeviceConfig, dps: Dps): void {
    const l = d.light;
    if (!l) return;
    const bools = Object.keys(dps).filter(k => typeof dps[k] === 'boolean');
    const ints = Object.keys(dps).filter(k => typeof dps[k] === 'number');
    const inRange = (k: string, lo?: number, hi?: number) => (dps[k] as number) >= (lo ?? 0) && (dps[k] as number) <= (hi ?? 1000);
    let moved = false;
    if (!(l.switch in dps) && bools.length) { l.switch = bools[0]; moved = true; }
    if (l.bri && !(l.bri in dps)) {
      const cand = ints.find(k => k !== l.switch && inRange(k, l.briMin, l.briMax));
      if (cand) { l.bri = cand; moved = true; }
    }
    if (l.temp && !(l.temp in dps)) {
      const cand = ints.find(k => k !== l.switch && k !== l.bri && inRange(k, l.tempMin, l.tempMax));
      if (cand) { l.temp = cand; moved = true; }
    }
    if (moved) this.ctx?.log(`${d.name ?? d.id}: its data points were not where the cloud spec said — using the ones it actually reports (switch ${l.switch}${l.bri ? `, brightness ${l.bri}` : ''}${l.temp ? `, warmth ${l.temp}` : ''})`);
  }

  private onDps(d: TuyaDeviceConfig, dps: Dps): void {
    this.remapLight(d, dps);
    const all = { ...this.known.get(d.id), ...dps };
    this.known.set(d.id, all);
    for (const dp of Object.keys(d.switches ?? {})) {
      if (typeof dps[dp] === 'boolean') this.ctx!.report(switchId(d, dp), { on: dps[dp] as boolean, online: true });
    }
    if (d.light) {
      const s = dpsToLight(d.light, all);
      if (Object.keys(s).length) this.ctx!.report(lightId(d), { ...s, online: true });
    }
  }

  async command(device: Device, cmd: Command): Promise<void> {
    const [devId, part] = device.address.split('/');
    const d = this.cfg.get(devId);
    if (!d) throw new Error(`Unknown Tuya device ${device.id}`);
    const c = this.conns.get(d.gateway ?? devId);
    if (!c) throw new Error(`${device.name} can't be reached: ${d.gateway ? 'its gateway is not set up for local control' : !d.host ? 'its IP address is not known yet' : 'it is not set up for local control'}`);
    const dps: Dps = part === 'light' && d.light ? lightToDps(d.light, cmd, device.state) : cmd.on !== undefined ? { [part]: !!cmd.on } : {};
    if (Object.keys(dps).length) await c.set(dps, d.gateway ? d.cid : undefined);
  }

  async stop(): Promise<void> { for (const c of this.conns.values()) c.close(); }

  status(): AdapterStatus {
    // A gateway counts as its sub-devices (they're up when it is), plus itself if it has switches of its own.
    let total = this.unreachable.length, off = this.unreachable.length;
    for (const [id, c] of this.conns) {
      const subs = this.subs.get(id)?.size ?? 0;
      const n = subs ? subs + (this.idsOf(this.cfg.get(id)!).length ? 1 : 0) : 1;
      total += n;
      if (!c.online) off += n;
    }
    if (!total) return { ok: false, note: 'No Tuya devices set up' };
    return off ? { ok: false, note: `${off} of ${total} not responding` } : { ok: true, note: `${total} devices, all local` };
  }
}
