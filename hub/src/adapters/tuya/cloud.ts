import { createHash, createHmac } from 'node:crypto';
import { lightFromSpec, switchesFromSpec, type TuyaDeviceConfig, type TuyaDpSpec, type TuyaLightDps, type TuyaOptions } from './index.ts';
import { discover, isSupportedVersion, type Discovered } from './discover.ts';

// Tuya IoT Platform OpenAPI: used once, to fetch each device's local key, name,
// category and data-point specification. Everyday control stays on the LAN.
// This is what tinytuya's wizard does; the endpoints and signing below follow it.
//
// Signing ("new sign", HMAC-SHA256):
//   stringToSign = METHOD \n sha256(body) \n <signed headers, none here> \n path?sorted-query
//   sign = HMAC_SHA256(secret, clientId + accessToken + t + nonce + stringToSign).hex().toUpperCase()
// with accessToken empty for the token request itself.

export const REGIONS: Record<string, string> = {
  eu: 'https://openapi.tuyaeu.com', // Central Europe (the Smart Life app in Europe, the Middle East, Africa, Oceania)
  'eu-w': 'https://openapi-weaz.tuyaeu.com', // Western Europe
  us: 'https://openapi.tuyaus.com', // Western America
  'us-e': 'https://openapi-ueaz.tuyaus.com', // Eastern America
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
  sg: 'https://openapi-sg.iotbing.com',
};

export interface TuyaCloudOptions {
  clientId: string;
  secret: string;
  /** eu, eu-w, us, us-e, cn, in, sg. Default eu. */
  region?: string;
  /** Overrides the region's URL (tests). */
  baseUrl?: string;
  /** Clock in ms (tests). */
  now?: () => number;
  /** Optional nonce per request; Tuya accepts none, as tinytuya sends. */
  nonce?: () => string;
}

export class TuyaCloudError extends Error {
  constructor(message: string, readonly code?: number | string) { super(message); }
}

