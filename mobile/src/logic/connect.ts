// Finding and remembering the hub. Kept free of React Native so it can be tested under Node.

import { kindFor, sortAddresses, type HubAddress } from './addresses.ts';

export const DEFAULT_PORT = 8140;

export interface HubConfig {
  /** The address in use (the last one that answered as this hub), e.g. http://192.168.1.20:8140 */
  url: string;
  /** Every address the hub may be reached at, home network first (logic/addresses.ts). Absent on a phone set up before there was a list. */
  addresses?: HubAddress[];
  /** What GET /api/hello at the hub says it is: an address must say the same before the token goes there. */
  hubId?: string;
  /** Addresses the owner took away, so learning from the hub doesn't bring them back. */
  removed?: string[];
  /** The hub's KOVA_TOKEN, when it has one. */
  token?: string;
  /** Who this phone belongs to (a person id in the home), for arriving and leaving. */
  personId?: string;
}

/** "192.168.1.20", "kova.local:8140/", "https://kova.example.com" → a base URL with no trailing slash. */
export function normalizeHubUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    // Plain HTTP with no port is a hub on the LAN: add Kova's port. HTTPS (a reverse proxy) keeps its own.
    // (URL drops a port that's the scheme's default, so read an explicit one from the text.)
    const typed = /^https?:\/\/[^/]*:(\d+)/i.exec(s)?.[1];
    const withPort = typed ? `${u.hostname}:${typed}` : u.protocol === 'http:' ? `${u.hostname}:${DEFAULT_PORT}` : u.host;
    return `${u.protocol}//${withPort}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The link the hub shows as a QR code (More → Connect the phone app):
 * kova://connect?url=http%3A%2F%2F192.168.1.20%3A8140&token=…&hub=<id>&alt=https%3A%2F%2Fkova.example.ts.net
 * `alt` is each other address the hub may be reached at; `hub` the ID its /api/hello gives.
 * Also accepts a plain hub address, and an https link with the same query.
 */
export function parseConnectLink(text: string): HubConfig | null {
  const s = text.trim();
  try {
    const u = new URL(s);
    if (u.protocol === 'kova:' || u.searchParams.has('url')) {
      const url = normalizeHubUrl(u.searchParams.get('url') ?? '');
      if (!url) return null;
      const token = u.searchParams.get('token') || undefined;
      const hubId = u.searchParams.get('hub') || undefined;
      const alt = u.searchParams.getAll('alt').map(normalizeHubUrl).filter((a): a is string => !!a && a !== url);
      const addresses = alt.length ? sortAddresses([url, ...new Set(alt)].map(a => ({ url: a, kind: kindFor(a) }))) : undefined;
      return { url, ...(token ? { token } : {}), ...(hubId ? { hubId } : {}), ...(addresses ? { addresses } : {}) };
    }
  } catch { /* not a URL: maybe a bare address */ }
  const url = normalizeHubUrl(s);
  return url ? { url } : null;
}

/** Every other address on the phone's /24, nearest first (hubs usually sit low or near the phone). */
export function subnetCandidates(phoneIp: string | null | undefined, port = DEFAULT_PORT): string[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(phoneIp ?? '');
  if (!m) return [];
  const [a, b, c, self] = m.slice(1).map(Number);
  if (a === 127 || a === 0) return [];
  const hosts = Array.from({ length: 254 }, (_, i) => i + 1).filter(h => h !== self);
  hosts.sort((x, y) => Math.min(x, Math.abs(x - self)) - Math.min(y, Math.abs(y - self)));
  return hosts.map(h => `http://${a}.${b}.${c}.${h}:${port}`);
}

/** A path on the hub, with the token as a query for places that can't send headers (web views, images, the socket). */
export function hubUrl(cfg: HubConfig, path: string, withToken = false): string {
  const u = `${cfg.url}${path.startsWith('/') ? path : `/${path}`}`;
  if (!withToken || !cfg.token) return u;
  return `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.token)}`;
}

export function wsUrl(cfg: HubConfig): string {
  return hubUrl({ ...cfg, url: cfg.url.replace(/^http/, 'ws') }, '/api/ws', true);
}

/** An invite to someone's home (household accounts): where the hub is, and the one-time code. */
export interface InviteLink {
  url: string;
  code: string;
  hubId?: string;
  addresses?: HubAddress[];
}

/** "abcde fghjk" → "ABCDE-FGHJK"; null unless it's an invite code's 10 letters and digits. */
export function cleanInviteCode(raw: string | null | undefined): string | null {
  const c = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : null;
}

/**
 * The invite the hub makes (Settings → People → Invite), as a link or its QR code:
 * https://kova.example/join.html#code=ABCDE-FGHJK&hub=<id>&alt=http%3A%2F%2F192.168.1.20%3A8140 (a browser opens
 * it; the code is after # so it never reaches a server log), or kova://join?url=…&code=…&hub=…&alt=… (the app).
 * Anything else (a connect link, a bare address) is null: parseConnectLink handles those.
 */
export function parseInviteLink(text: string): InviteLink | null {
  let u: URL;
  try { u = new URL(text.trim()); } catch { return null; }
  let base: string | null, q: URLSearchParams;
  if (u.protocol === 'kova:') {
    if (!/^kova:\/\/join\/?(\?|$)/i.test(u.href)) return null;
    q = u.searchParams;
    base = normalizeHubUrl(q.get('url') ?? '');
  } else if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (!/\/join(\.html)?\/?$/.test(u.pathname)) return null;
    q = new URLSearchParams(u.hash.replace(/^#/, '') || u.search.replace(/^\?/, ''));
    // The join page sits at the hub's root, wherever that is (a reverse proxy may add a path).
    base = normalizeHubUrl(`${u.protocol}//${u.host}${u.pathname.replace(/\/join(\.html)?\/?$/, '')}`);
  } else return null;
  const code = cleanInviteCode(q.get('code'));
  if (!base || !code) return null;
  const hubId = q.get('hub') || undefined;
  const alt = q.getAll('alt').map(normalizeHubUrl).filter((a): a is string => !!a && a !== base);
  const addresses = alt.length ? sortAddresses([base, ...new Set(alt)].map(a => ({ url: a, kind: kindFor(a) }))) : undefined;
  return { url: base, code, ...(hubId ? { hubId } : {}), ...(addresses ? { addresses } : {}) };
}
