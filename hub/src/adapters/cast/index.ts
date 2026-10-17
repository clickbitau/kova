import mdns from 'multicast-dns';
import { findCastGroups } from '../../services/lan-find.ts';
import type { Adapter, AdapterContext, AdapterStatus, Clip, NativeGroup, PlaybackPosition, Queue, QueueTrack } from '../sdk.ts';
import { partition } from '../../engine/group-sync.ts';
import { mmss } from '../../devices/registry.ts';
import type { Command, Device, DeviceState, Track } from '../../model/types.ts';
import { CastChannel, NS, type CastMessage } from './channel.ts';

// Google Cast speakers, displays and TVs (Nest Audio, Nest Hub, Chromecast…).
// Perfect multi-room sync comes from Cast groups: when several speakers are
// told to play the same thing at once, Kova plays it on the Cast groups whose
// members are exactly some of those speakers (the fewest streams), and the
// speakers in each keep themselves in sync. The rest play on their own.

const DEFAULT_RECEIVER = 'CC1AD845';

export interface CastEndpoint { id: string; name: string; model: string; host: string; port: number; group: boolean }

export interface CastOptions {
  /** Endpoints to use without mDNS (e.g. on another VLAN), or extra ones. */
  endpoints?: Omit<CastEndpoint, 'group'>[];
  discover?: boolean;
  discoverMs?: number;
  /** Cast device name → Kova room id. Unmatched names become a room id from the name. */
  rooms?: Record<string, string>;
  /** Cast device name → Kova device id to use. */
  ids?: Record<string, string>;
  pollMs?: number;
  /** Window in which commands are collected so simultaneous plays can use a group. */
  batchMs?: number;
  /** How long an announcement may sit buffering at its start before it's loaded again (default 8 s). */
  unstickMs?: number;
  /** How long a speaker may take to load an announcement before it's left out (default 10 s). */
  clipLoadMs?: number;
  /** How long speakers loading an announcement together are given to hold the file before all start (default 4 s). */
  clipReadyMs?: number;
  /** When, after an announcement on several speakers starts, they're checked to be together (ms; tests shorten it). */
  syncChecksMs?: number[];
  /** Plain TCP instead of TLS (tests only). */
  insecure?: boolean;
  /** The ports a moved speaker group is looked for on (default 32000–32999; tests narrow it). */
  groupPorts?: { from: number; to: number };
  timeoutMs?: number;
}

interface Pending { device: Device; cmd: Command; resolve: (did?: DeviceState) => void; reject: (e: Error) => void }

const isGroupModel = (md: string) => /cast group/i.test(md);
const contentType = (url: string) => /\.m3u8(\?|$)/i.test(url) ? 'application/x-mpegURL' : /\.flac(\?|$)/i.test(url) ? 'audio/flac' : /\.aac(\?|$)/i.test(url) ? 'audio/aac' : /\.(mp4|m4a)(\?|$)/i.test(url) ? 'audio/mp4' : 'audio/mpeg';

/** Every Cast speaker, display and group plays FLAC (up to 96 kHz / 24-bit), so Helix's songs go as they are, untranscoded. */
export const CAST_FORMAT = 'flac' as const;

/** How many songs a Cast queue holds ahead at once; more are added as it plays (stream URLs stay short-lived on the speaker). */
export const CAST_WINDOW = 20;

/** The song as Kova shows it. */
const shown = (t: QueueTrack): Track => ({ id: t.id, title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}), ...(t.art ? { art: t.art } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}) });

/** A queue item for the default media receiver: a music track with its metadata, tagged with its place in Kova's queue. */
function queueItem(t: QueueTrack, index: number) {
  return {
    autoplay: true, preloadTime: 10, customData: { kova: index },
    media: {
      contentId: t.url, contentType: t.contentType, streamType: 'BUFFERED', customData: { kova: index },
      ...(t.durationMs ? { duration: t.durationMs / 1000 } : {}),
      metadata: { metadataType: 3, title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { albumName: t.album } : {}), ...(t.art ? { images: [{ url: t.art }] } : {}) },
    },
  };
}

interface MediaStatus {
  mediaSessionId?: number; playerState?: string; idleReason?: string; currentItemId?: number; currentTime?: number; repeatMode?: string;
  media?: { contentId?: string; customData?: { kova?: number }; metadata?: { title?: string } }; items?: { itemId: number; customData?: { kova?: number }; media?: { customData?: { kova?: number } } }[];
}

/** A stream or recording a speaker plays; a looping one may come as the hub's endless stream of it (`endless`). */
type Stream = { url: string; title: string; loop: boolean; endless?: string };

/** One Cast receiver: a speaker, display, TV or group. */
class Receiver {
  readonly ch: CastChannel;
  media: string | null = null;
  /** A play queue (Helix music): the songs in order, where it is, and what the speaker holds. */
  queue: { q: Queue; index: number; from: number; to: number; session?: number; position: number; topping?: boolean; items?: Map<number, number>; asking?: number } | null = null;
  private transport: string | null = null;
  /** Playback is paused (on hold, not stopped), as the speaker last said. */
  paused = false;
  /** Called when the song changes or the queue ends. */
  onTrack?: () => void;
  /** Called when the speaker drops what it was given by itself (it couldn't fetch or play it): for Activity. */
  onProblem?: (p: { title: string; reason: string; from: string; endless: boolean; retrying: boolean }) => void;
  /**
   * Called when a looping sound stopped and the speaker didn't say it failed: stopped from another app or by voice
   * (CANCELLED), another app cast over it (INTERRUPTED), or the media player went away with no reason given.
   */
  onStopped?: (p: { title: string; reason: string; appId: string | null; restarting: boolean }) => void;
  /** The speaker's last idle status: why it stopped, and when. */
  lastIdle: { reason: string; at: number } | null = null;
  /** The stream or recording it plays (play()), to start it again after an announcement; `endless`: the hub's endless stream of it, playing. */
  stream: Stream | null = null;
  /** This speaker couldn't play an endless stream: loops go as a repeating queue. */
  private noEndless = false;
  private endlessAt = 0;
  /** The endless stream now loaded has been heard playing. */
  private endlessPlayed = false;
  /** An announcement clip playing (playClip()): when it finishes, the speaker is idle again. */
  clip: string | null = null;
  /** An announcement played together with other speakers: the moment its start was (or would have been) heard. */
  together: number | null = null;
  /** When a looping sound was last started again after the speaker dropped it (the last hour's). */
  private restarts: number[] = [];

  private unstickMs: number;
  constructor(readonly ep: CastEndpoint, o: CastOptions) {
    this.unstickMs = o.unstickMs ?? 8000;
    this.ch = new CastChannel({ host: ep.host, port: ep.port, insecure: o.insecure, timeoutMs: o.timeoutMs });
    this.ch.on('message', m => {
      if (m.namespace === NS.media && m.data.type === 'MEDIA_STATUS') this.onStatus((m.data.status as MediaStatus[] | undefined)?.[0]);
    });
  }

  get track(): Track | null { return this.queue ? shown(this.queue.q.tracks[this.queue.index]) : null; }

  async status() {
    await this.ch.connect();
    const m = await this.ch.request(NS.receiver, 'receiver-0', { type: 'GET_STATUS' });
    const st = m.data.status as { volume?: { level?: number; muted?: boolean }; applications?: { appId: string; sessionId: string; transportId: string; isIdleScreen?: boolean }[] } | undefined;
    return { volume: st?.volume ?? {}, app: st?.applications?.[0] };
  }

