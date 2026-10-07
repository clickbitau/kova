import { UNASSIGNED_ROOM, WHOLE_HOME, type Command, type Device, type DeviceSettings, type FanSpeed, type HvacMode, type Room, type Zone } from '../model/types.ts';
import { isSensor } from './sensors.ts';

// Ducted air conditioners and the rooms their zones serve. A ducted unit usually serves the whole home (its place is
// WHOLE_HOME); each zone is a damper that the owner ties to one or more rooms (DeviceSettings.zoneRooms). Rooms then
// show and control "their" zone, and automations, modes and Ask Kova reach it as "zone:<room id>".

/**
 * What a room's zone target ("zone:<room>") asks: its zone open (on) or closed, how far open (0–100), and optionally
 * the air conditioner itself — `hvac`, `target` and `fanSpeed` set the unit (a mode also turns it on); `ac` turns the
 * whole unit on or off. Closing a room's zone leaves the unit alone unless that was the last zone open: then it goes off.
 */
export interface ZoneCommand { on?: boolean; open?: number; hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed; ac?: boolean }

const HVAC: HvacMode[] = ['cool', 'heat', 'dry', 'fan', 'auto'];
const FANS: FanSpeed[] = ['auto', 'quiet', 'low', 'medium', 'high', 'turbo'];
/** The fields a zone target takes. */
export const ZONE_FIELDS = ['on', 'open', 'hvac', 'target', 'fanSpeed', 'ac'] as const;

export const hasZones = (d: Pick<Device, 'capabilities'>) => d.capabilities.includes('zones');
/** A device that serves the whole home rather than one room. */
export const isWholeHome = (d: Pick<Device, 'room'>) => d.room === WHOLE_HOME;

/** Clean a zone target as someone sent it. Throws with a message a person can act on. */
export function cleanZoneCommand(v: unknown): ZoneCommand {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('A zone target is { on, open, hvac, target, fanSpeed, ac }');
  const x = v as Record<string, unknown>, out: ZoneCommand = {};
  for (const k of Object.keys(x)) if (!(ZONE_FIELDS as readonly string[]).includes(k)) throw new Error(`${k} isn’t something a zone can do`);
  if (x.on !== undefined) { if (typeof x.on !== 'boolean') throw new Error('Zone on must be true or false'); out.on = x.on; }
  if (x.ac !== undefined) { if (typeof x.ac !== 'boolean') throw new Error('ac must be true or false'); out.ac = x.ac; }
  if (x.open !== undefined && x.open !== null && x.open !== '') {
    const n = Number(x.open);
    if (!Number.isFinite(n)) throw new Error('How far open is 0–100');
    out.open = Math.max(0, Math.min(100, Math.round(n)));
  }
  if (x.hvac !== undefined) { if (!HVAC.includes(x.hvac as HvacMode)) throw new Error(`${String(x.hvac)} isn’t a climate mode`); out.hvac = x.hvac as HvacMode; }
  if (x.fanSpeed !== undefined) { if (!FANS.includes(x.fanSpeed as FanSpeed)) throw new Error(`${String(x.fanSpeed)} isn’t a fan speed`); out.fanSpeed = x.fanSpeed as FanSpeed; }
  if (x.target !== undefined && x.target !== null && x.target !== '') {
    const n = Number(x.target);
    if (!Number.isFinite(n) || n < 16 || n > 32) throw new Error('The set temperature is 16–32°');
    out.target = Math.round(n * 2) / 2;
  }
  if (!Object.keys(out).length) throw new Error('Say what the zone should do');
  return out;
}

/** A zone target in words: "open 50%, AC cool 23°", "closed". */
export function zoneCommandWords(c: ZoneCommand): string {
  const zone = c.on === false ? 'closed' : c.open != null ? (c.open === 0 ? 'closed' : `open ${c.open}%`) : c.on ? 'open' : '';
  const unit = [c.hvac ?? (c.ac ? 'on' : ''), c.target != null ? `${c.target}°` : '', c.fanSpeed ? `fan ${c.fanSpeed}` : ''].filter(Boolean).join(' ');
  const ac = c.ac === false ? 'AC off' : unit ? `AC ${unit}` : '';
  return [zone, ac].filter(Boolean).join(', ') || 'as it is';
}

// ------------------------------------------------------------- suggesting --

