import mdns from 'multicast-dns';
import { networkInterfaces } from 'node:os';

// Kova on the network: `_kova._tcp` over mDNS, so apps at home (Warden's "Kova found on your network") can find the
// hub and open the right page on it. TXT: id (the hub's stable id), name, v (version), path (where Warden's connect
// link lands) and proto (http or https, the scheme to open).

export const KOVA_SERVICE = '_kova._tcp.local';

export interface KovaAnnounce {
  /** The hub's stable id (hub-id); none on a hub without one. */
  id: () => string | null | undefined;
  name: () => string;
  version: string;
  port: () => number;
  proto?: 'http' | 'https';
  /** Tests: the addresses to give instead of the hub's own. */
  addresses?: () => string[];
  /** A Warden heard on the network (`_warden._tcp`): for a new hub's first steps. */
  onWarden?: (w: WardenSeen) => void;
}

/** A Warden that said where it is on the network. */
export interface WardenSeen { name: string; url: string }

export const WARDEN_SERVICE = '_warden._tcp.local';

type Record_ = { name: string; type: string; data: unknown };
/** Wardens in an mDNS answer: each SRV of `_warden._tcp` with an address for its host. */
export function wardensIn(records: Record_[]): WardenSeen[] {
  const out: WardenSeen[] = [];
  const addr = new Map<string, string>();
  for (const r of records) if (r.type === 'A' && typeof r.data === 'string') addr.set(r.name.toLowerCase(), r.data);
  for (const r of records) {
    if (r.type !== 'SRV' || !r.name.toLowerCase().endsWith('.' + WARDEN_SERVICE)) continue;
    const d = r.data as { port?: number; target?: string };
    const host = String(d.target ?? '').toLowerCase();
    const ip = addr.get(host) ?? (host ? host.replace(/\.$/, '') : '');
    if (!ip || !d.port) continue;
    const txt = records.find(x => x.type === 'TXT' && x.name === r.name);
    const kv: Record<string, string> = {};
    for (const b of (Array.isArray(txt?.data) ? txt!.data : []) as Buffer[]) { const t = b.toString(); const i = t.indexOf('='); if (i > 0) kv[t.slice(0, i)] = t.slice(i + 1); }
    const label = r.name.slice(0, -(WARDEN_SERVICE.length + 1)).replace(/\\(.)/g, '$1');
    out.push({ name: kv.name || kv.n || label || 'Warden', url: `https://${ip}${d.port === 443 ? '' : `:${d.port}`}` });
  }
  return out;
}

type Answer = { name: string; type: string; ttl?: number; data: unknown; flush?: boolean };

/** A DNS label from a name: printable, at most 63 bytes. */
const label = (s: string) => (s.replace(/[.\u0000-\u001f]/g, ' ').trim() || 'Kova').slice(0, 63);

/** The hub's IPv4 addresses on its networks (no loopback, no link-local). */
const ownAddresses = (): string[] => Object.values(networkInterfaces()).flat()
  .filter((n): n is NonNullable<typeof n> => !!n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
  .map(n => n.address);

/** The records that describe the hub: what Kova answers with when asked, and says when it starts. */
export function kovaRecords(o: KovaAnnounce): { instance: string; host: string; answers: Answer[]; txt: Record<string, string> } {
  const id = o.id() || '';
  const instance = `${label(o.name())}.${KOVA_SERVICE}`;
  const host = `kova-${(id || 'hub').toLowerCase().replace(/^kova-/, '').replace(/[^a-z0-9-]/g, '')}.local`;
  const txt: Record<string, string> = { id, name: o.name(), v: o.version, path: '/integrations/warden', proto: o.proto ?? 'http' };
  const answers: Answer[] = [
    { name: KOVA_SERVICE, type: 'PTR', ttl: 4500, data: instance },
    { name: instance, type: 'SRV', ttl: 120, flush: true, data: { port: o.port(), target: host, priority: 0, weight: 0 } },
    { name: instance, type: 'TXT', ttl: 4500, flush: true, data: Object.entries(txt).map(([k, v]) => Buffer.from(`${k}=${v}`)) },
    ...(o.addresses ?? ownAddresses)().map(a => ({ name: host, type: 'A', ttl: 120, flush: true, data: a })),
  ];
  return { instance, host, answers, txt };
}

/** Does this mDNS question ask for the hub? */
export const asksForKova = (q: { name: string; type: string }, r: ReturnType<typeof kovaRecords>): boolean => {
  const n = q.name.toLowerCase();
  return (n === KOVA_SERVICE && (q.type === 'PTR' || q.type === 'ANY'))
    || (n === r.instance.toLowerCase() && ['SRV', 'TXT', 'ANY'].includes(q.type))
    || (n === r.host && ['A', 'ANY'].includes(q.type))
    || (n === '_services._dns-sd._udp.local' && q.type === 'PTR');
};

/** Answer for the hub on the network until stopped. Without multicast (some containers), it stays quiet. */
export function announceKova(o: KovaAnnounce): { stop: () => void } {
  let m: ReturnType<typeof mdns>;
  try { m = mdns(); } catch { return { stop: () => {} }; }
  m.on('error', () => {});
  const send = () => { try { m.respond({ answers: kovaRecords(o).answers } as never); } catch { /* not on a network */ } };
  // Listening for a Warden too (a new hub offers to connect to it).
  m.on('response', (res: { answers: Record_[]; additionals?: Record_[] }) => {
    if (!o.onWarden) return;
    for (const w of wardensIn([...res.answers, ...(res.additionals ?? [])])) o.onWarden(w);
  });
  const look = () => { if (o.onWarden) try { m.query({ questions: [{ name: WARDEN_SERVICE, type: 'PTR' }] } as never); } catch { /* not on a network */ } };
  m.on('query', (q: { questions: { name: string; type: string }[] }) => {
    const r = kovaRecords(o);
    if (!q.questions.some(x => asksForKova(x, r))) return;
    const browse = q.questions.some(x => x.name.toLowerCase() === '_services._dns-sd._udp.local');
    const answers = browse ? [{ name: '_services._dns-sd._udp.local', type: 'PTR', ttl: 4500, data: KOVA_SERVICE }, ...r.answers] : r.answers;
    try { m.respond({ answers } as never); } catch { /* gone */ }
  });
  // Said twice when it starts, as mDNS asks, so listeners hear of it without asking.
  send();
  look();
  const again = setTimeout(() => { send(); look(); }, 1000);
  again.unref?.();
  const every = setInterval(look, 10 * 60_000);
  every.unref?.();
  return { stop: () => { clearTimeout(again); clearInterval(every); try { m.destroy(); } catch { /* already */ } } };
}
