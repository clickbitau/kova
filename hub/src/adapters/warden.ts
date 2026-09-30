import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';
import { lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * Warden OS, the home's router (ClickBIT's own). Kova reads it over its REST API
 * (`/api/v1`) with a long-lived API token, and gets:
 *  - an **Internet** device: on while the internet is up, with events when it
 *    goes down or comes back, a new device joins, or Warden blocks an attack;
 *  - an **internet switch** per device you choose (a child's tablet, a console):
 *    off pauses that device's internet in Warden, so modes can do bedtime;
 *  - who's home, from phones on the network (see services/presence.ts).
 * Linking signs in once and makes a token named "Kova"; the password isn't kept.
 */
export interface WardenOptions {
  /** e.g. https://10.10.0.1 or https://router.internal */
  url: string;
  /** A Warden API token (cr_…), made by linking, or by hand in Warden → System → API tokens (role operator). */
  token?: string;
  /** Warden's certificate fingerprint, pinned when linked. */
  fingerprint?: string;
  /** Devices whose internet Kova can pause. */
  devices?: { mac: string; name: string; room: string; id?: string }[];
  /** Room for the Internet device. Default: none. */
  room?: string;
  /** Poll interval. Default 20 s; 0 turns the timer off (tests call poll()). */
  pollSec?: number;
}

export interface WardenClient {
  mac: string; name?: string; hostname?: string; ip?: string; online?: boolean;
  lastSeenAt?: string; medium?: string; ssid?: string; network?: string;
}

interface Incident { id: string; kind: string; level: string; title: string; body?: string; openedAt: string; updatedAt: string; closedAt?: string; detail?: string }
interface Dashboard { wanUp?: boolean; threatsBlocked?: number | null; clientCount?: number; last24h?: { threatsBlocked?: number; dnsBlocked?: number } }
interface SiteDoc { people?: { id: string; devices?: string[] }[] }

export const INTERNET_ID = 'warden_internet';
export const normMac = (m: string) => m.trim().toLowerCase().replace(/-/g, ':').split(':').map(x => x.padStart(2, '0')).join(':');
export const internetId = (mac: string) => `warden_${normMac(mac).replace(/:/g, '')}`;

/** Talks to one Warden. Shared by the adapter, presence and the setup routes. */
export class Warden {
  readonly url: string;
  constructor(private o: Pick<WardenOptions, 'url' | 'token' | 'fingerprint'>) { this.url = trimUrl(o.url); }

  async get<T>(path: string): Promise<T> {
    return (await lanJson<T>(this.url + path, { token: this.o.token, fingerprint: this.o.fingerprint })).json;
  }

  private async send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return (await lanJson<T>(this.url + path, { method, body, token: this.o.token, fingerprint: this.o.fingerprint })).json;
  }

  clients(): Promise<WardenClient[]> { return this.get<{ clients?: WardenClient[] }>('/api/v1/clients').then(r => r.clients ?? []); }
  dashboard(): Promise<Dashboard> { return this.get('/api/v1/dashboard'); }
  incidents(since: string): Promise<Incident[]> { return this.get<{ incidents?: Incident[] }>(`/api/v1/events?since=${encodeURIComponent(since)}&limit=100`).then(r => r.incidents ?? []); }

  /** MACs whose internet is paused (Warden keeps them as the "paused-devices" person). */
  async paused(): Promise<Set<string>> {
    const doc = await this.get<SiteDoc>('/api/v1/site');
    return new Set((doc.people?.find(p => p.id === 'paused-devices')?.devices ?? []).map(normMac));
  }

  setPaused(mac: string, paused: boolean): Promise<{ paused: boolean }> {
    return this.send(paused ? 'POST' : 'DELETE', `/api/v1/clients/${encodeURIComponent(normMac(mac))}/pause`);
  }
}

/**
 * Sign in once, make a Kova API token, sign out. Returns what to save.
 * The password is only used for this; Warden shows the token once and stores a hash.
 */