const FILLER = new Set(['room', 'rooms', 'the', 'zone', 'area', 'a']);
const words = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !FILLER.has(w));
const subset = (a: string[], b: string[]) => a.length > 0 && a.every(w => b.includes(w));

/** The rooms one part of a zone's name means: the room called that, else the one room whose name has those words. */
function roomsFor(part: string, rooms: Room[]): string[] {
  const pw = words(part);
  if (!pw.length) return [];
  const squash = pw.join('');
  const exact = rooms.filter(r => { const rw = words(r.name); return rw.join(' ') === pw.join(' ') || rw.join('') === squash || words(r.id).join(' ') === pw.join(' '); });
  if (exact.length) return exact.map(r => r.id);
  const close = rooms.filter(r => { const rw = words(r.name); return subset(pw, rw) || subset(rw, pw); });
  return close.length === 1 ? [close[0].id] : [];
}

/**
 * Rooms for each named zone, from the names: "Living" → the Living room, "Office & Guest" → the Office and the Guest
 * room. Only zones whose name points at a room (unambiguously) get one; the owner confirms them.
 */
export function suggestZoneRooms(names: Record<string, string>, rooms: Room[]): Record<string, string[]> {
  const real = rooms.filter(r => r.id !== WHOLE_HOME && r.id !== UNASSIGNED_ROOM);
  const out: Record<string, string[]> = {};
  for (const [n, name] of Object.entries(names)) {
    const ids = [...new Set(name.split(/\s*(?:&|\+|,|\/|\band\b)\s*/i).flatMap(p => roomsFor(p, real)))];
    if (ids.length) out[n] = ids;
  }
  return out;
}

// ----------------------------------------------------------------- rooms --

type Settings = Record<string, DeviceSettings>;

/** The zones that serve a room, on every zoned air conditioner: [device, zone number]. */
export function zonesServing(room: string, devices: Iterable<Device>, settings: Settings): { d: Device; n: number }[] {
  const out: { d: Device; n: number }[] = [];
  for (const d of devices) {
    if (!hasZones(d) || d.archived) continue;
    for (const [n, rs] of Object.entries(settings[d.id]?.zoneRooms ?? {})) if (rs.includes(room)) out.push({ d, n: Number(n) });
  }
  return out;
}

const zoneOf = (d: Device, n: number): Zone | undefined => d.state.zones?.find(z => z.n === n);
const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;

/**
 * A room's reading (temperature, humidity, light), as its climate summary shows it: from its sensors (the average
 * when there are several); without one, a device there that senses the room; for temperature, then the zone that
 * serves it, where the zone has its own sensor. A whole-home unit's own reading is never one room's.
 * `as`: a device's state to use in place of its current one (the state before a change, for triggers).
 */
export function roomReading(room: string, field: 'temp' | 'humidity' | 'lux', devices: Device[], settings: Settings, as?: { id: string; state: Device['state'] }): { value: number | null; from: string[] } {
  const st = (d: Device) => as && as.id === d.id ? as.state : d.state;
  const live = devices.filter(d => !d.hidden && !d.archived && st(d).online !== false);
  const here = live.filter(d => d.room === room);
  const has = (d: Device) => typeof st(d)[field] === 'number';
  const sensors = here.filter(d => isSensor(d) && has(d));
  const from = sensors.length ? sensors : here.filter(has);
  if (from.length) return { value: avg(from.map(d => st(d)[field] as number)), from: from.map(d => d.id) };
  if (field !== 'temp') return { value: null, from: [] };
  const zs = zonesServing(room, live, settings).map(({ d, n }) => ({ d, z: st(d).zones?.find(z => z.n === n) })).filter(x => typeof x.z?.temp === 'number');
  return { value: avg(zs.map(x => x.z!.temp!)), from: [...new Set(zs.map(x => x.d.id))] };
}

/** One zone as a room shows it: the zone, and the air conditioner it's on. */
export interface RoomZone {
  device: string;
  deviceName: string;
  n: number;
  /** What the owner calls it ("Living"), else "Zone 3". */
  name: string;
  on: boolean;
  open: number | null;
  temp: number | null;
  /** Every room the zone serves (this one among them). */
  rooms: string[];
  ac: { on: boolean; hvac: HvacMode | null; target: number | null; temp: number | null; fanSpeed: FanSpeed | null; online: boolean };
  /** A sensible way to turn the unit on for this room, when it's off: the mode and set temperature. */
  suggest: { hvac: HvacMode; target: number };
}

