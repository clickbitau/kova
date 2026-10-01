import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Automation, Cause, Command, Device, DeviceState, LightTheWayTrigger, Mode, Overlay, PersonState, PlanItem, Targets } from '../model/types.ts';
import type { Store } from '../store/db.ts';
import type { ChangeEvent, DeviceEvent, Registry } from '../devices/registry.ts';
import type { ConfigStore } from './config.ts';
import { Planner } from './plan.ts';
import { resolveRhythm, rhythmLabel } from '../rhythms/rhythms.ts';
import { clock, localDate } from '../util/time.ts';
import { isLight, isPlayer, targetLabel } from '../util/describe.ts';

export interface ActiveOverlay {
  id: string;
  since: number;
  /** When a time-based end resolves to an instant. */
  endsAt: number | null;
  /** What overlay-owned devices should return to when it ends. Mode changes during the overlay land here. */
  snapshot: Targets;
}

interface WayTimer { device: string; until: number; restore: Command | null; trigger: string }

type Undo = () => Promise<void> | void;

const LTW: Cause = { kind: 'behaviour', id: 'light_the_way', label: 'Light the way' };

/**
 * The engine decides what the home does: it moves between modes on their
 * rhythms, runs moments, layers overlays, runs behaviours, and answers "why?".
 */
