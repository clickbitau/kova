import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';

// Kova → AirPlay (Apple TV, HomePod, AirPlay speakers) through OwnTone, an
// open-source AirPlay 1/2 server that runs as its own process (GPL, so it stays
// separate) and is driven over its JSON API. OwnTone plays one source at a time
// to any set of AirPlay outputs, and keeps those outputs in sync.

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
interface Pending { device: Device; cmd: Command; resolve: () => void; reject: (e: Error) => void }

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
      this.api<{ state: string }>('GET', '/api/player'),
    ]);
    const airplay = outputs.filter(o => /airplay/i.test(o.type));
    const fresh = airplay.filter(o => !this.outputs.has(o.id));
    for (const o of airplay) { this.outputs.set(o.id, o); this.kova.set(o.id, this.kovaId(o)); this.out.set(this.kovaId(o), o.id); }
    if (fresh.length) {
      this.ctx!.announce(fresh.map(o => ({
        id: this.kovaId(o), name: o.name, type: /apple tv/i.test(o.name) ? 'tv' : 'media',
        room: this.o.rooms?.[o.name] ?? o.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        integration: `AirPlay · ${o.type}`, address: o.id, capabilities: ['onoff', 'media', 'volume'],
      })));
    }
    const playing = player.state === 'play';
    if (!playing) this.source = null;
    for (const o of airplay) {
      const on = playing && o.selected;
      this.ctx!.report(this.kovaId(o), { online: true, on, media: on ? this.source ?? 'AirPlay' : null, vol: o.volume });
    }
    this.error = airplay.some(o => o.requires_auth) ? 'An AirPlay device needs a PIN: pair it once in OwnTone' : null;
  }

  command(device: Device, cmd: Command): Promise<void> {
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
    const settle = async (ps: Pending[], fn: () => Promise<void>) => {
      try { await fn(); ps.forEach(p => p.resolve()); } catch (e) { ps.forEach(p => p.reject(e as Error)); }
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
      await settle(plays, async () => {
        const url = this.ctx!.sourceUrl(src);
        if (!url) throw new Error(`No stream URL set for “${src}”`);
        const ids = plays.map(p => this.outId(p.device));
        const others = [...this.outputs.values()].filter(o => o.selected && !ids.includes(o.id));
        if (this.source === src) {
          // Same source already playing: just add these speakers, in sync.
          for (const id of ids) await this.api('PUT', `/api/outputs/${id}`, { selected: true });
        } else {
          if (this.source && others.length) throw new Error(`AirPlay is playing ${this.source} in other rooms; one source at a time`);
          await this.api('PUT', '/api/outputs/set', { outputs: ids });
          await this.api('POST', `/api/queue/items/add?uris=${encodeURIComponent(url)}&clear=true&playback=start`);
          this.source = src;
        }
        for (const id of ids) { const o = this.outputs.get(id)!; o.selected = true; }
      });
    }
    const stops = live.filter(p => !p.cmd.media && (p.cmd.on === false || p.cmd.media === null));
    if (stops.length) {
      await settle(stops, async () => {
        for (const p of stops) { const id = this.outId(p.device); await this.api('PUT', `/api/outputs/${id}`, { selected: false }); this.outputs.get(id)!.selected = false; }
        if (![...this.outputs.values()].some(o => o.selected)) { await this.api('PUT', '/api/player/stop'); this.source = null; }
      });
    }
    // Commands that were only a volume change, or "on" with nothing to play.
    for (const p of live) if (!plays.includes(p) && !stops.includes(p)) p.resolve();
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