/** Query string with keys in alphabetical order, which Tuya's signature requires. */
export function sortedQuery(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const parts = Object.keys(q).filter(k => q[k] !== undefined).sort().map(k => `${k}=${q[k]}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The request signature. `url` is the path plus the sorted query, e.g. "/v1.0/token?grant_type=1". */
export function signRequest(p: { clientId: string; secret: string; accessToken?: string; t: string; nonce?: string; method: string; url: string; body?: string }): string {
  const stringToSign = [p.method.toUpperCase(), sha256Hex(p.body ?? ''), '', p.url].join('\n');
  return createHmac('sha256', p.secret).update(p.clientId + (p.accessToken ?? '') + p.t + (p.nonce ?? '') + stringToSign).digest('hex').toUpperCase();
}

/** A device as the cloud lists it. `ip` is usually the home's public IP, not the LAN address. */
export interface TuyaCloudDevice {
  id: string;
  name: string;
  key?: string;
  ip?: string;
  category?: string;
  product?: string;
  productId?: string;
  online?: boolean;
  uid?: string;
  /** A sub-device behind a gateway (Zigbee, BLE mesh): reached through the gateway, not on its own. */
  sub?: boolean;
  /** A sub-device's node id on its gateway (`cid`), and which gateway. */
  nodeId?: string;
  gatewayId?: string;
}

interface RawDevice { id?: string; name?: string; local_key?: string; ip?: string; category?: string; product_name?: string; product_id?: string; online?: boolean; is_online?: boolean; uid?: string; sub?: boolean; node_id?: string; gateway_id?: string }

export const toDevice = (r: RawDevice): TuyaCloudDevice => ({
  id: String(r.id),
  name: (r.name ?? '').trim() || String(r.id),
  ...(r.local_key ? { key: r.local_key } : {}),
  ...(r.ip ? { ip: r.ip } : {}),
  ...(r.category ? { category: r.category } : {}),
  ...(r.product_name ? { product: r.product_name } : {}),
  ...(r.product_id ? { productId: r.product_id } : {}),
  ...(r.online ?? r.is_online) !== undefined ? { online: !!(r.online ?? r.is_online) } : {},
  ...(r.uid ? { uid: r.uid } : {}),
  ...(r.sub || r.node_id || (r.gateway_id && r.gateway_id !== r.id) ? { sub: true } : {}),
  ...(r.node_id ? { nodeId: String(r.node_id) } : {}),
  ...(r.gateway_id && r.gateway_id !== r.id ? { gatewayId: String(r.gateway_id) } : {}),
});

export class TuyaCloud {
  private base: string;
  private token: { value: string; expires: number } | null = null;
  constructor(private o: TuyaCloudOptions) {
    const region = (o.region ?? 'eu').toLowerCase();
    const base = o.baseUrl ?? REGIONS[region];
    if (!base) throw new Error(`Unknown Tuya region "${o.region}" (use ${Object.keys(REGIONS).join(', ')})`);
    this.base = base.replace(/\/$/, '');
  }

  private now() { return this.o.now?.() ?? Date.now(); }

  private async raw<T>(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown, accessToken?: string): Promise<T> {
    const url = path + sortedQuery(query);
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const t = String(this.now());
    const nonce = this.o.nonce?.() ?? '';
    const headers: Record<string, string> = {
      client_id: this.o.clientId,
      sign: signRequest({ clientId: this.o.clientId, secret: this.o.secret, accessToken, t, nonce, method, url, body: bodyText }),
      t,
      sign_method: 'HMAC-SHA256',
    };
    if (nonce) headers.nonce = nonce;
    if (accessToken) headers.access_token = accessToken;
    if (bodyText) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + url, { method, headers, body: bodyText || undefined, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let j: { success?: boolean; result?: T; code?: number | string; msg?: string };
    try { j = JSON.parse(text); } catch { throw new TuyaCloudError(`Tuya cloud: HTTP ${res.status} ${text.slice(0, 120)}`); }
    if (!j.success) throw new TuyaCloudError(`Tuya cloud ${path}: ${j.msg ?? 'failed'}${j.code != null ? ` (code ${j.code})` : ''}`, j.code);
    return j.result as T;
  }

  /** GET /v1.0/token?grant_type=1 ("simple mode"). Cached until shortly before it expires. */
  async getToken(): Promise<string> {
    if (this.token && this.token.expires > this.now()) return this.token.value;
    const r = await this.raw<{ access_token: string; expire_time?: number }>('GET', '/v1.0/token', { grant_type: 1 });
    if (!r?.access_token) throw new TuyaCloudError('Tuya cloud: no access token in the reply');
    this.token = { value: r.access_token, expires: this.now() + Math.max(60, (r.expire_time ?? 7200) - 60) * 1000 };
    return r.access_token;
  }

  /** A signed call with the access token. Fetches a fresh token once if the cloud says it's invalid. */
  async request<T>(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, path, query, body, await this.getToken());
    } catch (e) {
      if (e instanceof TuyaCloudError && [1010, 1011, '1010', '1011'].includes(e.code as number)) {
        this.token = null;
        return this.raw<T>(method, path, query, body, await this.getToken());
      }
      throw e;
    }
  }

  /** Every device of every app account linked to the cloud project. GET /v1.0/iot-01/associated-users/devices. */
  async listAssociatedDevices(): Promise<TuyaCloudDevice[]> {
    const out: TuyaCloudDevice[] = [];
    let lastRowKey: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ devices?: RawDevice[]; has_more?: boolean; last_row_key?: string }>('GET', '/v1.0/iot-01/associated-users/devices', { size: 50, last_row_key: lastRowKey });
      out.push(...(r.devices ?? []).map(toDevice));
      if (!r.has_more || !r.last_row_key || r.last_row_key === lastRowKey) break;
      lastRowKey = r.last_row_key;
    }
    return out;
  }

  /** One app user's devices (older API). GET /v1.0/users/{uid}/devices. */
  async listUserDevices(uid: string): Promise<TuyaCloudDevice[]> {
    const r = await this.request<RawDevice[] | { devices?: RawDevice[] }>('GET', `/v1.0/users/${encodeURIComponent(uid)}/devices`);
    return (Array.isArray(r) ? r : r.devices ?? []).map(toDevice);
  }

  /** One app user's devices (newer API). GET /v1.3/iot-03/devices?source_type=tuyaUser&source_id={uid}. */
  async listIot03Devices(uid: string): Promise<TuyaCloudDevice[]> {
    const out: TuyaCloudDevice[] = [];
    let lastRowKey: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ list?: RawDevice[]; has_more?: boolean; last_row_key?: string }>('GET', '/v1.3/iot-03/devices', { page_size: 75, source_type: 'tuyaUser', source_id: uid, last_row_key: lastRowKey });
      out.push(...(r.list ?? []).map(toDevice));
      if (!r.has_more || !r.last_row_key || r.last_row_key === lastRowKey) break;
      lastRowKey = r.last_row_key;
    }
    return out;
  }

  /**
   * The devices, with local keys. Without a uid: all linked app accounts; any device that came
   * back without its key is looked up again per user (as tinytuya does). With a uid: that user's
   * devices, trying the v1.0 and then the v1.3 endpoint.
   */
  async listDevices(uid?: string): Promise<TuyaCloudDevice[]> {
    if (uid) {
      try { return await this.listUserDevices(uid); } catch (e1) {
        try { return await this.listIot03Devices(uid); } catch (e2) {
          throw new TuyaCloudError(`Couldn't list devices for user ${uid}: ${(e1 as Error).message}; ${(e2 as Error).message}`);
        }
      }
    }
    let devices: TuyaCloudDevice[];
    try { devices = await this.listAssociatedDevices(); } catch (e) {
      throw new TuyaCloudError(`${(e as Error).message}. Check that the Smart Life / Tuya app account is linked to the cloud project (Devices → Link App Account), the project's data center matches --region, and the IoT Core API is subscribed; or pass the app account's uid.`, (e as TuyaCloudError).code);
    }
    const missing = [...new Set(devices.filter(d => !d.key && d.uid).map(d => d.uid!))];
    for (const u of missing) {
      const more = await this.listIot03Devices(u).catch(() => this.listUserDevices(u)).catch(() => []);
      for (const m of more) {
        const d = devices.find(x => x.id === m.id);
        if (d) { for (const [k, v] of Object.entries(m)) if ((d as unknown as Record<string, unknown>)[k] == null) (d as unknown as Record<string, unknown>)[k] = v; }
        else devices.push(m);
      }
    }
    return devices;
  }

  /**
   * A device's data points: code, DP number (when the endpoint gives it), type and value range.
   * Tries /v1.1/devices/{id}/specifications (has dp_id), then /v1.0/devices/{id}/specifications,
   * then /v1.0/iot-03/devices/{id}/specification.
   */
  async specification(id: string): Promise<TuyaDpSpec[]> {
    const paths = [`/v1.1/devices/${id}/specifications`, `/v1.0/devices/${id}/specifications`, `/v1.0/iot-03/devices/${id}/specification`];
    let last: unknown;
    for (const p of paths) {
      try {
        const r = await this.request<{ functions?: RawSpec[]; status?: RawSpec[] }>('GET', p);
        return parseSpec(r);
      } catch (e) { last = e; }
    }
    throw last;
  }
}

