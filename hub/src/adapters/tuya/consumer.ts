import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID } from 'node:crypto';
import { toDevice, parseSpec, type CloudDeviceWithSpec, type Room, type TuyaCloudDevice } from './cloud.ts';
import type { TuyaDpSpec, TuyaOptions } from './index.ts';

// The Smart Life app's own sharing API — the one the Home Assistant integration uses. A phone scans a QR
// Kova shows; Tuya hands back a session; the session lists every device in the home *with its local key*.
// Every request is AES-128-GCM encrypted and HMAC-SHA256 signed (recipe: tuya_sharing's customerapi.py).

export const LINK_BASE = 'https://apigw.iotbing.com';
/** The shared "Home Assistant" app id Smart Life already trusts — Kova links the same way HA does. */
export const LINK_CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
const LINK_SCHEMA = 'haauthorize';

export interface ConsumerSession {
  /** The account's API endpoint, e.g. https://apigw.tuyaeu.com — from the scan reply. */
  endpoint: string;
  /** The account's user code (Smart Life → Me → Settings → Account and Security → User Code). */
  userCode: string;
  uid: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token dies (ms epoch). */
  expiresAt: number;
}

interface RawToken {
  t?: number;
  uid?: string;
  expire_time?: number;
  access_token?: string;
  refresh_token?: string;
  endpoint?: string;
}

const toSession = (t: RawToken, userCode: string): ConsumerSession => ({
  endpoint: String(t.endpoint ?? ''),
  userCode,
  uid: String(t.uid ?? ''),
  accessToken: String(t.access_token ?? ''),
  refreshToken: String(t.refresh_token ?? ''),
  expiresAt: (t.t ?? Date.now()) + (t.expire_time ?? 7200) * 1000,
});

export class TuyaLinkError extends Error { constructor(message: string, readonly code?: number | string) { super(message); } }

async function linkCall<T>(path: string, method: 'GET' | 'POST', base = LINK_BASE): Promise<T> {
  const res = await fetch(base + path, { method, signal: AbortSignal.timeout(15_000) });
  const j = await res.json().catch(() => null) as { success?: boolean; code?: string; msg?: string; result?: T; t?: number } | null;
  if (!j) throw new TuyaLinkError(`Tuya link: HTTP ${res.status}`);
  if (!j.success) throw new TuyaLinkError(`Tuya link: ${j.msg ?? 'failed'}`, j.code);
  return (j.result ?? {}) as T & { t?: number } | T;
}

/** Step one: the QR payload the Smart Life app scans. ~5 minutes to live. */
export async function qrStart(userCode: string, clientId = LINK_CLIENT_ID, base = LINK_BASE): Promise<string> {
  const r = await linkCall<{ qrcode?: string }>(`/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${clientId}&usercode=${encodeURIComponent(userCode)}&schema=${LINK_SCHEMA}`, 'POST', base);
  if (!r.qrcode) throw new TuyaLinkError('Tuya link: no QR code in the reply');
  return r.qrcode;
}

/** Step two: did anyone scan it? Returns the session once they did, null while they haven't. */
export async function qrPoll(qr: string, userCode: string, clientId = LINK_CLIENT_ID, base = LINK_BASE): Promise<{ session: ConsumerSession; t: number } | null> {
  const res = await fetch(`${base}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(qr)}?clientid=${clientId}&usercode=${encodeURIComponent(userCode)}`, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json().catch(() => null) as { success?: boolean; code?: string; result?: RawToken; t?: number } | null;
  if (!j?.success || !j.result) return null;
  const result = { ...j.result, t: j.t ?? j.result.t };
  return { session: toSession(result, userCode), t: result.t ?? Date.now() };
}

// ------------------------------------------------------------ signing --

const NONCES = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const nonce12 = () => Array.from({ length: 12 }, () => NONCES[Math.floor(Math.random() * NONCES.length)]).join('');

/** base64(nonce) + base64(ciphertext‖tag), exactly as the app builds it. */
function enc(raw: string, secret: string): string {
  const nonce = Buffer.from(nonce12(), 'utf8');
  const c = createCipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), nonce);
  const ct = Buffer.concat([c.update(raw, 'utf8'), c.final(), c.getAuthTag()]);
  return nonce.toString('base64') + ct.toString('base64');
}

