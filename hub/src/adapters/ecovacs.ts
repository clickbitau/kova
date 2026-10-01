import { constants, createHash, createPublicKey, publicEncrypt } from 'node:crypto';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState, VacuumActivity } from '../model/types.ts';

// Ecovacs DEEBOT robot vacuums (T-series and other "mqtt/json" bots) through
// the ECOVACS CLOUD. The bots have no local API: the app, and this adapter,
// talk to Ecovacs' servers, which relay commands to the bot over its own
// connection. So this adapter needs the internet and the Ecovacs account, and
// it stops working if Ecovacs changes the API.
//
// The request shapes follow the behaviour of the open-source deebot-client
// project (the library Home Assistant's ecovacs integration uses). Login is
// three separate steps, each isolated below so it's easy to fix against the
// real service:
//   1. user/login on gl-{country}-api.ecovacs.com   (signed GET, MD5 password) → uid + accessToken
//      (a new device id gets code 1013 instead: Ecovacs emails a code, and user/verifyDevice
//      with that code → uid + accessToken; the email is RSA-encrypted with Ecovacs' published key)
//   2. getAuthCode on gl-{country}-openapi.ecovacs.com (signed GET)           → authCode
//   3. loginByItToken on the IoT portal (users/user.do)                       → portal token
// Then the portal's appsvr/app.do lists devices and iot/devmanager.do relays
// JSON commands (clean_V2, charge, getCleanInfo_V2, getChargeState, getBattery).
// Legacy XMPP bots ("eco-legacy") aren't supported.

export const md5 = (s: string) => createHash('md5').update(s).digest('hex');

// Keys the Ecovacs global app signs requests with (public, shipped in the app; same values deebot-client uses).
const CLIENT = { key: '1520391301804', secret: '6c319b2a5cd3e66e39159c2e28f2fce9' };
const AUTH_CLIENT = { key: '1520391491841', secret: '77ef58ce3afbe337da74aa8c5ab963a9' };
// Ecovacs refuses old app versions ("Please update to the latest version"): keep this at what deebot-client sends.
const META = { lang: 'EN', appCode: 'global_e', appVersion: '3.14.0', channel: 'google_play', deviceType: '1' };
const PHONE = { model: 'Pixel 7', system: 'Android 14' };
const REALM = 'ecouser.net';

/**
 * Sign a request the way the Ecovacs app does: md5(key + sorted "k=v" pairs of
 * params and extra sign-only fields + secret). Returns the params plus authAppkey/authSign.
 */
export function signParams(params: Record<string, string>, signOnly: Record<string, string>, client: { key: string; secret: string }): Record<string, string> {
  const all: Record<string, string> = { ...params, ...signOnly };
  const text = client.key + Object.keys(all).sort().map(k => `${k}=${all[k]}`).join('') + client.secret;
  return { ...params, authAppkey: client.key, authSign: md5(text) };
}

// Ecovacs' own country → continent grouping for portal hosts. Anything not listed is "ww" (worldwide).
const CONTINENTS: Record<string, string> = {
  ...Object.fromEntries('at be bg ch cy cz de dk ee es fi fr gb gr hr hu ie is it li lt lu lv mt nl no pl pt ro se si sk uk'.split(' ').map(c => [c, 'eu'])),
  ...Object.fromEntries('us ca mx'.split(' ').map(c => [c, 'na'])),
  ...Object.fromEntries('jp kr tw hk sg my th id ph vn in ae sa il'.split(' ').map(c => [c, 'as'])),
};
export function continentFor(country: string): string { return CONTINENTS[country.toLowerCase()] ?? 'ww'; }

/** Ecovacs' hosts for an account's country (deebot-client's rule: portal-{continent}, plain portal in China). */
export function ecovacsUrls(country: string, continent = continentFor(country)) {
  const c = country.toLowerCase();
  const cn = c === 'cn';
  return {
    login: `https://gl-${c}-api.ecovacs.${cn ? 'cn' : 'com'}`,
    auth: `https://gl-${c}-openapi.ecovacs.${cn ? 'cn' : 'com'}`,
    // The old api-app.dc-{continent}.ww.ecouser.net names no longer resolve.
    portal: `https://portal${cn ? '' : `-${continent.toLowerCase()}`}.ecouser.net/api`,
  };
}

