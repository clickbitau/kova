import os from 'node:os';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';
import { lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * Helix, the home's media server and TV box (ClickBIT's own). Each Helix box
 * becomes a TV in Kova: what it's playing, pause and carry on, volume, stop,
 * and "play <film or show>" by name. It also sends events Kova acts on:
 * `video-started` (Movie mode can start by itself), `music-started`, `paused`, `stopped`.
 *
 * Kova pairs with Helix Server like any Helix app: it asks for a code, you type
 * it in Helix Server → Devices, and Kova gets its own device token (revoke it there).
 * Boxes come from the server; their remote port (8080, LAN only) takes play and volume.
 */
export interface HelixOptions {
  /** Helix Server, e.g. http://10.10.10.101:8090 */
  url: string;
  /** Kova's device token (hxd_…), from pairing. */
  token?: string;
  /** Box name → Kova room id. Boxes not listed go to no room. */
  rooms?: Record<string, string>;
  /** How often to read what the boxes are doing. Default 3 s; 0 turns the timer off (tests call poll()). */
  pollSec?: number;
  /** How often to look for new boxes. Default 60 s. */
  boxesSec?: number;
}

interface Box { id: string; name: string; client?: string; address?: string; remoteUrl?: string; online?: boolean }
export interface BoxState {
  mode?: 'browse' | 'video' | 'music'; screen?: string; title?: string; eyebrow?: string; itemId?: string;
  paused?: boolean; volume?: number; muted?: boolean; position?: number; duration?: number;
}
interface Item { id: string; kind: string; title: string; year?: number; seasonNo?: number; episodeNo?: number; parentId?: string; hasFile?: boolean; status?: string }

export const boxDeviceId = (name: string) => `helix_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'box'}`;

/** What Kova shows for a box: on while something plays or is paused, and what it is. */
export function boxState(s: BoxState | null, online: boolean): DeviceState {
  const active = !!s && (s.mode === 'video' || s.mode === 'music') && !!s.title;
  return {
    on: active,
    media: active ? s!.title! : null,
    paused: active ? !!s!.paused : false,
    vol: s?.volume != null ? Math.round(s.volume) : null,
    online,
  };
}

const HEADERS = { 'x-helix-client': 'kova/1', 'x-helix-device': 'Kova' };

export class HelixApi {
  readonly url: string;
  constructor(private o: Pick<HelixOptions, 'url' | 'token'>) { this.url = trimUrl(o.url); }
  async get<T>(path: string): Promise<T> {
    return (await lanJson<T>(this.url + path, { token: this.o.token, headers: HEADERS })).json;
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await lanJson<T>(this.url + path, { method: 'POST', body, token: this.o.token, headers: HEADERS })).json;
  }
  boxes(): Promise<Box[]> { return this.get<{ boxes?: Box[] }>('/v1/boxes').then(r => r.boxes ?? []); }
  state(boxId: string): Promise<BoxState> { return this.get(`/v1/boxes/${encodeURIComponent(boxId)}/state`); }
  key(boxId: string, key: string): Promise<unknown> { return this.post(`/v1/boxes/${encodeURIComponent(boxId)}/key/${key}`); }

  /** Find what to play for a spoken title: a film, or a show's next episode (resuming where you left off). */
  async resolve(q: string): Promise<{ item: Item; positionMs: number }> {
    const found = (await this.get<{ items?: Item[] }>(`/v1/search?q=${encodeURIComponent(q)}`)).items ?? [];
    const have = (i: Item) => i.hasFile !== false && (i.status == null || i.status === 'have');
    const pick = found.find(i => (i.kind === 'movie' || i.kind === 'show' || i.kind === 'episode') && have(i))
      ?? found.find(i => i.kind === 'movie' || i.kind === 'show' || i.kind === 'episode');
    if (!pick) throw new Error(`Helix has nothing called “${q}”`);
    if (pick.kind !== 'show') return { item: pick, positionMs: 0 };
    const seasons = ((await this.get<{ items?: Item[] }>(`/v1/items/${encodeURIComponent(pick.id)}/children`)).items ?? [])
      .filter(s => (s.seasonNo ?? 1) >= 1).sort((a, b) => (a.seasonNo ?? 0) - (b.seasonNo ?? 0));
    const ids = new Set(seasons.map(s => s.id));
    const kw = (await this.get<{ items?: { item: Item; positionMs?: number }[] }>('/v1/keep-watching?limit=50').catch(() => ({ items: [] }))).items ?? [];
    const next = kw.find(k => k.item.kind === 'episode' && k.item.parentId && ids.has(k.item.parentId));
    if (next) return { item: next.item, positionMs: next.positionMs ?? 0 };
    for (const s of seasons) {
      const eps = ((await this.get<{ items?: Item[] }>(`/v1/items/${encodeURIComponent(s.id)}/children`)).items ?? [])
        .filter(e => e.kind === 'episode').sort((a, b) => (a.episodeNo ?? 0) - (b.episodeNo ?? 0));
      const e = eps.find(have) ?? eps[0];
      if (e) return { item: e, positionMs: 0 };
    }
    throw new Error(`Helix has no episodes of ${pick.title} yet`);
  }
}

