import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Endpoint, Environment, Logger, LogLevel, ServerNode, VendorId } from '@matter/main';
import { NodeJsEnvironment } from '@matter/nodejs';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { ColorControlServer } from '@matter/main/behaviors/color-control';
import { FanControlServer } from '@matter/main/behaviors/fan-control';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { ColorTemperatureLightDevice } from '@matter/main/devices/color-temperature-light';
import { ExtendedColorLightDevice } from '@matter/main/devices/extended-color-light';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { AirPurifierDevice } from '@matter/main/devices/air-purifier';
import { ThermostatDevice } from '@matter/main/devices/thermostat';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import type { Hub } from '../hub.ts';
import type { Cause, Command, Device, DeviceState, FanSpeed, HvacMode, Overlay } from '../model/types.ts';
import type { RoomAc, RoomAcChange } from '../engine/room-climate.ts';
import { briToLevel, levelToBri, kelvinToMireds, miredsToKelvin, hexToHueSat, hueSatToHex, hexToXy, xyToHex } from '../adapters/matter.ts';

// Matter bridge. Kova publishes itself as a Matter bridge (an aggregator) so
// Google Home, Alexa, SmartThings and Apple Home can add Kova's devices over
// Matter, locally. The reverse of adapters/matter.ts: there Kova is the
// controller, here it is the device. Like the Apple Home bridge, it sits on top
// of the registry: every write from a controller goes through engine.command()
// / startOverlay() like any other user action, and registry changes are pushed
// back to the endpoints (as local, "offline" writes, which are never read back
// as controller commands, so nothing echoes).
//
// Mapping:
//   light  → On/Off Light
//   dimmer → Dimmable Light, Color Temperature Light ('colorTemp') or Extended Color Light ('color')
//   plug   → On/Off Plug-in Unit
//   fan    → Air Purifier (Fan Control: Off / Low = Sleep / High = Manual / Auto)
//   media / tv / camera / sensor → not exposed.
//   overlays → an On/Off Plug-in Unit each, "Kova Movie": on starts the overlay, off ends it.
//   room ACs → a Thermostat each, "<Room> AC", for every room a ducted unit's zone serves (engine/room-climate.ts):
//     SystemMode Off/Cool/Heat/Auto/Fan only/Dry, both set points on the unit's one set temperature, the room's
//     temperature, and a Fan Control cluster for the unit's fan. Thermostat rather than Room Air Conditioner:
//     Google Home supports Thermostat over Matter, and doesn't list Room Air Conditioner. Writes go to the room-AC
//     policy, not straight to the unit: "on" opens the room's zone and lets Kova choose the mode.

/** Default cause for writes from a controller. Apple, Amazon and Samsung fabrics get their own label (see causeFor). */
export const CAUSE: Cause = { kind: 'user', label: 'Google Home' };

/** Matter test vendor / product ids. Certified ids need CSA membership; see the docs for what that means per ecosystem. */
export const TEST_VENDOR_ID = 0xfff1;
export const TEST_PRODUCT_ID = 0x8000;

/** Devices Kova got from these adapters are already in the ecosystems the bridge serves. */
export const DEFAULT_EXCLUDED_ADAPTERS = ['matter', 'homekit'];

/** Colour temperature range the bridged lights advertise, in mireds (≈ 6500K–2000K). */
export const MIREDS_MIN = 153;
export const MIREDS_MAX = 500;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------ conversions --

export type MatterKind = 'onOffLight' | 'dimmableLight' | 'colorTemperatureLight' | 'extendedColorLight' | 'plug' | 'purifier';

/** Which Matter device type a Kova device becomes, or null when it isn't exposed. */
export function matterKind(d: Pick<Device, 'type' | 'capabilities'>): MatterKind | null {
  switch (d.type) {
    case 'light': return 'onOffLight';
    case 'dimmer':
      if (d.capabilities.includes('color')) return 'extendedColorLight';
      if (d.capabilities.includes('colorTemp')) return 'colorTemperatureLight';
      return 'dimmableLight';
    case 'plug': return 'plug';
    case 'fan': return 'purifier';
    default: return null;
  }
}

export interface BridgeExclude { adapters?: string[]; devices?: string[] }

/** Whether a Kova device goes on the bridge. `exclude.adapters` replaces the defaults (matter, homekit) when given. */
export function isBridged(d: Pick<Device, 'id' | 'type' | 'capabilities' | 'adapter'>, exclude: BridgeExclude = {}): boolean {
  if (!matterKind(d)) return false;
  if ((exclude.adapters ?? DEFAULT_EXCLUDED_ADAPTERS).includes(d.adapter)) return false;
  return !(exclude.devices ?? []).includes(d.id);
}

/** Matter labels are at most 32 characters; keep whole words where possible. */
export function matterLabel(s: string): string {
  const clean = s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Kova';
  if (clean.length <= 32) return clean;
  const cut = clean.slice(0, 32);
  const space = cut.lastIndexOf(' ');
  return (space >= 16 ? cut.slice(0, space) : cut).trim();
}

