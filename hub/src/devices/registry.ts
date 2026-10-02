import { EventEmitter } from 'node:events';
import type { Adapter, AdapterContext, DeviceInfo, Queue } from '../adapters/sdk.ts';
import type { Cause, Command, Device, DeviceSettings, DeviceState, Targets } from '../model/types.ts';
import type { Store } from '../store/db.ts';
import { CAPS, changeSentence, fitCommand, PSEUDO_TARGET, typeMatch } from '../util/describe.ts';

/**
 * Readings that update silently: they're not "changes" anyone made. A vacuum's
 * activity rides along with `on`, which is what gets logged.
 */
const MEASUREMENTS = new Set(['online', 'power', 'energy', 'grid', 'load', 'battery', 'activity']);

export interface ChangeEvent { device: Device; prev: DeviceState; patch: Command; cause: Cause }
export interface DeviceEvent { device: Device; type: string; data: Record<string, unknown> }
/** A command on its way to a device, and who asked. */
export interface SentEvent { device: Device; cmd: Command; cause: Cause }

/**
 * Holds every device and its live state. All changes go through here so each
 * one is written to the event log with its cause.
 */
export class Registry extends EventEmitter<{ change: [ChangeEvent]; event: [DeviceEvent]; devices: []; measure: []; sent: [SentEvent]; reading: [ChangeEvent] }> {
  readonly devices = new Map<string, Device>();
  readonly adapters = new Map<string, Adapter>();

  /** Last known state per device, so a restart doesn't forget what things were doing. */
  private saved: Record<string, DeviceState>;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Devices marked offline because their adapter was removed; a new adapter announcing them clears that. */
  private orphaned = new Set<string>();

  /** What each integration called a device and where it put it, before the owner's settings. */
  private origin = new Map<string, { name: string; room: string }>();

  /** Music by name → a play queue (services/helix-music.ts); set by the hub. */
  queues: ((media: string, opts: { shuffle?: boolean }) => Promise<Queue | null>) | null = null;
  /** Whether a name is music (not a radio source), for a plain answer on speakers that can't play a queue. */
  isMusic: ((media: string) => boolean) | null = null;

  /** Whether a source loops (set by the hub from the home's sources). */
  sourceLoops: (name: string) => boolean = () => false;

