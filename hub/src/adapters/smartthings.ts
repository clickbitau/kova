import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';

// Samsung soundbars through SmartThings: power, input, volume, mute, sound mode and night mode.
//
// Samsung's local soundbar API (JSON-RPC) only exists on the 2024 "D" models and later; a Q930B (2022) and the
// other A/B/C models are only reachable through Samsung's SmartThings cloud, the way Home Assistant does it.
// Sound mode and night mode aren't SmartThings capabilities: they go through the soundbar's `execute` capability
// with Samsung's own resource paths (/sec/networkaudio/soundmode and /advancedaudio).
//
// Signing in: a SmartThings OAuth app (an OAuth-In app with r:devices:* and x:devices:*), which Kova makes on the
// owner's account itself from a one-time personal access token (`createSmartThingsApp`, the request the SmartThings
// CLI's `apps:create` sends; or made with the CLI by hand). It's linked once, after which Kova keeps the refresh
// token, which SmartThings replaces on every use, in <KOVA_DATA>/smartthings/token.json. A personal access token
// works on its own too, but SmartThings now ends those after 24 h.

export const SMARTTHINGS_URLS = { api: 'https://api.smartthings.com/v1', authorize: 'https://api.smartthings.com/oauth/authorize', token: 'https://api.smartthings.com/oauth/token' };
export const SMARTTHINGS_DEFAULT_REDIRECT = 'https://httpbin.org/get';
const SCOPES = 'r:devices:* x:devices:*';

export interface SmartThingsOptions {
  /** A personal access token (account.smartthings.com/tokens). Lasts 24 h when made after December 2024. */
  token?: string;
  /** An OAuth-In app's client id and secret, from `smartthings apps:create`. */
  clientId?: string;
  clientSecret?: string;
  /** From linking (Link SmartThings). Kova keeps the newest one in storageDir, since SmartThings replaces it on every refresh. */
  refreshToken?: string;
  /** SmartThings device ids to use. Default: every soundbar on the account. */
  devices?: string[];
  /** SmartThings name → Kova room id. */
  rooms?: Record<string, string>;
  /** SmartThings name → Kova device id. */
  ids?: Record<string, string>;
  /** How often to read the soundbars, in seconds. Default 15; 0 = only after commands. */
  pollSec?: number;
  storageDir: string;
  apiUrl?: string;
  tokenUrl?: string;
  timeoutMs?: number;
  /** How long after a volume step the bar is read back (it's shown a step on at once). Default 1.5 s. */
  settleMs?: number;
}

interface StDevice { deviceId: string; label?: string; name?: string; manufacturerName?: string; ocf?: { deviceType?: string; modelNumber?: string }; components?: { id: string; capabilities?: { id: string }[] }[] }
type Status = Record<string, Record<string, { value?: unknown }>>;

/** Kova's names for soundbar inputs ↔ SmartThings's. "tv" is the TV's eARC/ARC or optical ("digital"). */
const TO_ST: Record<string, string> = { tv: 'digital', hdmi1: 'HDMI1', hdmi2: 'HDMI2', bluetooth: 'bluetooth', wifi: 'wifi' };
export function toStInput(input: string): string { return TO_ST[input] ?? input; }
export function fromStInput(v: string): string {
  const hdmi = /^hdmi\s*([1-4])$/i.exec(v.trim());
  if (hdmi) return `hdmi${hdmi[1]}`;
  const hit = Object.entries(TO_ST).find(([, st]) => st.toLowerCase() === v.toLowerCase());
  return hit ? hit[0] : /^(arc|earc|optical|d\.in)$/i.test(v) ? 'tv' : v.toLowerCase();
}

/** Is this SmartThings device a soundbar (Samsung's "network audio")? */
export function isSoundbar(d: StDevice): boolean {
  const caps = new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []);
  if (!caps.has('audioVolume')) return false;
  return d.ocf?.deviceType === 'oic.d.networkaudio' || caps.has('samsungvd.soundFrom') || /soundbar|\bhw-/i.test(`${d.label ?? ''} ${d.name ?? ''} ${d.ocf?.modelNumber ?? ''}`);
}

