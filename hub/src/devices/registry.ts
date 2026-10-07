import { EventEmitter } from 'node:events';
import type { Adapter, AdapterContext, Clip, DeviceInfo, Queue, QueueOptions } from '../adapters/sdk.ts';
import type { Cause, Command, Device, DeviceSettings, DeviceState, Targets } from '../model/types.ts';
import type { Store } from '../store/db.ts';
import { CAPS, changeSentence, fitCommand, PSEUDO_TARGET, typeMatch } from '../util/describe.ts';
import { isSensor } from '../util/sensors.ts';
import { allClosedAfter, mergeCommand, zoneCommands, type ZoneCommand } from '../util/zones.ts';

/**
 * Readings that update silently: they're not "changes" anyone made. A vacuum's
 * activity rides along with `on`, which is what gets logged. A room's temperature,
 * humidity, light and air are readings too, whichever device senses them. A server's power supplies and
 * sensors (the router's BMC) too: a supply that changes comes with an event, and that's logged.
 */
const MEASUREMENTS = new Set(['online', 'power', 'energy', 'grid', 'load', 'battery', 'activity', 'temp', 'humidity', 'lux', 'pm25', 'airQuality', 'filterLife', 'supplies', 'redundancy', 'sensors', 'fanMode', 'fanPercent']);

/** Value equality for state fields: objects (extras, zones, track) compare by content, not reference. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** What a speaker was doing before an announcement: its state, and its integration's exact account when it has one. */
export interface PlaybackSnap { state: DeviceState; exact?: unknown | null; hasExact?: boolean }

/** Seconds as "1:23". */
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface ChangeEvent { device: Device; prev: DeviceState; patch: Command; cause: Cause }
export interface DeviceEvent { device: Device; type: string; data: Record<string, unknown> }
/** A command on its way to a device, and who asked. */
export interface SentEvent { device: Device; cmd: Command; cause: Cause }

/**
 * The last change of a device's input that Kova saw: what it was changed to, when (Unix ms), by whom ("helix-auto" for
 * Helix switching by itself, "remote" for the device's own remote, else who asked: "You", "Helix remote", an automation's
 * name), and whether that was a person rather than something automatic.
 */
export interface InputChange { input: string; at: number; by: string; person: boolean; /** The input before. */ from?: string }

/** Who changed an input, from the cause of the change. */
export function inputChangeBy(cause: Cause): { by: string; person: boolean } {
  if (cause.id === 'helix-auto') return { by: 'helix-auto', person: false };
  if (cause.kind === 'device') return { by: 'remote', person: true };
  if (cause.kind === 'user' || cause.kind === 'assistant' || cause.kind === 'undo') return { by: cause.label, person: true };
  return { by: cause.label, person: false };
}

/** A readback this soon after Kova asked for an input, still showing another, is the device catching up, not someone changing it. */
const INPUT_SETTLE_MS = 20_000;

/**
 * Holds every device and its live state. All changes go through here so each
 * one is written to the event log with its cause.
 */
export class Registry extends EventEmitter<{ change: [ChangeEvent]; event: [DeviceEvent]; devices: []; measure: []; sent: [SentEvent]; reading: [ChangeEvent]; seen: [Device] }> {
  readonly devices = new Map<string, Device>();
  readonly adapters = new Map<string, Adapter>();

  /** Last known state per device, so a restart doesn't forget what things were doing. */
  private saved: Record<string, DeviceState>;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Devices marked offline because their adapter was removed; a new adapter announcing them clears that. */
  private orphaned = new Set<string>();

  /** The last input change of each device with an input, kept across restarts (inputChange()). */
  private inputLog: Record<string, InputChange>;

  /** What each integration called a device and where it put it, before the owner's settings. */
  private origin = new Map<string, { name: string; room: string }>();

  /** Music by name → a play queue (services/helix-music.ts); set by the hub. */
  queues: ((media: string, opts: QueueOptions) => Promise<Queue | null>) | null = null;
  /** Whether a name is music (not a radio source), for a plain answer on speakers that can't play a queue. */
  isMusic: ((media: string) => boolean) | null = null;

