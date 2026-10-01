import { createHash } from 'node:crypto';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';

// Levoit air purifiers (Core 200S/300S/400S/600S family) through the VeSync
// CLOUD API. These purifiers have no local API at all: the app, and this
// adapter, talk to VeSync's servers, which relay to the purifier over its own
// cloud connection. So this adapter needs the internet and the VeSync account
// email/password, and it stops working if VeSync changes or retires the API.
//
// The request shapes follow the behaviour of the open-source pyvesync project
// (3.x): a two-step login (password → authorization code → token, following
// VeSync's cross-region redirect), the device list, and the "bypassV2" relay
// that forwards a JSON method call to the purifier. VeSync refuses old app
// versions ("app version is too low"), so APP tracks what pyvesync sends.

export const VESYNC_HOSTS = { us: 'https://smartapi.vesync.com', eu: 'https://smartapi.vesync.eu' } as const;

// Values the VeSync Android app sends; the API expects them to be present.
const APP = { acceptLanguage: 'en', appVersion: '5.6.60', phoneBrand: 'Kova', phoneOS: 'Android', timeZone: 'America/New_York', userType: '1' };
const APP_ID = 'eldodkfj';
const CLIENT = { clientInfo: APP.phoneBrand, clientType: 'vesyncApp', clientVersion: `VeSync ${APP.appVersion}`, osInfo: APP.phoneOS, debugMode: false };
/** VeSync's answer when the account lives in the other region: retry there with the bizToken it gives. */
const CROSS_REGION = -11260022;
/** The EU countries' accounts live on the EU server; everyone else on the US one (pyvesync's rule, by exception list). */
export const regionHost = (region: string | undefined) => (String(region ?? '').toUpperCase() === 'EU' ? VESYNC_HOSTS.eu : VESYNC_HOSTS.us);

export const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Codes VeSync has been seen to use for a missing/expired token. Any message mentioning the token also counts. */
const AUTH_CODES = new Set([-11001000, -11012001, -11012022, 4001004]);
/** "Device offline" from the bypass relay. */
const OFFLINE_CODES = new Set([-11300030]);

export function isAuthError(code: number, msg = ''): boolean {
  return AUTH_CODES.has(code) || /token/i.test(msg);
}

export function isOfflineError(code: number, msg = ''): boolean {
  return OFFLINE_CODES.has(code) || /offline/i.test(msg);
}

/** Core 200S/300S/400S/600S and their LAP-C… model codes: the purifiers that speak bypassV2. */
export function isCorePurifier(deviceType: string): boolean {
  return /^Core[2346]00S/i.test(deviceType) || /^LAP-C[2346]\d\dS/i.test(deviceType);
}

export type VeSyncMode = 'auto' | 'sleep' | 'manual';
const KOVA_MODE: Record<VeSyncMode, string> = { auto: 'Auto', sleep: 'Sleep', manual: 'Manual' };

/** Kova mode name → VeSync purifier mode. */
export function toVeSyncMode(mode: string): VeSyncMode | null {
  const m = mode.trim().toLowerCase();
  return m === 'auto' || m === 'sleep' || m === 'manual' ? m : null;
}

/** What getPurifierStatus returns (inner result). */
export interface PurifierStatus {
  enabled: boolean;
  mode?: string;
  level?: number;
  display?: boolean;
  filter_life?: number;
  air_quality?: number;
  air_quality_value?: number;
}

export function statusToState(s: PurifierStatus): DeviceState {
  const st: DeviceState = { on: !!s.enabled, online: true };
  const m = s.mode ? toVeSyncMode(s.mode) : null;
  if (m) st.mode = KOVA_MODE[m];
  return st;
}

export interface VeSyncDevice {
  deviceName: string;
  deviceType: string;
  cid: string;
  uuid?: string;
  configModule?: string;
  connectionStatus?: string;
  deviceStatus?: string;
  deviceRegion?: string;
  subDeviceNo?: number | null;
}

export class VeSyncError extends Error {
  constructor(message: string, public code: number) { super(message); }
}

interface Envelope<T> { code: number; msg?: string; result?: T }

/** A logged-in VeSync account. Logs in again once when the token is rejected. */
export class VeSyncClient {
  private token = '';
  private accountId = '';
  /** Stable per account, like the app's install id ('2' + 32 hex). */
  private readonly terminalId: string;
  constructor(private base: string, private email: string, private password: string, private timeoutMs = 10_000, private country = 'US') {
    this.terminalId = '2' + md5(`kova:${email.toLowerCase()}`);
  }

  get loggedIn() { return !!this.token; }

