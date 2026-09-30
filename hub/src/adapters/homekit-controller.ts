import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { Category, HttpClient, IPDiscovery, PairMethods, type HapServiceIp, type PairingData } from 'hap-controller';
import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from './sdk.ts';
import type { Capability, Command, Device, DeviceState, DeviceType } from '../model/types.ts';

// HomeKit accessories over IP, with Kova as the controller (like Home
// Assistant's homekit_controller). The opposite of bridges/homekit.ts, which
// exposes Kova *to* Apple Home. Pair-setup, pair-verify, the encrypted session
// and mDNS browsing come from `hap-controller` (MPL-2.0).
//
// An accessory can only have one admin controller pairing. To move an
// accessory from Apple Home to Kova, remove it from the Home app first (which
// resets its pairing), then pair it here with the code on its label.
//
// Mapping, one Kova device per HAP service:
//   Lightbulb (On, Brightness, ColorTemperature, Hue+Saturation) → dimmer, or light without Brightness
//   Outlet → plug;  Switch → light
//   Fan / Fanv2 / AirPurifier → fan (On or Active; TargetAirPurifierState / TargetFanState AUTO ↔ 'Auto', MANUAL ↔ 'Sleep')
//   anything else → ignored for now

// ------------------------------------------------------------- HAP types --

const hapUuid = (short: string) => `${short.padStart(8, '0')}-0000-1000-8000-0026BB765291`;
/** Full HAP UUIDs (as hap-controller normalises them) for the services and characteristics used here. */
export const HAP = {
  svc: {
    AccessoryInformation: hapUuid('3E'), Lightbulb: hapUuid('43'), Outlet: hapUuid('47'), Switch: hapUuid('49'),
    Fan: hapUuid('40'), Fanv2: hapUuid('B7'), AirPurifier: hapUuid('BB'),
  },
  chr: {
    Name: hapUuid('23'), On: hapUuid('25'), Brightness: hapUuid('8'), ColorTemperature: hapUuid('CE'),
    Hue: hapUuid('13'), Saturation: hapUuid('2F'), Active: hapUuid('B0'),
    TargetAirPurifierState: hapUuid('A8'), TargetFanState: hapUuid('BF'),
  },
} as const;

/** TargetAirPurifierState / TargetFanState values. */
export const TARGET_MANUAL = 0;
export const TARGET_AUTO = 1;

// ------------------------------------------------------------ conversions --

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** HAP booleans arrive as true/false or 1/0 depending on the accessory. */
export function hapBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Mireds → Kelvin, rounded to the nearest 10 K. */
export function miredToKelvin(m: number): number {
  if (!Number.isFinite(m) || m <= 0) return 2700;
  return Math.round(1_000_000 / m / 10) * 10;
}

/** Kelvin → mireds, clamped to the characteristic's range (HAP default 140–500). */
export function kelvinToMired(k: number, min = 140, max = 500): number {
  if (!Number.isFinite(k) || k <= 0) return max;
  return clamp(Math.round(1_000_000 / k), min, max);
}

/** HAP Hue (0–360) and Saturation (0–100) at full value → '#rrggbb'. */
export function hsToHex(h: number, s: number): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = clamp(s, 0, 100) / 100, x = c * (1 - Math.abs((hh % 2) - 1)), m = 1 - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** '#rrggbb' → HAP Hue (0–360) and Saturation (0–100). Brightness is Kova's `bri`, so the value channel is dropped. */
export function hexToHs(color: string): { h: number; s: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`Not a colour: ${color}`);
  const n = parseInt(m[1], 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round((h * 60 + 360) % 360), s: max ? Math.round((d / max) * 100) : 0 };
}

/** Kova bri → HAP Brightness (integer 0–100). */
export function toHapBrightness(bri: number): number {
  return clamp(Math.round(bri), 0, 100);
}

/** Kova fan mode → TargetAirPurifierState / TargetFanState. */
export function fanModeToTarget(mode: string | null | undefined): number {
  return mode === 'Auto' ? TARGET_AUTO : TARGET_MANUAL;
}

/** TargetAirPurifierState / TargetFanState → Kova fan mode. HAP has no finer manual modes, so manual reads as 'Sleep'. */
export function targetToFanMode(v: unknown): string {
  return Number(v) === TARGET_AUTO ? 'Auto' : 'Sleep';
}

