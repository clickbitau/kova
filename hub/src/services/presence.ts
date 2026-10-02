import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Hub } from '../hub.ts';
import { Warden, type WardenDevice, type WardenOptions, type WardenPerson } from '../adapters/warden.ts';
import { LanHttpError } from '../util/lan-http.ts';

/** How Kova works out who's home. Lives under `presence` in integrations.json. Every source is optional. */
export interface PresenceOptions {
  /** Per person: the MAC addresses of their phones (as the router sees them), and optionally a fixed key for phone automations. */
  people?: Record<string, { phones?: string[]; key?: string; wardenPerson?: string }>;
  /** Read the router's ARP/NDP table through the OPNsense API (System → Access → Users → API keys). */
  opnsense?: { url: string; key: string; secret: string; insecureTls?: boolean };
  /** Per person: a phone IP to probe over TCP when the router can't be read. */
  pingHosts?: Record<string, string>;
  /** A phone must be gone this long before its person counts as away (iPhones leave Wi-Fi while asleep). Default 10. */
  awayAfterMin?: number;
  /** Poll interval. Default 30 s; 0 turns the timer off (tests call poll()). */
  pollSec?: number;
  /** TCP port for the ping probe. Default 62078 (iPhone lockdownd). */
  probePort?: number;
  /** Probe timeout. Default 2000 ms. */
  probeTimeoutMs?: number;
}

export const ROUTER = 'Router (OPNsense)';
export const WARDEN = 'Router (Warden)';
/** Older Warden (no device records): a phone counts as here while it was seen this recently. */
const WARDEN_RECENT_MS = 3 * 60_000;
export const PING = 'Network (ping)';
export const PHONE = 'Phone automation';
/** An explicit "left" from a phone beats the router this long: a phone stays on Wi-Fi while you drive off. */
export const LEFT_WINS_MS = 15 * 60_000;

interface PersonNet {
  /** What the network sources last concluded (after the away debounce). */
  home: boolean;
  lastSeen: number;
  /** A phone automation said "left": router sightings don't count until this clears. */
  left: { at: number; sawAbsent: boolean } | null;
}

const normMac = (m: string) => m.toLowerCase().replace(/-/g, ':').split(':').map(x => x.padStart(2, '0')).join(':');

/**
 * Combines the router, a TCP "ping" and phone automations (iOS Shortcuts,
 * Android automations) into one home/away per person, and tells the engine.
 * Network sources mark someone home the moment their phone shows up and away
 * only after it has been gone for `awayAfterMin`.
 */
export class Presence {
  private timer: NodeJS.Timeout | null = null;
  private net = new Map<string, PersonNet>();
  private keys: Record<string, string>;
  private polling = false;
  /** For the Integrations screen. */
  private last: { router?: { seen: number; total: number } | { error: string }; routerName?: 'Warden'; ping?: { up: number; total: number } } = {};

  /** `warden` reads the Warden section as it is now, so linking Warden later works without a restart. */
  constructor(private hub: Hub, private opts: PresenceOptions = {}, private sources: { warden?: () => WardenOptions | undefined; onReport?: (personId: string, home: boolean, source: string) => void } = {}) {
    this.keys = hub.store.get<Record<string, string>>('presenceKeys') ?? {};
  }

  private get now(): number { return this.hub.engine.now(); }
  private get awayMs(): number { return (this.opts.awayAfterMin ?? 10) * 60_000; }

  /** People who have at least one network source. */
  private tracked(): string[] {
    const ids = new Set<string>();
    // Phones count whenever a router can be read: OPNsense, or Warden (which may be linked later).
    if (this.opts.opnsense || this.sources.warden) for (const [id, p] of Object.entries(this.opts.people ?? {})) if (p.phones?.length) ids.add(id);
    // Warden knows who devices belong to: anyone it has as a person (same name, or chosen) counts too.
    if (this.sources.warden) for (const p of this.hub.config.get().people) ids.add(p.id);
    for (const id of Object.keys(this.opts.pingHosts ?? {})) ids.add(id);
    const known = new Set(this.hub.config.get().people.map(p => p.id));
    return [...ids].filter(id => known.has(id));
  }

