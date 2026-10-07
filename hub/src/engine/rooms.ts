import { EventEmitter } from 'node:events';
import type { Device, RoomEventKind } from '../model/types.ts';
import type { ChangeEvent, DeviceEvent, Registry } from '../devices/registry.ts';
import type { LogEntry, Store } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import { isCamera, isOutdoor, isSensor } from '../util/sensors.ts';
import { clock } from '../util/time.ts';

// What's happening in each room, from the cameras and sensors there: a person seen, motion, the doorbell, a door
// opening. Room activity drives room triggers and conditions in automations, the "someone's moving inside" hint
// for presence, camera alerts, and each room's and camera's timeline. Nothing here knows who anyone is.

/** Camera event types Kova treats as something happening in the room. */
export const CAMERA_KINDS: RoomEventKind[] = ['person', 'motion', 'ring', 'vehicle', 'animal', 'package', 'sound'];
/** Kinds that mean someone is (or was just) there: they make a room "active". */
export const PRESENCE_KINDS: RoomEventKind[] = ['person', 'motion', 'ring', 'opened', 'closed'];
/** How long a room stays active after its last sign of someone, unless a condition says otherwise. */
export const ACTIVE_MIN = 10;
/** Someone is in a room now: a motion sensor says so, or a person or motion this recently. */
const OCCUPIED_MS = 5 * 60_000;

export const ROOM_EVENT_WORDS: Record<RoomEventKind, string> = {
  person: 'a person', motion: 'motion', ring: 'the doorbell', vehicle: 'a vehicle', animal: 'an animal', package: 'a package', sound: 'a sound', opened: 'opened', closed: 'closed',
};

export interface RoomEvent {
  /** The log entry it came from. */
  id: number;
  at: number;
  room: string;
  device: string;
  kind: RoomEventKind;
  source: 'camera' | 'sensor';
  outdoor: boolean;
  /** "Doorbell saw a person", "Front door sensor opened". */
  what: string;
  /** Adapter event data (event and session ids), cameras only. */
  data?: Record<string, unknown>;
}

export interface RoomStatus {
  /** Something showed someone there in the last ACTIVE_MIN minutes. */
  active: boolean;
  /** Someone is there now (a motion sensor holding, or a person or motion in the last few minutes). */
  occupied: boolean;
  last: (RoomEvent & { atLabel: string }) | null;
}

export interface TimelineQuery { device?: string; room?: string; since?: number; until?: number; limit?: number; kinds?: RoomEventKind[] }

const SENSOR_EVENT_SQL = `kind = 'state' AND (json_extract(data, '$.patch.motion') = 1 OR json_type(data, '$.patch.open') IN ('true', 'false'))`;

export class RoomActivity extends EventEmitter<{ activity: [RoomEvent] }> {
  /** The latest event per room and kind (from the log at start, then live). */
  private last = new Map<string, Map<RoomEventKind, RoomEvent>>();
  /** Which saved event ids have a frame kept (set by the security service). */
  frames: { has(device: string, id: number): boolean } | null = null;

  constructor(private store: Store, private reg: Registry, private config: ConfigStore, private now: () => number) {
    super();
    reg.on('change', e => this.onSensor(e));
    // Devices announced (at start, or an integration added): read back what their rooms last saw.
    reg.on('devices', () => { this.loaded = false; });
  }

  private loaded = false;
  /** Remember the last two days from the log, so "was there motion in the garage?" and room conditions survive a restart. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const e of [...this.query({ since: this.now() - 2 * 86400_000, limit: 2000 })].reverse()) this.remember(e);
  }

  private cfg() { return this.config.get(); }

  /** A camera event the engine just logged (Engine.onDeviceEvent). */
  fromDeviceEvent(e: DeviceEvent, entry: LogEntry): RoomEvent | null {
    if (!CAMERA_KINDS.includes(e.type as RoomEventKind) || !(isCamera(e.device) || isSensor(e.device))) return null;
    const ev: RoomEvent = { id: entry.id, at: entry.ts, room: e.device.room, device: e.device.id, kind: e.type as RoomEventKind, source: isCamera(e.device) ? 'camera' : 'sensor', outdoor: isOutdoor(e.device, this.cfg()), what: entry.what, data: e.data };
    this.remember(ev);
    this.emit('activity', ev);
    return ev;
  }

  /** A sensor's motion starting, or a door or window opening or closing. */
  private onSensor(e: ChangeEvent): void {
    const d = e.device;
    if (!isSensor(d)) return;
    const kind: RoomEventKind | null = e.patch.motion === true && e.prev.motion !== true ? 'motion'
      : typeof e.patch.open === 'boolean' && e.patch.open !== e.prev.open ? (e.patch.open ? 'opened' : 'closed') : null;
    if (!kind) return;
    // The registry has just logged the change: that entry is this event.
    const entry = this.store.lastStateChange(d.id);
    const at = entry?.ts ?? this.now();
    const ev: RoomEvent = { id: entry?.id ?? 0, at, room: d.room, device: d.id, kind, source: 'sensor', outdoor: isOutdoor(d, this.cfg()), what: entry?.what ?? `${d.name} ${kind}` };
    this.remember(ev);
    this.emit('activity', ev);
  }

