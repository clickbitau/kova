import os from 'node:os';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { KOVA_VERSION } from '../version.ts';

// Connecting the Kova phone app: a kova://connect link (and its QR code) with this hub's address and,
// when the hub has one, its token. Only callers who already have the token get it back (the API's auth
// covers this route), so showing the code in the web app hands the phone nothing the browser didn't have.

/** An address a phone on the same network can reach: the one the browser used, unless that was localhost. */
export function lanBase(req: Pick<FastifyRequest, 'headers' | 'protocol'>, port: number, nets = os.networkInterfaces()): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host && !/^(localhost|127\.|::1$|0\.0\.0\.0$)/.test(name)) return `${proto}://${host}`;
  const ip = Object.values(nets).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  return `http://${ip ?? 'localhost'}:${port}`;
}

/**
 * The link the QR code holds. `url` is the address the phone tries first (older apps only read it and the token);
 * `alt` is each other address it may use, in order, and `hub` the hub's identity, so the app can check that an
 * address leads to this hub before it sends the token there.
 */
export function appLink(base: string, token?: string, more: { alt?: string[]; hubId?: string | null } = {}): string {
  const q = new URLSearchParams({ url: base, ...(token ? { token } : {}) });
  if (more.hubId) q.set('hub', more.hubId);
  for (const a of more.alt ?? []) if (a !== base) q.append('alt', a);
  return `kova://connect?${q}`;
}

// ---- Two ways to the hub: the home network and the remote address ----
// At home the phone talks to the hub on the LAN (fast, and it works with the internet down); away, over the hub's
// remote address (a Tailscale `tailscale serve` name, or any reverse proxy). The app keeps every address and uses
// the best one that answers as this hub (GET /api/hello), so the hub lists them all, best first.

export type AddressKind = 'local' | 'remote';
export interface HubAddress { url: string; kind: AddressKind }

/** 10/8, 172.16/12, 192.168/16: where a hub on a home network sits. */
export function isPrivateV4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A name or address only reachable on the home network: a private IPv4, a .local name, or a bare host name. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(localhost|127\.|::1$|0\.0\.0\.0$)/.test(h)) return false;
  return isPrivateV4(h) || h.endsWith('.local') || (/^[a-z0-9-]+$/.test(h) && !/^\d+$/.test(h));
}

// Interfaces a phone can't reach the hub through: containers, VMs, VPN tunnels.
const VIRTUAL = /^(docker|br-|veth|virbr|vnet|cni|flannel|cali|podman|lxc|lxd|tailscale|tun|tap|wg|zt|utun)/i;

/** http://<ip>:<port> for each private IPv4 interface on the hub. */
export function localAddresses(port: number, nets = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateV4(a.address)) continue;
      const u = `http://${a.address}:${port}`;
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}

/** A remote address as the app should use it: an http(s) URL with no trailing slash, or null. */
export function cleanRemote(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/**
 * Every address the phone may use, best first: the home-network ones (the one this request came in on, when that
 * is one, then each private interface), then the remote one. A request that came in on another https name (a
 * reverse proxy) counts as a remote address too.
 */
export function connectAddresses(req: Pick<FastifyRequest, 'headers' | 'protocol'>, port: number, remote: string | null | undefined, nets = os.networkInterfaces()): HubAddress[] {
  const out: HubAddress[] = [];
  const add = (url: string | null, kind: AddressKind) => { if (url && !out.some(a => a.url === url)) out.push({ url, kind }); };
  const seen = lanBase(req, port, nets);
  const seenHost = (() => { try { return new URL(seen).hostname; } catch { return ''; } })();
  const seenLocal = isLocalHost(seenHost);
  if (seenLocal) add(seen, 'local');
  for (const u of localAddresses(port, nets)) add(u, 'local');
  add(cleanRemote(remote), 'remote');
  if (!seenLocal && seen.startsWith('https://')) add(cleanRemote(seen), 'remote');
  return out;
}

/**
 * What /api/hello says about who this hub is: a fingerprint of the hub's ID, not the ID itself (which licences are
 * issued for). It's the same every time, so the app can tell this hub from any other device at an address.
 */
export function helloId(hubId: string): string {
  return createHash('sha256').update(`kova-hello\0${hubId}`).digest('hex').slice(0, 20);
}

export interface AppLinkOptions {
  token?: string;
  port: () => number;
  /** The hub's remote address (Tailscale or a reverse proxy), when it has one. */
  remoteUrl?: () => string | null | undefined;
  /** The hub's stable ID (hub-id); null when it has none. */
  hubId?: () => string | null | undefined;
}

export function registerAppLinkRoutes(app: FastifyInstance, o: AppLinkOptions): void {
  const id = (): string | null => { try { const h = o.hubId?.(); return h ? helloId(h) : null; } catch { return null; } };
  const remote = (): string | null => { try { return o.remoteUrl?.() ?? null; } catch { return null; } };

  // Is this Kova, and which one? No token needed (it's how the app checks an address before sending the token to
  // it), so it says nothing about the home: no name, no devices, only an opaque ID and the version.
  app.get('/api/hello', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { kova: true, hubId: id(), version: KOVA_VERSION };
  });

  // Every address the phone may use, best first (needs the token, like the rest of the API).
  app.get('/api/connect/addresses', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { hubId: id(), addresses: connectAddresses(req, o.port(), remote()) };
  });

  app.get('/api/app-link', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const base = lanBase(req, o.port());
    const addresses = connectAddresses(req, o.port(), remote());
    const hubId = id();
    const link = appLink(base, o.token, { alt: addresses.map(a => a.url), hubId });
    const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141517', light: '#f1efea' } });
    return { url: base, link, qrSvg, hasToken: !!o.token, addresses, hubId };
  });
}
