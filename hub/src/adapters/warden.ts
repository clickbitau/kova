import { EventEmitter } from 'node:events';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';
import { LanHttpError, lanJson, lanStream, trimUrl, type SseEvent } from '../util/lan-http.ts';

/**
 * Warden OS, the home's router (ClickBIT's own). Kova reads it over its REST API
 * (`/api/v1`) and gets:
 *  - an **Internet** device: on while the internet is up, with events when it goes
 *    down, comes back or fails over, a new device joins, or Warden blocks an attack;
 *  - an **internet switch** per device you choose (a child's tablet, a console):
 *    off pauses that device's internet in Warden, so modes can do bedtime;
 *  - who's home, from Warden's people and their phones (see services/presence.ts).
 *
 * Events arrive live on Warden's feed (`GET /api/v1/feed`, Server-Sent Events, resumed
 * with Last-Event-ID). Devices are Warden's device records: a stable `dev_…` id that
 * keeps every MAC and IP the device used, so a phone's rotating private address, a
 * laptop's second MAC or a new lease doesn't lose it.
 *
 * Kova links by pairing: it asks for the scopes below, shows a code, and you approve it
 * in Warden at /apps; Warden hands Kova a token limited to those scopes. A token made the
 * old way (signing in once, role operator) keeps working.
 */
export interface WardenOptions {
  /** e.g. https://10.10.0.1 or https://router.internal */
  url: string;
  /** Warden API token, from pairing (scoped) or from signing in once (cr_…, role operator). */
  token?: string;
  /** Warden's certificate fingerprint, pinned when linked. */
  fingerprint?: string;
  /** Warden's public key (SHA-256 of its SubjectPublicKeyInfo): trusted even when Warden reissues its certificate. */
  publicKeySha256?: string;
  /** Devices whose internet Kova can pause: by Warden device id, or by a MAC it has used. */
  devices?: { deviceId?: string; mac?: string; name: string; room: string; id?: string }[];
  /** Room for the Internet device. Default: none. */
  room?: string;
  /** How often to re-read the dashboard and devices. Default 60 s with the live feed, 20 s without; 0 turns the timer off (tests call poll()). */
  pollSec?: number;
  /** Follow the live feed. Default on. */
  feed?: boolean;
}

/** What Kova asks Warden for when pairing. */
export const WARDEN_SCOPES = ['devices:read', 'devices:write', 'pause', 'events', 'discovery', 'people:read', 'network:read', 'integration'];

/** Every event on Warden's feed, for the parts of Kova that answer Warden (services/warden-link.ts: power-cycle requests). */
export const wardenFeed = new EventEmitter<{ event: [FeedEvent] }>();

export interface WardenClient {
  mac: string; name?: string; hostname?: string; ip?: string; online?: boolean;
  lastSeenAt?: string; medium?: string; ssid?: string; network?: string;
}

/** One real device, as Warden's /api/v1/devices returns it. */
export interface WardenDevice {
  id: string; name?: string; icon?: string; owner?: string; hostname?: string;
  macs: string[]; privateMac?: boolean; ips: string[]; online: boolean;
  firstSeenAt?: string; lastSeenAt?: string; onlineSince?: string;
  vendor?: string; class?: string; model?: string; os?: string;
  services?: { type: string; name?: string; port?: number }[];
  connection?: { medium: string; ap?: string; ssid?: string; band?: string };
  network?: { id: string; name: string; vlan?: number };
  paused: boolean; pausedUntil?: string; blocked?: boolean; quarantined?: boolean;
}

export interface WardenPerson {
  id: string; name: string; devices: string[]; primaryPhone?: string;
  presence: { home: boolean; since?: string; via?: string; viaDevice?: string; ap?: string };
}

/** One event on Warden's feed. */
export interface FeedEvent { id: string; seq: number; type: string; at: string; data?: any }

interface Incident { id: string; kind: string; level: string; title: string; body?: string; openedAt: string; updatedAt: string; closedAt?: string; detail?: string }
interface Dashboard { wanUp?: boolean; threatsBlocked?: number | null; clientCount?: number; last24h?: { threatsBlocked?: number; dnsBlocked?: number } }
interface SiteDoc { people?: { id: string; devices?: string[] }[] }