  /** Whether a source loops (set by the hub from the home's sources). */
  sourceLoops: (name: string) => boolean = () => false;

  /** Announcements playing now, by title → URL: a speaker without its own clip support plays them as a source. */
  private clipSources = new Map<string, string>();
  private srcUrl(name: string): string | undefined { return this.clipSources.get(name) ?? this.sourceUrl(name); }
  /** A stream or recording's URL by name (a source, or an announcement playing now): what adapters play as a stream. */
  streamUrl(name: string): string | undefined { return this.srcUrl(name); }

  /** Queues Kova makes itself (the speaker groups' sync test), by media name, ahead of Helix music. */
  readonly ownQueues = new Map<string, (opts: QueueOptions) => Promise<Queue | null>>();

  constructor(private store: Store, private sourceUrl: (name: string) => string | undefined = () => undefined, private settings: () => Record<string, DeviceSettings> = () => ({})) {
    super();
    this.saved = store.get<Record<string, DeviceState>>('deviceState') ?? {};
    this.inputLog = store.get<Record<string, InputChange>>('inputLog') ?? {};
  }

  /** The last input change Kova saw on this device: asked for through Kova, or read back from the device. */
  inputChange(id: string): InputChange | undefined { return this.inputLog[id]; }

  private recordInput(id: string, input: string, cause: Cause, from?: string): void {
    this.inputLog[id] = { input, at: Date.now(), ...inputChangeBy(cause), ...(from && from !== input ? { from } : {}) };
    this.persist();
  }

