import os from 'node:os';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';
import { LanHttpError, lanJson, lanStream, trimUrl, type SseEvent } from '../util/lan-http.ts';

/**
 * Helix, the home's media server and TV box (ClickBIT's own). Each Helix box
 * becomes a TV in Kova: what it's playing, pause and carry on, volume, stop,
 * and "play <film or show>" by name. It also sends events Kova acts on:
 * `video-started` (Movie mode can start by itself), `music-started`, `paused`, `stopped`.
 *
 * Kova pairs with Helix Server like any Helix app: it asks for a code, you type
 * it in Helix Server → Devices, and Kova gets its own device token (revoke it there).
 * Everything goes through the server: boxes from `/v1/boxes`, what's playing live from
 * `/v1/events` (playback.started/paused/resumed/stopped/ended, player.online/offline),
 * control through `/v1/players/{id}/…` (the server holds each box's remote key), and
 * "play X" decided by `/v1/resolve`.
 */
export interface HelixOptions {
  /** Helix Server, e.g. http://10.10.10.101:8090 */
  url: string;
  /** Kova's device token (hxd_…), from pairing. */
  token?: string;
  /** Box name → Kova room id. Boxes not listed go to no room. */
  rooms?: Record<string, string>;
  /** How often to read what the boxes are doing while the live feed is down. Default 3 s (30 s with the feed); 0 turns the timer off (tests call poll()). */
  pollSec?: number;
  /** Follow Helix's live feed. Default on. */
  feed?: boolean;
  /** How often to look for new boxes. Default 60 s. */
  boxesSec?: number;
}

interface Box { id: string; name: string; client?: string; address?: string; remoteUrl?: string; online?: boolean }
export interface BoxState {
  mode?: 'browse' | 'video' | 'music'; screen?: string; title?: string; eyebrow?: string; itemId?: string;
  paused?: boolean; volume?: number; muted?: boolean; position?: number; duration?: number;
}

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

/** A title as Helix's playback events and /v1/resolve describe it. */
export interface HelixItem { id: string; kind: string; title: string; show?: string; season?: number; episode?: number; year?: number }
/** One event on Helix's live feed (`GET /v1/events` as Server-Sent Events). */
export interface PlaybackEvent {
  type: string; at?: number;
  player?: { id: string; name?: string; client?: string };
  item?: HelixItem; profile?: { id: string; name: string } | null;
  state?: string; positionMs?: number; durationMs?: number; reason?: string;
}