  constructor(private store: Store, private sourceUrl: (name: string) => string | undefined = () => undefined, private settings: () => Record<string, DeviceSettings> = () => ({})) {
    super();
    this.saved = store.get<Record<string, DeviceState>>('deviceState') ?? {};
  }

  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 500);
  }

  flush(): void {
    for (const d of this.devices.values()) this.saved[d.id] = d.state;
    this.store.set('deviceState', this.saved);
  }

  async addAdapter(a: Adapter): Promise<void> {
    this.adapters.set(a.id, a);
    const ctx: AdapterContext = {
      log: (msg, ...rest) => console.log(`[${a.id}] ${msg}`, ...rest),
      announce: infos => this.announce(a, infos),
      report: (id, state) => this.report(id, state),
      event: (id, type, data = {}) => this.deviceEvent(id, type, data),
      sourceUrl: this.sourceUrl,
      sourceLoops: name => this.sourceLoops(name),
      queueFor: (media, opts) => this.queues ? this.queues(media, opts ?? {}) : Promise.resolve(null),
      derive: (id, state) => { const d = this.devices.get(id); if (!d) return; const patch = this.diff(d, state); if (!Object.keys(patch).length) return; d.state = { ...d.state, ...patch }; this.emit('measure'); },
      peer: id => this.adapters.get(id),
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
    delete out.hidden; delete out.original;
    if (s.hidden) out.hidden = true;
    if (name !== o.name || room !== o.room) out.original = o;
    return out;
  }

  /** Re-apply the owner's device settings (after they change). */
  reapplySettings(): void {
    let changed = false;
    for (const d of this.devices.values()) {
      const n = this.withSettings(d);
      if (n.name !== d.name || n.room !== d.room || !!n.hidden !== !!d.hidden) changed = true;
      d.name = n.name; d.room = n.room;
      if (n.hidden) d.hidden = true; else delete d.hidden;
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
      if (k === 'skip' || k === 'volStep' || k === 'zoneSet' || (d.state as Record<string, unknown>)[k] !== v) (out as Record<string, unknown>)[k] = v;
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
    if (typeof cmd.media === 'string' && !d.capabilities.includes('queue') && !d.capabilities.includes('library') && !this.sourceUrl(cmd.media) && this.isMusic?.(cmd.media)) {
      throw new Error(`${d.name} can’t play Helix music yet (Google Cast, Sonos and AirPlay speakers can)`);
    }
    const patch = this.diff(d, fitCommand(d, cmd));
    if (!Object.keys(patch).length) return {};
    const adapter = this.adapters.get(d.adapter);
    if (!adapter) throw new Error(`No adapter ${d.adapter} for ${id}`);
    // Who asked a device for what, before it's done (the Helix link tells Helix who last changed an input).
    this.emit('sent', { device: d, cmd: patch, cause });
    let did: void | DeviceState;
    try {
      did = await adapter.command(d, patch, cause);
    } catch (err) {
      this.store.append({ kind: 'system', device: id, feed: 'system', what: `${d.name} didn't respond`, data: { error: String(err), patch }, cause });
      throw err;
    }
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

  /** Apply many targets at once. Failures on one device don't stop the rest. The caller logs one summary entry. */
  async applyTargets(targets: Targets, cause: Cause): Promise<{ changed: string[]; prev: Targets }> {
    // "type:light" / "room:lounge" targets resolve here, at run time — devices added later join in.
    const expanded: Record<string, Command> = {};
    for (const [id, cmd] of Object.entries(targets)) {
      const m = PSEUDO_TARGET.exec(id);
      if (!m) { expanded[id] = cmd; continue; }
      for (const d of this.devices.values()) {
        if (m[1] === 'type' ? typeMatch(d, m[2]!) : d.room === m[2]) {
          const c = fitCommand(d, cmd);
          if (Object.keys(c).length) expanded[d.id] = c;
        }
      }
    }
    const changed: string[] = [];
    const prev: Targets = {};
    await Promise.all(Object.entries(expanded).map(async ([id, cmd]) => {
      try {
        const p = await this.command(id, cmd, cause, { quiet: true });
        if (Object.keys(p).length) { changed.push(id); prev[id] = p; }
      } catch { /* logged in command() */ }
    }));
    return { changed, prev };
  }

  private apply(d: Device, patch: Command, cause: Cause, quiet = false): Command {
    const prev: Command = {};
    for (const k of Object.keys(patch)) (prev as Record<string, unknown>)[k] = (d.state as Record<string, unknown>)[k] ?? null;
    d.state = { ...d.state, ...patch };
    this.persist();
    const direct = cause.kind === 'user' || cause.kind === 'device' || cause.kind === 'assistant' || cause.kind === 'undo';
    this.store.append({
      kind: 'state', device: d.id, feed: direct && !quiet ? 'device' : null,
      what: changeSentence(d, prev, patch), data: { patch, prev }, cause,
    });
    this.emit('change', { device: d, prev, patch, cause });
    return prev;
  }

  /** State reported by an adapter. Anything we didn't ask for was done at the device or by another app. */
  private report(id: string, state: DeviceState): void {
    const d = this.devices.get(id);
    if (!d) return;
    const patch = this.diff(d, state);
    if (!Object.keys(patch).length) return;
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
    this.apply(d, patch, { kind: 'device', label: `${d.integration}`, detail: 'changed at the device or in another app' });
  }

  /** A momentary event from a device (camera saw a person, doorbell rang). */
  deviceEvent(id: string, type: string, data: Record<string, unknown> = {}): void {
    const d = this.devices.get(id);
    if (!d) return;
    this.emit('event', { device: d, type, data });
  }
}
