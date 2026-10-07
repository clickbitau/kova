import { EventEmitter } from 'node:events';
import type { Adapter, NativeGroup, PlaybackPosition } from '../adapters/sdk.ts';
import type { Registry, PlaybackSnap } from '../devices/registry.ts';
import type { Store } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { Cause, Command, CombinedDevice, Device, SpeakerGroup } from '../model/types.ts';
import { announceVol, trimOf } from './announce.ts';
import { SYNC_TEST_FILE, SYNC_TEST_MS } from '../services/clips.ts';

// Speaker groups across brands, kept in time.
//
// A Kova speaker group can hold any speakers. Speakers of one brand that can play as one stream do (a Cast group made
// in Google Home whose members are exactly some of the group's speakers; any two or more Sonos speakers, which Sonos
// groups on the fly): those are sample-locked by their own system. The rest (another brand, a lone speaker) play
// alongside, each as its own stream. partition() picks the native groups that leave the fewest streams.
//
// Every stream starts the same thing at a shared "start at" moment. For a queue (Helix music, Kova's own sync test)
// each part is asked early by its learned start delay (play command → the speaker playing, measured on each play)
// and moved by its offset, the owner's tuning (+ plays earlier, − later). A radio stream gets the offsets only: each
// speaker buffers a live stream by itself, so a start time means little there.
//
// While a queue plays, each part's place is read every few seconds and compared with the main part (the biggest; the
// one the others follow). A part more than DRIFT_CORRECT_MS out is lined up again at the start of the next song (it's
// started on the shared timeline there, where a jump isn't heard); one more than DRIFT_SEEK_MS out is moved at once,
// mid-song. Radio is never corrected. What Kova did is kept in a short log per group, for the tuning screen.

export const OFFSET_LIMIT_MS = 1000;
export const OFFSET_STEP_MS = 10;
/** Out by more than this (after the offset), a part is lined up again at the next song. */
export const DRIFT_CORRECT_MS = 120;
/** Out by more than this, it's moved at once, mid-song. */
export const DRIFT_SEEK_MS = 400;
/** At most one mid-song move per part in this long (a speaker that can't hold its place isn't chased). */
export const SEEK_GAP_MS = 20_000;
export const CHECK_MS = 5000;
/** How long the sync test plays (its click track's length). */
export { SYNC_TEST_MS };
export const SYNC_TEST_MEDIA = 'Kova sync test';
/** The announcement level the sync test plays at (× each speaker's announcement loudness): low and safe. */
export const SYNC_TEST_LEVEL = 15;
/** A seek's delay before anything is learned. */
const SEEK_GUESS_MS = 400;
const LATENCY_MAX_MS = 15_000;

// ------------------------------------------------------------------ the plan --

/** A part of a group: a native group played as one stream, or a speaker on its own. */
export interface PlanPart {
  /** "cast:<id>" / "sonos:group" for a native group, the member's device id for a speaker on its own. */
  key: string;
  kind: 'native' | 'single';
  /** The adapter that plays it ("cast", "sonos", …). */
  via: string;
  name: string;
  /** The group's members in this part (their ids as the group lists them). */
  members: string[];
  /** The devices commands go to (a combined device's speaker member). */
  players: string[];
  /** The part the others follow (offset 0, never corrected). */
  reference: boolean;
}

/**
 * Speakers into native groups and lone speakers, with the fewest streams. A dynamic native group (Sonos) takes all
 * its speakers that are here, two or more; fixed ones (Cast groups) only when every member is here, without overlap,
 * chosen to cover the most speakers with the fewest groups. Native groups come first, biggest first; then the rest
 * in the order given.
 */