interface RawSpec { code?: string; dp_id?: number | string; type?: string; values?: string | Record<string, unknown> }

/** Merge a specification's `status` and `functions` into one list, by code. */
export function parseSpec(r: { functions?: RawSpec[]; status?: RawSpec[] }): TuyaDpSpec[] {
  const out = new Map<string, TuyaDpSpec>();
  for (const s of [...(r.status ?? []), ...(r.functions ?? [])]) {
    if (!s.code) continue;
    const prev = out.get(s.code);
    let values: Record<string, unknown> | undefined;
    if (typeof s.values === 'string') { try { const v = JSON.parse(s.values); if (v && typeof v === 'object') values = v; } catch { /* not JSON */ } }
    else if (s.values && typeof s.values === 'object') values = s.values;
    const dp = s.dp_id != null && s.dp_id !== '' && Number.isFinite(Number(s.dp_id)) ? Number(s.dp_id) : undefined;
    out.set(s.code, { code: s.code, ...(dp ?? prev?.dp) != null ? { dp: dp ?? prev?.dp } : {}, ...(s.type ?? prev?.type) ? { type: s.type ?? prev?.type } : {}, ...(values ?? prev?.values) ? { values: values ?? prev?.values } : {} });
  }
  return [...out.values()];
}

// ------------------------------------------------------------- merge --

