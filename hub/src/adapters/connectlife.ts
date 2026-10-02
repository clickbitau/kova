import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState, FanSpeed, HvacMode, Zone } from '../model/types.ts';

// Hisense air conditioners (and other ConnectLife appliances) through the ConnectLife cloud. They have no
// local API: the ConnectLife app, Hisense's official Home Assistant plugin (MIT, Connectlife-LLC/HomeAssistantPlugin)
// and this adapter all talk to Hisense's servers. The request shapes follow that plugin:
//
//   sign-in      OAuth 2 code flow at oauth.hijuconn.com, with Hisense's published app id/secret. The redirect is
//                the plugin's registered one; the page it lands on doesn't load, and the owner copies the
//                address (…?code=…) back, as with SmartThings. Kova keeps the refresh token in
//                <KOVA_DATA>/connectlife/token.json.
//   requests     every call is signed: HMAC-SHA256 (app secret) over "appId\nMETHOD path\ndate: …\nhi-params-encrypt: appId\n",
//                plus a SHA-256 digest of the body, and carries "system parameters" (timeStamp, randStr, appId…).
//   devices      GET /clife-svc/pu/get_device_status_list → deviceList[] with statusList {t_power, t_work_mode, …}
//   control      POST /device/pu/property/set {puid, properties: {t_power: "1", t_temp: "24", …}}
//
// Air conditioners (split 009, window 008, portable 006) become `climate` devices.

export const CONNECTLIFE = {
  authorize: 'https://oauth.hijuconn.com/login',
  token: 'https://oauth.hijuconn.com/oauth/token',
  api: 'https://juapi-3rd.hijuconn.com',
  /** Hisense's app credentials for third-party hubs, as published in their official plugin. */
  clientId: '9793620883275788',
  clientSecret: '7h1m3gZVlILyBvIFBNmzXwoFYLhkGqG9NQd2jBzuZCqJKCTyCtYwQtXi4tVBjg9B',
  /** The redirect registered for that app: nothing answers there; the code is copied from the address bar. */
  redirect: 'http://homeassistant.local:8123/auth/external/callback',
};

/** Appliance types that are air conditioners: split, window, portable. */
const AC_TYPES = new Set(['009', '008', '006']);
const MODES: Record<string, HvacMode> = { 0: 'fan', 1: 'heat', 2: 'cool', 3: 'dry', 4: 'auto' };
const FANS: Record<string, FanSpeed> = { 0: 'auto', 5: 'quiet', 6: 'low', 7: 'medium', 8: 'high', 9: 'turbo' };
const invert = <T extends string>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<T, string>;
const MODE_CODE = invert(MODES), FAN_CODE = invert(FANS);

export interface ConnectLifeOptions {
  /** From linking (Integrations → ConnectLife → Link). Kova keeps the newest one in its data folder. */
  refreshToken?: string;
  /** Hisense device id → Kova room id. */
  rooms?: Record<string, string>;
  timezone?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Tests: Hisense's addresses and app credentials. */
  urls?: Partial<Pick<typeof CONNECTLIFE, 'authorize' | 'token' | 'api' | 'clientId' | 'clientSecret' | 'redirect'>>;
  storageDir?: string;
}

interface HisenseDevice {
  deviceId: string; puid: string; deviceNickName?: string; deviceTypeCode?: string; deviceFeatureCode?: string;
  /** Despite the name, 1 means online (as Hisense's own plugin reads it); 0 offline. */
  offlineState?: number | string; statusList?: Record<string, string | number>;
}

// ------------------------------------------------------------- pure helpers --

/** The sign-in page to send the owner to. */
export function connectLifeAuthUrl(o: ConnectLifeOptions['urls'] = {}): string {
  const c = { ...CONNECTLIFE, ...o };
  const q = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.redirect, state: randomBytes(8).toString('hex') });
  return `${c.authorize}?${q}`;
}

/** Signature headers for one request (the plugin's scheme). `body` is the exact JSON sent, or '' for none. */
export function connectLifeHeaders(method: string, path: string, body: string, o: { appId: string; secret: string; date?: string }): Record<string, string> {
  const date = o.date ?? new Date().toUTCString();
  const signed = `${o.appId}\n${method} ${path}\ndate: ${date}\nhi-params-encrypt: ${o.appId}\n`;
  const sign = createHmac('sha256', o.secret).update(signed).digest('base64');
  return {
    'hi-params-encrypt': o.appId,
    date,
    authorization: `Signature signature="${sign}", keyId="${o.appId}",algorithm="hmac-sha256", headers="@request-target date hi-params-encrypt"`,
    'content-type': 'application/json',
    digest: `SHA-256=${createHash('sha256').update(body).digest('base64')}`,
  };
}

