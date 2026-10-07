import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hub } from '../hub.ts';
import type { DeviceEvent } from '../devices/registry.ts';
import type { Device, RoomEventKind, SecuritySettings } from '../model/types.ts';
import type { RoomEvent } from '../engine/rooms.ts';
import type { Notification } from './notify.ts';
import type { Snapshot } from '../adapters/sdk.ts';
import { alertWhen, isDoorbell } from '../util/sensors.ts';
import { clock, localHour } from '../util/time.ts';

// Smart camera and sensor alerts, and the frames kept for each camera event.
//
// Alerts: an event in a room alerts when its camera's (or room's, or Kova's default) choice says so — always, or
// only while nobody's home. Events from one room that arrive together (a camera's motion and person for the same
// moment) become one alert, the most telling. The same kind of alert from the same room waits out a cooldown, and a
// stronger one (the doorbell, a person) covers weaker ones after it. Quiet hours hold everything back except the
// doorbell and anything while nobody's home. Every decision is kept, so the app can say why an alert didn't come.
//
// Frames: when a camera reports an event, Kova asks its integration for the picture (Nest keeps only the latest, and
// only ~30 s) and keeps it with that event, so each camera's and room's timeline shows what was seen.

export interface SecurityOptions {
  /** Where event frames are kept (one folder per camera). Without it, the last few are kept in memory. */
  framesDir?: string;
  /** Events from one room this close together are one alert. Default 1500 ms. */
  settleMs?: number;
  /** Wait this long after an event before asking for its picture (Nest fetches its own image first). Default 3000 ms. */
  frameDelayMs?: number;
  /** Frames kept per camera, and for how many days. Defaults 60 and 14. */
  keepFrames?: number;
  keepDays?: number;
}

export interface Decision { at: number; room: string; device: string; kind: RoomEventKind; sent: boolean; why: string; title?: string }

/** Which alerts cover which: the doorbell covers a person at the same door, a person covers motion. */
const PRIORITY: RoomEventKind[] = ['ring', 'person', 'package', 'opened', 'vehicle', 'animal', 'motion', 'sound'];
const CLASS: Partial<Record<RoomEventKind, string>> = { ring: 'door', person: 'person', package: 'package', opened: 'contact', vehicle: 'vehicle', animal: 'animal', motion: 'motion', sound: 'sound' };
/** A doorbell pressed twice is one visitor. */
const RING_COOLDOWN_MS = 30_000;
const DEFAULT_COOLDOWN_MIN = 5;
const MEMORY_FRAMES = 40;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

/** "07:00" → hours since midnight; null when it isn't a time. */
const hhmm = (s: unknown): number | null => {
  const m = typeof s === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(s.trim()) : null;
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) + Number(m[2]) / 60 : null;
};

/** Is `hour` inside quiet hours from → to (which may cross midnight)? */
export function inQuiet(quiet: SecuritySettings['quiet'], hour: number): boolean {
  const a = hhmm(quiet?.from), b = hhmm(quiet?.to);
  if (a == null || b == null || a === b) return false;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}

/** Clean quiet hours from the API ({ from: "22:30", to: "07:00" } or null). */
export function cleanQuiet(v: unknown): SecuritySettings['quiet'] {
  if (v === null) return null;
  const q = v as { from?: unknown; to?: unknown };
  if (!q || typeof q !== 'object' || hhmm(q.from) == null || hhmm(q.to) == null) throw new Error('quiet is { from: "22:30", to: "07:00" } or null');
  if (q.from === q.to) throw new Error('Quiet hours need different start and end times');
  return { from: String(q.from).trim().padStart(5, '0'), to: String(q.to).trim().padStart(5, '0') };
}

