import { EventEmitter } from 'node:events';
import type { Device, HomeConfig } from '../model/types.ts';
import type { Registry } from '../devices/registry.ts';
import type { Store } from '../store/db.ts';
import type { WeatherNow, WeatherToday } from './weather.ts';
import { clock, localDate } from '../util/time.ts';
import { isOutdoor, isSensor, roomOutdoor } from '../util/sensors.ts';

// What Kova notices about the home, for the Now page: the home at a glance (outside, inside, the air) and alerts and
// warnings worth acting on. Each insight has a stable id, so it can be snoozed and so a phone is told once, when it
// first appears. Device offline and broken links are shown here but pushed by the notifier's own rules.

export type Level = 'alert' | 'warning' | 'info';

export interface Insight {
  id: string;
  level: Level;
  icon: string;
  title: string;
  detail?: string;
  /** The device it's about, to open its panel. */
  device?: string;
  /** Push it to phones when it first appears (the notifier pushes offline devices and broken links itself). */
  push?: boolean;
}

export interface Glance {
  outside: (WeatherNow & { high?: number; low?: number; rain?: string | null; uvMax?: number | null }) | null;
  /** Rooms (or devices) with a temperature inside, in °C, and the humidity there when something senses it. */
  inside: { name: string; temp: number; humidity?: number; device: string; room?: string }[];
  /** The air as purifiers rate it: the worst room first. */
  air: { name: string; level: number; label: string; device: string }[];
}

export const AIR_LABEL: Record<number, string> = { 1: 'Good', 2: 'Moderate', 3: 'Poor', 4: 'Very poor' };

/** How long a device has to be offline before it's a warning (a router hiccup isn't news). */
const OFFLINE_MS = 30 * 60_000;
const DERIVED = new Set(['groups', 'combined', 'virtual']);

export interface InsightInputs {
  devices: Device[];
  cfg: Pick<HomeConfig, 'rooms' | 'timezone' | 'devices'>;
  now: number;
  weather: { current: WeatherNow | null; today: WeatherToday | null } | null;
  /** Integrations that aren't working: id, name, why. */
  failing: { id: string; name: string; note?: string }[];
  /** When each device was first seen offline (still offline now). */
  offlineSince: Map<string, number>;
  /** When each door or window sensor opened (still open now). */
  openSince?: Map<string, number>;
}

/** A door or window left open this long is worth saying. */
const OPEN_MS = 20 * 60_000;
const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10;

/**
 * Each indoor room's temperature (and humidity): its sensors' when it has them (the average of several), else a
 * climate device there that senses the room. Outdoor rooms and outdoor sensors aren't "inside".
 */
export function insideRooms(x: Pick<InsightInputs, 'devices' | 'cfg'>): Glance['inside'] {
  const visible = x.devices.filter(d => !x.cfg.devices?.[d.id]?.hidden && d.state.online !== false && typeof d.state.temp === 'number');
  const out: Glance['inside'] = [];
  const seen = new Set<string>();
  for (const r of x.cfg.rooms) {
    if (roomOutdoor(r)) continue;
    const here = visible.filter(d => d.room === r.id && !(isSensor(d) && isOutdoor(d, x.cfg)));
    const sensors = here.filter(isSensor);
    const from = sensors.length ? sensors : here.filter(d => d.type === 'climate');
    if (!from.length) continue;
    for (const d of here) seen.add(d.id);
    const hums = from.map(d => d.state.humidity).filter((v): v is number => typeof v === 'number');
    out.push({ name: r.name === 'Unsorted' ? from[0].name : r.name, room: r.id, temp: avg(from.map(d => d.state.temp as number)), ...(hums.length ? { humidity: Math.round(avg(hums)) } : {}), device: from[0].id });
  }
  // Climate devices in no room of the home still say how warm it is by them.
  for (const d of visible) if (!seen.has(d.id) && d.type === 'climate' && !x.cfg.rooms.some(r => r.id === d.room)) out.push({ name: d.name, temp: d.state.temp as number, device: d.id });
  return out;
}

const roomName = (cfg: InsightInputs['cfg'], d: Device) => cfg.rooms.find(r => r.id === d.room)?.name;
/** "Living Room Purifier", or "Bedroom AC (Bedroom)" when the room adds something. */
const where = (cfg: InsightInputs['cfg'], d: Device) => { const r = roomName(cfg, d); return r && !d.name.toLowerCase().includes(r.toLowerCase()) && r !== 'Unsorted' ? `${d.name} (${r})` : d.name; };