  /** The default media receiver, launched if needed, with its media channel connected. */
  private async receiverApp(): Promise<string> {
    let { app, volume } = await this.status();
    if (volume.muted) await this.volume(0, false);
    if (!app || app.appId !== DEFAULT_RECEIVER) {
      const m = await this.ch.request(NS.receiver, 'receiver-0', { type: 'LAUNCH', appId: DEFAULT_RECEIVER });
      app = (m.data.status as { applications?: typeof app[] })?.applications?.find(a => a?.appId === DEFAULT_RECEIVER);
      if (!app) throw new Error(`${this.ep.name} didn't start the media player`);
    }
    this.ch.connectTo(app.transportId);
    this.transport = app.transportId;
    return app.transportId;
  }

  /**
   * The media player is open but Kova holds nothing for it (Kova restarted while it played, or it's left open a few
   * minutes after an announcement): what it holds, asked of it. A stream or a recording is taken as Kova's own again,
   * so it shows by its name, loops, and comes back after an announcement. False when it plays nothing.
   */
  async adopt(transport: string): Promise<boolean> {
    this.ch.connectTo(transport);
    this.transport = transport;
    const m = await this.ch.request(NS.media, transport, { type: 'GET_STATUS' });
    const st = (m.data.status as MediaStatus[] | undefined)?.[0];
    if (!st?.media?.contentId || !st.playerState || st.playerState === 'IDLE') return false;
    this.paused = st.playerState === 'PAUSED';
    // A song of a queue Kova lost: playing, but not something to start again on its own.
    if (typeof st.media.customData?.kova === 'number') return true;
    const title = st.media.metadata?.title || 'Casting';
    const id = st.media.contentId, endless = /[?&]endless=1\b/.test(id);
    this.media = title;
    this.stream = endless
      ? { url: id.replace(/[?&]endless=1\b/, ''), title, loop: true, endless: id }
      : { url: id, title, loop: st.repeatMode === 'REPEAT_ALL' || st.repeatMode === 'REPEAT_SINGLE' };
    return true;
  }

  /**
   * Play a stream or a recording; `loop` plays a recording again from the start each time it ends. With `endless` (the
   * hub's endless stream of the loop) it's one item that never ends: no seam at all. A speaker that can't play that
   * gets the repeating queue instead, from then on.
   */
  async play(url: string, title: string, loop = false, endless?: string): Promise<void> {
    const transport = await this.receiverApp();
    if (loop && endless && !this.noEndless) {
      const e = await this.ch.request(NS.media, transport, {
        type: 'LOAD', autoplay: true,
        media: { contentId: endless, contentType: 'audio/flac', streamType: 'LIVE', metadata: { metadataType: 0, title } },
      });
      if (e.data.type !== 'LOAD_FAILED' && e.data.type !== 'LOAD_CANCELLED' && e.data.type !== 'INVALID_REQUEST') {
        this.media = title;
        this.queue = null;
        this.stream = { url, title, loop, endless };
        this.clip = null;
        this.endlessAt = Date.now();
        this.endlessPlayed = (e.data.status as MediaStatus[] | undefined)?.[0]?.playerState === 'PLAYING';
        return;
      }
      console.warn(`[cast] ${this.ep.name}: couldn't play ${title} as an endless stream; repeating it instead`);
      this.noEndless = true;
    }
    const r = loop
      ? await this.ch.request(NS.media, transport, {
        // Two of it, repeating the queue: the speaker fetches the next copy before this one ends and flows into it.
        // One item on REPEAT_SINGLE ends instead on a Google speaker (FINISHED, hourly) and leaves a gap to restart.
        type: 'QUEUE_LOAD', startIndex: 0, repeatMode: 'REPEAT_ALL',
        items: [0, 1].map(() => ({ autoplay: true, preloadTime: 30, media: { contentId: url, contentType: contentType(url), streamType: 'BUFFERED', metadata: { metadataType: 0, title } } })),
      })
      : await this.ch.request(NS.media, transport, {
        type: 'LOAD', autoplay: true,
        media: { contentId: url, contentType: contentType(url), streamType: 'LIVE', metadata: { metadataType: 0, title } },
      });
    if (r.data.type === 'LOAD_FAILED' || r.data.type === 'LOAD_CANCELLED' || r.data.type === 'INVALID_REQUEST') throw new Error(`${this.ep.name} couldn't play ${title}`);
    this.media = title;
    this.queue = null;
    this.stream = { url, title, loop };
    this.clip = null;
  }

  /**
   * Play an announcement once, buffered (not as a live stream), with its title. With `vols` (this speaker, or a
   * group's members, each at a level 0–100): loaded paused, the volumes set, then played — a Google speaker beeps at a
   * volume change only while it plays nothing, so set before, the announcement starts with beeps. A speaker that put
   * its own level back a moment later (a soundbar) is set again once.
   */
  async playClip(clip: Clip, vols?: { rec: Receiver; level: number }[]): Promise<void> {
    const loaded = await this.loadClip(clip, vols, !vols?.length);
    if (vols?.length) await this.startClip(loaded);
  }

  /**
   * An announcement loaded and ready (paused unless `autoplay`), at its volumes: started by startClip, so several
   * speakers loaded one by one start in the same moment.
   */
  async loadClip(clip: Clip, vols?: { rec: Receiver; level: number }[], autoplay = false): Promise<{ transport: string; session?: number; clip: Clip; vols?: { rec: Receiver; level: number }[] }> {
    const transport = await this.receiverApp();
    const r = await this.ch.request(NS.media, transport, {
      type: 'LOAD', autoplay,
      media: { contentId: clip.url, contentType: clip.contentType, streamType: 'BUFFERED', ...(clip.durationMs ? { duration: clip.durationMs / 1000 } : {}), metadata: { metadataType: 0, title: clip.title } },
    });
    if (r.data.type === 'LOAD_FAILED' || r.data.type === 'LOAD_CANCELLED' || r.data.type === 'INVALID_REQUEST') throw new Error(`${this.ep.name} couldn't play ${clip.title}`);
    if (vols?.length) await Promise.allSettled(vols.map(v => v.rec.volume(v.level / 100)));
    this.media = clip.title;
    this.queue = null;
    this.stream = null;
    this.clip = clip.title;
    this.paused = !autoplay;
    this.together = null;
    const session = (r.data.status as MediaStatus[] | undefined)?.[0]?.mediaSessionId;
    if (autoplay) void this.unstick(transport, clip, this.unstickMs);
    return { transport, ...(session != null ? { session } : {}), clip, ...(vols?.length ? { vols } : {}) };
  }

  /** Play what loadClip loaded; one that hasn't got going a few seconds in is loaded again. */
  async startClip(l: { transport: string; session?: number; clip: Clip; vols?: { rec: Receiver; level: number }[] }, together?: number): Promise<void> {
    await this.ch.request(NS.media, l.transport, { type: 'PLAY', ...(l.session != null ? { mediaSessionId: l.session } : {}) });
    this.paused = false;
    this.together = together ?? null;
    if (l.vols?.length) void this.holdVolumes(l.vols);
    void this.unstick(l.transport, l.clip, this.unstickMs);
  }

  /** Loaded and waiting to start (the speaker holds the file, paused), by `until`; false if it's still fetching it. */
  async clipReady(transport: string, until: number): Promise<boolean> {
    for (;;) {
      const st = await this.clipNow(transport);
      if (st && (st.state === 'PAUSED' || st.state === 'PLAYING')) return true;
      if (Date.now() >= until) return false;
      await new Promise(r => setTimeout(r, 200).unref?.());
    }
  }

  /** Where the announcement is: its session, state and seconds in, as of `at` (half the round trip ago). */
  async clipNow(transport: string): Promise<{ session?: number; state: string; pos: number; at: number } | null> {
    const t = Date.now();
    const m = await this.ch.request(NS.media, transport, { type: 'GET_STATUS' }).catch(() => null);
    const st = (m?.data.status as MediaStatus[] | undefined)?.[0];
    if (!st?.playerState) return null;
    return { ...(st.mediaSessionId != null ? { session: st.mediaSessionId } : {}), state: st.playerState, pos: st.currentTime ?? 0, at: (t + Date.now()) / 2 };
  }