/** The state a soundbar's SmartThings status describes. */
export function soundbarState(st: Status | undefined): DeviceState {
  const v = (cap: string, attr: string) => st?.[cap]?.[attr]?.value;
  const out: DeviceState = { online: true };
  const sw = v('switch', 'switch');
  if (sw === 'on' || sw === 'off') out.on = sw === 'on';
  const vol = Number(v('audioVolume', 'volume'));
  if (Number.isFinite(vol)) out.vol = vol;
  const mute = v('audioMute', 'mute');
  if (mute === 'muted' || mute === 'unmuted') out.muted = mute === 'muted';
  const input = v('mediaInputSource', 'inputSource') ?? v('samsungvd.audioInputSource', 'inputSource');
  if (typeof input === 'string' && input) out.input = fromStInput(input);
  const play = v('mediaPlayback', 'playbackStatus');
  if (play === 'playing' || play === 'paused') out.paused = play === 'paused';
  const td = v('audioTrackData', 'audioTrackData');
  if (td && typeof td === 'object' && (td as { title?: unknown }).title) {
    const t = td as { title?: string; artist?: string; album?: string };
    out.track = { title: t.title!, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}) };
  }
  return out;
}

/** The state a Samsung TV's SmartThings status describes: switch, volume, mute, input and its extra modes. */
export function tvState(st: Status | undefined, inputCap: string): DeviceState {
  const v = (cap: string, attr: string) => st?.[cap]?.[attr]?.value;
  const out: DeviceState = { online: true };
  const sw = v('switch', 'switch');
  if (sw === 'on' || sw === 'off') out.on = sw === 'on';
  const vol = Number(v('audioVolume', 'volume'));
  if (Number.isFinite(vol)) out.vol = vol;
  const mute = v('audioMute', 'mute');
  if (mute === 'muted' || mute === 'unmuted') out.muted = mute === 'muted';
  const input = v(inputCap, 'inputSource');
  if (typeof input === 'string' && input) out.input = fromTvSource(input);
  const play = v('mediaPlayback', 'playbackStatus');
  if (play === 'playing' || play === 'paused') out.paused = play === 'paused';
  const watts = (v('powerConsumptionReport', 'powerConsumption') as { power?: unknown } | undefined)?.power;
  if (typeof watts === 'number' && Number.isFinite(watts) && watts > 0) out.power = watts;
  const extras: Record<string, string | number | boolean> = {};
  const pic = v('samsungvd.pictureMode', 'pictureMode');
  if (typeof pic === 'string' && pic) extras.pictureMode = pic;
  const snd = v('samsungvd.soundMode', 'soundMode');
  if (typeof snd === 'string' && snd) extras.soundMode = snd;
  const ch = v('tvChannel', 'tvChannelName');
  if (typeof ch === 'string' && ch) extras.channel = ch;
  if (Object.keys(extras).length) out.extras = extras;
  return out;
}

export class SmartThingsError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** Access tokens: a personal token as it is, or from the OAuth refresh token (kept on disk, replaced on every refresh). */
export class SmartThingsAuth {
  private access = '';
  private expires = 0;
  private refreshing: Promise<string> | null = null;
  private file: string;

  constructor(private o: Pick<SmartThingsOptions, 'token' | 'clientId' | 'clientSecret' | 'refreshToken' | 'storageDir' | 'tokenUrl' | 'timeoutMs'>, private now = () => Date.now()) {
    this.file = join(o.storageDir, 'token.json');
  }