/** "Might rain from about 3 pm (2 mm)", or with a chance when the forecast gives one. */
export function rainText(r: WeatherToday['rain'], now: number, tz: string): string | null {
  if (!r) return null;
  const soon = r.from - now < 45 * 60_000;
  const at = soon ? 'soon' : `from about ${clock(r.from, tz)}`;
  const how = r.chance != null ? `${r.chance}% chance` : r.mm >= 0.2 ? `${r.mm} mm` : 'light';
  return `Might rain ${at} (${how})`;
}

export function glance(x: InsightInputs): Glance {
  const visible = x.devices.filter(d => !x.cfg.devices?.[d.id]?.hidden && !x.cfg.devices?.[d.id]?.archived);
  const w = x.weather;
  return {
    outside: w?.current ? { ...w.current, ...(w.today ? { high: w.today.high, low: w.today.low, uvMax: w.today.uvMax, rain: rainText(w.today.rain, x.now, x.cfg.timezone) } : {}) } : null,
    inside: insideRooms(x),
    air: visible.filter(d => typeof d.state.airQuality === 'number' && d.state.online !== false)
      .map(d => ({ name: d.name, level: d.state.airQuality as number, label: AIR_LABEL[d.state.airQuality as number] ?? '?', device: d.id }))
      .sort((a, b) => b.level - a.level),
  };
}