  /** The announcement moved to `sec` seconds in, playing. */
  async seekClip(transport: string, session: number | undefined, sec: number): Promise<void> {
    await this.ch.request(NS.media, transport, { type: 'SEEK', currentTime: Math.max(0, sec), resumeState: 'PLAYBACK_START', ...(session != null ? { mediaSessionId: session } : {}) });
  }

  /** Play a queue from `start` (at `position` seconds into that song): the next CAST_WINDOW songs go to the speaker. */
  async playQueue(q: Queue, start = 0, position = 0): Promise<void> {
    const transport = await this.receiverApp();
    const to = Math.min(q.tracks.length, start + CAST_WINDOW);
    await q.prepare?.(start, to);
    const r = await this.ch.request(NS.media, transport, {
      type: 'QUEUE_LOAD', startIndex: 0, repeatMode: 'REPEAT_OFF', ...(position > 0 ? { currentTime: position } : {}),
      items: q.tracks.slice(start, to).map((t, i) => queueItem(t, start + i)),
    });
    if (r.data.type === 'LOAD_FAILED' || r.data.type === 'LOAD_CANCELLED' || r.data.type === 'INVALID_REQUEST') throw new Error(`${this.ep.name} couldn't play ${q.label}`);
    this.media = q.label;
    this.stream = null;
    this.clip = null;
    this.queue = { q, index: start, from: start, to, position, session: (r.data.status as MediaStatus[] | undefined)?.[0]?.mediaSessionId };
    this.onTrack?.();
  }