  /** The refresh token to use: the one Kova kept, unless the settings carry a newer link. */
  private stored(): { refreshToken?: string; seed?: string } {
    for (const f of [this.file, this.file + '.bak']) {
      try { if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')); } catch { /* torn write: try the backup */ }
    }
    return {};
  }
  private refreshTokenNow(): string | undefined {
    const s = this.stored();
    // Linked again in the app: the settings' token is new, so it wins over the one kept from the old link.
    if (this.o.refreshToken && s.seed !== this.o.refreshToken) return this.o.refreshToken;
    return s.refreshToken ?? this.o.refreshToken;
  }
  private keep(refreshToken: string): void {
    mkdirSync(this.o.storageDir, { recursive: true });
    const data = JSON.stringify({ refreshToken, seed: this.o.refreshToken }, null, 2) + '\n';
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    try { writeFileSync(this.file + '.bak', data, { mode: 0o600 }); } catch { /* backup is best-effort */ }
  }

  get linked(): boolean { return !!this.o.token || !!(this.o.clientId && this.o.clientSecret && this.refreshTokenNow()); }
  invalidate(): void { this.access = ''; this.expires = 0; }

  async token(): Promise<string> {
    if (this.o.clientId && this.o.clientSecret && this.refreshTokenNow()) {
      if (this.access && this.now() < this.expires - 60_000) return this.access;
      this.refreshing ??= (async () => {
        try {
          const j = await smartThingsToken(this.o, { grant_type: 'refresh_token', refresh_token: this.refreshTokenNow()!, client_id: this.o.clientId! });
          if (j.refresh_token) this.keep(j.refresh_token);
          this.access = j.access_token;
          this.expires = this.now() + (j.expires_in ?? 86_400) * 1000;
          return this.access;
        } finally { this.refreshing = null; }
      })();
      return this.refreshing;
    }
    if (this.o.token) return this.o.token;
    throw new SmartThingsError('Link SmartThings first', 401);
  }
}

async function smartThingsToken(o: Pick<SmartThingsOptions, 'clientId' | 'clientSecret' | 'tokenUrl' | 'timeoutMs'>, form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(o.tokenUrl ?? SMARTTHINGS_URLS.token, {
    method: 'POST', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams(form).toString(),
  });
  const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new SmartThingsError(j.error === 'invalid_grant' ? 'SmartThings sign-in has ended: link SmartThings again' : `SmartThings sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`, res.status);
  }
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Where to send the owner to allow Kova (then they paste the code from the address bar). */
export function smartThingsAuthUrl(o: { clientId: string; redirectUri?: string }): string {
  const q = new URLSearchParams({ client_id: o.clientId, response_type: 'code', redirect_uri: o.redirectUri ?? SMARTTHINGS_DEFAULT_REDIRECT, scope: SCOPES });
  // "*" written as %2A: a trailing "*" is dropped when the link is copied or made clickable (scope "x:devices:" → invalid_scope).
  return `${SMARTTHINGS_URLS.authorize}?${q.toString().replace(/\*/g, '%2A')}`;
}

/**
 * Make Kova's OAuth-In app on the owner's SmartThings account, the way `smartthings apps:create` does, with a
 * personal access token that can manage apps (it's used only for this; SmartThings ends it by itself in 24 h).
 * Returns the app's OAuth client id and secret, which link Kova from then on.
 */
export async function createSmartThingsApp(o: { token: string; redirectUri?: string; apiUrl?: string; timeoutMs?: number }): Promise<{ clientId: string; clientSecret: string; appId?: string }> {
  const res = await fetch(`${o.apiUrl ?? SMARTTHINGS_URLS.api}/apps`, {
    method: 'POST',
    headers: { authorization: `Bearer ${o.token.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      appName: `kova-${randomBytes(4).toString('hex')}`,
      displayName: 'Kova',
      description: 'Kova smart home hub: Samsung soundbars and TVs on your home network',
      appType: 'API_ONLY',
      classifications: ['CONNECTED_SERVICE'],
      singleInstance: true,
      apiOnly: {},
      principalType: 'LOCATION',
      oauth: { clientName: 'Kova', scope: SCOPES.split(' '), redirectUris: [o.redirectUri ?? SMARTTHINGS_DEFAULT_REDIRECT] },
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  const j = await res.json().catch(() => ({})) as { oauthClientId?: string; oauthClientSecret?: string; app?: { appId?: string }; error?: { message?: string; details?: { message?: string }[] } };
  if (res.status === 401 || res.status === 403) throw new Error('SmartThings didn’t accept that token for making apps: make a new one with the Apps permissions ticked (and Devices)');
  if (!res.ok || !j.oauthClientId || !j.oauthClientSecret) throw new Error(`SmartThings couldn’t make Kova’s app: ${j.error?.details?.[0]?.message ?? j.error?.message ?? `HTTP ${res.status}`}`);
  return { clientId: j.oauthClientId, clientSecret: j.oauthClientSecret, ...(j.app?.appId ? { appId: j.app.appId } : {}) };
}

/** Swap the one-time code for a refresh token. */
export async function exchangeSmartThingsCode(o: { code: string; clientId: string; clientSecret: string; redirectUri?: string; tokenUrl?: string }): Promise<{ refreshToken: string }> {
  const j = await smartThingsToken(o, { grant_type: 'authorization_code', code: o.code, client_id: o.clientId, redirect_uri: o.redirectUri ?? SMARTTHINGS_DEFAULT_REDIRECT });
  if (!j.refresh_token) throw new SmartThingsError('SmartThings returned no refresh token', 0);
  return { refreshToken: j.refresh_token };
}

interface Bar {
  id: string; st: string; name: string; model?: string;
  /** Its SmartThings capabilities, and the input ids it lists (supportedInputSources), to pick the right command and name. */
  caps: Set<string>; inputs: string[];
  sound: string | null; night: boolean | null;
}
/** A Samsung TV on the account. Announced as its own device (it can be combined with the same TV on another adapter). */
interface StTv { id: string; st: string; label: string; model: string; caps: Set<string> }
/** A sensor the account exposes: the TV's light and sound (baby crying, dog barking) sensors and the like. */
interface StSensor { id: string; st: string; label?: string; model?: string; detected: string | null }

/** Is this SmartThings device a TV? */
export function isTv(d: StDevice): boolean {
  const caps = new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []);
  return d.ocf?.deviceType === 'oic.d.tv' || caps.has('samsungvd.mediaInputSource') || (caps.has('tvChannel') && caps.has('mediaInputSource'));
}

/** Is this a standalone sensor (a TV's light or sound sensor shows up as its own device)? */
export function isSensor(d: StDevice): boolean {
  const caps = new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []);
  return (caps.has('illuminanceMeasurement') || caps.has('soundDetection') || caps.has('samsungvd.soundDetection')) && !isTv(d) && !isSoundbar(d);
}

/** A soundbar input by Kova's name (tv, hdmi1, hdmi2, bluetooth, wifi) as the bar's own id, from the ids it lists. */
export function toBarSource(input: string, supported: string[]): string {
  const m = /^hdmi([1-4])$/.exec(input);
  const want = m ? [`HDMI${m[1]}`, `HDMI ${m[1]}`]
    : input === 'tv' ? ['digital', 'd.in', 'optical', 'earc', 'arc', 'tv']
    : input === 'bluetooth' ? ['bluetooth', 'bt']
    : [input];
  for (const w of want) { const hit = supported.find(x => x.toLowerCase() === w.toLowerCase()); if (hit) return hit; }
  return toStInput(input);
}

/**
 * The OCF soundFrom body for a soundbar that doesn't take mediaInputSource commands (only samsungvd.audioInputSource,
 * which reads the input but can't set it): /sec/networkaudio/soundFrom, the way Samsung's own app switches it.
 */
export function barSoundFrom(input: string): Record<string, unknown> | null {
  const sb: Record<string, [number, string]> = { tv: [25, 'D-IN/TV ARC'], hdmi1: [3, 'HDMI 1'], hdmi2: [21, 'HDMI 2'] };
  const m = sb[input];
  if (!m) return null;
  return { groupName: '', duid: '', deviceType: 4, sbMode: m[0], di: '', ip: '', name: 'External Device', connectionType: m[1], mac: '', status: 0 };
}

/** A soundbar's state from its SmartThings status: playback and the track it reports too. */
function sensorState(st: Status | undefined): DeviceState {
  const v = (cap: string, attr: string) => st?.[cap]?.[attr]?.value;
  const out: DeviceState = { online: true };
  const sw = v('switch', 'switch');
  if (sw === 'on' || sw === 'off') out.on = sw === 'on';
  const lux = Number(v('illuminanceMeasurement', 'illuminance'));
  if (Number.isFinite(lux)) out.lux = lux;
  const extras: Record<string, string | number | boolean> = {};
  const bright = v('relativeBrightness', 'brightnessIntensity');
  if (typeof bright === 'number' || typeof bright === 'string') extras.brightness = String(bright);
  const detected = v('soundDetection', 'soundDetected') ?? v('samsungvd.soundDetection', 'soundDetected');
  if (typeof detected === 'string') extras.detected = detected;
  const det = v('soundDetection', 'soundDetectionState');
  if (det === 'enabled' || det === 'disabled') extras.detection = det === 'enabled';
  if (Object.keys(extras).length) out.extras = extras;
  return out;
}

/** A TV source by Kova's name (hdmi1..hdmi4, tv) as the TV's own id, from the ids it lists. */
export function toTvSource(input: string, supported: string[]): string {
  const want = /^hdmi([1-4])$/.exec(input) ? [`HDMI${input.slice(4)}`] : input === 'tv' ? ['dtv', 'digitalTv', 'TV', 'atv'] : [input];
  for (const w of want) { const hit = supported.find(x => x.toLowerCase() === w.toLowerCase()); if (hit) return hit; }
  return want[0];
}
/** A TV's own source id as Kova's name. */
export function fromTvSource(v: string): string {
  const m = /^hdmi\s*([1-4])$/i.exec(v.trim());
  return m ? `hdmi${m[1]}` : /^(dtv|digitaltv|tv|atv|analogtv)$/i.test(v.trim()) ? 'tv' : v.toLowerCase();
}

export class SmartThingsAdapter implements Adapter {
  id = 'smartthings';
  name = 'Samsung SmartThings (soundbar, TV source)';
  icon = 'speaker';
  kind = 'Cloud' as const;
  private ctx?: AdapterContext;
  private auth: SmartThingsAuth;
  private bars = new Map<string, Bar>();
  private tvs: StTv[] = [];
  private sensors = new Map<string, StSensor>();
  private poller: NodeJS.Timeout | null = null;
  private error: string | null = null;

  constructor(private o: SmartThingsOptions) { this.auth = new SmartThingsAuth(o); }

  private async api<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const res = await fetch(`${(this.o.apiUrl ?? SMARTTHINGS_URLS.api).replace(/\/$/, '')}${path}`, {
      method, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      headers: { authorization: `Bearer ${await this.auth.token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && retry) { this.auth.invalidate(); return this.api(method, path, body, false); }
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const e = JSON.parse(text) as { error?: { message?: string } }; if (e.error?.message) msg = e.error.message; } catch { /* plain text */ }
      throw new SmartThingsError(res.status === 401 ? 'SmartThings no longer accepts Kova’s sign-in: link SmartThings again' : `SmartThings ${method} ${path.split('?')[0]} failed: ${msg}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private get devicesFile(): string { return join(this.o.storageDir, 'devices.json'); }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!this.auth.linked) this.error = 'Not linked yet: use Link SmartThings';
    else {
      try { await this.discover(); }
      catch (e) { this.error = (e as Error).message; }
    }
    if (!this.tvs.length && !this.bars.size && !this.sensors.size) this.restore();
    await this.poll();
    // Each poll is one API call per device — stretch the interval with the device count so a
    // day stays at ~5,700 calls whether there are 4 devices or 100.
    const n = Math.max(1, this.bars.size + this.tvs.length + this.sensors.size);
    const every = Math.max((this.o.pollSec ?? 30) * 1000, n * 15_000);
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); this.poller = null; }

  private async discover(): Promise<void> {
    const { items = [] } = await this.api<{ items?: StDevice[] }>('GET', '/devices');
    const want = this.o.devices?.length ? new Set(this.o.devices) : null;
    this.tvs = items.filter(isTv).map(d => ({
      id: `smarttv_${d.deviceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`,
      st: d.deviceId, label: d.label || d.name || '', model: (d.ocf?.modelNumber ?? '').split('|')[0],
      caps: new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []),
    }));
    const found = items.filter(d => want ? want.has(d.deviceId) : isSoundbar(d));
    for (const d of found) {
      const id = this.kovaId(d);
      if (!this.bars.has(id)) this.bars.set(id, {
        id, st: d.deviceId, name: d.label || d.name || 'Soundbar', model: d.ocf?.modelNumber?.split('|')[0],
        caps: new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []), inputs: [], sound: null, night: null,
      });
    }
    for (const d of items.filter(isSensor)) {
      if (!this.sensors.has(d.deviceId)) {
        this.sensors.set(d.deviceId, { id: `stsensor_${d.deviceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`, st: d.deviceId, label: d.label || d.name || 'Sensor', model: d.ocf?.modelNumber?.split('|')[0], detected: null });
      }
    }
    this.announceAll();
    this.saveDevices();
    this.error = found.length || this.tvs.length || this.sensors.size ? null : 'No soundbar or TV on this SmartThings account';
  }

  /** Announce every known device. Announce upserts by id, so repeat calls are safe. */
  private announceAll(): void {
    this.ctx!.announce([...this.bars.values()].map(b => ({
      id: b.id, name: b.name, type: 'media' as const, room: this.o.rooms?.[b.name] ?? 'unassigned', // not a room made up from its name: the owner puts it in one
      integration: `Samsung soundbar${b.model ? ` · ${b.model}` : ''}`, address: b.st,
      capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'],
    })));
    // TVs are full devices too: their modes and power readings don't fit anywhere else. The same TV on another
    // adapter (cast, the Samsung TV remote) can be combined with it.
    this.ctx!.announce(this.tvs.map(t => ({
      id: t.id, name: t.label || 'Samsung TV', type: 'tv' as const, room: this.o.rooms?.[t.label] ?? 'unassigned',
      integration: `Samsung SmartThings${t.model ? ` · ${t.model}` : ''}`, address: t.st,
      capabilities: ['onoff', 'volume', 'mute', 'input', 'power', 'extras'],
    })));
    this.ctx!.announce([...this.sensors.values()].map(s => ({
      id: s.id, name: s.label || 'Sensor', type: 'sensor' as const,
      room: this.o.rooms?.[s.label ?? ''] ?? 'unassigned',
      integration: `Samsung SmartThings${s.model ? ` · ${s.model}` : ''}`, address: s.st,
      capabilities: ['events', 'onoff', 'extras'],
    })));
  }

  /** Keep the discovered list on disk so a failed discover (dead grant, cloud down) doesn't make devices vanish. */
  private saveDevices(): void {
    try {
      mkdirSync(this.o.storageDir, { recursive: true });
      const data = JSON.stringify({
        tvs: this.tvs.map(t => ({ ...t, caps: [...t.caps] })),
        bars: [...this.bars.values()].map(b => ({ ...b, caps: [...b.caps] })),
        sensors: [...this.sensors.values()],
      });
      const tmp = this.devicesFile + '.tmp';
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, this.devicesFile);
    } catch { /* a cache only */ }
  }

  /** Announce the last-discovered devices again; the poll marks them offline until the link works. */
  private restore(): void {
    let c: { tvs?: (Omit<StTv, 'caps'> & { caps: string[] })[]; bars?: (Omit<Bar, 'caps' | 'inputs'> & { caps?: string[]; inputs?: string[] })[]; sensors?: StSensor[] };
    try { c = JSON.parse(readFileSync(this.devicesFile, 'utf8')); } catch { return; }
    // A bar kept by a Kova from before capabilities were kept: assumed to take mediaInputSource, as Kova always sent.
    for (const b of c.bars ?? []) this.bars.set(b.id, { ...b, caps: new Set(b.caps ?? ['mediaInputSource']), inputs: b.inputs ?? [] });
    this.tvs = (c.tvs ?? []).map(t => ({ ...t, caps: new Set(t.caps ?? []) }));
    for (const s of c.sensors ?? []) this.sensors.set(s.st, s);
    if (this.tvs.length || this.bars.size || this.sensors.size) this.announceAll();
  }

  private kovaId(d: StDevice): string {
    return this.o.ids?.[d.label ?? ''] ?? this.o.ids?.[d.name ?? ''] ?? `soundbar_${d.deviceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
  }

  private async read(b: Bar): Promise<DeviceState> {
    const st = await this.api<{ components?: Record<string, Status> }>('GET', `/devices/${encodeURIComponent(b.st)}/status`);
    const main = st.components?.main ?? {};
    const sup = main['mediaInputSource']?.supportedInputSources?.value ?? main['samsungvd.audioInputSource']?.supportedInputSources?.value;
    if (Array.isArray(sup)) b.inputs = sup.map(String);
    const s = soundbarState(main);
    // Sound mode and night mode can't be read back: what Kova last set.
    if (b.sound) s.sound = b.sound;
    if (b.night !== null) s.night = b.night;
    return s;
  }

  private async mainStatus(d: { st: string }): Promise<Status | undefined> {
    const st = await this.api<{ components?: Record<string, Status> }>('GET', `/devices/${encodeURIComponent(d.st)}/status`);
    return st.components?.main;
  }

  private async poll(): Promise<void> {
    let failed = 0;
    await Promise.all([
      ...[...this.bars.values()].map(async b => {
        try { this.ctx!.report(b.id, await this.read(b)); }
        catch (e) { failed++; if ((e as SmartThingsError).status === 401) this.error = (e as Error).message; else this.ctx!.report(b.id, { online: false }); }
      }),
      ...this.tvs.map(async t => {
        try { this.ctx!.report(t.id, tvState(await this.mainStatus(t), this.tvCap(t))); }
        catch (e) { failed++; if ((e as SmartThingsError).status === 401) this.error = (e as Error).message; else this.ctx!.report(t.id, { online: false }); }
      }),
      ...[...this.sensors.values()].map(async s => {
        try {
          const st = sensorState(await this.mainStatus(s));
          const detected = typeof st.extras?.detected === 'string' ? st.extras.detected : null;
          // A real sound (not "noSound") is a device event automations can trigger on.
          if (detected && detected !== 'noSound' && detected !== s.detected) {
            this.ctx!.event(s.id, detected, { title: detected === 'babyCrying' ? 'Baby crying heard' : detected === 'dogBarking' ? 'Dog barking heard' : `${detected} heard` });
          }
          if (detected) s.detected = detected;
          this.ctx!.report(s.id, st);
        } catch (e) { failed++; if ((e as SmartThingsError).status === 401) this.error = (e as Error).message; else this.ctx!.report(s.id, { online: false }); }
      }),
    ]);
    if (!failed && (this.bars.size || this.tvs.length || this.sensors.size)) this.error = null;
  }

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    const tv = this.tvs.find(t => t.id === d.id);
    if (tv) return this.tvCommand(tv, cmd);
    const sensor = this.sensors.get(d.address);
    if (sensor) {
      if (cmd.on !== undefined) await this.api('POST', `/devices/${encodeURIComponent(sensor.st)}/commands`, { commands: [{ component: 'main', capability: 'switch', command: cmd.on ? 'on' : 'off' }] });
      return;
    }
    const b = this.bars.get(d.id);
    if (!b) throw new Error(`Unknown soundbar ${d.name}`);
    const commands: { component: 'main'; capability: string; command: string; arguments?: unknown[] }[] = [];
    const c = (capability: string, command: string, args?: unknown[]) => commands.push({ component: 'main', capability, command, ...(args ? { arguments: args } : {}) });
    const exec = (path: string, body: Record<string, unknown>) => c('execute', 'execute', [path, body]);
    // On first, so the rest lands on a soundbar that's listening.
    if (cmd.on === true) c('switch', 'on');
    if (cmd.input) {
      if (b.caps.has('mediaInputSource') || !b.caps.has('samsungvd.audioInputSource')) c('mediaInputSource', 'setInputSource', [toBarSource(cmd.input, b.inputs)]);
      else {
        const sf = barSoundFrom(cmd.input);
        if (!sf) throw new Error(`${b.name} can’t be switched to ${cmd.input} from Kova`);
        exec('/sec/networkaudio/soundFrom', { 'x.com.samsung.networkaudio.soundFrom': sf });
      }
    }
    if (cmd.vol != null) c('audioVolume', 'setVolume', [Math.max(0, Math.min(100, Math.round(cmd.vol)))]);
    if (cmd.volStep) c('audioVolume', cmd.volStep > 0 ? 'volumeUp' : 'volumeDown');
    if (cmd.muted !== undefined) c('audioMute', cmd.muted ? 'mute' : 'unmute');
    if (cmd.sound) exec('/sec/networkaudio/soundmode', { 'x.com.samsung.networkaudio.soundmode': cmd.sound });
    if (cmd.night !== undefined) exec('/sec/networkaudio/advancedaudio', { 'x.com.samsung.networkaudio.nightmode': cmd.night ? 1 : 0 });
    if (cmd.on === false) c('switch', 'off');
    if (!commands.length) return;
    await this.api('POST', `/devices/${encodeURIComponent(b.st)}/commands`, { commands });
    if (cmd.sound) b.sound = cmd.sound;
    if (cmd.night !== undefined) b.night = cmd.night;
    // The input as the bar reads it back afterwards, not the one asked for (the next poll catches up).
    if (cmd.input) {
      const now = await this.read(b).catch(() => null);
      return { input: now?.input ?? null };
    }
    // A volume step lands where the bar says: shown a step on straight away (Helix's on-screen volume reads it), and
    // read back a moment later to be sure.
    if (cmd.volStep) {
      const was = typeof d.state.vol === 'number' ? d.state.vol : null;
      setTimeout(() => void this.read(b).then(s => this.ctx?.report(b.id, s)).catch(() => {}), this.o.settleMs ?? 1500).unref?.();
      if (was != null) return { vol: Math.max(0, Math.min(100, was + (cmd.volStep > 0 ? 1 : -1))) };
      const now = await this.read(b).catch(() => null);
      if (now?.vol != null) return { vol: now.vol };
    }
  }

  // ------------------------------------------------------------- TVs' sources --

  /** Which SmartThings TV is this one: same model, else same name, else the only TV on the account. */
  private tvFor(tv: { name?: string; model?: string }): StTv | null {
    const model = (tv.model ?? '').toLowerCase(), name = (tv.name ?? '').toLowerCase();
    return (model && this.tvs.find(t => t.model.toLowerCase() === model || (t.model && model.startsWith(t.model.toLowerCase())) || (t.model && t.model.toLowerCase().startsWith(model))))
      || (name && this.tvs.find(t => t.label.toLowerCase() === name))
      || (this.tvs.length === 1 ? this.tvs[0] : null);
  }

  /** Does SmartThings know this TV? */
  hasTv(tv: { name?: string; model?: string }): boolean { return !!this.tvFor(tv); }

  private tvCap(t: StTv) { return t.caps.has('samsungvd.mediaInputSource') ? 'samsungvd.mediaInputSource' : 'mediaInputSource'; }

  private async tvStatus(t: StTv): Promise<{ input: string | null; supported: string[] }> {
    const st = await this.api<{ components?: Record<string, Status> }>('GET', `/devices/${encodeURIComponent(t.st)}/status`);
    const c = st.components?.main?.[this.tvCap(t)];
    const map = c?.supportedInputSourcesMap?.value;
    const supported = Array.isArray(map) ? map.map(x => String((x as { id?: unknown }).id ?? '')) : Array.isArray(c?.supportedInputSources?.value) ? (c!.supportedInputSources!.value as unknown[]).map(String) : [];
    const v = c?.inputSource?.value;
    return { input: typeof v === 'string' && v ? fromTvSource(v) : null, supported };
  }

  /** The source the TV is on (hdmi1..hdmi4, tv, …), or undefined when SmartThings doesn't know this TV. */
  async tvInput(tv: { name?: string; model?: string }): Promise<string | null | undefined> {
    const t = this.tvFor(tv);
    return t ? (await this.tvStatus(t)).input : undefined;
  }

  /** Switch the TV to a source directly. False when SmartThings doesn't know this TV. */
  async setTvInput(tv: { name?: string; model?: string }, input: string): Promise<boolean> {
    const t = this.tvFor(tv);
    if (!t) return false;
    const { supported } = await this.tvStatus(t).catch(() => ({ supported: [] as string[] }));
    await this.api('POST', `/devices/${encodeURIComponent(t.st)}/commands`, { commands: [{ component: 'main', capability: this.tvCap(t), command: 'setInputSource', arguments: [toTvSource(input, supported)] }] });
    return true;
  }

  /** Switch the TV on or off through SmartThings (no pairing with the TV needed). False when SmartThings doesn't know this TV. */
  async setTvPower(tv: { name?: string; model?: string }, on: boolean): Promise<boolean> {
    const t = this.tvFor(tv);
    if (!t) return false;
    await this.api('POST', `/devices/${encodeURIComponent(t.st)}/commands`, { commands: [{ component: 'main', capability: 'switch', command: on ? 'on' : 'off' }] });
    return true;
  }

  /** Command a Samsung TV directly: switch, source, volume, mute, and its picture/sound modes as extras. */
  private async tvCommand(t: StTv, cmd: Command): Promise<void | DeviceState> {
    const commands: { component: 'main'; capability: string; command: string; arguments?: unknown[] }[] = [];
    const c = (capability: string, command: string, args?: unknown[]) => commands.push({ component: 'main', capability, command, ...(args ? { arguments: args } : {}) });
    if (cmd.on === true) c('switch', 'on');
    if (cmd.input) c(this.tvCap(t), 'setInputSource', [toTvSource(cmd.input, (await this.tvStatus(t).catch(() => ({ supported: [] as string[] }))).supported)]);
    if (cmd.vol != null) c('audioVolume', 'setVolume', [Math.max(0, Math.min(100, Math.round(cmd.vol)))]);
    if (cmd.muted !== undefined) c('audioMute', cmd.muted ? 'mute' : 'unmute');
    const pic = cmd.extras?.pictureMode;
    if (typeof pic === 'string' && pic && t.caps.has('samsungvd.pictureMode')) c('samsungvd.pictureMode', 'setPictureMode', [pic]);
    const snd = cmd.extras?.soundMode;
    if (typeof snd === 'string' && snd && t.caps.has('samsungvd.soundMode')) c('samsungvd.soundMode', 'setSoundMode', [snd]);
    if (cmd.on === false) c('switch', 'off');
    if (!commands.length) return;
    await this.api('POST', `/devices/${encodeURIComponent(t.st)}/commands`, { commands });
    // The source as the TV reads it back afterwards, not the one asked for (null until it says).
    if (cmd.input) return { input: (await this.tvStatus(t).catch(() => null))?.input ?? null };
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.bars.size;
    const parts = [n && `${n} soundbar${n === 1 ? '' : 's'}`, this.tvs.length && `${this.tvs.length} TV${this.tvs.length === 1 ? '' : 's'}`, this.sensors.size && `${this.sensors.size} sensor${this.sensors.size === 1 ? '' : 's'}`].filter(Boolean);
    return { ok: n > 0 || this.tvs.length > 0 || this.sensors.size > 0, note: parts.length ? parts.join(', ') : 'Looking for soundbars and TVs…' };
  }
}