export const INTERNET_ID = 'warden_internet';
export const normMac = (m: string) => m.trim().toLowerCase().replace(/-/g, ':').split(':').map(x => x.padStart(2, '0')).join(':');
export const internetId = (mac: string) => `warden_${normMac(mac).replace(/:/g, '')}`;
/** Kova's id for an internet switch: kept from its MAC when it was set up that way, else from Warden's device id. */
export const switchId = (d: NonNullable<WardenOptions['devices']>[number]) => d.id ?? (d.mac ? internetId(d.mac) : `warden_${(d.deviceId ?? '').replace(/^dev_/, '')}`);
/** What to call a Warden device. */
export const deviceLabel = (d: Partial<WardenDevice>) => d.name || d.hostname || d.model || (d.vendor ? `${d.vendor} device` : '') || d.macs?.[0] || 'A device';
const notFound = (e: unknown) => e instanceof LanHttpError && e.status === 404;

/** Talks to one Warden. Shared by the adapter, presence and the setup routes. */
export class Warden {
  readonly url: string;
  constructor(private o: Pick<WardenOptions, 'url' | 'token' | 'fingerprint' | 'publicKeySha256'>) { this.url = trimUrl(o.url); }

  async get<T>(path: string): Promise<T> {
    return (await lanJson<T>(this.url + path, { token: this.o.token, fingerprint: this.o.fingerprint, publicKeySha256: this.o.publicKeySha256 })).json;
  }