  /** A looping sound may be started again (at most LOOP_RESTARTS an hour): takes one when it may. */
  mayRestart(): boolean {
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < 3600_000);
    if (this.restarts.length >= LOOP_RESTARTS) return false;
    this.restarts.push(now);
    return true;
  }

  /** What the speaker says it's playing: follow the queue, and add more songs before it runs out. */
  private onStatus(st: MediaStatus | undefined): void {
    if (st?.playerState) this.paused = st.playerState === 'PAUSED';
    // An announcement that played to its end (or couldn't play): the speaker is idle again.
    if (this.clip && st?.playerState === 'IDLE' && (st.idleReason === 'FINISHED' || st.idleReason === 'ERROR')) {
      this.clip = null;
      this.media = null;
      this.onTrack?.();
      return;
    }
    // A sound set to loop (Thunderstorm) that the speaker dropped by itself (a fetch that failed, the file ended
    // without repeating): started again, at most a few times an hour. One stopped by a person (CANCELLED) or replaced
    // by another app (INTERRUPTED) is left alone.
    const sm = this.stream;
    if (sm?.endless && st?.playerState === 'PLAYING') this.endlessPlayed = true;
    if (st?.playerState === 'IDLE' && st.idleReason) this.lastIdle = { reason: st.idleReason, at: Date.now() };
    if (sm?.loop && st?.playerState === 'IDLE' && (st.idleReason === 'CANCELLED' || st.idleReason === 'INTERRUPTED')) {
      console.warn(`[cast] ${this.ep.name}: ${sm.title} stopped (${st.idleReason}): ${st.idleReason === 'CANCELLED' ? 'from another app or by voice' : 'another app cast over it'}`);
      this.onStopped?.({ title: sm.title, reason: st.idleReason, appId: DEFAULT_RECEIVER, restarting: false });
    }
    if (sm?.loop && st?.playerState === 'IDLE' && (st.idleReason === 'ERROR' || st.idleReason === 'FINISHED')) {
      const now = Date.now();
      // An endless stream this speaker gave up on at once, or without ever playing it (some take minutes to give up on
      // one they can't fetch): it can't play one; the repeating queue from now on.
      if (sm.endless && st.idleReason === 'ERROR' && (now - this.endlessAt < 20_000 || !this.endlessPlayed)) { this.noEndless = true; console.warn(`[cast] ${this.ep.name}: ${sm.title} as an endless stream failed without playing; repeating it instead`); }
      let from = '';
      try { from = new URL(sm.endless ?? sm.url).host; } catch { /* not a URL */ }
      const again = this.mayRestart();
      this.onProblem?.({ title: sm.title, reason: String(st.idleReason), from, endless: !!sm.endless, retrying: again });
      console.warn(`[cast] ${this.ep.name}: ${sm.title} stopped by itself (${st.idleReason})${again ? ', starting it again' : ''}`);
      if (again) setTimeout(() => { if (this.stream === sm) void this.play(sm.url, sm.title, true, sm.endless).catch(e => console.warn(`[cast] ${this.ep.name}: ${(e as Error).message}`)); }, 300).unref?.();
      return;
    }
    const qu = this.queue;
    if (!st || !qu) return;
    if (st.mediaSessionId) qu.session = st.mediaSessionId;
    if (st.currentTime != null) qu.position = st.currentTime;
    // Which song: the receiver's queue items carry their place in Kova's queue. A status doesn't always say (a Cast
    // group's often names only the item id), so the ids seen are kept, and one never seen is asked for.
    const items = (qu.items ??= new Map());
    for (const i of st.items ?? []) { const k = i.customData?.kova ?? i.media?.customData?.kova; if (typeof k === 'number') items.set(i.itemId, k); }
    const fromMedia = st.media?.customData?.kova;
    if (typeof fromMedia === 'number' && st.currentItemId != null) items.set(st.currentItemId, fromMedia);
    const at = fromMedia ?? (st.currentItemId != null ? items.get(st.currentItemId) : undefined);
    if (typeof at === 'number' && at !== qu.index && at >= 0 && at < qu.q.tracks.length) { qu.index = at; this.onTrack?.(); }
    if (at === undefined && st.currentItemId != null && qu.asking !== st.currentItemId && this.transport && qu.session != null) {
      qu.asking = st.currentItemId;
      const id = st.currentItemId;
      void this.ch.request(NS.media, this.transport, { type: 'QUEUE_GET_ITEMS', mediaSessionId: qu.session, itemIds: [id] })
        .then(m => this.onStatus({ ...st, items: (m.data.items as MediaStatus['items']) ?? [] }))
        .catch(() => { if (qu.asking === id) qu.asking = undefined; });
    }
    if (st.playerState === 'IDLE' && st.idleReason === 'FINISHED' && qu.index >= qu.q.tracks.length - 1) {
      this.queue = null;
      this.media = null;
      this.onTrack?.();
      return;
    }
    if (qu.to < qu.q.tracks.length && qu.index >= qu.to - 3 && !qu.topping) void this.topUp();
  }

  private async topUp(): Promise<void> {
    const qu = this.queue;
    if (!qu || !this.transport || qu.session == null) return;
    qu.topping = true;
    try {
      const to = Math.min(qu.q.tracks.length, qu.to + CAST_WINDOW);
      await qu.q.prepare?.(qu.to, to);
      await this.ch.request(NS.media, this.transport, { type: 'QUEUE_INSERT', mediaSessionId: qu.session, items: qu.q.tracks.slice(qu.to, to).map((t, i) => queueItem(t, qu.to + i)) });
      if (this.queue === qu) qu.to = to;
    } catch { /* tried again on the next status */ } finally { qu.topping = false; }
  }

  /** Pause (keep the place) or carry on whatever the speaker's media player is playing. */
  async setPaused(paused: boolean): Promise<void> {
    const { app } = await this.status();
    if (!app || app.isIdleScreen) throw new Error(`${this.ep.name} isn’t playing anything`);
    this.ch.connectTo(app.transportId);
    this.transport = app.transportId;
    const m = await this.ch.request(NS.media, app.transportId, { type: 'GET_STATUS' });
    const session = (m.data.status as MediaStatus[] | undefined)?.[0]?.mediaSessionId ?? this.queue?.session;
    if (session == null) throw new Error(`${this.ep.name} has nothing to ${paused ? 'pause' : 'resume'}`);
    await this.ch.request(NS.media, app.transportId, { type: paused ? 'PAUSE' : 'PLAY', mediaSessionId: session });
    this.paused = paused;
  }

  /** Next (1) or previous (-1) song. */
  async skip(delta: number): Promise<void> {
    const qu = this.queue;
    if (!qu) throw new Error(`${this.ep.name} isn’t playing a queue`);
    const next = qu.index + delta;
    if (next < 0) return this.playQueue(qu.q, 0);
    if (next >= qu.q.tracks.length) throw new Error(`That was the last song in ${qu.q.label}`);
    // Within what the speaker holds, it jumps; outside it (previous before the window, or ahead of a top-up), reload from there.
    if (next >= qu.from && next < qu.to && qu.session != null && this.transport) {
      await this.ch.request(NS.media, this.transport, { type: 'QUEUE_UPDATE', mediaSessionId: qu.session, jump: delta });
      qu.index = next;
      this.onTrack?.();
      return;
    }
    await this.playQueue(qu.q, next);
  }

  /** The same music in a new order (or back in order), carrying on with the song that's playing. */
  async reorder(q: Queue): Promise<void> {
    const qu = this.queue;
    if (!qu) return;
    const cur = qu.q.tracks[qu.index];
    const rest = q.tracks.filter(t => t.id !== cur.id);
    const at = q.shuffle ? 0 : Math.max(0, q.tracks.findIndex(t => t.id === cur.id));
    const tracks = q.shuffle ? [cur, ...rest] : q.tracks;
    await this.playQueue({ ...q, tracks }, at, qu.position);
  }

  /** Ask the speaker where the queue is (after a missed status, or a restart of the poll). */
  async refreshQueue(): Promise<void> {
    if (!this.queue || !this.transport) return;
    try {
      const m = await this.ch.request(NS.media, this.transport, { type: 'GET_STATUS' });
      this.onStatus((m.data.status as MediaStatus[] | undefined)?.[0]);
    } catch { /* the poll reports what the receiver says */ }
  }

  /** Where the queue is now, as the receiver says (its place to the ms, and when that was true). */
  async position(): Promise<PlaybackPosition | null> {
    if (!this.transport) {
      const { app } = await this.status();
      if (!app || app.isIdleScreen) return null;
      this.ch.connectTo(app.transportId);
      this.transport = app.transportId;
    }
    const t0 = Date.now();
    const m = await this.ch.request(NS.media, this.transport, { type: 'GET_STATUS' });
    const t1 = Date.now();
    const st = (m.data.status as MediaStatus[] | undefined)?.[0];
    if (!st) return null;
    this.onStatus(st);
    const qu = this.queue;
    return {
      index: qu?.index ?? 0, positionMs: Math.round((st.currentTime ?? 0) * 1000), at: Math.round((t0 + t1) / 2), playing: st.playerState === 'PLAYING',
      ...(qu?.q.tracks[qu.index]?.durationMs ? { durationMs: qu.q.tracks[qu.index]!.durationMs } : {}), seekStepMs: 1,
    };
  }

  /** To a song in the queue (its place in Kova's queue), `sec` into it: a seek in the same song, a jump within what the receiver holds, else a reload from there. */
  async seekTo(index: number, sec: number): Promise<void> {
    const qu = this.queue;
    if (!qu) throw new Error(`${this.ep.name} isn’t playing a queue`);
    if (index < 0 || index >= qu.q.tracks.length) throw new Error(`${qu.q.label} has no song ${index + 1}`);
    if (qu.session != null && this.transport && index === qu.index) {
      await this.ch.request(NS.media, this.transport, { type: 'SEEK', mediaSessionId: qu.session, currentTime: sec, resumeState: 'PLAYBACK_START' });
      qu.position = sec;
      return;
    }
    if (qu.session != null && this.transport && index > qu.index && index < qu.to) {
      await this.ch.request(NS.media, this.transport, { type: 'QUEUE_UPDATE', mediaSessionId: qu.session, jump: index - qu.index, currentTime: sec });
      qu.index = index;
      qu.position = sec;
      this.onTrack?.();
      return;
    }
    await this.playQueue(qu.q, index, sec);
  }

  async stop(): Promise<void> {
    const { app } = await this.status();
    if (app && !app.isIdleScreen) await this.ch.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId: app.sessionId });
    this.media = null;
    this.queue = null;
    this.stream = null;
    this.clip = null;
  }

  /**
   * A clip that hasn't got going a few seconds in (still buffering at the start, or idle with an error) is loaded again,
   * once: a speaker or group that stalls on a file otherwise stays silent for the whole announcement.
   */
  private async unstick(transport: string, clip: Clip, waitMs = 8000): Promise<void> {
    await new Promise(r => setTimeout(r, waitMs).unref?.());
    if (this.clip !== clip.title) return;
    const m = await this.ch.request(NS.media, transport, { type: 'GET_STATUS' }).catch(() => null);
    const st = (m?.data.status as MediaStatus[] | undefined)?.[0];
    const stuck = !st ? false : (st.playerState === 'BUFFERING' || st.playerState === 'LOADING') && (st.currentTime ?? 0) < 3;
    if (!stuck) return;
    // Played with other speakers: it joins where they are, not from the start (a soundbar seconds behind the rest).
    const join = this.together != null ? Math.max(0, (Date.now() - this.together) / 1000) : 0;
    console.log(`[cast] ${this.ep.name}: ${clip.title} still ${(st!.playerState ?? '').toLowerCase()} after ${waitMs / 1000} s; loading it again${join ? ` ${Math.round(join)} s in, with the others` : ''}`);
    await this.ch.request(NS.media, transport, {
      type: 'LOAD', autoplay: true, ...(join ? { currentTime: join } : {}),
      media: { contentId: clip.url, contentType: clip.contentType, streamType: 'BUFFERED', ...(clip.durationMs ? { duration: clip.durationMs / 1000 } : {}), metadata: { metadataType: 0, title: clip.title } },
    }).catch(e => console.log(`[cast] ${this.ep.name}: loading ${clip.title} again failed: ${(e as Error).message}`));
  }

  /** Once it plays: each speaker still at the level it was given, else given it again (once). */
  private async holdVolumes(vols: { rec: Receiver; level: number }[]): Promise<void> {
    await new Promise(r => setTimeout(r, 1500).unref?.());
    await Promise.allSettled(vols.map(async v => {
      const now = (await v.rec.status()).volume.level;
      if (typeof now === 'number' && Math.abs(now * 100 - v.level) > 1.5) {
        console.log(`[cast] ${v.rec.ep.name} went to ${Math.round(now * 100)}% by itself during an announcement; back to ${v.level}%`);
        await v.rec.volume(v.level / 100);
      }
    }));
  }

  async volume(level: number, muted?: boolean): Promise<void> {
    await this.ch.connect();
    await this.ch.request(NS.receiver, 'receiver-0', { type: 'SET_VOLUME', volume: muted === undefined ? { level: Math.max(0, Math.min(1, level)) } : { muted } });
  }

  async members(): Promise<string[]> {
    await this.ch.connect();
    const m = await this.ch.request(NS.multizone, 'receiver-0', { type: 'GET_STATUS' });
    const devs = (m.data.status as { devices?: { deviceId: string }[] })?.devices ?? [];
    return devs.map(d => d.deviceId.replace(/-/g, '').toLowerCase());
  }
}

/** How far apart (seconds) speakers on one announcement may drift before one is moved back in step. */
const SYNC_SLACK_S = 0.6;

/** How many times an hour a looping sound the speaker dropped is started again. */
const LOOP_RESTARTS = 6;