export async function linkWarden(url: string, username: string, password: string, totp?: string): Promise<{ url: string; token: string; fingerprint?: string; siteName?: string }> {
  const base = trimUrl(/^https?:\/\//.test(url.trim()) ? url : `https://${url.trim()}`);
  const disc = await lanJson<{ product?: string; siteName?: string; certificateFingerprint?: string }>(`${base}/.well-known/wardenos-gateway`, { timeoutMs: 6000 })
    .catch(e => { throw new Error(`Couldn’t find Warden at ${base}: ${e instanceof Error ? e.message : String(e)}`); });
  if (disc.json?.product !== 'WardenOS') throw new Error(`${base} answered, but it isn’t Warden`);
  // Pin the certificate we're talking to now (the one the gateway describes, when it says).
  const fingerprint = disc.fingerprint ?? disc.json.certificateFingerprint;
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
    return { url: base, token: made.json.token, fingerprint, siteName: disc.json.siteName };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(/403|admin/i.test(m) ? 'Sign in with a Warden admin account to link Kova' : `Couldn’t make a token for Kova: ${m}`);
  } finally {
    await lanJson(`${base}/api/v1/logout`, { method: 'POST', token: session, fingerprint }).catch(() => {});
  }
}

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
  /** Incidents already passed on, and where to read from next. */
  private seen = new Set<string>();
  private since = new Date().toISOString();
  private polling = false;

  constructor(private opts: WardenOptions, private clock: () => number = Date.now) {
    this.api = new Warden(opts);
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.since = new Date(this.clock()).toISOString();
    ctx.announce([
      { id: INTERNET_ID, name: 'Internet', room: this.opts.room ?? 'unassigned', type: 'sensor', capabilities: ['events'], integration: 'Warden', address: this.api.url, state: { on: true, online: true } },
      ...(this.opts.devices ?? []).map(d => ({
        id: d.id ?? internetId(d.mac), name: d.name, room: d.room, type: 'internet' as const, capabilities: ['onoff' as const],
        integration: 'Warden', address: normMac(d.mac), state: { on: true, online: true },
      })),
    ]);
    const every = (this.opts.pollSec ?? 20) * 1000;
    await this.poll();
    if (every > 0) { this.timer = setInterval(() => void this.poll(), every); this.timer.unref?.(); }
  }

  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; }

  status(): AdapterStatus { return this.last; }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [dash, incidents] = await Promise.all([this.api.dashboard(), this.api.incidents(this.since)]);
      this.onWan(dash.wanUp !== false);
      for (const i of incidents) this.onIncident(i);
      if (this.opts.devices?.length) {
        const [paused, clients] = await Promise.all([this.api.paused(), this.api.clients()]);
        const byMac = new Map(clients.map(c => [normMac(c.mac), c]));
        for (const d of this.opts.devices) {
          const c = byMac.get(normMac(d.mac));
          const recent = !!c?.lastSeenAt && this.clock() - Date.parse(c.lastSeenAt) < RECENT_MS;
          this.ctx.report(d.id ?? internetId(d.mac), { on: !paused.has(normMac(d.mac)), online: !!c && (recent || !c.lastSeenAt) });
        }
      }
      const blocked = dash.last24h?.threatsBlocked ?? dash.threatsBlocked;
      this.last = { ok: true, note: `${dash.wanUp === false ? 'Internet down' : 'Internet up'} · ${dash.clientCount ?? 0} devices online${blocked ? ` · ${Math.round(blocked)} threats blocked today` : ''}` };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.last = { ok: false, note: /401|403/.test(m) ? 'Warden no longer accepts Kova’s token. Link it again.' : `Can’t reach Warden: ${m}` };
      this.ctx.report(INTERNET_ID, { online: false });
    } finally {
      this.polling = false;
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

  async command(device: Device, cmd: Command): Promise<void> {
    if (device.id === INTERNET_ID) throw new Error('The internet can’t be switched from Kova');
    if (cmd.on === undefined) return;
    await this.api.setPaused(device.address, !cmd.on);
  }
}
