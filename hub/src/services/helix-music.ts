import type { AudioFormat, Queue, QueueOptions, QueueTrack } from '../adapters/sdk.ts';
import type { Device } from '../model/types.ts';
import { helixFeatures, helixHeaders, profileProblem } from '../adapters/helix.ts';
import { LanHttpError, lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * Helix music on any speaker: Kova turns a name into the tracks to queue, and the speaker
 * (Cast, Sonos, AirPlay) fetches each song straight from Helix Server.
 *
 * Names (what a speaker's `media` says while it plays):
 *   "Shuffle all"        the whole library, shuffled
 *   "Loved"              the loved songs
 *   "Recently added"     the newest songs in the library, newest first
 *   "Most played"        the most played songs, most played first
 *   "<playlist title>"   a playlist, in order (or shuffled)
 *   "Station: <name>"    a station from an artist, album or song: Helix's mix plus the artist's own songs, shuffled
 *   "Artist: <name>", "Album: <name>", "Song: <name>"   what Ask found by name
 *
 * Everything is for one Helix profile (`musicProfile`, default "default"): loved songs, Most played, playlists,
 * mixes, Siri-style lookups and plays are per profile. It goes with every call: `?profile=` and X-Helix-Profile on
 * reads, `profile` in play-url, `profileId` in played. A locked profile (403) or an unknown one (404) is said plainly.
 *
 * Songs: a speaker can't send headers, so each song gets a URL it can fetch by itself. Helix signs one per song
 * (`POST /v1/items/<id>/play-url {format, maxRate: 48000, ttl, profile}`: no token in it, that song only), and Kova asks
 * for them a window at a time, just before a speaker queues those songs (Queue.prepare). The format is the speaker's
 * (QueueOptions.format): "flac" serves a fitting file as it is, with Range and no transcoding, "aac" transcodes every
 * song. A signed URL is reused until shortly before its ttl runs out. A song Helix has no file for (a service's song in
 * Loved or a station: 404 "this song has no file") is skipped. Only a Helix from before signed URLs (play-url itself
 * missing: a plain 404 or a 405) gets `/v1/music/tracks/<id>/stream?max=aac&token=<Kova's device token>`, which puts
 * the token in the speaker's hands.
 * Shuffle all is Helix's own uniform shuffle of the whole library (`?shuffle=1`) where it has one.
 * Covers are signed the same way: play-url also returns the song's cover as `artUrl` (or null), and any cover still
 * carrying the token goes through `POST /v1/art-urls` in one call per window. Only a Helix with neither keeps it.
 *
 * A song counts as played in Helix (`POST /v1/music/tracks/<id>/played`) once a speaker has played at least 85% of it
 * (PlayCounter), with the speaker's name and the song's length; Helix marks a repeat within 2 minutes a duplicate.
 */
export interface HelixMusicConfig { url?: string; token?: string; /** Helix profile whose loved songs and playlists Kova uses. Default "default". */ musicProfile?: string }

interface HelixTrack {
  id: string; title: string; artist?: string; album?: string; posterUrl?: string; durationMs?: number;
  url?: string; hasFile?: boolean; streamable?: boolean; provisional?: boolean; codec?: string; playCount?: number;
}
interface Playlist { id: string; title: string; kind?: string; tracks?: number }
interface SiriPick { kind: 'artist' | 'album' | 'track' | 'playlist' | 'loved' | 'default' | 'none'; id?: string; title?: string; artist?: string }

/** The Media page's four ways into the library. */
const CHOICES: MusicItem[] = [
  { name: 'Shuffle all', kind: 'all', icon: 'shuffle' },
  { name: 'Loved', kind: 'loved', icon: 'favorite' },
  { name: 'Recently added', kind: 'added', icon: 'new_releases' },
  { name: 'Most played', kind: 'played', icon: 'trending_up' },
];
/** How many songs Recently added and Most played hold. */
const RECENT_MAX = 200;

export interface MusicItem { name: string; kind: 'all' | 'loved' | 'added' | 'played' | 'playlist'; icon: string; tracks?: number }

/** What a name means to Helix. */
type Spec =
  | { kind: 'all' } | { kind: 'loved' } | { kind: 'added' } | { kind: 'played' }
  | { kind: 'playlist'; id: string; title: string }
  | { kind: 'station' | 'artist' | 'album' | 'track'; id: string; seedKind: 'artist' | 'album' | 'track'; title: string };

const PREFIX: Record<string, 'station' | 'artist' | 'album' | 'track'> = { station: 'station', artist: 'artist', album: 'album', song: 'track' };
const LIBRARY_MAX = 4000;
const SAME_ORDER_MS = 60_000;
/** How long a signed song URL lasts (Helix takes 60–86400 s), and how long before the end Kova asks for a new one. */
export const SIGNED_TTL_S = 21_600;
const RESIGN_BEFORE_MS = 10 * 60_000;
/** The share of a song a speaker must play for it to count as played. */
export const PLAYED_SHARE = 0.85;

/** Fisher–Yates, with an injectable random for tests. */
export function shuffled<T>(a: T[], random = Math.random): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/**
 * The content type of a song as Helix serves it: by the `format` it answers ("flac", "mp3", "aac"; "" is the original
 * file, typed by the song's own codec).
 */
export function typeOf(served: string | undefined, codec?: string): string {
  const f = (served ?? '').toLowerCase();
  if (f === 'flac') return 'audio/flac';
  if (f === 'mp3') return 'audio/mpeg';
  if (f === 'aac') return 'audio/aac';
  const c = (codec ?? '').toLowerCase();
  if (/mp3|mpeg/.test(c)) return 'audio/mpeg';
  if (/aac|m4a|mp4|alac/.test(c)) return 'audio/mp4';
  if (/opus|ogg|vorbis/.test(c)) return 'audio/ogg';
  if (/wav/.test(c)) return 'audio/wav';
  return 'audio/flac';
}

/** A song URL Helix signed, kept until shortly before it runs out. */
interface Signed { url: string; contentType: string; art?: string | null; until: number }

export class HelixMusic {
  private playlists: Playlist[] = [];
  private listedAt = 0;
  /** Names Ask resolved, so playing it again doesn't need another lookup. */
  private specs = new Map<string, Spec>();
  /** Recent answers, so every speaker of a group gets the same order (each format a copy of the same songs). */
  private recent = new Map<string, { at: number; queue: Promise<Queue | null>; views: Map<AudioFormat, Promise<Queue | null>> }>();
  /** Whether Helix signs per-song URLs (null: not asked yet). */
  private signing: boolean | null = null;
  /** Whether Helix signs cover URLs in a batch (null: not asked yet). */
  private artSigning: boolean | null = null;
  /** Each song's cover as Helix listed it, without the token, for signing; and its codec. */
  private artPath = new WeakMap<QueueTrack, string>();
  private codecOf = new WeakMap<QueueTrack, string>();
  /** When each queued song's signed URL runs out. */
  private signedUntil = new WeakMap<QueueTrack, number>();
  /** Signed URLs by song and format, reused while they last. */
  private signedCache = new Map<string, Signed>();
  /** What's wrong with the profile, from Helix's last answer (null: nothing). */
  private trouble: string | null = null;
  /** Whether Helix offers music to its clients (`/v1/client/features`); null when it doesn't say. */
  private musicOn: boolean | null = null;

  constructor(private cfg: () => HelixMusicConfig | undefined, private o: { random?: () => number; now?: () => number } = {}) {}

  private get now() { return this.o.now?.() ?? Date.now(); }
  private linked(): { url: string; token: string; profile: string } | null {
    const c = this.cfg();
    return c?.url && c.token ? { url: trimUrl(c.url), token: c.token, profile: c.musicProfile?.trim() || 'default' } : null;
  }

  /** What's wrong with the Helix profile Kova uses, if anything (for the integration's status). */
  problem(): string | null { return this.trouble; }

  private noted<T>(p: Promise<T>, profile: string): Promise<T> {
    return p.then(r => { this.trouble = null; return r; }, e => {
      const said = profileProblem(e, profile);
      if (said) { this.trouble = said; throw new Error(said); }
      throw e;
    });
  }

  private async get<T>(path: string): Promise<T> {
    const h = this.linked();
    if (!h) throw new Error('Pair Kova with Helix first');
    const sep = path.includes('?') ? '&' : '?';
    return this.noted(lanJson<T>(`${h.url}${path}${sep}profile=${encodeURIComponent(h.profile)}`, { token: h.token, headers: helixHeaders(h.profile), timeoutMs: 15_000 }).then(r => r.json), h.profile);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const h = this.linked();
    if (!h) throw new Error('Pair Kova with Helix first');
    return this.noted(lanJson<T>(`${h.url}${path}`, { method: 'POST', body, token: h.token, headers: helixHeaders(h.profile), timeoutMs: 15_000 }).then(r => r.json), h.profile);
  }

  /** Count a song a speaker played to (nearly) the end as played in Helix, under the speaker's name. */
  async played(trackId: string, player: string, durationMs?: number): Promise<void> {
    const h = this.linked();
    if (!h || !/^helix:/.test(trackId)) return;
    await this.post(`/v1/music/tracks/${encodeURIComponent(trackId.replace(/^helix:/, ''))}/played`, {
      profileId: h.profile, player, playedAt: new Date(this.now).toISOString(), ...(durationMs ? { durationMs: Math.round(durationMs) } : {}),
    }).catch(() => {});
  }

  /**
   * What to offer on the Media page: four ways in, not every playlist (playlists still play by name,
   * from Ask or a mode). The playlists are still read, so their names are known.
   */
  async catalog(force = false): Promise<MusicItem[]> {
    const h = this.linked();
    if (!h) return [];
    if (force || this.now - this.listedAt > 5 * 60_000) {
      const f = await helixFeatures(h.url, h.token, h.profile);
      this.musicOn = f && typeof f.music === 'boolean' ? f.music : null;
      try {
        this.playlists = ((await this.get<{ playlists?: Playlist[] }>('/v1/playlists?kind=music')).playlists ?? []).filter(p => !p.kind || p.kind === 'music');
        this.listedAt = this.now;
      } catch { /* keep the last list */ }
    }
    return this.musicOn === false ? [] : CHOICES;
  }

  /** The last catalog, without asking Helix (for the snapshot). */
  cached(): MusicItem[] {
    if (!this.linked() || this.musicOn === false) return [];
    return CHOICES;
  }

  /** Whether a name is Helix music (as opposed to a radio source). */
  isMusic(media: string): boolean {
    if (!this.linked() || this.musicOn === false) return false;
    const n = media.trim().toLowerCase();
    return CHOICES.some(c => c.name.toLowerCase() === n) || /^(station|artist|album|song): /i.test(media) || this.specs.has(media)
      || this.playlists.some(p => p.title.toLowerCase() === n);
  }

  /** Words someone said ("my loved songs", a playlist's or an artist's name) → the name to play, by Helix's own rule. */
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
    if (n === 'recently added') return { kind: 'added' };
    if (n === 'most played') return { kind: 'played' };
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

  /**
   * A name → the queue to play, with URLs in the speaker's format. The same request within a few seconds gets the same
   * order (a group's speakers), each format its own copy of the songs.
   */
  queueFor(media: string, opts: QueueOptions = {}): Promise<Queue | null> {
    if (!this.linked()) return Promise.resolve(null);
    const key = `${media}\0${opts.shuffle ? 1 : 0}`;
    for (const [k, v] of this.recent) if (this.now - v.at > SAME_ORDER_MS) this.recent.delete(k);
    let hit = this.recent.get(key);
    if (!hit) {
      const queue = this.build(media, opts).catch(e => { this.recent.delete(key); throw e; });
      hit = { at: this.now, queue, views: new Map() };
      this.recent.set(key, hit);
    }
    const format = opts.format ?? 'aac';
    let view = hit.views.get(format);
    if (!view) {
      view = hit.queue.then(q => q && this.view(q, format));
      hit.views.set(format, view);
    }
    return view;
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
      case 'added': tracks = (await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?sort=added&limit=${RECENT_MAX}`)).tracks ?? []; break;
      case 'played': tracks = ((await this.get<{ tracks?: HelixTrack[] }>(`/v1/music/tracks?sort=played&limit=${RECENT_MAX}`)).tracks ?? []).filter(t => (t.playCount ?? 0) > 0); break;
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

  /** The songs in playing order (one list for every format; each format gets its own copy, view()). */
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
    return { label, tracks: shuffle ? shuffled(playable, this.o.random) : playable, shuffle: shown };
  }

  /** The queue for one format: the same songs in the same order, URLs signed for that format just before they're queued. */
  private view(q: Queue, format: AudioFormat): Queue {
    const tracks = q.tracks.map(t => {
      const c: QueueTrack = { ...t };
      const art = this.artPath.get(t), codec = this.codecOf.get(t);
      if (art) this.artPath.set(c, art);
      if (codec) this.codecOf.set(c, codec);
      return c;
    });
    const sign = (list: QueueTrack[], from: number, to: number) => this.sign(list, from, to, format);
    // A method, not an arrow: a speaker that reorders the queue ({...queue, tracks}) gets the songs of its own order signed.
    return { label: q.label, tracks, shuffle: q.shuffle, prepare(from, to) { return sign(this.tracks, from, to); } };
  }

  /**
   * Make tracks[from..to) playable by a speaker on its own: a URL Helix signs (no token, that song only), reused while
   * it lasts. A song Helix has no file for is taken out of the queue and the next one moves up, so the window stays
   * full. An older Helix keeps the token URLs. Anything else failing takes the song out rather than hand over the token.
   */
  private async sign(list: QueueTrack[], from: number, to: number, format: AudioFormat): Promise<void> {
    if (this.signing === false) return;
    const h = this.linked();
    if (!h) return;
    const fresh = (t: QueueTrack) => (this.signedUntil.get(t) ?? 0) > this.now;
    let i = from;
    while (i < Math.min(to, list.length)) {
      const stretch = list.slice(i, Math.min(i + 8, to, list.length));
      const need = stretch.filter(t => /^helix:/.test(t.id) && !fresh(t));
      const out = await Promise.all(need.map(t => this.signOne(t, h, format).then(r => [t, r] as const)));
      if ((this.signing as boolean | null) === false) return;
      // A song dropped from this stretch: the ones after it move up, and are signed in turn.
      const drop = out.filter(([, r]) => r === 'drop').map(([t]) => t);
      for (const t of drop) { const k = list.indexOf(t); if (k >= 0) list.splice(k, 1); }
      i += stretch.length - drop.length;
    }
    const window = list.slice(from, Math.min(to, list.length));
    await this.signArt(window.filter(t => t.art?.includes('token=') && this.artPath.has(t)), h.url);
  }

  /** One song's signed URL: 'ok', 'drop' (no file, or Helix won't sign it), or 'old' (a Helix without play-url). */
  private async signOne(t: QueueTrack, h: { url: string; profile: string }, format: AudioFormat): Promise<'ok' | 'drop' | 'old'> {
    const id = t.id.replace(/^helix:/, '');
    const key = `${id}\0${format}\0${h.profile}`;
    const cached = this.signedCache.get(key);
    if (cached && cached.until > this.now) { this.apply(t, cached); return 'ok'; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Helix answers url (absolute), path, expiresAt (Unix seconds), profile, format ("" = the original file), maxRate,
        // artUrl and artPath (null without a cover).
        const r = await this.post<{ url?: string; path?: string; artUrl?: string | null; artPath?: string | null; expiresAt?: number; format?: string }>(
          `/v1/items/${encodeURIComponent(id)}/play-url`, { format, maxRate: 48000, ttl: SIGNED_TTL_S, profile: h.profile });
        const url = r.url && /^https?:\/\//.test(r.url) ? r.url : r.path ? `${h.url}${r.path}` : null;
        if (!url) return 'drop';
        const ends = typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt) ? r.expiresAt * 1000 : NaN;
        const lasts = Number.isFinite(ends) && ends > this.now ? ends - this.now : SIGNED_TTL_S * 1000;
        const cover = r.artUrl ?? r.artPath;
        const s: Signed = {
          url, contentType: typeOf(r.format, this.codecOf.get(t)),
          art: cover === undefined ? undefined : cover === null ? null : abs(h.url, cover),
          until: this.now + Math.max(30_000, lasts - Math.min(RESIGN_BEFORE_MS, lasts / 4)),
        };
        this.signedCache.set(key, s);
        if (this.signedCache.size > 5000) this.signedCache.delete(this.signedCache.keys().next().value!);
        this.apply(t, s);
        this.signing = true;
        return 'ok';
      } catch (e) {
        const { status, body } = e as { status?: number; body?: unknown };
        // play-url itself missing (a plain 404, or 405): a Helix from before signed URLs. Token URLs from now on.
        if (status === 405 || (status === 404 && !(body && typeof body === 'object'))) {
          if (this.signing !== true) { this.signing = false; return 'old'; }
          return 'drop';
        }
        // A 404 with Helix's own {error} is about this song: no file (a service's song). Skipped.
        if (status === 404) return 'drop';
        if (e instanceof LanHttpError && e.status >= 400 && e.status < 500) return 'drop';
        // The network or Helix hiccuped: once more, then the song is left out.
      }
    }
    return 'drop';
  }

  private apply(t: QueueTrack, s: Signed): void {
    t.url = s.url;
    t.contentType = s.contentType;
    if (s.art) t.art = s.art;
    this.signedUntil.set(t, s.until);
  }

  /** Swap token cover URLs for signed ones in one call. A cover Helix won't sign (null) is dropped rather than sent with the token. */
  private async signArt(tracks: QueueTrack[], base: string): Promise<void> {
    if (!tracks.length || this.artSigning === false) return;
    try {
      const r = await this.post<{ urls?: (string | null)[] } | (string | null)[]>('/v1/art-urls', { urls: tracks.map(t => this.artPath.get(t)!), ttl: SIGNED_TTL_S });
      const urls = Array.isArray(r) ? r : r.urls ?? [];
      if (urls.length !== tracks.length) return;
      tracks.forEach((t, i) => { const u = urls[i] ? abs(base, urls[i]!) : null; if (u) t.art = u; else delete t.art; });
      this.artSigning = true;
    } catch (e) {
      const { status, body } = e as { status?: number; body?: unknown };
      if (this.artSigning === null && (status === 405 || (status === 404 && !(body && typeof body === 'object')))) this.artSigning = false;
    }
  }

  private track(t: HelixTrack, h: { url: string; token: string }): QueueTrack {
    const tok = `token=${encodeURIComponent(h.token)}`;
    // A song on disk: the AAC/MP4 rendition every speaker plays (only for a Helix that can't sign). A service's song:
    // Helix's relay (its url already carries the token).
    const url = t.hasFile ? `${h.url}/v1/music/tracks/${encodeURIComponent(t.id.replace(/^helix:/, ''))}/stream?max=aac&${tok}` : t.url!;
    const path = t.posterUrl && !/^https?:\/\//.test(t.posterUrl) ? `${t.posterUrl}${t.posterUrl.includes('?') ? '&' : '?'}w=600` : null;
    const art = path ? `${h.url}${path}&${tok}` : t.posterUrl || undefined;
    const q: QueueTrack = {
      // max=aac turns lossless into AAC/MP4 and passes lossy files through as they are.
      id: t.id, url, contentType: /mp3|mpeg/i.test(t.codec ?? '') ? 'audio/mpeg' : t.hasFile ? 'audio/mp4' : 'audio/mpeg',
      title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}),
      ...(art ? { art } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}),
    };
    if (path) this.artPath.set(q, path);
    if (t.codec) this.codecOf.set(q, t.codec);
    return q;
  }
}

/** A URL Helix handed back, absolute or a path on Helix. */
const abs = (base: string, u: string): string | null => /^https?:\/\//.test(u) ? u : u.startsWith('/') ? `${base}${u}` : null;

/**
 * Counts a song as played once a speaker has played at least 85% of it: the time it was playing (not paused) between it
 * starting and the speaker moving on, stopping or switching off. A song skipped part-way doesn't count.
 */
export class PlayCounter {
  private playing = new Map<string, { id: string; durationMs?: number; since: number | null; playedMs: number }>();

  constructor(private count: (trackId: string, player: string, durationMs?: number) => void, private now: () => number = Date.now) {}

  /** A speaker's state after a change: what it plays now, and whether it's paused or off. */
  seen(d: Pick<Device, 'id' | 'name' | 'state'>): void {
    const s = d.state, t = s.track;
    const cur = this.playing.get(d.id);
    const active = !!t?.id && s.on !== false && s.online !== false;
    const paused = !!s.paused;
    if (cur && (!active || t!.id !== cur.id)) {
      const ms = cur.playedMs + (cur.since != null ? this.now() - cur.since : 0);
      if (cur.durationMs && ms >= PLAYED_SHARE * cur.durationMs) this.count(cur.id, d.name, cur.durationMs);
      this.playing.delete(d.id);
    }
    if (!active) return;
    const now = this.playing.get(d.id);
    if (!now) { this.playing.set(d.id, { id: t!.id!, durationMs: t!.durationMs, since: paused ? null : this.now(), playedMs: 0 }); return; }
    if (paused && now.since != null) { now.playedMs += this.now() - now.since; now.since = null; }
    else if (!paused && now.since == null) now.since = this.now();
  }
}
