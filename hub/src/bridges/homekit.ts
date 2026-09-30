import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Accessory, Bridge, Categories, Characteristic, HAPStatus, HAPStorage, HapStatusError, MDNSAdvertiser, Service, uuid,
  type CharacteristicValue, type WithUUID,
} from 'hap-nodejs';
import type { Hub } from '../hub.ts';
import type { Cause, Command, Device, DeviceState, Overlay } from '../model/types.ts';

// Apple Home bridge. Publishes one HAP bridge accessory and exposes Kova's
// devices and overlays behind it, so iPhones, the Home app and Siri can see
// and control them. It sits on top of the registry: every write goes through
// engine.command() / startOverlay() like any other user action, and registry
// changes are pushed back to HomeKit as characteristic updates.
//
// Mapping:
//   light  → Lightbulb (On)
//   dimmer → Lightbulb (On, Brightness, + ColorTemperature with 'colorTemp', + Hue/Saturation with 'color')
//   plug   → Outlet (On, OutletInUse)
//   fan    → AirPurifier (Active, CurrentAirPurifierState, TargetAirPurifierState)
//   media / tv / camera / sensor → not exposed (a speaker has no good HomeKit
//   service outside AirPlay, and cameras need HomeKit Secure Video streaming).
//   overlays → a Switch each; on starts the overlay, off ends it.

export const CAUSE: Cause = { kind: 'user', label: 'Apple Home' };

/** HomeKit's ColorTemperature range, in mireds (≈ 7143K–2000K). */
export const MIRED_MIN = 140;
export const MIRED_MAX = 500;
/** HAP allows at most 150 accessories per bridge, the bridge itself included. */
export const MAX_BRIDGED = 149;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------ conversions --

/** Kelvin → mireds, clamped to HomeKit's 140–500 range. */
export function kelvinToMired(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return MIRED_MAX;
  return clamp(Math.round(1_000_000 / k), MIRED_MIN, MIRED_MAX);
}

/** Mireds → Kelvin (mireds clamped to 140–500 first), rounded to the nearest 10K. */
export function miredToKelvin(m: number): number {
  const k = 1_000_000 / clamp(m, MIRED_MIN, MIRED_MAX);
  return Math.round(k / 10) * 10;
}

