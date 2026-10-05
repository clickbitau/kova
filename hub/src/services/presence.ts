import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Hub } from '../hub.ts';
import type { PresenceEvidence, PresenceSourceKind } from '../model/types.ts';
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
/** An explicit "left" always has this long before the network can outvote it: the phone can still be on Wi-Fi while driving off. */
export const LEFT_WINS_MS = 15 * 60_000;
/** Longer than any stale ARP entry (FreeBSD keeps them 20 min): still listed after this, the phone is really here. */
export const ARP_STALE_MS = 45 * 60_000;
/** A reported "left" matters less as it ages; reliable fresh network evidence can eventually overrule it. */
const LEFT_HALF_LIFE_MS = 30 * 60_000;
/** A conflicting source needs this much of the vote before it changes state. */
const FLIP_AT = 0.55;
/** The remembered state counts a little, so one weak sighting doesn't flap presence. */
const INERTIA = 0.18;

/** Prior trust in each source family before per-person learning adjusts it. */
const SOURCE_BASE: Record<PresenceSourceKind, number> = {
  manual: 0.98,
  app: 0.9,
  phone: 0.82,
  warden: 0.84,
  router: 0.68,
  ping: 0.58,
  other: 0.7,
};

interface SourceReading {
  kind: PresenceSourceKind;
  source: string;
  home: boolean;
  /** Prior vote strength before learned reliability is applied, 0–1. */
  strength: number;
  at: number;
}

interface PersonNet {
  /** What the network sources last concluded (after the away debounce). */
  home: boolean;
  lastSeen: number;
  /** A phone said "left": network sightings have to outvote it after the minimum hold. */
  left: { at: number; sawAbsent: boolean; source: string; kind: PresenceSourceKind; strength: number } | null;
}

interface LearningRow { reliability: number; correct: number; contradicted: number; updatedAt: number }
type Learning = Record<string, Partial<Record<PresenceSourceKind, LearningRow>>>;

const normMac = (m: string) => m.toLowerCase().replace(/-/g, ':').split(':').map(x => x.padStart(2, '0')).join(':');
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const decay = (ageMs: number, halfLifeMs: number) => Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);

/** Which family to learn from a human source label. */
export function sourceKind(source: string | undefined): PresenceSourceKind {
  const s = (source ?? '').toLowerCase();
  if (s.includes('warden')) return 'warden';
  if (s.includes('opnsense') || s.includes('router')) return 'router';
  if (s.includes('ping') || s.includes('network check')) return 'ping';
  if (s.includes('location') || s.includes('app') || s.includes('geofence')) return 'app';
  if (s.includes('manual') || s.includes('user') || s.includes('you') || s.includes('test')) return 'manual';
  if (s.includes('phone') || s.includes('automation') || s.includes('shortcut')) return 'phone';
  return 'other';
}

/**
 * Combines the router, a TCP "ping" and phone reports into one home/away per
 * person, and tells the engine. Each report is evidence: a source prior, a
 * learned per-person reliability, freshness and the remembered state decide
 * the confidence. Network sources still mark someone home at once and away
 * only after `awayAfterMin`; a phone "left" gets a minimum hold before network
 * evidence can outvote it.
 */
export class Presence {
  private timer: NodeJS.Timeout | null = null;
  private net = new Map<string, PersonNet>();
  private keys: Record<string, string>;
  private learning: Learning;
  private polling = false;
  /** For the Integrations screen. */
  private last: { router?: { seen: number; total: number } | { error: string }; routerName?: 'Warden'; ping?: { up: number; total: number } } = {};

