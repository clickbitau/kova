import type { Adapter, AdapterContext, AdapterStatus, Queue, QueueTrack } from './sdk.ts';
import type { Command, Device, DeviceState, Track } from '../model/types.ts';

// Kova → AirPlay (Apple TV, HomePod, AirPlay speakers) through OwnTone, an
// open-source AirPlay 1/2 server that runs as its own process (GPL, so it stays
// separate) and is driven over its JSON API. OwnTone plays one source at a time
// to any set of AirPlay outputs, and keeps those outputs in sync.
//
// Helix music plays as OwnTone's own queue: the next OWNTONE_WINDOW songs (URLs Helix signed),
// more added as it plays, next/previous by queue position, and every selected speaker in sync.

/** How many songs OwnTone's queue holds ahead; more are added as it plays. */
export const OWNTONE_WINDOW = 50;

const shown = (t: QueueTrack): Track => ({ id: t.id, title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}), ...(t.art ? { art: t.art } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}) });

export interface AirPlayOptions {
  /** OwnTone's web address, e.g. http://10.10.10.150:3689 */
  url: string;
  /** AirPlay device name → Kova room id. */
  rooms?: Record<string, string>;
  /** AirPlay device name → Kova device id. */
  ids?: Record<string, string>;
  pollMs?: number;
  batchMs?: number;
  timeoutMs?: number;
}

interface Output { id: string; name: string; type: string; selected: boolean; volume: number; requires_auth?: boolean }
interface Pending { device: Device; cmd: Command; resolve: (s?: DeviceState) => void; reject: (e: Error) => void }
interface Player { state: string; item_id?: number; item_progress_ms?: number }
/** Helix music on OwnTone's queue: the songs in order, which one plays, and which of them OwnTone holds (from..to). */
interface Music { q: Queue; index: number; from: number; to: number }

export class AirPlayAdapter implements Adapter {
  id = 'airplay';
  name = 'AirPlay (via OwnTone)';
  icon = 'airplay';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private outputs = new Map<string, Output>();
  private kova = new Map<string, string>();
  private out = new Map<string, string>();
  /** What Kova last asked OwnTone to play. */
  private source: string | null = null;
  /** The music queue OwnTone plays, when it's Helix music rather than a stream. */
  private music: Music | null = null;
  private queue: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private error: string | null = null;