/** "<Room> <Device>", like the Apple Home bridge. */
export function deviceLabel(name: string, room?: string): string {
  return matterLabel(room && !name.toLowerCase().startsWith(room.toLowerCase()) ? `${room} ${name}` : name);
}

/**
 * The matter.js endpoint id for a Kova device or overlay. matter.js keeps the
 * endpoint number it assigned to an id in storage, so the same Kova id keeps
 * the same endpoint number (and its room and name in Google Home) across restarts.
 */
export function endpointId(kind: 'device' | 'overlay' | 'room', id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${kind === 'device' ? 'd' : kind === 'room' ? 'r' : 'o'}-${safe === id ? safe : `${safe}-${sha(id).slice(0, 6)}`}`;
}

/** A stable 32-character unique id for a bridged node. */
export const uniqueId = (kind: 'device' | 'overlay' | 'room', id: string) => sha(`kova:${kind}:${id}`).slice(0, 32);
/** A serial number for a bridged node (the spec wants it different from the unique id). */
export const serialNumber = (kind: 'device' | 'overlay' | 'room', id: string) => `KOVA-${sha(`kova:serial:${kind}:${id}`).slice(0, 12).toUpperCase()}`;

/** Passcodes the Matter spec forbids (§5.1.7.1): all one digit, 12345678 and 87654321. */
const INVALID_PASSCODES = new Set([12345678, 87654321, ...Array.from({ length: 10 }, (_, i) => i * 11111111)]);

export function isValidPasscode(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 99999998 && !INVALID_PASSCODES.has(p);
}

/** A random valid 27-bit setup passcode. */
export function generatePasscode(rand: (max: number) => number = randomInt): number {
  for (;;) {
    const p = rand(100_000_000);
    if (isValidPasscode(p)) return p;
  }
}

/** A random 12-bit discriminator. */
export const generateDiscriminator = (rand: (max: number) => number = randomInt) => rand(4096);

/** Kova fan state → Matter FanMode: off → Off (0), Auto → Auto (5), Sleep → Low (1), anything else → High (3). */
export function fanModeFromKova(st: Pick<DeviceState, 'on' | 'mode'>): number {
  if (st.on === false) return 0;
  if (st.mode === 'Auto') return 5;
  if (st.mode === 'Sleep') return 1;
  return 3;
}

/** Matter FanMode written by a controller → Kova command. */
export function fanModeCommand(fanMode: number): Command {
  switch (fanMode) {
    case 0: return { on: false };
    case 1: return { on: true, mode: 'Sleep' };
    case 2: case 3: return { on: true, mode: 'Manual' };
    case 5: case 6: return { on: true, mode: 'Auto' };
    default: return { on: true }; // On: keep whatever mode it was in.
  }
}

/** Matter PercentSetting (0–100) written by a controller → Kova command. */
export function fanPercentCommand(percent: number | null): Command | null {
  if (percent == null) return null;
  if (percent <= 0) return { on: false };
  return percent <= 33 ? { on: true, mode: 'Sleep' } : { on: true, mode: 'Manual' };
}

/** Fan Control attributes for a Kova fan state. PercentSetting is null in Auto, where the purifier picks its speed. */
export function fanState(st: Pick<DeviceState, 'on' | 'mode'>): { fanMode: number; percentSetting: number | null; percentCurrent: number } {
  const fanMode = fanModeFromKova(st);
  const percent = fanMode === 0 ? 0 : fanMode === 1 ? 33 : fanMode === 3 ? 100 : null;
  return { fanMode, percentSetting: percent, percentCurrent: percent ?? 50 };
}

// ------------------------------------------------------------ room ACs --

/** Matter Thermostat SystemMode values Kova uses. */
export const SYSTEM_MODE = { off: 0, auto: 1, cool: 3, heat: 4, fan: 7, dry: 8 } as const;

/** A room AC's SystemMode: Off unless the room's AC is on, else the unit's mode. */
export function systemModeFromKova(on: boolean, hvac: HvacMode | null): number {
  if (!on) return SYSTEM_MODE.off;
  return SYSTEM_MODE[hvac ?? 'auto'] ?? SYSTEM_MODE.auto;
}

/** SystemMode written by a controller → Kova mode, 'off', or null for one Kova doesn't do (sleep). */
export function systemModeCommand(mode: number): HvacMode | 'off' | null {
  switch (mode) {
    case 0: return 'off';
    case 1: return 'auto';
    case 3: case 6: return 'cool'; // 6: precooling
    case 4: case 5: return 'heat'; // 5: emergency heat
    case 7: return 'fan';
    case 8: return 'dry';
    default: return null; // 9: sleep
  }
}

/** °C → Matter temperature (hundredths), and back to Kova's half degrees. */
export const toMatterTemp = (c: number) => Math.round(c * 100);
export const fromMatterTemp = (v: number) => Math.round(v / 50) / 2;

/** Kova fan speed → Matter FanMode for a room AC: Off when the room's AC is off; quiet/low → Low, high/turbo → High. */
export function acFanMode(on: boolean, fan: FanSpeed | null): number {
  if (!on) return 0;
  switch (fan) {
    case 'quiet': case 'low': return 1;
    case 'medium': return 2;
    case 'high': case 'turbo': return 3;
    default: return 5;
  }
}

/** Matter FanMode written to a room AC → a room AC change. */
export function acFanCommand(fanMode: number): RoomAcChange | null {
  switch (fanMode) {
    case 0: return { on: false };
    case 1: return { fanSpeed: 'low' };
    case 2: return { fanSpeed: 'medium' };
    case 3: return { fanSpeed: 'high' };
    case 4: return { on: true };
    case 5: case 6: return { fanSpeed: 'auto' };
    default: return null;
  }
}

/** Matter PercentSetting written to a room AC → a fan speed. */
export function acFanPercentCommand(percent: number | null): RoomAcChange | null {
  if (percent == null) return null;
  if (percent <= 0) return { on: false };
  return { fanSpeed: percent <= 33 ? 'low' : percent <= 66 ? 'medium' : 'high' };
}

/** Thermostat and Fan Control attributes for a room AC. Both set points carry the unit's one set temperature. */
export function roomAcState(r: RoomAc): { thermostat: Record<string, unknown>; fanControl: Record<string, unknown> } {
  const t = toMatterTemp(Math.min(32, Math.max(16, r.target ?? 24)));
  const fanMode = acFanMode(r.on, r.fanSpeed);
  const percent = fanMode === 0 ? 0 : fanMode === 1 ? 33 : fanMode === 2 ? 66 : fanMode === 3 ? 100 : null;
  return {
    thermostat: {
      systemMode: systemModeFromKova(r.on, r.hvac), localTemperature: r.temp != null ? toMatterTemp(r.temp) : null,
      occupiedCoolingSetpoint: t, occupiedHeatingSetpoint: t,
    },
    fanControl: { fanMode, percentSetting: percent, percentCurrent: percent ?? 50 },
  };
}

export interface ColorAttrs {
  colorMode?: number;
  enhancedColorMode?: number;
  colorTemperatureMireds?: number;
  currentHue?: number;
  currentSaturation?: number;
  currentX?: number;
  currentY?: number;
}

/** Colour Control attributes for a Kova light's colour or colour temperature. */
export function colorState(st: Pick<DeviceState, 'k' | 'color'>, hasColor: boolean): ColorAttrs {
  if (hasColor && st.color) {
    try {
      const { hue, saturation } = hexToHueSat(st.color);
      const { colorX, colorY } = hexToXy(st.color);
      return { colorMode: 0, enhancedColorMode: 0, currentHue: hue, currentSaturation: saturation, currentX: colorX, currentY: colorY };
    } catch { /* not a colour: fall through */ }
  }
  if (st.k != null) {
    const m = kelvinToMireds(st.k, MIREDS_MIN, MIREDS_MAX);
    return { colorMode: 2, enhancedColorMode: 2, colorTemperatureMireds: m };
  }
  return {};
}

/** The Kova command for a light's Colour Control state after a controller changed it. */
export function colorCommand(cc: ColorAttrs, hasColor: boolean): Command | null {
  if (cc.colorMode === 2 && cc.colorTemperatureMireds != null) {
    return hasColor ? { k: miredsToKelvin(cc.colorTemperatureMireds), color: null } : { k: miredsToKelvin(cc.colorTemperatureMireds) };
  }
  if (!hasColor) return null;
  if (cc.colorMode === 0 && cc.currentHue != null && cc.currentSaturation != null) return { color: hueSatToHex(cc.currentHue, cc.currentSaturation), k: null };
  if (cc.colorMode === 1 && cc.currentX != null && cc.currentY != null) return { color: xyToHex(cc.currentX, cc.currentY), k: null };
  return null;
}

/** Known controller vendors, for the pairing screen and the activity log. */
const VENDORS: Record<number, { name: string; cause: string }> = {
  0x6006: { name: 'Google', cause: 'Google Home' },
  0x1349: { name: 'Apple', cause: 'Apple Home' },
  0x1217: { name: 'Amazon', cause: 'Alexa' },
  0x110a: { name: 'SmartThings', cause: 'SmartThings' },
  0x10e1: { name: 'Samsung', cause: 'SmartThings' },
};

export function vendorName(id: number): string {
  if (VENDORS[id]) return VENDORS[id].name;
  if (id >= 0xfff1 && id <= 0xfff4) return 'Test vendor';
  return `0x${id.toString(16).padStart(4, '0')}`;
}

/** The cause Kova logs for a command from a controller of this vendor. */
export function causeFor(vendorId?: number): Cause {
  const v = vendorId != null ? VENDORS[vendorId] : undefined;
  return v ? { kind: 'user', label: v.cause } : CAUSE;
}

// ------------------------------------------------------------------ bridge --

export interface MatterBridgeOptions {
  /** Where the bridge's passcode, fabrics and endpoint numbers live, e.g. `<KOVA_DATA>/matter-bridge`. */
  storageDir: string;
  /** UDP port. Default 5540 (the Matter default; the Kova controller uses a random port). */
  port?: number;
  /** Setup passcode. Generated and persisted on first run when omitted. */
  passcode?: number;
  /** 12-bit discriminator. Generated and persisted on first run when omitted. */
  discriminator?: number;
  /** Bridge name controllers show. Defaults to "Kova". */
  name?: string;
  /** Adapters and devices to leave off the bridge. `adapters` defaults to ['matter', 'homekit']. */
  exclude?: BridgeExclude;
  /** matter.js environment. Default: a Node.js environment of its own, storing in storageDir. Tests pass one on a simulated network. */
  environment?: Environment;
}

export interface PairingInfo {
  manualCode: string;
  qrCode: string;
  commissioned: boolean;
  fabrics: { label: string; vendor: string }[];
}

interface Identity { passcode: number; discriminator: number; serial: string }

interface Entry { endpoint: Endpoint; kind: MatterKind; label: string; reachable: boolean }
/** A room AC's endpoint, the SystemMode it last showed while on (what a controller's "on" sends back), and what it last pushed. */
interface RoomEntry { endpoint: Endpoint; label: string; reachable: boolean; lastActive: number | null; pushed: string }

type Pending = { cmd: Command; cause: Cause };
/** A room AC's controller writes within one transaction. */
type RoomPending = { values: Map<string, unknown>; cause: Cause };

const IDENTITY_FILE = 'kova-matter-bridge.json';

export class MatterBridge {
  readonly identity: Identity;
  /** Bridged endpoints by Kova device id / overlay id. */
  readonly devices = new Map<string, Entry>();
  readonly overlays = new Map<string, Entry>();
  /** Room ACs by room id. */
  readonly roomAcs = new Map<string, RoomEntry>();
  private node?: ServerNode;
  private aggregator?: Endpoint;
  private env?: Environment;
  private readonly unsubs: (() => void)[] = [];
  /** Endpoint work (adds, removals, pushes) runs one at a time so a reconcile never races a push. */
  private queue: Promise<void> = Promise.resolve();
  /** Controller changes collected for one device within a transaction, sent together. */
  private pending = new Map<string, Pending>();
  private inFlight = new Map<string, number>();
  private roomPending = new Map<string, RoomPending>();
  private running = false;

  constructor(private hub: Hub, private opts: MatterBridgeOptions) {
    this.identity = this.loadIdentity();
  }

  private get exclude(): BridgeExclude { return this.opts.exclude ?? {}; }

  async start(): Promise<void> {
    if (this.node) return;
    // matter.js is chatty at info level; keep it to warnings unless the user asked for more.
    if (!process.env.MATTER_LOG_LEVEL) Logger.level = LogLevel.WARN;
    const env = this.opts.environment ?? NodeJsEnvironment();
    env.vars.set('storage.path', this.opts.storageDir);
    env.vars.set('runtime.signals', false);
    env.vars.set('runtime.exitcode', false);
    this.env = env;
    const name = matterLabel(this.opts.name ?? 'Kova');
    let node: ServerNode | undefined;
    try {
      node = await ServerNode.create({
        environment: env,
        id: 'kova-bridge',
        network: { port: this.opts.port ?? 5540 },
        commissioning: { passcode: this.identity.passcode, discriminator: this.identity.discriminator },
        productDescription: { name, deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
          vendorName: 'Kova', vendorId: VendorId(TEST_VENDOR_ID), productId: TEST_PRODUCT_ID,
          productName: 'Kova hub', productLabel: 'Smart home hub', nodeLabel: name,
          serialNumber: this.identity.serial, uniqueId: sha(`kova:bridge:${this.identity.serial}`).slice(0, 32),
          hardwareVersion: 1, softwareVersion: 1, softwareVersionString: '0.1.0',
        },
      });
      this.node = node;
      this.aggregator = new Endpoint(AggregatorEndpoint, { id: 'kova' });
      await node.add(this.aggregator);
      await this.reconcileNow();
      await node.start();
    } catch (err) {
      this.node = undefined;
      this.aggregator = undefined;
      this.devices.clear();
      this.overlays.clear();
      this.roomAcs.clear();
      await node?.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Matter bridge didn't start: ${msg}${/mdns|ipv6|bind|EADDRINUSE/i.test(msg) ? ' (Matter needs IPv6, mDNS and a free UDP port on the host network)' : ''}`);
    }
    this.running = true;

    const onChange = ({ device }: { device: Device }) => { this.push(device.id); this.pushRooms(); };
    const onMeasure = () => { this.pushReachable(); this.pushRooms(); };
    const onDevices = () => this.reconcile();
    const onEngine = () => { for (const id of this.overlays.keys()) this.pushOverlay(id); };
    const onConfig = () => this.reconcile();
    this.hub.reg.on('change', onChange);
    this.hub.reg.on('measure', onMeasure);
    this.hub.reg.on('devices', onDevices);
    this.hub.engine.on('changed', onEngine);
    this.hub.config.on('changed', onConfig);
    this.hub.roomClimate.onMemory(() => this.pushRooms());
    this.unsubs.push(
      () => this.hub.reg.off('change', onChange),
      () => this.hub.reg.off('measure', onMeasure),
      () => this.hub.reg.off('devices', onDevices),
      () => this.hub.engine.off('changed', onEngine),
      () => this.hub.config.off('changed', onConfig),
    );
  }

  /** Stop serving. Fabrics and endpoint numbers stay in storageDir for the next start. */
  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
    this.running = false;
    const node = this.node;
    this.node = undefined;
    if (!node) return;
    await this.queue.catch(() => {});
    await node.close();
    this.devices.clear();
    this.overlays.clear();
    this.roomAcs.clear();
    this.aggregator = undefined;
  }

  get isRunning(): boolean { return this.running; }

  pairingInfo(): PairingInfo {
    const node = this.node;
    if (!node) return { manualCode: '', qrCode: '', commissioned: false, fabrics: [] };
    const c = node.state.commissioning;
    return {
      manualCode: c.pairingCodes.manualPairingCode,
      qrCode: c.pairingCodes.qrPairingCode,
      commissioned: !!c.commissioned,
      fabrics: this.fabrics().map(f => ({ label: f.label, vendor: vendorName(f.vendorId) })),
    };
  }

  private fabrics(): { fabricIndex: number; label: string; vendorId: number }[] {
    const list = (this.node?.state.operationalCredentials.fabrics ?? []) as readonly { fabricIndex: number; label: string; vendorId: number }[];
    return list.map(f => ({ fabricIndex: Number(f.fabricIndex), label: f.label, vendorId: Number(f.vendorId) }));
  }

  // ------------------------------------------------------------ identity --

  private loadIdentity(): Identity {
    mkdirSync(this.opts.storageDir, { recursive: true });
    const file = join(this.opts.storageDir, IDENTITY_FILE);
    let saved: Partial<Identity> = {};
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
    if (this.opts.passcode != null && !isValidPasscode(this.opts.passcode)) throw new Error(`Invalid Matter passcode ${this.opts.passcode} (1–99999998, not a trivial code)`);
    if (this.opts.discriminator != null && !(Number.isInteger(this.opts.discriminator) && this.opts.discriminator >= 0 && this.opts.discriminator <= 4095)) {
      throw new Error(`Invalid Matter discriminator ${this.opts.discriminator} (0–4095)`);
    }
    const validDisc = (d: unknown): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 4095;
    const id: Identity = {
      passcode: this.opts.passcode ?? (typeof saved.passcode === 'number' && isValidPasscode(saved.passcode) ? saved.passcode : generatePasscode()),
      discriminator: this.opts.discriminator ?? (validDisc(saved.discriminator) ? saved.discriminator : generateDiscriminator()),
      serial: typeof saved.serial === 'string' && /^[0-9a-f]{16}$/.test(saved.serial) ? saved.serial : sha(`${Date.now()}:${Math.random()}`).slice(0, 16),
    };
    if (id.passcode !== saved.passcode || id.discriminator !== saved.discriminator || id.serial !== saved.serial) {
      writeFileSync(file, JSON.stringify(id, null, 2) + '\n', { mode: 0o600 });
    }
    return id;
  }

  // ----------------------------------------------------------- endpoints --

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work).catch(err => console.warn('[matter-bridge]', err instanceof Error ? err.message : err));
    this.queue = next;
    return next;
  }

  /** Bring the bridged endpoints in line with the registry and the overlays in config. */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow());
  }

  private label(d: Device): string {
    const room = this.hub.config.get().rooms.find(r => r.id === d.room)?.name;
    return deviceLabel(d.name, room);
  }

  private async reconcileNow(): Promise<void> {
    const agg = this.aggregator;
    if (!agg) return;
    const want = new Map(this.hub.reg.list().filter(d => isBridged(d, this.exclude)).map(d => [d.id, d]));
    const overlays = new Map(this.hub.config.get().overlays.map(o => [o.id, o]));
    // close() rather than delete(): matter.js keeps the endpoint number, so a device that comes back gets the same one.
    for (const [id, e] of this.devices) {
      if (want.has(id) && matterKind(want.get(id)!) === e.kind) continue;
      this.devices.delete(id);
      await e.endpoint.close();
    }
    for (const [id, e] of this.overlays) {
      if (overlays.has(id)) continue;
      this.overlays.delete(id);
      await e.endpoint.close();
    }
    for (const o of overlays.values()) {
      const label = matterLabel(`Kova ${o.name}`);
      const e = this.overlays.get(o.id);
      if (e) { if (e.label !== label) { e.label = label; await e.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: label } } as never); } continue; }
      await this.addOverlay(agg, o, label);
    }
    for (const d of want.values()) {
      const label = this.label(d);
      const e = this.devices.get(d.id);
      if (e) { if (e.label !== label) { e.label = label; await e.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: label } } as never); } continue; }
      await this.addDevice(agg, d, label);
    }
    // Room ACs: one per room a zone serves, unless every unit serving it is left off the bridge.
    const exDevices = new Set(this.exclude.devices ?? []);
    const rooms = new Map(this.hub.roomClimate.rooms().filter(r => r.zones.some(z => !exDevices.has(z.device))).map(r => [r.room, r]));
    for (const [id, e] of this.roomAcs) {
      if (rooms.has(id)) continue;
      this.roomAcs.delete(id);
      await e.endpoint.close();
    }
    for (const r of rooms.values()) {
      const label = matterLabel(r.label);
      const e = this.roomAcs.get(r.room);
      if (e) { if (e.label !== label) { e.label = label; await e.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: label } } as never); } continue; }
      await this.addRoomAc(agg, r, label);
    }
  }

  /** The room ACs on the bridge, with the names controllers show. */
  roomAcList(): { room: string; label: string; endpoint: number | null }[] {
    return [...this.roomAcs].map(([room, e]) => ({ room, label: e.label, endpoint: e.endpoint.number ?? null }));
  }

  private async addRoomAc(agg: Endpoint, r: RoomAc, label: string): Promise<void> {
    const type = ThermostatDevice.with(BridgedDeviceBasicInformationServer, ThermostatServer.with('Heating', 'Cooling', 'AutoMode'), FanControlServer.with('Auto'));
    const st = roomAcState(r);
    const limits = { absMinHeatSetpointLimit: 1600, absMaxHeatSetpointLimit: 3200, minHeatSetpointLimit: 1600, maxHeatSetpointLimit: 3200, absMinCoolSetpointLimit: 1600, absMaxCoolSetpointLimit: 3200, minCoolSetpointLimit: 1600, maxCoolSetpointLimit: 3200 };
    const endpoint = new Endpoint(type as never, {
      id: endpointId('room', r.room),
      bridgedDeviceBasicInformation: {
        nodeLabel: label, productName: 'Kova room AC', productLabel: matterLabel(`${r.zones.map(z => z.name).join(', ')} zone`), vendorName: 'Kova',
        serialNumber: serialNumber('room', r.room), uniqueId: uniqueId('room', r.room), reachable: r.online,
      },
      // Cooling and heating, any set point (the unit has one), and no gap between them: auto runs to the same one.
      thermostat: { controlSequenceOfOperation: 4, minSetpointDeadBand: 0, ...limits, ...st.thermostat },
      fanControl: { fanModeSequence: 2, ...st.fanControl }, // OffLowMedHighAuto
    } as never) as Endpoint;
    await agg.add(endpoint);
    const e: RoomEntry = { endpoint, label, reachable: r.online, lastActive: r.on ? systemModeFromKova(true, r.hvac) : null, pushed: JSON.stringify(st) };
    this.roomAcs.set(r.room, e);
    this.followRoom(r.room, endpoint);
  }

  private followRoom(room: string, ep: Endpoint): void {
    const ev = ep.events as unknown as Record<string, Record<string, { on(fn: (v: unknown, old: unknown, ctx?: Ctx) => void): void } | undefined> | undefined>;
    // The values as written: Kova's own pushes may land on the endpoint before they're read.
    const watch = (cluster: string, attr: string) => ev[cluster]?.[`${attr}$Changed`]?.on((v, _old, ctx) => {
      if (!ctx || ctx.offline) return;
      const p = this.roomPending.get(room);
      if (p) { p.values.set(`${cluster}.${attr}`, v); return; }
      this.roomPending.set(room, { values: new Map([[`${cluster}.${attr}`, v]]), cause: this.causeOf(ctx) });
      setImmediate(() => void this.forwardRoom(room));
    });
    for (const a of ['systemMode', 'occupiedCoolingSetpoint', 'occupiedHeatingSetpoint']) watch('thermostat', a);
    for (const a of ['fanMode', 'percentSetting']) watch('fanControl', a);
  }

  /** What a controller's writes to a room AC ask of it, from the values it wrote ("thermostat.systemMode" → 3). */
  roomChange(room: string, values: Map<string, unknown>): RoomAcChange {
    const e = this.roomAcs.get(room);
    const view = this.hub.roomClimate.view(room);
    const out: RoomAcChange = {};
    if (values.has('thermostat.systemMode')) {
      const mode = Number(values.get('thermostat.systemMode'));
      const hvac = systemModeCommand(mode);
      // A controller's "turn on" switches an off thermostat back to the mode it last showed (Google Home), or to Auto:
      // that's "on", for Kova to choose the mode. Any other mode is a person choosing it.
      if (hvac === 'off') out.on = false;
      else if (hvac && !view?.on && (mode === e?.lastActive || mode === SYSTEM_MODE.auto)) out.on = true;
      else if (hvac) out.hvac = hvac;
    }
    const cool = values.get('thermostat.occupiedCoolingSetpoint'), heat = values.get('thermostat.occupiedHeatingSetpoint');
    if ((cool != null || heat != null) && out.on !== false) {
      const mode = out.hvac ?? view?.hvac ?? null;
      // The set point for the mode it's in; matter.js keeps the other one out of its way, which isn't a choice.
      const v = Number(mode === 'heat' ? heat ?? cool : cool ?? heat);
      if (Number.isFinite(v) && fromMatterTemp(v) !== view?.target) out.target = fromMatterTemp(v);
    }
    if (out.on !== false) {
      const fan = values.has('fanControl.fanMode') ? acFanCommand(Number(values.get('fanControl.fanMode')))
        : values.has('fanControl.percentSetting') ? acFanPercentCommand(values.get('fanControl.percentSetting') as number | null) : null;
      if (fan?.on === false && !out.hvac && out.target == null) out.on = false;
      else if (fan?.fanSpeed) out.fanSpeed = fan.fanSpeed;
      else if (fan?.on) out.on ??= true;
    }
    return out;
  }

  private async forwardRoom(room: string): Promise<void> {
    const p = this.roomPending.get(room);
    this.roomPending.delete(room);
    const e = this.roomAcs.get(room);
    if (!p || !e || !this.running) return;
    const change = this.roomChange(room, p.values);
    try {
      if (Object.keys(change).length) await this.hub.roomClimate.apply(room, change, p.cause);
    } catch (err) {
      console.warn(`[matter-bridge] ${e.label}:`, err instanceof Error ? err.message : err);
    }
    // Back in line with Kova (a mode the unit kept, a "turn on" that kept another room's mode).
    e.pushed = '';
    if (!this.roomPending.has(room)) this.pushRooms();
  }

  /** Push every room AC whose state changed. */
  private pushRooms(): void {
    if (!this.running) return;
    for (const r of this.hub.roomClimate.rooms()) {
      const e = this.roomAcs.get(r.room);
      if (!e || this.roomPending.has(r.room)) continue;
      const st = roomAcState(r);
      if (r.on) e.lastActive = st.thermostat.systemMode as number;
      const sig = JSON.stringify(st);
      const reach = r.online !== e.reachable;
      if (sig === e.pushed && !reach) continue;
      e.pushed = sig;
      const state: Record<string, object> = { ...st };
      if (reach) { e.reachable = r.online; state.bridgedDeviceBasicInformation = { reachable: r.online }; }
      void this.enqueue(async () => { if (this.roomAcs.get(r.room) === e) await e.endpoint.set(state as never); });
    }
  }

  private async addDevice(agg: Endpoint, d: Device, label: string): Promise<void> {
    const kind = matterKind(d)!;
    const reachable = d.state.online !== false;
    const info = {
      nodeLabel: label, productName: matterLabel(d.integration || 'Kova device'), productLabel: matterLabel(d.name),
      vendorName: 'Kova', serialNumber: serialNumber('device', d.id), uniqueId: uniqueId('device', d.id), reachable,
    };
    const type = {
      onOffLight: OnOffLightDevice.with(BridgedDeviceBasicInformationServer),
      dimmableLight: DimmableLightDevice.with(BridgedDeviceBasicInformationServer),
      colorTemperatureLight: ColorTemperatureLightDevice.with(BridgedDeviceBasicInformationServer),
      extendedColorLight: ExtendedColorLightDevice.with(BridgedDeviceBasicInformationServer, ColorControlServer.with('HueSaturation', 'Xy', 'ColorTemperature')),
      plug: OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      purifier: AirPurifierDevice.with(BridgedDeviceBasicInformationServer, FanControlServer.with('Auto')),
    }[kind];
    const initial: Record<string, unknown> = { id: endpointId('device', d.id), bridgedDeviceBasicInformation: info, ...this.clusterState(d, kind) };
    if (kind === 'colorTemperatureLight' || kind === 'extendedColorLight') {
      initial.colorControl = {
        colorTempPhysicalMinMireds: MIREDS_MIN, colorTempPhysicalMaxMireds: MIREDS_MAX, coupleColorTempToLevelMinMireds: MIREDS_MIN,
        colorTemperatureMireds: kelvinToMireds(2700, MIREDS_MIN, MIREDS_MAX), colorMode: 2, enhancedColorMode: 2,
        ...(initial.colorControl as object),
      };
    }
    if (kind === 'purifier') initial.fanControl = { fanModeSequence: 3, ...(initial.fanControl as object) }; // OffLowHighAuto
    const endpoint = new Endpoint(type as never, initial as never) as Endpoint;
    await agg.add(endpoint);
    this.devices.set(d.id, { endpoint, kind, label, reachable });
    this.follow(d.id, endpoint, kind);
  }

  private async addOverlay(agg: Endpoint, o: Overlay, label: string): Promise<void> {
    const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), {
      id: endpointId('overlay', o.id),
      bridgedDeviceBasicInformation: {
        nodeLabel: label, productName: 'Kova overlay', productLabel: matterLabel(o.name), vendorName: 'Kova',
        serialNumber: serialNumber('overlay', o.id), uniqueId: uniqueId('overlay', o.id), reachable: true,
      },
      onOff: { onOff: this.hub.engine.overlay?.id === o.id },
    });
    await agg.add(endpoint);
    this.overlays.set(o.id, { endpoint, kind: 'plug', label, reachable: true });
    endpoint.events.onOff.onOff$Changed.on((on, _old, ctx) => {
      if (!ctx || ctx.offline) return;
      const cause = this.causeOf(ctx);
      void (async () => {
        try {
          if (on) await this.hub.engine.startOverlay(o.id, cause);
          else if (this.hub.engine.overlay?.id === o.id) await this.hub.engine.endOverlay('user');
        } catch (err) {
          console.warn(`[matter-bridge] ${o.name}:`, err instanceof Error ? err.message : err);
        }
        this.pushOverlay(o.id);
      })();
    });
  }

  /** Cluster attributes for a Kova device's state. */
  private clusterState(d: Device, kind: MatterKind): Record<string, object> {
    const st = d.state;
    if (kind === 'purifier') return { fanControl: fanState(st) };
    const out: Record<string, object> = { onOff: { onOff: !!st.on } };
    if (kind !== 'onOffLight' && kind !== 'plug' && st.bri != null) out.levelControl = { currentLevel: briToLevel(st.bri) };
    if (kind === 'colorTemperatureLight' || kind === 'extendedColorLight') {
      const cc = colorState(st, kind === 'extendedColorLight');
      if (Object.keys(cc).length) out.colorControl = cc;
    }
    return out;
  }

  /** Listen for controller writes and commands on a device endpoint. */
  private follow(id: string, ep: Endpoint, kind: MatterKind): void {
    const hasColor = kind === 'extendedColorLight';
    const ev = ep.events as unknown as Record<string, Record<string, { on(fn: (v: unknown, old: unknown, ctx?: Ctx) => void): void } | undefined> | undefined>;
    const on = (cluster: string, attrs: string[], build: () => Command | null) => {
      const events = ev[cluster];
      if (!events) return;
      for (const a of attrs) {
        events[`${a}$Changed`]?.on((_v, _old, ctx) => {
          if (!ctx || ctx.offline) return; // Kova's own push, or matter.js internals
          const cmd = build();
          if (cmd) this.collect(id, cmd, this.causeOf(ctx));
        });
      }
    };
    const state = () => ep.state as unknown as Record<string, Record<string, unknown>>;
    if (kind === 'purifier') {
      on('fanControl', ['fanMode'], () => fanModeCommand(Number(state().fanControl.fanMode)));
      on('fanControl', ['percentSetting'], () => fanPercentCommand(state().fanControl.percentSetting as number | null));
      return;
    }
    on('onOff', ['onOff'], () => ({ on: !!state().onOff.onOff }));
    if (kind !== 'onOffLight' && kind !== 'plug') {
      on('levelControl', ['currentLevel'], () => {
        const level = state().levelControl.currentLevel;
        return typeof level === 'number' ? { bri: levelToBri(level) } : null;
      });
    }
    if (kind === 'colorTemperatureLight' || hasColor) {
      on('colorControl', ['colorMode', 'colorTemperatureMireds', 'currentHue', 'currentSaturation', 'currentX', 'currentY'],
        () => colorCommand(state().colorControl as ColorAttrs, hasColor));
    }
  }

  private causeOf(ctx: Ctx): Cause {
    const idx = ctx.fabric;
    if (idx == null) return CAUSE;
    return causeFor(this.fabrics().find(f => f.fabricIndex === Number(idx))?.vendorId);
  }

  /** Gather a transaction's attribute changes into one Kova command, sent once they've all landed. */
  private collect(id: string, cmd: Command, cause: Cause): void {
    const p = this.pending.get(id);
    if (p) { Object.assign(p.cmd, cmd); return; }
    this.pending.set(id, { cmd: { ...cmd }, cause });
    setImmediate(() => void this.forward(id));
  }

  private async forward(id: string): Promise<void> {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || !this.running) return;
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    try {
      await this.hub.engine.command(id, p.cmd, p.cause);
    } catch (err) {
      console.warn(`[matter-bridge] ${id}:`, err instanceof Error ? err.message : err);
    } finally {
      const n = (this.inFlight.get(id) ?? 1) - 1;
      if (n > 0) this.inFlight.set(id, n); else this.inFlight.delete(id);
    }
    // Put the endpoint back in line with Kova: the command may have failed, been a no-op, or mapped onto
    // something coarser (Medium → Manual → High). Skipped while more changes from the controller are on their way.
    if (!this.pending.has(id) && !this.inFlight.has(id)) this.push(id);
  }

  /** Push a Kova device's state to its endpoint. A local write: controllers see it, the bridge doesn't read it back. */
  private push(id: string): void {
    const e = this.devices.get(id);
    const d = this.hub.reg.get(id);
    if (!e || !d || !this.running) return;
    const state: Record<string, object> = this.clusterState(d, e.kind);
    const reachable = d.state.online !== false;
    if (reachable !== e.reachable) { e.reachable = reachable; state.bridgedDeviceBasicInformation = { reachable }; }
    void this.enqueue(async () => { if (this.devices.get(id) === e) await e.endpoint.set(state as never); });
  }

  private pushReachable(): void {
    for (const [id, e] of this.devices) {
      const reachable = this.hub.reg.get(id)?.state.online !== false;
      if (reachable === e.reachable) continue;
      e.reachable = reachable;
      void this.enqueue(async () => { if (this.devices.get(id) === e) await e.endpoint.set({ bridgedDeviceBasicInformation: { reachable } } as never); });
    }
  }

  private pushOverlay(id: string): void {
    const e = this.overlays.get(id);
    if (!e || !this.running) return;
    const on = this.hub.engine.overlay?.id === id;
    void this.enqueue(async () => { if (this.overlays.get(id) === e) await e.endpoint.set({ onOff: { onOff: on } } as never); });
  }
}

/** What matter.js passes to a $Changed observer: offline for local writes, with the fabric for a controller's. */
interface Ctx { offline?: boolean; fabric?: number }
