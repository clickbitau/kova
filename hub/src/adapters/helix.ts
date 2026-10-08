import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';
import { LanHttpError, lanJson, lanStream, trimUrl, type SseEvent } from '../util/lan-http.ts';
import { KOVA_VERSION } from '../version.ts';

/**
 * Helix, the home's media server and TV box (ClickBIT's own). Each Helix box
 * becomes a TV in Kova: what it's playing, pause and carry on, volume, stop,
 * sleep and wake, and "play <film or show>" by name. It also sends events Kova acts on:
 * `video-started` (Movie mode can start by itself), `music-started`, `paused`, `resumed`, `stopped`, `ended`,
 * and the screen's own: `screen-asleep`, `screen-shutdown` (a real power-off, never a restart), `screen-awake`.
 *
 * Kova pairs with Helix Server like any Helix app: it asks for a code, you type
 * it in Helix Server → Devices, and Kova gets its own device token (hxd_…, revoke it there).
 * Everything goes through the server:
 *  - the boxes from `GET /v1/players`: the entries with `"box": true` (never `"you": true`, Kova itself), by their
 *    stable id ("d-" and 16 hex digits; an `addr:<ip>` id is only an alias), with whether each is online, asleep or
 *    suspended, what it can do, what it plays, and its soundbar;
 *  - what changes live from `GET /v1/events` (Server-Sent Events): playback.*, player.*, screen.*. A ping comes every
 *    25 s, so a minute of silence is a dead feed. A reconnect asks for what it missed (`?after=` and Last-Event-ID) and
 *    events seen twice are dropped; `reset` (Helix lost the history) reads the players again;
 *  - while the feed is up, /v1/players again only on hello, reset, player.*, screen.* or a player Kova doesn't know;
 *  - `/v1/boxes/{id}/state` (a live hop to the box, up to 3 s) only for what isn't announced: volume, mute, the browse
 *    screen, and URL or YouTube plays. Never for a suspended box (Helix waits 3 s for it and then says 502);
 *  - control through `/v1/players/{id}/…`: play {itemId, positionMs, profile}, pause, resume, stop, volume {level}
 *    (the box's own volume: not offered for a box with a soundbar, whose volume is the soundbar's), mute {muted},
 *    sleep and wake (wake on a suspended box is Wake-on-LAN: Kova waits for screen.awake before playing), notify;
 *    never power, input or soundbar there (Helix sends those back to Kova), and never /v1/boxes/{id}/wake or /sleep;
 *  - "play X" decided by `/v1/resolve`, for the profile Kova uses (`musicProfile`, default "default"), which goes with
 *    every call: X-Helix-Profile on reads, `profile` in play.
 */
export interface HelixOptions {
  /** Helix Server, e.g. http://192.168.1.10:8090 */
  url: string;
  /** Kova's device token (hxd_…), from pairing. */
  token?: string;
  /** Box name → Kova room id. Boxes not listed go to no room. */
  rooms?: Record<string, string>;
  /** The Helix profile Kova acts as: Continue watching, loved songs, playlists and plays are per profile. Default "default". */
  musicProfile?: string;
  /** Box name → its TV (services/helix-link.ts); read here only to keep a box's settings when Helix renames it. */
  screens?: Record<string, HelixScreenSetting>;
  /** How often to read the boxes' volume and screen: while the live feed is down every pollSec (default 3 s), with it every 15 s. 0 turns the timers off (tests call poll()). */
  pollSec?: number;
  /** Follow Helix's live feed. Default on. */
  feed?: boolean;
  /** How often to read the players while the live feed is down. Default 60 s. */
  boxesSec?: number;
  /** Where Kova keeps which Kova device each Helix box is (so ids stay when Helix renames or re-keys a box). */
  storageDir?: string;
  /** How long "play" waits for a suspended box to wake. Default 30 s. */
  wakeWaitMs?: number;
  /** Silence on the live feed that counts as down. Default 60 s (Helix pings every 25 s). */
  idleMs?: number;
}

/** Which TV (and soundbar) a box is on, set by the owner (services/helix-link.ts). */
export interface HelixScreenSetting {
  tv?: string; input?: string; soundbar?: string; soundbarInput?: string;
  /** Whether Kova switches this TV and soundbar for what the box does (default true). */
  follow?: boolean;
}

/** One entry of Helix's `GET /v1/players`. Only `id` is kept as the box's id. */
export interface HelixPlayer {
  id: string; name?: string; client?: string;
  /** A screen (a TV box), and whether it's this caller (Kova itself). */
  box?: boolean; you?: boolean;
  online?: boolean; asleep?: boolean; suspended?: boolean;
  /** What Helix can do with it: notify, sleep, wake, soundbar… */
  capabilities?: string[];
  /** Null while idle; else what plays, for which profile, playing or paused, where (ms), updatedAt (Unix ms). */
  playback?: { item?: HelixItem | null; profile?: { id: string; name: string } | null; state?: 'playing' | 'paused' | string; positionMs?: number; durationMs?: number; updatedAt?: number } | null;
  /** Unix seconds. */
  lastSeenAt?: number;
  remoteUrl?: string;
  tv?: { deviceId?: string; name?: string } | null;
  soundbar?: { deviceId?: string; name?: string } | null;
  /** The box's address (an addr:<ip> id is an alias of the stable one); other ids it's known by, where Helix says. */
  address?: string; aliases?: string[];
}