export function partition(ids: string[], natives: NativeGroup[]): { native?: NativeGroup; ids: string[] }[] {
  const rest = new Set(ids);
  const out: { native?: NativeGroup; ids: string[] }[] = [];
  for (const n of natives.filter(x => x.dynamic)) {
    const m = ids.filter(id => rest.has(id) && n.members.includes(id));
    if (m.length < 2) continue;
    out.push({ native: n, ids: m });
    for (const id of m) rest.delete(id);
  }
  const cands = natives
    .filter(n => !n.dynamic && new Set(n.members).size >= 2 && n.members.every(m => rest.has(m)))
    .map(n => ({ n, set: new Set(n.members) }))
    .sort((a, b) => b.set.size - a.set.size || a.n.name.localeCompare(b.n.name))
    .slice(0, 24);
  // Streams = speakers − Σ(size − 1): maximise the saving; on a tie, more speakers in native groups.
  let best: { pick: number[]; save: number; covered: number } = { pick: [], save: 0, covered: 0 };
  const walk = (i: number, used: Set<string>, pick: number[], save: number, covered: number): void => {
    if (save > best.save || (save === best.save && covered > best.covered)) best = { pick: [...pick], save, covered };
    // Bound: even taking every group left can't beat the best.
    let left = 0;
    for (let j = i; j < cands.length; j++) left += cands[j]!.set.size - 1;
    if (save + left < best.save || i >= cands.length) return;
    for (let j = i; j < cands.length; j++) {
      const c = cands[j]!;
      if ([...c.set].some(m => used.has(m))) continue;
      for (const m of c.set) used.add(m);
      pick.push(j);
      walk(j + 1, used, pick, save + c.set.size - 1, covered + c.set.size);
      pick.pop();
      for (const m of c.set) used.delete(m);
    }
  };
  walk(0, new Set(), [], 0, 0);
  for (const j of best.pick) {
    const c = cands[j]!;
    out.push({ native: c.n, ids: ids.filter(id => c.set.has(id)) });
    for (const id of c.set) rest.delete(id);
  }
  out.sort((a, b) => b.ids.length - a.ids.length);
  for (const id of ids) if (rest.has(id)) out.push({ ids: [id] });
  return out;
}

/** The device that plays for a member: itself, or a combined device's member that plays media. */
export function playerOf(id: string, device: (id: string) => Device | undefined, combined: CombinedDevice[] = []): string | undefined {
  const d = device(id);
  if (!d) return undefined;
  if (d.adapter !== 'combined') return id;
  const c = combined.find(x => `combined_${x.id}` === id);
  return c?.members.map(device).find(m => !!m && m.capabilities.includes('media'))?.id ?? id;
}

/** A group's parts, in play order (the first is the reference). */
export function planParts(members: string[], device: (id: string) => Device | undefined, natives: NativeGroup[], combined: CombinedDevice[] = []): PlanPart[] {
  const pairs = members.map(id => ({ id, p: playerOf(id, device, combined) })).filter((x): x is { id: string; p: string } => !!x.p);
  const byPlayer = new Map<string, string[]>();
  for (const x of pairs) byPlayer.set(x.p, [...(byPlayer.get(x.p) ?? []), x.id]);
  return partition([...byPlayer.keys()], natives).map((g, i) => {
    const ms = g.ids.flatMap(p => byPlayer.get(p) ?? []);
    if (g.native) return { key: `${g.native.via}:${g.native.id}`, kind: 'native' as const, via: g.native.via, name: g.native.name, members: ms, players: g.ids, reference: i === 0 };
    const d = device(ms[0]!);
    return { key: ms[0]!, kind: 'single' as const, via: device(g.ids[0]!)?.adapter ?? d?.adapter ?? '', name: d?.name ?? ms[0]!, members: ms, players: g.ids, reference: i === 0 };
  });
}

// ----------------------------------------------------------------- offsets --

/** An offset as kept: a whole number of 10 ms steps, −1000…+1000. Throws on anything else. */
export function cleanOffset(v: unknown): number {
  const n = typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('A delay is a number of milliseconds');
  if (Math.abs(n) > OFFSET_LIMIT_MS) throw new Error(`A delay is at most ${OFFSET_LIMIT_MS} ms either way`);
  return Math.round(n / OFFSET_STEP_MS) * OFFSET_STEP_MS || 0;
}

/**
 * A change to a group's offsets, checked against its parts: only parts played alongside take one (the reference is
 * what they follow). Returns the offsets to keep (0 drops one). Keys of parts not in the plan now (a Cast group that's
 * offline, say) are kept as they were.
 */