  private remember(ev: RoomEvent): void {
    const m = this.last.get(ev.room) ?? new Map<RoomEventKind, RoomEvent>();
    const cur = m.get(ev.kind);
    if (!cur || cur.at <= ev.at) m.set(ev.kind, ev);
    this.last.set(ev.room, m);
  }

  /** The latest event in a room (of some kinds), if any since `since`. */
  latest(room: string, kinds: RoomEventKind[] = PRESENCE_KINDS, since = 0): RoomEvent | null {
    this.load();
    let best: RoomEvent | null = null;
    for (const [k, ev] of this.last.get(room) ?? []) if (kinds.includes(k) && ev.at >= since && (!best || ev.at > best.at)) best = ev;
    return best;
  }

  /** A motion sensor in the room says someone is moving now. */
  private sensing(room: string): boolean {
    return this.reg.list().some(d => d.room === room && isSensor(d) && d.state.motion === true && d.state.online !== false);
  }

  /** Was there activity in the room within the last `withinMin` minutes (or a motion sensor holding now)? */
  active(room: string, withinMin = ACTIVE_MIN): boolean {
    return this.sensing(room) || !!this.latest(room, PRESENCE_KINDS, this.now() - withinMin * 60_000);
  }

  status(room: string): RoomStatus {
    const t = this.now(), tz = this.cfg().timezone;
    const last = this.latest(room, [...PRESENCE_KINDS, 'vehicle', 'animal', 'package', 'sound']);
    const recent = this.latest(room, ['person', 'motion'], t - OCCUPIED_MS);
    return {
      active: this.active(room),
      occupied: this.sensing(room) || !!recent,
      last: last ? { ...last, atLabel: clock(last.at, tz) } : null,
    };
  }

  /** Camera and sensor events from the log, newest first: for a device, a room, or the whole home. */
  timeline(q: TimelineQuery = {}): RoomEvent[] {
    return this.query(q).filter(e => (!q.room || e.room === q.room) && (!q.kinds?.length || q.kinds.includes(e.kind))).slice(0, Math.max(1, Math.min(500, q.limit ?? 50)));
  }

  /** Per kind: how many and the latest, in a room since an instant. For Ask Kova and the room cards. */
  summary(room: string, since: number): { kind: RoomEventKind; count: number; last: number }[] {
    const by = new Map<RoomEventKind, { count: number; last: number }>();
    for (const e of this.timeline({ room, since, limit: 500 })) {
      const x = by.get(e.kind) ?? { count: 0, last: 0 };
      x.count++; x.last = Math.max(x.last, e.at);
      by.set(e.kind, x);
    }
    return [...by].map(([kind, x]) => ({ kind, ...x })).sort((a, b) => b.last - a.last);
  }

  private query(q: TimelineQuery): RoomEvent[] {
    const cfg = this.cfg();
    const all = this.reg.list();
    const inRoom = (d: Device) => !q.room || d.room === q.room;
    const cams = all.filter(d => (isCamera(d) || isSensor(d)) && inRoom(d) && (!q.device || d.id === q.device)).map(d => d.id);
    const sensors = all.filter(d => isSensor(d) && inRoom(d) && (!q.device || d.id === q.device)).map(d => d.id);
    const limit = (q.limit ?? 50) * (q.room || q.kinds ? 3 : 1) + 10;
    const devEvents = cams.length ? this.store.query({ kinds: ['device_event'], devices: cams, since: q.since, until: q.until, limit, where: `json_extract(data, '$.type') IN (${CAMERA_KINDS.map(k => `'${k}'`).join(', ')})` }) : [];
    const sensEvents = sensors.length ? this.store.query({ kinds: ['state'], devices: sensors, since: q.since, until: q.until, limit, where: SENSOR_EVENT_SQL }) : [];
    const out: RoomEvent[] = [];
    for (const e of [...devEvents, ...sensEvents]) {
      const d = this.reg.get(e.device ?? '');
      if (!d) continue;
      let kind: RoomEventKind;
      if (e.kind === 'device_event') kind = e.data.type as RoomEventKind;
      else {
        const p = (e.data.patch ?? {}) as { motion?: boolean; open?: boolean };
        kind = p.motion === true ? 'motion' : p.open ? 'opened' : 'closed';
      }
      const { type: _t, ...data } = e.data as Record<string, unknown>;
      out.push({ id: e.id, at: e.ts, room: d.room, device: d.id, kind, source: isCamera(d) ? 'camera' : 'sensor', outdoor: isOutdoor(d, cfg), what: e.what, ...(e.kind === 'device_event' ? { data } : {}) });
    }
    return out.sort((a, b) => b.at - a.at || b.id - a.id);
  }
}