export interface BoxState {
  mode?: 'browse' | 'video' | 'music'; screen?: string; title?: string; eyebrow?: string; itemId?: string;
  /** Volume 0–100; position and duration in seconds. */
  paused?: boolean; volume?: number; muted?: boolean; position?: number; duration?: number; asleep?: boolean;
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

/** What every call to Helix carries: who Kova is (its version), and the profile it acts as. */
export function helixHeaders(profile?: string): Record<string, string> {
  return { 'x-helix-client': `kova/${KOVA_VERSION}`, 'x-helix-device': 'Kova', ...(profile ? { 'x-helix-profile': profile } : {}) };
}

/** What Helix Server offers its clients (`GET /v1/client/features`): null for a Helix from before it said. */
export interface HelixFeatures { enabled?: boolean; music?: boolean; notices?: boolean; devices?: boolean }
export async function helixFeatures(url: string, token: string, profile?: string): Promise<HelixFeatures | null> {
  try {
    const r = await lanJson<{ players?: HelixFeatures }>(`${trimUrl(url)}/v1/client/features${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`, { token, headers: helixHeaders(profile), timeoutMs: 4000 });
    return r.json?.players && typeof r.json.players === 'object' ? r.json.players : null;
  } catch { return null; }
}

/**
 * What's wrong with the profile Kova uses, from Helix's answer: a locked profile is a 403, an unknown one a 404 that
 * says so. Null when the error is about something else.
 */
export function profileProblem(e: unknown, profile: string): string | null {
  if (!(e instanceof LanHttpError)) return null;
  const said = JSON.stringify(e.body ?? '').toLowerCase();
  if (e.status === 403 && /profile|locked|pin/.test(said)) return `Helix profile “${profile}” is locked. Unlock it in Helix, or choose another profile in Kova’s Helix settings.`;
  if (e.status === 404 && /profile/.test(said)) return `Helix has no profile “${profile}”. Choose another in Kova’s Helix settings.`;
  return null;
}

/** A title as Helix describes it (players, playback events, resolve). kind: "music" (a track, album or artist), the library kind ("movie", "episode"), or for a title from outside the library "music", "video" or "". */
export interface HelixItem { id: string; kind: string; title: string; year?: number; genres?: string[]; rating?: string | number; hdr?: string | boolean; show?: string; showId?: string; season?: number; episode?: number }
/** One event on Helix's live feed (`GET /v1/events` as Server-Sent Events). */
export interface PlaybackEvent {
  type: string; at?: number;
  player?: { id: string; name?: string; client?: string };
  item?: HelixItem; profile?: { id: string; name: string } | null;
  state?: string; positionMs?: number; durationMs?: number; reason?: string;
  /** screen.asleep / screen.awake: what did it (sheet, remote, idle, controller, play, suspend). */
  by?: string;
}

/**
 * Is this paired device a screen (a TV box), rather than Kova itself, a phone or the desktop app? Only for a Helix that
 * doesn't mark its boxes (`"box": true` in /v1/players): a TV client (helix-tv, helix-atv) or the box's own shell
 * (helix-desk, not helix-desktop); a device that hasn't said what it is counts as a box.
 */
export function isScreen(b: { name?: string; client?: string }): boolean {
  const c = (b.client ?? '').toLowerCase(), n = (b.name ?? '').trim().toLowerCase();
  if (c.startsWith('kova') || n === 'kova') return false;
  if (!c) return true;
  return /tv\b|atv|^helix-desk(?!top)/.test(c);
}

/** "S01E02" for an episode, else nothing. */
const episodeTag = (i?: HelixItem | null) => i?.kind === 'episode' && i.season && i.episode ? `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : '';

/** The IP address in a box's address alias (addr:<ip>), or its address. */
const addrOf = (p: { id?: string; address?: string; aliases?: string[] }): string | undefined => {
  const all = [p.id, ...(p.aliases ?? [])].filter((x): x is string => typeof x === 'string');
  const alias = all.find(x => /^addr:/i.test(x));
  return alias ? alias.slice(5) : p.address?.trim() || undefined;
};

const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

export class HelixApi {
  readonly url: string;
  constructor(private o: Pick<HelixOptions, 'url' | 'token' | 'musicProfile'>) { this.url = trimUrl(o.url); }
  get profile(): string { return this.o.musicProfile?.trim() || 'default'; }
  async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return (await lanJson<T>(this.url + path, { token: this.o.token, headers: helixHeaders(this.profile), ...(timeoutMs ? { timeoutMs } : {}) })).json;
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await lanJson<T>(this.url + path, { method: 'POST', body, token: this.o.token, headers: helixHeaders(this.profile) })).json;
  }
  /** Every paired device Helix knows, boxes and others (`box`, `you`). */
  async players(): Promise<HelixPlayer[]> { return (await this.playersPage()).players; }
  /** `GET /v1/players`: the players, and the feed's last event id then (where to follow the feed from). */
  async playersPage(): Promise<{ players: HelixPlayer[]; lastId?: string }> {
    const r = await this.get<{ players?: HelixPlayer[]; lastId?: number } | HelixPlayer[]>('/v1/players');
    const players = (Array.isArray(r) ? r : r?.players ?? []).filter(p => p && typeof p.id === 'string');
    const lastId = !Array.isArray(r) && typeof r?.lastId === 'number' && Number.isFinite(r.lastId) ? String(r.lastId) : undefined;
    return { players, ...(lastId !== undefined ? { lastId } : {}) };
  }
  /** A box's screen right now (a live hop to the box): volume, mute, browse or what plays, asleep. Never for a suspended box. */
  state(boxId: string): Promise<BoxState> { return this.get(`/v1/boxes/${encodeURIComponent(boxId)}/state`, 5000); }

  /** Control a screen through the server (which carries the box's remote key). `play` carries the profile. */
  control<T = unknown>(playerId: string, verb: 'play' | 'pause' | 'resume' | 'stop' | 'next' | 'previous' | 'seek' | 'volume' | 'mute' | 'tracks' | 'sleep' | 'wake', body?: Record<string, unknown>): Promise<T> {
    return this.post(`/v1/players/${encodeURIComponent(playerId)}/${verb}`, verb === 'play' ? { ...body, profile: this.profile } : body ?? {});
  }

  /** A card on the screen over whatever plays (D98.5): a title (≤80), a body (≤300), a picture Helix fetches from imageUrl, for 3–60 s. */
  notify(playerId: string, n: { title: string; body?: string; imageUrl?: string; seconds?: number }): Promise<unknown> {
    return this.post(`/v1/players/${encodeURIComponent(playerId)}/notify`, {
      title: clip(n.title, 80), ...(n.body ? { body: clip(n.body, 300) } : {}), ...(n.imageUrl ? { imageUrl: n.imageUrl } : {}),
      seconds: Math.max(3, Math.min(60, Math.round(n.seconds ?? 15))),
    });
  }

  /** What to play for spoken words, decided by Helix for Kova's profile: the episode you're on and where you stopped, a film, music. */
  async resolve(q: string): Promise<{ item: HelixItem; positionMs: number; reason?: string }> {
    try {
      return await this.get(`/v1/resolve?q=${encodeURIComponent(q)}&profile=${encodeURIComponent(this.profile)}`);
    } catch (e) {
      const p = profileProblem(e, this.profile);
      if (p) throw new Error(p);
      if (e instanceof LanHttpError && e.status === 404) throw new Error(`Helix has nothing called “${q}”`);
      throw e;
    }
  }

  /** Follow Helix's live feed from `after` (or from now). */
  follow(after: string | undefined, onEvent: (e: SseEvent) => void, idleMs = 60_000) {
    const q = `?stream=1${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    return lanStream(`${this.url}/v1/events${q}`, { token: this.o.token, headers: helixHeaders(this.profile), lastEventId: after, idleMs }, onEvent);
  }
}