  private async post<T>(path: string, body: Record<string, unknown>, auth: boolean): Promise<Envelope<T>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=UTF-8', 'accept-language': 'en', appVersion: APP.appVersion,
      tz: APP.timeZone, 'user-agent': 'okhttp/3.12.1',
    };
    if (auth) { headers.tk = this.token; headers.accountId = this.accountId; }
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 401 || res.status === 419) return { code: -11012022, msg: `HTTP ${res.status} token` };
    if (!res.ok) throw new VeSyncError(`VeSync HTTP ${res.status}`, res.status);
    return await res.json() as Envelope<T>;
  }

  private common(method: string, auth = true): Record<string, unknown> {
    return { ...APP, traceId: String(Date.now()), method, ...(auth ? { accountID: this.accountId, token: this.token } : {}) };
  }

  /** Sign in: the password buys an authorization code, which buys the token. */
  async login(): Promise<void> {
    const base = { acceptLanguage: APP.acceptLanguage, accountID: '', ...CLIENT, terminalId: this.terminalId, timeZone: APP.timeZone, token: '' };
    const a = await this.post<{ accountID: string; authorizeCode: string }>('/globalPlatform/api/accountAuth/v1/authByPWDOrOTM', {
      ...base, email: this.email, method: 'authByPWDOrOTM', password: md5(this.password), authProtocolType: 'generic',
      userCountryCode: this.country, appID: APP_ID, sourceAppID: APP_ID, traceId: String(Date.now()),
    }, false);
    if (a.code !== 0 || !a.result?.authorizeCode) throw new VeSyncError(`VeSync login failed: ${a.msg ?? `code ${a.code}`}`, a.code);
    let bizToken: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.post<{ token: string; accountID: string; countryCode?: string; currentRegion?: string; bizToken?: string }>('/user/api/accountManage/v1/loginByAuthorizeCode4Vesync', {
        ...base, method: 'loginByAuthorizeCode4Vesync', authorizeCode: a.result.authorizeCode, emailSubscriptions: false,
        userCountryCode: this.country, traceId: String(Date.now()),
        ...(bizToken ? { bizToken, regionChange: 'lastRegion' } : {}),
      }, false);
      if (r.code === CROSS_REGION && r.result?.bizToken && !bizToken) {
        // The account is in the other region: switch server and country, then finish there.
        if (r.result.countryCode) this.country = r.result.countryCode;
        if (r.result.currentRegion && (Object.values(VESYNC_HOSTS) as string[]).includes(this.base)) this.base = regionHost(r.result.currentRegion);
        bizToken = r.result.bizToken;
        continue;
      }
      if (r.code !== 0 || !r.result?.token) throw new VeSyncError(`VeSync login failed: ${r.msg ?? `code ${r.code}`}`, r.code);
      this.token = r.result.token;
      this.accountId = String(r.result.accountID);
      if (r.result.countryCode) this.country = r.result.countryCode;
      return;
    }
    throw new VeSyncError('VeSync login failed: the region redirect repeated', CROSS_REGION);
  }

  /** An authenticated call. On an auth error, log in again and retry once. */
  private async call<T>(path: string, body: () => Record<string, unknown>): Promise<Envelope<T>> {
    if (!this.token) await this.login();
    let r = await this.post<T>(path, body(), true);
    if (r.code !== 0 && isAuthError(r.code, r.msg)) {
      this.token = '';
      await this.login();
      r = await this.post<T>(path, body(), true);
    }
    return r;
  }

  async devices(): Promise<VeSyncDevice[]> {
    const r = await this.call<{ list?: VeSyncDevice[] }>('/cloud/v1/deviceManaged/devices', () => ({ ...this.common('devices'), pageNo: '1', pageSize: '100' }));
    if (r.code !== 0) throw new VeSyncError(`VeSync device list failed: ${r.msg ?? `code ${r.code}`}`, r.code);
    return r.result?.list ?? [];
  }

  /** Relay one method call to a device through bypassV2. Returns the device's own result. */
  async bypass<T = Record<string, unknown>>(dev: VeSyncDevice, method: string, data: Record<string, unknown> = {}): Promise<T> {
    const r = await this.call<{ code?: number; msg?: string; result?: T }>('/cloud/v2/deviceManaged/bypassV2', () => ({
      ...this.common('bypassV2'), debugMode: false, deviceRegion: dev.deviceRegion ?? 'US',
      cid: dev.cid, configModule: dev.configModule ?? '',
      payload: { method, source: 'APP', data },
    }));
    const code = r.code !== 0 ? r.code : (r.result?.code ?? 0);
    const msg = r.code !== 0 ? r.msg : r.result?.msg;
    if (code !== 0) throw new VeSyncError(`VeSync ${method} failed: ${msg ?? `code ${code}`}`, code);
    return (r.result?.result ?? {}) as T;
  }

  getPurifierStatus(dev: VeSyncDevice) { return this.bypass<PurifierStatus>(dev, 'getPurifierStatus'); }
  setSwitch(dev: VeSyncDevice, on: boolean) { return this.bypass(dev, 'setSwitch', { enabled: on, id: 0 }); }
  setPurifierMode(dev: VeSyncDevice, mode: 'auto' | 'sleep') { return this.bypass(dev, 'setPurifierMode', { mode }); }
  /** Fan speed 1–3 (Core300S). Puts the purifier in manual mode. */
  setLevel(dev: VeSyncDevice, level: number) { return this.bypass(dev, 'setLevel', { id: 0, level: Math.max(1, Math.min(3, Math.round(level))), type: 'wind' }); }
  setDisplay(dev: VeSyncDevice, on: boolean) { return this.bypass(dev, 'setDisplay', { state: on }); }
}

