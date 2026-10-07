import type { AlertPrefs, AlertWhen, Capability, Device, DeviceSettings, DeviceState, HomeConfig, Room, RoomEventKind } from '../model/types.ts';

// What a device is to the owner: something to control (a device), something that only tells (a sensor), or a
// camera. A sensor is anything with no capability that can be controlled, that only reports readings or events:
// a thermometer, a motion or door sensor, a power meter, a solar inverter. A controllable device with readings
// (an air conditioner with its room temperature, a plug that measures power) stays a device; its readings still
// feed the room.

export type DeviceKind = 'device' | 'sensor' | 'camera';

/** Capabilities that mean Kova can change something on the device. */
const CONTROLS = new Set<Capability>(['onoff', 'brightness', 'colorTemp', 'color', 'fanMode', 'media', 'volume', 'vacuum', 'pause', 'library', 'input', 'queue', 'mute', 'sound', 'climate', 'zones', 'purifier']);

export function kindOf(d: Pick<Device, 'type' | 'capabilities'>): DeviceKind {
  if (d.type === 'camera') return 'camera';
  if (d.type === 'sensor') return 'sensor';
  return d.capabilities.some(c => CONTROLS.has(c)) ? 'device' : 'sensor';
}
export const isSensor = (d: Pick<Device, 'type' | 'capabilities'>) => kindOf(d) === 'sensor';
export const isCamera = (d: Pick<Device, 'type'>) => d.type === 'camera';
/** Devices people control: not sensors, not cameras. */
export const isControllable = (d: Pick<Device, 'type' | 'capabilities'>) => kindOf(d) === 'device';

// ---------------------------------------------------------------- readings --

/** A reading Kova shows for a sensor, and the room it's in. */
export type ReadingField = 'temp' | 'humidity' | 'lux' | 'pm25' | 'airQuality' | 'power' | 'energy' | 'battery' | 'motion' | 'open' | 'internet';

export interface Reading {
  field: ReadingField;
  label: string;
  /** Number or on/off; null when the sensor hasn't said yet. */
  value: number | boolean | null;
  unit: string;
  /** "22.4°", "48%", "Motion", "Open". */
  text: string;
}

/** Numeric readings that can go up and down over time (for trends and history). */
export const NUMERIC_READINGS: ReadingField[] = ['temp', 'humidity', 'lux', 'pm25', 'airQuality', 'power', 'energy', 'battery'];

const AIR: Record<number, string> = { 1: 'Good', 2: 'Moderate', 3: 'Poor', 4: 'Very poor' };
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
const watts = (w: number) => Math.abs(w) >= 1000 ? `${round(w / 1000, 1)} kW` : `${Math.round(w)} W`;

/** One reading in words, or null when the device doesn't have it. */
export function reading(d: Pick<Device, 'id' | 'state' | 'capabilities' | 'type'>, f: ReadingField): Reading | null {
  const s = d.state as DeviceState & Record<string, unknown>;
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  switch (f) {
    case 'temp': { const v = n(s.temp); return v == null ? null : { field: f, label: 'Temperature', value: round(v, 1), unit: '°C', text: `${round(v, 1)}°` }; }
    case 'humidity': { const v = n(s.humidity); return v == null ? null : { field: f, label: 'Humidity', value: Math.round(v), unit: '%', text: `${Math.round(v)}%` }; }
    case 'lux': { const v = n(s.lux); return v == null ? null : { field: f, label: 'Light', value: Math.round(v), unit: 'lx', text: `${Math.round(v)} lx` }; }
    case 'pm25': { const v = n(s.pm25); return v == null ? null : { field: f, label: 'PM2.5', value: v, unit: 'µg/m³', text: `${v} µg/m³` }; }
    case 'airQuality': { const v = n(s.airQuality); return v == null ? null : { field: f, label: 'Air', value: v, unit: '', text: AIR[v] ?? String(v) }; }
    case 'power': { const v = n(s.power); return v == null && !d.capabilities.includes('power') ? null : { field: f, label: 'Power', value: v, unit: 'W', text: v == null ? '—' : watts(v) }; }
    case 'energy': { const v = n(s.energy); return v == null ? null : { field: f, label: 'Energy today', value: v, unit: 'kWh', text: `${round(v, 1)} kWh` }; }
    case 'battery': { const v = n(s.battery); return v == null ? null : { field: f, label: 'Battery', value: Math.round(v), unit: '%', text: `${Math.round(v)}%` }; }
    case 'motion': return typeof s.motion === 'boolean' ? { field: f, label: 'Motion', value: s.motion, unit: '', text: s.motion ? 'Motion' : 'Clear' } : null;
    case 'open': return typeof s.open === 'boolean' ? { field: f, label: 'Contact', value: s.open, unit: '', text: s.open ? 'Open' : 'Closed' } : null;
    // A router's view of the internet (the Warden device): on = connected.
    case 'internet': return d.type === 'sensor' && d.id.endsWith('_internet') && typeof s.on === 'boolean' ? { field: f, label: 'Internet', value: s.on, unit: '', text: s.on ? 'Connected' : 'Down' } : null;
  }
}

/** Everything a device reports, the most telling first (battery last: it's about the sensor, not the room). */
export function readingsOf(d: Pick<Device, 'id' | 'state' | 'capabilities' | 'type'>): Reading[] {
  const order: ReadingField[] = ['internet', 'open', 'motion', 'temp', 'humidity', 'lux', 'pm25', 'airQuality', 'power', 'energy', 'battery'];
  return order.map(f => reading(d, f)).filter((r): r is Reading => !!r);
}