export class CastAdapter implements Adapter {
  id = 'cast';
  /** Sets an announcement's volume itself once the clip is loaded (no beep on an idle Google speaker): see Adapter.clipVolume. */
  clipVolume = true;
  name = 'Google Cast';
  icon = 'cast';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private receivers = new Map<string, Receiver>();
  private groups = new Map<string, Set<string>>();
  /** Speaker id → group id currently playing through it. */
  private viaGroup = new Map<string, string>();
  /** Speakers taken out of a group that's still playing (muted, the rest carry on in sync) → that group. */
  private silenced = new Map<string, string>();
  private queue: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private browser: ReturnType<typeof mdns> | null = null;
  private failing = new Set<string>();
  /** Kova device id ↔ Cast id. */
  private kova = new Map<string, string>();
  private castOf = new Map<string, string>();

  constructor(private o: CastOptions = {}) {}
  private get clipLoadMs(): number { return this.o.clipLoadMs ?? 10_000; }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    for (const e of this.o.endpoints ?? []) this.add({ ...e, group: isGroupModel(e.model) });
    if (this.o.discover !== false) await this.discover(this.o.discoverMs ?? 3000);
    await this.refreshGroups();
    const every = this.o.pollMs ?? 10_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
    await this.poll();
  }

  private add(ep: CastEndpoint): void {
    const existing = this.receivers.get(ep.id);
    if (existing && existing.ep.host === ep.host && existing.ep.port === ep.port) return;
    existing?.ch.close();
    const r = new Receiver(ep, this.o);
    r.onTrack = () => this.reportTrack(ep.id);
    r.onProblem = p => this.ctx?.event(this.kovaId(ep.id), 'playback-failed', p);
    r.onStopped = p => this.ctx?.event(this.kovaId(ep.id), 'playback-stopped', p);
    this.receivers.set(ep.id, r);
    if (ep.group) { this.groups.set(ep.id, new Set()); return; }
    const tv = /tv|oled|qled|s90|bravia/i.test(`${ep.name} ${ep.model}`) && !/nest|audio|hub/i.test(ep.model);
    const room = this.o.rooms?.[ep.name] ?? ep.name.toLowerCase().replace(/\s*(speaker|display)\s*/g, ' ').trim().replace(/[^a-z0-9]+/g, '_');
    const kid = this.o.ids?.[ep.name] ?? `cast_${ep.id}`;
    this.kova.set(ep.id, kid);
    this.castOf.set(kid, ep.id);
    this.ctx!.announce([{ id: kid, name: ep.name, room, type: tv ? 'tv' : 'media', integration: `Google Cast · ${ep.model}`, address: `${ep.host}:${ep.port}`, capabilities: ['onoff', 'media', 'volume', 'queue', 'pause'] }]);
  }

  /** mDNS browse for _googlecast._tcp. Keeps listening so new devices and IP changes are picked up. */
  private discover(ms: number): Promise<void> {
    return new Promise(resolve => {
      let m: ReturnType<typeof mdns>;
      try { m = mdns(); } catch { resolve(); return; }
      this.browser = m;
      const srv = new Map<string, { port: number; target: string }>();
      const txt = new Map<string, Record<string, string>>();
      const addr = new Map<string, string>();
      m.on('response', res => {
        for (const a of [...res.answers, ...res.additionals]) {
          if (a.type === 'SRV' && a.name.includes('_googlecast')) srv.set(a.name, { port: (a.data as { port: number }).port, target: (a.data as { target: string }).target });
          if (a.type === 'TXT' && a.name.includes('_googlecast')) {
            const kv: Record<string, string> = {};
            for (const b of a.data as Buffer[]) { const s = b.toString(); const i = s.indexOf('='); if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1); }
            txt.set(a.name, kv);
          }
          if (a.type === 'A') addr.set(a.name, a.data as string);
        }
        for (const [name, s] of srv) {
          const t = txt.get(name), host = addr.get(s.target);
          if (t?.id && host) this.add({ id: t.id.toLowerCase(), name: t.fn ?? name, model: t.md ?? 'Cast', host, port: s.port, group: isGroupModel(t.md ?? '') });
        }
      });
      m.on('error', () => resolve());
      m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
      setTimeout(resolve, ms);
    });
  }

  /** Groups that didn't answer when last asked, and when Kova last went looking for each. */
  private groupDown = new Map<string, number>();
  private groupSearched = new Map<string, number>();

  /** Learn which speakers are in each Cast group. */
  private async refreshGroups(): Promise<void> {
    await Promise.all([...this.groups.keys()].map(async gid => {
      try {
        this.groups.set(gid, new Set(await this.receivers.get(gid)!.members()));
        this.groupDown.delete(gid);
      } catch { this.groupDown.set(gid, (this.groupDown.get(gid) ?? 0) + 1); /* group offline, or moved */ }
    }));
    await this.refindGroups();
  }

  /**
   * Google moves a speaker group to another of its speakers (and port) now and then. A group set up by
   * address (another VLAN: no mDNS to follow it) that stops answering is looked for on the speakers Kova
   * knows, at most every five minutes, and followed: the group with the same speakers, or the only one.
   */
  private async refindGroups(): Promise<void> {
    const now = Date.now();
    const lost = [...this.groupDown].filter(([gid, n]) => n >= 2 && now - (this.groupSearched.get(gid) ?? 0) > 5 * 60_000).map(([gid]) => gid);
    if (!lost.length) return;
    for (const gid of lost) this.groupSearched.set(gid, now);
    const speakers = [...new Set([...this.receivers.values()].filter(r => !r.ep.group).map(r => r.ep.host))];
    const found = await findCastGroups(speakers, { insecure: this.o.insecure, ports: this.o.groupPorts }).catch(() => []);
    for (const gid of lost) {
      const was = [...(this.groups.get(gid) ?? [])].sort().join(',');
      const g = (was ? found.find(f => f.members.join(',') === was) : undefined) ?? (found.length === 1 && lost.length === 1 ? found[0] : undefined);
      const r = this.receivers.get(gid);
      if (!g || !r || (r.ep.host === g.host && r.ep.port === g.port)) continue;
      this.ctx?.log(`${r.ep.name} moved to ${g.host}:${g.port}`);
      this.add({ ...r.ep, host: g.host, port: g.port });
      this.groups.set(gid, new Set(g.members));
      this.groupDown.delete(gid);
    }
  }

  private speakerId(d: Device) { return this.castOf.get(d.id) ?? d.id.replace(/^cast_/, ''); }
  private kovaId(castId: string) { return this.kova.get(castId) ?? `cast_${castId}`; }

  /**
   * Cast ids (the udn AirConnect knows a device by) for device names, e.g. the speakers to leave out of AirPlay.
   * A name matches with or without aircast's trailing "+", in any case.
   */
  castIdsByName(names: string[]): Record<string, string> {
    const norm = (n: string) => n.trim().replace(/\+$/, '').toLowerCase();
    const out: Record<string, string> = {};
    for (const n of names) {
      const r = [...this.receivers.values()].find(x => norm(x.ep.name) === norm(n));
      if (!r) continue;
      // Speakers are 32 hex digits; groups' ids are the UUID form, upper case.
      const id = r.ep.id;
      out[n] = r.ep.group && /^[0-9a-f]{32}$/i.test(id) ? id.toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : id;
    }
    return out;
  }

  /** The name of the Cast group (made in Google Home) whose members are exactly these Kova devices: plays through it are in perfect sync. */
  castGroupFor(devices: Device[]): string | undefined {
    const gid = devices.length > 1 ? this.groupFor(devices.map(d => this.speakerId(d))) : undefined;
    return gid ? this.receivers.get(gid)?.ep.name ?? gid : undefined;
  }

  /** The group whose members are exactly these speakers. */
  groupFor(speakers: string[]): string | undefined {
    const want = new Set(speakers);
    for (const [gid, members] of this.groups) {
      if (members.size === want.size && [...want].every(s => members.has(s))) return gid;
    }
    return undefined;
  }

  command(device: Device, cmd: Command): Promise<void | DeviceState> {
    return new Promise((resolve, reject) => {
      this.queue.push({ device, cmd, resolve, reject });
      this.flushTimer ??= setTimeout(() => void this.flush(), this.o.batchMs ?? 60);
    });
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const batch = this.queue.splice(0);
    // fn may say what the speaker actually did (a queue: shuffled or not, and its first song).
    const run = async (p: Pending[], fn: () => Promise<void | DeviceState>) => {
      try { const did = await fn(); p.forEach(x => x.resolve(did || undefined)); } catch (e) { p.forEach(x => x.reject(e as Error)); }
    };
    const playedQueue = (r: Receiver): DeviceState | undefined => r.queue ? { shuffle: r.queue.q.shuffle, track: r.track, paused: r.paused } : { paused: r.paused };
    const jobs: Promise<void>[] = [];
    // Back into the group it was taken out of, while that group still plays the same: unmute and rejoin, no new stream.
    for (const p of [...batch]) {
      const id = this.speakerId(p.device);
      const gid = this.silenced.get(id);
      const g = gid ? this.receivers.get(gid) : undefined;
      if (!gid || !g?.media || p.cmd.on === false || p.cmd.media === null || (p.cmd.on !== true && !p.cmd.media) || (p.cmd.media && p.cmd.media !== g.media)) continue;
      batch.splice(batch.indexOf(p), 1);
      jobs.push(run([p], async () => {
        const r = this.receivers.get(id)!;
        if (p.cmd.vol != null) await r.volume(p.cmd.vol / 100);
        await r.volume(0, false);
        this.silenced.delete(id);
        this.viaGroup.set(id, gid);
        r.media = g.media;
        return playedQueue(g);
      }));
    }
    // Plays of the same source in the same instant: try to use one Cast group.
    const plays = new Map<string, Pending[]>();
    const rest: Pending[] = [];
    for (const p of batch) {
      if (p.cmd.media) { const key = `${p.cmd.media}\0${p.cmd.shuffle ? 1 : 0}`; plays.set(key, [...(plays.get(key) ?? []), p]); }
      else rest.push(p);
    }
    for (const [key, ps] of plays) {
      for (const p of ps) this.silenced.delete(this.speakerId(p.device)); // something new: no longer "taken out"
      const media = key.slice(0, key.lastIndexOf('\0'));
      const url = this.ctx!.sourceUrl(media);
      // Not a radio source: maybe music (Helix), which plays as a queue of songs.
      const queue = url ? null : this.ctx!.queueFor(media, { shuffle: !!ps[0].cmd.shuffle, format: CAST_FORMAT });
      const start = async (r: Receiver) => {
        if (url) {
          // From the hub's address on the network this speaker is reached through.
          const host = r.ep.host, loop = !!this.ctx!.sourceLoops?.(media);
          return r.play(this.ctx!.sourceUrl(media, host) ?? url, media, loop, loop ? this.ctx!.endlessUrl?.(media, host) : undefined);
        }
        const q = await queue;
        if (!q) throw new Error(`No stream URL set for “${media}”`);
        await r.playQueue(q);
      };
      queue?.catch(() => {});
      // The Cast groups among these speakers that leave the fewest streams; the rest play on their own.
      const ids = ps.map(p => this.speakerId(p.device));
      const parts = ps.length > 1 ? partition(ids, this.castGroups()) : [{ ids }];
      for (const part of parts) {
        const gid = part.native?.id;
        if (gid) {
          const gps = ps.filter(p => part.ids.includes(this.speakerId(p.device)));
          jobs.push(run(gps, async () => {
            await Promise.all(gps.filter(p => p.cmd.vol != null).map(p => this.receivers.get(this.speakerId(p.device))!.volume(p.cmd.vol! / 100)));
            await start(this.receivers.get(gid)!);
            for (const id of part.ids) { this.viaGroup.set(id, gid); this.receivers.get(id)!.media = media; }
            return playedQueue(this.receivers.get(gid)!);
          }));
          continue;
        }
        for (const p of ps.filter(x => part.ids.includes(this.speakerId(x.device)))) jobs.push(run([p], async () => {
          const r = this.receivers.get(this.speakerId(p.device))!;
          if (p.cmd.vol != null) await r.volume(p.cmd.vol / 100);
          await start(r);
          this.viaGroup.delete(this.speakerId(p.device));
          return playedQueue(r);
        }));
      }
    }
    // Next / previous song, shuffle on or off, pause and resume: once per receiver (a group's speakers share one queue).
    const playing = (p: Pending) => { const id = this.speakerId(p.device); return this.receivers.get(this.viaGroup.get(id) ?? id)!; };
    const skips = rest.filter(p => p.cmd.skip || p.cmd.shuffle !== undefined || (p.cmd.paused !== undefined && p.cmd.on !== false && p.cmd.media !== null));
    const byReceiver = new Map<Receiver, Pending[]>();
    for (const p of skips) byReceiver.set(playing(p), [...(byReceiver.get(playing(p)) ?? []), p]);
    for (const [r, ps] of byReceiver) {
      jobs.push(run(ps, async () => {
        for (const p of ps) if (p.cmd.vol != null) await this.receivers.get(this.speakerId(p.device))!.volume(p.cmd.vol / 100);
        const shuffle = ps.find(p => p.cmd.shuffle !== undefined)?.cmd.shuffle;
        if (shuffle !== undefined && r.queue && shuffle !== r.queue.q.shuffle) {
          const q = await this.ctx!.queueFor(r.queue.q.label, { shuffle, format: CAST_FORMAT });
          if (q) await r.reorder(q);
        }
        const skip = ps.find(p => p.cmd.skip)?.cmd.skip;
        if (skip) await r.skip(skip > 0 ? 1 : -1);
        const paused = ps.find(p => p.cmd.paused !== undefined)?.cmd.paused;
        if (paused !== undefined && paused !== r.paused) await r.setPaused(paused);
        return playedQueue(r);
      }));
    }
    for (const p of skips) rest.splice(rest.indexOf(p), 1);
    // Stops: stop a group session only when all its speakers are stopped together.
    const stops = rest.filter(p => p.cmd.on === false || p.cmd.media === null);
    const stoppedIds = new Set(stops.map(p => this.speakerId(p.device)));
    const groupsDone = new Set<string>();
    for (const p of stops) {
      const id = this.speakerId(p.device);
      const gid = this.viaGroup.get(id);
      if (gid) {
        const members = [...this.viaGroup].filter(([, g]) => g === gid).map(([s]) => s);
        if (members.every(s => stoppedIds.has(s))) {
          if (!groupsDone.has(gid)) {
            groupsDone.add(gid);
            const ps = stops.filter(x => members.includes(this.speakerId(x.device)));
            jobs.push(run(ps, async () => {
              // A group that doesn't answer (a member dropped out and it's stuck resyncing): stop each speaker itself.
              try { await this.receivers.get(gid)!.stop(); }
              catch (e) {
                const each = await Promise.allSettled(members.map(m => this.receivers.get(m)!.stop()));
                if (each.every(x => x.status === 'rejected')) throw e;
              }
              for (const s of members) { this.viaGroup.delete(s); this.receivers.get(s)!.media = null; }
              // Speakers taken out earlier come back to full volume for next time.
              for (const [s, g] of [...this.silenced]) if (g === gid) { this.silenced.delete(s); await this.receivers.get(s)?.volume(0, false).catch(() => {}); }
            }));
          }
          continue;
        }
        // Only some speakers of a group: silence this one, the rest keep playing in sync.
        jobs.push(run([p], async () => { await this.receivers.get(id)!.volume(0, true); this.viaGroup.delete(id); this.silenced.set(id, gid); this.receivers.get(id)!.media = null; }));
        continue;
      }
      jobs.push(run([p], () => this.receivers.get(id)!.stop()));
    }
    for (const p of rest.filter(x => !stops.includes(x))) {
      const r = this.receivers.get(this.speakerId(p.device))!;
      jobs.push(run([p], async () => {
        if (p.cmd.vol != null) await r.volume(p.cmd.vol / 100);
        if (p.cmd.on === true && !r.media) {
          const src = this.ctx!.sourceUrl('Radio');
          if (src) await r.play(src, 'Radio');
        }
      }));
    }
    await Promise.all(jobs);
  }

  private polls = 0;
  private async poll(): Promise<void> {
    // Group members are read at start, but a group that didn't answer then (or was changed in
    // Google Home since) would leave Kova's speaker groups out of sync for good: read again,
    // at once while a group's members are unknown, and every sixth poll otherwise.
    if (this.groups.size && ([...this.groups.values()].some(m => !m.size) || ++this.polls % 6 === 0)) await this.refreshGroups();
    await Promise.all([...this.receivers.values()].filter(r => !r.ep.group).map(async r => {
      const id = r.ep.id;
      try {
        const { volume, app } = await r.status();
        const gid = this.viaGroup.get(id);
        // Taken out of a group that's still playing: it's muted, and off as far as anyone is concerned.
        let playing = !!app && !app.isIdleScreen && !this.silenced.has(id);
        if (gid && !playing) {
          const g = await this.receivers.get(gid)!.status().catch(() => ({ app: undefined }));
          playing = !!g.app && !g.app.isIdleScreen;
          if (!playing) this.viaGroup.delete(id);
        }
        // The media player open with nothing Kova knows of: what it holds (nothing, a few minutes after an announcement).
        if (playing && !gid && app?.appId === DEFAULT_RECEIVER && !r.media && !r.queue && !r.clip) playing = await r.adopt(app.transportId).catch(() => true);
        // A looping sound Kova started is gone and the speaker gave no reason (the media player closed, or it's back on
        // its idle screen): nobody stopped it, so it plays again (a stop from another app or by voice is CANCELLED, and
        // left alone). Another app on it now (Spotify, YouTube) is the person's: only said.
        const sm = r.stream;
        if (!playing && sm?.loop && r.media && !gid && !this.silenced.has(id)) {
          const recent = r.lastIdle && Date.now() - r.lastIdle.at < 60_000 ? r.lastIdle.reason : null;
          if (!recent) {
            const other = !!app && !app.isIdleScreen && app.appId !== DEFAULT_RECEIVER;
            const again = !other && r.mayRestart();
            const reason = other ? `another app is on it (${app!.appId})` : app?.isIdleScreen ? 'it went back to its idle screen' : 'its media player closed';
            console.warn(`[cast] ${r.ep.name}: ${sm.title} stopped with no reason given: ${reason}${again ? ', starting it again' : ''}`);
            r.onStopped?.({ title: sm.title, reason, appId: app?.appId ?? null, restarting: again });
            if (again) playing = await r.play(sm.url, sm.title, true, sm.endless).then(() => true, e => { console.warn(`[cast] ${r.ep.name}: ${(e as Error).message}`); return false; });
          }
        }
        if (!playing) { r.media = null; r.queue = null; }
        const src = gid ? this.receivers.get(gid)! : r;
        if (playing) await src.refreshQueue();
        this.ctx!.report(this.kovaId(id), {
          online: true, on: playing, media: playing ? r.media ?? 'Casting' : null, vol: volume.level != null ? Math.round(volume.level * 100) : undefined, paused: playing ? (gid ? this.receivers.get(gid)?.paused ?? r.paused : r.paused) : false,
          track: playing ? src.track : null, shuffle: playing && src.queue ? src.queue.q.shuffle : false,
        });
        this.failing.delete(id);
      } catch {
        this.failing.add(id);
        this.ctx!.report(this.kovaId(id), { online: false });
      }
    }));
  }

  /** The song changed on a receiver: tell Kova for the speaker, or every speaker playing through the group. */
  private reportTrack(castId: string): void {
    const r = this.receivers.get(castId);
    if (!r || !this.ctx) return;
    const ids = r.ep.group ? [...this.viaGroup].filter(([, g]) => g === castId).map(([s]) => s) : [castId];
    for (const id of ids) {
      // Only the song: on, media and shuffle come from the command that started it (reported first, they'd read as changed at the speaker).
      this.ctx.report(this.kovaId(id), r.queue ? { track: r.track } : { track: null, ...(r.media ? {} : { on: false, media: null, shuffle: false }) });
    }
  }

  // ---------------------------------------------------------- announcements --

  /** Restores in progress for a Cast group: its speakers share one, so the group starts again once. */
  private restoring = new Map<string, Promise<void>>();

  /**
   * What a speaker plays, to put back after an announcement: Kova's queue and the place in it (asked of the speaker
   * now), or the stream it was on. Something another app cast (Spotify, YouTube) can't be taken back: it says so.
   */
  async snapshotPlayback(device: Device): Promise<unknown | null> {
    const id = this.speakerId(device);
    const r = this.receivers.get(id);
    if (!r) return null;
    const gid = this.viaGroup.get(id);
    const src = (gid && this.receivers.get(gid)) || r;
    const { app } = await src.status();
    if (!app || app.isIdleScreen || this.silenced.has(id)) return null;
    if (app.appId !== DEFAULT_RECEIVER) return { other: true };
    if (!src.queue && !src.stream && !src.clip && !(await src.adopt(app.transportId).catch(() => false))) return null;
    await src.refreshQueue();
    if (src.queue) return { via: gid, paused: src.paused, queue: { q: src.queue.q, index: src.queue.index, position: src.queue.position } };
    if (src.stream) return { via: gid, paused: src.paused, stream: { ...src.stream } };
    return { other: true };
  }

  /** An announcement on this speaker alone: out of any group it was playing in. */
  async playClip(device: Device, clip: Clip): Promise<DeviceState> {
    const id = this.speakerId(device);
    const r = this.receivers.get(id);
    if (!r) throw new Error(`${device.name} isn’t reachable`);
    this.viaGroup.delete(id);
    this.silenced.delete(id);
    await r.playClip(clip, clip.vol != null ? [{ rec: r, level: clip.vol }] : undefined);
    return { on: true, media: clip.title, paused: false, track: null, shuffle: false, ...(clip.vol != null ? { vol: clip.vol } : {}) };
  }

  /**
   * An announcement on several speakers: each on its own, never through a Cast group (a group is only as good as the
   * speaker hosting it: a soundbar on its TV input left every Google speaker silent). Each is loaded paused at its own
   * volume, then all start in the same moment; one that doesn't load in time is left out and said, and never holds up
   * the rest.
   */
  async playClipTogether(devices: Device[], clipOf: (d: Device) => Clip): Promise<PromiseSettledResult<void | DeviceState>[]> {
    const loads = await Promise.allSettled(devices.map(async d => {
      const id = this.speakerId(d), r = this.receivers.get(id);
      if (!r) throw new Error(`${d.name} isn’t reachable`);
      this.viaGroup.delete(id);
      this.silenced.delete(id);
      const clip = clipOf(d);
      const loaded = await within(r.loadClip(clip, clip.vol != null ? [{ rec: r, level: clip.vol }] : undefined), this.clipLoadMs, `${d.name} didn’t load it in ${Math.round(this.clipLoadMs / 1000)} s`);
      return { r, loaded, clip };
    }));
    // Each holding the file before any starts (one still fetching it would start late), for a few seconds at most.
    const ready = Date.now() + this.clipReadyMs;
    await Promise.allSettled(loads.map(l => l.status === 'fulfilled' ? l.value.r.clipReady(l.value.loaded.transport, ready) : null));
    // Together: every PLAY sent at once; then kept together while it plays.
    const t0 = Date.now() + 150;
    const playing = loads.flatMap(l => l.status === 'fulfilled' ? [l.value] : []);
    if (playing.length > 1) void this.keepTogether(playing.map(p => ({ r: p.r, transport: p.loaded.transport, title: p.clip.title })), t0);
    return Promise.allSettled(loads.map(async l => {
      if (l.status === 'rejected') throw l.reason;
      await l.value.r.startClip(l.value.loaded, t0);
      const clip = l.value.clip;
      return { on: true, media: clip.title, paused: false, track: null, shuffle: false, ...(clip.vol != null ? { vol: clip.vol } : {}) } as DeviceState;
    }));
  }

  /**
   * Speakers playing one announcement, kept together: a few seconds in and then now and then, each says how far in it
   * is; one more than SYNC_SLACK_S off the rest (most of them, the median) is moved to where they are. A speaker that
   * started late (still fetching, or loaded again) catches up; one that ran ahead waits for them.
   */
  private async keepTogether(list: { r: Receiver; transport: string; title: string }[], t0: number): Promise<void> {
    const moves = new Map<Receiver, number>();
    for (const after of this.syncChecksMs) {
      await new Promise(r => setTimeout(r, Math.max(0, t0 + after - Date.now())).unref?.());
      const live = list.filter(x => x.r.clip === x.title);
      if (live.length < 2) return;
      const now = await Promise.all(live.map(async x => ({ x, s: await x.r.clipNow(x.transport) })));
      // How far each is ahead of the wall clock since the start: alike for speakers in step.
      const ahead = now.filter(n => n.s?.state === 'PLAYING').map(n => ({ ...n, off: n.s!.pos - (n.s!.at - t0) / 1000 }));
      if (ahead.length < 2) continue;
      const offs = ahead.map(a => a.off).sort((a, b) => a - b);
      // With an even count, the later of the middle two: a speaker that started late is the usual one out.
      const mid = offs[Math.floor(offs.length / 2)]!;
      await Promise.allSettled(ahead.filter(a => Math.abs(a.off - mid) > SYNC_SLACK_S && (moves.get(a.x.r) ?? 0) < 3).map(async a => {
        moves.set(a.x.r, (moves.get(a.x.r) ?? 0) + 1);
        const to = mid + (Date.now() - t0) / 1000;
        console.log(`[cast] ${a.x.r.ep.name} was ${Math.abs(a.off - mid).toFixed(1)} s ${a.off < mid ? 'behind' : 'ahead of'} the other speakers on ${a.x.title}; moved to ${to.toFixed(1)} s`);
        await a.x.r.seekClip(a.x.transport, a.s?.session, to);
      }));
    }
  }

  private get clipReadyMs(): number { return this.o.clipReadyMs ?? 4000; }
  private get syncChecksMs(): number[] { return this.o.syncChecksMs ?? [3000, 8000, 15_000, 30_000, 60_000, 120_000, 180_000, 240_000]; }

  async restorePlayback(device: Device, snap0: unknown | null): Promise<{ words: string; state?: DeviceState }> {
    const id = this.speakerId(device);
    const r = this.receivers.get(id);
    if (!r) throw new Error(`${device.name} isn’t reachable`);
    // An announcement it heard through a Cast group: that group's clip stops (once, for the first of its speakers back).
    const via = this.viaGroup.get(id), g = via ? this.receivers.get(via) : undefined;
    if (g?.clip && r.clip === g.clip) { await g.stop().catch(() => {}); g.clip = null; }
    if (r.clip && via) { this.viaGroup.delete(id); r.clip = null; r.media = null; }
    const snap = snap0 as null | { other?: boolean; via?: string; paused?: boolean; queue?: { q: Queue; index: number; position: number }; stream?: Stream };
    if (!snap) {
      if (r.clip || r.media) await r.stop().catch(() => {});
      return { words: 'idle again', state: { on: false, media: null, paused: false, track: null, shuffle: false } };
    }
    if (snap.other) {
      if (r.clip) await r.stop().catch(() => {});
      throw new Error('it was casting from another app (Spotify, YouTube…), which Kova can’t take back');
    }
    const target = (snap.via && this.receivers.get(snap.via)) || r;
    const key = target.ep.id;
    let job = this.restoring.get(key);
    if (!job) {
      job = (async () => {
        if (snap.queue) await target.playQueue(snap.queue.q, snap.queue.index, snap.queue.position);
        else if (snap.stream) await target.play(snap.stream.url, snap.stream.title, snap.stream.loop, snap.stream.endless);
        if (snap.paused) await target.setPaused(true).catch(() => {});
      })();
      this.restoring.set(key, job);
      const done = () => setTimeout(() => this.restoring.delete(key), 5000).unref?.();
      // One that failed can be tried again at once (Kova's check after an announcement does).
      job.then(done, () => this.restoring.delete(key));
    }
    await job;
    if (snap.via) { this.viaGroup.set(id, snap.via); r.media = target.media; r.clip = null; }
    const pos = snap.queue?.position ?? 0;
    const words = snap.queue
      ? `resumed ${snap.queue.q.label}${snap.queue.q.tracks[snap.queue.index] ? ` (${snap.queue.q.tracks[snap.queue.index]!.title}${pos >= 1 ? ` at ${mmss(pos)}` : ''})` : ''}${snap.paused ? ', paused' : ''}`
      : `back to ${snap.stream!.title}${snap.paused ? ', paused' : ''}`;
    return { words, state: { on: true, media: target.media, paused: !!snap.paused, track: target.track, shuffle: target.queue ? target.queue.q.shuffle : false } };
  }

  /** The Cast groups whose members are known, by Cast ids (for partition()). */
  private castGroups(): NativeGroup[] {
    return [...this.groups].filter(([, m]) => m.size >= 2).map(([id, m]) => ({ via: 'cast', id, name: this.receivers.get(id)?.ep.name ?? id, members: [...m] }));
  }

  /** Cast groups made in Google Home, as native groups for Kova's speaker groups (member Kova device ids). */
  nativeGroups(): NativeGroup[] {
    return this.castGroups().map(g => ({ ...g, members: g.members.map(s => this.kovaId(s)) }));
  }

  /** The receiver that plays this speaker now: the Cast group it plays through, or itself. */
  private playerFor(device: Device): Receiver | undefined {
    const id = this.speakerId(device);
    return this.receivers.get(this.viaGroup.get(id) ?? id);
  }

  async playbackPosition(device: Device): Promise<PlaybackPosition | null> {
    const r = this.playerFor(device);
    return r ? r.position() : null;
  }

  async syncTo(device: Device, to: { index: number; positionMs: number }): Promise<void> {
    const r = this.playerFor(device);
    if (!r) throw new Error(`${device.name} isn’t reachable`);
    await r.seekTo(to.index, Math.max(0, to.positionMs) / 1000);
  }

  /** Cast groups Kova can use for synced playback, with their member device ids. */
  groupList(): { id: string; name: string; members: string[] }[] {
    return [...this.groups].map(([id, m]) => ({ id, name: this.receivers.get(id)!.ep.name, members: [...m].map(s => this.kovaId(s)) }));
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.browser?.destroy();
    for (const r of this.receivers.values()) r.ch.close();
  }

  status(): AdapterStatus {
    const speakers = [...this.receivers.values()].filter(r => !r.ep.group).length;
    if (this.failing.size) return { ok: false, note: `${this.failing.size} of ${speakers} not responding` };
    return { ok: speakers > 0, note: speakers ? `${speakers} speakers and displays · ${this.groups.size} group${this.groups.size === 1 ? '' : 's'} for synced audio` : 'No Cast devices found yet' };
  }
}

export type { CastMessage };

/** A promise, or an error with `why` once `ms` pass. */
function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(why)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}