  /** `warden` reads the Warden section as it is now, so linking Warden later works without a restart. */
  constructor(private hub: Hub, private opts: PresenceOptions = {}, private sources: { warden?: () => WardenOptions | undefined; onReport?: (personId: string, home: boolean, source: string) => void } = {}) {
    this.keys = hub.store.get<Record<string, string>>('presenceKeys') ?? {};
    this.learning = hub.store.get<Learning>('presenceLearning') ?? {};
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

  /** An explicit report from a phone automation (or the app). It wins immediately, then joins the learned evidence model. */
  async report(personId: string, home: boolean, source = PHONE): Promise<void> {
    const kind = sourceKind(source);
    const n = this.net.get(personId);
    if (n) {
      // Arrived: the phone may not be on Wi-Fi yet, so the away debounce starts from now.
      if (home) { n.left = null; n.home = true; n.lastSeen = this.now; }
      else { n.left = { at: this.now, sawAbsent: false, source, kind, strength: SOURCE_BASE[kind] }; n.home = false; }
    }
    await this.apply(personId, [{ kind, source, home, strength: SOURCE_BASE[kind], at: this.now }], { force: true, learn: kind === 'manual' });
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
        const readings = [byRouter, byPing].filter((r): r is SourceReading => !!r);
        // No source could answer for this person: leave them as they are.
        if (!readings.length) continue;
        const seen = readings.some(r => r.home);
        // Someone changed presence outside Kova's sources (the API without a key, a test): treat it like a phone report.
        const eng = this.hub.engine.people[id];
        if (eng && eng.home !== n.home) {
          n.home = eng.home;
          if (eng.home) { n.left = null; n.lastSeen = Math.max(n.lastSeen, eng.since); }
          else n.left = { at: eng.since, sawAbsent: false, source: eng.evidence?.[0]?.source ?? PHONE, kind: eng.evidence?.[0]?.kind ?? 'phone', strength: eng.evidence?.[0]?.weight ?? SOURCE_BASE.phone };
        }
        if (seen) n.lastSeen = t;
        if (n.left) {
          if (!seen) { n.left.sawAbsent = true; continue; }
          const after = t - n.left.at;
          const live = (byRouter?.kind === 'warden' && byRouter.home) || byPing?.home === true;
          const eligible = (live && after >= LEFT_WINS_MS) || (n.left.sawAbsent && after >= LEFT_WINS_MS) || after >= ARP_STALE_MS;
          // A "left" cannot be overruled instantly. OPNsense also has to see the phone disappear and return, unless it
          // has stayed in ARP well past any stale entry; a continuous sighting inside that window may just be stale.
          if (!eligible || (!live && !n.left.sawAbsent && after < ARP_STALE_MS)) continue;
          const left: SourceReading = { kind: n.left.kind, source: n.left.source, home: false, strength: n.left.strength * decay(after, LEFT_HALF_LIFE_MS), at: n.left.at };
          const d = await this.apply(id, [...readings, left], { inertia: false, learn: n.left.sawAbsent || after >= ARP_STALE_MS });
          n.home = d.home;
          if (d.home) n.left = null;
          continue;
        }
        // Home sightings apply at once. Absence is debounced, then becomes away evidence.
        if (!seen && n.home && t - n.lastSeen < this.awayMs) continue;
        const d = await this.apply(id, readings, { learn: true });
        n.home = d.home;
      }
    } finally {
      this.polling = false;
    }
    this.hub.emit('changed');
  }

  /** Score evidence, optionally learn from a decisive change, then update the engine. */
  private async apply(personId: string, readings: SourceReading[], opts: { force?: boolean; inertia?: boolean; learn?: boolean } = {}): Promise<{ home: boolean; confidence: number; evidence: PresenceEvidence[] }> {
    const current = this.hub.engine.people[personId]?.home ?? this.net.get(personId)?.home ?? true;
    const evidence = readings.map(r => {
      const reliability = this.reliability(personId, r.kind);
      return { source: r.source, kind: r.kind, home: r.home, weight: round2(clamp01(r.strength) * reliability), reliability: round2(reliability), at: r.at };
    }).sort((a, b) => b.weight - a.weight).slice(0, 5);
    const inertia = opts.inertia === false ? 0 : INERTIA;
    let homeW = current ? inertia : 0;
    let awayW = current ? 0 : inertia;
    for (const e of evidence) (e.home ? homeW += e.weight : awayW += e.weight);
    const total = homeW + awayW;
    const pHome = total ? homeW / total : current ? 1 : 0;
    const home = opts.force ? (readings[0]?.home ?? current) : pHome >= FLIP_AT ? true : pHome <= 1 - FLIP_AT ? false : current;
    const confidence = round2(clamp01(home ? pHome : 1 - pHome));
    if ((opts.learn ?? false) && (opts.force || home !== current)) this.learn(personId, evidence, home);
    const label = evidence.find(e => e.home === home)?.source ?? evidence[0]?.source;
    await this.hub.engine.setPresence(personId, home, label, { confidence, evidence });
    return { home, confidence, evidence };
  }

  private reliability(personId: string, kind: PresenceSourceKind): number {
    return this.learning[personId]?.[kind]?.reliability ?? 0.82;
  }

  /** EWMA-ish source reliability: evidence that agrees with the outcome gains a little; evidence against it loses more. */
  private learn(personId: string, evidence: PresenceEvidence[], outcome: boolean): void {
    if (!evidence.length) return;
    const by = this.learning[personId] ??= {};
    let changed = false;
    for (const e of evidence) {
      const row = by[e.kind] ??= { reliability: 0.82, correct: 0, contradicted: 0, updatedAt: this.now };
      const agree = e.home === outcome;
      const step = agree ? 0.06 * e.weight : 0.18 * e.weight;
      const next = clamp01(row.reliability + (agree ? (1 - row.reliability) * step : (0 - row.reliability) * step));
      if (agree) row.correct++; else row.contradicted++;
      row.reliability = Math.max(0.2, Math.min(0.98, next));
      row.updatedAt = this.now;
      changed = true;
    }
    if (changed) this.hub.store.set('presenceLearning', this.learning);
  }

  /** Per person: the latest reading each network source can offer. */
  private async readRouter(): Promise<Map<string, SourceReading> | null> {
    const w = this.sources.warden?.();
    if (w?.url && w.token) return this.readWarden(w);
    const o = this.opts.opnsense;
    if (!o) return null;
    try {
      const macs = new Map<string, number>();
      const arp = await getJson(`${o.url.replace(/\/+$/, '')}/api/diagnostics/interface/getArp`, o);
      for (const e of rows(arp)) if (e.mac && !e.expired) macs.set(normMac(e.mac), this.now);
      // IPv6 neighbours too; older firmware may not have it, which is fine.
      try {
        const ndp = await getJson(`${o.url.replace(/\/+$/, '')}/api/diagnostics/interface/getNdp`, o);
        for (const e of rows(ndp)) if (e.mac) macs.set(normMac(e.mac), this.now);
      } catch { /* optional */ }
      return this.match(macs, ROUTER, 'router', 0.68, 0.55);
    } catch (err) {
      this.last.router = { error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  }

  /**
   * Who Warden says is here. A person's phones (by any MAC Warden has seen them use) on a device that's online,
   * or Warden's own presence for the person of the same name (or the one chosen). People Warden can't speak for are left out.
   */
  private async readWarden(w: WardenOptions): Promise<Map<string, SourceReading> | null> {
    this.last.routerName = 'Warden';
    const api = new Warden(w);
    try {
      let devices: WardenDevice[] | null = null;
      try { devices = await api.devices(); } catch (e) { if (!(e instanceof LanHttpError && e.status === 404)) throw e; }
      if (!devices) {
        // Older Warden: clients by MAC, seen recently.
        const now = Date.now();
        const macs = new Map<string, number>();
        for (const c of await api.clients()) {
          const at = c.lastSeenAt ? Date.parse(c.lastSeenAt) : NaN;
          if (Number.isFinite(at) ? now - at < WARDEN_RECENT_MS : c.online !== false) macs.set(normMac(c.mac), Number.isFinite(at) ? at : this.now);
        }
        return this.match(macs, WARDEN, 'warden', 0.78, 0.58);
      }
      const online = new Map<string, number>();
      for (const d of devices.filter(d => d.online)) {
        const at = Date.parse(d.lastSeenAt ?? d.onlineSince ?? '') || this.now;
        for (const mac of d.macs) online.set(normMac(mac), at);
      }
      const out = this.match(online, WARDEN, 'warden', 0.78, 0.58);
      const people = await api.people().catch(() => [] as WardenPerson[]);
      const byName = new Map(people.map(p => [p.name.trim().toLowerCase(), p]));
      for (const p of this.hub.config.get().people) {
        if (out.has(p.id)) continue;
        const set = this.opts.people?.[p.id]?.wardenPerson;
        const wp = set ? people.find(x => x.id === set) ?? byName.get(set.trim().toLowerCase()) : byName.get(p.name.trim().toLowerCase());
        if (wp && wp.devices.length) {
          const at = Date.parse(wp.presence.since ?? '') || this.now;
          out.set(p.id, { kind: 'warden', source: WARDEN, home: wp.presence.home, strength: 0.86, at });
        }
      }
      return out;
    } catch (err) {
      this.last.router = { error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  }

  /** Per person: whether any of their phones is among `macs`. */
  private match(macs: Map<string, number>, source: string, kind: PresenceSourceKind, seenStrength: number, absentStrength: number): Map<string, SourceReading> {
    const out = new Map<string, SourceReading>();
    let seen = 0, total = 0;
    for (const [id, p] of Object.entries(this.opts.people ?? {})) {
      const phones = (p.phones ?? []).map(normMac);
      if (!phones.length) continue;
      total += phones.length;
      const hits = phones.filter(m => macs.has(m));
      seen += hits.length;
      const home = hits.length > 0;
      out.set(id, { kind, source, home, strength: home ? seenStrength : absentStrength, at: hits.length ? Math.max(...hits.map(m => macs.get(m)!)) : this.now });
    }
    this.last.router = { seen, total };
    return out;
  }

  private async readPing(): Promise<Map<string, SourceReading> | null> {
    const hosts = Object.entries(this.opts.pingHosts ?? {});
    if (!hosts.length) return null;
    const port = this.opts.probePort ?? 62078;
    const res = await Promise.all(hosts.map(async ([id, ip]) => [id, await probe(ip, port, this.opts.probeTimeoutMs ?? 2000)] as const));
    this.last.ping = { up: res.filter(([, up]) => up).length, total: res.length };
    return new Map(res.map(([id, up]) => [id, { kind: 'ping' as const, source: PING, home: up, strength: up ? 0.58 : 0.5, at: this.now }]));
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