export class Security {
  /** Phones; set once the notifier is up (main.ts). */
  notify: ((n: Notification) => Promise<unknown>) | null = null;
  private pending = new Map<string, { events: RoomEvent[]; timer: NodeJS.Timeout }>();
  /** When each room's alerts (by class) last went out. */
  private sentAt = new Map<string, number>();
  private decisions: Decision[] = [];
  /** The doorbell decision per device, for the notifier's own doorbell message. */
  private ring = new Map<string, Decision>();
  /** Saved frames per camera: event ids, oldest first. */
  private frames = new Map<string, number[]>();
  private memFrames = new Map<string, Snapshot>();
  private timers = new Set<NodeJS.Timeout>();
  private inflight = new Set<Promise<unknown>>();
  private off: (() => void) | null = null;

  constructor(private hub: Hub, private opts: SecurityOptions = {}) {
    if (opts.framesDir) this.scanFrames();
    hub.engine.rooms.frames = { has: (device, id) => this.hasFrame(device, id) };
  }

  private get cfg() { return this.hub.config.get(); }
  private get now() { return this.hub.engine.now(); }

  start(): void {
    const onActivity = (ev: RoomEvent) => this.onActivity(ev);
    this.hub.engine.rooms.on('activity', onActivity);
    this.off = () => this.hub.engine.rooms.off('activity', onActivity);
  }

  async stop(): Promise<void> {
    this.off?.();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.idle();
  }

  /** Resolves when alerts and frames started so far are done (tests). */
  async idle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.catch(err => console.warn('[security]', err)).finally(() => this.inflight.delete(p));
    return p;
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  // --------------------------------------------------------------- settings --

  /** The home's alert settings, filled in. */
  settings(): Required<Pick<SecuritySettings, 'cooldownMin'>> & { quiet: SecuritySettings['quiet']; rooms: NonNullable<SecuritySettings['rooms']> } {
    const s = this.cfg.security ?? {};
    return { quiet: s.quiet ?? null, cooldownMin: s.cooldownMin ?? DEFAULT_COOLDOWN_MIN, rooms: s.rooms ?? {} };
  }

  /** Now inside quiet hours? */
  quietNow(): boolean { return inQuiet(this.settings().quiet, localHour(this.now, this.cfg.timezone)); }

  /** The latest decisions, newest first. */
  recent(limit = 30): Decision[] { return this.decisions.slice(0, limit); }

  // ----------------------------------------------------------------- alerts --

  private onActivity(ev: RoomEvent): void {
    if (ev.kind === 'closed') return;
    if (ev.source === 'camera') this.grabFrame(ev);
    // The doorbell has its own message (notify.ts, with what Light the way did): decide it now, so the notifier can ask.
    if (ev.kind === 'ring') { const d = this.decide([ev]); if (d) this.ring.set(ev.device, d); return; }
    const p = this.pending.get(ev.room);
    if (p) { p.events.push(ev); return; }
    const timer = this.later(this.opts.settleMs ?? 1500, () => {
      const q = this.pending.get(ev.room);
      this.pending.delete(ev.room);
      if (q) { const d = this.decide(q.events); if (d?.sent) this.track(this.send(d, q.events.find(e => e.kind === d.kind)!)); }
    });
    this.pending.set(ev.room, { events: [ev], timer });
  }

  /** For the notifier's doorbell rule: whether this ring should alert (the camera's choice, the cooldown). */
  allowRing(e: DeviceEvent): boolean {
    const d = this.ring.get(e.device.id);
    return !d || this.now - d.at > 10_000 ? true : d.sent;
  }

