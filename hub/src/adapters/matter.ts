import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientNode, ControllerBehavior, Endpoint, Environment, Logger, LogLevel, Seconds, ServerNode } from '@matter/main';
import { QrPairingCodeCodec } from '@matter/main/types';
import { ClientSubscriptions } from '@matter/main/protocol';
import { OnOffClient } from '@matter/main/behaviors/on-off';
import { LevelControlClient } from '@matter/main/behaviors/level-control';
import { ColorControlClient } from '@matter/main/behaviors/color-control';
import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from './sdk.ts';
import type { Capability, Command, Device, DeviceState, DeviceType } from '../model/types.ts';

// Matter over IP, as a controller on Kova's own fabric, using matter.js.
// Devices already in Google Home / Apple Home join through multi-admin: the user
// opens a pairing window there and pastes the code into Kova. BLE is not supported.

// ------------------------------------------------------------ pure mapping --

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Kova brightness 0–100 → LevelControl level 1–254, clamped to the device's range. */
export function briToLevel(bri: number, min = 1, max = 254): number {
  return clamp(Math.round(1 + (clamp(bri, 0, 100) / 100) * 253), Math.max(1, min), Math.min(254, max));
}

/** LevelControl level 1–254 → Kova brightness. An on light never reads as 0%. */
export function levelToBri(level: number): number {
  return clamp(Math.round(((clamp(level, 1, 254) - 1) * 100) / 253), 1, 100);
}

/** Kelvin → mireds, clamped to the device's physical range. */
export function kelvinToMireds(k: number, min = 1, max = 65279): number {
  return clamp(Math.round(1e6 / Math.max(1, k)), min, max);
}