// ------------------------------------------------------------ pairing --

export interface PairStart { pairingId: string; code: string; expiresIn: number; pollInterval?: number }
export type PairPoll = { status: 'pending' } | { status: 'approved'; token: string; serverId?: string } | { status: 'expired' };

export async function helixPairStart(url: string): Promise<PairStart> {
  return (await lanJson<PairStart>(`${trimUrl(url)}/v1/pair/start`, { method: 'POST', body: { name: 'Kova' }, headers: helixHeaders() })).json;
}

export async function helixPairPoll(url: string, pairingId: string): Promise<PairPoll> {
  try {
    return (await lanJson<PairPoll>(`${trimUrl(url)}/v1/pair/${encodeURIComponent(pairingId)}`, { headers: helixHeaders() })).json;
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

/** A Helix box as Kova follows it. */
interface Box {
  /** Helix's stable id for it ("d-…"). */
  id: string;
  /** Its Kova device id, kept when Helix renames or re-keys the box. */
  kovaId: string;
  name: string;
  online: boolean; asleep: boolean; suspended: boolean;
  /** What Helix can do with it; null from a Helix that doesn't say. */
  caps: string[] | null;
  /** Helix sends its volume keys to a soundbar (through Kova): the box's own volume isn't offered. */
  soundbar: boolean;
}

/** What Kova keeps about each box it has seen, so its Kova id stays put. */
interface KnownBox { id: string; kovaId: string; name: string; addr?: string; names: string[] }

export class HelixAdapter implements Adapter {
  id = 'helix';
  name = 'Helix';
  icon = 'movie';
  kind = 'Local' as const;
  readonly api: HelixApi;
  private ctx!: AdapterContext;
  /** By Kova device id. */
  private boxes = new Map<string, Box>();
  /** Every box Kova has seen, by Helix id (kept in boxes.json). */
  private known = new Map<string, KnownBox>();
  /** What Kova believes each box is doing (read, or just asked for). */
  private states = new Map<string, DeviceState>();
  /** What each box last said itself: events come from changes here, so a film Kova started still counts as starting. */
  private observed = new Map<string, DeviceState>();
  /** Boxes whose playback Kova took from their screen (a URL or YouTube play Helix doesn't announce), not from events. */
  private fromScreen = new Set<string>();
  /** Where each box is in what it plays (playback.progress, at most every 30 s). */
  private progressOf = new Map<string, { positionMs?: number; durationMs?: number; at: number }>();
  private timers: NodeJS.Timeout[] = [];
  private last: AdapterStatus = { ok: true, note: 'Connecting…' };
  private polling = false;
  private stopped = false;
  /** The live feed: connected, the last event id, ids seen lately, the open stream, and when boxes were last read. */
  private live = false;
  private cursor: string | undefined;
  private seen = new Set<string>();
  private stream: { close: () => void } | null = null;
  private retry: NodeJS.Timeout | null = null;
  private refetch: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  private summary = '';
  private problem: string | null = null;
  private features: HelixFeatures | null = null;
  /** Waiting for a box to wake (a suspended box woken with Wake-on-LAN). */
  private waking = new Map<string, (() => void)[]>();

  constructor(private opts: HelixOptions) {
    this.api = new HelixApi(opts);
    this.load();
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    if (!this.opts.token) { this.last = { ok: false, note: 'Not paired yet. Use Pair with Helix.' }; return; }
    this.features = await helixFeatures(this.api.url, this.opts.token, this.api.profile);
    await this.checkProfile();
    await this.refreshBoxes();
    await this.poll();
    if (this.opts.feed !== false) this.connect();
    const every = (this.opts.pollSec ?? 3) * 1000;
    if (every > 0) {
      // While the feed is live, the screens are only read every 15 s (volume, mute, and plays Helix doesn't announce).
      this.timers.push(setInterval(() => { if (!this.live || Date.now() - this.lastPoll >= 15_000) void this.poll(); }, every));
      // The players are read again on the feed's own say-so while it's live; without it, every boxesSec.
      this.timers.push(setInterval(() => { if (!this.live) void this.refreshBoxes(); }, (this.opts.boxesSec ?? 60) * 1000));
      this.timers.forEach(t => t.unref?.());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    if (this.refetch) clearTimeout(this.refetch);
    this.retry = this.refetch = null;
    this.stream?.close();
    this.stream = null;
    this.live = false;
    for (const ws of this.waking.values()) for (const w of ws) w();
    this.waking.clear();
  }

  status(): AdapterStatus { return this.last; }

  /** Whether the live feed is connected. */
  get following(): boolean { return this.live; }

  /** The other names a box went by (its settings are kept by box name): before Helix renamed it or gave it its stable id. */
  aliases(kovaId: string): string[] {
    const k = [...this.known.values()].find(x => x.kovaId === kovaId);
    if (!k) return [];
    return [...new Set([...k.names, ...(k.addr ? [`Helix box ${k.addr}`] : [])])].filter(n => n !== k.name);
  }

  /** Where this box is in what it plays, from Helix's playback.progress (at most every 30 s). */
  progress(kovaId: string): { positionMs?: number; durationMs?: number; at: number } | undefined { return this.progressOf.get(kovaId); }

  // ------------------------------------------------------- remembering --

  private get file(): string | null { return this.opts.storageDir ? join(this.opts.storageDir, 'boxes.json') : null; }

  private load(): void {
    const f = this.file;
    if (!f || !existsSync(f)) return;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { boxes?: KnownBox[] };
      for (const k of j.boxes ?? []) if (k?.id && k.kovaId) this.known.set(k.id, { ...k, names: k.names ?? [k.name] });
    } catch { /* start afresh */ }
  }

  private save(): void {
    const f = this.file;
    if (!f) return;
    try {
      mkdirSync(this.opts.storageDir!, { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify({ boxes: [...this.known.values()] }, null, 2) + '\n', { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch (e) { this.ctx?.log(`couldn’t keep the boxes: ${(e as Error).message}`); }
  }

  /** Does the home's Helix settings name this box (rooms, screens)? */
  private inSettings(name: string): boolean {
    const keys = [...Object.keys(this.opts.rooms ?? {}), ...Object.keys(this.opts.screens ?? {})].map(k => k.toLowerCase());
    return keys.includes(name.toLowerCase());
  }

  /**
   * The Kova device for a Helix player: the one it was before (by its id, or by the address alias it had before Helix gave
   * it a stable id), so the home's rooms, TV and soundbar settings, Activity and automations keep pointing at it.
   */
  private remember(p: HelixPlayer, name: string, taken: Set<string>): KnownBox {
    const addr = addrOf(p);
    let k = this.known.get(p.id);
    if (!k) {
      // Re-keyed: Helix knew it by its address (addr:<ip>) and now by its stable id.
      const ids = new Set([...(p.aliases ?? []), ...(addr ? [`addr:${addr}`] : [])].map(x => x.toLowerCase()));
      const old = [...this.known.values()].find(x => ids.has(x.id.toLowerCase()) || (!!addr && x.addr === addr && /^addr:/i.test(x.id)));
      if (old) {
        this.known.delete(old.id);
        k = { ...old, id: p.id };
      } else {
        // Seen for the first time by this Kova (or by one before boxes were kept): the id the home already used, if any.
        const legacy = addr ? `Helix box ${addr}` : '';
        const byName = boxDeviceId(name), byAddr = legacy ? boxDeviceId(legacy) : '';
        const used = (id: string) => !!id && !!this.ctx?.known?.(id);
        const kovaId = used(byName) ? byName : byAddr && (used(byAddr) || this.inSettings(legacy)) ? byAddr : byName;
        k = { id: p.id, kovaId, name, names: [name, ...(legacy && kovaId === byAddr ? [legacy] : [])] };
      }
    }
    // Two boxes by one name: the second gets an id of its own.
    if (taken.has(k.kovaId)) { let i = 2; while (taken.has(`${k.kovaId}_${i}`)) i++; k.kovaId = `${k.kovaId}_${i}`; }
    taken.add(k.kovaId);
    if (!k.names.includes(name)) k.names.push(name);
    k.name = name;
    if (addr) k.addr = addr;
    this.known.set(p.id, k);
    return k;
  }

  private roomOf(name: string, kovaId: string): string {
    const r = this.opts.rooms ?? {};
    for (const n of [name, ...this.aliases(kovaId)]) {
      const hit = r[n] ?? Object.entries(r).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
      if (hit) return hit;
    }
    return 'unassigned';
  }

  private setStatus(): void {
    if (this.problem) { this.last = { ok: false, note: this.problem }; return; }
    if (this.features?.enabled === false) { this.last = { ok: false, note: 'Helix Server has players turned off for its apps (Helix Server → Devices)' }; return; }
    if (this.summary) this.last = { ok: true, note: `${this.summary}${this.live ? ' · live' : ''}` };
  }

  /** Whether the profile Kova uses works: locked (403) or unknown (404) is said plainly. */
  private async checkProfile(): Promise<void> {
    try {
      await this.api.get('/v1/playlists?limit=1', 5000);
      this.problem = null;
    } catch (e) {
      this.problem = profileProblem(e, this.api.profile);
    }
  }

  private caps(b: Box): Device['capabilities'] {
    const sleeps = this.can(b, 'sleep') || this.can(b, 'wake');
    const own = b.soundbar ? [] : [...(this.can(b, 'volume', true) ? ['volume'] as const : []), ...(this.can(b, 'mute', true) ? ['mute'] as const : [])];
    return ['onoff', 'media', ...own, 'pause', 'library', ...(sleeps ? ['extras'] as const : [])] as Device['capabilities'];
  }

  /** Whether the screen is asleep (or the box suspended), as the `asleep` extra: set it to put the box to sleep or wake it. */
  private reportSleep(b: Box): void {
    if (!this.can(b, 'sleep') && !this.can(b, 'wake')) return;
    const asleep = b.asleep || b.suspended;
    const cur = this.states.get(b.kovaId);
    if (cur?.extras?.asleep === asleep) return;
    this.states.set(b.kovaId, { ...(cur ?? boxState(null, b.online)), extras: { ...cur?.extras, asleep } });
    this.ctx.report(b.kovaId, { extras: { asleep } });
  }

  /** Read the players: which boxes there are, and (from a current Helix) whether each is awake and what it plays. */
  async refreshBoxes(): Promise<void> {
    try {
      const page = await this.api.playersPage();
      const all = page.players;
      // The feed is followed from where this list stands, so nothing between the two is missed or counted twice.
      if (this.cursor === undefined && page.lastId !== undefined) this.cursor = page.lastId;
      const marked = all.some(p => typeof p.box === 'boolean');
      const players = all.filter(p => !p.you && (marked ? p.box === true : isScreen(p)));
      const taken = new Set<string>();
      const fresh: Box[] = [];
      const now = new Map<string, Box>();
      for (const p of players) {
        const name = p.name?.trim() || `Helix box ${addrOf(p) ?? p.id}`;
        const k = this.remember(p, name, taken);
        const caps = Array.isArray(p.capabilities) ? p.capabilities.map(String) : null;
        const b: Box = {
          id: p.id, kovaId: k.kovaId, name, online: p.online !== false, asleep: !!p.asleep, suspended: !!p.suspended,
          caps, soundbar: !!p.soundbar?.deviceId || !!p.soundbar?.name,
        };
        const old = this.boxes.get(b.kovaId);
        if (!old || old.id !== b.id || old.name !== b.name || old.soundbar !== b.soundbar || JSON.stringify(old.caps) !== JSON.stringify(b.caps)) fresh.push(b);
        now.set(b.kovaId, b);
        if (!b.suspended && old?.suspended) this.woke(b.kovaId);
        if (p.playback !== undefined && this.live) this.fromPlayers(b, p);
        else if (old && old.online !== b.online) this.observe(b.kovaId, { ...(this.observed.get(b.kovaId) ?? boxState(null, b.online)), online: b.online, ...(b.online ? {} : { on: false, media: null, paused: false }) }, 'video');
      }
      // A box Helix no longer lists (unpaired): gone from Kova too, so it doesn't count as a screen.
      const gone = [...this.boxes.keys()].filter(id => !now.has(id));
      this.boxes = now;
      if (gone.length) this.ctx.retract(gone);
      if (fresh.length) {
        this.ctx.announce(fresh.map(b => ({
          id: b.kovaId, name: b.name, room: this.roomOf(b.name, b.kovaId), type: 'tv' as const,
          capabilities: this.caps(b), integration: 'Helix', address: b.id, state: { on: false, online: b.online },
        })));
      }
      for (const b of now.values()) this.reportSleep(b);
      this.save();
      this.summary = now.size ? `${now.size} box${now.size === 1 ? '' : 'es'}` : 'Paired. No Helix box has used this server yet.';
      this.setStatus();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const status = err instanceof LanHttpError ? err.status : 0;
      this.last = { ok: false, note: status === 401 || (status === 403 && !profileProblem(err, this.api.profile)) ? 'Helix no longer accepts Kova. Pair again.' : profileProblem(err, this.api.profile) ?? `Can’t reach Helix Server: ${m}` };
    }
  }

  /** Read the players again soon (once, however many events asked). */
  private refreshSoon(): void {
    if (this.refetch || this.stopped) return;
    this.refetch = setTimeout(() => { this.refetch = null; void this.refreshBoxes(); }, 200);
    this.refetch.unref?.();
  }

  /** What a box plays, as /v1/players says (while the feed is live: playback is announced, and this is the catch-up). */
  private fromPlayers(b: Box, p: HelixPlayer): void {
    const cur = this.observed.get(b.kovaId) ?? boxState(null, b.online);
    const pb = p.playback;
    const st = String(pb?.state ?? '').toLowerCase();
    const item = pb?.item ?? undefined;
    const kind = item?.kind === 'music' ? 'music' : 'video';
    if (b.online && (st === 'playing' || st === 'paused') && (item?.title || cur.media)) {
      this.fromScreen.delete(b.kovaId);
      this.observe(b.kovaId, { ...cur, on: true, media: item?.title || cur.media || '', paused: st === 'paused', online: true }, kind, episodeTag(item));
    } else if (!this.fromScreen.has(b.kovaId)) {
      this.observe(b.kovaId, { ...cur, on: false, media: null, paused: false, online: b.online }, kind);
    } else if (cur.online !== b.online) {
      this.observe(b.kovaId, { ...cur, online: b.online }, kind);
    }
  }

  /** A box's Kova id from Helix's player id (or an alias of it). */
  private byPlayer(playerId: string): string | undefined {
    for (const [id, b] of this.boxes) if (b.id === playerId) return id;
    const k = [...this.known.values()].find(x => x.id === playerId || (/^addr:/i.test(playerId) && x.addr === playerId.slice(5)));
    return k && this.boxes.has(k.kovaId) ? k.kovaId : undefined;
  }

  /** Pass on a box's new state, with the events modes act on when it changed. */
  private observe(id: string, next: DeviceState, kind: 'video' | 'music', what = '', ended = false): void {
    const prev = this.observed.get(id);
    this.observed.set(id, next);
    this.states.set(id, next);
    this.ctx.report(id, next);
    if (next.online === false) return;
    const data = { title: next.media ?? '', what };
    if (next.on && !next.paused && (!prev?.on || prev.media !== next.media)) this.ctx.event(id, `${kind}-started`, data);
    else if (next.on && next.paused && prev?.on && !prev.paused) this.ctx.event(id, 'paused', data);
    else if (next.on && !next.paused && prev?.on && prev.paused) this.ctx.event(id, 'resumed', data);
    else if (!next.on && prev?.on) {
      this.ctx.event(id, 'stopped', { title: prev.media ?? '' });
      if (ended) this.ctx.event(id, 'ended', { title: prev.media ?? '' });
    }
  }

  /**
   * Read every box's screen (never a suspended one). Without the live feed this is how Kova follows them (every 3 s);
   * with it, only what Helix doesn't announce is taken from here: volume, mute, and a URL or YouTube play.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPoll = Date.now();
    try {
      await Promise.all([...this.boxes].map(async ([id, b]) => {
        // Whether a box is online is Helix's to say (/v1/players, player.online/offline), not one slow answer's.
        if (b.suspended || !b.online) return;
        const online = true;
        let s: BoxState | null = null;
        try { s = await this.api.state(b.id); } catch { return; }
        if (s && typeof s.asleep === 'boolean') b.asleep = s.asleep;
        const read = boxState(s, online);
        if (b.soundbar) delete read.vol;
        const own = b.soundbar ? {} : { vol: read.vol, ...(typeof s?.muted === 'boolean' ? { muted: s.muted } : {}) };
        if (this.live) {
          const cur = this.observed.get(id) ?? boxState(null, online);
          // A URL or YouTube play shows only on the screen: taken from it while nothing announced plays.
          if (s && read.on && (!cur.on || this.fromScreen.has(id))) {
            this.fromScreen.add(id);
            this.observe(id, { ...cur, ...read, ...own, online }, s.mode === 'music' ? 'music' : 'video', s.eyebrow ?? '');
            return;
          }
          if (s && !read.on && this.fromScreen.has(id)) {
            this.fromScreen.delete(id);
            this.observe(id, { ...cur, on: false, media: null, paused: false, ...own, online }, 'video');
            return;
          }
          const next = { ...cur, ...own, online };
          this.observed.set(id, next);
          this.states.set(id, { ...(this.states.get(id) ?? next), ...own, online });
          this.ctx.report(id, { ...own, online });
          return;
        }
        this.observe(id, { ...read, ...own }, s?.mode === 'music' ? 'music' : 'video', s?.eyebrow ?? '');
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
      const s = this.api.follow(this.cursor, e => this.onSse(e), this.opts.idleMs ?? 60_000);
      this.stream = s;
      s.done.then(
        () => this.dropped(3000),
        err => {
          // An older Helix without the live feed: keep polling.
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

  /** An event id seen before (a reconnect replays what came after the last one Kova had): dropped. */
  private already(id: string | undefined): boolean {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    return false;
  }

  private onSse(e: SseEvent): void {
    if (e.event === 'hello') {
      // Connected: read the players and screens once, so what changed while Kova wasn't listening is caught up.
      this.live = true;
      void this.checkProfile().then(() => this.refreshBoxes()).then(() => this.poll()).then(() => this.setStatus());
      return;
    }
    if (e.event === 'reset') {
      // Helix lost the history Kova asked from: start counting again, and read the players.
      this.seen.clear();
      if (e.id) this.cursor = e.id;
      this.refreshSoon();
      return;
    }
    if (this.already(e.id)) return;
    if (e.id) this.cursor = e.id;
    if (!/^(playback|player|screen)\./.test(e.event)) return;
    let ev: PlaybackEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    ev = { ...ev, type: ev.type ?? e.event };
    if (/^(player|screen)\./.test(ev.type)) this.refreshSoon();
    if (ev.type.startsWith('screen.')) this.onScreen(ev);
    else this.onPlayback(ev);
  }

  /** screen.asleep {reason: sleep|shutdown, by} and screen.awake {reason: wake, by}: events automations can start on. */
  private onScreen(ev: PlaybackEvent): void {
    const id = ev.player?.id ? this.byPlayer(ev.player.id) : undefined;
    if (!id) { this.refreshSoon(); return; }
    const b = this.boxes.get(id)!;
    const data = { by: ev.by ?? '', reason: ev.reason ?? '' };
    if (ev.type === 'screen.asleep') {
      b.asleep = true;
      this.reportSleep(b);
      this.ctx.event(id, ev.reason === 'shutdown' ? 'screen-shutdown' : 'screen-asleep', data);
    } else if (ev.type === 'screen.awake') {
      b.asleep = false;
      b.suspended = false;
      this.reportSleep(b);
      this.ctx.event(id, 'screen-awake', data);
      this.woke(id);
    }
  }

  /** One playback or player event from Helix's feed. */
  onPlayback(ev: PlaybackEvent): void {
    const id = ev.player?.id ? this.byPlayer(ev.player.id) : undefined;
    if (!id) { if (ev.player?.id) this.refreshSoon(); return; }
    const cur = this.observed.get(id) ?? boxState(null, true);
    const kind = ev.item?.kind === 'music' ? 'music' : 'video';
    const title = ev.item?.title || cur.media || '';
    if (ev.type.startsWith('playback.')) this.fromScreen.delete(id);
    switch (ev.type) {
      case 'playback.started':
      case 'playback.resumed':
        this.observe(id, { ...cur, on: true, media: title, paused: false, online: true }, kind, episodeTag(ev.item));
        break;
      case 'playback.paused':
        this.observe(id, { ...cur, on: true, media: title, paused: true, online: true }, kind, episodeTag(ev.item));
        break;
      case 'playback.progress':
        this.progressOf.set(id, { positionMs: ev.positionMs, durationMs: ev.durationMs, at: Date.now() });
        // Playing (Kova missed its start, or it was the first thing after a restart).
        if (!cur.on && title) this.observe(id, { ...cur, on: true, media: title, paused: ev.state === 'paused', online: true }, kind, episodeTag(ev.item));
        break;
      case 'playback.stopped':
      case 'playback.ended':
      case 'playback.gone':
        // Another title began on it: playback.started follows straight away.
        if (ev.reason === 'replaced') break;
        this.progressOf.delete(id);
        this.observe(id, { ...cur, on: false, media: null, paused: false }, kind, '', ev.type === 'playback.ended');
        break;
      case 'player.online':
        this.boxes.get(id)!.online = true;
        this.observe(id, { ...cur, online: true }, kind);
        break;
      case 'player.offline':
        this.boxes.get(id)!.online = false;
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

  /** Whether Helix can do this with the box (a Helix that doesn't list capabilities can do what it always could). */
  private can(b: Box, what: string, before = false): boolean { return b.caps ? b.caps.includes(what) : before; }

  /** The box woke: whoever was waiting carries on. */
  private woke(id: string): void {
    const ws = this.waking.get(id);
    this.waking.delete(id);
    for (const w of ws ?? []) w();
  }

  /**
   * A suspended box can't play (Helix answers 502): wake it (Wake-on-LAN through Helix) and wait for screen.awake, or
   * for /v1/players to say it's up when the feed is down. A box that's only asleep wakes by itself when it plays.
   */
  private async ready(b: Box, device: Device): Promise<void> {
    if (!b.suspended) return;
    if (!this.can(b, 'wake')) throw new Error(`${device.name} is suspended and Helix can’t wake it`);
    const up = new Promise<void>(r => { const ws = this.waking.get(b.kovaId) ?? []; ws.push(r); this.waking.set(b.kovaId, ws); });
    await this.api.control(b.id, 'wake');
    const until = Date.now() + (this.opts.wakeWaitMs ?? 30_000);
    let timer: NodeJS.Timeout | undefined;
    const check = async (): Promise<void> => {
      if (!this.live) await this.refreshBoxes();
      const cur = this.boxes.get(b.kovaId);
      if (cur && !cur.suspended) { this.woke(b.kovaId); return; }
      if (Date.now() < until) { timer = setTimeout(() => void check(), 2000); timer.unref?.(); }
    };
    timer = setTimeout(() => void check(), 2000);
    timer.unref?.();
    const late = new Promise<'late'>(r => { const t = setTimeout(() => r('late'), Math.max(0, until - Date.now())); t.unref?.(); });
    try {
      if (await Promise.race([up.then(() => 'up' as const), late]) === 'late') throw new Error(`${device.name} didn’t wake up in time`);
    } finally { clearTimeout(timer); }
  }

  /** Put a card on this box's screen (the doorbell's snapshot while a film plays), where Helix offers that. */
  async notice(device: Device, n: { title: string; body?: string; imageUrl?: string; seconds?: number }): Promise<void> {
    const b = this.box(device);
    if (this.features?.notices === false || !this.can(b, 'notify', true) || b.suspended) return;
    await this.api.notify(b.id, n);
  }

  async command(device: Device, cmd: Command): Promise<void | DeviceState> {
    const b = this.box(device);
    const cur = this.states.get(device.id) ?? boxState(null, true);
    let did: DeviceState | undefined;
    if (typeof cmd.media === 'string' && cmd.media && cmd.media !== cur.media) {
      await this.ready(b, device);
      const { item, positionMs } = await this.api.resolve(cmd.media);
      await this.api.control(b.id, 'play', { itemId: item.id, positionMs });
      b.asleep = false;
      did = { on: true, media: item.title, paused: false };
    } else if (cmd.on === false || cmd.media === null) {
      if (cur.on) await this.api.control(b.id, 'stop');
      did = { on: false, media: null, paused: false };
      // Off is the screen off too, where Helix can put it to sleep.
      if (cmd.on === false && this.can(b, 'sleep') && !b.asleep && !b.suspended && b.online) {
        await this.api.control(b.id, 'sleep');
        b.asleep = true;
        did.extras = { ...cur.extras, asleep: true };
      }
    } else if (cmd.paused !== undefined && cur.on && cmd.paused !== !!cur.paused) {
      await this.api.control(b.id, cmd.paused ? 'pause' : 'resume');
    } else if (cmd.on === true) {
      // On wakes the screen (a suspended box with Wake-on-LAN), and carries on what was paused.
      if ((b.asleep || b.suspended) && this.can(b, 'wake')) { await this.api.control(b.id, 'wake'); b.asleep = false; did = { extras: { ...cur.extras, asleep: false } }; }
      if (cur.on && cur.paused) { await this.api.control(b.id, 'resume'); did = { ...did, paused: false }; }
    }
    // The screen asleep or awake, whatever plays (the `asleep` extra).
    const asleep = cmd.extras?.asleep;
    if (asleep === true && !b.asleep && !b.suspended) { await this.api.control(b.id, 'sleep'); b.asleep = true; }
    if (asleep === false && (b.asleep || b.suspended)) { await this.api.control(b.id, 'wake'); b.asleep = false; }
    if (typeof asleep === 'boolean') did = { ...did, extras: { ...cur.extras, ...cmd.extras, asleep } };
    if (cmd.vol != null) {
      if (b.soundbar) throw new Error(`${device.name}’s sound is its soundbar’s: change the soundbar’s volume`);
      await this.api.control(b.id, 'volume', { level: Math.max(0, Math.min(100, Math.round(cmd.vol))) });
    }
    if (cmd.muted !== undefined && !b.soundbar) await this.api.control(b.id, 'mute', { muted: cmd.muted });
    this.states.set(device.id, { ...cur, ...cmd, ...did });
    return did;
  }
}