  /** Of events from one room arriving together, the most telling one that may alert, and why (or why not). */
  decide(events: RoomEvent[]): Decision | null {
    if (!events.length) return null;
    const sorted = [...events].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
    const t = this.now;
    const away = !this.hub.engine.anyoneHome();
    const quiet = this.quietNow();
    const cool = this.settings().cooldownMin * 60_000;
    let first: Decision | null = null;
    for (const ev of sorted) {
      const dev = this.hub.reg.get(ev.device);
      if (!dev) continue;
      const when = alertWhen(dev, ev.kind, this.cfg);
      const klass = CLASS[ev.kind] ?? ev.kind;
      const base = { at: t, room: ev.room, device: ev.device, kind: ev.kind };
      let why = '';
      if (when === 'never') why = `${ev.kind} alerts are off for ${dev.name}`;
      else if (when === 'away' && !away) why = 'someone’s home';
      else if (quiet && ev.kind !== 'ring' && !away) why = 'quiet hours';
      else {
        const same = this.sentAt.get(`${ev.room}:${klass}`);
        const limit = ev.kind === 'ring' ? RING_COOLDOWN_MS : cool;
        // A stronger alert from the same room covers this one for the cooldown (a person after the doorbell).
        const stronger = PRIORITY.slice(0, PRIORITY.indexOf(ev.kind)).map(k => this.sentAt.get(`${ev.room}:${CLASS[k] ?? k}`)).filter((x): x is number => x != null && t - x < cool);
        if (same != null && t - same < limit) why = `already told ${Math.max(1, Math.round((t - same) / 60_000))} min ago`;
        else if (stronger.length && ev.kind !== 'ring') why = 'covered by a stronger alert just before';
      }
      const d: Decision = { ...base, sent: !why, why: why || (away ? 'nobody’s home' : when === 'always' ? 'always on' : 'on') };
      first ??= d;
      if (d.sent) {
        this.sentAt.set(`${ev.room}:${klass}`, t);
        return this.record(d);
      }
    }
    return first ? this.record(first) : null;
  }

  private record(d: Decision): Decision {
    this.decisions.unshift(d);
    this.decisions = this.decisions.slice(0, 60);
    return d;
  }

  /** The alert for an event, in words. */
  message(ev: RoomEvent, dev: Device): Notification {
    const cfg = this.cfg;
    const room = cfg.rooms.find(r => r.id === ev.room)?.name;
    const away = !this.hub.engine.anyoneHome();
    const tz = cfg.timezone;
    const door = isDoorbell(dev) || /door|porch|entr/i.test(room ?? '');
    const place = room && !/unsorted|unassigned/i.test(room) ? room : dev.name;
    const atDoor = door ? (/door/i.test(place) ? `the ${place.toLowerCase()}` : `the ${place.toLowerCase()} door`) : null;
    const inRoom = `the ${place}`;
    const tail = away && !ev.outdoor ? ' while nobody’s home' : '';
    const titles: Record<string, string> = {
      person: atDoor ? `Someone’s at ${atDoor}` : `Someone’s in ${inRoom}${tail}`,
      package: `A package at ${atDoor ?? inRoom}`,
      vehicle: `A vehicle at ${atDoor ?? inRoom}`,
      animal: `An animal in ${inRoom}`,
      motion: `Motion in ${inRoom}${tail}`,
      sound: `A sound in ${inRoom}${tail}`,
      opened: `${dev.name} opened${away ? ' while nobody’s home' : ''}`,
    };
    const seen: Record<string, string> = { person: 'saw someone', package: 'saw a package', vehicle: 'saw a vehicle', animal: 'saw an animal', motion: 'noticed motion', sound: 'heard something', opened: 'opened' };
    const body = ev.kind === 'opened' ? `${place} · ${clock(ev.at, tz)}.${away ? ' Nobody’s marked home.' : ''}`
      : `${dev.name} ${seen[ev.kind] ?? ev.kind} at ${clock(ev.at, tz)}.${away && !ev.outdoor ? ' Nobody’s marked home.' : ''}`;
    const cam = ev.source === 'camera' ? `/phone.html?cam=${encodeURIComponent(dev.id)}` : '/phone.html?page=sensors';
    return {
      title: titles[ev.kind] ?? `${dev.name}: ${ev.kind}`, body, url: cam,
      tag: `security-${ev.room}-${CLASS[ev.kind] ?? ev.kind}`,
      ...(ev.source === 'camera' ? { actions: [{ action: 'view-camera', title: 'View camera', url: cam }] } : {}),
    };
  }