export class Engine extends EventEmitter<{ changed: [] }> {
  readonly planner: Planner;
  modeId = '';
  overlay: ActiveOverlay | null = null;
  skips = new Set<string>();
  people: Record<string, PersonState> = {};
  /** A mode that started while nobody was home; its "on" targets wait for an arrival. */
  pendingEntry: string | null = null;
  private way = new Map<string, WayTimer>();
  private undos = new Map<string, { fn: Undo; at: number }>();
  private lastTick = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private reg: Registry, private config: ConfigStore, readonly now: () => number = Date.now) {
    super();
    this.planner = new Planner(() => config.get(), () => reg.devices);
    config.on('changed', () => { this.planner.invalidate(); this.emit('changed'); });
    reg.on('devices', () => { this.planner.invalidate(); this.emit('changed'); });
    reg.on('change', e => this.onChange(e));
    reg.on('event', e => void this.onDeviceEvent(e));
  }

  get cfg() { return this.config.get(); }
  get tz() { return this.cfg.timezone; }
  mode(id = this.modeId): Mode { return this.cfg.modes.find(m => m.id === id) ?? this.cfg.modes[0]; }

  // ------------------------------------------------------------ lifecycle --

  start(intervalMs = 1000): void {
    const t = this.now();
    this.skips = new Set(this.store.get<string[]>('skips') ?? []);
    this.overlay = this.store.get<ActiveOverlay | null>('overlay') ?? null;
    this.people = this.store.get<Record<string, PersonState>>('people') ?? {};
    for (const p of this.cfg.people) this.people[p.id] ??= { home: true, since: t };
    this.pendingEntry = this.store.get<string | null>('pendingEntry') ?? null;
    // Don't replay what we missed while off: take the current mode as-is and carry on.
    const cur = this.planner.modeAt(t).mode.id;
    if (this.store.get<string>('mode') !== cur) this.store.set('mode', cur);
    this.modeId = cur;
    this.lastTick = t;
    if (intervalMs > 0) this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Advance to `t`: fire due plan items, end overlays, expire behaviours. */
  async tick(t = this.now()): Promise<void> {
    if (t <= this.lastTick) return;
    const from = this.lastTick;
    this.lastTick = t;
    for (const item of this.planner.itemsBetween(from, t)) await this.fire(item);
    if (this.overlay?.endsAt != null && this.overlay.endsAt <= t) await this.endOverlay('time');
    for (const w of [...this.way.values()]) if (w.until <= t) await this.expireWay(w);
    this.pruneUndos(t);
  }

  // --------------------------------------------------------- plan items --

  anyoneHome(): boolean { return Object.values(this.people).some(p => p.home); }

  private async fire(item: PlanItem): Promise<void> {
    const skipped = this.skips.has(item.id);
    let targets = item.targets;
    let waitForSomeone = false;
    if (item.kind === 'mode') {
      const m = this.mode(item.refId);
      this.modeId = m.id;
      this.store.set('mode', m.id);
      this.pendingEntry = null;
      if (m.onlyWhenSomeoneHome && !this.anyoneHome()) {
        waitForSomeone = true;
        this.pendingEntry = m.id;
        targets = Object.fromEntries(Object.entries(targets).filter(([, c]) => c.on === false || c.media === null));
      }
      this.store.set('pendingEntry', this.pendingEntry);
    }
    const cause: Cause = item.kind === 'mode'
      ? { kind: 'mode', id: item.refId, label: `${this.mode(item.refId).name} started`, detail: this.mode(item.refId).start.kind === 'time' ? undefined : rhythmLabel(this.mode(item.refId).start) }
      : { kind: 'moment', id: item.refId, label: item.label };
    const lightsOnBefore = this.reg.list().filter(d => isLight(d) && d.state.on).map(d => d.id);
    let changed: string[] = [];
    if (!skipped) changed = await this.applyUnderOverlay(targets, cause);
    const lightsTurnedOn = Object.entries(targets).filter(([id, c]) => c.on !== false && this.reg.get(id) && isLight(this.reg.get(id)!)).length;
    const what = skipped ? `${item.label} skipped` : waitForSomeone
      ? `${cause.label} · nobody home, lights wait for someone to arrive`
      : `${item.kind === 'mode' ? cause.label : item.label} · ${plural(changed.length, 'device')} changed`;
    this.store.append({
      kind: item.kind === 'mode' ? 'mode' : 'run', device: null, feed: 'auto', what,
      data: {
        item: item.id, modeId: item.kind === 'mode' ? item.refId : item.modeId, skipped, waitForSomeone,
        changed, anyoneHome: this.anyoneHome(), lightsTurnedOn: skipped || waitForSomeone ? 0 : lightsTurnedOn, lightsOnBefore,
      },
      cause: skipped ? { kind: 'user', label: 'Skipped tonight' } : cause,
    });
    this.emit('changed');
  }

  /** Apply targets; devices owned by an active overlay have the change queued for when it ends. */
  private async applyUnderOverlay(targets: Targets, cause: Cause): Promise<string[]> {
    if (!this.overlay) return (await this.reg.applyTargets(targets, cause)).changed;
    const now: Targets = {};
    for (const [id, c] of Object.entries(targets)) {
      if (id in this.overlay.snapshot) this.overlay.snapshot[id] = { ...this.overlay.snapshot[id], ...c };
      else now[id] = c;
    }
    this.store.set('overlay', this.overlay);
    return (await this.reg.applyTargets(now, cause)).changed;
  }

  setSkip(itemId: string, skip: boolean): void {
    if (skip) this.skips.add(itemId); else this.skips.delete(itemId);
    // Keep only recent skips.
    const cutoff = localDate(this.now() - 3 * 86400_000, this.tz);
    this.skips = new Set([...this.skips].filter(s => (s.split('@')[1] ?? '') >= cutoff));
    this.store.set('skips', [...this.skips]);
    this.emit('changed');
  }

  // ------------------------------------------------------------ overlays --

  private overlayTargets(o: Overlay): Targets {
    const t: Targets = { ...o.targets };
    // The device that starts an overlay by itself keeps playing (Movie mustn't stop the film that started it).
    if (o.allOff) for (const d of this.reg.list()) if (!(d.id in t) && d.id !== o.startsOn?.device && (isLight(d) || isPlayer(d))) t[d.id] = isPlayer(d) ? { on: false, media: null } : { on: false };
    return t;
  }

  async startOverlay(id: string, by: Cause = { kind: 'user', label: 'You' }): Promise<string> {
    const o = this.cfg.overlays.find(x => x.id === id);
    if (!o) throw new Error(`Unknown overlay ${id}`);
    if (this.overlay?.id === id) return this.registerUndo(() => this.endOverlay('undo'));
    if (this.overlay) await this.endOverlay('replaced');
    const targets = this.overlayTargets(o);
    const snapshot: Targets = {};
    for (const [devId, c] of Object.entries(targets)) {
      const d = this.reg.get(devId);
      if (!d) continue;
      snapshot[devId] = pick(d.state, Object.keys(c));
    }
    const now = this.now();
    const endsAt = o.ends.kind === 'time' ? this.nextRhythm(o.ends.at, now) : null;
    this.overlay = { id, since: now, endsAt, snapshot };
    this.store.set('overlay', this.overlay);
    const cause: Cause = { kind: 'overlay', id, label: `${o.name} started`, detail: by.kind === 'user' ? undefined : by.label };
    const { changed } = await this.reg.applyTargets(targets, cause);
    this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${o.name} on · ${plural(changed.length, 'device')} changed`, data: { overlay: id, changed }, cause });
    this.emit('changed');
    return this.registerUndo(() => this.endOverlay('undo'));
  }

  async endOverlay(reason: 'user' | 'time' | 'device' | 'arrival' | 'undo' | 'replaced' = 'user'): Promise<void> {
    const cur = this.overlay;
    if (!cur) return;
    const o = this.cfg.overlays.find(x => x.id === cur.id);
    this.overlay = null;
    this.store.set('overlay', null);
    const name = o?.name ?? cur.id;
    const cause: Cause = { kind: 'overlay', id: cur.id, label: `${name} ended`, detail: { user: undefined, undo: 'undone', replaced: undefined, time: o?.endsLabel, device: o?.endsLabel, arrival: 'someone came home' }[reason] };
    const { changed } = await this.reg.applyTargets(cur.snapshot, cause);
    this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${name} ended · back to ${this.mode().name}`, data: { overlay: cur.id, changed, reason }, cause });
    this.emit('changed');
  }

  private nextRhythm(r: Parameters<typeof resolveRhythm>[0], after: number): number | null {
    for (let i = 0; i < 3; i++) {
      const t = resolveRhythm(r, localDate(after + i * 86400_000, this.tz), this.cfg);
      if (t != null && t > after) return t;
    }
    return null;
  }

  // ------------------------------------------------------------- devices --

  async command(id: string, cmd: Command, cause: Cause = { kind: 'user', label: 'You' }): Promise<string> {
    const prev = await this.reg.command(id, cmd, cause);
    return this.registerUndo(async () => { await this.reg.command(id, prev, { kind: 'undo', label: 'Undo' }); });
  }

  async applyMany(targets: Targets, cause: Cause): Promise<{ undo: string; changed: string[] }> {
    const { changed, prev } = await this.reg.applyTargets(targets, cause);
    if (changed.length) this.store.append({ kind: 'run', device: null, feed: cause.kind === 'user' || cause.kind === 'assistant' ? 'device' : 'auto', what: `${cause.label} · ${plural(changed.length, 'device')} changed`, data: { changed }, cause });
    return { changed, undo: this.registerUndo(async () => { await this.reg.applyTargets(prev, { kind: 'undo', label: 'Undo' }); }) };
  }

  private onChange(e: ChangeEvent): void {
    // Someone changed a light Light the way is holding: stop managing it.
    const w = this.way.get(e.device.id);
    if (w && e.cause.kind !== 'behaviour') this.way.delete(e.device.id);
    // "Movie ends when the TV turns off."
    const cur = this.overlay;
    if (cur) {
      const o = this.cfg.overlays.find(x => x.id === cur.id);
      if (o?.ends.kind === 'device_off' && o.ends.device === e.device.id && e.patch.on === false && e.cause.kind !== 'overlay') void this.endOverlay('device');
    }
    // Automations started by this device switching on or off, or going offline or coming back.
    const became = becameOf(e);
    if (became.length) {
      for (const a of this.automations()) {
        if (!('becomes' in a.when) || a.when.device !== e.device.id || !became.includes(a.when.becomes)) continue;
        if (e.cause.kind === 'automation' && e.cause.id === a.id) continue; // its own doing
        void this.runAutomation(a, `${e.device.name} ${BECAME[a.when.becomes]}`);
      }
    }
    this.emit('changed');
  }

  // --------------------------------------------------------- automations --

  private automations(): Automation[] { return (this.cfg.automations ?? []).filter(a => a.enabled !== false); }

  /** Do an automation's "then" if every "if" holds. Returns which devices changed, or null when an "if" didn't hold. */
  async runAutomation(a: Automation, why: string): Promise<string[] | null> {
    for (const c of a.if ?? []) {
      const d = this.reg.get(c.device);
      if (!d || !holds(d.state, c.is)) return null;
    }
    const cause: Cause = { kind: 'automation', id: a.id, label: a.name, detail: why };
    const { changed } = await this.reg.applyTargets(a.then, cause);
    if (changed.length) {
      const names = changed.map(id => this.reg.get(id)?.name ?? id);
      this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${a.name}: ${names.join(', ')} · ${why}`, data: { automation: a.id, changed }, cause });
    }
    return changed;
  }

  // --------------------------------------------------------- behaviours --

  private async onDeviceEvent(e: DeviceEvent): Promise<void> {
    const labels: Record<string, string> = {
      person: 'saw a person', ring: 'rang', motion: 'detected motion',
      'internet-down': 'is down', 'internet-up': 'is back', 'internet-failover': 'switched to the backup connection', 'new-device': 'saw a new device join', threat: 'blocked an attack',
      'video-started': 'started playing', 'music-started': 'started playing', paused: 'paused', resumed: 'carried on playing', stopped: 'stopped',
    };
    const title = typeof e.data?.title === 'string' && e.data.title && /started$/.test(e.type) ? ` ${e.data.title}` : '';
    this.store.append({
      kind: 'device_event', device: e.device.id, feed: 'people',
      what: `${e.device.name} ${labels[e.type] ?? e.type}${title}`,
      data: { type: e.type, ...e.data }, cause: { kind: 'device', label: e.device.integration },
    });
    for (const a of this.automations()) {
      if ('event' in a.when && a.when.device === e.device.id && a.when.event === e.type) await this.runAutomation(a, `${e.device.name} ${labels[e.type] ?? e.type}`);
    }
    const hits = this.cfg.lightTheWay.triggers.filter(t => 'device' in t.on && t.on.device === e.device.id && t.on.event === e.type);
    for (const t of hits) await this.lightTheWay(t);
    // "Movie starts when the lounge Helix plays a film."
    const starts = this.cfg.overlays.find(o => o.startsOn?.device === e.device.id && o.startsOn.event === e.type);
    if (starts && this.overlay?.id !== starts.id) {
      await this.startOverlay(starts.id, { kind: 'device', label: `${e.device.name} started playing` }).catch(err => console.warn(`[engine] ${starts.id}: ${String(err)}`));
    }
    if (e.type === 'ring' && this.cfg.pauseForDoorbell !== false) await this.pauseForDoor(e.device.name);
    this.emit('changed');
  }

  /** The doorbell rang: pause what's playing on players that can pause. */
  private async pauseForDoor(bell: string): Promise<void> {
    const playing = this.reg.list().filter(d => d.capabilities.includes('pause') && d.state.on && !d.state.paused);
    if (!playing.length) return;
    const cause: Cause = { kind: 'behaviour', id: 'doorbell-pause', label: 'Paused for the door', detail: `${bell} rang` };
    const { changed } = await this.reg.applyTargets(Object.fromEntries(playing.map(d => [d.id, { paused: true }])), cause);
    if (changed.length) this.store.append({ kind: 'run', device: null, feed: 'auto', what: `Paused ${playing.filter(d => changed.includes(d.id)).map(d => d.name).join(', ')}: ${bell} rang`, data: { changed }, cause });
  }

  private async lightTheWay(t: LightTheWayTrigger): Promise<void> {
    if (!this.mode().lightTheWay) return;
    const until = this.now() + t.minutes * 60_000;
    const cause: Cause = { ...LTW, detail: t.label };
    const turnOn: Targets = {};
    for (const id of t.lights) {
      const d = this.reg.get(id);
      if (!d) continue;
      const existing = this.way.get(id);
      if (existing) { existing.until = Math.max(existing.until, until); continue; }
      // Already on before we got here: leave it on afterwards.
      this.way.set(id, { device: id, until, trigger: t.id, restore: d.state.on ? null : { on: false } });
      if (!d.state.on) turnOn[id] = { on: true };
    }
    const { changed } = await this.reg.applyTargets(turnOn, cause);
    const names = t.lights.map(id => this.reg.get(id)?.name).filter(Boolean);
    this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${names.join(' and ')} on for ${t.minutes} min`, data: { behaviour: 'light_the_way', trigger: t.id, changed }, cause });
  }

  private async expireWay(w: WayTimer): Promise<void> {
    this.way.delete(w.device);
    if (w.restore) {
      try { await this.reg.command(w.device, w.restore, { ...LTW, label: 'Light the way finished' }); } catch { /* logged */ }
    }
  }

  // ------------------------------------------------------------- people --

  async setPresence(personId: string, home: boolean, source?: string): Promise<void> {
    const p = this.cfg.people.find(x => x.id === personId);
    if (!p) throw new Error(`Unknown person ${personId}`);
    const cur = this.people[personId];
    if (cur?.home === home) return;
    const wasAnyone = this.anyoneHome();
    this.people[personId] = { home, since: this.now() };
    this.store.set('people', this.people);
    this.store.append({ kind: 'presence', device: null, feed: 'people', what: `${p.name} ${home ? 'arrived home' : 'left home'}`, data: { person: personId, home }, cause: { kind: 'presence', id: personId, label: source ?? p.detail } });
    if (home) {
      for (const t of this.cfg.lightTheWay.triggers.filter(x => 'arrival' in x.on)) await this.lightTheWay({ ...t, label: `${p.name} came home` });
      const o = this.overlay && this.cfg.overlays.find(x => x.id === this.overlay!.id);
      if (o?.ends.kind === 'arrival') await this.endOverlay('arrival');
      if (!wasAnyone && this.pendingEntry === this.modeId) {
        const m = this.mode();
        this.pendingEntry = null;
        this.store.set('pendingEntry', null);
        const cause: Cause = { kind: 'mode', id: m.id, label: `${m.name} started`, detail: `${p.name} came home` };
        const changed = await this.applyUnderOverlay(m.targets, cause);
        this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${m.name} lights on · ${p.name} came home`, data: { modeId: m.id, changed }, cause });
      }
    }
    this.emit('changed');
  }

  // --------------------------------------------------------------- undo --

  registerUndo(fn: Undo): string {
    const id = randomUUID();
    this.undos.set(id, { fn, at: this.now() });
    return id;
  }

  async undo(id: string): Promise<boolean> {
    const u = this.undos.get(id);
    if (!u) return false;
    this.undos.delete(id);
    await u.fn();
    this.emit('changed');
    return true;
  }

  private pruneUndos(t: number): void {
    for (const [id, u] of this.undos) if (t - u.at > 15 * 60_000) this.undos.delete(id);
  }

  // ---------------------------------------------------- why and preview --

  /** What set this device's state, and what will change it next. */
  why(deviceId: string): { now: string; next: string } {
    const d = this.reg.get(deviceId);
    if (!d) return { now: '', next: '' };
    const last = this.store.lastStateChange(deviceId);
    let now = 'No change recorded yet. It’s where Kova found it.';
    if (last) {
      const at = clock(last.ts, this.tz);
      const c = last.cause;
      now = c.kind === 'user' ? `You changed this at ${at}.`
        : c.kind === 'device' ? `Changed at the device or in another app at ${at}.`
        : c.kind === 'undo' ? `Put back by an undo at ${at}.`
        : `${c.label} set this at ${at}${c.detail ? ` (${c.detail})` : ''}.`;
    }
    const w = this.way.get(deviceId);
    if (w?.restore) return { now, next: `${clock(w.until, this.tz)} · Light the way turns this off.` };
    const t = this.now();
    const next = this.planner.itemsBetween(t, t + 36 * 3600_000).find(i => !this.skips.has(i.id) && i.targets[deviceId]);
    return { now, next: next ? `${clock(next.at, this.tz)} · ${next.label}: ${targetLabel(d, next.targets[deviceId])}.` : 'Nothing scheduled.' };
  }

  /** What every device will look like at instant `t`, according to today's plan. */
  preview(t: number): Record<string, DeviceState> {
    const out: Record<string, DeviceState> = {};
    for (const d of this.reg.list()) out[d.id] = { ...d.state };
    const kd = this.planner.kovaDayAt(t);
    const from = Math.min(kd.start, this.now());
    for (const item of this.planner.itemsBetween(from - 1, t)) {
      if (this.skips.has(item.id)) continue;
      for (const [id, c] of Object.entries(item.targets)) if (out[id]) out[id] = { ...out[id], ...c };
    }
    return out;
  }

  /** Which modes, moments, overlays and behaviours use a device. */
  usedIn(deviceId: string): { kind: string; id: string; name: string }[] {
    const c = this.cfg;
    return [
      ...c.modes.filter(m => m.targets[deviceId]).map(m => ({ kind: 'mode', id: m.id, name: `${m.name} mode` })),
      ...c.moments.filter(m => m.targets[deviceId]).map(m => ({ kind: 'moment', id: m.id, name: m.label })),
      ...c.overlays.filter(o => o.targets[deviceId]).map(o => ({ kind: 'overlay', id: o.id, name: o.name })),
      ...c.lightTheWay.triggers.filter(t => t.lights.includes(deviceId) || ('device' in t.on && t.on.device === deviceId)).map(t => ({ kind: 'behaviour', id: t.id, name: `Light the way · ${t.label}` })),
      ...(c.automations ?? []).filter(a => a.when.device === deviceId || a.then[deviceId] || a.if.some(x => x.device === deviceId)).map(a => ({ kind: 'automation', id: a.id, name: a.name })),
    ];
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

const BECAME: Record<string, string> = { on: 'switched on', off: 'switched off', offline: 'went offline', online: 'came back online' };

/** What a change made a device become: switched on or off, gone offline or back. A device first heard from isn't "back". */
export function becameOf(e: { prev: DeviceState; patch: Command }): ('on' | 'off' | 'offline' | 'online')[] {
  const out: ('on' | 'off' | 'offline' | 'online')[] = [];
  if (e.patch.on === true && e.prev.on !== true) out.push('on');
  if (e.patch.on === false && e.prev.on === true) out.push('off');
  if (e.patch.online === false && e.prev.online !== false) out.push('offline');
  if (e.patch.online === true && e.prev.online === false) out.push('online');
  return out;
}

/** Is a device like this now? Unknown on/off counts as off; unknown online counts as online. */
export function holds(s: DeviceState, is: Automation['if'][number]['is']): boolean {
  if (is.on !== undefined && !!s.on !== is.on) return false;
  if (is.online !== undefined && (s.online !== false) !== is.online) return false;
  if (is.input !== undefined && s.input !== is.input) return false;
  if (is.hvac !== undefined && s.hvac !== is.hvac) return false;
  return true;
}

function pick(s: DeviceState, keys: string[]): Command {
  const out: Command = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = (s as Record<string, unknown>)[k] ?? (k === 'on' ? false : null);
  return out;
}

export type { Device };