// ------------------------------------------------------------ pairing --

export interface PairStart { pairingId: string; code: string; expiresIn: number; pollInterval?: number }
export type PairPoll = { status: 'pending' } | { status: 'approved'; token: string; serverId?: string } | { status: 'expired' };

export async function helixPairStart(url: string): Promise<PairStart> {
  return (await lanJson<PairStart>(`${trimUrl(url)}/v1/pair/start`, { method: 'POST', body: { name: 'Kova' }, headers: HEADERS })).json;
}

export async function helixPairPoll(url: string, pairingId: string): Promise<PairPoll> {
  try {
    return (await lanJson<PairPoll>(`${trimUrl(url)}/v1/pair/${encodeURIComponent(pairingId)}`, { headers: HEADERS })).json;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { status: 'expired' };
    throw e;
  }
}

/** Helix Server doesn't announce itself, so look on the hub's own networks the way the Helix apps do: port 8090, /v1/hello. */
export async function findHelixServers(opts: { port?: number; timeoutMs?: number; hosts?: string[] } = {}): Promise<{ name: string; url: string; version?: string }[]> {
  const port = opts.port ?? 8090;
  const hosts = opts.hosts ?? Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal && a.cidr?.endsWith('/24'))
    .flatMap(a => { const base = a!.address.split('.').slice(0, 3).join('.'); return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`); });
  const found: { name: string; url: string; version?: string }[] = [];
  await Promise.all([...new Set(hosts)].map(async h => {
    const url = `http://${h}:${port}`;
    try {
      const r = await lanJson<{ helix?: boolean; name?: string; version?: string }>(`${url}/v1/hello`, { timeoutMs: opts.timeoutMs ?? 1200 });
      if (r.json?.helix) found.push({ name: `${r.json.name ?? 'Helix Server'} at ${url}`, url, version: r.json.version });
    } catch { /* nothing there */ }
  }));
  return found;
}

// ------------------------------------------------------------ adapter --

export class HelixAdapter implements Adapter {
  id = 'helix';
  name = 'Helix';
  icon = 'movie';
  kind = 'Local' as const;
  readonly api: HelixApi;
  private ctx!: AdapterContext;
  private boxes = new Map<string, Box>();
  /** What Kova believes each box is doing (read, or just asked for). */
  private states = new Map<string, DeviceState>();
  /** What each box last said itself: events come from changes here, so a film Kova started still counts as starting. */
  private observed = new Map<string, DeviceState>();
  private timers: NodeJS.Timeout[] = [];
  private last: AdapterStatus = { ok: true, note: 'Connecting…' };
  private polling = false;