/**
 * How to run the unit for a room: cool when the room is warm (25° and up), heat when it's cool (19° and under), else
 * what the unit last did. The set temperature stays the unit's when it's a comfortable one for that mode.
 */
export function sensibleMode(ac: Pick<Device['state'], 'hvac' | 'target'>, roomTemp: number | null): { hvac: HvacMode; target: number } {
  const hvac: HvacMode = roomTemp != null && roomTemp >= 25 ? 'cool' : roomTemp != null && roomTemp <= 19 ? 'heat' : ac.hvac ?? 'auto';
  const t = typeof ac.target === 'number' ? ac.target : null;
  const target = hvac === 'cool' ? (t != null && t >= 20 && t <= 26 ? t : 24) : hvac === 'heat' ? (t != null && t >= 18 && t <= 24 ? t : 21) : (t != null && t >= 18 && t <= 26 ? t : 23);
  return { hvac, target };
}

/** Each room's zones, for the room cards and pages. */
export function roomZones(rooms: Room[], devices: Device[], settings: Settings): Record<string, RoomZone[]> {
  const out: Record<string, RoomZone[]> = {};
  for (const r of rooms) {
    const zs = zonesServing(r.id, devices, settings);
    if (!zs.length) continue;
    const temp = roomReading(r.id, 'temp', devices, settings).value;
    out[r.id] = zs.map(({ d, n }) => {
      const z = zoneOf(d, n), s = d.state;
      return {
        device: d.id, deviceName: d.name, n, name: settings[d.id]?.zoneNames?.[String(n)] || `Zone ${n}`,
        on: !!z?.on, open: z?.open ?? null, temp: typeof z?.temp === 'number' ? z.temp : null,
        rooms: settings[d.id]?.zoneRooms?.[String(n)] ?? [r.id],
        ac: { on: !!s.on, hvac: s.hvac ?? null, target: s.target ?? null, temp: s.temp ?? null, fanSpeed: s.fanSpeed ?? null, online: s.online !== false },
        suggest: sensibleMode(s, temp),
      };
    });
  }
  return out;
}

// --------------------------------------------------------------- targets --

/**
 * A room's zone target as device commands: the zones serving the room on each unit (zoneSet), and the unit's own
 * power, mode, set temperature and fan when asked. Nothing for a room no zone serves.
 */
export function zoneCommands(room: string, cmd: ZoneCommand, devices: Iterable<Device>, settings: Settings): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const { d, n } of zonesServing(room, devices, settings)) {
    const c = (out[d.id] ??= {});
    const on = cmd.on ?? (cmd.open != null ? cmd.open > 0 : undefined);
    const z: { on?: boolean; open?: number } = {};
    if (on !== undefined) z.on = on;
    if (cmd.open != null && on !== false) z.open = cmd.open;
    if (Object.keys(z).length) c.zoneSet = { ...(c.zoneSet ?? {}), [String(n)]: z };
    if (cmd.ac === false) c.on = false;
    else if (cmd.ac === true || cmd.hvac) c.on = true;
    if (cmd.ac !== false) {
      if (cmd.hvac) c.hvac = cmd.hvac;
      if (cmd.target != null) c.target = cmd.target;
      if (cmd.fanSpeed) c.fanSpeed = cmd.fanSpeed;
    }
  }
  for (const [id, c] of Object.entries(out)) if (!Object.keys(c).length) delete out[id];
  return out;
}

/** Put one command into a set of expanded targets, merging zone changes with ones already there for that unit. */
export function mergeCommand(into: Record<string, Command>, id: string, c: Command): void {
  const was = into[id];
  if (!was) { into[id] = c; return; }
  into[id] = { ...was, ...c, ...(was.zoneSet || c.zoneSet ? { zoneSet: { ...(was.zoneSet ?? {}), ...(c.zoneSet ?? {}) } } : {}) };
}

/** After these zone changes, would every zone of the unit be closed? */
export function allClosedAfter(d: Device, zoneSet: NonNullable<Command['zoneSet']>): boolean {
  const zs = d.state.zones ?? [];
  if (!zs.length) return false;
  return zs.every(z => (zoneSet[String(z.n)]?.on ?? z.on) === false);
}
