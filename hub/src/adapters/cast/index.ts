import mdns from 'multicast-dns';
import type { Adapter, AdapterContext, AdapterStatus, Queue, QueueTrack } from '../sdk.ts';
import type { Command, Device, DeviceState, Track } from '../../model/types.ts';
import { CastChannel, NS, type CastMessage } from './channel.ts';

// Google Cast speakers, displays and TVs (Nest Audio, Nest Hub, Chromecast…).
// Perfect multi-room sync comes from Cast groups: when several speakers are
// told to play the same thing at once, Kova plays it on the Cast group whose
// members are exactly those speakers, and the speakers keep themselves in sync.

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
  /** Plain TCP instead of TLS (tests only). */
  insecure?: boolean;
  timeoutMs?: number;
}

interface Pending { device: Device; cmd: Command; resolve: (did?: DeviceState) => void; reject: (e: Error) => void }

const isGroupModel = (md: string) => /cast group/i.test(md);
const contentType = (url: string) => /\.m3u8(\?|$)/i.test(url) ? 'application/x-mpegURL' : /\.aac(\?|$)/i.test(url) ? 'audio/aac' : /\.(mp4|m4a)(\?|$)/i.test(url) ? 'audio/mp4' : 'audio/mpeg';

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
  mediaSessionId?: number; playerState?: string; idleReason?: string; currentItemId?: number; currentTime?: number;
  media?: { customData?: { kova?: number } }; items?: { itemId: number; customData?: { kova?: number }; media?: { customData?: { kova?: number } } }[];
}

/** One Cast receiver: a speaker, display, TV or group. */
class Receiver {
  readonly ch: CastChannel;
  media: string | null = null;
  /** A play queue (Helix music): the songs in order, where it is, and what the speaker holds. */
  queue: { q: Queue; index: number; from: number; to: number; session?: number; position: number; topping?: boolean } | null = null;
  private transport: string | null = null;
  /** Playback is paused (on hold, not stopped), as the speaker last said. */
  paused = false;
  /** Called when the song changes or the queue ends. */
  onTrack?: () => void;

  constructor(readonly ep: CastEndpoint, o: CastOptions) {
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

  async play(url: string, title: string): Promise<void> {
    const transport = await this.receiverApp();
    const r = await this.ch.request(NS.media, transport, {
      type: 'LOAD', autoplay: true,
      media: { contentId: url, contentType: contentType(url), streamType: 'LIVE', metadata: { metadataType: 0, title } },
    });
    if (r.data.type === 'LOAD_FAILED' || r.data.type === 'LOAD_CANCELLED') throw new Error(`${this.ep.name} couldn't play ${title}`);
    this.media = title;
    this.queue = null;
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
    this.queue = { q, index: start, from: start, to, position, session: (r.data.status as MediaStatus[] | undefined)?.[0]?.mediaSessionId };
    this.onTrack?.();
  }

  /** What the speaker says it's playing: follow the queue, and add more songs before it runs out. */
  private onStatus(st: MediaStatus | undefined): void {
    if (st?.playerState) this.paused = st.playerState === 'PAUSED';
    const qu = this.queue;
    if (!st || !qu) return;
    if (st.mediaSessionId) qu.session = st.mediaSessionId;
    if (st.currentTime != null) qu.position = st.currentTime;
    const item = st.items?.find(i => i.itemId === st.currentItemId);
    const at = st.media?.customData?.kova ?? item?.customData?.kova ?? item?.media?.customData?.kova;
    if (typeof at === 'number' && at !== qu.index && at >= 0 && at < qu.q.tracks.length) { qu.index = at; this.onTrack?.(); }
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

  async stop(): Promise<void> {
    const { app } = await this.status();
    if (app && !app.isIdleScreen) await this.ch.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId: app.sessionId });
    this.media = null;
    this.queue = null;
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

export class CastAdapter implements Adapter {
  id = 'cast';
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

  /** Learn which speakers are in each Cast group. */
  private async refreshGroups(): Promise<void> {
    await Promise.all([...this.groups.keys()].map(async gid => {
      try { this.groups.set(gid, new Set(await this.receivers.get(gid)!.members())); } catch { /* group offline */ }
    }));
  }

  private speakerId(d: Device) { return this.castOf.get(d.id) ?? d.id.replace(/^cast_/, ''); }
  private kovaId(castId: string) { return this.kova.get(castId) ?? `cast_${castId}`; }

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
      const queue = url ? null : this.ctx!.queueFor(media, { shuffle: !!ps[0].cmd.shuffle });
      const start = async (r: Receiver) => {
        if (url) return r.play(url, media);
        const q = await queue;
        if (!q) throw new Error(`No stream URL set for “${media}”`);
        await r.playQueue(q);
      };
      queue?.catch(() => {});
      const ids = ps.map(p => this.speakerId(p.device));
      const gid = ps.length > 1 ? this.groupFor(ids) : undefined;
      if (gid) {
        jobs.push(run(ps, async () => {
          await Promise.all(ps.filter(p => p.cmd.vol != null).map(p => this.receivers.get(this.speakerId(p.device))!.volume(p.cmd.vol! / 100)));
          await start(this.receivers.get(gid)!);
          for (const id of ids) { this.viaGroup.set(id, gid); this.receivers.get(id)!.media = media; }
          return playedQueue(this.receivers.get(gid)!);
        }));
      } else {
        for (const p of ps) jobs.push(run([p], async () => {
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
          const q = await this.ctx!.queueFor(r.queue.q.label, { shuffle });
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
              await this.receivers.get(gid)!.stop();
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