  start(): void {
    const t = this.now;
    for (const id of this.tracked()) {
      // Until the network says otherwise, trust what the engine remembered.
      const home = this.hub.engine.people[id]?.home ?? true;
      this.net.set(id, { home, lastSeen: t, left: null });
    }
    // Make sure every person has a key for phone automations.
    this.ensureKeys();
    const every = (this.opts.pollSec ?? 30) * 1000;
    if (every > 0 && this.net.size) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), every);
      this.timer.unref?.();
    }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ---------------------------------------------------------- phone keys --

  private ensureKeys(): void {
    let changed = false;
    for (const p of this.hub.config.get().people) {
      if (this.opts.people?.[p.id]?.key || this.keys[p.id]) continue;
      this.keys[p.id] = randomBytes(18).toString('base64url');
      changed = true;
    }
    if (changed) this.hub.store.set('presenceKeys', this.keys);
  }

  keyFor(personId: string): string | undefined {
    this.ensureKeys();
    return this.opts.people?.[personId]?.key ?? this.keys[personId];
  }

  /** Whether `key` is this person's phone-automation key. */
  checkKey(personId: string, key: string | undefined): boolean {
    const want = this.keyFor(personId);
    if (!want || !key) return false;
    const a = Buffer.from(key), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Per-person URLs to paste into an iOS Shortcut or Android automation. */
  setup(baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, '');
    return {
      people: this.hub.config.get().people.map(p => {
        const key = this.keyFor(p.id)!;
        const url = `${base}/api/people/${encodeURIComponent(p.id)}/presence?key=${encodeURIComponent(key)}`;
        return {
          id: p.id, name: p.name, key,
          arriveUrl: `${url}&home=1`, leaveUrl: `${url}&home=0`,
          router: !!((this.opts.opnsense || this.sources.warden?.()?.token) && this.opts.people?.[p.id]?.phones?.length),
          ping: !!this.opts.pingHosts?.[p.id],
        };
      }),
      howTo: [
        'iPhone: Shortcuts → Automation → New → "Arrive" at Home → Run immediately.',
        'Add "Get Contents of URL", paste the arrive URL, set Method to POST.',
        'Make a second automation for "Leave" with the leave URL.',
        'Android: any automation app with a geofence (Tasker, MacroDroid…) that sends an HTTP POST to the same URLs.',
      ],
    };
  }

  // -------------------------------------------------------------- reports --

  /** An explicit report from a phone automation (or the app). "Arrived" wins at once; "left" beats the router for 15 minutes. */
  async report(personId: string, home: boolean, source = PHONE): Promise<void> {
    const n = this.net.get(personId);
    if (n) {
      // Arrived: the phone may not be on Wi-Fi yet, so the away debounce starts from now.
      if (home) { n.left = null; n.home = true; n.lastSeen = this.now; }
      else { n.left = { at: this.now, sawAbsent: false }; n.home = false; }
    }
    await this.hub.engine.setPresence(personId, home, source);
    // Tell Warden too (services/warden-link.ts), so it doesn't alarm about the phone of someone Kova knows is home.
    try { this.sources.onReport?.(personId, home, source); } catch { /* best effort */ }
  }

  /** Read every network source once and apply what changed. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [router, ping] = await Promise.all([this.readRouter(), this.readPing()]);
      const t = this.now;
      for (const [id, n] of this.net) {
        const byRouter = router?.get(id);
        const byPing = ping?.get(id);
        // No source could answer for this person: leave them as they are.
        if (byRouter === undefined && byPing === undefined) continue;
        const seen = !!byRouter || !!byPing;
        // Someone changed presence outside Kova's sources (the API without a key, a test): treat it like a phone report.
        const eng = this.hub.engine.people[id];
        if (eng && eng.home !== n.home) {
          n.home = eng.home;
          if (eng.home) { n.left = null; n.lastSeen = Math.max(n.lastSeen, eng.since); }
          else n.left = { at: eng.since, sawAbsent: false };
        }
        if (seen) n.lastSeen = t;
        if (n.left) {
          if (!seen) n.left.sawAbsent = true;
          // The phone dropped off and came back after the "left" window: that's a real return.
          else if (n.left.sawAbsent && t - n.left.at >= LEFT_WINS_MS) n.left = null;
          if (n.left) continue;
        }
        const routerLabel = this.last.routerName === 'Warden' ? WARDEN : ROUTER;
        const label = seen ? (byRouter ? routerLabel : PING) : (byRouter !== undefined ? routerLabel : PING);
        if (seen && !n.home) {
          n.home = true;
          await this.set(id, true, label);
        } else if (!seen && n.home && t - n.lastSeen >= this.awayMs) {
          n.home = false;
          await this.set(id, false, label);
        }
      }
    } finally {
      this.polling = false;
    }
    this.hub.emit('changed');
  }

  private async set(id: string, home: boolean, label: string): Promise<void> {
    try { await this.hub.engine.setPresence(id, home, label); } catch (err) { console.warn(`[presence] ${id}: ${String(err)}`); }
  }

  /** Per person: true if any of their phones is in the router's table, false if none; null map when the router can't be read. */
  private async readRouter(): Promise<Map<string, boolean> | null> {
    const w = this.sources.warden?.();
    if (w?.url && w.token) return this.readWarden(w);
    const o = this.opts.opnsense;
    if (!o) return null;
    try {
      const macs = new Set<string>();
      const arp = await getJson(`${o.url.replace(/\/+$/, '')}/api/diagnostics/interface/getArp`, o);
      for (const e of rows(arp)) if (e.mac && !e.expired) macs.add(normMac(e.mac));
      // IPv6 neighbours too; older firmware may not have it, which is fine.
      try {
        const ndp = await getJson(`${o.url.replace(/\/+$/, '')}/api/diagnostics/interface/getNdp`, o);
        for (const e of rows(ndp)) if (e.mac) macs.add(normMac(e.mac));
      } catch { /* optional */ }
      return this.match(macs);
    } catch (err) {
      this.last.router = { error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  }

  /**
   * Who Warden says is here. A person's phones (by any MAC Warden has seen them use) on a device that's online,
   * or Warden's own presence for the person of the same name (or the one chosen). People Warden can't speak for are left out.
   */
  private async readWarden(w: WardenOptions): Promise<Map<string, boolean> | null> {
    this.last.routerName = 'Warden';
    const api = new Warden(w);
    try {
      let devices: WardenDevice[] | null = null;
      try { devices = await api.devices(); } catch (e) { if (!(e instanceof LanHttpError && e.status === 404)) throw e; }
      if (!devices) {
        // Older Warden: clients by MAC, seen recently.
        const now = Date.now();
        const macs = new Set((await api.clients())
          .filter(c => c.lastSeenAt ? now - Date.parse(c.lastSeenAt) < WARDEN_RECENT_MS : c.online !== false)
          .map(c => normMac(c.mac)));
        return this.match(macs);
      }
      const online = new Set(devices.filter(d => d.online).flatMap(d => d.macs.map(normMac)));
      const out = this.match(online);
      const people = await api.people().catch(() => [] as WardenPerson[]);
      const byName = new Map(people.map(p => [p.name.trim().toLowerCase(), p]));
      for (const p of this.hub.config.get().people) {
        if (out.has(p.id)) continue;
        const set = this.opts.people?.[p.id]?.wardenPerson;
        const wp = set ? people.find(x => x.id === set) ?? byName.get(set.trim().toLowerCase()) : byName.get(p.name.trim().toLowerCase());
        if (wp && wp.devices.length) out.set(p.id, wp.presence.home);
      }
      return out;
    } catch (err) {
      this.last.router = { error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  }

  /** Per person: whether any of their phones is among `macs`. */
  private match(macs: Set<string>): Map<string, boolean> {
    const out = new Map<string, boolean>();
    let seen = 0, total = 0;
    for (const [id, p] of Object.entries(this.opts.people ?? {})) {
      const phones = (p.phones ?? []).map(normMac);
      if (!phones.length) continue;
      total += phones.length;
      const here = phones.filter(m => macs.has(m)).length;
      seen += here;
      out.set(id, here > 0);
    }
    this.last.router = { seen, total };
    return out;
  }

  private async readPing(): Promise<Map<string, boolean> | null> {
    const hosts = Object.entries(this.opts.pingHosts ?? {});
    if (!hosts.length) return null;
    const port = this.opts.probePort ?? 62078;
    const res = await Promise.all(hosts.map(async ([id, ip]) => [id, await probe(ip, port, this.opts.probeTimeoutMs ?? 2000)] as const));
    this.last.ping = { up: res.filter(([, up]) => up).length, total: res.length };
    return new Map(res);
  }

  /**
   * What already tells Kova whether this person is home, without their phone's location: Warden (which knows whose
   * devices are whose), the OPNsense router seeing their phone, or a network check. Empty when only the phone can.
   */
  coveredBy(personId: string): string[] {
    const out: string[] = [];
    const w = this.sources.warden?.();
    if (w?.url && w.token) out.push('Warden');
    else if (this.opts.opnsense && this.opts.people?.[personId]?.phones?.length) out.push('your router');
    if (this.opts.pingHosts?.[personId]) out.push('a network check');
    return out;
  }

  /** Row on the Integrations screen. */
  status(): { ok: boolean; note?: string } {
    const parts: string[] = [];
    let ok = true;
    const r = this.last.router;
    const w = this.sources.warden?.();
    if (this.opts.opnsense || (w?.url && w.token)) {
      const name = w?.url && w.token ? 'Warden' : 'OPNsense';
      if (!r) parts.push('Router: checking…');
      else if ('error' in r) { ok = false; parts.push(`Router: can't read ${name} (${r.error})`); }
      else parts.push(`Router: ${r.seen} phone${r.seen === 1 ? '' : 's'} seen`);
    }
    const p = this.last.ping;
    if (p) parts.push(`Ping: ${p.up} of ${p.total} reachable`);
    if (!parts.length) parts.push('Phone automations only');
    return { ok, note: parts.join(' · ') };
  }
}

interface ArpRow { mac?: string; ip?: string; expired?: boolean }
function rows(j: unknown): ArpRow[] {
  if (Array.isArray(j)) return j as ArpRow[];
  if (j && typeof j === 'object' && Array.isArray((j as { rows?: unknown }).rows)) return (j as { rows: ArpRow[] }).rows;
  return [];
}

/** GET a JSON document with basic auth; `insecureTls` accepts the router's self-signed certificate. */
function getJson(url: string, o: { key: string; secret: string; insecureTls?: boolean }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { authorization: 'Basic ' + Buffer.from(`${o.key}:${o.secret}`).toString('base64'), accept: 'application/json' },
      timeout: 10_000,
      ...(u.protocol === 'https:' && o.insecureTls ? { rejectUnauthorized: false } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('not JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Is a phone at this address? A TCP connect that's accepted or refused means
 * something answered; a timeout or "unreachable" means nothing is there.
 * (ICMP needs privileges that containers often don't have.)
 */
export function probe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    s.once('connect', () => finish(true));
    s.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'));
  });
}