/** What a sensor mostly is, for its icon and how it's shown. */
export type SensorKind = 'climate' | 'motion' | 'contact' | 'light' | 'air' | 'energy' | 'network' | 'sound' | 'other';

export function sensorKind(d: Pick<Device, 'id' | 'state' | 'capabilities' | 'type'>): SensorKind {
  const s = d.state;
  if (reading(d, 'internet')) return 'network';
  if (typeof s.open === 'boolean') return 'contact';
  if (typeof s.motion === 'boolean') return 'motion';
  if (typeof s.temp === 'number' || typeof s.humidity === 'number') return 'climate';
  if (typeof s.airQuality === 'number' || typeof s.pm25 === 'number') return 'air';
  if (d.capabilities.includes('power') || d.capabilities.includes('energy') || typeof s.power === 'number') return 'energy';
  if (typeof s.lux === 'number') return 'light';
  if (s.extras && 'detected' in s.extras) return 'sound';
  return 'other';
}

export const SENSOR_ICON: Record<SensorKind, string> = {
  climate: 'thermostat', motion: 'sensors', contact: 'sensor_door', light: 'light_mode', air: 'air', energy: 'electric_meter', network: 'router', sound: 'graphic_eq', other: 'sensors',
};

// --------------------------------------------------------------- placement --

/** Room icons that are outside the living space. */
const OUTDOOR_ICONS = new Set(['door_front', 'yard', 'garage_home', 'deck', 'balcony']);

export const roomOutdoor = (r: Pick<Room, 'icon' | 'outdoor'> | undefined): boolean => r?.outdoor ?? (r ? OUTDOOR_ICONS.has(r.icon) : false);

/** A doorbell, by what its integration or the owner calls it. */
export const isDoorbell = (d: Pick<Device, 'name' | 'integration'>) => /doorbell/i.test(`${d.integration} ${d.name}`);

/** Whether a camera or sensor is outside: the owner's choice, else a doorbell, else its room. */
export function isOutdoor(d: Pick<Device, 'id' | 'room' | 'name' | 'integration'>, cfg: Pick<HomeConfig, 'rooms' | 'devices'>): boolean {
  const own = cfg.devices?.[d.id]?.outdoor;
  if (typeof own === 'boolean') return own;
  if (isDoorbell(d)) return true;
  return roomOutdoor(cfg.rooms.find(r => r.id === d.room));
}

// ------------------------------------------------------------------ alerts --

export const ALERT_KINDS: RoomEventKind[] = ['person', 'ring', 'package', 'vehicle', 'animal', 'motion', 'sound', 'opened'];
export const ALERT_WHEN: AlertWhen[] = ['always', 'away', 'never'];

/**
 * Kova's defaults, by where the camera or sensor is: someone at the door or outside always; inside only while
 * nobody's home; motion only while nobody's home (and never outside, where trees and cars move); a door opening
 * while nobody's home; vehicles, animals and sounds only when asked.
 */
export function defaultAlert(kind: RoomEventKind, outdoor: boolean): AlertWhen {
  switch (kind) {
    case 'ring': return 'always';
    case 'person': return outdoor ? 'always' : 'away';
    case 'package': return 'always';
    case 'motion': return outdoor ? 'never' : 'away';
    case 'opened': return 'away';
    default: return 'never';
  }
}

/** When an event of this kind from this device alerts: the device's own choice, then the room's, then Kova's default. */
export function alertWhen(d: Pick<Device, 'id' | 'room' | 'name' | 'integration'>, kind: RoomEventKind, cfg: Pick<HomeConfig, 'rooms' | 'devices' | 'security'>): AlertWhen {
  return cfg.devices?.[d.id]?.alerts?.[kind] ?? cfg.security?.rooms?.[d.room]?.[kind] ?? defaultAlert(kind, isOutdoor(d, cfg));
}

/** Every kind's resolved choice for a device, and which were set by the owner. */
export function alertsFor(d: Pick<Device, 'id' | 'room' | 'name' | 'integration'>, cfg: Pick<HomeConfig, 'rooms' | 'devices' | 'security'>, kinds = ALERT_KINDS): Record<string, { when: AlertWhen; from: 'device' | 'room' | 'default' }> {
  const own: AlertPrefs = cfg.devices?.[d.id]?.alerts ?? {}, room: AlertPrefs = cfg.security?.rooms?.[d.room] ?? {};
  return Object.fromEntries(kinds.map(k => [k, { when: alertWhen(d, k, cfg), from: own[k] ? 'device' : room[k] ? 'room' : 'default' }]));
}

/** Clean an alerts object from the API: known kinds, known choices. Throws with a message a person can act on. */
export function cleanAlerts(v: unknown): AlertPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('alerts is { person: "always" | "away" | "never", … }');
  const out: AlertPrefs = {};
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (![...ALERT_KINDS, 'closed'].includes(k as RoomEventKind)) throw new Error(`${k} isn’t an event Kova alerts on`);
    if (w === null || w === undefined || w === '') continue;
    if (!ALERT_WHEN.includes(w as AlertWhen)) throw new Error(`${k}: choose always, away or never`);
    out[k as RoomEventKind] = w as AlertWhen;
  }
  return out;
}

/** Settings that matter to the camera and sensor screens: placement and alerts. */
export const sensorSettings = (s: DeviceSettings | undefined) => ({ ...(typeof s?.outdoor === 'boolean' ? { outdoor: s.outdoor } : {}), ...(s?.alerts ? { alerts: s.alerts } : {}) });
