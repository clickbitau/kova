import { EventEmitter } from 'node:events';
import type { Adapter, AdapterContext, DeviceInfo } from '../adapters/sdk.ts';
import type { Cause, Command, Device, DeviceState, Targets } from '../model/types.ts';
import type { Store } from '../store/db.ts';
import { CAPS, changeSentence, fitCommand } from '../util/describe.ts';

/**
 * Readings that update silently: they're not "changes" anyone made. A vacuum's
 * activity rides along with `on`, which is what gets logged.
 */
const MEASUREMENTS = new Set(['online', 'power', 'energy', 'grid', 'load', 'battery', 'activity']);

export interface ChangeEvent { device: Device; prev: DeviceState; patch: Command; cause: Cause }
export interface DeviceEvent { device: Device; type: string; data: Record<string, unknown> }

/**
 * Holds every device and its live state. All changes go through here so each
 * one is written to the event log with its cause.
 */
export class Registry extends EventEmitter<{ change: [ChangeEvent]; event: [DeviceEvent]; devices: []; measure: [] }> {
  readonly devices = new Map<string, Device>();
  readonly adapters = new Map<string, Adapter>();

  /** Last known state per device, so a restart doesn't forget what things were doing. */
  private saved: Record<string, DeviceState>;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Devices marked offline because their adapter was removed; a new adapter announcing them clears that. */
  private orphaned = new Set<string>();

  constructor(private store: Store, private sourceUrl: (name: string) => string | undefined = () => undefined) {
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
      this.devices.set(info.id, {
        ...info,
        capabilities: info.capabilities?.length ? info.capabilities : CAPS[info.type],
        adapter: a.id,
        state: { ...(info.state ?? {}), ...(this.saved[info.id] ?? {}), ...(existing?.state ?? {}) },
      });
    }
    this.emit('devices');
  }

  get(id: string): Device | undefined { return this.devices.get(id); }
  list(): Device[] { return [...this.devices.values()]; }

  /** Only the fields of `patch` that would change the device. */
  diff(d: Device, patch: Command): Command {
    const out: Command = {};
    for (const [k, v] of Object.entries(patch)) {
      if ((d.state as Record<string, unknown>)[k] !== v) (out as Record<string, unknown>)[k] = v;
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
    const patch = this.diff(d, fitCommand(d, cmd));
    if (!Object.keys(patch).length) return {};
    const adapter = this.adapters.get(d.adapter);
    if (!adapter) throw new Error(`No adapter ${d.adapter} for ${id}`);
    try {
      await adapter.command(d, patch);
    } catch (err) {
      this.store.append({ kind: 'system', device: id, feed: 'system', what: `${d.name} didn't respond`, data: { error: String(err), patch }, cause });
      throw err;
    }
    return this.apply(d, patch, cause, opts.quiet);
  }

  /** Apply many targets at once. Failures on one device don't stop the rest. The caller logs one summary entry. */
  async applyTargets(targets: Targets, cause: Cause): Promise<{ changed: string[]; prev: Targets }> {
    const changed: string[] = [];
    const prev: Targets = {};
    await Promise.all(Object.entries(targets).map(async ([id, cmd]) => {
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
    if (onlyOnline) { d.state = { ...d.state, ...patch }; this.emit('measure'); return; }
    this.apply(d, patch, { kind: 'device', label: `${d.integration}`, detail: 'changed at the device or in another app' });
  }

  /** A momentary event from a device (camera saw a person, doorbell rang). */
  deviceEvent(id: string, type: string, data: Record<string, unknown> = {}): void {
    const d = this.devices.get(id);
    if (!d) return;
    this.emit('event', { device: d, type, data });
  }
}
