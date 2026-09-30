// Finding and remembering the hub. Kept free of React Native so it can be tested under Node.

export const DEFAULT_PORT = 8140;

export interface HubConfig {
  /** e.g. http://192.168.1.20:8140 */
  url: string;
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
 * kova://connect?url=http%3A%2F%2F192.168.1.20%3A8140&token=…
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
      return { url, ...(token ? { token } : {}) };
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
