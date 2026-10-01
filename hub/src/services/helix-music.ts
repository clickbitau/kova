import type { Queue, QueueTrack } from '../adapters/sdk.ts';
import { lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * Helix music on any speaker: Kova turns a name into the tracks to queue, and the speaker
 * (Cast, Sonos) fetches each song straight from Helix Server.
 *
 * Names (what a speaker's `media` says while it plays):
 *   "Shuffle all"        the whole library, shuffled
 *   "Loved"              the loved songs
 *   "<playlist title>"   a playlist, in order (or shuffled)
 *   "Station: <name>"    a station from an artist, album or song: Helix's mix plus the artist's own songs, shuffled
 *   "Artist: <name>", "Album: <name>", "Song: <name>"   what Ask found by name
 *
 * Songs: a speaker can't send headers, so each song gets a URL it can fetch by itself. Helix signs one per song
 * (`POST /v1/items/<id>/play-url {format:'aac', maxRate:48000}`: no token in it, that song only, 6 hours), and
 * Kova asks for them a window at a time, just before a speaker queues those songs (Queue.prepare). A Helix
 * from before signed URLs gets `/v1/music/tracks/<id>/stream?max=aac&token=<Kova's device token>` instead.
 * Shuffle all is Helix's own uniform shuffle of the whole library (`?shuffle=1`) where it has one.
 * Every song a speaker starts is counted as played in Helix (`POST /v1/music/tracks/<id>/played`).
 */
export interface HelixMusicConfig { url?: string; token?: string; /** Helix profile whose loved songs and playlists Kova uses. Default "default". */ musicProfile?: string }

interface HelixTrack {
  id: string; title: string; artist?: string; album?: string; posterUrl?: string; durationMs?: number;
  url?: string; hasFile?: boolean; streamable?: boolean; provisional?: boolean; codec?: string;
}
interface Playlist { id: string; title: string; kind?: string; tracks?: number }
interface SiriPick { kind: 'artist' | 'album' | 'track' | 'playlist' | 'loved' | 'default' | 'none'; id?: string; title?: string; artist?: string }

export interface MusicItem { name: string; kind: 'all' | 'loved' | 'playlist'; icon: string; tracks?: number }

/** What a name means to Helix. */
type Spec =
  | { kind: 'all' } | { kind: 'loved' }
  | { kind: 'playlist'; id: string; title: string }
  | { kind: 'station' | 'artist' | 'album' | 'track'; id: string; seedKind: 'artist' | 'album' | 'track'; title: string };

const PREFIX: Record<string, 'station' | 'artist' | 'album' | 'track'> = { station: 'station', artist: 'artist', album: 'album', song: 'track' };
const LIBRARY_MAX = 4000;
const SAME_ORDER_MS = 10_000;

/** Fisher–Yates, with an injectable random for tests. */
export function shuffled<T>(a: T[], random = Math.random): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export class HelixMusic {
  private playlists: Playlist[] = [];
  private listedAt = 0;
  /** Names Ask resolved, so playing it again doesn't need another lookup. */
  private specs = new Map<string, Spec>();
  /** Recent answers, so every speaker of a group gets the same order. */
  private recent = new Map<string, { at: number; queue: Promise<Queue | null> }>();
  /** Whether Helix signs per-song URLs (null: not asked yet). */
  private signing: boolean | null = null;

  constructor(private cfg: () => HelixMusicConfig | undefined, private o: { random?: () => number; now?: () => number } = {}) {}

  private get now() { return this.o.now?.() ?? Date.now(); }
  private linked(): { url: string; token: string; profile: string } | null {
    const c = this.cfg();
    return c?.url && c.token ? { url: trimUrl(c.url), token: c.token, profile: c.musicProfile || 'default' } : null;
  }

  private async get<T>(path: string): Promise<T> {
    const h = this.linked();
    if (!h) throw new Error('Pair Kova with Helix first');
    const sep = path.includes('?') ? '&' : '?';
    return (await lanJson<T>(`${h.url}${path}${sep}profile=${encodeURIComponent(h.profile)}`, { token: h.token, headers: { 'x-helix-client': 'kova/1', 'x-helix-device': 'Kova' }, timeoutMs: 15_000 })).json;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const h = this.linked();
    if (!h) throw new Error('Pair Kova with Helix first');
    return (await lanJson<T>(`${h.url}${path}`, { method: 'POST', body, token: h.token, headers: { 'x-helix-client': 'kova/1', 'x-helix-device': 'Kova' }, timeoutMs: 15_000 })).json;
  }

  /** Count a song a speaker started as played in Helix (once per song: Helix ignores a repeat within 2 minutes). */
  async played(trackId: string, player: string): Promise<void> {
    const h = this.linked();
    if (!h || !/^helix:/.test(trackId)) return;
    await this.post(`/v1/music/tracks/${encodeURIComponent(trackId.replace(/^helix:/, ''))}/played`, { profileId: h.profile, player, playedAt: new Date(this.now).toISOString() }).catch(() => {});
  }

  /** What to offer on the Media page: Shuffle all, Loved, then each music playlist. */
  async catalog(force = false): Promise<MusicItem[]> {
    if (!this.linked()) return [];
    if (force || this.now - this.listedAt > 5 * 60_000) {
      try {
        this.playlists = ((await this.get<{ playlists?: Playlist[] }>('/v1/playlists?kind=music')).playlists ?? []).filter(p => !p.kind || p.kind === 'music');
        this.listedAt = this.now;
      } catch { /* keep the last list */ }
    }
    return [
      { name: 'Shuffle all', kind: 'all', icon: 'shuffle' },
      { name: 'Loved', kind: 'loved', icon: 'favorite' },
      ...this.playlists.map(p => ({ name: p.title, kind: 'playlist' as const, icon: 'queue_music', tracks: p.tracks })),
    ];
  }

  /** The last catalog, without asking Helix (for the snapshot). */
  cached(): MusicItem[] {
    if (!this.linked()) return [];
    return [{ name: 'Shuffle all', kind: 'all', icon: 'shuffle' }, { name: 'Loved', kind: 'loved', icon: 'favorite' },
      ...this.playlists.map(p => ({ name: p.title, kind: 'playlist' as const, icon: 'queue_music', tracks: p.tracks }))];
  }

  /** Whether a name is Helix music (as opposed to a radio source). */
  isMusic(media: string): boolean {
    if (!this.linked()) return false;
    const n = media.trim().toLowerCase();
    return n === 'shuffle all' || n === 'loved' || /^(station|artist|album|song): /i.test(media) || this.specs.has(media)
      || this.playlists.some(p => p.title.toLowerCase() === n);
  }

  /** Words someone said ("Bangla Collection", "my loved songs", "Coke Studio") → the name to play, by Helix's own rule. */
  async find(words: string, opts: { station?: boolean } = {}): Promise<{ media: string; kind: string } | null> {
    const pick = await this.get<SiriPick>(`/v1/music/siri?name=${encodeURIComponent(words)}`).catch(() => null);
    if (!pick || pick.kind === 'none') return null;
    if (pick.kind === 'default') return { media: 'Shuffle all', kind: 'all' };
    if (pick.kind === 'loved') return { media: 'Loved', kind: 'loved' };
    if (pick.kind === 'playlist' && pick.id) {
      const title = pick.title || words;
      this.specs.set(title, { kind: 'playlist', id: pick.id, title });
      return { media: title, kind: 'playlist' };
    }
    if ((pick.kind === 'artist' || pick.kind === 'album' || pick.kind === 'track') && pick.id) {
      const title = pick.title || words;
      const kind = opts.station ? 'station' : pick.kind;
      const media = `${kind === 'track' ? 'Song' : kind[0].toUpperCase() + kind.slice(1)}: ${title}${pick.kind === 'track' && pick.artist ? ` (${pick.artist})` : ''}`;
      this.specs.set(media, { kind, id: pick.id, seedKind: pick.kind, title });
      return { media, kind };
    }
    return null;
  }

  /** What a name means, looking it up when Ask didn't just resolve it. */
  private async spec(media: string): Promise<Spec | null> {
    const known = this.specs.get(media);
    if (known) return known;
    const n = media.trim().toLowerCase();
    if (n === 'shuffle all') return { kind: 'all' };
    if (n === 'loved') return { kind: 'loved' };
    const m = /^(station|artist|album|song): (.+)$/i.exec(media.trim());
    if (m) {
      const kind = PREFIX[m[1].toLowerCase()];
      const name = m[2].replace(/ \([^)]*\)$/, '');
      const type = kind === 'station' ? '' : `&type=${kind === 'track' ? 'song' : kind}`;
      const pick = await this.get<SiriPick>(`/v1/music/siri?name=${encodeURIComponent(name)}${type}`).catch(() => null);
      if (!pick?.id || !['artist', 'album', 'track'].includes(pick.kind)) return null;
      const spec: Spec = { kind, id: pick.id, seedKind: pick.kind as 'artist' | 'album' | 'track', title: pick.title || name };
      this.specs.set(media, spec);
      return spec;
    }
    if (!this.playlists.length) await this.catalog(true);
    const pl = this.playlists.find(p => p.title.toLowerCase() === n);
    return pl ? { kind: 'playlist', id: pl.id, title: pl.title } : null;
  }

  /** A name → the queue to play. The same request within a few seconds gets the same order (a group's speakers). */
  queueFor(media: string, opts: { shuffle?: boolean } = {}): Promise<Queue | null> {
    if (!this.linked()) return Promise.resolve(null);
    const key = `${media}\0${opts.shuffle ? 1 : 0}`;
    for (const [k, v] of this.recent) if (this.now - v.at > SAME_ORDER_MS) this.recent.delete(k);
    const hit = this.recent.get(key);
    if (hit) return hit.queue;
    const queue = this.build(media, opts).catch(e => { this.recent.delete(key); throw e; });
    this.recent.set(key, { at: this.now, queue });
    return queue;
  }

  private async build(media: string, opts: { shuffle?: boolean }): Promise<Queue | null> {
    const spec = await this.spec(media);
    if (!spec) return null;
    let tracks: HelixTrack[] = [];
    let shuffle = !!opts.shuffle;
    switch (spec.kind) {
      case 'all': {
        // Helix's own uniform shuffle of the whole library, where it has one.
        const page = await this.get<{ tracks?: HelixTrack[]; seed?: unknown }>('/v1/music/tracks?shuffle=1&limit=1000').catch(() => null);
        if (page?.seed !== undefined && page.tracks?.length) return this.queue(media, page.tracks, false, true);
        for (let offset = 0; offset < LIBRARY_MAX; offset += 2000) {
          const page = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?limit=2000&offset=${offset}`)).tracks ?? [];
          tracks.push(...page);
          if (page.length < 2000) break;
        }
        shuffle = true;
        break;
      }
      case 'loved': tracks = (await this.get<{ tracks?: HelixTrack[] }>('/v1/music/tracks?loved=1&limit=2000')).tracks ?? []; break;
      case 'playlist': tracks = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/playlists/${encodeURIComponent(spec.id)}`)).tracks ?? []; break;
      case 'artist': tracks = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?artist=${encodeURIComponent(spec.id)}&limit=2000`)).tracks ?? []; break;
      case 'album': tracks = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?album=${encodeURIComponent(spec.id)}&limit=2000`)).tracks ?? []; break;
      case 'track': {
        // One song, then a station from it so the music carries on.
        const [one, mix] = await Promise.all([
          this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?ids=${encodeURIComponent(spec.id)}`),
          this.get<{ tracks?: HelixTrack[] }>(`/v1/music/mix?kind=track&seed=${encodeURIComponent(spec.id)}&limit=50`).catch(() => ({ tracks: [] })),
        ]);
        tracks = [...(one.tracks ?? []), ...(opts.shuffle ? shuffled(mix.tracks ?? [], this.o.random) : mix.tracks ?? [])];
        return this.queue(media, tracks, false, opts.shuffle);
      }
      case 'station': {
        // Helix's mix leaves out the seed artist; a station is better with some of theirs mixed in.
        const mix = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/mix?kind=${spec.seedKind}&seed=${encodeURIComponent(spec.id)}&limit=100`)).tracks ?? [];
        const own = spec.seedKind === 'artist'
          ? (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?artist=${encodeURIComponent(spec.id)}&limit=200`).catch(() => ({ tracks: [] }))).tracks ?? []
          : [];
        tracks = [...mix, ...shuffled(own, this.o.random).slice(0, Math.ceil(mix.length / 3))];
        shuffle = true;
        break;
      }
    }
    return this.queue(media, tracks, shuffle);
  }

  private queue(label: string, tracks: HelixTrack[], shuffle: boolean, shown = shuffle): Queue | null {
    const h = this.linked()!;
    const seen = new Set<string>();
    const playable: QueueTrack[] = [];
    for (const t of tracks) {
      if (seen.has(t.id) || !(t.hasFile || t.streamable)) continue;
      seen.add(t.id);
      playable.push(this.track(t, h));
    }
    if (!playable.length) throw new Error(`Helix has no songs to play in “${label}”`);
    const ordered = shuffle ? shuffled(playable, this.o.random) : playable;
    const signed = new Set<QueueTrack>();
    return { label, tracks: ordered, shuffle: shown, prepare: (from, to) => this.sign(ordered.slice(from, to).filter(t => !signed.has(t)), signed) };
  }

  /** Swap the token URLs of these songs for ones Helix signs (no token, that song only). An older Helix keeps the token URLs. */
  private async sign(tracks: QueueTrack[], done: Set<QueueTrack>): Promise<void> {
    if (this.signing === false) return;
    const h = this.linked();
    if (!h) return;
    for (let i = 0; i < tracks.length; i += 8) {
      await Promise.all(tracks.slice(i, i + 8).map(async t => {
        // Songs on disk only (a service's song plays through Helix's relay URL as it is).
        if (!/^helix:/.test(t.id) || done.has(t) || !t.url.includes('/stream?max=aac&token=')) return;
        try {
          const r = await this.post<{ url?: string; path?: string }>(`/v1/items/${encodeURIComponent(t.id.replace(/^helix:/, ''))}/play-url`, { format: 'aac', maxRate: 48000, ttl: 21600, profile: h.profile });
          const url = r.url && /^https?:\/\//.test(r.url) ? r.url : r.path ? `${h.url}${r.path}` : null;
          if (!url) return;
          t.url = url;
          t.contentType = 'audio/aac';
          done.add(t);
          this.signing = true;
        } catch (e) {
          // Helix without signed URLs (the route itself is missing: a plain 404 or a 405): stay on token URLs from now on.
          // A 404 with Helix's own {error} is about that song, not the route.
          const { status, body } = e as { status?: number; body?: unknown };
          if (this.signing === null && (status === 405 || (status === 404 && !(body && typeof body === 'object')))) this.signing = false;
        }
      }));
      if ((this.signing as boolean | null) === false) return;
    }
  }

  private track(t: HelixTrack, h: { url: string; token: string }): QueueTrack {
    const tok = `token=${encodeURIComponent(h.token)}`;
    // A song on disk: the AAC/MP4 rendition every speaker plays. A service's song: Helix's relay (its url already carries the token).
    const url = t.hasFile ? `${h.url}/v1/music/tracks/${encodeURIComponent(t.id.replace(/^helix:/, ''))}/stream?max=aac&${tok}` : t.url!;
    const art = t.posterUrl ? (/^https?:\/\//.test(t.posterUrl) ? t.posterUrl : `${h.url}${t.posterUrl}${t.posterUrl.includes('?') ? '&' : '?'}w=600&${tok}`) : undefined;
    return {
      // max=aac turns lossless into AAC/MP4 and passes lossy files through as they are.
      id: t.id, url, contentType: /mp3|mpeg/i.test(t.codec ?? '') ? 'audio/mpeg' : t.hasFile ? 'audio/mp4' : 'audio/mpeg',
      title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}),
      ...(art ? { art } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}),
    };
  }
}
