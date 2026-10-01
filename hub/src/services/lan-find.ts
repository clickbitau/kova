import net from 'node:net';
import os from 'node:os';
import { CastChannel, NS } from '../adapters/cast/channel.ts';

// Finding speakers on the home network from the Integrations page, including on another VLAN, where
// discovery (mDNS, SSDP) doesn't reach. Instead of listening for announcements, Kova asks each address
// directly: the hub's own networks, a network the owner names, and (when Warden is linked) every device
// Warden sees online.

/** Addresses in a "10.10.30.0/24"-style network (/22 to /30), or a single address. */
export function expandSubnet(subnet: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(subnet.trim());
  if (!m) throw new Error(`“${subnet}” isn't a network like 10.10.30.0/24`);
  const parts = m.slice(1, 5).map(Number);
  if (parts.some(p => p > 255)) throw new Error(`“${subnet}” isn't a network like 10.10.30.0/24`);
  const bits = m[5] ? Number(m[5]) : 32;
  if (bits < 22 || bits > 32) throw new Error('Search a /22 or smaller (up to 1024 addresses)');
  const ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  if (bits === 32) return [parts.join('.')];
  const size = 2 ** (32 - bits), base = (ip & ~(size - 1)) >>> 0;
  const out: string[] = [];
  for (let i = 1; i < size - 1; i++) { const a = base + i; out.push([a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join('.')); }
  return out;
}

/** Every address on the hub's own IPv4 networks (each /24 it's on). */
export function ownNetworkHosts(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal)
    .flatMap(a => expandSubnet(`${a!.address.split('.').slice(0, 3).join('.')}.0/24`));
}

/** The addresses to ask: the hub's networks, a named network, and any others (e.g. Warden's online devices). */
export function searchHosts(o: { subnet?: string; extra?: string[] } = {}): string[] {
  return [...new Set([...ownNetworkHosts(), ...(o.subnet?.trim() ? expandSubnet(o.subnet) : []), ...(o.extra ?? [])])];
}

/** Run `f` over `items`, `limit` at a time. */
async function each<T>(items: T[], limit: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await f(items[next++]); }));
}

/** Whether a TCP port answers. */
export function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export interface FoundCast { id: string; name: string; model: string; host: string; port: number }

/** Cast speakers, displays and TVs: each answers its name, id and model on :8008. */
export async function findCastDevices(hosts: string[], timeoutMs = 1200, httpPort = 8008): Promise<FoundCast[]> {
  const found: FoundCast[] = [];
  await each(hosts, 128, async host => {
    try {
      const r = await fetch(`http://${host}:${httpPort}/setup/eureka_info?params=name,device_info,ssdp_udn`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const j = await r.json() as { name?: string; ssdp_udn?: string; device_info?: { model_name?: string; manufacturer?: string } };
      if (!j.ssdp_udn || !j.name) return;
      found.push({ id: j.ssdp_udn.replace(/-/g, '').toLowerCase(), name: j.name, model: j.device_info?.model_name || j.device_info?.manufacturer || 'Cast', host, port: 8009 });
    } catch { /* not a Cast device */ }
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The ports a Google speaker group listens on, on whichever of its speakers leads it (seen: 32000–32999). */
export const CAST_GROUP_PORTS = { from: 32000, to: 32999 };

export interface FoundCastGroup { host: string; port: number; members: string[] }

/** Google speaker groups: a Cast receiver on a high port of one of their speakers, whose multizone status lists the members. */
export async function findCastGroups(speakerHosts: string[], o: { ports?: { from: number; to: number }; timeoutMs?: number; insecure?: boolean } = {}): Promise<FoundCastGroup[]> {
  const ports = o.ports ?? CAST_GROUP_PORTS;
  const candidates: { host: string; port: number }[] = [];
  const all = speakerHosts.flatMap(host => Array.from({ length: ports.to - ports.from + 1 }, (_, i) => ({ host, port: ports.from + i })));
  await each(all, 256, async c => { if (await portOpen(c.host, c.port)) candidates.push(c); });
  const groups: FoundCastGroup[] = [];
  await each(candidates, 8, async c => {
    const ch = new CastChannel({ host: c.host, port: c.port, insecure: o.insecure, timeoutMs: o.timeoutMs ?? 3000 });
    try {
      await ch.connect();
      const m = await ch.request(NS.multizone, 'receiver-0', { type: 'GET_STATUS' });
      const devices = (m.data.status as { devices?: { deviceId: string }[] } | undefined)?.devices ?? [];
      if (devices.length > 1) groups.push({ ...c, members: devices.map(d => d.deviceId.replace(/-/g, '').toLowerCase()).sort() });
    } catch { /* something else on that port */ } finally { ch.close(); }
  });
  return groups;
}

/** Sonos speakers answer their device description on :1400. */
export async function findSonos(hosts: string[], timeoutMs = 1200): Promise<{ host: string; room: string; model: string }[]> {
  const found: { host: string; room: string; model: string }[] = [];
  await each(hosts, 128, async host => {
    try {
      const r = await fetch(`http://${host}:1400/xml/device_description.xml`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const x = await r.text();
      const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(x)?.[1] ?? '';
      if (!/sonos/i.test(tag('manufacturer'))) return;
      found.push({ host, room: tag('roomName'), model: tag('modelName') });
    } catch { /* not a Sonos */ }
  });
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