function dec(data: string, secret: string): string {
  const buf = Buffer.from(data, 'base64');
  const d = createDecipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

/** A signed, encrypted call to the consumer endpoint. Keys are per-request: md5(rid+refreshToken). */
export class ConsumerApi {
  constructor(private s: ConsumerSession, private clientId = LINK_CLIENT_ID) { }

  /** The session, refreshed if a call rotated it — callers persist this. */
  get session(): ConsumerSession { return this.s; }

  private async raw<T>(method: string, path: string, params?: Record<string, unknown>, body?: Record<string, unknown>): Promise<T> {
    const rid = randomUUID();
    const sid = '';
    const hashKey = createHash('md5').update(rid + this.s.refreshToken).digest('hex');
    const secret = createHmac('sha256', rid).update(hashKey).digest('hex').slice(0, 16);

    let qEnc = '';
    let query: Record<string, string> | undefined;
    if (params && Object.keys(params).length) {
      qEnc = enc(JSON.stringify(params), secret);
      query = { encdata: qEnc };
    }
    let bEnc = '';
    let payload: { encdata: string } | undefined;
    if (body && Object.keys(body).length) {
      bEnc = enc(JSON.stringify(body), secret);
      payload = { encdata: bEnc };
    }

    const headers: Record<string, string> = {
      'X-appKey': this.clientId,
      'X-requestId': rid,
      'X-sid': sid,
      'X-time': String(Date.now()),
    };
    if (this.s.accessToken) headers['X-token'] = this.s.accessToken;

    const signStr = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
      .filter(k => headers[k])
      .map(k => `${k}=${headers[k]}`)
      .join('||') + qEnc + bEnc;
    headers['X-sign'] = createHmac('sha256', Buffer.from(hashKey, 'utf8')).update(signStr).digest('hex');

    const url = (this.s.endpoint || LINK_BASE) + path + (query ? `?${new URLSearchParams(query)}` : '');
    const res = await fetch(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(15_000) });
    const j = await res.json().catch(() => null) as { success?: boolean; code?: number | string; msg?: string; result?: string; t?: number } | null;
    if (!j) throw new TuyaLinkError(`Tuya ${path}: HTTP ${res.status}`);
    if (!j.success) throw new TuyaLinkError(`Tuya ${path}: ${j.msg ?? 'failed'}`, j.code);
    if (typeof j.result !== 'string' || !j.result) return j.result as T;
    const plain = dec(j.result, secret);
    try { return JSON.parse(plain) as T; } catch { return plain as unknown as T; }
  }

  private async refresh(): Promise<void> {
    const r = await this.raw<{ expireTime?: number; uid?: string; accessToken?: string; refreshToken?: string }>('GET', `/v1.0/m/token/${this.s.refreshToken}`);
    if (!r?.accessToken || !r.refreshToken) throw new TuyaLinkError('Tuya: the refreshed session came back empty');
    this.s = { ...this.s, uid: r.uid ?? this.s.uid, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: Date.now() + (r.expireTime ?? 7200) * 1000 };
  }

  /** A call, refreshing first if the token is nearly dead and once more if Tuya says it died anyway. */
  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    // A failed refresh is not fatal: the request can still go out on the old token, like HA does.
    if (this.s.expiresAt - 60_000 <= Date.now()) await this.refresh().catch(() => undefined);
    try { return await this.raw<T>('GET', path, params); }
    catch (e) {
      if (e instanceof TuyaLinkError && String(e.code) === '1010') { await this.refresh(); return this.raw<T>('GET', path, params); }
      throw e;
    }
  }

  // The three reads Kova needs ------------------------------------------------

  async homes(): Promise<{ id: string; name: string }[]> {
    const r = await this.get<{ ownerId?: number | string; name?: string }[]>('/v1.0/m/life/users/homes');
    return (r ?? []).map(h => ({ id: String(h.ownerId ?? ''), name: String(h.name ?? 'Home') }));
  }

  /** Every device in a home — sub-devices carry node_id + gateway_id, and each has its local_key. */
  async devices(homeId: string): Promise<TuyaCloudDevice[]> {
    const r = await this.get<Record<string, unknown>[]>('/v1.0/m/life/ha/home/devices', { homeId });
    return (r ?? []).map(d => toDevice(d as Parameters<typeof toDevice>[0]));
  }

  /** A device's data points, for the light/switch mapping. */
  async specification(id: string): Promise<TuyaDpSpec[]> {
    const r = await this.get<{ functions?: unknown[]; status?: unknown[]; category?: string }>(`/v1.1/m/life/${id}/specifications`);
    return parseSpec((r ?? {}) as Parameters<typeof parseSpec>[0]);
  }
}

// ------------------------------------------------------------ import --

export interface ConsumerImportOptions {
  existing?: TuyaOptions;
  rooms?: Room[];
  discoverMs?: number;
  discoverPorts?: number[];
  log?: (line: string) => void;
}

/**
 * The whole link: homes → every device (with local keys) → specs → LAN IPs → the tuya config section.
 * Returns the (possibly refreshed) session so the caller can keep it for the next pull.
 */
export async function importFromSession(session: ConsumerSession, o: ConsumerImportOptions = {}): Promise<{ session: ConsumerSession; devices: CloudDeviceWithSpec[] }> {
  const api = new ConsumerApi(session);
  const out: CloudDeviceWithSpec[] = [];
  for (const h of await api.homes()) {
    for (const d of await api.devices(h.id)) out.push(d);
  }
  for (const d of out) {
    try { d.spec = await api.specification(d.id); } catch (e) { o.log?.(`${d.name}: no specification (${(e as Error).message})`); }
  }
  return { session: api.session, devices: out };
}

/** Sessions from scans: `tuya.session` in integrations.json (accessToken/refreshToken are redacted to apps). */
export const sessionFromSection = (t: TuyaOptions | undefined): ConsumerSession | null => {
  const s = (t as unknown as { session?: Record<string, unknown> })?.session;
  return s?.accessToken && s?.refreshToken && s.endpoint && s.userCode
    ? { endpoint: String(s.endpoint), userCode: String(s.userCode), uid: String(s.uid ?? ''), accessToken: String(s.accessToken), refreshToken: String(s.refreshToken), expiresAt: Number(s.expiresAt ?? 0) }
    : null;
};