export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** LAN addresses only: the cloud's `ip` is normally the home's public address, which is useless locally. */
export function isPrivateIp(ip?: string): boolean {
  if (!ip) return false;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'xdd', 'fwd', 'dc', 'fsd', 'tyndj', 'gyd', 'sxd']);
const PLUG_CATEGORIES = new Set(['cz', 'pc']);
/** Tuya's standard v2 light, for a light whose specification couldn't be fetched. */
const DEFAULT_V2_LIGHT: TuyaLightDps = { switch: '20', mode: '21', bri: '22', briMin: 10, briMax: 1000, temp: '23', tempMin: 0, tempMax: 1000, colour: '24', colourFormat: 'hsv16', colourMax: 1000 };

export interface Room { id: string; name: string }
export interface CloudDeviceWithSpec extends TuyaCloudDevice { spec?: TuyaDpSpec[] }

/** What the import did with one cloud device. Never includes the key. */
export interface ImportedDevice {
  id: string;
  name: string;
  category?: string;
  product?: string;
  online?: boolean;
  hasKey: boolean;
  host?: string;
  version?: string;
  status: 'added' | 'updated' | 'skipped';
  /** e.g. "light (brightness, warmth, colour)" or "2 switches". */
  as?: string;
  note?: string;
}

function roomFor(name: string, rooms: Room[]): string {
  const n = slug(name);
  const hit = [...rooms].sort((a, b) => b.name.length - a.name.length).find(r => n.includes(slug(r.name)) || n.includes(r.id));
  return hit?.id ?? 'unassigned';
}

function describe(d: TuyaDeviceConfig): string | undefined {
  if (!d.light && !d.switches && !d.gateway) return 'gateway';
  if (d.light) {
    const f = [d.light.bri && 'brightness', d.light.temp && 'warmth', d.light.colour && 'colour'].filter(Boolean);
    return `light${f.length ? ` (${f.join(', ')})` : ''}`;
  }
  const n = Object.keys(d.switches ?? {}).length;
  return n ? `${n} switch${n === 1 ? '' : 'es'}` : undefined;
}

/**
 * Fold cloud devices into the Tuya config. Existing devices keep their host (unless discovery
 * found a new one), version, switch names, rooms and Kova ids; their key is refreshed, and a
 * light's data-point mapping is refreshed from the spec. New devices get a room guessed from their
 * name and a mapping from their spec. A gateway's sub-devices (Zigbee lights…) are added with
 * the gateway and their node id, and the gateway itself as a connection; unsupported categories are skipped.
 */