export function mergeOffsets(current: Record<string, number> | undefined, change: unknown, parts: PlanPart[]): Record<string, number> {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Send the delays as { "<speaker>": ms }');
  const out = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(change as Record<string, unknown>)) {
    const p = parts.find(x => x.key === k);
    if (!p) throw new Error(`“${k}” isn’t a part of this group`);
    if (p.reference) throw new Error(`${p.name} is what the other speakers follow: move the others instead`);
    const n = cleanOffset(v);
    if (n) out[k] = n; else delete out[k];
  }
  return out;
}

/** Offsets kept for a group, only for parts it has now (and none for the reference). */
export function offsetsFor(saved: Record<string, number> | undefined, parts: PlanPart[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of parts) if (!p.reference && typeof saved?.[p.key] === 'number') out[p.key] = saved[p.key]!;
  return out;
}

/** Offsets for members still in the group (a part's key is a member, or a native group whose members may change). */
export function pruneOffsets(saved: Record<string, number> | undefined, members: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved ?? {})) if (k.includes(':') || members.includes(k)) out[k] = v;
  return out;
}

// --------------------------------------------------------------- scheduling --

/**
 * When to ask each part to play. A queue: every part sounds its first note at `startAt` less its offset, so each is
 * asked that much earlier again by its start delay (unknown delays count as the others' middle one, or 0); startAt is
 * as soon as the slowest allows, plus a margin. A stream: offsets only (asked earlier by its offset).
 */
