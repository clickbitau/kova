import { constants, createHash, createPublicKey, publicEncrypt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import { zstdDecompressSync } from 'node:zlib';
import type { CleanMode, Command, Device, DeviceState, RobotArea, RobotCommand, RobotMap, RobotPart, RobotSettings, RobotState, StationJob, StationState, Suction, VacuumActivity } from '../model/types.ts';

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
  // "washing": a clean that's back at the station washing its mop half way.
  if (clean?.state === 'clean' || clean?.state === 'washing') {
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
  private codeSentAt = 0;
  constructor(private urls: { login: string; auth: string; portal: string }, private email: string, private password: string, private country: string, private timeoutMs = 15_000, private storageDir?: string) {
    this.deviceId = md5(`kova:${email}`);
    this.load();
  }

  /** The file the session and the "code sent" time live in (<dataDir>/ecovacs/session.json). */
  private get file() { return this.storageDir ? join(this.storageDir, 'session.json') : undefined; }

  /** A session that still has time left is reused, so restarts don't log in again (or trigger another email). */
  private load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { session?: Session; codeSentAt?: number };
      this.codeSentAt = j.codeSentAt ?? 0;
      if (j.session && (j.session.expiresAt ?? Infinity) - 60_000 > Date.now()) this.session = { ...j.session, expiresAt: j.session.expiresAt ?? Infinity };
    } catch { /* first run, or the file is gone */ }
  }

  private save() {
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ session: this.session, codeSentAt: this.codeSentAt })); }
    catch { /* best effort */ }
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

  /** Ask Ecovacs to email the one-time code that verifies this device id. At most once per 15 min: each
   * send voids the last code, so every restart asking again floods the inbox and nothing is ever usable. */
  async requestVerifyCode(): Promise<void> {
    if (Date.now() - this.codeSentAt < 15 * 60_000) throw new EcovacsError('Ecovacs was asked for a code minutes ago — use the newest email and enter it in the Ecovacs setup', 'verify');
    const r = await this.privateCall('user/sendEmailVerifyCode', { encryptEmail: await this.encryptAccount(), verifyType: 'EMAIL_VERIFY_DEVICE', supportChar: 'N', isForce: 'N' });
    if (r.code !== '0000') throw new EcovacsError(`Ecovacs couldn’t send the email code: ${r.msg ?? `code ${r.code}`}`);
    this.codeSentAt = Date.now();
    this.save();
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
    this.save();
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

// ------------------------------------------------------------------ what a bot reports, as Kova's RobotState --

/** Ecovacs' suction levels. */
const SPEEDS: [number, Suction][] = [[1000, 'quiet'], [0, 'standard'], [1, 'max'], [2, 'max+']];
/** Ecovacs' work modes (what a clean does). */
const WORK_MODES: [number, CleanMode][] = [[0, 'both'], [1, 'vacuum'], [2, 'mop'], [3, 'mopAfter']];
/** Station jobs (stationAction type), and the station's own state by content type. */
const JOBS: Record<StationJob, number> = { empty: 1, dry: 2, wash: 4 };
const STATION_BY_TYPE: Record<number, StationState> = { 1: 'emptying', 2: 'drying', 3: 'washing', 4: 'washing' };
/** Parts that wear, as Ecovacs names them, asked for all at once (a bot answers for the ones it has; one it doesn't
 *  know fails the whole ask, so a failure is retried part by part, once, to learn which it has). */
export const PARTS: [string, string][] = [['brush', 'Main brush'], ['sideBrush', 'Side brushes'], ['heap', 'Filter'], ['roundMop', 'Mop pads'], ['dustBag', 'Dust bag'], ['unitCare', 'Sensors and contacts'], ['cleaningSolution', 'Cleaning solution'], ['lensBrush', 'Camera lens brush'], ['dModule', 'Air freshener'], ['uv', 'UV sanitiser'], ['blade', 'Blade'], ['sideBrushHub', 'Side brush hub']];
/** Station problems that only say an optional module isn't fitted: stations without it report them all the time. */
const OPTIONAL_MODULES = new Set([314, 315]);
/** What Ecovacs' error codes mean, in plain words (the common ones; others are shown by number). */
export const ERROR_WORDS: Record<number, string> = {
  101: 'Battery low', 102: 'Lifted off the floor', 103: 'A drive wheel is stuck', 104: 'The drop sensors are dusty', 105: 'Stuck',
  106: 'Side brushes worn out', 107: 'Filter worn out', 108: 'Side brushes tangled', 109: 'Main brush tangled', 110: 'Dust bin not in',
  111: 'Bumper stuck', 112: 'Laser sensor fault', 113: 'Main brush worn out', 114: 'Dust bin full', 116: 'Front sensor fault', 119: 'Fan fault',
  120: 'Water tank fault', 125: 'Water tank fault', 126: 'Water tank not in', 128: 'Mop pads not both fitted', 129: 'Mop pad tangled',
  204: 'A wheel is hanging', 209: '3D sensor fault', 301: 'Clean water tank empty', 302: 'Dirty water tank full', 303: 'Clean water tank not in',
  304: 'Dirty water tank not in', 305: 'Dirty water tank full', 306: 'Station sink filter not in', 307: 'Station fault', 310: 'Station lid open',
  311: 'Replace the dust bag', 312: 'Dust bag full', 317: 'Clean water tank can’t refill', 318: 'Dirty water tank full', 319: 'Cleaning solution low',
  322: 'Clean water tank empty or not in', 323: 'Dirty water tank full or not in', 1007: 'Mop blocked', 1052: 'Time to change the mop',
};
const problem = (code: number) => ({ code, text: ERROR_WORDS[code] ?? `Error ${code}` });

/** "22:0" (as the bot says it) → "22:00", and back. */
export const hhmm = (t: unknown) => { const [h, m] = String(t ?? '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null; };
const botTime = (t: string) => { const [h, m] = t.split(':').map(Number); return `${h}:${m}`; };

/** The station's state, and its problems (getStationState). */
export function stationOf(st: { state?: number; content?: { type?: number; motionState?: number; error?: number[] } } | null): { station: StationState | null; problems: number[] } {
  if (!st) return { station: null, problems: [] };
  const busy = st.state === 1 && st.content?.motionState === 1 ? STATION_BY_TYPE[st.content.type ?? 0] : undefined;
  return { station: busy ?? 'idle', problems: (st.content?.error ?? []).filter(c => !OPTIONAL_MODULES.has(c)) };
}

/** Parts' wear (getLifeSpan) → Kova parts, % left. */
export function partsOf(life: { type?: string; left?: number; total?: number }[] | null): RobotPart[] | undefined {
  if (!Array.isArray(life)) return undefined;
  return life.filter(p => p.type && typeof p.left === 'number' && typeof p.total === 'number' && p.total > 0).map(p => ({
    id: p.type!, name: PARTS.find(x => x[0] === p.type)?.[1] ?? p.type!,
    left: Math.max(0, Math.min(100, Math.round((p.left! / p.total!) * 100))), hoursLeft: Math.round(p.left! / 60),
  }));
}

/** Map areas (getMapSet_V2 type "ar", zstd-compressed JSON of [id, name, …] rows). */
export function areasOf(subsets: string | undefined): RobotArea[] | undefined {
  if (!subsets) return undefined;
  try {
    const rows = JSON.parse(zstdDecompressSync(Buffer.from(subsets, 'base64')).toString()) as string[][];
    return rows.filter(r => Array.isArray(r) && r[0] != null).map(r => ({ id: String(r[0]), name: String(r[1] ?? '').trim(), x: Number(r[5]), y: Number(r[6]) }))
      .sort((a, b) => Number(a.id) - Number(b.id)).map(({ id, name }) => ({ id, name }));
  } catch { return undefined; }
}

/** Ecovacs map units (mm) to map pixels: 50 mm each, y going down. */
const PX = 50;
const px = (n: number) => Math.round((n / PX) * 10) / 10;

/**
 * The map (getMapInfo_V2: zstd-compressed JSON of layers, each [type, "id;x,y[,flag];…" …]): the areas as shapes
 * (type 2), the walls (type 1, a point flagged 3-1-0 starts a new line: a doorway), and each area's middle.
 */
export function mapOf(info: string, areaCentres: Map<string, [number, number]>): RobotMap | null {
  let layers: string[][];
  try { layers = JSON.parse(zstdDecompressSync(Buffer.from(info, 'base64')).toString()); } catch { return null; }
  const pts = (spec: string) => spec.split(';').filter(Boolean);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const areas: RobotMap['areas'] = [];
  const walls: string[] = [];
  for (const layer of layers) {
    if (!Array.isArray(layer)) continue;
    const [type, ...entries] = layer;
    for (const e of entries) {
      const [id, ...ps] = pts(String(e));
      if (type === '2') {
        const xy = ps.map(p => p.split(',').map(Number)).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).map(([x, y]) => [px(x!), px(-y!)] as const);
        if (xy.length < 3) continue;
        xy.forEach(([x, y]) => see(x, y));
        const c = areaCentres.get(id!);
        const mid = c ? [px(c[0]), px(-c[1])] : [xy.reduce((a, p) => a + p[0], 0) / xy.length, xy.reduce((a, p) => a + p[1], 0) / xy.length];
        areas.push({ id: id!, path: `M${xy.map(([x, y]) => `${x} ${y}`).join('L')}Z`, x: Math.round(mid[0]! * 10) / 10, y: Math.round(mid[1]! * 10) / 10 });
      } else if (type === '1') {
        let d = '', first: string | null = null;
        for (const p of ps) {
          const [xs, ys, flag] = p.split(',');
          const x = px(Number(xs)), y = px(-Number(ys));
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          see(x, y);
          const move = !d || flag?.trim() === '3-1-0';
          d += `${move ? 'M' : 'L'}${x} ${y}`;
          if (!first) first = `${x} ${y}`;
        }
        // Back to the start, unless the outline began at a doorway.
        const firstFlag = ps[0]?.split(',')[2]?.trim();
        if (d && first && firstFlag !== '3-1-0') d += `L${first}`;
        if (d) walls.push(d);
      }
    }
  }
  if (!areas.length || !Number.isFinite(minX)) return null;
  const pad = 4;
  return { viewBox: [Math.floor(minX - pad), Math.floor(minY - pad), Math.ceil(maxX - minX + pad * 2), Math.ceil(maxY - minY + pad * 2)], areas: areas.sort((a, b) => Number(a.id) - Number(b.id)), walls: walls.join(''), dock: null };
}

/** Everything a bot's getters said → Kova's RobotState (only what it answered). */
export function robotOf(r: Partial<{
  speed: { speed?: number | string } | null; water: { amount?: number; customAmount?: number; enable?: number } | null;
  workMode: { mode?: number } | null; count: { count?: number } | null; station: ReturnType<typeof stationOf> | null;
  parts: RobotPart[]; areas: RobotArea[]; stats: { area?: number; time?: number } | null; totals: { area?: number; time?: number; count?: number } | null;
  errors: number[] | null; carpet: { enable?: number } | null; trueDetect: { enable?: number; level?: number } | null; childLock: { on?: number } | null;
  volume: { volume?: number; total?: number } | null; breakPoint: { enable?: number } | null; block: { enable?: number; start?: string; end?: string } | null;
  voiceAssistant: { enable?: number } | null; ota: { autoSwitch?: number; supportAuto?: number; ver?: string } | null; autoEmpty: { enable?: number } | null;
  drying: { duration?: number } | null; net: { rssi?: string | number } | null; map: boolean;
}>): RobotState {
  const out: RobotState = {};
  if (r.speed?.speed != null) out.suction = SPEEDS.find(([n]) => n === Number(r.speed!.speed))?.[1] ?? null;
  if (r.water) {
    if (r.water.customAmount != null) { out.water = r.water.customAmount; out.waterMax = 50; }
    else if (r.water.amount != null) { out.water = r.water.amount; out.waterMax = 4; }
    if (r.water.enable != null) out.mop = !!r.water.enable;
  }
  if (r.workMode?.mode != null) out.mode = WORK_MODES.find(([n]) => n === Number(r.workMode!.mode))?.[1] ?? null;
  if (r.count?.count != null) out.passes = r.count.count;
  if (r.station) { out.station = r.station.station; out.stationJobs = ['empty', 'wash', 'dry']; }
  if (r.parts) out.parts = r.parts;
  if (r.areas) out.areas = r.areas;
  if (r.stats && r.stats.area != null) out.last = { area: r.stats.area, minutes: Math.round((r.stats.time ?? 0) / 60) };
  if (r.totals && r.totals.area != null) out.totals = { area: r.totals.area, hours: Math.round((r.totals.time ?? 0) / 3600), count: r.totals.count ?? 0 };
  if (r.errors || r.station) out.problems = [...(r.errors ?? []).filter(c => c > 0 && c !== 100), ...(r.station?.problems ?? [])].map(problem);
  const set: RobotSettings = {};
  if (r.carpet?.enable != null) set.carpetBoost = !!r.carpet.enable;
  if (r.trueDetect?.enable != null) { set.obstacles = !!r.trueDetect.enable; if (r.trueDetect.level != null) out.obstacleLevel = r.trueDetect.level; }
  if (r.childLock?.on != null) set.childLock = !!r.childLock.on;
  if (r.volume?.volume != null) { set.voice = r.volume.volume; set.voiceMax = r.volume.total ?? 10; }
  if (r.breakPoint?.enable != null) set.resume = !!r.breakPoint.enable;
  if (r.block?.enable != null) set.quiet = { on: !!r.block.enable, start: hhmm(r.block.start) ?? '22:00', end: hhmm(r.block.end) ?? '08:00' };
  if (r.voiceAssistant?.enable != null) set.voiceAssistant = !!r.voiceAssistant.enable;
  if (r.ota?.supportAuto && r.ota.autoSwitch != null) set.autoUpdate = !!r.ota.autoSwitch;
  if (r.autoEmpty?.enable != null) set.autoEmpty = !!r.autoEmpty.enable;
  if (r.drying?.duration != null) set.dryMinutes = r.drying.duration;
  if (Object.keys(set).length) out.settings = set;
  if (r.ota?.ver) out.firmware = r.ota.ver;
  if (r.net?.rssi != null && Number.isFinite(Number(r.net.rssi))) out.wifi = Number(r.net.rssi);
  if (r.map) out.map = true;
  return out;
}

/** The bot commands for a robotSet, in the order to send them: how first (suction, mode…), then where (start). */
export function robotCommands(rs: RobotCommand, now: RobotState | null | undefined): { name: string; data: Record<string, unknown> }[] {
  const out: { name: string; data: Record<string, unknown> }[] = [];
  if (rs.suction) out.push({ name: 'setSpeed', data: { speed: SPEEDS.find(([, s]) => s === rs.suction)![0] } });
  if (rs.mode) out.push({ name: 'setWorkMode', data: { mode: WORK_MODES.find(([, m]) => m === rs.mode)![0] } });
  if (rs.water != null) {
    const max = now?.waterMax ?? 4;
    const n = Math.max(1, Math.min(max, rs.water));
    out.push({ name: 'setWaterInfo', data: max > 4 ? { customAmount: n } : { amount: n } });
  }
  if (rs.passes != null) out.push({ name: 'setCleanCount', data: { count: rs.passes } });
  const st = rs.settings ?? {};
  if (st.carpetBoost !== undefined) out.push({ name: 'setCarpertPressure', data: { enable: st.carpetBoost ? 1 : 0 } });
  // The T50 refuses it without the level ("format error"): the level it had, else 1.
  if (st.obstacles !== undefined) out.push({ name: 'setTrueDetect', data: { enable: st.obstacles ? 1 : 0, level: now?.obstacleLevel ?? 1 } });
  if (st.childLock !== undefined) out.push({ name: 'setChildLock', data: { on: st.childLock ? 1 : 0 } });
  if (st.voice !== undefined) out.push({ name: 'setVolume', data: { volume: Math.max(0, Math.min(now?.settings?.voiceMax ?? 10, st.voice)) } });
  if (st.resume !== undefined) out.push({ name: 'setBreakPoint', data: { enable: st.resume ? 1 : 0 } });
  if (st.quiet) out.push({ name: 'setBlock', data: { enable: st.quiet.on ? 1 : 0, start: botTime(st.quiet.start), end: botTime(st.quiet.end) } });
  if (st.voiceAssistant !== undefined) out.push({ name: 'setVoiceAssistantState', data: { enable: st.voiceAssistant ? 1 : 0 } });
  if (st.autoUpdate !== undefined) out.push({ name: 'setOta', data: { autoSwitch: st.autoUpdate ? 1 : 0 } });
  if (st.autoEmpty !== undefined) out.push({ name: 'setAutoEmpty', data: { enable: st.autoEmpty ? 1 : 0 } });
  if (st.dryMinutes !== undefined) out.push({ name: 'setDryingDuration', data: { duration: st.dryMinutes } });
  if (rs.resetPart) out.push({ name: 'resetLifeSpan', data: { type: rs.resetPart } });
  if (rs.station) out.push({ name: 'stationAction', data: { act: 1, type: JOBS[rs.station] } });
  if (rs.locate) out.push({ name: 'playSound', data: { count: 1, sid: 30 } });
  if (rs.areas?.length) out.push({ name: 'clean_V2', data: { act: 'start', content: { type: 'spotArea', value: rs.areas.join(',') } } });
  return out;
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
  /** Where the session survives restarts (integrations.ts gives <dataDir>/ecovacs). */
  storageDir?: string;
}

interface Bot {
  id: string; dev: EcovacsDevice; activity?: VacuumActivity; offline: boolean;
  /** Everything known of it beyond activity and battery, merged from the getters as they're asked. */
  robot: RobotState;
  polls: number;
  /** Ask for its settings on the next refresh (after a command, or something changed in the Ecovacs app). */
  dirty: boolean;
  /** Its map: the one in use and when it last changed, and the shapes drawn from it. */
  mapId?: string; mapAt?: number; map?: RobotMap | null;
  /** The worn parts it answers for (learned once when asking for all of them fails). */
  partTypes?: string[];
}

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
    this.client = new EcovacsClient(urls, opts.email, opts.password, opts.country, opts.timeoutMs, opts.storageDir);
    if (opts.verifyCode?.trim()) this.client.verifyCode = opts.verifyCode.trim();
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.poll();
    // Four or five API calls per bot per poll (more now and then for its settings, wear and map, see refresh) —
    // stretch the interval with the bot count so a day stays in the low thousands at any fleet size.
    const every = Math.max(this.opts.pollMs ?? 120_000, this.bots.size * 60_000);
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
        b = { id, dev, offline: false, robot: {}, polls: 0, dirty: true };
        this.loadMap(b);
        this.bots.set(dev.did, b);
        ctx.announce([{ id, name, room: this.opts.rooms?.[name] ?? 'unassigned', type: 'vacuum', integration: `Ecovacs ${dev.deviceName ?? 'DEEBOT'}`, address: dev.did, capabilities: ['onoff', 'vacuum', 'battery'] }]);
      } else b.dev = dev;
    }
    await Promise.all([...this.bots.values()].map(b => this.refresh(b)));
  }

  /**
   * Ask a bot what it's doing (every poll: activity, battery, the station, and the clean's progress while cleaning),
   * its settings (every 10th poll, or after a command), and its wear, totals and map (every 30th). Models differ in
   * what they answer: a getter one doesn't know just leaves that out.
   */
  private async refresh(b: Bot): Promise<void> {
    const ctx = this.ctx!, c = this.client, dev = b.dev;
    if (dev.status === 0) { b.offline = true; ctx.report(b.id, { online: false }); return; }
    const opt = <T,>(p: Promise<T>) => p.catch(() => null);
    try {
      const n = b.polls++;
      const settings = b.dirty || n % 10 === 0, slow = n % 30 === 0;
      b.dirty = false;
      const [clean, charge, battery, station] = await Promise.all([
        c.getCleanInfo(dev), opt(c.getChargeState(dev)), opt(c.getBattery(dev)),
        opt(c.command<Parameters<typeof stationOf>[0] & object>(dev, 'getStationState')),
      ]);
      b.activity = toActivity(clean, charge ? !!charge.isCharging : null);
      b.offline = false;
      const busy = b.activity === 'cleaning' || b.activity === 'paused' || b.activity === 'returning';
      const get = <T,>(name: string, data?: Record<string, unknown>) => opt(c.command<T>(dev, name, data));
      const [stats, errors] = await Promise.all([
        busy || slow ? get<{ area?: number; time?: number }>('getStats') : null,
        settings || b.activity === 'error' ? get<{ code?: number[] }>('getError') : null,
      ]);
      const more: Parameters<typeof robotOf>[0] = { station: stationOf(station), stats, errors: errors ? errors.code ?? [] : null };
      if (settings) {
        const [speed, water, workMode, count, carpet, trueDetect, childLock, volume, breakPoint, block, voiceAssistant, autoEmpty, drying] = await Promise.all([
          get<{ speed?: number }>('getSpeed'), get<{ amount?: number; customAmount?: number; enable?: number }>('getWaterInfo'), get<{ mode?: number }>('getWorkMode'),
          get<{ count?: number }>('getCleanCount'), get<{ enable?: number }>('getCarpertPressure'), get<{ enable?: number; level?: number }>('getTrueDetect'),
          get<{ on?: number }>('getChildLock'), get<{ volume?: number; total?: number }>('getVolume'), get<{ enable?: number }>('getBreakPoint'),
          get<{ enable?: number; start?: string; end?: string }>('getBlock'), get<{ enable?: number }>('getVoiceAssistantState'),
          get<{ enable?: number }>('getAutoEmpty'), get<{ duration?: number }>('getDryingDuration'),
        ]);
        Object.assign(more, { speed, water, workMode, count, carpet, trueDetect, childLock, volume, breakPoint, block, voiceAssistant, autoEmpty, drying });
      }
      if (slow) {
        const [life, totals, net, ota] = await Promise.all([this.parts(b), get<{ area?: number; time?: number; count?: number }>('getTotalStats'), get<{ rssi?: string }>('getNetInfo'), get<{ ver?: string; autoSwitch?: number; supportAuto?: number }>('getOta')]);
        Object.assign(more, { parts: partsOf(life), totals, net, ota });
        const areas = await this.areasAndMap(b);
        if (areas) more.areas = areas;
      }
      more.map = !!b.map;
      b.robot = { ...b.robot, ...robotOf(more) };
      const st = activityToState(b.activity, battery?.value);
      st.robot = b.robot;
      // Readings it used to show as extras (suction, mopping) are in `robot` now.
      (st as Record<string, unknown>).extras = null;
      ctx.report(b.id, st);
    } catch (err) {
      b.offline = true;
      ctx.report(b.id, { online: false });
      if (!(err instanceof EcovacsError && err.kind === 'offline')) ctx.log(`${dev.nick ?? dev.did}: ${(err as Error).message}`);
    }
  }

  /** Wear of every part the bot has: all asked at once; when that fails (a part it doesn't know), learned part by part. */
  private async parts(b: Bot): Promise<{ type?: string; left?: number; total?: number }[] | null> {
    type Life = { type?: string; left?: number; total?: number }[];
    const types = b.partTypes ?? PARTS.map(p => p[0]);
    try { return await this.client.command<Life>(b.dev, 'getLifeSpan', types as unknown as Record<string, unknown>); }
    catch {
      if (b.partTypes) return null;
      const found: Life = [];
      for (const t of types) {
        try { found.push(...await this.client.command<Life>(b.dev, 'getLifeSpan', [t] as unknown as Record<string, unknown>)); } catch { /* not this one */ }
      }
      b.partTypes = found.map(p => p.type!).filter(Boolean);
      return found.length ? found : null;
    }
  }

  /** The areas of the map in use, and the map itself when it changed (by its id and time) or isn't known yet. */
  private async areasAndMap(b: Bot): Promise<RobotArea[] | null> {
    type Cached = { info?: { mid?: string; using?: number; mts?: number }[] };
    const cached = await this.client.command<Cached>(b.dev, 'getCachedMapInfo').catch(() => null);
    const using = cached?.info?.find(m => m.using === 1 && m.mid && m.mid !== '0');
    if (!using?.mid) return null;
    const set = await this.client.command<{ subsets?: string }>(b.dev, 'getMapSet_V2', { mid: using.mid, type: 'ar' }).catch(() => null);
    const areas = areasOf(set?.subsets);
    if (!areas) return null;
    if (!b.map || b.mapId !== using.mid || b.mapAt !== using.mts) {
      const info = await this.client.command<{ info?: string }>(b.dev, 'getMapInfo_V2', { mid: using.mid, type: '0' }).catch(() => null);
      const centres = new Map<string, [number, number]>();
      try {
        for (const r of JSON.parse(zstdDecompressSync(Buffer.from(set!.subsets!, 'base64')).toString()) as string[][]) centres.set(String(r[0]), [Number(r[5]), Number(r[6])]);
      } catch { /* centres from the shapes */ }
      const map = info?.info ? mapOf(info.info, centres) : null;
      if (map) {
        const pos = await this.client.command<{ chargePos?: { x?: number; y?: number; invalid?: number }[] }>(b.dev, 'getPos', ['chargePos'] as unknown as Record<string, unknown>).catch(() => null);
        const dock = pos?.chargePos?.find(p => !p.invalid && p.x != null && p.y != null);
        if (dock) map.dock = { x: px(dock.x!), y: px(-dock.y!) };
        b.map = map; b.mapId = using.mid; b.mapAt = using.mts;
        this.saveMap(b);
      }
    }
    return areas;
  }

  private mapFile(b: Bot) { return this.opts.storageDir ? join(this.opts.storageDir, `map-${b.dev.did.replace(/[^\w-]/g, '')}.json`) : null; }
  private loadMap(b: Bot) {
    const f = this.mapFile(b);
    if (!f) return;
    try { const j = JSON.parse(readFileSync(f, 'utf8')); b.map = j.map; b.mapId = j.mapId; b.mapAt = j.mapAt; } catch { /* none yet */ }
  }
  private saveMap(b: Bot) {
    const f = this.mapFile(b);
    if (!f) return;
    try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify({ map: b.map, mapId: b.mapId, mapAt: b.mapAt })); } catch { /* best effort */ }
  }

  /** A bot's floor map, for the apps to show and pick areas on. */
  floorMap(d: Device): RobotMap | null {
    return this.bots.get(d.address)?.map ?? null;
  }

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    const b = this.bots.get(d.address);
    if (!b) throw new Error(`Unknown Ecovacs device ${d.id}`);
    const rs = cmd.robotSet;
    // How it cleans and its settings first, then what to do: clean some areas, or start, pause, dock.
    for (const c of rs ? robotCommands(rs, b.robot) : []) await this.client.command(b.dev, c.name, c.data);
    const c = rs?.areas?.length ? null : commandFor(cmd, b.activity ?? d.state.activity ?? undefined);
    if (c) await this.client.command(b.dev, c.name, c.data);
    const next: VacuumActivity | null = rs?.areas?.length ? 'cleaning' : !c ? null : c.name === 'charge' ? 'returning' : c.data.act === 'pause' ? 'paused' : c.data.act === 'stop' ? 'idle' : 'cleaning';
    if (rs) {
      // What it was told shows straight away; its settings are asked again on the refresh below.
      const r = { ...b.robot, settings: { ...b.robot.settings, ...rs.settings } };
      if (rs.suction) r.suction = rs.suction;
      if (rs.mode) r.mode = rs.mode;
      if (rs.water != null) r.water = Math.max(1, Math.min(b.robot.waterMax ?? 4, rs.water));
      if (rs.passes != null) r.passes = rs.passes;
      if (rs.station) r.station = rs.station === 'empty' ? 'emptying' : rs.station === 'wash' ? 'washing' : 'drying';
      if (rs.resetPart) r.parts = r.parts?.map(p => p.id === rs.resetPart ? { ...p, left: 100 } : p);
      b.robot = r;
      b.dirty = true;
    }
    if (next) b.activity = next;
    const after = this.opts.refreshMs ?? 5_000;
    if (after > 0) {
      const t = setTimeout(() => { this.timers.delete(t); void this.refresh(b); }, after);
      t.unref();
      this.timers.add(t);
    }
    // What it's doing now and how, as the one who asked did it (not "changed in another app").
    if (next || rs) return { ...(next ? { activity: next, on: next === 'cleaning' } : {}), ...(rs ? { robot: b.robot } : {}) };
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    const n = this.bots.size;
    const off = [...this.bots.values()].filter(b => b.offline).length;
    if (off) return { ok: false, note: `${off} of ${n} offline (cloud)` };
    return { ok: n > 0, note: `${n} vacuum${n === 1 ? '' : 's'} · cloud` };
  }
}