  private async send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return (await lanJson<T>(this.url + path, { method, body, token: this.o.token, fingerprint: this.o.fingerprint, publicKeySha256: this.o.publicKeySha256 })).json;
  }

  dashboard(): Promise<Dashboard> { return this.get('/api/v1/dashboard'); }

  devices(q: { online?: boolean; class?: string; owner?: string; network?: string } = {}): Promise<WardenDevice[]> {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return this.get<{ devices?: WardenDevice[] }>(`/api/v1/devices${qs ? `?${qs}` : ''}`).then(r => r.devices ?? []);
  }
  device(id: string): Promise<WardenDevice> { return this.get(`/api/v1/devices/${encodeURIComponent(id)}`); }
  deviceByMac(mac: string): Promise<WardenDevice> { return this.get(`/api/v1/devices/by-mac/${encodeURIComponent(normMac(mac))}`); }
  people(): Promise<WardenPerson[]> { return this.get<{ people?: WardenPerson[] }>('/api/v1/people').then(r => r.people ?? []); }

  /** Pause a device's internet (every MAC it has used), optionally until a time; or lift it. */
  pauseDevice(id: string, paused: boolean, until?: Date): Promise<WardenDevice> {
    return this.send(paused ? 'POST' : 'DELETE', `/api/v1/devices/${encodeURIComponent(id)}/pause`, paused && until ? { until: until.toISOString() } : undefined);
  }
  /** Wake-on-LAN, sent by the router on the device's own network. */
  wake(id: string): Promise<unknown> { return this.send('POST', `/api/v1/devices/${encodeURIComponent(id)}/wake`); }

  /** The feed as a page: the latest events without a cursor, else those after it. */
  feedPage(after?: string, limit = 100): Promise<{ events: FeedEvent[]; next: string; more: boolean; missed?: boolean }> {
    return this.get(`/api/v1/feed?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
  }
  /** Follow the feed live from `after` (or from now). */
  follow(after: string | undefined, onEvent: (e: SseEvent) => void) {
    return lanStream(`${this.url}/api/v1/feed`, { token: this.o.token, fingerprint: this.o.fingerprint, publicKeySha256: this.o.publicKeySha256, lastEventId: after }, onEvent);
  }

  // Before device records (older Warden): clients by MAC, incidents, and the paused list in the site document.
  clients(): Promise<WardenClient[]> { return this.get<{ clients?: WardenClient[] }>('/api/v1/clients').then(r => r.clients ?? []); }
  incidents(since: string): Promise<Incident[]> { return this.get<{ incidents?: Incident[] }>(`/api/v1/events?since=${encodeURIComponent(since)}&limit=100`).then(r => r.incidents ?? []); }
  async paused(): Promise<Set<string>> {
    const doc = await this.get<SiteDoc>('/api/v1/site');
    return new Set((doc.people?.find(p => p.id === 'paused-devices')?.devices ?? []).map(normMac));
  }
  setPaused(mac: string, paused: boolean): Promise<{ paused: boolean }> {
    return this.send(paused ? 'POST' : 'DELETE', `/api/v1/clients/${encodeURIComponent(normMac(mac))}/pause`);
  }
}

// ------------------------------------------------------------ linking --

interface Gateway { url: string; fingerprint?: string; siteName?: string }

/** Find Warden at an address and pin the certificate it presents now. */
async function gateway(url: string): Promise<Gateway> {
  const base = trimUrl(/^https?:\/\//.test(url.trim()) ? url : `https://${url.trim()}`);
  const disc = await lanJson<{ product?: string; siteName?: string; certificateFingerprint?: string }>(`${base}/.well-known/wardenos-gateway`, { timeoutMs: 6000 })
    .catch(e => { throw new Error(`Couldn’t find Warden at ${base}: ${e instanceof Error ? e.message : String(e)}`); });
  if (disc.json?.product !== 'WardenOS') throw new Error(`${base} answered, but it isn’t Warden`);
  return { url: base, fingerprint: disc.fingerprint ?? disc.json.certificateFingerprint, siteName: disc.json.siteName };
}

export interface WardenPairing extends Gateway { pairId: string; code: string; pollSecret: string; expiresAt: string }

/** Ask Warden for access: it shows the same code at /apps for an admin to approve. */
export async function wardenPairStart(url: string): Promise<WardenPairing> {
  const g = await gateway(url);
  try {
    const r = await lanJson<{ pairId: string; code: string; pollSecret: string; expiresAt: string }>(`${g.url}/api/v1/apps/pair`, {
      method: 'POST', body: { name: 'Kova', scopes: WARDEN_SCOPES }, fingerprint: g.fingerprint,
    });
    return { ...g, ...r.json };
  } catch (e) {
    if (notFound(e)) throw new Error('This Warden can’t pair apps yet. Update it, or link by signing in.');
    throw new Error(`Warden didn’t take the request: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type WardenPairPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token?: string; scopes?: string[] };

/** How the request is going. The token comes once, on the first poll after approval. */
export async function wardenPairPoll(p: Pick<WardenPairing, 'url' | 'fingerprint' | 'pairId' | 'pollSecret'>): Promise<WardenPairPoll> {
  try {
    return (await lanJson<WardenPairPoll>(`${p.url}/api/v1/apps/pair/${encodeURIComponent(p.pairId)}`, { fingerprint: p.fingerprint, headers: { 'x-pair-secret': p.pollSecret } })).json;
  } catch (e) {
    if (notFound(e)) return { status: 'expired' };
    throw e;
  }
}

/**
 * Sign in once, make a Kova API token, sign out. Returns what to save.
 * The password is only used for this; Warden shows the token once and stores a hash.
 */
export async function linkWarden(url: string, username: string, password: string, totp?: string): Promise<{ url: string; token: string; fingerprint?: string; siteName?: string }> {
  const { url: base, fingerprint, siteName } = await gateway(url);
  const login = await lanJson<{ session?: { token?: string } }>(`${base}/api/v1/login`, { method: 'POST', body: { username, password, ...(totp ? { totp } : {}) }, fingerprint })
    .catch(e => {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(/one-time code/i.test(m) ? 'Warden wants the one-time code from your authenticator app too' : `Warden didn’t accept that sign-in: ${m}`);
    });
  const session = login.json.session?.token;
  if (!session) throw new Error('Warden didn’t start a session');
  try {
    const made = await lanJson<{ token?: string }>(`${base}/api/v1/tokens`, { method: 'POST', token: session, fingerprint, body: { name: 'Kova', role: 'operator' } });
    if (!made.json.token) throw new Error('Warden didn’t return a token');
    return { url: base, token: made.json.token, fingerprint, siteName };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(/403|admin/i.test(m) ? 'Sign in with a Warden admin account to link Kova' : `Couldn’t make a token for Kova: ${m}`);
  } finally {
    await lanJson(`${base}/api/v1/logout`, { method: 'POST', token: session, fingerprint }).catch(() => {});
  }
}

// ------------------------------------------------------------ adapter --

const RECENT_MS = 5 * 60_000;

export class WardenAdapter implements Adapter {
  id = 'warden';
  name = 'Warden';
  icon = 'router';
  kind = 'Local' as const;
  readonly api: Warden;
  private ctx!: AdapterContext;
  private timer: NodeJS.Timeout | null = null;
  private last: { ok: boolean; note?: string } = { ok: true, note: 'Connecting…' };
  private wanUp: boolean | null = null;
  private polling = false;
  private stopped = false;
  /** Warden without device records or the feed: read clients and incidents instead. */
  private legacy = false;
  /** Incidents already passed on, and where to read from next (legacy). */
  private seen = new Set<string>();
  private since = new Date().toISOString();
  /** The live feed: connected, the last event id, and the open stream. */
  private live = false;
  private cursor: string | undefined;
  private stream: { close: () => void } | null = null;
  private retry: NodeJS.Timeout | null = null;
  /** Kova switch id → Warden device id, once known. */
  private devIds = new Map<string, string>();
  private summary = '';

  constructor(private opts: WardenOptions, private clock: () => number = Date.now) {
    this.api = new Warden(opts);
  }

  private get switches() { return (this.opts.devices ?? []).filter(d => d.deviceId || d.mac); }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.since = new Date(this.clock()).toISOString();
    for (const d of this.switches) if (d.deviceId) this.devIds.set(switchId(d), d.deviceId);
    ctx.announce([
      { id: INTERNET_ID, name: 'Internet', room: this.opts.room ?? 'unassigned', type: 'sensor', capabilities: ['events'], integration: 'Warden', address: this.api.url, state: { on: true, online: true } },
      ...this.switches.map(d => ({
        id: switchId(d), name: d.name, room: d.room, type: 'internet' as const, capabilities: ['onoff' as const],
        integration: 'Warden', address: d.deviceId ?? normMac(d.mac ?? ''), state: { on: true, online: true },
      })),
    ]);
    await this.poll();
    if (this.opts.feed !== false && !this.legacy) this.connect();
    const every = (this.opts.pollSec ?? (this.opts.feed !== false && !this.legacy ? 60 : 20)) * 1000;
    if (every > 0) { this.timer = setInterval(() => void this.poll(), every); this.timer.unref?.(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    this.stream?.close();
    this.stream = null;
    this.live = false;
  }

  status(): AdapterStatus { return this.last; }

  /** Whether the live feed is connected (for tests and the status line). */
  get following(): boolean { return this.live; }

  // ----------------------------------------------------------- the feed --

  private connect(delay = 0): void {
    if (this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.stopped) return;
      const s = this.api.follow(this.cursor, e => this.onSse(e));
      this.stream = s;
      s.done.then(
        () => this.dropped(3000),
        err => {
          // An older Warden has no feed: stay on polling.
          if (err instanceof LanHttpError && (err.status === 404 || err.status === 415)) { this.live = false; this.legacy = true; this.status_(); return; }
          this.dropped(/401|403/.test(String(err?.message)) ? 60_000 : Math.min(60_000, (delay || 1500) * 2));
        },
      );
    }, delay);
    this.retry.unref?.();
  }

  private dropped(next: number): void {
    this.stream = null;
    if (this.stopped) return;
    if (this.live) { this.live = false; this.status_(); }
    this.connect(next);
  }

  private onSse(e: SseEvent): void {
    if (!this.live) { this.live = true; this.status_(); }
    if (e.event === 'feed.missed') { void this.poll(); return; }
    if (e.event === 'feed.closed') return;
    let ev: FeedEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (e.id) this.cursor = e.id;
    this.onFeed(ev);
  }

  /** One event from Warden's feed. */
  onFeed(ev: FeedEvent): void {
    wardenFeed.emit('event', ev);
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'wan.down': this.onWan(false); break;
      case 'wan.up': this.onWan(true); break;
      case 'wan.failover':
        this.ctx.event(INTERNET_ID, 'internet-failover', { title: `Switched to ${d.wanName ?? d.wan ?? 'the backup connection'}`, body: `${d.fromName ?? d.from ?? 'The main connection'} stopped answering.` });
        break;
      case 'threat.blocked':
      case 'ids.alert': {
        const who = d.device?.name || d.device?.ip;
        this.ctx.event(INTERNET_ID, 'threat', { title: d.title ?? 'Warden blocked an attack', body: [d.body, who && ev.type === 'ids.alert' ? `Device: ${who}` : ''].filter(Boolean).join(' '), device: d.device?.deviceId ?? '' });
        break;
      }
      case 'device.new': {
        const dev = d.device as WardenDevice | undefined;
        if (!dev) break;
        const what = [dev.vendor, dev.class].filter(Boolean).join(' ');
        this.ctx.event(INTERNET_ID, 'new-device', {
          title: `${deviceLabel(dev)} joined ${dev.network?.name ?? 'your network'}`,
          body: [what && `A ${what}.`, 'Open Warden to name it or block it.'].filter(Boolean).join(' '),
          device: dev.id,
        });
        break;
      }
      case 'device.joined': case 'device.left': case 'device.updated': case 'device.roamed': case 'device.ip_changed':
        if (d.device) this.onDevice(d.device as WardenDevice);
        break;
      case 'pause.changed': {
        const byMac = this.switches.find(s => s.mac && d.mac && normMac(s.mac) === normMac(d.mac));
        const kid = (d.deviceId && this.kovaIdFor(d.deviceId)) || (byMac && switchId(byMac));
        if (kid) this.ctx.report(kid, { on: !d.paused });
        break;
      }
    }
  }

  private kovaIdFor(devId: string): string | undefined {
    for (const [kid, did] of this.devIds) if (did === devId) return kid;
    return undefined;
  }

  /** A device record changed: if it's one of the switches, its online and paused state. */
  private onDevice(dev: WardenDevice): void {
    const macs = new Set(dev.macs.map(normMac));
    for (const s of this.switches) {
      const kid = switchId(s);
      const mine = this.devIds.get(kid) === dev.id || (!this.devIds.has(kid) && !!s.mac && macs.has(normMac(s.mac)));
      if (!mine) continue;
      this.devIds.set(kid, dev.id);
      this.ctx.report(kid, { on: !dev.paused, online: dev.online });
    }
  }

  // ------------------------------------------------------------ polling --

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const dash = await this.api.dashboard();
      this.onWan(dash.wanUp !== false);
      let count = dash.clientCount ?? 0;
      if (!this.legacy) {
        try {
          const devices = await this.api.devices();
          for (const dev of devices) this.onDevice(dev);
          count = devices.filter(d => d.online).length;
        } catch (e) {
          if (!notFound(e)) throw e;
          this.legacy = true;
        }
      }
      if (this.legacy) await this.pollLegacy();
      const blocked = dash.last24h?.threatsBlocked ?? dash.threatsBlocked;
      this.summary = `${dash.wanUp === false ? 'Internet down' : 'Internet up'} · ${count} devices online${blocked ? ` · ${Math.round(blocked)} threats blocked today` : ''}`;
      this.status_();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.last = { ok: false, note: /401|403/.test(m) ? 'Warden no longer accepts Kova’s token. Link it again.' : `Can’t reach Warden: ${m}` };
      this.ctx.report(INTERNET_ID, { online: false });
    } finally {
      this.polling = false;
    }
  }

  private status_(): void {
    if (!this.summary) return;
    this.last = { ok: true, note: `${this.summary}${this.live ? ' · live' : ''}` };
  }

  /** Older Warden: incidents for events, clients by MAC for the switches. */
  private async pollLegacy(): Promise<void> {
    for (const i of await this.api.incidents(this.since)) this.onIncident(i);
    if (!this.switches.length) return;
    const [paused, clients] = await Promise.all([this.api.paused(), this.api.clients()]);
    const byMac = new Map(clients.map(c => [normMac(c.mac), c]));
    for (const d of this.switches) {
      if (!d.mac) continue;
      const c = byMac.get(normMac(d.mac));
      const recent = !!c?.lastSeenAt && this.clock() - Date.parse(c.lastSeenAt) < RECENT_MS;
      this.ctx.report(switchId(d), { on: !paused.has(normMac(d.mac)), online: !!c && (recent || !c.lastSeenAt) });
    }
  }

  private onWan(up: boolean): void {
    const was = this.wanUp;
    this.wanUp = up;
    this.ctx.report(INTERNET_ID, { on: up, online: true });
    if (was !== null && was !== up) this.ctx.event(INTERNET_ID, up ? 'internet-up' : 'internet-down');
  }

  private onIncident(i: Incident): void {
    if (Date.parse(i.updatedAt) > Date.parse(this.since)) this.since = new Date(Date.parse(i.updatedAt)).toISOString();
    if (this.seen.has(i.id) || i.closedAt) return;
    this.seen.add(i.id);
    if (i.kind === 'device.new') this.ctx.event(INTERNET_ID, 'new-device', { title: i.title, body: i.body ?? '' });
    else if ((i.kind === 'attack' || i.kind === 'security') && i.level === 'act') this.ctx.event(INTERNET_ID, 'threat', { title: i.title, body: i.body ?? '' });
  }

  // ----------------------------------------------------------- commands --

  async command(device: Device, cmd: Command): Promise<void> {
    if (device.id === INTERNET_ID) throw new Error('The internet can’t be switched from Kova');
    if (cmd.on === undefined) return;
    const s = this.switches.find(x => switchId(x) === device.id);
    let devId = this.devIds.get(device.id);
    if (!devId && s?.mac && !this.legacy) {
      devId = await this.api.deviceByMac(s.mac).then(d => d.id, e => { if (notFound(e)) return undefined; throw e; });
      if (devId) this.devIds.set(device.id, devId);
    }
    if (devId) { await this.api.pauseDevice(devId, !cmd.on); return; }
    const mac = s?.mac ?? device.address;
    if (!/^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/i.test(mac)) throw new Error(`Warden doesn’t know ${device.name} any more`);
    await this.api.setPaused(mac, !cmd.on);
  }
}