  /** The input a device was last known on: the last change Kova saw, else what it read back. */
  private knownInput(d: Device): string | undefined {
    return this.inputLog[d.id]?.input ?? (typeof d.state.input === 'string' && d.state.input ? d.state.input : undefined);
  }

  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 500);
  }

  flush(): void {
    for (const d of this.devices.values()) this.saved[d.id] = d.state;
    this.store.set('deviceState', this.saved);
    this.store.set('inputLog', this.inputLog);
  }

  async addAdapter(a: Adapter): Promise<void> {
    this.adapters.set(a.id, a);
    const ctx: AdapterContext = {
      log: (msg, ...rest) => console.log(`[${a.id}] ${msg}`, ...rest),
      announce: infos => this.announce(a, infos),
      report: (id, state) => this.report(id, state),
      event: (id, type, data = {}) => this.deviceEvent(id, type, data),
      sourceUrl: name => this.srcUrl(name),
      sourceLoops: name => this.sourceLoops(name),
      queueFor: (media, opts) => this.ownQueues.get(media)?.(opts ?? {}) ?? (this.queues ? this.queues(media, opts ?? {}) : Promise.resolve(null)),
      derive: (id, state) => { const d = this.devices.get(id); if (!d) return; const patch = this.diff(d, state); if (!Object.keys(patch).length) return; d.state = { ...d.state, ...patch }; this.emit('measure'); },
      peer: id => this.adapters.get(id),
      known: id => this.devices.has(id) || id in this.saved,
      retract: ids => { let n = 0; for (const id of ids) if (this.devices.get(id)?.adapter === a.id) { this.devices.delete(id); n++; } if (n) this.emit('devices'); },
    };
    try {
      await a.start(ctx);
    } catch (err) {
      this.store.append({ kind: 'system', device: null, feed: 'system', what: `${a.name} failed to start`, data: { error: String(err) }, cause: { kind: 'system', label: a.name } });
    }
  }

  /**
   * Stop one adapter and take it out. Its devices stay (same ids, so modes and
   * overlays that name them keep working) and show as offline until an adapter
   * announces them again, unless `forget` is set: then they're dropped from the
   * list, though their last state is kept for when they come back.
   */
  async removeAdapter(id: string, opts: { forget?: boolean } = {}): Promise<boolean> {
    const a = this.adapters.get(id);
    if (!a) return false;
    this.adapters.delete(id);
    await a.stop().catch(() => {});
    for (const d of this.list().filter(x => x.adapter === id)) {
      this.saved[d.id] = d.state;
      if (opts.forget) this.devices.delete(d.id);
      else { d.state = { ...d.state, online: false }; this.orphaned.add(d.id); }
    }
    this.persist();
    this.emit('devices');
    return true;
  }

  async stop(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.flush();
    await Promise.all([...this.adapters.values()].map(a => a.stop().catch(() => {})));
  }

  private announce(a: Adapter, infos: DeviceInfo[]): void {
    for (const info of infos) {
      const existing = this.devices.get(info.id);
      if (existing && this.orphaned.delete(info.id)) { const { online: _gone, ...rest } = existing.state; existing.state = rest; }
      this.origin.set(info.id, { name: info.name, room: info.room });
      this.devices.set(info.id, this.withSettings({
        ...info,
        capabilities: info.capabilities?.length ? info.capabilities : CAPS[info.type],
        adapter: a.id,
        state: { ...(info.state ?? {}), ...(this.saved[info.id] ?? {}), ...(existing?.state ?? {}) },
      }));
    }
    this.emit('devices');
  }

  /** A device with the owner's name, room and visibility applied over what its integration reported. */
  private withSettings(d: Device): Device {
    const o = this.origin.get(d.id) ?? { name: d.name, room: d.room };
    const s = this.settings()[d.id] ?? {};
    const name = s.name?.trim() || o.name, room = s.room || o.room;
    const out: Device = { ...d, name, room };
    delete out.hidden; delete out.archived; delete out.original;
    if (s.hidden) out.hidden = true;
    if (s.archived) out.archived = true;
    if (name !== o.name || room !== o.room) out.original = o;
    return out;
  }

  /** Re-apply the owner's device settings (after they change). */
  reapplySettings(): void {
    let changed = false;
    for (const d of this.devices.values()) {
      const n = this.withSettings(d);
      if (n.name !== d.name || n.room !== d.room || !!n.hidden !== !!d.hidden || !!n.archived !== !!d.archived) changed = true;
      d.name = n.name; d.room = n.room;
      if (n.hidden) d.hidden = true; else delete d.hidden;
      if (n.archived) d.archived = true; else delete d.archived;
      if (n.original) d.original = n.original; else delete d.original;
    }
    if (changed) this.emit('devices');
  }

  get(id: string): Device | undefined { return this.devices.get(id); }
  list(): Device[] { return [...this.devices.values()]; }

  /** Only the fields of `patch` that would change the device. */
  diff(d: Device, patch: Command): Command {
    const out: Command = {};
    for (const [k, v] of Object.entries(patch)) {
      // A skip or volume step is momentary: always sent, never kept as state.
      if (k === 'skip' || k === 'volStep' || k === 'zoneSet' || !same((d.state as Record<string, unknown>)[k], v)) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  /**
   * Send a command to a device and record it. Returns the previous values of
   * the fields that changed, which is exactly what an undo needs.
   */
  async command(id: string, cmd: Command, cause: Cause, opts: { quiet?: boolean } = {}): Promise<Command> {
    const d = this.devices.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    if (typeof cmd.media === 'string' && !d.capabilities.includes('queue') && !d.capabilities.includes('library') && !this.srcUrl(cmd.media) && this.isMusic?.(cmd.media)) {
      throw new Error(`${d.name} can’t play Helix music yet (Google Cast, Sonos and AirPlay speakers can)`);
    }
    const patch = this.diff(d, fitCommand(d, cmd));
    if (!Object.keys(patch).length) return {};
    const adapter = this.adapters.get(d.adapter);
    if (!adapter) throw new Error(`No adapter ${d.adapter} for ${id}`);
    const before = this.knownInput(d);
    // Who asked a device for what, before it's done (the Helix link tells Helix who last changed an input).
    this.emit('sent', { device: d, cmd: patch, cause });
    let did: void | DeviceState;
    try {
      did = await adapter.command(d, patch, cause);
    } catch (err) {
      this.store.append({ kind: 'system', device: id, feed: 'system', what: `${d.name} didn't respond`, data: { error: String(err), patch }, cause });
      throw err;
    }
    // Who changed the input, even where the device can't say which input it's on (a TV's remote API).
    if (typeof patch.input === 'string' && patch.input) this.recordInput(d.id, patch.input, cause, before);
    // zoneSet is a change to some zones: what's kept is the zones as the adapter reports them after it.
    const { skip: _skip, volStep: _step, zoneSet: _zones, ...kept } = did ? { ...patch, ...did } : patch;
    // A skip changes the song (which the speaker reports), a step the volume: log it, keep no state for it.
    if ((_skip || _step) && !Object.keys(kept).length) {
      const what = _skip ? (_skip > 0 ? 'next song' : 'previous song') : `volume ${_step! > 0 ? 'up' : 'down'}`;
      this.store.append({ kind: 'state', device: d.id, feed: cause.kind === 'user' || cause.kind === 'assistant' ? 'device' : null, what: `${d.name}: ${what}`, data: { patch }, cause });
      return {};
    }
    return this.apply(d, kept, cause, opts.quiet);
  }

  /**
   * "type:light" / "room:lounge" / "zone:lounge" targets resolve here, at run time — devices added later join in.
   * A room's zone becomes its air conditioner's zone change (and the unit's mode when asked); zone changes for the
   * same unit merge. Closing zones so that none is left open turns the unit off, unless the target said otherwise.
   */
  expandTargets(targets: Targets): Record<string, Command> {
    const expanded: Record<string, Command> = {};
    const closing = new Set<string>();
    for (const [id, cmd] of Object.entries(targets)) {
      const m = PSEUDO_TARGET.exec(id);
      if (!m) { mergeCommand(expanded, id, cmd); continue; }
      if (m[1] === 'zone') {
        const zc = cmd as unknown as ZoneCommand;
        for (const [did, c] of Object.entries(zoneCommands(m[2]!, zc, this.devices.values(), this.settings()))) {
          mergeCommand(expanded, did, c);
          if ((zc.on === false || zc.open === 0) && zc.ac === undefined) closing.add(did);
        }
        continue;
      }
      for (const d of this.devices.values()) {
        if (m[1] === 'type' ? typeMatch(d, m[2]!) : d.room === m[2]) {
          const c = fitCommand(d, cmd);
          if (Object.keys(c).length) expanded[d.id] = c;
        }
      }
    }
    for (const id of closing) {
      const d = this.devices.get(id), c = expanded[id];
      if (d && c?.zoneSet && c.on === undefined && d.state.on && allClosedAfter(d, c.zoneSet)) c.on = false;
    }
    return expanded;
  }

  /** Apply many targets at once. Failures on one device don't stop the rest. The caller logs one summary entry. */

  async applyTargets(targets: Targets, cause: Cause): Promise<{ changed: string[]; prev: Targets; failed: { id: string; error: string }[] }> {
    // Archived devices are left alone: a mode or overlay that still names one skips it.
    const expanded = Object.fromEntries(Object.entries(this.expandTargets(targets)).filter(([id]) => !this.devices.get(id)?.archived));
    const changed: string[] = [];
    const prev: Targets = {};
    const failed: { id: string; error: string }[] = [];
    await Promise.all(Object.entries(expanded).map(async ([id, cmd]) => {
      try {
        const p = await this.command(id, cmd, cause, { quiet: true });
        if (Object.keys(p).length) { changed.push(id); prev[id] = p; }
      } catch (e) { failed.push({ id, error: e instanceof Error ? e.message : String(e) }); /* logged in command() */ }
    }));
    return { changed, prev, failed };
  }

  private apply(d: Device, patch: Command, cause: Cause, quiet = false): Command {
    const prev: Command = {};
    for (const k of Object.keys(patch)) (prev as Record<string, unknown>)[k] = (d.state as Record<string, unknown>)[k] ?? null;
    d.state = { ...d.state, ...patch };
    this.persist();
    const direct = cause.kind === 'user' || cause.kind === 'device' || cause.kind === 'assistant' || cause.kind === 'undo';
    // A sensor's motion comes and goes all day: kept in the log (room activity, timelines), not the Activity feed.
    // A door or window opening is worth seeing there, with the comings and goings.
    const sensor = isSensor(d);
    const feed = sensor ? ('open' in patch ? 'people' : null) : direct && !quiet ? 'device' : null;
    this.store.append({
      kind: 'state', device: d.id, feed,
      what: changeSentence(d, prev, patch), data: { patch, prev }, cause,
    });
    this.emit('change', { device: d, prev, patch, cause });
    return prev;
  }

  /** State reported by an adapter. Anything we didn't ask for was done at the device or by another app. */
  private report(id: string, state: DeviceState): void {
    const d = this.devices.get(id);
    if (!d) return;
    // It spoke, even if nothing changed (a sensor's "last reported").
    this.emit('seen', d);
    const patch = this.diff(d, state);
    if (!Object.keys(patch).length) return;
    if (typeof patch.input === 'string' && patch.input) this.inputReadBack(d, patch.input);
    const onlyOnline = Object.keys(patch).every(k => MEASUREMENTS.has(k));
    if (onlyOnline) {
      const wasOnline = d.state.online;
      const prev: DeviceState = {};
      for (const k of Object.keys(patch)) (prev as Record<string, unknown>)[k] = (d.state as Record<string, unknown>)[k] ?? null;
      d.state = { ...d.state, ...patch };
      this.emit('measure');
      // Readings (power, energy, battery…) for automations that compare them; not a change for screens.
      this.emit('reading', { device: d, prev, patch, cause: { kind: 'device', label: d.integration, detail: 'reading' } });
      // Going offline or coming back isn't news for Activity, but automations start on it.
      if ('online' in patch && patch.online !== wasOnline) {
        this.emit('change', { device: d, prev: { online: wasOnline }, patch: { online: patch.online }, cause: { kind: 'device', label: d.integration, detail: patch.online ? 'back online' : 'went offline' } });
      }
      return;
    }
    // The next song in a queue isn't news for Activity: keep it quiet, but let listeners (play counts) hear it.
    if (Object.keys(patch).every(k => k === 'track' || k === 'shuffle' || MEASUREMENTS.has(k))) {
      const prev: DeviceState = {};
      for (const k of Object.keys(patch)) (prev as Record<string, unknown>)[k] = (d.state as Record<string, unknown>)[k] ?? null;
      d.state = { ...d.state, ...patch };
      this.persist();
      this.emit('change', { device: d, prev, patch, cause: { kind: 'device', label: d.integration, detail: 'next song' } });
      this.emit('measure');
      return;
    }
    // A sensor reports what it noticed; anything else was changed at the device or in another app.
    this.apply(d, patch, isSensor(d) ? { kind: 'device', label: d.integration } : { kind: 'device', label: `${d.integration}`, detail: 'changed at the device or in another app' });
  }

  /**
   * An input read back from the device that isn't the one Kova knew: changed at the device (its own remote, or another
   * app). The first reading, with nothing known before, says nothing about who; one that still shows another input just
   * after Kova asked for one is the device catching up.
   */
  private inputReadBack(d: Device, input: string): void {
    const log = this.inputLog[d.id];
    const before = this.knownInput(d);
    if (before === undefined || before === input) return;
    // Still the input from before Kova's own change, just after it: the device catching up.
    if (log && log.from === input && Date.now() - log.at < INPUT_SETTLE_MS && log.by !== 'remote') return;
    this.recordInput(d.id, input, { kind: 'device', label: d.integration }, before);
  }

  // ------------------------------------------------------------ announcements --

  /** What a speaker is doing now, to put back after an announcement (engine/announce.ts). */
  async snapshotPlayback(id: string): Promise<PlaybackSnap> {
    const d = this.devices.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    const { on, media, vol, paused, shuffle, input, track, muted } = d.state;
    const state: DeviceState = { on: !!on, media: media ?? null, ...(typeof vol === 'number' ? { vol } : {}), paused: !!paused, shuffle: !!shuffle, ...(input ? { input } : {}), ...(track ? { track } : {}), ...(muted !== undefined ? { muted } : {}) };
    const a = this.adapters.get(d.adapter);
    if (!a?.snapshotPlayback) return { state };
    // The integration's own account, when it can give one; if asking fails, Kova still puts back what it knows.
    try { return { state, exact: await a.snapshotPlayback(d), hasExact: true }; } catch { return { state }; }
  }

  /** Play an announcement clip on a speaker at a volume: through its integration's own clip support, else as a source. */
  async playClip(id: string, clip: Clip, vol: number, cause: Cause, o: { keepVol?: boolean } = {}): Promise<void> {
    const d = this.devices.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    const a = this.adapters.get(d.adapter);
    if (!a) throw new Error(`No adapter ${d.adapter} for ${id}`);
    if (!a.playClip) {
      this.clipSources.set(clip.title, clip.url);
      await this.command(id, { on: true, media: clip.title, ...(o.keepVol ? {} : { vol }), paused: false }, cause, { quiet: true });
      return;
    }
    if (!o.keepVol && d.capabilities.includes('volume')) await this.command(id, { vol }, cause, { quiet: true });
    const did = await a.playClip(d, clip, cause);
    const patch = this.diff(d, { on: true, media: clip.title, paused: false, ...(did ?? {}) });
    if (Object.keys(patch).length) this.apply(d, patch, cause, true);
  }

  /**
   * Put a speaker back as `snap` says: its volume, then (when `resume`) what it played, at the place where its
   * integration allows, else started again by name; idle or off when it was. Resolves with what it did, in words.
   */
  async restorePlayback(id: string, snap: PlaybackSnap, cause: Cause, resume = true): Promise<string> {
    const d = this.devices.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    const s = snap.state;
    const a = this.adapters.get(d.adapter);
    const q = { quiet: true };
    if (typeof s.vol === 'number' && d.state.vol !== s.vol) await this.command(id, { vol: s.vol }, cause, q);
    const was = s.on && typeof s.media === 'string' && s.media !== '';
    if (resume && snap.hasExact && a?.restorePlayback && (snap.exact != null || !was)) {
      const r = await a.restorePlayback(d, snap.exact ?? null);
      const patch = this.diff(d, r.state ?? (snap.exact == null ? { on: s.on, media: null, paused: false, track: null } : {}));
      if (Object.keys(patch).length) this.apply(d, patch, cause, true);
      await this.inputBack(d, s, cause);
      return r.words;
    }
    if (!was || !resume) {
      if (d.state.on || d.state.media) await this.command(id, s.on ? { media: null } : { on: false, media: null }, cause, q);
      await this.inputBack(d, s, cause);
      return was ? `left idle (it was playing ${s.media})` : s.on ? 'idle again' : 'off again';
    }
    // Started again by name: a source (a live stream picks up where it is now), Helix music, a title on a TV.
    const media = s.media as string;
    if (this.sourceUrl(media) || this.isMusic?.(media) || d.capabilities.includes('library')) {
      await this.command(id, { on: true, media, ...(s.shuffle ? { shuffle: true } : {}) }, cause, q);
      if (s.paused && d.capabilities.includes('pause')) await this.command(id, { paused: true }, cause, q);
      await this.inputBack(d, s, cause);
      return `${media} again${this.sourceUrl(media) ? '' : ' (from the start)'}${s.paused ? ', paused' : ''}`;
    }
    await this.command(id, { media: null }, cause, q);
    throw new Error(`couldn’t carry on with “${media}” (it was playing from another app)`);
  }

  /** A soundbar back on the input it was on (Cast switches it to Wi-Fi to play). */
  private async inputBack(d: Device, s: DeviceState, cause: Cause): Promise<void> {
    if (s.input && d.capabilities.includes('input') && d.state.input !== s.input) await this.command(d.id, { input: s.input }, cause, { quiet: true }).catch(() => {});
  }

  /** A device's state as its integration now says, with no Activity entry (a member put back after an announcement). */
  setQuietly(id: string, state: DeviceState): void {
    const d = this.devices.get(id);
    if (!d) return;
    const patch = this.diff(d, state);
    if (Object.keys(patch).length) this.apply(d, patch, { kind: 'system', label: 'Announcement' }, true);
  }

  /** The clip a speaker played as a source is no longer needed by that name. */
  clipDone(title: string): void { this.clipSources.delete(title); }

  /** A momentary event from a device (camera saw a person, doorbell rang). */
  deviceEvent(id: string, type: string, data: Record<string, unknown> = {}): void {
    const d = this.devices.get(id);
    if (!d) return;
    this.emit('event', { device: d, type, data });
  }
}
