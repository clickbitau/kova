import type { Registry, ChangeEvent } from '../devices/registry.ts';
import type { Store } from '../store/db.ts';
import type { Device, HomeConfig } from '../model/types.ts';
import type { RoomActivity } from '../engine/rooms.ts';
import { isOutdoor, isSensor, NUMERIC_READINGS, readingsOf, roomOutdoor, SENSOR_ICON, sensorKind, type Reading, type ReadingField, type SensorKind } from '../util/sensors.ts';
import { clock } from '../util/time.ts';

// Sensors as the owner sees them: each one's live readings with units, which way they're heading, when they last
// changed and reported, its battery, and whether it's answering. And each room's climate and activity, from its
// sensors first and the devices there that sense the room too (an air conditioner's temperature).

/** Points kept per reading: one per 15 minutes, a day back. */
const BUCKET_MS = 15 * 60_000;
const KEEP_MS = 24 * 3600_000;
/** How far back a trend looks, and how much has to change before it's "rising" or "falling". */
const TREND_MS = 60 * 60_000;
const TREND_MIN: Partial<Record<ReadingField, number>> = { temp: 0.5, humidity: 3, lux: 50, pm25: 5, airQuality: 1, power: 50, battery: 5, energy: 0.5 };
/** No report for this long: the sensor is quiet (it may be asleep, or its battery gone). */
export const STALE_MS = 6 * 3600_000;

export type Trend = 'up' | 'down' | 'steady';

export interface SensorReading extends Reading {
  trend: Trend | null;
  /** When this reading last changed. */
  changedAt: number | null;
  changedLabel: string | null;
}

export interface SensorView {
  id: string; name: string; room: string; integration: string; type: Device['type'];
  kind: SensorKind; icon: string; hidden: boolean; outdoor: boolean;
  /** The main reading first. */
  readings: SensorReading[];
  battery: number | null;
  lowBattery: boolean;
  online: boolean;
  /** When it last reported anything. */
  seenAt: number | null;
  seenLabel: string | null;
  /** Hasn't reported for a long while. */
  stale: boolean;
}

export interface RoomClimate {
  temp: number | null; humidity: number | null; lux: number | null;
  /** Where the temperature comes from: sensors in the room, else a device there that senses it. */
  tempFrom: string[];
  outdoor: boolean;
  active: boolean;
  occupied: boolean;
  /** The latest thing that happened there (a camera's person, motion, a door). */
  last: { kind: string; at: number; atLabel: string; device: string; what: string } | null;
  /** Doors and windows open there now. */
  open: string[];
  sensors: number;
}

type Series = Record<string, Record<string, [number, number][]>>;