  constructor(private o: AirPlayOptions) {}

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.o.url.replace(/\/$/, '')}${path}`, {
      method, signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    if (!res.ok) throw new Error(`OwnTone ${method} ${path.split('?')[0]} failed (HTTP ${res.status})`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.refresh().catch(err => { this.error = `Can’t reach OwnTone: ${(err as Error).message}`; });
    const every = this.o.pollMs ?? 5000;
    if (every > 0) this.poller = setInterval(() => void this.refresh().catch(e => { this.error = String((e as Error).message); }), every);
  }

  private kovaId(o: Output) { return this.o.ids?.[o.name] ?? `airplay_${o.id}`; }

  /** Read outputs and player state; announce new outputs; report state. */
  private async refresh(): Promise<void> {
    const [{ outputs }, player] = await Promise.all([
      this.api<{ outputs: Output[] }>('GET', '/api/outputs'),
      this.api<Player>('GET', '/api/player'),
    ]);
    const airplay = outputs.filter(o => /airplay/i.test(o.type));
    const fresh = airplay.filter(o => !this.outputs.has(o.id));
    for (const o of airplay) { this.outputs.set(o.id, o); this.kova.set(o.id, this.kovaId(o)); this.out.set(this.kovaId(o), o.id); }
    if (fresh.length) {
      this.ctx!.announce(fresh.map(o => ({
        id: this.kovaId(o), name: o.name, type: /apple tv/i.test(o.name) ? 'tv' : 'media',
        room: this.o.rooms?.[o.name] ?? o.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        integration: `AirPlay · ${o.type}`, address: o.id, capabilities: ['onoff', 'media', 'volume', 'queue'],
      })));
    }
    const playing = player.state === 'play';
    // A paused queue keeps its place; a stopped one (it ran out, or something else played) is over.
    if (player.state === 'stop') this.music = null;
    if (!playing && !this.music) this.source = null;
    if (playing && this.music) await this.follow(player).catch(() => {});
    const mu = playing ? this.music : null;
    for (const o of airplay) {
      const on = playing && o.selected;
      this.ctx!.report(this.kovaId(o), {
        online: true, on, media: on ? this.source ?? 'AirPlay' : null, vol: o.volume,
        track: on && mu ? shown(mu.q.tracks[mu.index]) : null, shuffle: on && mu ? mu.q.shuffle : false,
      });
    }
    this.error = airplay.some(o => o.requires_auth) ? 'An AirPlay device needs a PIN: pair it once in OwnTone' : null;
  }

  command(device: Device, cmd: Command): Promise<void | DeviceState> {
    return new Promise((resolve, reject) => {
      this.queue.push({ device, cmd, resolve, reject });
      this.flushTimer ??= setTimeout(() => void this.flush(), this.o.batchMs ?? 60);
    });
  }

  private outId(d: Device): string {
    const id = this.out.get(d.id) ?? d.address;
    if (!this.outputs.has(id)) throw new Error(`Unknown AirPlay device ${d.name}`);
    return id;
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const batch = this.queue.splice(0);
    // Plays, skips and shuffles answer with the song the queue is on; a speaker that stopped doesn't take one.
    const settle = async (ps: Pending[], fn: () => Promise<void>, playing = true) => {
      try { await fn(); const st = playing ? this.now() : undefined; ps.forEach(p => p.resolve(st)); } catch (e) { ps.forEach(p => p.reject(e as Error)); }
    };
    // Volume first, so a speaker joining a stream starts at the right level.
    const failed = new Set<Pending>();
    for (const p of batch.filter(x => x.cmd.vol != null)) {
      try { await this.api('PUT', `/api/outputs/${this.outId(p.device)}`, { volume: Math.round(p.cmd.vol!) }); }
      catch (e) { failed.add(p); p.reject(e as Error); }
    }
    const live = batch.filter(p => !failed.has(p));
    const plays = live.filter(p => p.cmd.media);
    const media = [...new Set(plays.map(p => p.cmd.media!))];
    if (media.length > 1) {
      plays.forEach(p => p.reject(new Error('AirPlay devices can play one source at a time')));
    } else if (plays.length) {
      const src = media[0];
      const shuffle = plays.some(p => p.cmd.shuffle);
      await settle(plays, async () => {
        const url = this.ctx!.sourceUrl(src);
        const ids = plays.map(p => this.outId(p.device));
        const others = [...this.outputs.values()].filter(o => o.selected && !ids.includes(o.id));
        if (this.source === src && (url || !plays.some(p => p.cmd.shuffle !== undefined && p.cmd.shuffle !== this.music?.q.shuffle))) {
          // Same source already playing: just add these speakers, in sync.
          for (const id of ids) await this.api('PUT', `/api/outputs/${id}`, { selected: true });
        } else {
          if (this.source && others.length) throw new Error(`AirPlay is playing ${this.source} in other rooms; one source at a time`);
          // Not a stream: maybe music (Helix), which plays as a queue of songs.
          const q = url ? null : await this.ctx!.queueFor(src, { shuffle });
          if (!url && !q) throw new Error(`No stream URL set for “${src}”`);
          await this.api('PUT', '/api/outputs/set', { outputs: ids });
          if (q) await this.playQueue(q);
          else {
            // A recording set to loop plays again from the start each time it ends.
            await this.api('PUT', `/api/player/repeat?state=${this.ctx!.sourceLoops?.(src) ? 'single' : 'off'}`).catch(() => {});
            await this.api('POST', `/api/queue/items/add?uris=${encodeURIComponent(url!)}&clear=true&playback=start`);
            this.music = null;
          }
          this.source = src;
        }
        for (const id of ids) { const o = this.outputs.get(id)!; o.selected = true; }
      });
    }
    const stops = live.filter(p => !p.cmd.media && (p.cmd.on === false || p.cmd.media === null));
    if (stops.length) {
      await settle(stops, async () => {
        for (const p of stops) { const id = this.outId(p.device); await this.api('PUT', `/api/outputs/${id}`, { selected: false }); this.outputs.get(id)!.selected = false; }
        if (![...this.outputs.values()].some(o => o.selected)) { await this.api('PUT', '/api/player/stop'); this.source = null; this.music = null; }
      }, false);
    }
    // Shuffle and next/previous act on the one queue every selected speaker plays, once however many speakers asked.
    const rest = live.filter(p => !plays.includes(p) && !stops.includes(p));
    const reorder = rest.find(p => p.cmd.shuffle !== undefined && this.music && p.cmd.shuffle !== this.music.q.shuffle);
    const skip = rest.find(p => p.cmd.skip);
    const queued = rest.filter(p => p.cmd.shuffle !== undefined || p.cmd.skip);
    if (queued.length) {
      await settle(queued, async () => {
        if (reorder) await this.reorder(reorder.cmd.shuffle!);
        if (skip) await this.skip(skip.cmd.skip! > 0 ? 1 : -1);
      });
    }
    // Commands that were only a volume change, or "on" with nothing to play.
    for (const p of rest) if (!queued.includes(p)) p.resolve();
  }

  /** What every speaker on the queue now plays, for the registry to record with the command. */
  private now(): DeviceState | undefined {
    return this.music ? { shuffle: this.music.q.shuffle, track: shown(this.music.q.tracks[this.music.index]) } : undefined;
  }

  /** Play a queue from `start` (at `positionMs` into that song): OwnTone's queue gets the next OWNTONE_WINDOW songs. */
  private async playQueue(q: Queue, start = 0, positionMs = 0): Promise<void> {
    const to = Math.min(q.tracks.length, start + OWNTONE_WINDOW);
    await q.prepare?.(start, to);
    // Kova does the shuffling (the same order on every speaker it tells): OwnTone plays the queue as it is.
    await this.api('PUT', '/api/player/shuffle?state=false').catch(() => {});
    await this.enqueue(q.tracks.slice(start, to), true);
    if (positionMs > 0) await this.api('PUT', `/api/player/seek?position_ms=${Math.round(positionMs)}`).catch(() => {});
    this.music = { q, index: start, from: start, to };
  }

  /** Add songs to the end of OwnTone's queue (or replace it and start playing). */
  private async enqueue(tracks: QueueTrack[], replace = false): Promise<void> {
    // OwnTone takes a comma-separated list; a URL with a comma in it goes on its own.
    const groups: QueueTrack[][] = [];
    for (const t of tracks) {
      const last = groups[groups.length - 1];
      if (last && !t.url.includes(',') && !last[0].url.includes(',')) last.push(t); else groups.push([t]);
    }
    for (const [i, g] of groups.entries()) {
      const first = replace && i === 0;
      await this.api('POST', `/api/queue/items/add?uris=${encodeURIComponent(g.map(t => t.url).join(','))}${first ? '&clear=true&playback=start' : ''}`);
    }
  }

  private async skip(delta: number): Promise<void> {
    const mu = this.music;
    if (!mu) throw new Error('AirPlay isn’t playing a queue');
    const next = mu.index + delta;
    if (next >= mu.q.tracks.length) throw new Error(`That was the last song in ${mu.q.label}`);
    if (next < mu.from || next >= mu.to) { await this.playQueue(mu.q, Math.max(0, next)); return; }
    await this.api('PUT', `/api/player/play?position=${next - mu.from}`);
    mu.index = next;
  }

  /** The same music in a new order (or back in order), carrying on with this song where it is. */
  private async reorder(shuffle: boolean): Promise<void> {
    const mu = this.music;
    if (!mu) return;
    const q = await this.ctx!.queueFor(mu.q.label, { shuffle });
    if (!q) return;
    const cur = mu.q.tracks[mu.index];
    const player = await this.api<Player>('GET', '/api/player').catch(() => ({ state: 'play' } as Player));
    const tracks = q.shuffle ? [cur, ...q.tracks.filter(t => t.id !== cur.id)] : q.tracks;
    await this.playQueue({ ...q, tracks }, q.shuffle ? 0 : Math.max(0, q.tracks.findIndex(t => t.id === cur.id)), player.item_progress_ms ?? 0);
  }

  /** Where OwnTone's queue is, and more songs before it runs out. */
  private async follow(player: Player): Promise<void> {
    const mu = this.music!;
    if (player.item_id != null) {
      const { items } = await this.api<{ items?: { id: number; position: number }[] }>('GET', '/api/queue');
      const at = items?.find(i => i.id === player.item_id)?.position;
      if (at != null && mu.from + at < mu.q.tracks.length) mu.index = mu.from + at;
    }
    if (mu.to < mu.q.tracks.length && mu.index >= mu.to - 5) {
      const to = Math.min(mu.q.tracks.length, mu.to + OWNTONE_WINDOW);
      await mu.q.prepare?.(mu.to, to);
      await this.enqueue(mu.q.tracks.slice(mu.to, to));
      mu.to = to;
    }
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  status(): AdapterStatus {
    const n = this.outputs.size;
    if (this.error) return { ok: false, note: this.error };
    return { ok: n > 0, note: n ? `${n} AirPlay device${n === 1 ? '' : 's'}, synced when played together` : 'No AirPlay devices found' };
  }
}