export function mergeCloudDevices(existing: TuyaOptions | undefined, cloud: CloudDeviceWithSpec[], opts: { rooms?: Room[]; found?: Map<string, Discovered> } = {}): { tuya: TuyaOptions; devices: ImportedDevice[] } {
  const tuya: TuyaOptions = { ...existing, devices: (existing?.devices ?? []).map(d => structuredClone(d)) };
  const rooms = opts.rooms ?? [];
  const found = opts.found ?? new Map<string, Discovered>();
  const report: ImportedDevice[] = [];
  const usedIds = new Set<string>(tuya.devices.flatMap(d => [...Object.values(d.switches ?? {}).map(s => s.id), d.light?.id]).filter((x): x is string => !!x));
  const uniqueId = (base: string) => { let id = base, n = 2; while (usedIds.has(id)) id = `${base}_${n++}`; usedIds.add(id); return id; };
  const kovaId = (name: string, room: string) => uniqueId(room === 'unassigned' ? `tuya_${slug(name)}` : `${room}_${slug(name).replace(new RegExp(`^${room}_`), '') || 'light'}`);

  // Gateways that something in this account sits behind: kept as connections even with no switches of their own.
  const gateways = new Set(cloud.filter(c => c.sub && c.gatewayId).map(c => c.gatewayId!));

  for (const c of cloud) {
    const base = { id: c.id, name: c.name, category: c.category, product: c.product, online: c.online, hasKey: !!c.key };
    if (c.sub) {
      if (!c.gatewayId || !c.nodeId) { report.push({ ...base, status: 'skipped', note: 'behind a gateway, but the cloud gave no gateway or node id' }); continue; }
      const notes: string[] = [];
      const e = tuya.devices.find(d => d.id === c.id);
      if (e) {
        e.gateway = c.gatewayId; e.cid = c.nodeId;
        if (c.key) e.key = c.key;
        if (!e.light && !Object.keys(e.switches ?? {}).length) Object.assign(e, mapNew(c, c.spec ?? [], rooms, kovaId, notes));
        report.push({ ...base, status: 'updated', as: describe(e), note: [`through gateway ${c.gatewayId}`, ...notes].join('; ') });
        continue;
      }
      const mapped = mapNew(c, c.spec ?? [], rooms, kovaId, notes);
      if (!mapped.light && !mapped.switches) { report.push({ ...base, status: 'skipped', note: `category ${c.category ?? '?'} isn't supported yet` }); continue; }
      const d: TuyaDeviceConfig = { id: c.id, host: '', key: c.key ?? '', gateway: c.gatewayId, cid: c.nodeId, name: c.name, ...(c.category ? { category: c.category } : {}), ...(c.product ? { product: c.product } : {}), ...mapped };
      tuya.devices.push(d);
      report.push({ ...base, status: 'added', as: describe(d), note: [`through gateway ${c.gatewayId}`, ...notes].join('; ') });
      continue;
    }
    const disc = found.get(c.id);
    const host = disc?.ip ?? (isPrivateIp(c.ip) ? c.ip! : '');
    const discVersion = isSupportedVersion(disc?.version) ? disc!.version as TuyaDeviceConfig['version'] : undefined;
    const spec = c.spec ?? [];
    const notes: string[] = [];
    if (disc?.version && !discVersion) notes.push(`protocol ${disc.version} isn't supported`);

    const e = tuya.devices.find(d => d.id === c.id);
    if (e) {
      if (c.key) e.key = c.key;
      if (host && e.host !== host) { if (e.host) notes.push(`IP changed from ${e.host}`); e.host = host; }
      if (discVersion && e.version !== discVersion) e.version = discVersion;
      e.name ??= c.name;
      if (c.category) e.category = c.category;
      if (c.product) e.product = c.product;
      const light = spec.length ? lightFromSpec(spec) : null;
      if (e.light && light) e.light = { ...light, name: e.light.name, room: e.light.room, ...(e.light.id ? { id: e.light.id } : {}), ...(e.light.kMin ? { kMin: e.light.kMin } : {}), ...(e.light.kMax ? { kMax: e.light.kMax } : {}) };
      if (!e.light && !Object.keys(e.switches ?? {}).length) Object.assign(e, mapNew(c, spec, rooms, kovaId, notes));
      report.push({ ...base, status: 'updated', host: e.host || undefined, version: e.version ?? '3.3', as: describe(e), ...(notes.length ? { note: notes.join('; ') } : {}) });
      continue;
    }
    if (!c.key) { report.push({ ...base, status: 'skipped', note: 'the cloud gave no local key' }); continue; }
    const mapped = mapNew(c, spec, rooms, kovaId, notes);
    if (!mapped.light && !mapped.switches && gateways.has(c.id)) {
      // A gateway: a connection for the devices behind it.
      if (!host) notes.push('IP not known: run discovery on the home network, or set "host"');
      const d: TuyaDeviceConfig = { id: c.id, host, key: c.key, version: discVersion ?? '3.3', name: c.name, ...(c.category ? { category: c.category } : {}), ...(c.product ? { product: c.product } : {}) };
      tuya.devices.push(d);
      report.push({ ...base, status: 'added', host: host || undefined, version: d.version, as: 'gateway', ...(notes.length ? { note: notes.join('; ') } : {}) });
      continue;
    }
    if (!mapped.light && !mapped.switches) {
      report.push({ ...base, status: 'skipped', note: `category ${c.category ?? '?'} isn't supported yet` });
      continue;
    }
    if (!host) notes.push('IP not known: run discovery on the home network, or set "host"');
    if (!discVersion) notes.push('protocol version assumed 3.3');
    const d: TuyaDeviceConfig = { id: c.id, host, key: c.key, version: discVersion ?? '3.3', name: c.name, ...(c.category ? { category: c.category } : {}), ...(c.product ? { product: c.product } : {}), ...mapped };
    tuya.devices.push(d);
    report.push({ ...base, status: 'added', host: host || undefined, version: d.version, as: describe(d), ...(notes.length ? { note: notes.join('; ') } : {}) });
  }
  return { tuya, devices: report };
}