/** What getCleanInfo_V2 (and v1 getCleanInfo) return in body.data. */
export interface CleanInfo {
  trigger?: string;
  state?: string;
  cleanState?: { motionState?: string; content?: unknown; router?: string };
}

/** Kova activity from the bot's clean info and charge state (deebot-client's state mapping). */
export function toActivity(clean: CleanInfo | null, charging: boolean | null): VacuumActivity {
  if (clean?.trigger === 'alert') return 'error';
  if (clean?.state === 'clean') {
    const m = clean.cleanState?.motionState;
    if (m === 'pause') return 'paused';
    if (m === 'goCharging') return 'returning';
    return 'cleaning';
  }
  if (clean?.state === 'goCharging') return 'returning';
  if (charging) return 'docked';
  return 'idle';
}

export function activityToState(activity: VacuumActivity, battery?: number | null): DeviceState {
  const st: DeviceState = { on: activity === 'cleaning', activity, online: true };
  if (battery != null) st.battery = battery;
  return st;
}

/** The JSON command(s) for a Kova command, given what the bot is doing now. */
export function commandFor(cmd: Command, current: VacuumActivity | undefined): { name: string; data: Record<string, unknown> } | null {
  const want: VacuumActivity | undefined = cmd.activity ?? (cmd.on === true ? 'cleaning' : cmd.on === false ? 'returning' : undefined);
  switch (want) {
    case 'cleaning': return current === 'paused' ? { name: 'clean_V2', data: { act: 'resume' } } : { name: 'clean_V2', data: { act: 'start', content: { type: 'auto' } } };
    case 'returning': case 'docked': return { name: 'charge', data: { act: 'go' } };
    case 'paused': return { name: 'clean_V2', data: { act: 'pause' } };
    case 'idle': return { name: 'clean_V2', data: { act: 'stop' } };
    default: return null;
  }
}

/** One device from GetGlobalDeviceList. */
export interface EcovacsDevice {
  did: string;
  name?: string;
  class: string;
  resource: string;
  nick?: string;
  deviceName?: string;
  company?: string;
  status?: number;
  product_category?: string;
}

/** A JSON-protocol DEEBOT (not a legacy XMPP bot or a non-vacuum Ecovacs product). */
export function isJsonVacuum(d: EcovacsDevice): boolean {
  return d.company === 'eco-ng' && (!d.product_category || /deebot/i.test(d.product_category));
}

export class EcovacsError extends Error {
  constructor(message: string, public kind: 'auth' | 'credentials' | 'verify' | 'offline' | 'other' = 'other') { super(message); }
}

interface Session { uid: string; accessToken: string; userId: string; token: string; expiresAt: number }

/** Expiry of a JWT-shaped token in ms, if it has one. */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const exp = JSON.parse(Buffer.from(part, 'base64url').toString()).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch { return null; }
}

/** Portal error codes/messages meaning the token is no longer valid. */
export function isPortalAuthError(j: { errno?: unknown; error?: unknown; ret?: unknown; result?: unknown }): boolean {
  if (j.ret !== 'fail' && j.result !== 'fail') return false;
  return String(j.errno) === '3' || /auth|token/i.test(String(j.error ?? ''));
}

/** A logged-in Ecovacs account. Logs in again once when the portal rejects the token. */
export class EcovacsClient {
  private session: Session | null = null;
  /** The app's "device id": stable per account so Ecovacs sees one phone, not a new one each start. */
  readonly deviceId: string;
  /** The one-time code Ecovacs emailed to verify this device id (from the setup), if any. */
  verifyCode?: string;
  constructor(private urls: { login: string; auth: string; portal: string }, private email: string, private password: string, private country: string, private timeoutMs = 15_000) {
    this.deviceId = md5(`kova:${email}`);
  }