export function schedule(parts: { key: string; latencyMs?: number }[], offsets: Record<string, number>, now: number, live: boolean, marginMs = 150): { startAt: number; sends: Record<string, number> } {
  const off = (k: string) => offsets[k] ?? 0;
  if (live) {
    const most = Math.max(0, ...parts.map(p => off(p.key)));
    return { startAt: now + most, sends: Object.fromEntries(parts.map(p => [p.key, now + most - off(p.key)])) };
  }
  const known = parts.map(p => p.latencyMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  const guess = known.length ? known[Math.floor((known.length - 1) / 2)]! : 0;
  const lat = (p: { latencyMs?: number }) => p.latencyMs ?? guess;
  const lead = Math.max(0, ...parts.map(p => off(p.key) + lat(p)));
  const startAt = now + lead + marginMs;
  return { startAt, sends: Object.fromEntries(parts.map(p => [p.key, startAt - off(p.key) - lat(p)])) };
}

// ------------------------------------------------------------------- drift --

/** Where a speaker is at time t, from a reading. */
export const posAt = (p: PlaybackPosition, t: number) => p.positionMs + (p.playing ? t - p.at : 0);

/**
 * How far a part is from where it should be (ms; + ahead, − behind): its place less the reference's, less its offset.
 * Across a song change when the earlier song's length is known; null when it can't be told (songs further apart).
 */
export function driftOf(ref: PlaybackPosition, part: PlaybackPosition, offsetMs = 0): number | null {
  const t = Math.max(ref.at, part.at);
  const r = posAt(ref, t), q = posAt(part, t);
  if (part.index === ref.index) return Math.round(q - r - offsetMs);
  if (part.index === ref.index + 1 && ref.durationMs) return Math.round(ref.durationMs - r + q - offsetMs);
  if (part.index === ref.index - 1 && part.durationMs) return Math.round(-(part.durationMs - q + r) - offsetMs);
  return null;
}

export type DriftAction = 'none' | 'boundary' | 'seek';

/** What to do about a part's drift: nothing, line it up at the next song, or move it now. Never on a stream. */
export function driftAction(o: { live: boolean; driftMs: number | null; sinceSeekMs?: number }): DriftAction {
  if (o.live || o.driftMs == null) return 'none';
  const d = Math.abs(o.driftMs);
  if (d <= DRIFT_CORRECT_MS) return 'none';
  if (d > DRIFT_SEEK_MS && (o.sinceSeekMs ?? Infinity) >= SEEK_GAP_MS) return 'seek';
  return 'boundary';
}

// ------------------------------------------------------------ start delays --

/**
 * Start delays learned per device (or native group): the last 12 measurements, read as their median, kept in the
 * store. Also each part's seek delay ("seek:<key>"), refined from how far off each move landed.
 */
export class LatencyBook {
  private data: Record<string, number[]>;
  constructor(private store?: Store | null, private key = 'groupSyncLatency') {
    this.data = store?.get<Record<string, number[]>>(key) ?? {};
  }
  record(id: string, ms: number): boolean {
    if (!(ms >= 0 && ms <= LATENCY_MAX_MS)) return false;
    const l = (this.data[id] ??= []);
    l.push(Math.round(ms));
    if (l.length > 12) l.splice(0, l.length - 12);
    this.store?.set(this.key, this.data);
    return true;
  }
  get(id: string): number | undefined {
    const l = [...(this.data[id] ?? [])].sort((a, b) => a - b);
    if (!l.length) return undefined;
    const m = l.length >> 1;
    return l.length % 2 ? l[m]! : Math.round((l[m - 1]! + l[m]!) / 2);
  }
  count(id: string): number { return this.data[id]?.length ?? 0; }
}

// ------------------------------------------------------------- coordinator --

export interface SyncLogLine { at: number; text: string }
export interface PartView extends PlanPart {
  offset: number; latencyMs: number | null; latencyN: number; driftMs: number | null;
  /** For a part played alongside: a speaker of the reference to listen to it against (one in its room, if any). */
  listenWith: string | null;
}
export interface GroupSyncView {
  parts: PartView[];
  /** What's playing through the group now, as Kova started it. */
  playing: { media: string; live: boolean; startAt: number } | null;
  test: { until: number } | null;
  log: SyncLogLine[];
}

interface Pending { refIndex: number; scheduled?: boolean }
interface Session {
  group: string; media: string; live: boolean; startAt: number; parts: PlanPart[]; cause: Cause;
  timer: NodeJS.Timeout | null; timers: Set<NodeJS.Timeout>; checking: boolean; ended: boolean; misses: number;
  pending: Map<string, Pending>; lastSeek: Map<string, number>; seeked: Set<string>; drift: Map<string, number | null>;
}
interface SyncTest { snaps: Map<string, PlaybackSnap>; players: string[]; until: number; timer: NodeJS.Timeout | null; cause: Cause }

export interface GroupSyncOptions {
  checkMs?: number; marginMs?: number; testMs?: number;
  /** How long to watch for a part to start, to learn its start delay. */
  measureMs?: number;
  /** Real time in ms (Date.now): positions and schedules are in it. */
  now?: () => number;
  /** The hub's address as a speaker at this IP reaches it, for the sync test's click track. */
  base?: (host?: string) => string | null;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
const signed = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(Math.round(ms))} ms`;
const hostOf = (address: string | undefined) => /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(address ?? '')?.[1];

export class GroupSync extends EventEmitter<{ changed: [] }> {
  readonly book: LatencyBook;
  private sessions = new Map<string, Session>();
  private logs = new Map<string, SyncLogLine[]>();
  private tests = new Map<string, SyncTest>();
  private now: () => number;

  constructor(private reg: Registry, private config: ConfigStore, store: Store | null, private o: GroupSyncOptions = {}) {
    super();
    this.book = new LatencyBook(store);
    this.now = o.now ?? Date.now;
    // The click track as a one-song queue, so it plays exactly as music does (start delays, offsets, drift checks).
    reg.ownQueues.set(SYNC_TEST_MEDIA, async () => {
      const host = [...this.tests.values()].flatMap(t => t.players).map(id => hostOf(this.reg.get(id)?.address)).find(Boolean);
      const base = this.o.base?.(host);
      if (!base) throw new Error('Kova doesn’t know its own address on your network for the speakers to fetch the test from');
      const ms = this.o.testMs ?? SYNC_TEST_MS;
      return { label: SYNC_TEST_MEDIA, shuffle: false, tracks: [{ id: 'kova-sync-test', title: 'Sync test', url: `${base}/api/clip/${SYNC_TEST_FILE}`, contentType: 'audio/wav', durationMs: ms }] };
    });
  }

  private group(id: string): SpeakerGroup | undefined { return (this.config.get().speakerGroups ?? []).find(g => g.id === id); }
  private natives(): NativeGroup[] {
    return [...this.reg.adapters.values()].flatMap(a => { try { return a.nativeGroups?.() ?? []; } catch { return []; } });
  }

  /** The group's parts now: native groups and speakers on their own. */
  plan(g: SpeakerGroup): PlanPart[] {
    return planParts(g.members, id => this.reg.get(id), this.natives(), this.config.get().combined ?? []);
  }

  offsets(groupId: string, parts: PlanPart[]): Record<string, number> { return offsetsFor(this.config.get().groupOffsets?.[groupId], parts); }

  /** The key a part's start delay is learned under: a native group's key, or the speaker that plays. */
  latencyKey(p: PlanPart): string { return p.kind === 'native' ? p.key : p.players[0]!; }

  view(groupId: string): GroupSyncView | null {
    const g = this.group(groupId);
    if (!g) return null;
    const parts = this.plan(g), offs = this.offsets(g.id, parts), s = this.sessions.get(g.id), t = this.tests.get(g.id);
    const ref = parts[0];
    const near = (p: PlanPart): string | null => {
      if (!ref || p.reference) return null;
      const room = this.reg.get(p.members[0]!)?.room;
      const ds = ref.members.map(id => this.reg.get(id)).filter((d): d is Device => !!d);
      return (ds.find(d => d.room === room) ?? ds[0])?.name ?? null;
    };
    return {
      parts: parts.map(p => ({ ...p, offset: offs[p.key] ?? 0, latencyMs: this.book.get(this.latencyKey(p)) ?? null, latencyN: this.book.count(this.latencyKey(p)), driftMs: s?.drift.get(p.key) ?? null, listenWith: near(p) })),
      playing: s ? { media: s.media, live: s.live, startAt: s.startAt } : null,
      test: t ? { until: t.until } : null,
      log: [...(this.logs.get(g.id) ?? [])].reverse(),
    };
  }

  log(groupId: string, text: string): void {
    const l = this.logs.get(groupId) ?? [];
    l.push({ at: this.now(), text });
    if (l.length > 60) l.splice(0, l.length - 60);
    this.logs.set(groupId, l);
  }

  private adapterOf(id: string): { a?: Adapter; d?: Device } {
    const d = this.reg.get(id);
    return { d, a: d ? this.reg.adapters.get(d.adapter) : undefined };
  }

  /** Where a part is: asked of its first player (a native group's speaker answers for the group). */
  private async position(p: PlanPart): Promise<PlaybackPosition | null> {
    const { a, d } = this.adapterOf(p.players[0]!);
    if (!a?.playbackPosition || !d) return null;
    try { return await a.playbackPosition(d); } catch { return null; }
  }

  private sleep(s: Session | null, ms: number): Promise<void> {
    return new Promise(r => {
      const t = setTimeout(() => { s?.timers.delete(t); r(); }, Math.max(0, ms));
      s?.timers.add(t);
    });
  }

  /**
   * Play to a group: each part at its moment. Resolves with each player's result, in the order of the parts' players.
   * Ends whatever the group played before as far as timing goes.
   */
  async play(g: SpeakerGroup, cmd: Command, cause: Cause, o: { quiet?: boolean } = {}): Promise<{ id: string; result: PromiseSettledResult<unknown> }[]> {
    this.end(g.id);
    const parts = this.plan(g);
    if (!parts.length) throw new Error(`${g.name} has no speakers`);
    const media = String(cmd.media);
    const live = !!this.reg.streamUrl(media);
    const offs = this.offsets(g.id, parts);
    const now = this.now();
    const sch = schedule(parts.map(p => ({ key: p.key, latencyMs: live ? undefined : this.book.get(this.latencyKey(p)) })), offs, now, live, this.o.marginMs ?? 150);
    const s: Session = {
      group: g.id, media, live, startAt: sch.startAt, parts, cause, timer: null, timers: new Set(), checking: false, ended: false, misses: 0,
      pending: new Map(), lastSeek: new Map(), seeked: new Set(), drift: new Map(),
    };
    this.sessions.set(g.id, s);
    if (parts.length > 1) {
      this.log(g.id, `Playing ${media}${live ? ' (a live stream: offsets only)' : ''} as ${parts.length} streams: ${parts.map(p => {
        const lat = this.book.get(this.latencyKey(p));
        return `${p.name} asked at +${Math.max(0, Math.round(sch.sends[p.key]! - now))} ms${!live ? ` (start delay ${lat != null ? sec(lat) : 'not learned yet'})` : ''}${offs[p.key] ? `, ${signed(offs[p.key]!)}` : ''}`;
      }).join('; ')}`);
    }
    const sentAt = new Map<string, number>();
    const out = await Promise.all(parts.map(async p => {
      await this.sleep(s, sch.sends[p.key]! - this.now());
      if (s.ended) return p.players.map(id => ({ id, result: { status: 'rejected', reason: new Error('Something else was played on the group') } as PromiseSettledResult<unknown> }));
      sentAt.set(p.key, this.now());
      const r = await Promise.allSettled(p.players.map(id => this.reg.command(id, cmd, cause, { quiet: !!o.quiet })));
      return p.players.map((id, i) => ({ id, result: r[i]! }));
    }));
    if (!live && !s.ended && parts.length > 1) {
      for (const p of parts) { const t0 = sentAt.get(p.key); if (t0 != null) void this.measureStart(s, p, t0); }
      const every = this.o.checkMs ?? CHECK_MS;
      if (every > 0) { s.timer = setInterval(() => void this.check(s), every); s.timer.unref?.(); }
    }
    this.emit('changed');
    return out.flat();
  }

  /** Watch a part start, and learn its start delay: when it really began (its place, back from when it said so) less when it was asked. */
  private async measureStart(s: Session, p: PlanPart, t0: number): Promise<void> {
    const until = t0 + (this.o.measureMs ?? 15_000);
    while (!s.ended && this.now() < until) {
      const at = await this.position(p);
      if (at && at.playing && at.index === 0 && at.positionMs > 0) {
        const ms = Math.round(at.at - at.positionMs - t0);
        if (this.book.record(this.latencyKey(p), Math.max(0, ms))) this.log(s.group, `${p.name} started ${sec(Math.max(0, ms))} after it was asked`);
        this.emit('changed');
        return;
      }
      await this.sleep(s, 200);
    }
  }

  /** One drift check: every part's place against the reference's, and a correction where one is due. */
  async check(s: Session): Promise<void> {
    if (s.checking || s.ended || s.live) return;
    s.checking = true;
    try {
      const pos = await Promise.all(s.parts.map(p => this.position(p)));
      const ref = pos[0];
      if (!ref) { if (++s.misses >= 3) this.end(s.group); return; }
      s.misses = 0;
      if (!ref.playing) return;
      const offs = this.offsets(s.group, s.parts);
      for (let k = 1; k < s.parts.length; k++) {
        const part = s.parts[k]!, at = pos[k];
        if (!at || !at.playing || s.ended) { s.drift.set(part.key, null); continue; }
        const off = offs[part.key] ?? 0;
        const d = driftOf(ref, at, off);
        s.drift.set(part.key, d);
        // How far the last move landed from where it was meant to: the seek delay to use next time.
        if (s.seeked.has(part.key) && d != null) {
          s.seeked.delete(part.key);
          this.book.record(`seek:${part.key}`, Math.max(0, Math.min(5000, this.seekDelay(part) - d)));
        }
        const act = driftAction({ live: s.live, driftMs: d, sinceSeekMs: this.now() - (s.lastSeek.get(part.key) ?? -Infinity) });
        if (act === 'none') { s.pending.delete(part.key); continue; }
        const how = `${part.name} is ${Math.abs(d!)} ms ${d! > 0 ? 'ahead' : 'behind'}${off ? ` (after its ${signed(off)})` : ''}`;
        if (act === 'seek') {
          s.pending.delete(part.key);
          this.log(s.group, `${how}: more than ${DRIFT_SEEK_MS} ms, so moved now, mid-song`);
          await this.seek(s, part, ref, at, off);
          continue;
        }
        let pend = s.pending.get(part.key);
        if (!pend) { pend = { refIndex: ref.index }; s.pending.set(part.key, pend); this.log(s.group, `${how}: lining it up at the start of the next song`); }
        const now = this.now(), left = ref.durationMs ? ref.durationMs - posAt(ref, now) : undefined;
        if (left != null && left <= (this.o.checkMs ?? CHECK_MS) + 1500 && !pend.scheduled) {
          pend.scheduled = true;
          void this.atBoundary(s, part, ref, off, now + left);
        } else if (left == null && ref.index !== pend.refIndex && posAt(ref, now) < 4000) {
          // The song's length isn't known: line it up just after the song changed.
          s.pending.delete(part.key);
          this.log(s.group, `${part.name} lined up just after the song changed`);
          await this.seek(s, part, ref, at, off, false);
        }
      }
    } finally { s.checking = false; this.emit('changed'); }
  }

  private seekDelay(p: PlanPart): number { return this.book.get(`seek:${p.key}`) ?? SEEK_GUESS_MS; }

  /** Move a part to where it should be when the move lands; a speaker that seeks in whole seconds is asked at the right moment. */
  private async seek(s: Session, p: PlanPart, ref: PlaybackPosition, at: PlaybackPosition, off: number, midSong = true): Promise<void> {
    const { a, d } = this.adapterOf(p.players[0]!);
    if (!a?.syncTo || !d) return;
    const L = this.seekDelay(p), now = this.now();
    let index = ref.index, target = posAt(ref, now + L) + off;
    if (ref.durationMs && target >= ref.durationMs) { index++; target -= ref.durationMs; }
    target = Math.max(0, target);
    const step = at.seekStepMs ?? 1;
    let wait = 0;
    if (step > 1) { const S = Math.ceil(target / step) * step; wait = S - target; target = S; }
    await this.sleep(s, wait);
    if (s.ended) return;
    try {
      await a.syncTo(d, { index, positionMs: Math.round(target) });
      // Only a move mid-song counts against chasing it again soon (a line-up at a song change isn't heard).
      if (midSong) s.lastSeek.set(p.key, this.now());
      s.seeked.add(p.key);
    } catch (e) { this.log(s.group, `${p.name} couldn’t be moved: ${(e as Error).message}`); }
  }

  /** At the reference's next song: start that song on the part at the shared moment (less its offset). */
  private async atBoundary(s: Session, p: PlanPart, ref: PlaybackPosition, off: number, endAt: number): Promise<void> {
    const { a, d } = this.adapterOf(p.players[0]!);
    if (!a?.syncTo || !d) return;
    await this.sleep(s, endAt - off - this.seekDelay(p) - this.now());
    if (s.ended) return;
    try {
      await a.syncTo(d, { index: ref.index + 1, positionMs: 0 });
      s.seeked.add(p.key);
      s.pending.delete(p.key);
      this.log(s.group, `${p.name} started the next song with the others`);
    } catch (e) { this.log(s.group, `${p.name} couldn’t be lined up: ${(e as Error).message}`); }
  }

  /** The owner moved a part's offset: while a queue plays, move that part now, so the change is heard. */
  async retune(groupId: string, keys: string[]): Promise<void> {
    const s = this.sessions.get(groupId);
    if (!s || s.live || s.ended) return;
    const pos = await Promise.all(s.parts.map(p => this.position(p)));
    const ref = pos[0];
    if (!ref?.playing) return;
    const offs = this.offsets(groupId, s.parts);
    for (const k of keys) {
      const i = s.parts.findIndex(p => p.key === k);
      if (i < 1 || !pos[i]?.playing) continue;
      this.log(groupId, `${s.parts[i]!.name} moved to ${signed(offs[k] ?? 0)}`);
      await this.seek(s, s.parts[i]!, ref, pos[i]!, offs[k] ?? 0, false);
    }
  }

  /** Is the group playing as Kova started it (a session with drift checks)? */
  session(groupId: string): Session | undefined { return this.sessions.get(groupId); }

  /** Stop keeping the group in time (it stopped, or something else plays). */
  end(groupId: string): void {
    const s = this.sessions.get(groupId);
    if (!s) return;
    s.ended = true;
    if (s.timer) clearInterval(s.timer);
    for (const t of s.timers) clearTimeout(t);
    this.sessions.delete(groupId);
  }

  // ------------------------------------------------------------ sync test --

  testing(groupId: string): boolean { return this.tests.has(groupId); }

  /**
   * The sync test: Kova's click track on every speaker of the group at once, at a low level (SYNC_TEST_LEVEL × each
   * speaker's announcement loudness), through the same timing as music. What each speaker was doing is noted first
   * (as an announcement does) and put back when the test stops, or after it has played through.
   */
  async startTest(groupId: string, cause: Cause, level = SYNC_TEST_LEVEL): Promise<{ until: number }> {
    const g = this.group(groupId);
    if (!g) throw new Error('That speaker group no longer exists');
    if (this.tests.has(groupId)) await this.stopTest(groupId);
    const parts = this.plan(g);
    const players = [...new Set(parts.flatMap(p => p.players))].filter(id => this.reg.get(id)?.state.online !== false);
    if (players.length < 2) throw new Error(`${g.name} needs two speakers online for a sync test`);
    const snaps = new Map<string, PlaybackSnap>();
    await Promise.all(players.map(async id => { snaps.set(id, await this.reg.snapshotPlayback(id).catch(() => ({ state: this.reg.get(id)!.state }))); }));
    const ms = this.o.testMs ?? SYNC_TEST_MS;
    const t: SyncTest = { snaps, players, until: this.now() + ms, timer: null, cause };
    this.tests.set(groupId, t);
    try {
      const cfg = this.config.get();
      await Promise.allSettled(players.map(id => this.reg.command(id, { vol: announceVol(level, trimOf(cfg, id)) }, cause, { quiet: true })));
      const r = await this.play(g, { on: true, media: SYNC_TEST_MEDIA }, cause, { quiet: true });
      const bad = r.filter(x => x.result.status === 'rejected');
      if (bad.length === r.length) throw (bad[0]!.result as PromiseRejectedResult).reason;
      for (const b of bad) this.log(groupId, `${this.reg.get(b.id)?.name ?? b.id} didn’t play the test: ${((b.result as PromiseRejectedResult).reason as Error)?.message}`);
      this.log(groupId, `Sync test started at ${level}%`);
    } catch (e) {
      await this.stopTest(groupId);
      throw e;
    }
    t.timer = setTimeout(() => void this.stopTest(groupId), ms + 3000);
    t.timer.unref?.();
    this.emit('changed');
    return { until: t.until };
  }

  /** Stop the sync test and put every speaker back as it was (its volume, and what it played). */
  async stopTest(groupId: string): Promise<string[]> {
    const t = this.tests.get(groupId);
    if (!t) return [];
    this.tests.delete(groupId);
    if (t.timer) clearTimeout(t.timer);
    this.end(groupId);
    const q = { quiet: true };
    // Off together first (a Cast group's session ends as one), then each back as it was.
    await Promise.allSettled(t.players.filter(id => this.reg.get(id)?.state.media === SYNC_TEST_MEDIA).map(id => this.reg.command(id, { on: false, media: null }, t.cause, q)));
    const back = await Promise.allSettled(t.players.map(id => this.reg.restorePlayback(id, t.snaps.get(id)!, t.cause, true)));
    const words = back.map((b, i) => `${this.reg.get(t.players[i]!)?.name ?? t.players[i]}: ${b.status === 'fulfilled' ? b.value : (b.reason as Error)?.message}`);
    this.log(groupId, `Sync test stopped. ${words.join('; ')}`);
    this.emit('changed');
    return words;
  }

  stop(): void {
    for (const id of [...this.sessions.keys()]) this.end(id);
    for (const t of this.tests.values()) if (t.timer) clearTimeout(t.timer);
  }
}