/** "S01E02" for an episode, else nothing. */
const episodeTag = (i?: HelixItem) => i?.kind === 'episode' && i.season && i.episode ? `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : '';

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

  /** Control a screen through the server (which carries the box's remote key): play, pause, resume, stop, volume… */
  control<T = unknown>(playerId: string, verb: 'play' | 'pause' | 'resume' | 'stop' | 'next' | 'previous' | 'seek' | 'volume' | 'mute' | 'tracks', body?: unknown): Promise<T> {
    return this.post(`/v1/players/${encodeURIComponent(playerId)}/${verb}`, body ?? {});
  }

  /** A card on the screen over whatever plays (D98.5): title, body, a picture Helix fetches from imageUrl, for some seconds. */
  notify(playerId: string, n: { title: string; body?: string; imageUrl?: string; seconds?: number }): Promise<unknown> {
    return this.post(`/v1/players/${encodeURIComponent(playerId)}/notify`, n);
  }

  /** What to play for spoken words, decided by Helix: the episode you're on and where you stopped, a film, music. */
  async resolve(q: string): Promise<{ item: HelixItem; positionMs: number; reason?: string }> {
    try {
      return await this.get(`/v1/resolve?q=${encodeURIComponent(q)}`);
    } catch (e) {
      if (e instanceof LanHttpError && e.status === 404) throw new Error(`Helix has nothing called “${q}”`);
      throw e;
    }
  }

  /** Follow Helix's live feed from `after` (or from now). */
  follow(after: string | undefined, onEvent: (e: SseEvent) => void) {
    return lanStream(`${this.url}/v1/events`, { token: this.o.token, headers: HEADERS, lastEventId: after, idleMs: 75_000 }, onEvent);
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
  private stopped = false;
  /** The live feed: connected, the last event id, the open stream, and when boxes were last read in full. */
  private live = false;
  private cursor: string | undefined;
  private stream: { close: () => void } | null = null;
  private retry: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  private summary = '';

  constructor(private opts: HelixOptions) { this.api = new HelixApi(opts); }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    if (!this.opts.token) { this.last = { ok: false, note: 'Not paired yet. Use Pair with Helix.' }; return; }
    await this.refreshBoxes();
    await this.poll();
    if (this.opts.feed !== false) this.connect();
    const every = (this.opts.pollSec ?? 3) * 1000;
    if (every > 0) {
      // While the feed is live, boxes are only re-read every 30 s (volume, and as a check).
      this.timers.push(setInterval(() => { if (!this.live || Date.now() - this.lastPoll >= 30_000) void this.poll(); }, every));
      this.timers.push(setInterval(() => void this.refreshBoxes(), (this.opts.boxesSec ?? 60) * 1000));
      this.timers.forEach(t => t.unref?.());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stream?.close();
    this.stream = null;
    this.live = false;
  }

  status(): AdapterStatus { return this.last; }

  /** Whether the live feed is connected. */
  get following(): boolean { return this.live; }

  private roomOf(b: Box): string {
    const r = this.opts.rooms ?? {};
    return r[b.name] ?? Object.entries(r).find(([k]) => k.toLowerCase() === b.name.toLowerCase())?.[1] ?? 'unassigned';
  }

  private setStatus(): void {
    if (this.summary) this.last = { ok: true, note: `${this.summary}${this.live ? ' · live' : ''}` };
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
      this.summary = boxes.length ? `${boxes.length} box${boxes.length === 1 ? '' : 'es'}` : 'Paired. No Helix box has used this server yet.';
      this.setStatus();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.last = { ok: false, note: /401|403/.test(m) ? 'Helix no longer accepts Kova. Pair again.' : `Can’t reach Helix Server: ${m}` };
    }
  }

  /** A box's Kova id from Helix's player id. */
  private byPlayer(playerId: string): string | undefined {
    for (const [id, b] of this.boxes) if (b.id === playerId) return id;
    return undefined;
  }

  /** Pass on a box's new state, with the events modes act on when it changed. */
  private observe(id: string, next: DeviceState, kind: 'video' | 'music', what = ''): void {
    const prev = this.observed.get(id);
    this.observed.set(id, next);
    this.states.set(id, next);
    this.ctx.report(id, next);
    if (next.online === false) return;
    const data = { title: next.media ?? '', what };
    if (next.on && !next.paused && (!prev?.on || prev.media !== next.media)) this.ctx.event(id, `${kind}-started`, data);
    else if (next.on && next.paused && prev?.on && !prev.paused) this.ctx.event(id, 'paused', data);
    else if (next.on && !next.paused && prev?.on && prev.paused) this.ctx.event(id, 'resumed', data);
    else if (!next.on && prev?.on) this.ctx.event(id, 'stopped', { title: prev.media ?? '' });
  }

  /**
   * Read every box's state. Without the live feed this is how Kova follows them (every 3 s);
   * with it, only volume and whether the box answers are taken from here.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPoll = Date.now();
    try {
      await Promise.all([...this.boxes].map(async ([id, b]) => {
        let s: BoxState | null = null;
        let online = !!b.online;
        try { s = await this.api.state(b.id); online = true; } catch { online = false; }
        const read = boxState(s, online);
        if (this.live) {
          const cur = this.observed.get(id) ?? boxState(null, online);
          const next = { ...cur, vol: read.vol, online };
          this.observed.set(id, next);
          this.states.set(id, { ...(this.states.get(id) ?? next), vol: read.vol, online });
          this.ctx.report(id, { vol: read.vol, online });
          return;
        }
        this.observe(id, read, s?.mode === 'music' ? 'music' : 'video', s?.eyebrow ?? '');
      }));
    } finally {
      this.polling = false;
    }
  }

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
          // An older Helix without playback events on the feed: keep polling.
          if (err instanceof LanHttpError && (err.status === 404 || err.status === 415)) { this.live = false; this.setStatus(); return; }
          this.dropped(/401|403/.test(String(err?.message)) ? 60_000 : Math.min(60_000, (delay || 1500) * 2));
        },
      );
    }, delay);
    this.retry.unref?.();
  }

  private dropped(next: number): void {
    this.stream = null;
    if (this.stopped) return;
    if (this.live) { this.live = false; this.setStatus(); }
    this.connect(next);
  }

  private onSse(e: SseEvent): void {
    if (e.id) this.cursor = e.id;
    if (e.event === 'hello') {
      // Connected: read every box once, so what changed while Kova wasn't listening is caught up.
      this.live = false;
      void this.poll().then(() => { this.live = true; this.setStatus(); });
      return;
    }
    if (e.event === 'reset') { const was = this.live; this.live = false; void this.poll().then(() => { this.live = was; }); return; }
    if (!/^(playback|player)\./.test(e.event)) return;
    let ev: PlaybackEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    this.onPlayback({ ...ev, type: ev.type ?? e.event });
  }

  /** One playback or player event from Helix's feed. */
  onPlayback(ev: PlaybackEvent): void {
    const id = ev.player?.id ? this.byPlayer(ev.player.id) : undefined;
    if (!id) return;
    const cur = this.observed.get(id) ?? boxState(null, true);
    const kind = ev.item?.kind === 'music' ? 'music' : 'video';
    const title = ev.item?.title || cur.media || '';
    switch (ev.type) {
      case 'playback.started':
      case 'playback.resumed':
        this.observe(id, { ...cur, on: true, media: title, paused: false, online: true }, kind, episodeTag(ev.item));
        break;
      case 'playback.paused':
        this.observe(id, { ...cur, on: true, media: title, paused: true, online: true }, kind, episodeTag(ev.item));
        break;
      case 'playback.stopped':
      case 'playback.ended':
        // Another title began on it: playback.started follows straight away.
        if (ev.reason === 'replaced') break;
        this.observe(id, { ...cur, on: false, media: null, paused: false }, kind);
        break;
      case 'player.online':
        this.observe(id, { ...cur, online: true }, kind);
        break;
      case 'player.offline':
        this.observe(id, { ...cur, on: false, media: null, paused: false, online: false }, kind);
        break;
    }
  }

  // ----------------------------------------------------------- commands --

  private box(device: Device): Box {
    const b = this.boxes.get(device.id);
    if (!b) throw new Error(`${device.name} isn’t known to Helix Server any more`);
    return b;
  }

  /** Put a card on this box's screen (the doorbell's snapshot while a film plays). */
  async notice(device: Device, n: { title: string; body?: string; imageUrl?: string; seconds?: number }): Promise<void> {
    await this.api.notify(this.box(device).id, n);
  }

  async command(device: Device, cmd: Command): Promise<void | DeviceState> {
    const b = this.box(device);
    const cur = this.states.get(device.id) ?? boxState(null, true);
    const stop = cmd.on === false || cmd.media === null;
    let did: DeviceState | undefined;
    if (typeof cmd.media === 'string' && cmd.media && cmd.media !== cur.media) {
      const { item, positionMs } = await this.api.resolve(cmd.media);
      await this.api.control(b.id, 'play', { itemId: item.id, positionMs });
      did = { on: true, media: item.title, paused: false };
    } else if (stop && cur.on) {
      await this.api.control(b.id, 'stop');
      did = { on: false, media: null, paused: false };
    } else if (cmd.paused !== undefined && cur.on && cmd.paused !== !!cur.paused) {
      await this.api.control(b.id, cmd.paused ? 'pause' : 'resume');
    } else if (cmd.on === true && cur.on && cur.paused) {
      await this.api.control(b.id, 'resume');
      did = { paused: false };
    }
    if (cmd.vol != null) await this.api.control(b.id, 'volume', { level: Math.max(0, Math.min(100, Math.round(cmd.vol))) });
    this.states.set(device.id, { ...cur, ...cmd, ...did });
    return did;
  }
}