  constructor(private opts: HelixOptions) { this.api = new HelixApi(opts); }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!this.opts.token) { this.last = { ok: false, note: 'Not paired yet. Use Pair with Helix.' }; return; }
    await this.refreshBoxes();
    await this.poll();
    const every = (this.opts.pollSec ?? 3) * 1000;
    if (every > 0) {
      this.timers.push(setInterval(() => void this.poll(), every));
      this.timers.push(setInterval(() => void this.refreshBoxes(), (this.opts.boxesSec ?? 60) * 1000));
      this.timers.forEach(t => t.unref?.());
    }
  }

  async stop(): Promise<void> { this.timers.forEach(clearInterval); this.timers = []; }

  status(): AdapterStatus { return this.last; }

  private roomOf(b: Box): string {
    const r = this.opts.rooms ?? {};
    return r[b.name] ?? Object.entries(r).find(([k]) => k.toLowerCase() === b.name.toLowerCase())?.[1] ?? 'unassigned';
  }

  async refreshBoxes(): Promise<void> {
    try {
      // A box that hasn't been paired by name shows up by its address.
      const boxes = (await this.api.boxes()).map(b => ({ ...b, name: b.name?.trim() || `Helix box ${b.address ?? ''}`.trim() }));
      const fresh = boxes.filter(b => !this.boxes.has(boxDeviceId(b.name)));
      for (const b of boxes) this.boxes.set(boxDeviceId(b.name), b);
      if (fresh.length) {
        this.ctx.announce(fresh.map(b => ({
          id: boxDeviceId(b.name), name: b.name, room: this.roomOf(b), type: 'tv' as const,
          capabilities: ['onoff', 'media', 'volume', 'pause', 'library'] as Device['capabilities'],
          integration: 'Helix', address: b.id, state: { on: false, online: !!b.online },
        })));
      }
      this.last = { ok: true, note: boxes.length ? `${boxes.length} box${boxes.length === 1 ? '' : 'es'}` : 'Paired. No Helix box has used this server yet.' };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.last = { ok: false, note: /401|403/.test(m) ? 'Helix no longer accepts Kova. Pair again.' : `Can’t reach Helix Server: ${m}` };
    }
  }

  /** Read every box's state and pass on what changed, with the events modes act on. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.boxes].map(async ([id, b]) => {
        let s: BoxState | null = null;
        let online = !!b.online;
        try { s = await this.api.state(b.id); online = true; } catch { online = false; }
        const next = boxState(s, online);
        const prev = this.observed.get(id);
        this.observed.set(id, next);
        this.states.set(id, next);
        this.ctx.report(id, next);
        if (!online) return;
        const kind = s?.mode === 'music' ? 'music' : 'video';
        const data = { title: next.media ?? '', what: s?.eyebrow ?? '' };
        if (next.on && !next.paused && (!prev?.on || prev.media !== next.media)) this.ctx.event(id, `${kind}-started`, data);
        else if (next.on && next.paused && prev?.on && !prev.paused) this.ctx.event(id, 'paused', data);
        else if (next.on && !next.paused && prev?.on && prev.paused) this.ctx.event(id, 'resumed', data);
        else if (!next.on && prev?.on) this.ctx.event(id, 'stopped', { title: prev.media ?? '' });
      }));
    } finally {
      this.polling = false;
    }
  }

  private box(device: Device): Box {
    const b = this.boxes.get(device.id);
    if (!b) throw new Error(`${device.name} isn’t known to Helix Server any more`);
    return b;
  }

  private async remote(b: Box, path: string, body: unknown): Promise<void> {
    if (!b.remoteUrl) throw new Error(`${b.name} hasn’t told Helix where to reach it`);
    await lanJson(`${trimUrl(b.remoteUrl)}${path}`, { method: 'POST', body, timeoutMs: 5000 });
  }

  async command(device: Device, cmd: Command): Promise<void | DeviceState> {
    const b = this.box(device);
    const cur = this.states.get(device.id) ?? boxState(null, true);
    const stop = cmd.on === false || cmd.media === null;
    let did: DeviceState | undefined;
    if (typeof cmd.media === 'string' && cmd.media && cmd.media !== cur.media) {
      const { item, positionMs } = await this.api.resolve(cmd.media);
      await this.remote(b, '/play', { itemId: item.id, positionMs });
      did = { on: true, media: item.title, paused: false };
    } else if (stop && cur.on) {
      // Out of the player: Back leaves a film, Stop ends music.
      const s = await this.api.state(b.id).catch(() => null);
      await this.api.key(b.id, s?.mode === 'music' ? 'mstop' : 'back');
      did = { on: false, media: null, paused: false };
    } else if (cmd.paused !== undefined && cur.on && cmd.paused !== !!cur.paused) {
      await this.api.key(b.id, 'playpause');
    } else if (cmd.on === true && cur.on && cur.paused) {
      await this.api.key(b.id, 'playpause');
      did = { paused: false };
    }
    if (cmd.vol != null) await this.remote(b, '/volume', { level: Math.max(0, Math.min(100, Math.round(cmd.vol))) });
    this.states.set(device.id, { ...cur, ...cmd, ...did });
    return did;
  }
}