  private async send(d: Decision, ev: RoomEvent): Promise<void> {
    const dev = this.hub.reg.get(ev.device);
    if (!dev || !this.notify) return;
    const n = this.message(ev, dev);
    d.title = n.title;
    await this.notify(n);
  }

  // ----------------------------------------------------------------- frames --

  private key(device: string, id: number) { return `${device}:${id}`; }

  hasFrame(device: string, id: number): boolean {
    return this.opts.framesDir ? !!this.frames.get(device)?.includes(id) : this.memFrames.has(this.key(device, id));
  }

  /** The picture kept for one event. */
  frame(device: string, id: number): Snapshot | null {
    if (!this.opts.framesDir) return this.memFrames.get(this.key(device, id)) ?? null;
    if (!this.hasFrame(device, id) || !/^[\w.-]+$/.test(device)) return null;
    const dir = join(this.opts.framesDir, device);
    const file = readdirSync(dir).find(f => f.startsWith(`${id}.`));
    if (!file) return null;
    return { contentType: BY_EXT[file.split('.').pop()!] ?? 'image/jpeg', body: readFileSync(join(dir, file)) };
  }

  /** Ask the camera's integration for the picture of this event, a moment after it, and keep it. */
  private grabFrame(ev: RoomEvent): void {
    const dev = this.hub.reg.get(ev.device);
    const a = dev && this.hub.reg.adapters.get(dev.adapter);
    if (!dev || !a?.snapshot || !ev.id) return;
    this.later(this.opts.frameDelayMs ?? 3000, () => {
      this.track((async () => {
        const snap = await Promise.race([a.snapshot!(dev), new Promise<never>((_, no) => { const t = setTimeout(() => no(new Error('slow')), 15_000); t.unref?.(); })]);
        if (!snap?.body?.length) return;
        this.keep(ev.device, ev.id, snap);
        this.hub.emit('changed');
      })().catch(() => { /* no picture for this one */ }));
    });
  }

  keep(device: string, id: number, snap: Snapshot): void {
    if (!this.opts.framesDir) {
      this.memFrames.set(this.key(device, id), snap);
      while (this.memFrames.size > MEMORY_FRAMES) this.memFrames.delete(this.memFrames.keys().next().value!);
      return;
    }
    if (!/^[\w.-]+$/.test(device)) return;
    const dir = join(this.opts.framesDir, device);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.${TYPES[snap.contentType] ?? 'jpg'}`), snap.body);
    const ids = [...(this.frames.get(device) ?? []).filter(x => x !== id), id].sort((a, b) => a - b);
    this.frames.set(device, ids);
    this.prune(device);
  }

  /** Keep the newest frames per camera, none older than keepDays. */
  private prune(device: string): void {
    const dir = join(this.opts.framesDir!, device);
    const keep = this.opts.keepFrames ?? 60;
    const cutoff = this.now - (this.opts.keepDays ?? 14) * 86400_000;
    let ids = this.frames.get(device) ?? [];
    const old = this.hub.store.query({ kinds: ['device_event'], devices: [device], until: cutoff, limit: 5000 }).map(e => e.id);
    const drop = new Set([...ids.slice(0, Math.max(0, ids.length - keep)), ...ids.filter(i => old.includes(i))]);
    if (!drop.size) return;
    for (const f of readdirSync(dir)) if (drop.has(Number(f.split('.')[0]))) { try { unlinkSync(join(dir, f)); } catch { /* gone */ } }
    ids = ids.filter(i => !drop.has(i));
    this.frames.set(device, ids);
  }

  private scanFrames(): void {
    try {
      mkdirSync(this.opts.framesDir!, { recursive: true });
      for (const dev of readdirSync(this.opts.framesDir!)) {
        try { this.frames.set(dev, readdirSync(join(this.opts.framesDir!, dev)).map(f => Number(f.split('.')[0])).filter(Number.isFinite).sort((a, b) => a - b)); } catch { /* not a folder */ }
      }
    } catch { /* no frames yet */ }
  }
}
