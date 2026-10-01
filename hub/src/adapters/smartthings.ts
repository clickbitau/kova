import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
}

interface StDevice { deviceId: string; label?: string; name?: string; manufacturerName?: string; ocf?: { deviceType?: string; modelNumber?: string }; components?: { id: string; capabilities?: { id: string }[] }[] }
type Status = Record<string, Record<string, { value?: unknown }>>;

/** Kova's names for soundbar inputs ↔ SmartThings's. "tv" is the TV's eARC/ARC or optical ("digital"). */
const TO_ST: Record<string, string> = { tv: 'digital', hdmi1: 'HDMI1', hdmi2: 'HDMI2', bluetooth: 'bluetooth', wifi: 'wifi' };
export function toStInput(input: string): string { return TO_ST[input] ?? input; }
export function fromStInput(v: string): string {
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
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; } catch { return {}; }
  }
  private refreshTokenNow(): string | undefined {
    const s = this.stored();
    // Linked again in the app: the settings' token is new, so it wins over the one kept from the old link.
    if (this.o.refreshToken && s.seed !== this.o.refreshToken) return this.o.refreshToken;
    return s.refreshToken ?? this.o.refreshToken;
  }
  private keep(refreshToken: string): void {
    mkdirSync(this.o.storageDir, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ refreshToken, seed: this.o.refreshToken }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.file, 0o600);
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

interface Bar { id: string; st: string; name: string; sound: string | null; night: boolean | null }
/** A Samsung TV on the account. Kova's Samsung TV adapter owns the TV; SmartThings sets and reads its source. */
interface StTv { st: string; label: string; model: string; caps: Set<string> }

/** Is this SmartThings device a TV? */
export function isTv(d: StDevice): boolean {
  const caps = new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []);
  return d.ocf?.deviceType === 'oic.d.tv' || caps.has('samsungvd.mediaInputSource') || (caps.has('tvChannel') && caps.has('mediaInputSource'));
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

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!this.auth.linked) { this.error = 'Not linked yet: use Link SmartThings'; return; }
    try {
      await this.discover();
      await this.poll();
    } catch (e) { this.error = (e as Error).message; }
    const every = (this.o.pollSec ?? 15) * 1000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); this.poller = null; }

  private async discover(): Promise<void> {
    const { items = [] } = await this.api<{ items?: StDevice[] }>('GET', '/devices');
    const want = this.o.devices?.length ? new Set(this.o.devices) : null;
    this.tvs = items.filter(isTv).map(d => ({
      st: d.deviceId, label: d.label || d.name || '', model: (d.ocf?.modelNumber ?? '').split('|')[0],
      caps: new Set((d.components ?? []).find(c => c.id === 'main')?.capabilities?.map(c => c.id) ?? []),
    }));
    const found = items.filter(d => want ? want.has(d.deviceId) : isSoundbar(d));
    const fresh = found.filter(d => !this.bars.has(this.kovaId(d)));
    for (const d of found) {
      const id = this.kovaId(d);
      if (!this.bars.has(id)) this.bars.set(id, { id, st: d.deviceId, name: d.label || d.name || 'Soundbar', sound: null, night: null });
    }
    if (fresh.length) {
      this.ctx!.announce(fresh.map(d => {
        const name = d.label || d.name || 'Soundbar';
        return {
          id: this.kovaId(d), name, type: 'media' as const, room: this.o.rooms?.[name] ?? 'unassigned', // not a room made up from its name: the owner puts it in one
          integration: `Samsung soundbar${d.ocf?.modelNumber ? ` · ${d.ocf.modelNumber.split('|')[0]}` : ''}`, address: d.deviceId,
          capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'],
        };
      }));
    }
    this.error = found.length || this.tvs.length ? null : 'No soundbar or TV on this SmartThings account';
  }

  private kovaId(d: StDevice): string {
    return this.o.ids?.[d.label ?? ''] ?? this.o.ids?.[d.name ?? ''] ?? `soundbar_${d.deviceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
  }

  private async read(b: Bar): Promise<DeviceState> {
    const st = await this.api<{ components?: Record<string, Status> }>('GET', `/devices/${encodeURIComponent(b.st)}/status`);
    const s = soundbarState(st.components?.main);
    // Sound mode and night mode can't be read back: what Kova last set.
    if (b.sound) s.sound = b.sound;
    if (b.night !== null) s.night = b.night;
    return s;
  }

  private async poll(): Promise<void> {
    let failed = 0;
    await Promise.all([...this.bars.values()].map(async b => {
      try { this.ctx!.report(b.id, await this.read(b)); }
      catch (e) { failed++; if ((e as SmartThingsError).status === 401) this.error = (e as Error).message; else this.ctx!.report(b.id, { online: false }); }
    }));
    if (!failed && this.bars.size) this.error = null;
  }

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    const b = this.bars.get(d.id);
    if (!b) throw new Error(`Unknown soundbar ${d.name}`);
    const commands: { component: 'main'; capability: string; command: string; arguments?: unknown[] }[] = [];
    const c = (capability: string, command: string, args?: unknown[]) => commands.push({ component: 'main', capability, command, ...(args ? { arguments: args } : {}) });
    const exec = (path: string, body: Record<string, unknown>) => c('execute', 'execute', [path, body]);
    // On first, so the rest lands on a soundbar that's listening.
    if (cmd.on === true) c('switch', 'on');
    if (cmd.input) c('mediaInputSource', 'setInputSource', [toStInput(cmd.input)]);
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
    // A volume step lands somewhere Kova can only read: read it, and the rest, back.
    if (cmd.volStep) {
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

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.bars.size;
    const parts = [n && `${n} soundbar${n === 1 ? '' : 's'}`, this.tvs.length && `the source of ${this.tvs.length} TV${this.tvs.length === 1 ? '' : 's'}`].filter(Boolean);
    return { ok: n > 0 || this.tvs.length > 0, note: parts.length ? parts.join(', ') : 'Looking for soundbars and TVs…' };
  }
}