/** 'AA:BB:CC:DD:EE:FF' → 'aabbccddeeff' (safe inside a Kova device id). */
export function sanitiseAccessoryId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function kovaDeviceId(accessoryId: string, aid: number, iid: number): string {
  return `homekit_${sanitiseAccessoryId(accessoryId)}_${aid}_${iid}`;
}

/** Accepts '123-45-678' or '12345678'; returns 'XXX-XX-XXX' or null if it isn't a setup code. */
export function normaliseSetupCode(code: string): string | null {
  const d = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** HAP pairing TLV error codes (spec table 5-5) → something a person can act on. */
export function pairingErrorMessage(code: number | undefined, fallback: string): string {
  switch (code) {
    case 2: return 'Wrong setup code';
    case 3: return 'The accessory asked to wait before trying again (too many attempts)';
    case 4: return 'The accessory has no room for another controller';
    case 5: return 'Too many failed attempts; reset the accessory and try again';
    case 6: return 'The accessory is already paired with another controller (remove it from that app first, or reset it)';
    case 7: return 'The accessory is busy pairing with another controller';
    default: return fallback;
  }
}

/** Prefer an IPv4 address from an mDNS record (link-local IPv6 needs a scope id to be useful). */
export function pickAddress(addresses: string[]): string | undefined {
  return addresses.find(a => isIPv4(a)) ?? addresses[0];
}

// ------------------------------------------------------ accessory mapping --

export type HapKind = 'lightbulb' | 'outlet' | 'switch' | 'fan';

/** One HAP service that became a Kova device. Plain data, so it can be cached on disk. */
export interface ServiceMap {
  deviceId: string;
  aid: number;
  iid: number;
  kind: HapKind;
  name: string;
  type: DeviceType;
  capabilities: Capability[];
  /** Characteristic iids by role. */
  chars: { on?: number; active?: number; bri?: number; ct?: number; hue?: number; sat?: number; target?: number };
  ctMin?: number;
  ctMax?: number;
  /** Characteristics that can send events. */
  evented: number[];
}

type HapChar = { iid?: number; type?: string; value?: unknown; perms?: string[]; minValue?: number; maxValue?: number };
type HapService = { iid: number; type: string; characteristics: HapChar[] };
/** The accessory database as GET /accessories returns it. */
export interface AccessoryDb { accessories: { aid: number; services: HapService[] }[] }

const KINDS: Record<string, HapKind> = {
  [HAP.svc.Lightbulb]: 'lightbulb', [HAP.svc.Outlet]: 'outlet', [HAP.svc.Switch]: 'switch',
  [HAP.svc.Fan]: 'fan', [HAP.svc.Fanv2]: 'fan', [HAP.svc.AirPurifier]: 'fan',
};

const upper = (s: string | undefined) => (s ?? '').toUpperCase();
const findChar = (s: HapService, type: string) => s.characteristics.find(c => upper(c.type) === type);

const KIND_LABEL: Record<HapKind, string> = { lightbulb: 'Light', outlet: 'Outlet', switch: 'Switch', fan: 'Fan' };

/**
 * A Kova device name for one service. A single-service accessory takes the
 * accessory's name (or the one given at pairing); services of a multi-service
 * accessory use their own Name, prefixed with the given name if there is one.
 */
export function serviceName(accName: string, override: string | undefined, svcName: string | undefined, kind: HapKind, count: number): string {
  const base = override ?? accName;
  if (count <= 1) return base;
  const own = svcName && svcName !== accName ? svcName : undefined;
  if (override) return `${override} ${own ?? KIND_LABEL[kind]}`;
  return own ?? `${accName} ${KIND_LABEL[kind]}`;
}

/** Initial values by iid, from the accessory database (readable characteristics carry `value`). */
export type Values = Map<number, unknown>;

/**
 * The accessory database (GET /accessories) → the services Kova understands.
 * Pure: names come from each service's Name, falling back to the accessory's.
 * Bridges (several aids) give one device per service of every bridged accessory.
 */
export function mapAccessories(accessoryId: string, db: AccessoryDb, nameOverride?: string): { services: ServiceMap[]; values: Map<string, Values> } {
  const services: ServiceMap[] = [];
  const values = new Map<string, Values>();
  // On a bridge each bridged accessory keeps its own name; a name given at pairing names a single accessory.
  const override = db.accessories.length === 1 ? nameOverride : undefined;
  for (const acc of db.accessories) {
    const svcs = acc.services;
    const info = svcs.find(s => upper(s.type) === HAP.svc.AccessoryInformation);
    const accName = String(info && findChar(info, HAP.chr.Name)?.value || accessoryId);
    const known = svcs.filter(s => KINDS[upper(s.type)]);
    known.forEach(s => {
      const kind = KINDS[upper(s.type)];
      const c = (type: string) => findChar(s, type);
      const iid = (type: string) => c(type)?.iid;
      const chars: ServiceMap['chars'] = {};
      const caps: Capability[] = ['onoff'];
      let type: DeviceType;
      if (kind === 'lightbulb') {
        chars.on = iid(HAP.chr.On);
        chars.bri = iid(HAP.chr.Brightness);
        chars.ct = iid(HAP.chr.ColorTemperature);
        chars.hue = iid(HAP.chr.Hue);
        chars.sat = iid(HAP.chr.Saturation);
        if (chars.bri) caps.push('brightness');
        if (chars.ct) caps.push('colorTemp');
        if (chars.hue && chars.sat) caps.push('color');
        else { delete chars.hue; delete chars.sat; }
        type = chars.bri ? 'dimmer' : 'light';
      } else if (kind === 'fan') {
        chars.active = iid(HAP.chr.Active);
        if (!chars.active) chars.on = iid(HAP.chr.On);
        chars.target = iid(HAP.chr.TargetAirPurifierState) ?? iid(HAP.chr.TargetFanState);
        if (chars.target) caps.push('fanMode');
        type = 'fan';
      } else {
        chars.on = iid(HAP.chr.On);
        type = kind === 'outlet' ? 'plug' : 'light';
      }
      for (const k of Object.keys(chars) as (keyof ServiceMap['chars'])[]) if (chars[k] == null) delete chars[k];
      if (chars.on == null && chars.active == null) return; // nothing to switch; not a service we can use
      const svcName = c(HAP.chr.Name)?.value as string | undefined;
      const name = serviceName(accName, override, svcName, kind, known.length);
      const ct = c(HAP.chr.ColorTemperature);
      const map: ServiceMap = {
        deviceId: kovaDeviceId(accessoryId, acc.aid, s.iid), aid: acc.aid, iid: s.iid, kind, name, type, capabilities: caps, chars,
        ...(ct ? { ctMin: ct.minValue ?? 140, ctMax: ct.maxValue ?? 500 } : {}),
        evented: Object.values(chars).filter(i => s.characteristics.find(x => x.iid === i)?.perms?.includes('ev')) as number[],
      };
      services.push(map);
      const v: Values = new Map();
      for (const i of Object.values(chars) as number[]) {
        const ch = s.characteristics.find(x => x.iid === i);
        if (ch && ch.value !== undefined) v.set(i, ch.value);
      }
      values.set(map.deviceId, v);
    });
  }
  return { services, values };
}

/** Which colour characteristic was set last decides whether a bulb reports `k` or `color`. */
export type ColorMode = 'ct' | 'hs';

/** Characteristic values → Kova state. */
export function stateFrom(m: ServiceMap, v: Values, colorMode?: ColorMode): DeviceState {
  const s: DeviceState = {};
  const get = (i: number | undefined) => (i == null ? undefined : v.get(i));
  const on = get(m.chars.active) ?? get(m.chars.on);
  if (on !== undefined) s.on = hapBool(on);
  if (m.kind === 'lightbulb') {
    const bri = get(m.chars.bri);
    if (typeof bri === 'number') s.bri = bri;
    const ct = get(m.chars.ct), hue = get(m.chars.hue), sat = get(m.chars.sat);
    const hs = typeof hue === 'number' && typeof sat === 'number';
    const mode = colorMode ?? (m.chars.ct == null ? 'hs' : 'ct');
    if (hs && (mode === 'hs' || typeof ct !== 'number')) { s.color = hsToHex(hue as number, sat as number); if (m.chars.ct != null) s.k = null; }
    else if (typeof ct === 'number') { s.k = miredToKelvin(ct); if (m.chars.hue != null) s.color = null; }
  }
  if (m.kind === 'fan') {
    const t = get(m.chars.target);
    if (t !== undefined) s.mode = targetToFanMode(t);
  }
  return s;
}

/** Kova command → characteristic writes (iid → value), in the order HAP accessories expect. */
export function writesFor(m: ServiceMap, cmd: Command): [number, unknown][] {
  const out: [number, unknown][] = [];
  const onIid = m.chars.active ?? m.chars.on;
  const onValue = (on: boolean) => (m.chars.active != null ? (on ? 1 : 0) : on);
  let on = cmd.on;
  if (cmd.bri != null && cmd.bri <= 0) on = false;
  if (on !== undefined && onIid != null) out.push([onIid, onValue(!!on)]);
  if (m.kind === 'lightbulb') {
    if (cmd.bri != null && cmd.bri > 0) {
      if (m.chars.bri == null) throw new Error(`${m.name} can't dim`);
      out.push([m.chars.bri, toHapBrightness(cmd.bri)]);
    }
    if (cmd.k != null) {
      if (m.chars.ct == null) throw new Error(`${m.name} has no colour temperature`);
      out.push([m.chars.ct, kelvinToMired(cmd.k, m.ctMin, m.ctMax)]);
    }
    if (cmd.color) {
      if (m.chars.hue == null || m.chars.sat == null) throw new Error(`${m.name} has no colour`);
      const { h, s } = hexToHs(cmd.color);
      out.push([m.chars.hue, h], [m.chars.sat, s]);
    }
  }
  if (m.kind === 'fan' && cmd.mode != null) {
    if (m.chars.target == null) throw new Error(`${m.name} has no modes`);
    out.push([m.chars.target, fanModeToTarget(cmd.mode)]);
  }
  return out;
}

// ------------------------------------------------------------------ adapter --

export interface HomeKitAccessoryConfig { id: string; name?: string; room?: string }

export interface HomeKitControllerOptions {
  /** Where pairings (long-term keys) are kept: `<KOVA_DATA>/homekit-controller`. */
  storageDir: string;
  /** Per-accessory overrides, by HAP device id ('AA:BB:CC:DD:EE:FF'). */
  accessories?: HomeKitAccessoryConfig[];
  /** Browse mDNS in the background to follow accessories that change IP. Default true. */
  mdns?: boolean;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** First reconnect delay; doubles up to 5 minutes. Default 2 s. */
  retryMs?: number;
  /** Room for accessories paired without one. */
  defaultRoom?: string;
}

export interface DiscoveredAccessory { id: string; name: string; category: string; host: string; port: number; paired: boolean }

interface PairingRecord {
  id: string;
  host: string;
  port: number;
  name?: string;
  room?: string;
  category?: string;
  pairing: PairingData;
  /** Last known services, so devices still show (offline) when the accessory is unreachable at start. */
  services?: ServiceMap[];
}

interface Session {
  rec: PairingRecord;
  client?: HttpClient;
  online: boolean;
  services: ServiceMap[];
  values: Map<string, Values>;
  colorMode: Map<string, ColorMode>;
  retry?: NodeJS.Timeout;
  delay: number;
  /** Bumped on every (re)connect so late callbacks from an old client are ignored. */
  gen: number;
  connecting?: Promise<void>;
}

const FILE = 'pairings.json';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

export class HomeKitControllerAdapter implements Adapter {
  id = 'homekit';
  name = 'HomeKit devices';
  icon = 'home';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private sessions = new Map<string, Session>();
  private byDevice = new Map<string, { s: Session; m: ServiceMap }>();
  private seen = new Map<string, HapServiceIp>();
  private browser?: IPDiscovery;
  private stopped = false;

  constructor(private opts: HomeKitControllerOptions) {}

  private get timeout() { return this.opts.timeoutMs ?? 10_000; }
  private cfg(id: string) { return this.opts.accessories?.find(a => a.id.toUpperCase() === id.toUpperCase()); }
  private roomOf(rec: PairingRecord) { return this.cfg(rec.id)?.room ?? rec.room ?? this.opts.defaultRoom ?? 'unassigned'; }
  private nameOf(rec: PairingRecord) { return this.cfg(rec.id)?.name ?? rec.name; }

  // ---------------------------------------------------------- storage --

  private load(): Record<string, PairingRecord> {
    const f = join(this.opts.storageDir, FILE);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as Record<string, PairingRecord> : {};
  }

  private save(): void {
    mkdirSync(this.opts.storageDir, { recursive: true, mode: 0o700 });
    const f = join(this.opts.storageDir, FILE), tmp = `${f}.tmp`;
    const all = Object.fromEntries([...this.sessions].map(([id, s]) => [id, { ...s.rec, services: s.services.length ? s.services : s.rec.services }]));
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  }

  /** Paired accessory ids. */
  get paired(): string[] { return [...this.sessions.keys()]; }

  // ------------------------------------------------------------ start --

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    for (const rec of Object.values(this.load())) {
      const s = this.addSession(rec);
      if (rec.services?.length) this.announce(s, rec.services, false);
    }
    if (this.opts.mdns !== false) this.browse();
    // Connect in the background; an unreachable accessory shouldn't hold up the hub.
    for (const s of this.sessions.values()) void this.connect(s).catch(() => {});
  }

  private addSession(rec: PairingRecord): Session {
    const s: Session = { rec, online: false, services: [], values: new Map(), colorMode: new Map(), delay: this.opts.retryMs ?? 2000, gen: 0 };
    this.sessions.set(rec.id, s);
    return s;
  }

  private browse(): void {
    try {
      const b = new IPDiscovery();
      const seen = (svc: HapServiceIp) => {
        if (!svc.id) return;
        const id = svc.id.toUpperCase();
        const prev = this.seen.get(id);
        this.seen.set(id, svc);
        const s = this.sessions.get(id);
        if (!s) return;
        const host = pickAddress(svc.allAddresses ?? [svc.address]) ?? svc.address;
        const moved = host !== s.rec.host || svc.port !== s.rec.port;
        const reconfigured = prev && prev['c#'] !== svc['c#'];
        if (moved) { s.rec.host = host; s.rec.port = svc.port; this.save(); }
        if (moved || reconfigured || !s.online) { s.delay = this.opts.retryMs ?? 2000; void this.connect(s).catch(() => {}); }
      };
      b.on('serviceUp', seen);
      b.on('serviceChanged', seen);
      b.start();
      this.browser = b;
    } catch (err) {
      this.ctx?.log(`mDNS browsing unavailable: ${(err as Error).message}`);
    }
  }

  /** Pair-verify, read the accessory database, announce, subscribe. */
  private connect(s: Session): Promise<void> {
    if (s.connecting) return s.connecting;
    const run = async () => {
      if (s.retry) { clearTimeout(s.retry); s.retry = undefined; }
      await this.drop(s);
      const gen = ++s.gen;
      const client = new HttpClient(s.rec.id, s.rec.host, s.rec.port, s.rec.pairing, { usePersistentConnections: true });
      s.client = client;
      try {
        const db = await withTimeout(client.getAccessories(), this.timeout, `${this.label(s)}`) as unknown as AccessoryDb;
        if (gen !== s.gen || this.stopped) return;
        const { services, values } = mapAccessories(s.rec.id, db, this.nameOf(s.rec));
        s.services = services;
        s.values = values;
        this.announce(s, services, true);
        client.on('event', (ev: { characteristics?: { aid: number; iid: number; value: unknown }[] }) => { if (gen === s.gen) this.onEvent(s, ev.characteristics ?? []); });
        client.on('event-disconnect', () => { if (gen === s.gen) this.lost(s, 'connection closed'); });
        const ev = services.flatMap(m => m.evented.map(i => `${m.aid}.${i}`));
        if (ev.length) await withTimeout(client.subscribeCharacteristics(ev), this.timeout, `${this.label(s)} subscribe`);
        if (gen !== s.gen) return;
        s.online = true;
        s.delay = this.opts.retryMs ?? 2000;
        for (const m of services) this.ctx!.report(m.deviceId, { ...stateFrom(m, values.get(m.deviceId)!, s.colorMode.get(m.deviceId)), online: true });
        this.save();
      } catch (err) {
        if (gen === s.gen) this.lost(s, (err as Error).message);
        throw err;
      }
    };
    s.connecting = run().finally(() => { s.connecting = undefined; });
    return s.connecting;
  }

  private label(s: Session): string { return this.nameOf(s.rec) ?? s.rec.name ?? s.rec.id; }

  private announce(s: Session, services: ServiceMap[], online: boolean): void {
    for (const m of services) this.byDevice.set(m.deviceId, { s, m });
    const room = this.roomOf(s.rec);
    this.ctx!.announce(services.map(m => ({
      id: m.deviceId, name: m.name, room, type: m.type, capabilities: m.capabilities,
      integration: 'HomeKit', address: `${s.rec.id}/${m.aid}.${m.iid}`, ...(online ? {} : { state: { online: false } }),
    } satisfies DeviceInfo)));
    if (!online) for (const m of services) this.ctx!.report(m.deviceId, { online: false });
  }

  private onEvent(s: Session, chars: { aid: number; iid: number; value: unknown }[]): void {
    const touched = new Set<ServiceMap>();
    // Like Apple's controllers, read a batched EVENT newest-last from the end:
    // hap-nodejs (and others) put the latest value of a characteristic first.
    for (const c of [...chars].reverse()) {
      const aid = Number(c.aid), iid = Number(c.iid);
      const m = s.services.find(x => x.aid === aid && Object.values(x.chars).includes(iid));
      if (!m) continue;
      s.values.get(m.deviceId)?.set(iid, c.value);
      if (iid === m.chars.ct) s.colorMode.set(m.deviceId, 'ct');
      if (iid === m.chars.hue || iid === m.chars.sat) s.colorMode.set(m.deviceId, 'hs');
      touched.add(m);
    }
    for (const m of touched) this.ctx?.report(m.deviceId, { ...stateFrom(m, s.values.get(m.deviceId)!, s.colorMode.get(m.deviceId)), online: true });
  }

  /** Mark the accessory unreachable and retry with backoff. */
  private lost(s: Session, why: string): void {
    const was = s.online;
    s.online = false;
    s.gen++;
    void this.drop(s);
    for (const m of s.services.length ? s.services : s.rec.services ?? []) this.ctx?.report(m.deviceId, { online: false });
    if (was || !s.retry) this.ctx?.log(`${this.label(s)} (${s.rec.host}:${s.rec.port}) unreachable: ${why}; retrying in ${(s.delay / 1000).toFixed(1)} s`);
    if (this.stopped || s.retry) return;
    s.retry = setTimeout(() => { s.retry = undefined; void this.connect(s).catch(() => {}); }, s.delay);
    s.delay = Math.min(s.delay * 2, 5 * 60_000);
  }

  private async drop(s: Session): Promise<void> {
    const c = s.client;
    s.client = undefined;
    if (!c) return;
    c.removeAllListeners();
    try { await c.close(); } catch { /* already closed */ }
  }

  // --------------------------------------------------------- commands --

  async command(device: Device, cmd: Command): Promise<void> {
    const hit = this.byDevice.get(device.id);
    if (!hit) throw new Error(`Unknown HomeKit device ${device.id}`);
    const { s, m } = hit;
    const writes = writesFor(m, cmd);
    if (!writes.length) return;
    if (!s.online || !s.client) throw new Error(`${device.name} is offline (HomeKit accessory ${s.rec.host}:${s.rec.port})`);
    const body = Object.fromEntries(writes.map(([iid, value]) => [`${m.aid}.${iid}`, value]));
    let res: Record<string, unknown>;
    try {
      res = await withTimeout(s.client.setCharacteristics(body), this.timeout, `${device.name}`);
    } catch (err) {
      this.lost(s, (err as Error).message);
      throw new Error(`${device.name} didn't accept the command: ${(err as Error).message}`);
    }
    const failed = ((res as { characteristics?: { iid: unknown; status?: number }[] }).characteristics ?? []).filter(c => c.status != null && c.status !== 0);
    if (failed.length) throw new Error(`${device.name} refused the command (HAP status ${failed.map(f => f.status).join(', ')})`);
    const v = s.values.get(m.deviceId)!;
    for (const [iid, value] of writes) v.set(iid, value);
    if (cmd.k != null) s.colorMode.set(m.deviceId, 'ct');
    if (cmd.color) s.colorMode.set(m.deviceId, 'hs');
  }

  // ---------------------------------------------------------- pairing --

  /** Browse mDNS for HAP accessories for `ms` milliseconds. */
  async discover(ms = 3000): Promise<DiscoveredAccessory[]> {
    const b = this.browser ?? new IPDiscovery();
    const own = !this.browser;
    if (own) {
      b.on('serviceUp', (svc: HapServiceIp) => { if (svc.id) this.seen.set(svc.id.toUpperCase(), svc); });
      b.on('serviceChanged', (svc: HapServiceIp) => { if (svc.id) this.seen.set(svc.id.toUpperCase(), svc); });
      b.start();
      await new Promise(r => setTimeout(r, ms));
    }
    const list = b.list();
    if (own) b.stop();
    for (const svc of list) if (svc.id) this.seen.set(svc.id.toUpperCase(), svc);
    return list.filter(svc => svc.id).map(svc => ({
      id: svc.id.toUpperCase(),
      name: svc.name,
      category: Number.isFinite(svc.ci) ? Category.categoryFromId(svc.ci) : 'Unknown',
      host: pickAddress(svc.allAddresses ?? [svc.address]) ?? svc.address,
      port: svc.port,
      paired: this.sessions.has(svc.id.toUpperCase()) || !svc.availableToPair,
    }));
  }

  /**
   * Pair-setup with an accessory using the code on its label, save the
   * long-term keys, then connect and announce its devices. `host`/`port`
   * skip mDNS (for networks where it doesn't reach).
   */
  async pair(deviceId: string, setupCode: string, o: { room?: string; name?: string; host?: string; port?: number } = {}): Promise<DeviceInfo[]> {
    const id = String(deviceId ?? '').toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(id)) throw new Error(`Not a HomeKit accessory id: ${deviceId}`);
    const code = normaliseSetupCode(setupCode);
    if (!code) throw new Error('The setup code should look like 123-45-678');
    if (this.sessions.get(id)?.online) throw new Error('Already paired with Kova');
    let svc = this.seen.get(id);
    if (!o.host && !svc) { await this.discover(); svc = this.seen.get(id); }
    const host = o.host ?? (svc && pickAddress(svc.allAddresses ?? [svc.address]));
    const port = o.port ?? svc?.port;
    if (!host || !port) throw new Error(`Couldn't find HomeKit accessory ${id} on the network`);
    // MFi accessories with an authentication coprocessor use "pair-setup with auth".
    const method = svc && (svc.ff & 0x01) ? PairMethods.PairSetupWithAuth : PairMethods.PairSetup;
    const client = new HttpClient(id, host, port);
    try {
      await withTimeout(client.pairSetup(code, method), Math.max(this.timeout, 30_000), 'Pairing');
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      throw new Error(`HomeKit pairing failed: ${pairingErrorMessage(e.statusCode, e.message)}`);
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
    const pairing = client.getLongTermData();
    if (!pairing) throw new Error('HomeKit pairing failed: no keys returned');
    const old = this.sessions.get(id);
    if (old) { if (old.retry) clearTimeout(old.retry); old.gen++; await this.drop(old); }
    const s = this.addSession({ id, host, port, pairing, room: o.room, name: o.name, category: svc ? Category.categoryFromId(svc.ci) : undefined });
    this.save();
    try {
      await this.connect(s);
    } catch (err) {
      throw new Error(`Paired, but couldn't read the accessory yet (${(err as Error).message}); Kova will keep trying`);
    }
    return s.services.map(m => ({ id: m.deviceId, name: m.name, room: this.roomOf(s.rec), type: m.type, capabilities: m.capabilities, integration: 'HomeKit', address: `${id}/${m.aid}.${m.iid}` }));
  }

  // ------------------------------------------------------------- stop --

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.browser?.stop(); } catch { /* ignore */ }
    this.browser = undefined;
    await Promise.all([...this.sessions.values()].map(async s => {
      if (s.retry) { clearTimeout(s.retry); s.retry = undefined; }
      s.gen++;
      await this.drop(s);
    }));
  }

  status(): AdapterStatus {
    const all = [...this.sessions.values()];
    if (!all.length) return { ok: true, note: 'No HomeKit accessories paired yet' };
    const off = all.filter(s => !s.online).length;
    return off ? { ok: false, note: `${off} of ${all.length} not responding` } : { ok: true, note: `${all.length} accessor${all.length === 1 ? 'y' : 'ies'}` };
  }
}
