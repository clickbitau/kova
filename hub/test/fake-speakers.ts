import type { Adapter, AdapterContext, AdapterStatus, NativeGroup, PlaybackPosition } from '../src/adapters/sdk.ts';
import type { Command, Device, DeviceState } from '../src/model/types.ts';
import { partition } from '../src/engine/group-sync.ts';

// In-memory speakers for the speaker-group sync tests (and the visual demo): a Cast-like adapter with fixed native
// groups, or a Sonos-like one that groups any of its speakers. Each stream starts playing its start delay after the
// play command; its place is (now − when it started) plus a bias a test sets (drift), read with the time it was true.

export interface FakeSpeaker { id: string; name: string; room: string }
interface Stream { key: string; ids: string[]; media: string; live: boolean; startedAt: number; bias: number; durations: number[]; paused: boolean; heldAt?: number }

export class FakeSpeakers implements Adapter {
  kind = 'Local' as const;
  icon = 'speaker';
  private ctx?: AdapterContext;
  private streams = new Map<string, Stream>();
  private pend: { d: Device; cmd: Command; res: (v: void | DeviceState) => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Every play command as it arrived (device, ms) and every syncTo. */
  readonly asked: { id: string; at: number; media: string }[] = [];
  readonly seeks: { id: string; at: number; index: number; positionMs: number }[] = [];

  constructor(readonly id: 'cast' | 'sonos', readonly name: string, private speakers: FakeSpeaker[], private o: {
    /** Fixed native groups (Cast groups), or dynamic (any two or more, like Sonos). */
    groups?: { id: string; name: string; members: string[] }[]; dynamic?: boolean;
    /** Start delay per stream key (a group id, or a speaker id); default 0. */
    latency?: Record<string, number>; seekLatency?: number; seekStepMs?: number; batchMs?: number;
    /** A gap between songs (a Cast group fetching the next), per stream key: ms, or a function of the song it ends. */
    gapMs?: Record<string, number | ((index: number) => number)>;
    /** Can wait at a song's end (hold). */
    canHold?: boolean;
  } = {}) {
    if (o.canHold) this.hold = async (d: Device) => { const st = this.streamOf(d.id); if (st) { this.holds.push({ id: d.id, at: Date.now() }); st.heldAt ??= Date.now(); } };
  }
  readonly holds: { id: string; at: number }[] = [];
  hold?: (d: Device) => Promise<void>;

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.announce(this.speakers.map(s => ({ id: s.id, name: s.name, room: s.room, type: 'media' as const, integration: this.name, address: '10.0.0.9', capabilities: ['onoff', 'media', 'volume', 'queue', 'pause'], state: { on: false, vol: 30, online: true } })));
  }
  async stop(): Promise<void> { if (this.timer) clearTimeout(this.timer); }
  status(): AdapterStatus { return { ok: true }; }

  nativeGroups(): NativeGroup[] {
    if (this.o.dynamic) return this.speakers.length >= 2 ? [{ via: this.id, id: 'group', name: this.name, members: this.speakers.map(s => s.id), dynamic: true }] : [];
    return (this.o.groups ?? []).map(g => ({ via: this.id, ...g }));
  }

  command(d: Device, cmd: Command): Promise<void | DeviceState> {
    if (typeof cmd.media === 'string' && cmd.media) {
      this.asked.push({ id: d.id, at: Date.now(), media: cmd.media });
      return new Promise(res => { this.pend.push({ d, cmd, res }); this.timer ??= setTimeout(() => void this.flush(), this.o.batchMs ?? 10); });
    }
    if (cmd.on === false || cmd.media === null) for (const s of this.streams.values()) s.ids = s.ids.filter(x => x !== d.id);
    if (cmd.paused !== undefined) { const s = this.streamOf(d.id); if (s) s.paused = cmd.paused; }
    return Promise.resolve();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = this.pend.splice(0);
    const media = String(batch[0]!.cmd.media);
    const live = !!this.ctx!.sourceUrl(media);
    const q = live ? null : await this.ctx!.queueFor(media, {});
    const ids = batch.map(p => p.d.id);
    for (const part of partition(ids, this.nativeGroups())) {
      const key = part.native?.id ?? part.ids[0]!;
      for (const s of this.streams.values()) s.ids = s.ids.filter(x => !part.ids.includes(x));
      this.streams.set(key, { key, ids: part.ids, media, live, startedAt: Date.now() + (this.o.latency?.[key] ?? 0), bias: 0, durations: q?.tracks.map(t => t.durationMs ?? 0) ?? [], paused: false });
    }
    for (const p of batch) p.res();
  }

  private streamOf(id: string): Stream | undefined { return [...this.streams.values()].find(s => s.ids.includes(id)); }

  /** Make the stream that plays this speaker run `ms` ahead (+) or behind (−) from now on. */
  drift(id: string, ms: number): void { const s = this.streamOf(id); if (s) s.bias += ms; }

  /** Where the stream is in its queue, from the time it started (a held one where it stopped; gaps between songs silent). */
  where(id: string, t = Date.now()): { index: number; positionMs: number; playing: boolean } | null {
    const s = this.streamOf(id);
    if (!s) return null;
    const held = s.heldAt != null;
    const tt = held ? s.heldAt! : t;
    let pos = tt - s.startedAt + s.bias, index = 0;
    if (tt < s.startedAt) return { index: 0, positionMs: 0, playing: false };
    const gapOf = (i: number) => { const g = this.o.gapMs?.[s.key]; return typeof g === 'function' ? g(i) : g ?? 0; };
    while (s.durations[index] && pos >= s.durations[index]! && index < s.durations.length - 1) {
      pos -= s.durations[index]!;
      const g = gapOf(index);
      index++;
      if (pos < g) return { index, positionMs: 0, playing: false };
      pos -= g;
    }
    return { index, positionMs: pos, playing: !s.paused && !held };
  }

  async playbackPosition(d: Device): Promise<PlaybackPosition | null> {
    const s = this.streamOf(d.id), w = this.where(d.id);
    if (!s || !w || s.live) return null;
    const at = Date.now();
    return { ...w, positionMs: Math.round(w.positionMs), at, ...(s.durations[w.index] ? { durationMs: s.durations[w.index] } : {}), seekStepMs: this.o.seekStepMs ?? 1 };
  }

  async syncTo(d: Device, to: { index: number; positionMs: number }): Promise<void> {
    const s = this.streamOf(d.id);
    if (!s) throw new Error('not playing');
    this.seeks.push({ id: d.id, at: Date.now(), ...to });
    // Lands after the seek delay at exactly that place.
    const gapOf = (i: number) => { const g = this.o.gapMs?.[s.key]; return typeof g === 'function' ? g(i) : g ?? 0; };
    const before = s.durations.slice(0, to.index).reduce((a, b, i) => a + b + gapOf(i), 0);
    s.startedAt = Date.now() + (this.o.seekLatency ?? 0) - before - to.positionMs;
    s.bias = 0;
    s.heldAt = undefined;
  }
}