/** HomeKit hue (0–360) and saturation (0–100) at full value → '#rrggbb'. */
export function hsToHex(h: number, s: number): string {
  const hh = ((h % 360) + 360) % 360 / 60;
  const ss = clamp(s, 0, 100) / 100;
  const c = ss, x = c * (1 - Math.abs((hh % 2) - 1)), m = 1 - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** '#rrggbb' → HomeKit hue (0–360) and saturation (0–100). Brightness lives in Kova's `bri`, so value is dropped. */
export function hexToHs(color: string): { h: number; s: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return { h: 0, s: 0 };
  const n = parseInt(m[1], 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(((h * 60) + 360) % 360);
  const s = max ? Math.round((d / max) * 100) : 0;
  return { h, s };
}

/** Kova bri (0–100, may be null) → HomeKit Brightness (integer 0–100). */
export function toHomeKitBrightness(bri: number | null | undefined): number {
  return bri == null || !Number.isFinite(bri) ? 100 : clamp(Math.round(bri), 0, 100);
}

/** HomeKit Brightness write → Kova command. 0 means off; anything else also switches the light on. */
export function brightnessCommand(v: number): Command {
  const bri = clamp(Math.round(v), 0, 100);
  return bri === 0 ? { on: false } : { on: true, bri };
}

/** Kova fan mode → TargetAirPurifierState: 'Auto' is AUTO (1), anything else MANUAL (0). */
export function fanModeToTarget(mode: string | null | undefined): number {
  return mode === 'Auto' ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL;
}

/**
 * TargetAirPurifierState write → Kova fan mode. AUTO is 'Auto'. MANUAL keeps
 * the current manual mode if there is one, otherwise picks 'Sleep' (the only
 * manual mode the demo home's purifiers use).
 */
export function targetToFanMode(target: number, current: string | null | undefined): string {
  if (target === Characteristic.TargetAirPurifierState.AUTO) return 'Auto';
  return current && current !== 'Auto' ? current : 'Sleep';
}

/** HomeKit names: letters, numbers, spaces and apostrophes, starting and ending with a letter or number. */
export function homeKitName(s: string): string {
  const out = s.replace(/[^\p{L}\p{N} ']+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim();
  return (out || 'Kova').slice(0, 64);
}

/** Codes HomeKit rejects as too trivial. */
const INVALID_PINS = new Set(['12345678', '87654321', ...Array.from({ length: 10 }, (_, i) => String(i).repeat(8))]);

export function isValidPincode(pin: string): boolean {
  if (!/^\d{3}-\d{2}-\d{3}$/.test(pin)) return false;
  return !INVALID_PINS.has(pin.replace(/-/g, ''));
}

/** A random valid 'XXX-XX-XXX' setup code. */
export function generatePincode(rand: (max: number) => number = randomInt): string {
  for (;;) {
    const d = Array.from({ length: 8 }, () => rand(10)).join('');
    const pin = `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    if (isValidPincode(pin)) return pin;
  }
}

/** A random locally-administered unicast MAC, used as the bridge's HAP username. */
export function generateUsername(): string {
  const b = randomBytes(6);
  b[0] = (b[0] | 0x02) & 0xfe;
  return [...b].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

const SETUP_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function generateSetupID(rand: (max: number) => number = randomInt): string {
  return Array.from({ length: 4 }, () => SETUP_ID_CHARS[rand(SETUP_ID_CHARS.length)]).join('');
}

/**
 * The X-HM:// setup payload encoded in a HomeKit QR code. Same encoding as
 * hap-nodejs' Accessory.setupURI(), but usable before the bridge is published.
 */
export function setupURI(pincode: string, setupID: string, category: number = Categories.BRIDGE): string {
  const low = (parseInt(pincode.replace(/-/g, ''), 10) | (1 << 28)) >>> 0 | ((category & 1) << 31);
  const value = BigInt(category >> 1) * 0x1_0000_0000n + BigInt(low >>> 0);
  return `X-HM://${value.toString(36).toUpperCase().padStart(9, '0')}${setupID}`;
}

/** Stable accessory UUIDs, so a restart or rename keeps the Home app's room and scene assignments. */
export const deviceUUID = (id: string) => uuid.generate(`kova:device:${id}`);
export const overlayUUID = (id: string) => uuid.generate(`kova:overlay:${id}`);

/** Whether (and how) a Kova device is exposed. */
export function homeKitKind(d: Pick<Device, 'type'>): 'lightbulb' | 'outlet' | 'purifier' | null {
  switch (d.type) {
    case 'light': case 'dimmer': return 'lightbulb';
    case 'plug': return 'outlet';
    case 'fan': return 'purifier';
    default: return null;
  }
}

// ------------------------------------------------------------------ bridge --

export interface HomeKitOptions {
  /** Where the bridge identity and hap-nodejs pairing data live. */
  storageDir: string;
  /** HAP TCP port. Default 51826. */
  port?: number;
  /** Setup code 'XXX-XX-XXX'. Generated and persisted on first run when omitted. */
  pincode?: string;
  /** Bridge name. Defaults to the home's name, or "Kova". */
  name?: string;
  /** mDNS advertiser. Default ciao (pure JS); Avahi suits hosts that already run avahi-daemon. */
  advertiser?: MDNSAdvertiser;
}

interface Identity { username: string; pincode: string; setupID: string }

interface Binding { char: Characteristic; read: () => CharacteristicValue }
interface Entry { accessory: Accessory; bindings: Binding[] }

export class HomeKitBridge {
  readonly bridge: Bridge;
  readonly identity: Identity;
  /** Bridged accessories by Kova device id / overlay id. */
  readonly devices = new Map<string, Entry>();
  readonly overlays = new Map<string, Entry>();
  private published = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(private hub: Hub, private opts: HomeKitOptions) {
    this.identity = this.loadIdentity();
    const name = homeKitName(opts.name ?? (hub.config.get().name || 'Kova'));
    this.bridge = new Bridge(name, uuid.generate(`kova:bridge:${this.identity.username}`));
    this.bridge.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Kova')
      .setCharacteristic(Characteristic.Model, 'Kova hub')
      .setCharacteristic(Characteristic.SerialNumber, this.identity.username)
      .setCharacteristic(Characteristic.FirmwareRevision, '0.1.0');
    this.reconcile();

    const onChange = ({ device }: { device: Device }) => this.push(this.devices.get(device.id));
    const onDevices = () => this.reconcile();
    const onEngine = () => { for (const e of this.overlays.values()) this.push(e); };
    const onConfig = () => this.reconcile();
    this.hub.reg.on('change', onChange);
    this.hub.reg.on('devices', onDevices);
    this.hub.engine.on('changed', onEngine);
    this.hub.config.on('changed', onConfig);
    this.unsubs.push(
      () => this.hub.reg.off('change', onChange),
      () => this.hub.reg.off('devices', onDevices),
      () => this.hub.engine.off('changed', onEngine),
      () => this.hub.config.off('changed', onConfig),
    );
  }

  /** Publish the bridge on the network (HAP server + mDNS). */
  async start(): Promise<void> {
    if (this.published) return;
    try { HAPStorage.setCustomStoragePath(this.opts.storageDir); } catch { /* already initialised in this process */ }
    await this.bridge.publish({
      username: this.identity.username,
      pincode: this.identity.pincode,
      setupID: this.identity.setupID,
      port: this.opts.port ?? 51826,
      category: Categories.BRIDGE,
      advertiser: this.opts.advertiser ?? MDNSAdvertiser.CIAO,
    });
    this.published = true;
  }

  /** Unpublish and stop listening to the hub. Pairings stay on disk for the next start. */
  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
    if (this.published) { this.published = false; await this.bridge.unpublish(); }
  }

  setupInfo(): { pincode: string; setupURI: string } {
    return { pincode: this.identity.pincode, setupURI: setupURI(this.identity.pincode, this.identity.setupID) };
  }

  get paired(): boolean {
    return this.bridge._accessoryInfo?.paired() ?? false;
  }

  get isPublished(): boolean { return this.published; }

  // ------------------------------------------------------------ identity --

  private loadIdentity(): Identity {
    mkdirSync(this.opts.storageDir, { recursive: true });
    const file = join(this.opts.storageDir, 'kova-bridge.json');
    let saved: Partial<Identity> = {};
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
    if (this.opts.pincode && !isValidPincode(this.opts.pincode)) throw new Error(`Invalid HomeKit pincode ${this.opts.pincode} (want XXX-XX-XXX, not a trivial code)`);
    const id: Identity = {
      username: saved.username && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(saved.username) ? saved.username : generateUsername(),
      pincode: this.opts.pincode ?? (saved.pincode && isValidPincode(saved.pincode) ? saved.pincode : generatePincode()),
      setupID: saved.setupID && /^[0-9A-Z]{4}$/.test(saved.setupID) ? saved.setupID : generateSetupID(),
    };
    if (id.username !== saved.username || id.pincode !== saved.pincode || id.setupID !== saved.setupID) {
      writeFileSync(file, JSON.stringify(id, null, 2) + '\n', { mode: 0o600 });
    }
    return id;
  }

  // ----------------------------------------------------------- accessories --

  private name(d: Device): string {
    const room = this.hub.config.get().rooms.find(r => r.id === d.room)?.name;
    return homeKitName(room ? `${room} ${d.name}` : d.name);
  }

  /** Bring the bridged accessories in line with the registry and the overlays in config. */
  reconcile(): void {
    const add: Accessory[] = [];
    const remove: Accessory[] = [];
    const wantDevices = new Set(this.hub.reg.list().filter(d => homeKitKind(d)).map(d => d.id));
    const wantOverlays = new Set(this.hub.config.get().overlays.map(o => o.id));
    for (const [id, e] of this.devices) if (!wantDevices.has(id)) { remove.push(e.accessory); this.devices.delete(id); }
    for (const [id, e] of this.overlays) if (!wantOverlays.has(id)) { remove.push(e.accessory); this.overlays.delete(id); }

    let count = this.devices.size + this.overlays.size;
    for (const o of this.hub.config.get().overlays) {
      if (this.overlays.has(o.id) || count >= MAX_BRIDGED) continue;
      const e = this.overlayAccessory(o);
      this.overlays.set(o.id, e); add.push(e.accessory); count++;
    }
    for (const d of this.hub.reg.list()) {
      if (!wantDevices.has(d.id) || this.devices.has(d.id)) continue;
      if (count >= MAX_BRIDGED) { console.warn(`[homekit] bridge full, ${d.id} not exposed`); continue; }
      const e = this.deviceAccessory(d);
      this.devices.set(d.id, e); add.push(e.accessory); count++;
    }
    if (remove.length) this.bridge.removeBridgedAccessories(remove);
    if (add.length) this.bridge.addBridgedAccessories(add);
  }

  private info(acc: Accessory, model: string, serial: string): void {
    acc.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Kova')
      .setCharacteristic(Characteristic.Model, model || 'Kova device')
      .setCharacteristic(Characteristic.SerialNumber, serial)
      .setCharacteristic(Characteristic.FirmwareRevision, '0.1.0');
  }

  private state(id: string): DeviceState {
    const d = this.hub.reg.get(id);
    if (!d) throw new HapStatusError(HAPStatus.RESOURCE_DOES_NOT_EXIST);
    if (d.state.online === false) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return d.state;
  }

  private async send(id: string, cmd: Command): Promise<void> {
    try { await this.hub.engine.command(id, cmd, CAUSE); } catch { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  }

  /** Wire one characteristic: get reads live registry state, set sends a Kova command. */
  private bind(bindings: Binding[], service: Service, type: WithUUID<new () => Characteristic>, id: string,
    read: (s: DeviceState) => CharacteristicValue, write?: (v: CharacteristicValue, s: DeviceState) => Command): void {
    const char = service.getCharacteristic(type);
    const get = () => read(this.state(id));
    char.onGet(get);
    if (write) char.onSet(async v => this.send(id, write(v, this.state(id))));
    bindings.push({ char, read: () => read(this.hub.reg.get(id)?.state ?? {}) });
  }

  private deviceAccessory(d: Device): Entry {
    const name = this.name(d);
    const acc = new Accessory(name, deviceUUID(d.id));
    this.info(acc, d.integration, d.id);
    const b: Binding[] = [];
    const id = d.id;
    const caps = d.capabilities;
    switch (homeKitKind(d)) {
      case 'lightbulb': {
        acc.category = Categories.LIGHTBULB;
        const s = acc.addService(Service.Lightbulb, name);
        this.bind(b, s, Characteristic.On, id, st => !!st.on, v => ({ on: !!v }));
        if (d.type === 'dimmer') {
          this.bind(b, s, Characteristic.Brightness, id, st => toHomeKitBrightness(st.bri), v => brightnessCommand(Number(v)));
          if (caps.includes('colorTemp')) {
            s.getCharacteristic(Characteristic.ColorTemperature).setProps({ minValue: MIRED_MIN, maxValue: MIRED_MAX });
            this.bind(b, s, Characteristic.ColorTemperature, id, st => kelvinToMired(st.k ?? 2700), v => ({ k: miredToKelvin(Number(v)), color: null }));
          }
          if (caps.includes('color')) {
            // Hue and Saturation arrive as separate writes; each pairs with the other's current HomeKit value.
            const hue = s.getCharacteristic(Characteristic.Hue), sat = s.getCharacteristic(Characteristic.Saturation);
            this.bind(b, s, Characteristic.Hue, id, st => st.color ? hexToHs(st.color).h : 0, v => ({ color: hsToHex(Number(v), Number(sat.value ?? 0)), k: null }));
            this.bind(b, s, Characteristic.Saturation, id, st => st.color ? hexToHs(st.color).s : 0, v => ({ color: hsToHex(Number(hue.value ?? 0), Number(v)), k: null }));
          }
        }
        break;
      }
      case 'outlet': {
        acc.category = Categories.OUTLET;
        const s = acc.addService(Service.Outlet, name);
        this.bind(b, s, Characteristic.On, id, st => !!st.on, v => ({ on: !!v }));
        this.bind(b, s, Characteristic.OutletInUse, id, st => !!st.on && (st.power == null || st.power > 0));
        break;
      }
      case 'purifier': {
        acc.category = Categories.AIR_PURIFIER;
        const s = acc.addService(Service.AirPurifier, name);
        const A = Characteristic.Active, C = Characteristic.CurrentAirPurifierState;
        this.bind(b, s, A, id, st => st.on ? A.ACTIVE : A.INACTIVE, v => ({ on: v === A.ACTIVE }));
        this.bind(b, s, C, id, st => st.on ? C.PURIFYING_AIR : C.INACTIVE);
        this.bind(b, s, Characteristic.TargetAirPurifierState, id, st => fanModeToTarget(st.mode), (v, st) => ({ mode: targetToFanMode(Number(v), st.mode) }));
        break;
      }
    }
    const e = { accessory: acc, bindings: b };
    this.push(e);
    return e;
  }

  private overlayAccessory(o: Overlay): Entry {
    const name = homeKitName(o.name);
    const acc = new Accessory(name, overlayUUID(o.id));
    acc.category = Categories.SWITCH;
    this.info(acc, 'Kova overlay', `overlay-${o.id}`);
    const s = acc.addService(Service.Switch, name);
    const char = s.getCharacteristic(Characteristic.On);
    const read = () => this.hub.engine.overlay?.id === o.id;
    char.onGet(read);
    char.onSet(async v => {
      try {
        if (v) await this.hub.engine.startOverlay(o.id, CAUSE);
        else if (read()) await this.hub.engine.endOverlay('user');
      } catch { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
    });
    const e = { accessory: acc, bindings: [{ char, read }] };
    this.push(e);
    return e;
  }

  /** Push current Kova values to HomeKit (notifies paired controllers when a value changed). */
  private push(e: Entry | undefined): void {
    if (!e) return;
    for (const { char, read } of e.bindings) {
      const v = read();
      if (char.value !== v) char.updateValue(v);
    }
  }
}