export class SensorHistory {
  private series: Series;
  private changed: Record<string, Record<string, number>>;
  private seen: Record<string, number>;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private reg: Registry, private store: Store, private now: () => number) {
    const saved = store.get<{ series?: Series; changed?: Record<string, Record<string, number>>; seen?: Record<string, number> }>('sensor-history') ?? {};
    this.series = saved.series ?? {};
    this.changed = saved.changed ?? {};
    this.seen = saved.seen ?? {};
    const on = (e: ChangeEvent) => this.note(e);
    reg.on('reading', on);
    reg.on('change', on);
    reg.on('seen', d => { if (d.state.online !== false) this.seen[d.id] = this.now(); });
    // A new sensor starts its history from what it says now.
    reg.on('devices', () => { for (const d of reg.list()) this.sample(d); });
  }

  /** A reading came in: remember when it changed, and put it in its 15-minute slot. */
  private note(e: ChangeEvent): void {
    const d = e.device, t = this.now();
    this.seen[d.id] = t;
    for (const f of NUMERIC_READINGS) {
      if (!(f in e.patch)) continue;
      const was = (e.prev as Record<string, unknown>)[f], is = (d.state as Record<string, unknown>)[f];
      if (was !== is && was !== undefined) (this.changed[d.id] ??= {})[f] = t;
      else if (was === undefined) (this.changed[d.id] ??= {})[f] ??= t;
    }
    for (const f of ['motion', 'open'] as const) if (f in e.patch && e.patch[f] !== e.prev[f]) (this.changed[d.id] ??= {})[f] = t;
    this.sample(d);
    this.save();
  }

  private sample(d: Device): void {
    const t = this.now(), slot = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    for (const f of NUMERIC_READINGS) {
      const v = (d.state as Record<string, unknown>)[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const s = ((this.series[d.id] ??= {})[f] ??= []);
      const last = s[s.length - 1];
      if (last && last[0] === slot) last[1] = v; else s.push([slot, v]);
      while (s.length && s[0][0] < t - KEEP_MS) s.shift();
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 30_000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.store.set('sensor-history', { series: this.series, changed: this.changed, seen: this.seen });
  }

  /** The day's points for one reading: [time, value] oldest first. */
  history(device: string, field: ReadingField): [number, number][] { return this.series[device]?.[field] ?? []; }

  /** Rising, falling or steady over the last hour; null without enough history. */
  trend(device: string, field: ReadingField, current: number | null): Trend | null {
    const s = this.history(device, field);
    if (current == null || s.length < 2) return null;
    const t = this.now();
    const then = [...s].reverse().find(p => p[0] <= t - TREND_MS) ?? (s[0][0] <= t - TREND_MS / 3 ? s[0] : null);
    if (!then) return null;
    const diff = current - then[1], min = TREND_MIN[field] ?? 0;
    return Math.abs(diff) < min ? 'steady' : diff > 0 ? 'up' : 'down';
  }

  changedAt(device: string, field: string): number | null { return this.changed[device]?.[field] ?? null; }
  seenAt(device: string): number | null { return this.seen[device] ?? null; }

  /** One sensor as the Sensors screen shows it. */
  view(d: Device, cfg: Pick<HomeConfig, 'rooms' | 'devices' | 'timezone'>): SensorView {
    const tz = cfg.timezone, t = this.now();
    const readings = readingsOf(d).map(r => {
      const changedAt = this.changedAt(d.id, r.field);
      return { ...r, trend: typeof r.value === 'number' ? this.trend(d.id, r.field, r.value) : null, changedAt, changedLabel: changedAt ? clock(changedAt, tz) : null };
    });
    const battery = typeof d.state.battery === 'number' ? Math.round(d.state.battery) : null;
    const seenAt = this.seenAt(d.id);
    const online = d.state.online !== false;
    const kind = sensorKind(d);
    return {
      id: d.id, name: d.name, room: d.room, integration: d.integration, type: d.type, kind, icon: SENSOR_ICON[kind], hidden: !!d.hidden,
      outdoor: isOutdoor(d, cfg), readings, battery, lowBattery: battery != null && battery <= 20, online,
      seenAt, seenLabel: seenAt ? clock(seenAt, tz) : null,
      // Contact and motion sensors only speak when something happens; a quiet one isn't stale.
      stale: online && seenAt != null && t - seenAt > STALE_MS && kind !== 'contact' && kind !== 'motion',
    };
  }
}

/** Every sensor, in the home's room order, then by name. */
export function sensorViews(devices: Device[], cfg: Pick<HomeConfig, 'rooms' | 'devices' | 'timezone'>, history: SensorHistory): SensorView[] {
  const order = new Map(cfg.rooms.map((r, i) => [r.id, i]));
  return devices.filter(isSensor).map(d => history.view(d, cfg))
    .sort((a, b) => (order.get(a.room) ?? 999) - (order.get(b.room) ?? 999) || a.name.localeCompare(b.name));
}

const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;

/**
 * Each room's climate and activity. Temperature and humidity come from the room's sensors (the average when there
 * are several); without one, from a device there that senses the room (an air conditioner). Hidden and offline
 * devices don't count.
 */
export function roomClimate(devices: Device[], cfg: Pick<HomeConfig, 'rooms' | 'timezone'>, rooms: RoomActivity): Record<string, RoomClimate> {
  const out: Record<string, RoomClimate> = {};
  const live = devices.filter(d => !d.hidden && d.state.online !== false);
  for (const r of cfg.rooms) {
    const here = live.filter(d => d.room === r.id);
    const sensors = here.filter(isSensor);
    const pick = (f: 'temp' | 'humidity' | 'lux') => {
      const from = (sensors.some(d => typeof d.state[f] === 'number') ? sensors : here).filter(d => typeof d.state[f] === 'number');
      return { v: avg(from.map(d => d.state[f] as number)), from: from.map(d => d.id) };
    };
    const temp = pick('temp'), hum = pick('humidity'), lux = pick('lux');
    const st = rooms.status(r.id);
    out[r.id] = {
      temp: temp.v, humidity: hum.v, lux: lux.v, tempFrom: temp.from, outdoor: roomOutdoor(r),
      active: st.active, occupied: st.occupied,
      last: st.last ? { kind: st.last.kind, at: st.last.at, atLabel: st.last.atLabel, device: st.last.device, what: st.last.what } : null,
      open: sensors.filter(d => d.state.open === true).map(d => d.name),
      sensors: devices.filter(d => d.room === r.id && isSensor(d) && !d.hidden).length,
    };
  }
  return out;
}
