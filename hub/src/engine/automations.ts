import { randomUUID } from 'node:crypto';
import type { Action, Automation, AutomationRun, Cause, Condition, DeviceState, HomeConfig, NumericField, StateMatch, Targets, Trigger } from '../model/types.ts';
import type { ChangeEvent, DeviceEvent, Registry } from '../devices/registry.ts';
import type { Store } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { Notification } from '../services/notify.ts';
import type { RoomEvent } from './rooms.ts';
import { ACTIVE_MIN } from './rooms.ts';
import { resolveRhythm } from '../rhythms/rhythms.ts';
import { localDate, localHour } from '../util/time.ts';
import { pseudoLabel } from '../util/describe.ts';

// Automations: when (any trigger), if (all conditions), then (actions in order), with a run mode for when one
// starts while still running, and a step-by-step history of each run.
//
// Time comes from the engine's clock: delays, "for 5 minutes" and wait timeouts are due on a tick, so tests
// can move time on exactly, and a real hub (ticking every second) gets one-second resolution.

/** What the automations need from the engine. */
export interface EngineView {
  modeId: string;
  overlayId(): string | null;
  people(): Record<string, { home: boolean }>;
  startOverlay(id: string, by: Cause): Promise<unknown>;
  endOverlay(): Promise<void>;
  emitChanged(): void;
  /** A room had activity (a person, motion, a door) in the last so many minutes, or a motion sensor there says so now. */
  roomActive?(room: string, withinMin?: number): boolean;
}

// ------------------------------------------------------------------ matching --