function mapNew(c: TuyaCloudDevice, spec: TuyaDpSpec[], rooms: Room[], kovaId: (name: string, room: string) => string, notes: string[]): Pick<TuyaDeviceConfig, 'light' | 'switches'> {
  const room = roomFor(c.name, rooms);
  let light = spec.length ? lightFromSpec(spec) : null;
  if (!light && !spec.length && LIGHT_CATEGORIES.has(c.category ?? '')) { light = { ...DEFAULT_V2_LIGHT }; notes.push('no specification: assumed the standard v2 light data points (20–24)'); }
  const channels = switchesFromSpec(spec);
  if (light && (LIGHT_CATEGORIES.has(c.category ?? '') || !channels.length)) return { light: { ...light, name: c.name, room, id: kovaId(c.name, room) } };
  let dps = channels;
  if (!dps.length && !spec.length && (c.category === 'kg' || PLUG_CATEGORIES.has(c.category ?? ''))) { dps = ['1']; notes.push('no specification: assumed one switch on DP 1'); }
  if (!dps.length) return {};
  const type = PLUG_CATEGORIES.has(c.category ?? '') ? 'plug' as const : 'light' as const;
  const switches: NonNullable<TuyaDeviceConfig['switches']> = {};
  for (const dp of dps) {
    const name = dps.length === 1 ? c.name : `${c.name} ${dp}`;
    switches[dp] = { name, room, type, id: kovaId(name, room) };
  }
  return { switches };
}

// ------------------------------------------------------------ import --

export interface CloudImportOptions extends TuyaCloudOptions {
  /** A linked app user's uid; without it, every linked account's devices. */
  uid?: string;
  existing?: TuyaOptions;
  rooms?: Room[];
  /** Listen for LAN broadcasts this long to find IPs the config doesn't have. 0 = don't. Default 6000. */
  discoverMs?: number;
  discoverPorts?: number[];
  log?: (line: string) => void;
}

/** Fetch devices (+ specs) from the cloud, find missing IPs on the LAN, and merge into the Tuya config. */
export async function importFromCloud(o: CloudImportOptions): Promise<{ tuya: TuyaOptions; devices: ImportedDevice[] }> {
  const cloud = new TuyaCloud(o);
  const list: CloudDeviceWithSpec[] = await cloud.listDevices(o.uid);
  for (const d of list) {
    try { d.spec = await cloud.specification(d.id); } catch (e) { o.log?.(`${d.name}: no specification (${(e as Error).message})`); }
  }
  const known = new Map((o.existing?.devices ?? []).map(d => [d.id, d.host]));
  const needIp = list.filter(d => !d.sub && !known.get(d.id) && !isPrivateIp(d.ip)).map(d => d.id);
  let found = new Map<string, Discovered>();
  const ms = o.discoverMs ?? 6000;
  if (ms > 0 && list.length) {
    o.log?.(`Listening ${Math.round(ms / 1000)} s for Tuya devices on the network…`);
    found = await discover({ durationMs: ms, ports: o.discoverPorts, want: needIp.length ? list.filter(d => !d.sub).map(d => d.id) : undefined, onError: (p, e) => o.log?.(`Discovery on UDP ${p}: ${e.message}`) });
  }
  return mergeCloudDevices(o.existing, list, { rooms: o.rooms, found });
}