export function insights(x: InsightInputs): Insight[] {
  const out: Insight[] = [];
  const visible = x.devices.filter(d => !x.cfg.devices?.[d.id]?.hidden && !x.cfg.devices?.[d.id]?.archived);
  const tz = x.cfg.timezone, today = localDate(x.now, tz);
  for (const d of visible) {
    const s = d.state;
    if (typeof s.filterLife === 'number' && s.filterLife <= 20) {
      out.push({ id: `filter:${d.id}`, level: s.filterLife <= 10 ? 'alert' : 'warning', icon: 'filter_alt', device: d.id, push: true,
        title: `${where(x.cfg, d)}: replace the filter ${s.filterLife <= 10 ? 'now' : 'soon'}`, detail: `${s.filterLife}% left` });
    }
    if (typeof s.airQuality === 'number' && s.airQuality >= 3 && s.online !== false) {
      out.push({ id: `air:${d.id}`, level: s.airQuality >= 4 ? 'alert' : 'warning', icon: 'air', device: d.id, push: true,
        title: `The air is ${AIR_LABEL[s.airQuality].toLowerCase()} near ${where(x.cfg, d)}`, detail: s.pm25 != null ? `PM2.5 ${s.pm25} µg/m³${s.on ? '' : '. The purifier is off.'}` : s.on ? undefined : 'The purifier is off.' });
    }
    // Too hot or cold inside: by an air conditioner, or a sensor in an indoor room.
    if ((d.type === 'climate' || (isSensor(d) && !isOutdoor(d, x.cfg))) && typeof s.temp === 'number' && s.online !== false) {
      const ac = d.type === 'climate' ? (s.on ? undefined : 'The air conditioner is off.') : undefined;
      const by = isSensor(d) ? (roomName(x.cfg, d) ?? d.name) : where(x.cfg, d);
      if (s.temp >= 30) out.push({ id: `indoor-hot:${d.id}`, level: 'warning', icon: 'device_thermostat', device: d.id, push: true, title: isSensor(d) ? `It’s ${s.temp}° in the ${by}` : `It’s ${s.temp}° inside, by ${by}`, detail: ac });
      if (s.temp <= 12) out.push({ id: `indoor-cold:${d.id}`, level: 'warning', icon: 'device_thermostat', device: d.id, push: true, title: isSensor(d) ? `It’s ${s.temp}° in the ${by}` : `It’s ${s.temp}° inside, by ${by}`, detail: ac });
    }
    // A door or window left open a while.
    if (isSensor(d) && s.open === true && s.online !== false) {
      const since = x.openSince?.get(d.id);
      if (since != null && x.now - since >= OPEN_MS) out.push({ id: `open:${d.id}:${since}`, level: 'warning', icon: 'sensor_door', device: d.id, push: true, title: `${where(x.cfg, d)} has been open ${Math.round((x.now - since) / 60_000)} min`, detail: `Since ${clock(since, tz)}` });
    }
    if (typeof s.battery === 'number' && s.battery <= 20 && !(d.type === 'vacuum' && (s.activity === 'docked' || s.activity === 'returning'))) {
      out.push({ id: `battery:${d.id}`, level: s.battery <= 10 ? 'alert' : 'warning', icon: 'battery_alert', device: d.id, push: true, title: `${where(x.cfg, d)}: battery low`, detail: `${s.battery}%` });
    }
  }
  // The internet (Warden's device).
  const net = x.devices.find(d => d.id === 'warden_internet');
  if (net && net.state.online !== false && net.state.on === false) out.push({ id: 'internet', level: 'alert', icon: 'wifi_off', device: net.id, title: 'The internet is down', detail: 'Cloud devices won’t answer until it’s back.' });
  // Devices offline a while, together.
  const off = visible.filter(d => !DERIVED.has(d.adapter) && d.state.online === false && x.now - (x.offlineSince.get(d.id) ?? x.now) >= OFFLINE_MS && d.id !== 'warden_internet');
  if (off.length) {
    out.push({ id: `offline:${off.map(d => d.id).sort().join(',')}`, level: 'warning', icon: 'cloud_off', ...(off.length === 1 ? { device: off[0].id } : {}),
      title: off.length === 1 ? `${off[0].name} isn’t responding` : `${off.length} ${off.every(isSensor) ? 'sensors' : off.some(isSensor) ? 'devices and sensors' : 'devices'} aren’t responding`,
      detail: off.length === 1 ? `Since ${clock(x.offlineSince.get(off[0].id)!, tz)}` : off.slice(0, 4).map(d => d.name).join(', ') + (off.length > 4 ? ` and ${off.length - 4} more` : '') });
  }
  for (const f of x.failing) out.push({ id: `integration:${f.id}`, level: 'warning', icon: 'extension_off', title: `${f.name} needs attention`, detail: f.note });
  // Outside, today.
  const t = x.weather?.today;
  if (t) {
    const rain = rainText(t.rain, x.now, tz);
    if (rain) out.push({ id: `rain:${today}`, level: 'info', icon: 'rainy', title: rain, detail: 'Bring the washing in, close the windows.' });
    if (t.high >= 35) out.push({ id: `heat:${today}`, level: 'warning', icon: 'thermostat', push: true, title: `Hot today: up to ${t.high}°`, detail: 'Cool the house early, before it heats up.' });
    if (t.low <= 2) out.push({ id: `cold:${today}`, level: 'warning', icon: 'ac_unit', push: true, title: `Cold today: down to ${t.low}°`, detail: t.low <= 0 ? 'Frost likely.' : undefined });
    if (t.uvMax != null && t.uvMax >= 8) out.push({ id: `uv:${today}`, level: 'info', icon: 'wb_sunny', title: `UV very high today (${Math.round(t.uvMax)})`, detail: 'Sun protection if you’re outside around midday.' });
  }
  const rank: Record<Level, number> = { alert: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * Keeps what insights need over time: when devices went offline, what the owner snoozed, and which insights were
 * already pushed. Emits `new` for an alert or warning (with `push`) the first time it appears, not while snoozed.
 */
export class Insights extends EventEmitter<{ new: [Insight] }> {
  private offlineSince = new Map<string, number>();
  private openSince = new Map<string, number>();
  private seen = new Set<string>();
  private first = true;

  constructor(private reg: Registry, private store: Store, private inputs: () => Omit<InsightInputs, 'offlineSince' | 'devices'>) {
    super();
    const note = () => {
      const t = this.inputs().now;
      for (const d of this.reg.list()) {
        if (d.state.online === false) { if (!this.offlineSince.has(d.id)) this.offlineSince.set(d.id, t); }
        else this.offlineSince.delete(d.id);
        if (d.state.open === true) { if (!this.openSince.has(d.id)) this.openSince.set(d.id, t); }
        else this.openSince.delete(d.id);
      }
    };
    reg.on('change', note);
    reg.on('measure', note);
    reg.on('devices', note);
    note();
  }

  private snoozes(): Record<string, number> { return this.store.get<Record<string, number>>('insight-snooze') ?? {}; }

  /** Snooze one for so many hours (24 by default). Snoozes past are forgotten. */
  snooze(id: string, hours = 24): void {
    const t = this.inputs().now;
    const s = Object.fromEntries(Object.entries(this.snoozes()).filter(([, until]) => until > t));
    s[id] = t + Math.max(1, Math.min(24 * 30, hours)) * 3600_000;
    this.store.set('insight-snooze', s);
  }

  private all(): Insight[] { return insights({ ...this.inputs(), devices: this.reg.list(), offlineSince: this.offlineSince, openSince: this.openSince }); }

  /** What to show now (snoozed ones left out), and tell listeners about new ones worth a push. */
  current(): Insight[] {
    const t = this.inputs().now, sn = this.snoozes();
    const list = this.all().filter(i => !(sn[i.id] > t));
    const ids = new Set(list.map(i => i.id));
    // The first look after starting only remembers (a restart doesn't re-send everything).
    for (const i of list) if (!this.seen.has(i.id) && !this.first && i.push && i.level !== 'info') this.emit('new', i);
    this.seen = ids;
    this.first = false;
    return list;
  }

  glance(): Glance { return glance({ ...this.inputs(), devices: this.reg.list(), offlineSince: this.offlineSince }); }
}