  get loggedIn() { return !!this.session; }
  get resource() { return this.deviceId.slice(0, 8); }

  private async get<T>(url: string, params: Record<string, string>): Promise<T> {
    const res = await fetch(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new EcovacsError(`Ecovacs HTTP ${res.status}`);
    return await res.json() as T;
  }

  private async post<T>(path: string, body: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
    const q = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetch(`${this.urls.portal}/${path}${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new EcovacsError(`Ecovacs HTTP ${res.status}`, 'auth');
    if (!res.ok) throw new EcovacsError(`Ecovacs HTTP ${res.status}`);
    return await res.json() as T;
  }

  /** A signed call to the account API (gl-{country}-api): user/login, user/verifyDevice, common/getConfig… */
  private async privateCall<T>(endpoint: string, params: Record<string, string>): Promise<{ code: string; msg?: string; data?: T }> {
    const c = this.country.toLowerCase();
    const path = `/v1/private/${c}/${META.lang}/${this.deviceId}/${META.appCode}/${META.appVersion}/${META.channel}/${META.deviceType}/${endpoint}`;
    const now = String(Date.now());
    const signed = signParams({ ...params, requestId: md5(now), authTimespan: now, authTimeZone: 'GMT-8' }, { ...META, country: c, deviceId: this.deviceId }, CLIENT);
    return this.get(`${this.urls.login}${path}`, signed);
  }

  private accountResult(r: { code: string; msg?: string; data?: { uid: string; accessToken: string } }, what: string) {
    if (r.code === '1005' || r.code === '1010') throw new EcovacsError('Ecovacs login failed: wrong email or password', 'credentials');
    if (r.code === '1013') throw new EcovacsError('Ecovacs wants to verify Kova by email', 'verify');
    if (r.code === '1012') throw new EcovacsError('That email code is wrong or expired', 'verify');
    if (r.code !== '0000' || !r.data?.accessToken) throw new EcovacsError(`Ecovacs ${what} failed: ${r.msg ?? `code ${r.code}`}`);
    return { uid: String(r.data.uid), accessToken: r.data.accessToken };
  }

  /** Step 1: account login → uid + accessToken. */
  async userLogin(): Promise<{ uid: string; accessToken: string }> {
    return this.accountResult(await this.privateCall('user/login', { account: this.email, password: md5(this.password) }), 'login');
  }

  /** The account email, encrypted with Ecovacs' published RSA key (PKCS#1 v1.5), as the verification calls want it. */
  async encryptAccount(): Promise<string> {
    const r = await this.privateCall<{ key?: string; value?: string }[]>('common/getConfig', { keys: 'PUBLIC.KEY.CONFIG' });
    const entry = Array.isArray(r.data) ? r.data.find(e => e?.key === 'PUBLIC.KEY.CONFIG') : undefined;
    let der: string | undefined;
    try { der = JSON.parse(String(entry?.value)).publicKey; } catch { /* below */ }
    if (r.code !== '0000' || typeof der !== 'string') throw new EcovacsError('Ecovacs didn’t give its public key');
    const key = createPublicKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'spki' });
    return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(this.email)).toString('base64');
  }

  /** Ask Ecovacs to email the one-time code that verifies this device id. */
  async requestVerifyCode(): Promise<void> {
    const r = await this.privateCall('user/sendEmailVerifyCode', { encryptEmail: await this.encryptAccount(), verifyType: 'EMAIL_VERIFY_DEVICE', supportChar: 'N', isForce: 'N' });
    if (r.code !== '0000') throw new EcovacsError(`Ecovacs couldn’t send the email code: ${r.msg ?? `code ${r.code}`}`);
  }

  /** Step 1, for a device id Ecovacs hasn't seen: the emailed code → uid + accessToken. */
  async verifyDevice(code: string): Promise<{ uid: string; accessToken: string }> {
    const r = await this.privateCall<{ uid: string; accessToken: string }>('user/verifyDevice', {
      encryptAccount: await this.encryptAccount(), backUpEmail: '', verifyCode: code.trim(), ...PHONE,
    });
    return this.accountResult(r, 'device verification');
  }

  /** Step 2: exchange the account token for an IoT auth code. */
  async getAuthCode(uid: string, accessToken: string): Promise<{ authCode: string; ecovacsUid: string }> {
    const params = signParams(
      { uid, accessToken, bizType: 'ECOVACS_IOT', deviceId: this.deviceId, authTimespan: String(Date.now()) },
      { openId: 'global' },
      AUTH_CLIENT,
    );
    const r = await this.get<{ code: string; msg?: string; data?: { authCode: string; ecovacsUid: string } }>(`${this.urls.auth}/v1/global/auth/getAuthCode`, params);
    if (r.code !== '0000' || !r.data?.authCode) throw new EcovacsError(`Ecovacs auth code failed: ${r.msg ?? `code ${r.code}`}`);
    return r.data;
  }

  /** Step 3: log in to the IoT portal with the auth code → portal token. */
  async loginByItToken(authCode: string, ecovacsUid: string): Promise<{ userId: string; token: string }> {
    const cn = this.country.toLowerCase() === 'cn';
    const r = await this.post<{ result?: string; userId?: string; token?: string; error?: string; errno?: unknown }>('users/user.do', {
      edition: 'ECOGLOBLE', userId: ecovacsUid, token: authCode, realm: REALM, resource: this.resource,
      org: cn ? 'ECOCN' : 'ECOWW', last: '', country: cn ? 'Chinese' : this.country.toUpperCase(), todo: 'loginByItToken',
    });
    if (r.result !== 'ok' || !r.token) throw new EcovacsError(`Ecovacs portal login failed: ${r.error ?? r.errno ?? 'no token'}`);
    return { userId: r.userId ?? ecovacsUid, token: r.token };
  }

  async login(): Promise<void> {
    this.session = null;
    let account: { uid: string; accessToken: string };
    try {
      account = await this.userLogin();
    } catch (err) {
      if (!(err instanceof EcovacsError) || err.kind !== 'verify') throw err;
      // A new device id: use the emailed code if the owner gave one, else ask Ecovacs to send one.
      if (this.verifyCode) {
        try { account = await this.verifyDevice(this.verifyCode); }
        catch (e) {
          if (!(e instanceof EcovacsError) || e.kind !== 'verify') throw e;
          this.verifyCode = undefined;
          await this.requestVerifyCode();
          throw new EcovacsError('That email code didn’t work, so Ecovacs sent a new one: enter it in the Ecovacs setup', 'verify');
        }
      } else {
        await this.requestVerifyCode();
        throw new EcovacsError('Ecovacs emailed you a code: enter it in the Ecovacs setup to finish signing in', 'verify');
      }
    }
    const { uid, accessToken } = account;
    const { authCode, ecovacsUid } = await this.getAuthCode(uid, accessToken);
    const { userId, token } = await this.loginByItToken(authCode, ecovacsUid);
    this.session = { uid, accessToken, userId, token, expiresAt: tokenExpiry(token) ?? Infinity };
  }

  private auth() {
    const s = this.session!;
    return { with: 'users', userid: s.userId, realm: REALM, token: s.token, resource: this.resource };
  }

  /** An authenticated portal call. On an auth error, log in again and retry once. */
  private async call<T extends Record<string, unknown>>(path: string, body: () => Record<string, unknown>, query?: () => Record<string, string>): Promise<T> {
    // Refresh a minute before a known expiry rather than waiting to be rejected.
    if (!this.session || this.session.expiresAt - 60_000 < Date.now()) await this.login();
    const once = async () => {
      try {
        const r = await this.post<T>(path, { ...body(), auth: this.auth() }, query?.());
        return isPortalAuthError(r) ? null : r;
      } catch (err) {
        if (err instanceof EcovacsError && err.kind === 'auth') return null;
        throw err;
      }
    };
    const r = await once();
    if (r) return r;
    await this.login();
    const again = await once();
    if (!again) throw new EcovacsError('Ecovacs rejected the new login', 'auth');
    return again;
  }

  async devices(): Promise<EcovacsDevice[]> {
    const r = await this.call<{ code?: number; devices?: EcovacsDevice[]; msg?: string }>('appsvr/app.do', () => ({ userid: this.session!.userId, todo: 'GetGlobalDeviceList' }));
    if (r.code !== 0) throw new EcovacsError(`Ecovacs device list failed: ${r.msg ?? `code ${r.code}`}`);
    return r.devices ?? [];
  }

  /** Send one JSON-protocol command to a bot through the portal. Returns the bot's body.data. */
  async command<T = Record<string, unknown>>(dev: EcovacsDevice, cmdName: string, data?: Record<string, unknown>): Promise<T> {
    type Resp = { ret?: string; errno?: unknown; error?: string; debug?: string; resp?: { body?: { code?: number; msg?: string; data?: T } } };
    const r = await this.call<Resp>('iot/devmanager.do', () => ({
      cmdName,
      payload: { header: { pri: '1', ts: String(Date.now()), tzm: 480, ver: '0.0.50' }, body: data ? { data } : {} },
      payloadType: 'j', td: 'q', toId: dev.did, toRes: dev.resource, toType: dev.class,
    }), () => ({ mid: dev.class, did: dev.did, td: 'q', u: this.session!.userId, cv: '1.67.3', t: 'a', av: '1.3.1' }));
    if (r.ret !== 'ok') {
      const why = String(r.error ?? r.debug ?? r.errno ?? 'failed');
      throw new EcovacsError(`Ecovacs ${cmdName}: ${why}`, /timeout|offline/i.test(why) ? 'offline' : 'other');
    }
    const body = r.resp?.body;
    if (body?.code != null && body.code !== 0) throw new EcovacsError(`Ecovacs ${cmdName}: ${body.msg ?? `code ${body.code}`}`);
    return (body?.data ?? {}) as T;
  }

  getCleanInfo(dev: EcovacsDevice) { return this.command<CleanInfo>(dev, 'getCleanInfo_V2'); }
  getChargeState(dev: EcovacsDevice) { return this.command<{ isCharging?: number }>(dev, 'getChargeState'); }
  getBattery(dev: EcovacsDevice) { return this.command<{ value?: number; isLow?: number }>(dev, 'getBattery'); }
}

export interface EcovacsOptions {
  email: string;
  password: string;
  /** Two-letter account country, e.g. "au". */
  country: string;
  /** Portal region (eu, na, as, ww); derived from the country when omitted. */
  continent?: string;
  /** Kova room per bot, keyed by its name in the Ecovacs app. Unlisted bots go in "unassigned". */
  rooms?: Record<string, string>;
  /** Kova device id per bot name. */
  ids?: Record<string, string>;
  pollMs?: number;
  /** Poll a bot this long after a command so its new activity shows quickly (0 = don't). */
  refreshMs?: number;
  /** Override the login/auth/portal base URLs (tests, or if Ecovacs moves them). */
  urls?: Partial<{ login: string; auth: string; portal: string }>;
  timeoutMs?: number;
  /** The one-time code Ecovacs emails the first time Kova signs in (it verifies Kova as a device). */
  verifyCode?: string;
}

interface Bot { id: string; dev: EcovacsDevice; activity?: VacuumActivity; offline: boolean }

export class EcovacsAdapter implements Adapter {
  id = 'ecovacs';
  name = 'Ecovacs';
  icon = 'cleaning_services';
  kind = 'Cloud' as const;
  private ctx?: AdapterContext;
  private client: EcovacsClient;
  private bots = new Map<string, Bot>();
  private poller: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private error: string | null = null;
  /** Wrong email/password: stop retrying (repeated failures can lock the account) until restart. */
  private badCredentials = false;
  /** Legacy bots already mentioned in the log. */
  private skipped = new Set<string>();

  constructor(private opts: EcovacsOptions) {
    const urls = { ...ecovacsUrls(opts.country, opts.continent), ...opts.urls };
    this.client = new EcovacsClient(urls, opts.email, opts.password, opts.country, opts.timeoutMs);
    if (opts.verifyCode?.trim()) this.client.verifyCode = opts.verifyCode.trim();
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.poll();
    const every = this.opts.pollMs ?? 60_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Refresh the device list (for new bots and online/offline), then each bot's status. */
  async poll(): Promise<void> {
    const ctx = this.ctx!;
    if (this.badCredentials) return;
    let list: EcovacsDevice[];
    try {
      list = await this.client.devices();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      if (err instanceof EcovacsError && err.kind === 'credentials') {
        this.badCredentials = true;
        this.error = 'Wrong Ecovacs email or password. Fix ecovacs.password in integrations.json and restart Kova.';
      }
      // Waiting for the emailed code: don't keep asking Ecovacs (each try would email another code).
      if (err instanceof EcovacsError && err.kind === 'verify') this.badCredentials = true;
      ctx.log(this.error);
      for (const b of this.bots.values()) ctx.report(b.id, { online: false });
      return;
    }
    for (const dev of list) {
      if (!isJsonVacuum(dev)) {
        if (dev.company === 'eco-legacy' && !this.skipped.has(dev.did) && this.skipped.add(dev.did)) ctx.log(`${dev.nick ?? dev.deviceName ?? dev.did}: older (XMPP) DEEBOT, not supported`);
        continue;
      }
      let b = this.bots.get(dev.did);
      const name = dev.nick || dev.deviceName || dev.name || dev.did;
      if (!b) {
        const id = this.opts.ids?.[name] ?? `ecovacs_${dev.did.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        b = { id, dev, offline: false };
        this.bots.set(dev.did, b);
        ctx.announce([{ id, name, room: this.opts.rooms?.[name] ?? 'unassigned', type: 'vacuum', integration: `Ecovacs ${dev.deviceName ?? 'DEEBOT'}`, address: dev.did, capabilities: ['onoff', 'vacuum', 'battery'] }]);
      } else b.dev = dev;
    }
    await Promise.all([...this.bots.values()].map(b => this.refresh(b)));
  }

  private async refresh(b: Bot): Promise<void> {
    const ctx = this.ctx!;
    if (b.dev.status === 0) { b.offline = true; ctx.report(b.id, { online: false }); return; }
    try {
      const [clean, charge, battery] = await Promise.all([
        this.client.getCleanInfo(b.dev),
        this.client.getChargeState(b.dev).catch(() => null),
        this.client.getBattery(b.dev).catch(() => null),
      ]);
      b.activity = toActivity(clean, charge ? !!charge.isCharging : null);
      b.offline = false;
      ctx.report(b.id, activityToState(b.activity, battery?.value));
    } catch (err) {
      b.offline = true;
      ctx.report(b.id, { online: false });
      if (!(err instanceof EcovacsError && err.kind === 'offline')) ctx.log(`${b.dev.nick ?? b.dev.did}: ${(err as Error).message}`);
    }
  }

  async command(d: Device, cmd: Command): Promise<void> {
    const b = this.bots.get(d.address);
    if (!b) throw new Error(`Unknown Ecovacs device ${d.id}`);
    const c = commandFor(cmd, b.activity ?? d.state.activity ?? undefined);
    if (!c) return;
    await this.client.command(b.dev, c.name, c.data);
    const next: VacuumActivity = c.name === 'charge' ? 'returning' : c.data.act === 'pause' ? 'paused' : c.data.act === 'stop' ? 'idle' : 'cleaning';
    b.activity = next;
    this.ctx!.report(d.id, { activity: next });
    const after = this.opts.refreshMs ?? 5_000;
    if (after > 0) {
      const t = setTimeout(() => { this.timers.delete(t); void this.refresh(b); }, after);
      t.unref();
      this.timers.add(t);
    }
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.bots.size;
    const off = [...this.bots.values()].filter(b => b.offline).length;
    if (off) return { ok: false, note: `${off} of ${n} offline (cloud)` };
    return { ok: n > 0, note: `${n} vacuum${n === 1 ? '' : 's'} · cloud` };
  }
}