/** Online, as ConnectLife says it: `offlineState` 1 is online (Hisense's plugin: `is_online = offline_state == 1`). Unknown: online. */
export const isOnline = (d: Pick<HisenseDevice, 'offlineState'>) => d.offlineState === undefined || d.offlineState === null || String(d.offlineState) === '1';

/** Switches Hisense units report that Kova has no named field for — kept by name so they still show and set. */
const EXTRAS: Record<string, string> = {
  eco: 't_eco', sleep: 't_sleep', turbo: 't_super', purify: 't_purify', fanMute: 't_fan_mute', frostProtect: 't_8heat', dimmer: 't_dimmer',
};

/** The extra switches a unit reports (a subset of EXTRAS — models differ). */
export function extrasOf(s: Record<string, string | number>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, p] of Object.entries(EXTRAS)) if (s[p] !== undefined) out[k] = String(s[p]) === '1';
  return out;
}

/** A Hisense air conditioner's status → Kova's climate state. Temperatures in °C (Fahrenheit units converted). */
export function acState(d: HisenseDevice): DeviceState {
  const s = d.statusList ?? {};
  const f = String(s.t_temp_type ?? '0') === '1';
  const c = (v: unknown) => {
    const n = Number(v);
    if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return null;
    return f ? Math.round(((n - 32) * 5) / 9 * 2) / 2 : n;
  };
  const hum = Number(s.f_humidity);
  const extras = extrasOf(s);
  return {
    online: isOnline(d),
    on: String(s.t_power ?? '0') === '1',
    hvac: MODES[String(s.t_work_mode)] ?? null,
    fanSpeed: FANS[String(s.t_fan_speed)] ?? null,
    target: c(s.t_temp),
    temp: c(s.f_temp_in),
    ...(Number.isFinite(hum) && hum >= 0 && hum <= 100 ? { humidity: hum } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
    ...(hasZones(d) ? { zones: zonesOf(s) } : {}),
  };
}

/** Ducted units with zones (Australian models): aus_zone1_power … aus_zone8_power, and how far each is open. */
export const hasZones = (d: Pick<HisenseDevice, 'statusList'>) => Object.keys(d.statusList ?? {}).some(k => /^aus_zone\d+_power$/.test(k));
export function zonesOf(s: Record<string, string | number>): Zone[] {
  const ns = Object.keys(s).map(k => /^aus_zone(\d+)_power$/.exec(k)?.[1]).filter((n): n is string => !!n).map(Number).sort((a, b) => a - b);
  return ns.map(n => {
    const open = Number(s[`aus_zone${n}_opencontrol`]);
    return { n, on: String(s[`aus_zone${n}_power`]) === '1', open: Number.isFinite(open) ? open : null };
  });
}

/** A Kova command → the properties to set (strings, as the API takes them). Fahrenheit units get °F. */
export function acProperties(cmd: Command, fahrenheit = false): Record<string, string> {
  const p: Record<string, string> = {};
  if (cmd.on !== undefined) p.t_power = cmd.on ? '1' : '0';
  if (cmd.hvac && MODE_CODE[cmd.hvac] !== undefined) { p.t_work_mode = MODE_CODE[cmd.hvac]; p.t_power ??= '1'; }
  if (cmd.fanSpeed && FAN_CODE[cmd.fanSpeed] !== undefined) p.t_fan_speed = FAN_CODE[cmd.fanSpeed];
  // Zones: some (zoneSet, by number) or all of them (zones, as undo sends them back).
  const zs: Record<string, { on?: boolean; open?: number | null }> = { ...(cmd.zoneSet ?? {}) };
  for (const z of cmd.zones ?? []) zs[String(z.n)] = { on: z.on, open: z.open };
  for (const [n, z] of Object.entries(zs)) {
    if (!/^[1-9]\d?$/.test(n)) continue;
    if (z.on !== undefined) p[`aus_zone${n}_power`] = z.on ? '1' : '0';
    if (z.open != null) p[`aus_zone${n}_opencontrol`] = String(Math.max(0, Math.min(100, Math.round(z.open))));
  }
  for (const [k, v] of Object.entries(cmd.extras ?? {})) {
    const prop = EXTRAS[k];
    if (prop) p[prop] = v === true || v === '1' || v === 1 || v === 'on' ? '1' : '0';
  }
  if (cmd.target != null) {
    const t = Math.max(16, Math.min(32, Math.round(cmd.target)));
    p.t_temp = String(fahrenheit ? Math.round(t * 9 / 5 + 32) : t);
  }
  return p;
}

// ------------------------------------------------------------------ client --

class ConnectLifeError extends Error {
  kind: 'auth' | 'other';
  constructor(message: string, kind: 'auth' | 'other' = 'other') { super(message); this.kind = kind; }
}

/** Hisense's API with sign-in kept fresh. The newest refresh token is written to disk (it may change on each refresh). */
export class ConnectLifeClient {
  private access: { token: string; until: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly c: typeof CONNECTLIFE;
  private readonly o: ConnectLifeOptions & { storageDir: string };
  private readonly source = `td001002000${createHash('md5').update(randomBytes(16)).digest('hex')}`;

  constructor(o: ConnectLifeOptions & { storageDir: string }) { this.o = o; this.c = { ...CONNECTLIFE, ...o.urls }; }

  private get file() { return join(this.o.storageDir, 'token.json'); }
  private stored(): { refreshToken?: string; seed?: string } {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; } catch { return {}; }
  }
  /** The settings' token when it's a new link, else the newest one kept. */
  private refreshTokenNow(): string | undefined {
    const s = this.stored();
    if (this.o.refreshToken && s.seed !== this.o.refreshToken) return this.o.refreshToken;
    return s.refreshToken ?? this.o.refreshToken;
  }
  private keep(refreshToken: string): void {
    mkdirSync(this.o.storageDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ refreshToken, seed: this.o.refreshToken }, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
  get linked() { return !!this.refreshTokenNow(); }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    this.refreshing ??= (async () => {
      try {
        const rt = this.refreshTokenNow();
        if (!rt) throw new ConnectLifeError('Not linked to ConnectLife yet', 'auth');
        const j = await connectLifeToken({ grant_type: 'refresh_token', refresh_token: rt }, this.c, this.o.timeoutMs);
        if (j.refresh_token) this.keep(j.refresh_token);
        this.access = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
        return j.access_token;
      } finally { this.refreshing = null; }
    })();
    return this.refreshing;
  }

  private async system(): Promise<Record<string, string | number>> {
    const now = Date.now();
    return {
      timeStamp: String(now), version: '8.1', languageId: '1', timezone: this.o.timezone ?? 'UTC',
      randStr: createHash('md5').update(randomBytes(16)).digest('hex'), appId: this.c.clientId, sourceId: this.source, platformId: 5,
    };
  }

  /** A signed call; when ConnectLife says the sign-in ran out, Kova signs in again and tries once more. */
  async request<T>(method: 'GET' | 'POST', path: string, data: Record<string, unknown> = {}, again = true): Promise<T> {
    const token = await this.accessToken();
    const params: Record<string, unknown> = { ...data, ...(await this.system()) };
    let url = `${this.c.api}${path}`, body = '';
    const headers: Record<string, string> = {};
    if (method === 'GET') {
      const q = Object.entries(params).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('&');
      url += `?${q}`;
      headers.accessToken = token;
    } else {
      body = JSON.stringify({ ...params, accessToken: token });
    }
    const path2 = url.replace(/^https?:\/\/[^/]*/, '');
    Object.assign(headers, connectLifeHeaders(method, path2, body, { appId: this.c.clientId, secret: this.c.clientSecret }));
    const res = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    if (res.status === 401) {
      this.access = null;
      if (again) return this.request<T>(method, path, data, false);
      throw new ConnectLifeError('ConnectLife refused the sign-in', 'auth');
    }
    if (!res.ok) throw new ConnectLifeError(`ConnectLife HTTP ${res.status}`);
    const j = await res.json() as { resultCode?: number; msg?: string } & T;
    if (j.resultCode !== 0) throw new ConnectLifeError(`ConnectLife: ${j.msg ?? `code ${j.resultCode}`}`);
    return j;
  }

  async devices(): Promise<HisenseDevice[]> {
    return (await this.request<{ deviceList?: HisenseDevice[] }>('GET', '/clife-svc/pu/get_device_status_list')).deviceList ?? [];
  }

  async set(puid: string, properties: Record<string, string>): Promise<void> {
    await this.request('POST', '/device/pu/property/set', { puid, properties });
  }
}

/** The OAuth token endpoint: a code (linking) or a refresh token → tokens. */
export async function connectLifeToken(form: Record<string, string>, c: Pick<typeof CONNECTLIFE, 'token' | 'clientId' | 'clientSecret' | 'redirect'> = CONNECTLIFE, timeoutMs = 15_000): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(c.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirect }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new ConnectLifeError(`ConnectLife sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`, 'auth');
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Linking, once: the code from the address bar (or the whole address) → a refresh token to save. */
export async function exchangeConnectLifeCode(code: string, urls: ConnectLifeOptions['urls'] = {}): Promise<{ refreshToken: string }> {
  const c = { ...CONNECTLIFE, ...urls };
  const raw = code.trim();
  const only = decodeURIComponent(/[?&]code=([^&#\s]+)/.exec(raw)?.[1] ?? raw);
  const j = await connectLifeToken({ grant_type: 'authorization_code', code: only }, c);
  if (!j.refresh_token) throw new ConnectLifeError('ConnectLife gave no refresh token', 'auth');
  return { refreshToken: j.refresh_token };
}

// ----------------------------------------------------------------- adapter --

export class ConnectLifeAdapter implements Adapter {
  id = 'connectlife';
  name = 'Hisense ConnectLife';
  icon = 'ac_unit';
  kind = 'Cloud' as const;
  private ctx?: AdapterContext;
  private client: ConnectLifeClient;
  private units = new Map<string, HisenseDevice>();
  private poller: NodeJS.Timeout | null = null;
  private error: string | null = null;
  private readonly o: ConnectLifeOptions & { storageDir: string };

  constructor(o: ConnectLifeOptions & { storageDir: string }) { this.o = o; this.client = new ConnectLifeClient(o); }

  private kovaId(d: HisenseDevice) { return `connectlife_${d.deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toLowerCase()}`; }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.poll();
    const every = this.o.pollMs ?? 60_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); }

  /** Read every appliance: new ones are announced, and each one's state reported. */
  async poll(): Promise<void> {
    const ctx = this.ctx!;
    if (!this.client.linked) { this.error = 'Link your ConnectLife account (Integrations → Hisense ConnectLife → Link)'; return; }
    try {
      const list = (await this.client.devices()).filter(d => AC_TYPES.has(String(d.deviceTypeCode)));
      this.error = null;
      const fresh = list.filter(d => !this.units.has(this.kovaId(d)));
      for (const d of list) this.units.set(this.kovaId(d), d);
      if (fresh.length) {
        ctx.announce(fresh.map(d => ({
          id: this.kovaId(d), name: d.deviceNickName || 'Air conditioner', room: this.o.rooms?.[d.deviceId] ?? 'unassigned', type: 'climate' as const,
          capabilities: ['onoff', 'climate', ...(hasZones(d) ? (['zones'] as const) : []), ...(Object.keys(extrasOf(d.statusList ?? {})).length ? (['extras'] as const) : [])], integration: 'Hisense ConnectLife', address: d.puid,
        })));
      }
      for (const d of list) ctx.report(this.kovaId(d), acState(d));
    } catch (e) {
      this.error = (e as Error).message;
      ctx.log(this.error);
      for (const id of this.units.keys()) ctx.report(id, { online: false });
    }
  }

  async command(device: Device, cmd: Command): Promise<void | DeviceState> {
    const d = this.units.get(device.id);
    if (!d) throw new Error(`Unknown ConnectLife device ${device.id}`);
    const props = acProperties(cmd, String(d.statusList?.t_temp_type ?? '0') === '1');
    if (!Object.keys(props).length) return;
    await this.client.set(d.puid, props);
    // What was asked, as Kova reads it: the next poll confirms.
    d.statusList = { ...d.statusList, ...props };
    return acState(d);
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.units.size, off = [...this.units.values()].filter(d => !isOnline(d)).length;
    if (!n) return { ok: false, note: 'No air conditioners on this ConnectLife account' };
    return off ? { ok: false, note: `${off} of ${n} offline (cloud)` } : { ok: true, note: `${n} air conditioner${n === 1 ? '' : 's'} · cloud` };
  }
}