const num = (s: DeviceState, f: NumericField): number | null => {
  const v = (s as Record<string, unknown>)[f];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Does a device's state match? Unknown on/off counts as off; unknown online counts as online. */
export function matches(s: DeviceState, m: StateMatch): boolean {
  if (m.on !== undefined && !!s.on !== m.on) return false;
  if (m.online !== undefined && (s.online !== false) !== m.online) return false;
  if (m.input !== undefined && s.input !== m.input) return false;
  if (m.hvac !== undefined && s.hvac !== m.hvac) return false;
  if (m.activity !== undefined && s.activity !== m.activity) return false;
  if (m.playing !== undefined && (!!s.on && !s.paused && s.media !== null) !== m.playing) return false;
  if (m.muted !== undefined && !!s.muted !== m.muted) return false;
  if (m.mode !== undefined && s.mode !== m.mode) return false;
  if (m.motion !== undefined && !!s.motion !== m.motion) return false;
  if (m.open !== undefined && !!s.open !== m.open) return false;
  return true;
}

/** Is a reading in range (above and/or below; both given means between)? Null when there's no reading. */
export function inRange(v: number | null, above?: number, below?: number): boolean {
  if (v == null) return false;
  if (above != null && !(v > above)) return false;
  if (below != null && !(v < below)) return false;
  return true;
}

const dayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export interface CondCtx {
  reg: Registry;
  cfg: HomeConfig;
  now: number;
  engine: EngineView;
}

/** Does a condition hold now? `why` gets the first one that didn't, in words, for the run history. */
export function holds(c: Condition, x: CondCtx, why: string[] = []): boolean {
  const ok = (b: boolean, text: () => string) => { if (!b) why.push(text()); return b; };
  const name = (id: string) => x.reg.get(id)?.name ?? id;
  switch (c.kind) {
    case 'device': {
      const d = x.reg.get(c.device);
      return ok(!!d && matches(d.state, c.is), () => `${name(c.device)} isn’t ${matchText(c.is)}`);
    }
    case 'numeric': {
      const d = x.reg.get(c.device);
      return ok(!!d && inRange(num(d.state, c.field), c.above, c.below), () => `${name(c.device)} ${FIELD[c.field]} isn’t ${rangeText(c.above, c.below)}`);
    }
    case 'time': {
      const date = localDate(x.now, x.cfg.timezone);
      if (c.days?.length && !c.days.includes(dayOf(date))) return ok(false, () => 'not one of its days');
      if (!c.after && !c.before) return true;
      const a = c.after ? resolveRhythm(c.after, date, x.cfg) : null, b = c.before ? resolveRhythm(c.before, date, x.cfg) : null;
      let inside: boolean;
      if (a != null && b != null) inside = a <= b ? x.now >= a && x.now < b : x.now >= a || x.now < b; // crossing midnight
      else if (a != null) inside = x.now >= a;
      else inside = b != null && x.now < b;
      return ok(inside, () => 'outside its times');
    }
    case 'presence': {
      const ppl = x.engine.people();
      const any = Object.values(ppl).some(p => p.home);
      if (c.who === 'anyone') return ok(any === c.home, () => c.home ? 'nobody’s home' : 'someone’s home');
      if (c.who === 'no-one') return ok(!any === c.home, () => c.home ? 'someone’s home' : 'nobody’s home');
      const p = x.cfg.people.find(q => q.id === c.who);
      return ok(!!ppl[c.who]?.home === c.home, () => `${p?.name ?? c.who} is ${c.home ? 'out' : 'home'}`);
    }
    case 'mode': return ok(c.modes.includes(x.engine.modeId), () => `not in ${c.modes.map(m => x.cfg.modes.find(y => y.id === m)?.name ?? m).join(' or ')}`);
    case 'overlay': {
      const cur = x.engine.overlayId();
      const on = c.overlay ? cur === c.overlay : cur != null;
      return ok(on === c.active, () => `${c.overlay ? x.cfg.overlays.find(o => o.id === c.overlay)?.name ?? c.overlay : 'an overlay'} is ${c.active ? 'off' : 'on'}`);
    }
    case 'room': {
      const within = c.withinMin ?? ACTIVE_MIN;
      const on = x.engine.roomActive?.(c.room, within) ?? false;
      const rn = x.cfg.rooms.find(r => r.id === c.room)?.name ?? c.room;
      return ok(on === c.active, () => c.active ? `no activity in ${rn} in the last ${within} min` : `there was activity in ${rn} in the last ${within} min`);
    }
    case 'all': return c.conditions.every(k => holds(k, x, why));
    case 'any': { const w: string[] = []; return ok(c.conditions.some(k => holds(k, x, w)), () => `none of: ${w.join('; ')}`); }
    case 'not': return ok(!c.conditions.every(k => holds(k, x, [])), () => 'the “not” held');
  }
}

// ------------------------------------------------------------------ words --

const FIELD: Record<NumericField, string> = { temp: 'temperature', target: 'set temperature', power: 'power', energy: 'energy today', battery: 'battery', bri: 'brightness', vol: 'volume', grid: 'grid power', load: 'home power', humidity: 'humidity', lux: 'light level', pm25: 'PM2.5' };
const INPUTS: Record<string, string> = { tv: 'TV', hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };
export function matchText(m: StateMatch): string {
  const parts = [
    m.input ? `on ${INPUTS[m.input] ?? m.input}` : m.on !== undefined ? (m.on ? 'on' : 'off') : '',
    m.online !== undefined ? (m.online ? 'online' : 'offline') : '',
    m.playing !== undefined ? (m.playing ? 'playing' : 'not playing') : '',
    m.hvac ? `on ${m.hvac}` : '', m.activity ? m.activity : '', m.muted !== undefined ? (m.muted ? 'muted' : 'not muted') : '', m.mode ? `on ${m.mode}` : '',
    m.motion !== undefined ? (m.motion ? 'detecting motion' : 'clear of motion') : '', m.open !== undefined ? (m.open ? 'open' : 'closed') : '',
  ].filter(Boolean);
  return parts.join(' and ') || 'anything';
}
export const rangeText = (above?: number, below?: number) => above != null && below != null ? `between ${above} and ${below}` : above != null ? `above ${above}` : `below ${below}`;

// ------------------------------------------------------------------ upgrade --

/** Automations saved by hub 0.7.6 (one "when", a list of "if"s, one set of targets) as today's shape. */
export function upgradeAutomation(raw: Record<string, unknown>): Automation {
  if (Array.isArray(raw.triggers)) {
    return { mode: 'single', conditions: [], actions: [], ...raw, enabled: raw.enabled !== false } as unknown as Automation;
  }
  const when = raw.when as { device: string; becomes?: string; event?: string } | undefined;
  const BEC: Record<string, StateMatch> = { on: { on: true }, off: { on: false }, offline: { online: false }, online: { online: true } };
  const triggers: Trigger[] = !when ? [] : when.event ? [{ kind: 'event', device: when.device, event: when.event }] : [{ kind: 'device', device: when.device, to: BEC[when.becomes ?? 'on'] }];
  const conditions: Condition[] = ((raw.if as { device: string; is: StateMatch }[] | undefined) ?? []).map(c => ({ kind: 'device', device: c.device, is: c.is }));
  const targets = (raw.then ?? {}) as Record<string, never>;
  return {
    id: String(raw.id), name: String(raw.name ?? 'Automation'), enabled: raw.enabled !== false, mode: 'single',
    triggers, conditions, actions: Object.keys(targets).length ? [{ kind: 'set', targets }] : [],
  };
}

// ------------------------------------------------------------------- runner --

class Cancelled extends Error {}

interface Live { run: AutomationRun; cancelled: boolean; wake?: () => void }
interface Timer { at: number; fn: () => void }
interface Waiter { cond: Condition; resolve: (ok: boolean) => void; until: number | null; live: Live }

const RUNS_KEPT = 30;
/** More starts than this in a minute is a loop: the automation is paused and says so. */
const LOOP_LIMIT = 30;

export class Automations {
  /** Push notifications; set once the notifier is up. */
  notify: ((n: Notification) => Promise<unknown>) | null = null;
  private timers: Timer[] = [];
  private waiters: Waiter[] = [];
  private live = new Map<string, Live[]>();
  private queues = new Map<string, Promise<void>>();
  /** "For 5 minutes" triggers armed: key → when it's due. */
  private armed = new Map<string, Timer>();
  private starts = new Map<string, number[]>();
  private runs: Record<string, AutomationRun[]>;
  private lastTick: number;

  constructor(private reg: Registry, private config: ConfigStore, private store: Store, private engine: EngineView, private now: () => number) {
    this.runs = store.get<Record<string, AutomationRun[]>>('automation-runs') ?? {};
    // Runs cut short by a restart were interrupted.
    for (const list of Object.values(this.runs)) for (const r of list) if (r.result === 'running') { r.result = 'cancelled'; r.detail = 'the hub restarted'; }
    this.lastTick = now();
    // Saved by hub 0.7.6 (one "when", "if"s, one set of targets): rewritten once in today's shape.
    if ((config.get().automations ?? []).some(x => !Array.isArray((x as Partial<Automation>).triggers))) {
      config.update(c => { c.automations = (c.automations ?? []).map(x => upgradeAutomation(x as unknown as Record<string, unknown>)); });
    }
    reg.on('change', e => this.onChange(e));
    reg.on('reading', e => this.onChange(e));
    reg.on('event', e => this.onEvent(e));
  }

  list(): Automation[] { return (this.config.get().automations ?? []).map(a => upgradeAutomation(a as unknown as Record<string, unknown>)); }
  private enabled(): Automation[] { return this.list().filter(a => a.enabled); }
  history(id: string): AutomationRun[] { return this.runs[id] ?? []; }
  lastRun(id: string): AutomationRun | undefined { return this.runs[id]?.[0]; }
  running(id: string): number { return this.live.get(id)?.length ?? 0; }

  private ctx(): CondCtx { return { reg: this.reg, cfg: this.config.get(), now: this.now(), engine: this.engine }; }

  // --------------------------------------------------------------- triggers --

  /** The hub started: "hub start" triggers. */
  hubStarted(): void { for (const a of this.enabled()) if (a.triggers.some(t => t.kind === 'hub')) void this.start(a, 'Kova started'); }

  /** The clock moved on: due timers, time and "every" triggers. */
  async tick(t = this.now()): Promise<void> {
    const from = this.lastTick;
    if (t <= from) return;
    this.lastTick = t;
    const due = this.timers.filter(x => x.at <= t).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter(x => x.at > t);
    for (const x of due) x.fn();
    for (const [k, x] of [...this.armed]) if (x.at <= t) { this.armed.delete(k); x.fn(); }
    for (const w of [...this.waiters]) if (w.until != null && w.until <= t) this.endWait(w, false);
    const cfg = this.config.get();
    for (const a of this.enabled()) {
      for (const tr of a.triggers) {
        if (tr.kind === 'time') {
          for (const date of new Set([localDate(from, cfg.timezone), localDate(t, cfg.timezone)])) {
            const at = resolveRhythm(tr.at, date, cfg);
            if (at != null && at > from && at <= t && (!tr.days?.length || tr.days.includes(dayOf(date)))) void this.start(a, `It’s ${timeWords(tr)}`);
          }
        } else if (tr.kind === 'every' && tr.minutes > 0) {
          const slot = (ms: number) => `${localDate(ms, cfg.timezone)}:${Math.floor((localHour(ms, cfg.timezone) * 60 + 1e-6) / tr.minutes)}`;
          if (slot(from) !== slot(t)) void this.start(a, `Every ${tr.minutes} min`);
        }
      }
    }
  }

  private onChange(e: ChangeEvent): void {
    const d = e.device;
    const next = d.state, prev: DeviceState = { ...next, ...e.prev };
    for (const a of this.enabled()) {
      // Never started by its own doing (a loop).
      if (e.cause.kind === 'automation' && e.cause.id === a.id) continue;
      a.triggers.forEach((tr, i) => {
        const key = `${a.id}:${i}`;
        if (tr.kind === 'device' && tr.device === d.id) {
          const wasTo = tr.to ? matches(prev, tr.to) : false, isTo = tr.to ? matches(next, tr.to) : true;
          const fromOk = tr.from ? matches(prev, tr.from) : true;
          const leftFrom = tr.from && !tr.to ? !matches(next, tr.from) : true;
          const fired = tr.to ? isTo && !wasTo && fromOk : fromOk && leftFrom && prev !== next;
          const why = `${d.name} ${tr.to ? `turned ${matchText(tr.to)}` : `stopped being ${matchText(tr.from!)}`}`;
          this.fireOrArm(a, key, fired, tr.forSec, () => !!this.reg.get(d.id) && (tr.to ? matches(this.reg.get(d.id)!.state, tr.to) : !matches(this.reg.get(d.id)!.state, tr.from!)), why);
          if (tr.forSec && !isTo && tr.to) this.armed.delete(key);
        }
        if (tr.kind === 'numeric' && tr.device === d.id && tr.field in e.patch) {
          const was = inRange(num(prev, tr.field), tr.above, tr.below), is = inRange(num(next, tr.field), tr.above, tr.below);
          const why = `${d.name} ${FIELD[tr.field]} went ${rangeText(tr.above, tr.below)} (${num(next, tr.field)})`;
          this.fireOrArm(a, key, is && !was, tr.forSec, () => inRange(num(this.reg.get(d.id)?.state ?? {}, tr.field), tr.above, tr.below), why);
          if (!is) this.armed.delete(key);
        }
      });
    }
    this.checkWaiters();
  }

  /** Start now, or (with "for") once it has stayed so that long. */
  private fireOrArm(a: Automation, key: string, fired: boolean, forSec: number | undefined, still: () => boolean, why: string): void {
    if (!fired) return;
    if (!forSec) { void this.start(a, why); return; }
    const mins = forSec >= 60 ? `${Math.round(forSec / 60)} min` : `${forSec} s`;
    this.armed.set(key, { at: this.now() + forSec * 1000, fn: () => { if (still()) void this.start(a, `${why}, for ${mins}`); } });
  }

  private onEvent(e: DeviceEvent): void {
    for (const a of this.enabled()) {
      if (a.triggers.some(t => t.kind === 'event' && t.device === e.device.id && t.event === e.type)) void this.start(a, `${e.device.name}: ${EVENT_WORDS[e.type] ?? e.type}`);
    }
  }

  /** When each room trigger last fired: motion sensors and cameras repeat themselves within seconds. */
  private roomFired = new Map<string, number>();

  /** Something happened in a room (engine/rooms.ts): "motion in the lounge", "a person at the front door". */
  roomEvent(ev: RoomEvent): void {
    const t = this.now();
    const room = this.config.get().rooms.find(r => r.id === ev.room)?.name ?? ev.room;
    for (const a of this.enabled()) {
      a.triggers.forEach((tr, i) => {
        if (tr.kind !== 'room' || tr.room !== ev.room) return;
        // "Motion" is anything moving: a motion sensor, a camera's motion, or a person it saw.
        const hit = tr.event === ev.kind || (tr.event === 'motion' && ev.kind === 'person');
        if (!hit) return;
        const key = `${a.id}:${i}`;
        if (t - (this.roomFired.get(key) ?? -Infinity) < ROOM_REFIRE_MS) return;
        this.roomFired.set(key, t);
        void this.start(a, `${cap(ROOM_EVENT_TEXT[ev.kind])} in ${room}`);
      });
    }
    this.checkWaiters();
  }

  /** Someone arrived or left. `anyBefore` is whether anyone was home before it. */
  presence(personId: string, home: boolean, anyBefore: boolean, anyAfter: boolean): void {
    const p = this.config.get().people.find(x => x.id === personId)?.name ?? personId;
    for (const a of this.enabled()) {
      for (const t of a.triggers) {
        if (t.kind !== 'presence') continue;
        const hit = t.event === 'arrives' ? home && (!t.person || t.person === personId)
          : t.event === 'leaves' ? !home && (!t.person || t.person === personId)
          : t.event === 'first-arrives' ? home && !anyBefore
          : !home && anyBefore && !anyAfter;
        if (hit) { void this.start(a, home ? `${p} came home` : t.event === 'last-leaves' ? `${p} left, the last one out` : `${p} left`); break; }
      }
    }
    this.checkWaiters();
  }

  modeStarted(modeId: string): void {
    const m = this.config.get().modes.find(x => x.id === modeId)?.name ?? modeId;
    for (const a of this.enabled()) if (a.triggers.some(t => t.kind === 'mode' && t.mode === modeId)) void this.start(a, `${m} started`);
    this.checkWaiters();
  }

  overlayChanged(id: string, event: 'starts' | 'ends'): void {
    const o = this.config.get().overlays.find(x => x.id === id)?.name ?? id;
    for (const a of this.enabled()) if (a.triggers.some(t => t.kind === 'overlay' && t.overlay === id && t.event === event)) void this.start(a, `${o} ${event === 'starts' ? 'started' : 'ended'}`);
    this.checkWaiters();
  }

  // ------------------------------------------------------------------- runs --

  /** Started by a trigger: check its conditions, then run as its mode says. */
  async start(a: Automation, why: string): Promise<AutomationRun | null> {
    const t = this.now();
    const recent = (this.starts.get(a.id) ?? []).filter(x => x > t - 60_000);
    recent.push(t);
    this.starts.set(a.id, recent);
    if (recent.length > LOOP_LIMIT) {
      this.config.update(c => { const x = c.automations?.find(y => y.id === a.id); if (x) x.enabled = false; });
      this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${a.name} switched off: it started ${recent.length} times in a minute`, data: { automation: a.id }, cause: { kind: 'automation', id: a.id, label: a.name, detail: 'kept starting itself' } });
      return null;
    }
    const why2: string[] = [];
    if (!a.conditions.every(c => holds(c, this.ctx(), why2))) {
      this.record({ id: randomUUID(), automation: a.id, at: t, why, result: 'skipped', detail: why2[0], steps: [], endedAt: t });
      return null;
    }
    return this.runNow(a, why);
  }

  /** Run its actions now (Run now, or "run another automation"): conditions are the caller's business. */
  async runNow(a: Automation, why: string, depth = 0): Promise<AutomationRun | null> {
    const busy = this.live.get(a.id) ?? [];
    if (busy.length && a.mode === 'single') return null;
    if (busy.length && a.mode === 'restart') for (const l of busy) this.cancel(l);
    const go = async (): Promise<AutomationRun> => {
      const run: AutomationRun = { id: randomUUID(), automation: a.id, at: this.now(), why, result: 'running', steps: [] };
      const live: Live = { run, cancelled: false };
      this.live.set(a.id, [...(this.live.get(a.id) ?? []), live]);
      this.record(run);
      try {
        const r = await this.actions(a, a.actions, live, depth);
        run.result = r === 'stop' ? 'stopped' : 'done';
      } catch (e) {
        if (e instanceof Cancelled) { run.result = 'cancelled'; run.detail ??= 'started again'; }
        else { run.result = 'failed'; run.detail = (e as Error).message; }
      } finally {
        run.endedAt = this.now();
        this.live.set(a.id, (this.live.get(a.id) ?? []).filter(l => l !== live));
        this.save();
        this.engine.emitChanged();
      }
      return run;
    };
    if (a.mode === 'queued' && busy.length) {
      const prev = this.queues.get(a.id) ?? Promise.resolve();
      let out!: AutomationRun;
      const p = prev.then(async () => { out = await go(); });
      this.queues.set(a.id, p.catch(() => {}));
      await p;
      return out;
    }
    const p = go();
    if (a.mode === 'queued') this.queues.set(a.id, p.then(() => {}, () => {}));
    return p;
  }

  private cancel(l: Live): void {
    l.cancelled = true;
    l.wake?.();
    for (const w of this.waiters.filter(x => x.live === l)) this.endWait(w, false);
  }

  private async actions(a: Automation, list: Action[], live: Live, depth: number): Promise<'stop' | void> {
    const cause: Cause = { kind: 'automation', id: a.id, label: a.name, detail: live.run.why };
    const step = (text: string, ok = true, detail?: string) => { live.run.steps.push({ at: this.now(), text, ok, detail }); this.save(); };
    for (const x of list) {
      if (live.cancelled) throw new Cancelled();
      switch (x.kind) {
        case 'set': {
          const { changed } = await this.reg.applyTargets(x.targets, cause);
          const names = Object.keys(x.targets).map(id => pseudoLabel(id, this.config.get().rooms) ?? this.reg.get(id)?.name ?? id);
          step(`Set ${names.join(', ')}`, true, changed.length ? `${changed.length} changed` : 'already so');
          if (changed.length) this.store.append({ kind: 'run', device: null, feed: 'auto', what: `${a.name}: ${changed.map(id => this.reg.get(id)?.name ?? id).join(', ')} · ${live.run.why}`, data: { automation: a.id, changed }, cause });
          break;
        }
        case 'delay': {
          step(`Wait ${durWords(x.seconds)}`);
          await this.sleep(x.seconds * 1000, live);
          break;
        }
        case 'wait': {
          const ok = await this.waitFor(x.until, x.timeoutSec, live);
          step(`Wait until ${condWords(x.until, this.ctx())}`, ok || !x.stopOnTimeout, ok ? 'it happened' : `not after ${durWords(x.timeoutSec ?? 0)}`);
          if (!ok && x.stopOnTimeout) return 'stop';
          break;
        }
        case 'notify': {
          if (!this.notify) { step('Notify', false, 'notifications aren’t set up'); break; }
          await this.notify({ title: x.title || a.name, body: x.message, people: x.people?.length ? x.people : undefined, tag: `automation-${a.id}` })
            .then(() => step(`Notify: “${x.message}”`), (e: Error) => step(`Notify: “${x.message}”`, false, e.message));
          break;
        }
        case 'overlay': {
          const name = this.config.get().overlays.find(o => o.id === x.overlay)?.name ?? x.overlay;
          if (x.op === 'start') await this.engine.startOverlay(x.overlay, cause);
          else if (this.engine.overlayId() === x.overlay) await this.engine.endOverlay();
          step(`${x.op === 'start' ? 'Start' : 'End'} ${name}`);
          break;
        }
        case 'if': {
          const why: string[] = [];
          const yes = x.conditions.every(c => holds(c, this.ctx(), why));
          step(`If ${x.conditions.map(c => condWords(c, this.ctx())).join(' and ')}`, true, yes ? 'yes' : `no: ${why[0]}`);
          const r = await this.actions(a, yes ? x.then : x.else ?? [], live, depth);
          if (r === 'stop') return r;
          break;
        }
        case 'ramp': {
          const first = this.reg.get(Object.keys(this.reg.expandTargets(x.targets))[0] ?? '');
          const start = x.from ?? (first ? num(first.state, x.field) : null) ?? 0;
          const stepSec = Math.max(5, x.stepSec ?? 60);
          const n = Math.max(1, Math.ceil(x.overSec / stepSec));
          step(`Ramp ${FIELD[x.field]} to ${x.to} over ${durWords(x.overSec)}`);
          for (let i = 1; i <= n; i++) {
            const v = Math.round(start + (x.to - start) * (i / n));
            const t: Targets = {};
            for (const [id, cmd] of Object.entries(x.targets)) t[id] = { ...cmd, [x.field]: v };
            await this.reg.applyTargets(t, cause);
            if (i < n) await this.sleep(stepSec * 1000, live);
          }
          break;
        }
        case 'repeat': {
          for (let i = 0; i < Math.min(x.times, 100); i++) {
            const r = await this.actions(a, x.actions, live, depth);
            if (r === 'stop') return r;
          }
          step(`Repeated ${x.times} times`);
          break;
        }
        case 'run': {
          const other = this.list().find(o => o.id === x.automation);
          if (!other || depth >= 5) { step(`Run ${other?.name ?? x.automation}`, false, other ? 'too many automations running each other' : 'it no longer exists'); break; }
          step(`Run ${other.name}`);
          await this.runNow(other, `${a.name} ran it`, depth + 1);
          break;
        }
        case 'stop': step('Stop'); return 'stop';
      }
    }
  }

  private sleep(ms: number, live: Live): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer: Timer = { at: this.now() + ms, fn: () => { live.wake = undefined; resolve(); } };
      this.timers.push(timer);
      live.wake = () => { this.timers = this.timers.filter(x => x !== timer); reject(new Cancelled()); };
    });
  }

  private waitFor(cond: Condition, timeoutSec: number | undefined, live: Live): Promise<boolean> {
    if (holds(cond, this.ctx())) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const w: Waiter = { cond, live, until: timeoutSec ? this.now() + timeoutSec * 1000 : null, resolve: ok => (live.cancelled ? reject(new Cancelled()) : resolve(ok)) };
      this.waiters.push(w);
    });
  }

  private endWait(w: Waiter, ok: boolean): void { this.waiters = this.waiters.filter(x => x !== w); w.resolve(ok); }

  private checkWaiters(): void {
    if (!this.waiters.length) return;
    const x = this.ctx();
    for (const w of [...this.waiters]) if (holds(w.cond, x)) this.endWait(w, true);
  }

  private record(run: AutomationRun): void {
    const list = this.runs[run.automation] ?? [];
    if (!list.includes(run)) list.unshift(run);
    this.runs[run.automation] = list.slice(0, RUNS_KEPT);
    this.save();
  }

  private saveTimer: NodeJS.Timeout | null = null;
  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.store.set('automation-runs', this.runs); }, 50);
    this.saveTimer.unref?.();
  }

  /** Forget the history of automations that are gone. */
  prune(): void {
    const ids = new Set(this.list().map(a => a.id));
    for (const k of Object.keys(this.runs)) if (!ids.has(k)) delete this.runs[k];
    this.save();
  }

  stop(): void {
    for (const lives of this.live.values()) for (const l of lives) this.cancel(l);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.store.set('automation-runs', this.runs);
  }
}

// ------------------------------------------------------------------ words --

/** A room trigger won't start the same automation again this soon (a motion sensor repeats itself). */
const ROOM_REFIRE_MS = 30_000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A room event in words, for "… in the Lounge". */
export const ROOM_EVENT_TEXT: Record<string, string> = {
  person: 'a person', motion: 'motion', ring: 'the doorbell', vehicle: 'a vehicle', animal: 'an animal', package: 'a package', sound: 'a sound', opened: 'a door or window opened', closed: 'a door or window closed',
};

export const EVENT_WORDS: Record<string, string> = {
  person: 'saw a person', ring: 'rang', motion: 'detected motion', vehicle: 'saw a vehicle', animal: 'saw an animal', package: 'saw a package', sound: 'heard a sound', 'video-started': 'started a video', 'music-started': 'started music',
  paused: 'paused', resumed: 'carried on', stopped: 'stopped', 'internet-down': 'internet down', 'internet-up': 'internet back', 'new-device': 'new device joined',
};

export const durWords = (s: number) => s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const daysWords = (days?: number[]) => !days?.length || days.length === 7 ? '' : days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d)) ? 'on weekdays' : days.length === 2 && days.includes(0) && days.includes(6) ? 'at weekends' : `on ${[...days].sort().map(d => DAYS[d]).join(', ')}`;

const rhythmWords = (r: import('../model/types.ts').Rhythm): string => {
  if (r.kind === 'time') return r.at;
  const off = r.offsetMin ? `${Math.abs(r.offsetMin)} min ${r.offsetMin < 0 ? 'before' : 'after'} ` : '';
  return off + (r.kind === 'sun' ? r.event : r.prayer.charAt(0).toUpperCase() + r.prayer.slice(1));
};
export const timeWords = (t: Extract<Trigger, { kind: 'time' }>) => [rhythmWords(t.at), daysWords(t.days)].filter(Boolean).join(' ');

/** A trigger in words: "Lounge box turns offline for 2 min". */
export function triggerWords(t: Trigger, x: Pick<CondCtx, 'reg' | 'cfg'>): string {
  const n = (id: string) => x.reg.get(id)?.name ?? id;
  const forW = (s?: number) => s ? ` for ${durWords(s)}` : '';
  switch (t.kind) {
    case 'device': return `${n(t.device)} ${t.to ? `turns ${matchText(t.to)}` : `stops being ${matchText(t.from ?? {})}`}${t.to && t.from ? ` from ${matchText(t.from)}` : ''}${forW(t.forSec)}`;
    case 'numeric': return `${n(t.device)} ${FIELD[t.field]} goes ${rangeText(t.above, t.below)}${forW(t.forSec)}`;
    case 'event': return `${n(t.device)} ${EVENT_WORDS[t.event] ?? t.event}`;
    case 'room': return `${cap(ROOM_EVENT_TEXT[t.event] ?? t.event)} in ${x.cfg.rooms.find(r => r.id === t.room)?.name ?? t.room}`;
    case 'time': return `At ${timeWords(t)}`;
    case 'every': return `Every ${durWords(t.minutes * 60)}`;
    case 'presence': {
      const p = t.person ? x.cfg.people.find(q => q.id === t.person)?.name ?? t.person : 'Someone';
      return t.event === 'arrives' ? `${p} comes home` : t.event === 'leaves' ? `${p} leaves` : t.event === 'first-arrives' ? 'The first person comes home' : 'The last person leaves';
    }
    case 'mode': return `${x.cfg.modes.find(m => m.id === t.mode)?.name ?? t.mode} starts`;
    case 'overlay': return `${x.cfg.overlays.find(o => o.id === t.overlay)?.name ?? t.overlay} ${t.event === 'starts' ? 'starts' : 'ends'}`;
    case 'hub': return 'Kova starts';
  }
}

/** A condition in words. */
export function condWords(c: Condition, x: Pick<CondCtx, 'reg' | 'cfg'>): string {
  const n = (id: string) => x.reg.get(id)?.name ?? id;
  switch (c.kind) {
    case 'device': return `${n(c.device)} is ${matchText(c.is)}`;
    case 'numeric': return `${n(c.device)} ${FIELD[c.field]} is ${rangeText(c.above, c.below)}`;
    case 'time': return [c.after && c.before ? `between ${rhythmWords(c.after)} and ${rhythmWords(c.before)}` : c.after ? `after ${rhythmWords(c.after)}` : c.before ? `before ${rhythmWords(c.before)}` : '', daysWords(c.days)].filter(Boolean).join(' ') || 'any time';
    case 'presence': return c.who === 'anyone' ? (c.home ? 'someone’s home' : 'nobody’s home') : c.who === 'no-one' ? (c.home ? 'nobody’s home' : 'someone’s home') : `${x.cfg.people.find(p => p.id === c.who)?.name ?? c.who} is ${c.home ? 'home' : 'out'}`;
    case 'mode': return `in ${c.modes.map(m => x.cfg.modes.find(y => y.id === m)?.name ?? m).join(' or ')}`;
    case 'overlay': return `${c.overlay ? x.cfg.overlays.find(o => o.id === c.overlay)?.name ?? c.overlay : 'an overlay'} is ${c.active ? 'on' : 'off'}`;
    case 'room': {
      const rn = x.cfg.rooms.find(r => r.id === c.room)?.name ?? c.room, m = c.withinMin ?? ACTIVE_MIN;
      return c.active ? `there’s been activity in ${rn} in the last ${m} min` : `no activity in ${rn} for ${m} min`;
    }
    case 'all': return c.conditions.map(k => condWords(k, x)).join(' and ');
    case 'any': return c.conditions.map(k => condWords(k, x)).join(' or ');
    case 'not': return `not (${c.conditions.map(k => condWords(k, x)).join(' and ')})`;
  }
}

/** An action in words, one line (nested steps summarised). */
export function actionWords(a: Action, x: Pick<CondCtx, 'reg' | 'cfg'>, targetText: (id: string, cmd: object) => string): string {
  switch (a.kind) {
    case 'set': return Object.entries(a.targets).map(([id, cmd]) => targetText(id, cmd)).join(', ');
    case 'delay': return `Wait ${durWords(a.seconds)}`;
    case 'wait': return `Wait until ${condWords(a.until, x)}${a.timeoutSec ? ` (at most ${durWords(a.timeoutSec)})` : ''}`;
    case 'notify': return `Notify: “${a.message}”`;
    case 'overlay': return `${a.op === 'start' ? 'Start' : 'End'} ${x.cfg.overlays.find(o => o.id === a.overlay)?.name ?? a.overlay}`;
    case 'if': return `If ${a.conditions.map(c => condWords(c, x)).join(' and ')}: ${a.then.map(k => actionWords(k, x, targetText)).join('; ') || 'nothing'}${a.else?.length ? `; otherwise ${a.else.map(k => actionWords(k, x, targetText)).join('; ')}` : ''}`;
    case 'ramp': return `${FIELD[a.field]} ramps to ${a.to} over ${durWords(a.overSec)}: ${Object.keys(a.targets).map(id => pseudoLabel(id, x.cfg.rooms) ?? x.reg.get(id)?.name ?? id).join(', ')}`;
    case 'repeat': return `${a.times}×: ${a.actions.map(k => actionWords(k, x, targetText)).join('; ')}`;
    case 'run': return `Run ${x.cfg.automations?.find(o => o.id === a.automation)?.name ?? a.automation}`;
    case 'stop': return 'Stop';
  }
}