/** Mireds → Kelvin, rounded to 10 K so a round trip lands where it started. */
export function miredsToKelvin(mireds: number): number {
  return Math.round(1e6 / Math.max(1, mireds) / 10) * 10;
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

/** '#rrggbb' → Matter hue and saturation (both 0–254). Brightness is carried by the level, not the colour. */
export function hexToHueSat(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = parseHex(hex).map(v => v / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const s = max ? d / max : 0;
  return { hue: Math.round((h / 360) * 254) % 255, saturation: Math.round(s * 254) };
}

/** Matter hue and saturation (0–254) → '#rrggbb' at full value. */
export function hueSatToHex(hue: number, saturation: number): string {
  const h = (clamp(hue, 0, 254) / 254) * 360, s = clamp(saturation, 0, 254) / 254;
  const c = s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = 1 - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** '#rrggbb' → Matter CIE xy (each 0–65279, i.e. x·65536). */
export function hexToXy(hex: string): { colorX: number; colorY: number } {
  const [r, g, b] = parseHex(hex).map(v => lin(v / 255));
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  // Black has no chromaticity; use the D65 white point.
  const [x, y] = sum ? [X / sum, Y / sum] : [0.3127, 0.329];
  return { colorX: clamp(Math.round(x * 65536), 0, 65279), colorY: clamp(Math.round(y * 65536), 0, 65279) };
}

/** Matter CIE xy → '#rrggbb', scaled so the brightest channel is full. */
export function xyToHex(colorX: number, colorY: number): string {
  const x = colorX / 65536, y = Math.max(1e-6, colorY / 65536);
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
  [r, g, b] = [r, g, b].map(v => Math.max(0, v));
  const max = Math.max(r, g, b) || 1;
  return toHex(gam(r / max) * 255, gam(g / max) * 255, gam(b / max) * 255);
}

/** Matter device type ids Kova understands. */
export const DEVICE_TYPES = {
  onOffLight: 0x0100, dimmableLight: 0x0101, colorTemperatureLight: 0x010c, extendedColorLight: 0x010d,
  onOffPlugInUnit: 0x010a, dimmablePlugInUnit: 0x010b, mountedOnOffControl: 0x010f, mountedDimmableLoadControl: 0x0110,
} as const;
const LIGHTS = new Set<number>([DEVICE_TYPES.onOffLight, DEVICE_TYPES.dimmableLight, DEVICE_TYPES.colorTemperatureLight, DEVICE_TYPES.extendedColorLight]);
const PLUGS = new Set<number>([DEVICE_TYPES.onOffPlugInUnit, DEVICE_TYPES.dimmablePlugInUnit, DEVICE_TYPES.mountedOnOffControl, DEVICE_TYPES.mountedDimmableLoadControl]);

export interface EndpointShape {
  deviceTypes: number[];
  onOff: boolean;
  level: boolean;
  colorTemp: boolean;
  hueSat: boolean;
  xy: boolean;
}

/** Which Kova device an endpoint becomes, or null if Kova doesn't support it. */
export function classify(e: EndpointShape): { type: DeviceType; capabilities: Capability[] } | null {
  if (!e.onOff) return null;
  const light = e.deviceTypes.some(t => LIGHTS.has(t));
  const plug = !light && e.deviceTypes.some(t => PLUGS.has(t));
  if (!light && !plug) return null;
  const capabilities: Capability[] = ['onoff'];
  if (e.level) capabilities.push('brightness');
  if (plug) return { type: e.level ? 'dimmer' : 'plug', capabilities };
  if (e.colorTemp) capabilities.push('colorTemp');
  if (e.hueSat || e.xy) capabilities.push('color');
  return { type: e.level ? 'dimmer' : 'light', capabilities };
}

// ----------------------------------------------------------------- adapter --

export interface MatterOptions {
  /** Where the controller keeps its fabric, credentials and paired nodes, e.g. `<KOVA_DATA>/matter`. */
  storageDir: string;
  /** UDP port for the controller. 0 (default) picks a free one, so it never clashes with a Matter device on this host. */
  port?: number;
  /** Fabric label other ecosystems show for Kova (max 32 chars). */
  fabricLabel?: string;
  /** matter.js environment. Defaults to the process-wide one; tests pass their own with a simulated network. */
  environment?: Environment;
  /** How long a command may take before it counts as failed. */
  commandTimeoutMs?: number;
  /** Transition time for level and colour changes, in tenths of a second. */
  transitionTenths?: number;
  /** How long commissioning may look for the device. */
  commissionTimeoutMs?: number;
}

interface NodeMeta { name?: string; room?: string }
interface Target { node: ClientNode; nodeId: string; endpoint: number; name: string }
/** What Kova last sent, so a device echoing it back isn't read as a change made elsewhere. */
interface Sent { mireds?: number; k?: number; hs?: string; xy?: string; color?: string }

const META_FILE = 'kova-nodes.json';
const OPTS = { optionsMask: { executeIfOff: true }, optionsOverride: { executeIfOff: true } };

export class MatterAdapter implements Adapter {
  id = 'matter';
  name = 'Matter';
  icon = 'hub';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private controller?: ServerNode;
  private env: Environment;
  private targets = new Map<string, Target>();
  private watched = new WeakSet<ClientNode>();
  private followed = new Set<string>();
  /** Nodes whose subscription is up. */
  private live = new WeakSet<ClientNode>();
  private offlineCheck?: NodeJS.Timeout;
  private sent = new Map<string, Sent>();
  /** Devices with a command in flight: reports are held until it settles. */
  private busy = new Map<string, number>();
  private held = new Set<string>();
  private meta: Record<string, NodeMeta> = {};
  private error: string | null = null;
  private opts: Required<Omit<MatterOptions, 'environment'>>;

  constructor(opts: MatterOptions) {
    this.opts = {
      storageDir: opts.storageDir, port: opts.port ?? 0, fabricLabel: (opts.fabricLabel ?? 'Kova').slice(0, 32),
      commandTimeoutMs: opts.commandTimeoutMs ?? 10_000, transitionTenths: opts.transitionTenths ?? 4, commissionTimeoutMs: opts.commissionTimeoutMs ?? 60_000,
    };
    this.env = opts.environment ?? Environment.default;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    mkdirSync(this.opts.storageDir, { recursive: true });
    try { this.meta = JSON.parse(readFileSync(join(this.opts.storageDir, META_FILE), 'utf8')); } catch { this.meta = {}; }
    // matter.js is chatty at info level; keep it to warnings unless the user asked for more.
    if (!process.env.MATTER_LOG_LEVEL) Logger.level = LogLevel.WARN;
    const vars = this.env.vars;
    vars.set('storage.path', this.opts.storageDir);
    // The hub owns the process: its own signal handlers and exit code.
    vars.set('runtime.signals', false);
    vars.set('runtime.exitcode', false);
    try {
      this.controller = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
        environment: this.env,
        id: 'kova-controller',
        network: { port: this.opts.port },
        controller: { adminFabricLabel: this.opts.fabricLabel },
        commissioning: { enabled: false },
        subscriptions: { persistenceEnabled: false },
      });
      await this.controller.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // matter.js needs IPv6 and multicast DNS; a container without them fails here.
      this.error = `Matter controller didn't start: ${msg}${/mdns|ipv6|bind/i.test(msg) ? ' (Matter needs IPv6 and mDNS on the host network)' : ''}`;
      const c = this.controller;
      this.controller = undefined;
      await c?.close().catch(() => {});
      throw err;
    }
    // Peers commissioned before are restored from storage and reconnect by themselves.
    for (const node of this.controller.peers) {
      if (node.peerAddress) this.adopt(node);
    }
    // A node that hasn't come back after a while is reported offline rather than left showing its last state.
    this.offlineCheck = setTimeout(() => {
      for (const [id, t] of this.targets) if (!this.live.has(t.node)) this.ctx?.report(id, { online: false });
    }, 45_000).unref();
  }

  async stop(): Promise<void> {
    const c = this.controller;
    this.controller = undefined;
    if (this.offlineCheck) clearTimeout(this.offlineCheck);
    if (!c) return;
    // Stop subscription bookkeeping first: if a peer is unreachable, the node's shutdown is forced and
    // matter.js 0.17 can leave the subscription timeout timer running, which keeps the process alive.
    await c.env.maybeGet(ClientSubscriptions)?.close().catch(() => {});
    await c.close();
  }

  /**
   * Commission a device over IP with an 11/21-digit manual pairing code or an
   * `MT:` QR payload. For a device already in another app, open a pairing
   * window there first ("Linked Matter apps" / "Turn on pairing mode").
   */
  async commission(pairingCode: string, opts: { room?: string; name?: string } = {}): Promise<DeviceInfo[]> {
    const ctl = this.controller;
    if (!ctl) throw new Error('Matter is not running');
    const code = pairingCode.trim();
    const timeout = Seconds(this.opts.commissionTimeoutMs / 1000);
    let node: ClientNode;
    try {
      if (/^MT:/i.test(code)) {
        const [qr] = QrPairingCodeCodec.decode(code.toUpperCase());
        if (!qr) throw new Error('empty QR code');
        node = await ctl.peers.commission({ passcode: qr.passcode, longDiscriminator: qr.discriminator, timeout });
      } else {
        const digits = code.replace(/[\s-]/g, '');
        if (!/^(\d{11}|\d{21})$/.test(digits)) throw new Error('a pairing code has 11 or 21 digits');
        node = await ctl.peers.commission({ pairingCode: digits, timeout });
      }
    } catch (err) {
      throw new Error(`Couldn't add the Matter device: ${err instanceof Error ? err.message : String(err)}`);
    }
    const nodeId = node.peerAddress ? String(node.peerAddress.nodeId) : undefined;
    if (!nodeId) throw new Error('Commissioning finished but the device has no node id');
    this.meta[nodeId] = { ...(opts.name ? { name: opts.name } : {}), ...(opts.room ? { room: opts.room } : {}) };
    this.saveMeta();
    this.live.add(node);
    const devices = this.adopt(node);
    for (const d of devices) this.ctx?.report(d.id, { online: true });
    if (!devices.length) this.ctx?.log(`node ${nodeId} has no lights or plugs Kova supports yet`);
    return devices;
  }

  /**
   * Remove a node from Kova's fabric. Tries a proper decommission first; if the
   * device can't be reached it is forgotten locally (it may then need a factory reset).
   */
  async remove(nodeId: string): Promise<void> {
    const node = [...this.targets.values()].find(t => t.nodeId === nodeId)?.node
      ?? [...(this.controller?.peers ?? [])].find(n => String(n.peerAddress?.nodeId) === nodeId);
    if (!node) throw new Error(`Unknown Matter node ${nodeId}`);
    try {
      await withTimeout(node.decommission(), this.opts.commandTimeoutMs, new AbortController(), 'decommission timed out');
    } catch (err) {
      this.ctx?.log(`couldn't decommission node ${nodeId}, forgetting it locally`, err instanceof Error ? err.message : err);
      await node.delete();
    }
    for (const [id, t] of this.targets) {
      if (t.nodeId !== nodeId) continue;
      this.targets.delete(id);
      this.followed.delete(id);
      this.ctx?.report(id, { online: false });
    }
    delete this.meta[nodeId];
    this.saveMeta();
  }

  private saveMeta(): void {
    try { writeFileSync(join(this.opts.storageDir, META_FILE), JSON.stringify(this.meta, null, 2)); } catch (err) { this.ctx?.log('could not save node names', err); }
  }

  /** Announce a node's supported endpoints and start following its state. */
  private adopt(node: ClientNode): DeviceInfo[] {
    const nodeId = String(node.peerAddress!.nodeId);
    const meta = this.meta[nodeId] ?? {};
    const basic = node.maybeStateOf('basicInformation') as { nodeLabel?: string; productName?: string; productLabel?: string } | undefined;
    const baseName = meta.name || basic?.nodeLabel || basic?.productLabel || basic?.productName || `Matter device ${nodeId}`;
    const found: { ep: Endpoint; type: DeviceType; capabilities: Capability[] }[] = [];
    for (const ep of node.endpoints) {
      if (ep.number === undefined || ep.number === 0) continue;
      const shape = shapeOf(ep);
      const kind = classify(shape);
      if (kind) found.push({ ep, ...kind });
      this.ctx?.log(`${baseName} endpoint ${ep.number}: ${JSON.stringify(shape)}`);
    }
    const infos: DeviceInfo[] = found.map(({ ep, type, capabilities }, i) => {
      const id = `matter_${nodeId}_${ep.number}`;
      const name = found.length > 1 ? `${baseName} ${i + 1}` : baseName;
      this.targets.set(id, { node, nodeId, endpoint: ep.number!, name });
      return {
        id, name, room: meta.room ?? 'unassigned', type, capabilities,
        integration: 'Matter', address: `${nodeId}/${ep.number}`, state: this.read(id, ep),
      };
    });
    this.ctx?.announce(infos);
    for (const { ep } of found) this.follow(`matter_${nodeId}_${ep.number}`, ep);
    if (!this.watched.has(node)) {
      this.watched.add(node);
      node.eventsOf('network').subscriptionStatusChanged?.on((active: boolean) => {
        if (active) this.live.add(node); else this.live.delete(node);
        for (const [id, t] of this.targets) {
          if (t.node !== node) continue;
          const ep = node.endpoints.for(t.endpoint);
          this.ctx?.report(id, active ? { ...this.read(id, ep), online: true } : { online: false });
        }
      });
    }
    return infos;
  }

  /** Report attribute changes made at the device or by another controller. */
  private follow(id: string, ep: Endpoint): void {
    if (this.followed.has(id)) return;
    this.followed.add(id);
    const push = () => {
      if (this.busy.get(id)) { this.held.add(id); return; }
      this.ctx?.report(id, this.read(id, ep));
    };
    const attrs: Record<string, string[]> = {
      onOff: ['onOff'],
      levelControl: ['currentLevel'],
      colorControl: ['colorMode', 'colorTemperatureMireds', 'currentHue', 'currentSaturation', 'currentX', 'currentY'],
    };
    for (const [cluster, names] of Object.entries(attrs)) {
      if (!ep.behaviors.has(cluster)) continue;
      const events = ep.eventsOf(cluster);
      for (const n of names) events[`${n}$Changed`]?.on(push);
    }
  }

  /** Kova state from an endpoint's cached attributes. */
  private read(id: string, ep: Endpoint): DeviceState {
    const st: DeviceState = {};
    const onOff = ep.maybeStateOf(OnOffClient);
    if (onOff) st.on = !!onOff.onOff;
    const level = ep.maybeStateOf(LevelControlClient);
    if (level && typeof level.currentLevel === 'number') st.bri = levelToBri(level.currentLevel);
    const cc = ep.maybeStateOf(ColorControlClient) as Record<string, number | undefined> | undefined;
    if (cc) {
      const sent = this.sent.get(id) ?? {};
      const f = shapeOf(ep);
      // colorMode: 0 hue/saturation, 1 xy, 2 colour temperature.
      const mode = cc.colorMode ?? (f.colorTemp ? 2 : f.hueSat ? 0 : 1);
      if (mode === 2 && f.colorTemp && cc.colorTemperatureMireds != null) {
        const m = cc.colorTemperatureMireds;
        st.k = sent.mireds === m && sent.k ? sent.k : miredsToKelvin(m);
        if (f.hueSat || f.xy) st.color = null;
      } else if (mode === 0 && f.hueSat && cc.currentHue != null && cc.currentSaturation != null) {
        const key = `${cc.currentHue},${cc.currentSaturation}`;
        st.color = sent.hs === key && sent.color ? sent.color : hueSatToHex(cc.currentHue, cc.currentSaturation);
        if (f.colorTemp) st.k = null;
      } else if (mode === 1 && f.xy && cc.currentX != null && cc.currentY != null) {
        const key = `${cc.currentX},${cc.currentY}`;
        st.color = sent.xy === key && sent.color ? sent.color : xyToHex(cc.currentX, cc.currentY);
        if (f.colorTemp) st.k = null;
      }
    }
    return st;
  }

  async command(d: Device, cmd: Command): Promise<void> {
    const t = this.targets.get(d.id);
    if (!t) throw new Error(`Unknown Matter device ${d.id}`);
    this.busy.set(d.id, (this.busy.get(d.id) ?? 0) + 1);
    try {
      const abort = new AbortController();
      await withTimeout(this.send(d, t, cmd, { abort: abort.signal }), this.opts.commandTimeoutMs, abort,
        `${t.name} didn't respond within ${Math.round(this.opts.commandTimeoutMs / 1000)} s`);
    } catch (err) {
      throw new Error(`Matter: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Let the device's own reports of this change arrive before listening again.
      setTimeout(() => {
        const n = (this.busy.get(d.id) ?? 1) - 1;
        if (n > 0) { this.busy.set(d.id, n); return; }
        this.busy.delete(d.id);
        if (this.held.delete(d.id) && this.controller) {
          const t2 = this.targets.get(d.id);
          if (t2) this.ctx?.report(d.id, this.read(d.id, t2.node.endpoints.for(t2.endpoint)));
        }
      }, 400 + this.opts.transitionTenths * 100).unref();
    }
  }

  private async send(d: Device, t: Target, cmd: Command, ctx: { abort: AbortSignal }): Promise<void> {
    const ep = t.node.endpoints.for(t.endpoint);
    const f = shapeOf(ep);
    const transitionTime = this.opts.transitionTenths;
    const sent = this.sent.get(d.id) ?? {};

    // Colour first, so a light switched on comes up in the right colour.
    if (cmd.k != null && f.colorTemp) {
      const cc = ep.stateOf(ColorControlClient);
      const mireds = kelvinToMireds(cmd.k, cc.colorTempPhysicalMinMireds || 1, cc.colorTempPhysicalMaxMireds || 65279);
      await ep.commandsOf(ColorControlClient).moveToColorTemperature({ colorTemperatureMireds: mireds, transitionTime, ...OPTS }, ctx);
      this.sent.set(d.id, { mireds, k: cmd.k });
    } else if (cmd.color && (f.hueSat || f.xy)) {
      if (f.hueSat) {
        const { hue, saturation } = hexToHueSat(cmd.color);
        await ep.commandsOf(ColorControlClient).moveToHueAndSaturation({ hue, saturation, transitionTime, ...OPTS }, ctx);
        this.sent.set(d.id, { ...sent, hs: `${hue},${saturation}`, xy: undefined, color: cmd.color });
      } else {
        const { colorX, colorY } = hexToXy(cmd.color);
        await ep.commandsOf(ColorControlClient).moveToColor({ colorX, colorY, transitionTime, ...OPTS }, ctx);
        this.sent.set(d.id, { ...sent, xy: `${colorX},${colorY}`, hs: undefined, color: cmd.color });
      }
    }

    if (cmd.bri != null && f.level) {
      const lc = ep.stateOf(LevelControlClient);
      const level = briToLevel(cmd.bri, lc.minLevel ?? 1, lc.maxLevel ?? 254);
      // Only switch on with the level when that's what Kova asked for (or the light is on already).
      const withOnOff = cmd.on === true || (cmd.on === undefined && d.state.on !== false);
      if (withOnOff) await ep.commandsOf(LevelControlClient).moveToLevelWithOnOff({ level, transitionTime, ...OPTS }, ctx);
      else await ep.commandsOf(LevelControlClient).moveToLevel({ level, transitionTime, ...OPTS }, ctx);
      // Moving to the minimum level with on/off switches the light off; "on at 0%" should stay on.
      if (cmd.on === true && level <= (lc.minLevel ?? 1)) await ep.commandsOf(OnOffClient).on(undefined, ctx);
    } else if (cmd.on === true) {
      await ep.commandsOf(OnOffClient).on(undefined, ctx);
    }
    if (cmd.on === false) await ep.commandsOf(OnOffClient).off(undefined, ctx);
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    if (!this.controller) return { ok: false, note: 'Not running' };
    const n = this.targets.size;
    return { ok: true, note: n ? `${n} device${n === 1 ? '' : 's'}` : 'No devices yet. Add one with its pairing code.' };
  }
}

function shapeOf(ep: Endpoint): EndpointShape {
  const desc = ep.maybeStateOf('descriptor') as { deviceTypeList?: readonly { deviceType: number }[] } | undefined;
  const deviceTypes = [...(desc?.deviceTypeList ?? [])].map(t => Number(t.deviceType));
  if (!deviceTypes.length && ep.type.deviceType) deviceTypes.push(Number(ep.type.deviceType));
  const features = (ep.behaviors.has('colorControl') ? ep.maybeFeaturesOf('colorControl') : undefined) ?? {};
  return {
    deviceTypes,
    onOff: ep.behaviors.has('onOff'),
    level: ep.behaviors.has('levelControl'),
    colorTemp: !!features.colorTemperature,
    hueSat: !!features.hueSaturation,
    xy: !!features.xy,
  };
}

/** Fail after `ms`, and abort the interaction so matter.js stops retrying it. */
function withTimeout<T>(p: Promise<T>, ms: number, abort: AbortController, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(new Error(message)); reject(new Error(message)); }, ms); }),
  ]);
}