export interface VeSyncOptions {
  email: string;
  password: string;
  region?: 'us' | 'eu';
  /** Keyed by the purifier's name in the VeSync app. Purifiers not listed go in room "unassigned". */
  devices?: Record<string, { room: string; id?: string }>;
  pollMs?: number;
  /** Override the API base URL (tests). */
  baseUrl?: string;
  timeoutMs?: number;
}

interface Purifier { id: string; dev: VeSyncDevice; level: number }

export class VeSyncAdapter implements Adapter {
  id = 'vesync';
  name = 'VeSync (Levoit)';
  icon = 'air_purifier';
  kind = 'Cloud' as const;
  private ctx?: AdapterContext;
  private client: VeSyncClient;
  private purifiers = new Map<string, Purifier>();
  private poller: NodeJS.Timeout | null = null;
  private error: string | null = null;
  private offline = new Set<string>();

  constructor(private opts: VeSyncOptions) {
    const base = opts.baseUrl ?? VESYNC_HOSTS[opts.region ?? 'us'];
    this.client = new VeSyncClient(base, opts.email, opts.password, opts.timeoutMs);
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.poll();
    const every = this.opts.pollMs ?? 30_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); }

  /** Refresh the device list (for online/offline and new purifiers), then each purifier's status. */
  async poll(): Promise<void> {
    const ctx = this.ctx!;
    let list: VeSyncDevice[];
    try {
      list = await this.client.devices();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      ctx.log(this.error);
      for (const p of this.purifiers.values()) ctx.report(p.id, { online: false });
      return;
    }
    for (const dev of list.filter(d => isCorePurifier(d.deviceType))) {
      let p = this.purifiers.get(dev.cid);
      if (!p) {
        const cfg = this.opts.devices?.[dev.deviceName];
        const id = cfg?.id ?? `vesync_${dev.cid.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        p = { id, dev, level: 1 };
        this.purifiers.set(dev.cid, p);
        ctx.announce([{ id, name: dev.deviceName, room: cfg?.room ?? 'unassigned', type: 'fan', integration: `Levoit ${dev.deviceType}`, address: dev.cid, capabilities: ['onoff', 'fanMode'] }]);
      } else p.dev = dev;
    }
    await Promise.all([...this.purifiers.values()].map(async p => {
      if (p.dev.connectionStatus && p.dev.connectionStatus !== 'online') {
        this.offline.add(p.id);
        ctx.report(p.id, { online: false });
        return;
      }
      try {
        const s = await this.client.getPurifierStatus(p.dev);
        if (s.level) p.level = s.level;
        this.offline.delete(p.id);
        ctx.report(p.id, statusToState(s));
      } catch (err) {
        this.offline.add(p.id);
        ctx.report(p.id, { online: false });
        if (!(err instanceof VeSyncError && isOfflineError(err.code, err.message))) ctx.log(`${p.dev.deviceName}: ${(err as Error).message}`);
      }
    }));
  }

  async command(d: Device, cmd: Command): Promise<void> {
    const p = this.purifiers.get(d.address);
    if (!p) throw new Error(`Unknown VeSync device ${d.id}`);
    if (cmd.on === false) { await this.client.setSwitch(p.dev, false); return; }
    if (cmd.on === true) await this.client.setSwitch(p.dev, true);
    if (cmd.mode != null) {
      const m = toVeSyncMode(cmd.mode);
      if (!m) throw new Error(`${d.name} has no "${cmd.mode}" mode (Auto, Sleep or Manual)`);
      // Manual is entered by setting a fan speed, as the app does.
      if (m === 'manual') await this.client.setLevel(p.dev, p.level);
      else await this.client.setPurifierMode(p.dev, m);
    }
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.purifiers.size;
    if (this.offline.size) return { ok: false, note: `${this.offline.size} of ${n} offline (cloud)` };
    return { ok: n > 0, note: `${n} purifier${n === 1 ? '' : 's'} · cloud` };
  }
}
