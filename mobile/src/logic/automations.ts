// Automations on the phone: the shapes the hub sends (hub/src/model/types.ts), and the editor's logic kept free
// of React Native so the tests can run it under plain Node. Everything Kova's assistant can build
// (hub/src/assistant/ai.ts: set_devices, create_automation) can be built here by hand, and what the hub accepts
// (hub/src/engine/automation-check.ts) is what the editor offers: every field a device can be set to, state
// matches, readings, events, every kind of trigger, condition and step, and one-time schedules.
import type { Command, Device, Room, RoomStatus } from '../api/types';
import { isCamera, isSensor } from './sensors.ts';
import { WHOLE_HOME, WHOLE_HOME_NAME, ZONE_FIELDS, ZONE_PRESETS, zoneCommandWords, zoneTargetOptions, type ZoneCommand } from './zones.ts';

// ------------------------------------------------------------------ shapes --

export interface StateMatch {
  on?: boolean; online?: boolean; input?: string; hvac?: string; activity?: string; playing?: boolean; muted?: boolean; mode?: string;
  /** Motion sensors: detecting motion now (true) or clear. Door and window sensors: open (true) or closed. */
  motion?: boolean; open?: boolean;
}
export type NumericField = 'temp' | 'target' | 'power' | 'energy' | 'battery' | 'bri' | 'vol' | 'grid' | 'load' | 'humidity' | 'lux' | 'pm25';
export type SunEvent = 'sunrise' | 'sunset' | 'dawn' | 'dusk';
export type Prayer = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
export type Rhythm = { kind: 'time'; at: string } | { kind: 'sun'; event: SunEvent; offsetMin?: number } | { kind: 'prayer'; prayer: Prayer; offsetMin?: number };
/** What to set each device (or every matching device: "type:light", "room:lounge") to. */
export type Targets = Record<string, Command>;

/** What a room's cameras and sensors notice (hub engine/rooms.ts). */
export type RoomEvent = 'person' | 'motion' | 'ring' | 'vehicle' | 'animal' | 'package' | 'sound' | 'opened' | 'closed';
export const ROOM_EVENT_WORDS: Record<RoomEvent, string> = { motion: 'motion (or a person)', person: 'a person', ring: 'the doorbell', opened: 'a door or window opens', closed: 'a door or window closes', package: 'a package', vehicle: 'a vehicle', animal: 'an animal', sound: 'a sound' };
/** A room trigger in words, after "When": "there’s motion in the Hall", "a door or window opens in the Front door". */
const ROOM_TRIGGER_WORDS: Record<RoomEvent, (room: string) => string> = {
  motion: r => `there’s motion in ${r}`, person: r => `a person is seen in ${r}`, ring: r => `the doorbell rings in ${r}`, opened: r => `a door or window opens in ${r}`,
  closed: r => `a door or window closes in ${r}`, package: r => `a package is seen in ${r}`, vehicle: r => `a vehicle is seen in ${r}`, animal: r => `an animal is seen in ${r}`, sound: r => `a sound is heard in ${r}`,
};
/** How long a room counts as active after its last sign of someone, unless a condition says (hub engine/rooms.ts ACTIVE_MIN). */
export const ACTIVE_MIN = 10;

export type Trigger =
  | { kind: 'device'; device: string; to?: StateMatch; from?: StateMatch; forSec?: number }
  | { kind: 'numeric'; device: string; field: NumericField; above?: number; below?: number; forSec?: number }
  | { kind: 'event'; device: string; event: string }
  /** Anything a camera or sensor in the room notices; motion includes a person seen. */
  | { kind: 'room'; room: string; event: RoomEvent }
  | { kind: 'time'; at: Rhythm; days?: number[] }
  | { kind: 'every'; minutes: number }
  | { kind: 'presence'; event: 'arrives' | 'leaves' | 'first-arrives' | 'last-leaves'; person?: string }
  | { kind: 'mode'; mode: string }
  | { kind: 'overlay'; overlay: string; event: 'starts' | 'ends' }
  | { kind: 'hub'; event: 'start' }
  /** Once, at a date and time on the home's clock ("2026-10-08T15:30"). The hub stamps firedAt (and missed). */
  | { kind: 'once'; at: string; firedAt?: number; missed?: boolean };

export type Condition =
  | { kind: 'device'; device: string; is: StateMatch }
  | { kind: 'numeric'; device: string; field: NumericField; above?: number; below?: number }
  | { kind: 'time'; after?: Rhythm; before?: Rhythm; days?: number[] }
  | { kind: 'presence'; who: string; home: boolean }
  | { kind: 'mode'; modes: string[] }
  | { kind: 'overlay'; overlay?: string; active: boolean }
  /** A room had activity in the last withinMin minutes (default 10), or not. */
  | { kind: 'room'; room: string; active: boolean; withinMin?: number }
  | { kind: 'all' | 'any' | 'not'; conditions: Condition[] };

export type RampField = 'bri' | 'vol' | 'target';
export type Action =
  | { kind: 'set'; targets: Targets }
  | { kind: 'delay'; seconds: number }
  | { kind: 'wait'; until: Condition; timeoutSec?: number; stopOnTimeout?: boolean }
  | { kind: 'notify'; title?: string; message: string; people?: string[] }
  | { kind: 'overlay'; overlay: string; op: 'start' | 'end' }
  | { kind: 'if'; conditions: Condition[]; then: Action[]; else?: Action[] }
  | { kind: 'repeat'; times: number; actions: Action[] }
  | { kind: 'ramp'; targets: Targets; field: RampField; to: number; from?: number; overSec: number; stepSec?: number; /** Devices easing to their own end (learned), by id. */ toFor?: Record<string, number> }
  | { kind: 'run'; automation: string }
  | { kind: 'stop' };

export type RunMode = 'single' | 'restart' | 'queued' | 'parallel';
export type RunResult = 'running' | 'done' | 'stopped' | 'skipped' | 'cancelled' | 'failed';

/** What the editor works on: an automation without its id (new ones have none yet). */
export interface Draft {
  name: string;
  description?: string;
  enabled: boolean;
  mode: RunMode;
  triggers: Trigger[];
  conditions: Condition[];
  actions: Action[];
  origin?: { from: 'home-assistant'; id: string; notes?: string[] };
}
export interface Automation extends Draft { id: string }

export interface AutomationRun {
  id: string; automation: string; at: number; why: string; result: RunResult; detail?: string;
  steps: { at: number; text: string; ok: boolean; detail?: string }[];
  endedAt?: number;
}

interface Words { triggerLabels?: string[]; conditionLabels?: string[]; actionLabels?: string[] }
/** An automation in the live snapshot: with each part in words, its last run and how many runs are going. */
export interface AutomationView extends Automation, Words {
  lastRun: { at: number; atLabel: string; result: RunResult; why: string; detail: string | null } | null;
  running: number;
  /** One-time schedules (every trigger is "once"): when the next one goes off, in words, and whether all have. */
  oneTime?: boolean;
  nextAt?: number | null;
  nextLabel?: string | null;
  done?: boolean;
}
/** A suggestion from the hub (an ordinary automation to add, change or dismiss). */
export interface Idea extends Omit<Draft, 'enabled'>, Words { key: string; why: string }
/** A Home Assistant automation from the last import (GET /api/import/ha/automations). */
export interface HaAutomation {
  id: string; name: string; enabled: boolean; when: string[]; cond: string[]; then: string[];
  converted: string | null; notes: string[]; convertible: boolean;
}

// ------------------------------------------------------------ paths -------

/** Where a part sits in the draft: ['actions', 2, 'then', 0, 'conditions', 1]. */
export type Path = (string | number)[];

export function getAt(o: unknown, p: Path): unknown {
  return p.reduce<unknown>((x, k) => (x == null ? x : (x as Record<string | number, unknown>)[k]), o);
}

/** A copy of `o` with the value at `p` replaced (undefined removes an object key). Only the path is copied. */
export function setAt<T>(o: T, p: Path, v: unknown): T {
  if (!p.length) return v as T;
  const [k, ...rest] = p;
  const cur = (o ?? (typeof k === 'number' ? [] : {})) as Record<string | number, unknown>;
  const next = setAt(cur[k], rest, v);
  if (Array.isArray(cur)) { const a = cur.slice(); a[k as number] = next; return a as T; }
  const c = { ...cur };
  if (next === undefined) delete c[k]; else c[k] = next;
  return c as T;
}

/** Remove the list item or object key at `p`. */
export function removeAt<T>(o: T, p: Path): T {
  const parent = getAt(o, p.slice(0, -1)), k = p[p.length - 1];
  if (Array.isArray(parent)) return setAt(o, p.slice(0, -1), parent.filter((_, i) => i !== k));
  if (parent && typeof parent === 'object') { const c = { ...(parent as Record<string, unknown>) }; delete c[k as string]; return setAt(o, p.slice(0, -1), c); }
  return o;
}

/** Add to the end of the list at `p` (made if missing). */
export function pushAt<T>(o: T, p: Path, v: unknown): T {
  const l = getAt(o, p);
  return setAt(o, p, Array.isArray(l) ? [...l, v] : [v]);
}

/** Put a copy of the list item at `p` right after it. */
export function duplicateAt<T>(o: T, p: Path): T {
  const l = getAt(o, p.slice(0, -1)), i = p[p.length - 1] as number;
  if (!Array.isArray(l) || i < 0 || i >= l.length) return o;
  const a = l.slice();
  a.splice(i + 1, 0, clone(l[i]));
  return setAt(o, p.slice(0, -1), a);
}

/** Move the list item at `p` up (-1) or down (+1); unchanged at either end. */
export function moveAt<T>(o: T, p: Path, d: -1 | 1): T {
  const l = getAt(o, p.slice(0, -1)), i = p[p.length - 1] as number, j = i + d;
  if (!Array.isArray(l) || j < 0 || j >= l.length) return o;
  const a = l.slice();
  [a[i], a[j]] = [a[j], a[i]];
  return setAt(o, p.slice(0, -1), a);
}

/** Can the item at `p` move that way? */
export function canMove(o: unknown, p: Path, d: -1 | 1): boolean {
  const l = getAt(o, p.slice(0, -1)), j = (p[p.length - 1] as number) + d;
  return Array.isArray(l) && j >= 0 && j < l.length;
}

// ----------------------------------------------------------- choices ------

export type Opt<V = string> = { v: V; label: string };
const opts = <V extends string>(l: [V, string][]): Opt<V>[] => l.map(([v, label]) => ({ v, label }));

export const TRIGGER_KINDS = opts<Trigger['kind']>([['device', 'A device changes'], ['numeric', 'A reading goes above or below'], ['event', 'A device event'], ['room', 'Something happens in a room'], ['time', 'A time of day'], ['once', 'Once, at a date and time'], ['every', 'Every few minutes'], ['presence', 'Someone comes or goes'], ['mode', 'A mode starts'], ['overlay', 'An overlay starts or ends'], ['hub', 'Kova starts']]);
export const CONDITION_KINDS = opts<Condition['kind']>([['device', 'A device is'], ['numeric', 'A reading is above or below'], ['time', 'The time or day'], ['presence', 'Who’s home'], ['mode', 'The mode'], ['overlay', 'An overlay'], ['room', 'Activity in a room'], ['any', 'Any of these'], ['all', 'All of these'], ['not', 'None of these']]);
export const ACTION_KINDS = opts<Action['kind']>([['set', 'Set devices'], ['ramp', 'Ramp gradually'], ['delay', 'Wait a while'], ['wait', 'Wait until something is true'], ['notify', 'Send a notification'], ['overlay', 'Start or end an overlay'], ['if', 'If … otherwise …'], ['repeat', 'Repeat'], ['run', 'Run another automation'], ['stop', 'Stop here']]);
export const RUN_MODES = opts<RunMode>([['single', 'Ignore the new start'], ['restart', 'Start over'], ['queued', 'Run again after'], ['parallel', 'Run alongside']]);

/** An icon for each kind of part, so a long automation can be scanned. */
export const KIND_ICON: Record<string, string> = {
  'trigger:device': 'toggle_on', 'trigger:numeric': 'thermostat', 'trigger:event': 'notifications_active', 'trigger:room': 'sensors', 'trigger:time': 'schedule', 'trigger:once': 'timer',
  'trigger:every': 'autorenew', 'trigger:presence': 'person', 'trigger:mode': 'routine', 'trigger:overlay': 'layers', 'trigger:hub': 'power_settings_new',
  'condition:device': 'toggle_on', 'condition:numeric': 'thermostat', 'condition:time': 'schedule', 'condition:presence': 'person', 'condition:mode': 'routine',
  'condition:overlay': 'layers', 'condition:room': 'sensor_occupied', 'condition:any': 'call_split', 'condition:all': 'fact_check', 'condition:not': 'block',
  'action:set': 'tune', 'action:ramp': 'brightness_6', 'action:delay': 'timer', 'action:wait': 'pending', 'action:notify': 'notifications',
  'action:overlay': 'layers', 'action:if': 'call_split', 'action:repeat': 'repeat', 'action:run': 'play_arrow', 'action:stop': 'stop',
};

export const FIELDS = opts<NumericField>([['temp', 'temperature (°C)'], ['target', 'set temperature (°C)'], ['humidity', 'humidity (%)'], ['lux', 'light level (lux)'], ['pm25', 'PM2.5 (µg/m³)'], ['power', 'power (W)'], ['energy', 'energy today (kWh)'], ['grid', 'grid power (W, minus = exporting)'], ['load', 'home power use (W)'], ['battery', 'battery (%)'], ['bri', 'brightness (%)'], ['vol', 'volume (%)']]);
const FIELD_WORD: Record<NumericField, string> = { temp: 'temperature', target: 'set temperature', power: 'power', energy: 'energy today', battery: 'battery', bri: 'brightness', vol: 'volume', grid: 'grid power', load: 'home power', humidity: 'humidity', lux: 'light level', pm25: 'PM2.5' };
export const RAMP_FIELDS = opts<RampField>([['bri', 'Brightness'], ['vol', 'Volume'], ['target', 'Set temperature']]);
const RAMP_CAP: Record<RampField, string> = { bri: 'brightness', vol: 'volume', target: 'climate' };

export const EVENTS = opts([
  ['person', 'sees a person'], ['motion', 'detects motion'], ['ring', 'rings (doorbell)'],
  ['vehicle', 'sees a vehicle'], ['animal', 'sees an animal'], ['package', 'sees a package'], ['sound', 'hears a sound'],
  ['video-started', 'starts a video'], ['music-started', 'starts music'], ['paused', 'pauses'], ['resumed', 'carries on playing'], ['stopped', 'stops playing'], ['ended', 'finishes playing'],
  ['screen-asleep', 'screen goes to sleep'], ['screen-shutdown', 'screen shuts down'], ['screen-awake', 'screen wakes up'],
  ['internet-down', 'internet goes down'], ['internet-up', 'internet comes back'], ['internet-failover', 'switches to the backup connection'], ['new-device', 'a new device joins'], ['threat', 'blocks an attack'],
  ['power-supply-changed', 'a power supply changes'], ['power-supply-failed', 'a power supply fails'], ['power-supply-restored', 'a power supply comes back'],
]);
export const PRESENCE_EVENTS = opts<'arrives' | 'leaves' | 'first-arrives' | 'last-leaves'>([['arrives', 'comes home'], ['leaves', 'leaves'], ['first-arrives', 'first home (nobody was)'], ['last-leaves', 'last one out']]);
export const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The option list with the current value in it, even when it isn't one of the usual ones. */
export function withCurrent<V extends string>(list: Opt<V>[], cur: V | undefined): Opt<V>[] {
  return cur == null || cur === '' || list.some(o => o.v === cur) ? list : [...list, { v: cur, label: cur }];
}
export const labelOf = <V extends string>(list: Opt<V>[], v: V | undefined, fallback = '') => list.find(o => o.v === v)?.label ?? (v || fallback);

// ------------------------------------------------------------- devices ----

type Dev = Pick<Device, 'id' | 'type' | 'capabilities'> & { kind?: Device['kind']; name?: string; integration?: string; room?: string; state?: Partial<Device['state']>; zoneNames?: Record<string, string>; zoneRooms?: Record<string, string[]>; archived?: boolean };
const has = (d: { capabilities?: string[] }, c: string) => (d.capabilities ?? []).includes(c);
const isPlayerType = (t: string | undefined) => t === 'media' || t === 'tv';

/**
 * Devices a step can set. Cameras and sensors only report: a sensor is the hub's kind (a power meter is a plug
 * with nothing to control), or type sensor on an older hub.
 */
export const canSet = (d: Pick<Device, 'type'> & { kind?: Device['kind'] }) => !isCamera(d) && d.kind !== 'camera' && !isSensor(d);

/**
 * "type:light" / "room:lounge": every matching device, now and later. "zone:lounge": the air conditioner zone that
 * serves the room (logic/zones.ts), on whichever unit serves it when it runs. (A zone's own fields inside an air
 * conditioner's command are keyed by number in `zoneSet`, so they never meet these ids.)
 */
export const PSEUDO = /^(type|room|zone):(.+)$/;
export const isPseudo = (id: string) => PSEUDO.test(id);
const TYPE_WORDS: Record<string, string> = { light: 'All lights', dimmer: 'All dimmers', fan: 'All fans and purifiers', media: 'All media players', tv: 'All TVs', plug: 'All plugs', camera: 'All cameras', sensor: 'All sensors', vacuum: 'All vacuums', internet: 'Every device’s internet', climate: 'All air conditioners' };
/** A pseudo-target in words: "All lights", "Everything in the Lounge"; null for a device id. */
export function pseudoLabel(id: string, rooms: Pick<Room, 'id' | 'name'>[]): string | null {
  const m = PSEUDO.exec(id);
  if (!m) return null;
  if (m[1] === 'room') return `Everything in ${rooms.find(r => r.id === m[2])?.name ?? m[2]}`;
  if (m[1] === 'zone') return `${rooms.find(r => r.id === m[2])?.name ?? m[2]} zone`;
  return TYPE_WORDS[m[2]!] ?? `All ${m[2]}s`;
}
/** Does this device match a "type:" word? "light" includes dimmers, "media" includes TVs (as the hub has it). */
export const typeMatch = (d: Pick<Device, 'type'>, t: string) => d.type === t || (t === 'light' && (d.type === 'light' || d.type === 'dimmer')) || (t === 'media' && isPlayerType(d.type));

/** The groups a step can target: all of a type the home has, and each room with something settable in it. */
export function pseudoTargets(devices: (Pick<Device, 'type' | 'room'> & { kind?: Device['kind'] })[], rooms: Pick<Room, 'id' | 'name'>[]): Opt[] {
  const settable = devices.filter(canSet);
  const types = new Set<string>();
  for (const d of settable) { types.add(d.type === 'dimmer' ? 'light' : d.type === 'tv' ? 'media' : d.type); if (d.type === 'tv') types.add('tv'); }
  const order = ['light', 'media', 'tv', 'climate', 'fan', 'plug', 'vacuum', 'internet'];
  const t = order.filter(x => types.has(x)).map(x => ({ v: `type:${x}`, label: TYPE_WORDS[x] ?? x }));
  const r = rooms.filter(rm => settable.some(d => d.room === rm.id)).map(rm => ({ v: `room:${rm.id}`, label: `Everything in ${rm.name}` }));
  return [...t, ...r];
}
/** The "<Room> zone" targets: each room an air conditioner zone serves (confirmed in the unit's panel). */
export const zoneTargets = zoneTargetOptions;

/** What a type can usually do, for a group with no such device yet. */
const TYPE_CAPS: Record<string, string[]> = {
  light: ['onoff', 'brightness', 'colorTemp', 'color'], dimmer: ['onoff', 'brightness'], fan: ['onoff', 'fanMode'], media: ['onoff', 'media', 'volume', 'pause'],
  tv: ['onoff', 'media', 'volume', 'input', 'mute'], plug: ['onoff'], camera: [], sensor: [], vacuum: ['onoff', 'vacuum'], internet: ['onoff'], climate: ['onoff', 'climate'],
};

/** A target (a device or a group) as the editor needs it: what it can do, and the devices behind it. */
export interface TargetInfo { id: string; label: string; caps: Set<string>; devices: Dev[]; type?: string; pseudo: boolean; missing: boolean }
export function targetInfo(id: string, devices: Dev[], rooms: Pick<Room, 'id' | 'name'>[]): TargetInfo {
  const m = PSEUDO.exec(id);
  // A room's zone: the zoned units serving it now are its devices; what it takes is the zone's fields (ZONE_FIELDS).
  if (m && m[1] === 'zone') {
    const units = devices.filter(d => !d.archived && (d.capabilities ?? []).includes('zones') && Object.values(d.zoneRooms ?? {}).some(rs => rs.includes(m[2]!)));
    return { id, label: pseudoLabel(id, rooms)!, caps: new Set(['zone']), devices: units, type: 'zone', pseudo: true, missing: !rooms.some(r => r.id === m[2]) };
  }
  if (m) {
    const list = devices.filter(d => canSet(d) && (m[1] === 'room' ? d.room === m[2] : typeMatch(d, m[2]!)));
    const caps = new Set<string>(list.flatMap(d => d.capabilities ?? []));
    if (!list.length && m[1] === 'type') for (const c of TYPE_CAPS[m[2]!] ?? ['onoff']) caps.add(c);
    if (!list.length && m[1] === 'room') caps.add('onoff');
    return { id, label: pseudoLabel(id, rooms)!, caps, devices: list, type: m[1] === 'type' ? m[2] : undefined, pseudo: true, missing: m[1] === 'room' && !rooms.some(r => r.id === m[2]) };
  }
  const d = devices.find(x => x.id === id);
  return { id, label: d?.name ?? id, caps: new Set(d?.capabilities ?? []), devices: d ? [d] : [], type: d?.type, pseudo: false, missing: !d };
}

// ------------------------------------------------------------ commands ----

export const INPUT_NAMES: Record<string, string> = { tv: 'TV', hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };
const TV_INPUTS = ['tv', 'hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'];
const BAR_INPUTS = ['tv', 'hdmi1', 'hdmi2', 'bluetooth', 'wifi'];
export const SOUND_MODES = opts([['standard', 'Standard'], ['surround', 'Surround'], ['game', 'Game'], ['adaptive', 'Adaptive']]);
export const HVAC_MODES = opts([['cool', 'Cool'], ['heat', 'Heat'], ['dry', 'Dry'], ['fan', 'Fan'], ['auto', 'Auto']]);
export const FAN_SPEEDS = opts([['auto', 'Auto'], ['quiet', 'Quiet'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['turbo', 'Turbo']]);
export const FAN_MODES = opts([['Auto', 'Auto'], ['Sleep', 'Sleep'], ['Manual', 'Manual']]);
export const ACTIVITIES = opts([['cleaning', 'Cleaning'], ['returning', 'Returning'], ['docked', 'Docked'], ['paused', 'Paused'], ['idle', 'Idle'], ['error', 'Needs attention']]);
const VAC_COMMANDS = opts([['cleaning', 'Clean'], ['returning', 'Go back to the dock'], ['paused', 'Pause']]);

/** The inputs a device can switch to: a soundbar's (it has `sound`) or a TV's, with any it reports now. */
export function inputsOf(t: { caps: Set<string>; devices: Dev[] }, cur?: string | null): Opt[] {
  const base = t.caps.has('sound') ? BAR_INPUTS : TV_INPUTS;
  const ids = [...base];
  for (const d of t.devices) { const i = d.state?.input; if (typeof i === 'string' && i && !ids.includes(i)) ids.push(i); }
  if (cur && !ids.includes(cur)) ids.push(cur);
  return ids.map(v => ({ v, label: v === 'tv' && t.caps.has('sound') ? 'TV (eARC)' : INPUT_NAMES[v] ?? v }));
}

export type FieldKind = 'bool' | 'number' | 'choice' | 'color' | 'media' | 'zones' | 'extras';
/** One thing a step can set on a device: how it's shown and what it can be. */
export interface CmdField {
  key: string; label: string; icon: string; kind: FieldKind;
  min?: number; max?: number; step?: number; unit?: string;
  /** For bool: the words for true and false ("On" / "Off", "Pause" / "Play"). */
  yes?: string; no?: string;
  options?: Opt[];
}

/** Every field a command can carry, in the order they're shown, and the capability each needs (the hub's FIELD_CAP). */
export const CMD_ORDER = ['on', 'bri', 'k', 'color', 'hvac', 'target', 'fanSpeed', 'mode', 'fanLevel', 'activity', 'media', 'shuffle', 'paused', 'skip', 'vol', 'volStep', 'muted', 'input', 'sound', 'night', 'zoneSet', 'display', 'childLock', 'extras'] as const;
export const FIELD_CAP: Record<string, string> = {
  on: 'onoff', bri: 'brightness', k: 'colorTemp', color: 'color', mode: 'fanMode', media: 'media', vol: 'volume', paused: 'pause', input: 'input', skip: 'queue', shuffle: 'queue',
  muted: 'mute', sound: 'sound', night: 'sound', volStep: 'volume', hvac: 'climate', target: 'climate', fanSpeed: 'climate', zoneSet: 'zones', extras: 'extras',
  fanLevel: 'purifier', display: 'purifier', childLock: 'purifier', activity: 'vacuum',
};
const canDo = (caps: Set<string>, key: string) => {
  const c = FIELD_CAP[key];
  if (!c) return false;
  if (caps.has(c)) return true;
  if (key === 'color' && caps.has('colorTemp')) return true;
  if (key === 'media' && caps.has('library')) return true;
  return false;
};

/** The highest fan level among the devices (purifiers), default 3. */
const levelMax = (devs: Dev[]) => { const m = Math.max(0, ...devs.map(d => Number(d.state?.fanLevelMax) || 0)); return m > 1 ? m : 3; };

/** How each field is edited, for this target. */
export function fieldSpec(key: string, t: TargetInfo, cur?: unknown): CmdField {
  const choice = (label: string, icon: string, options: Opt[]): CmdField => ({ key, label, icon, kind: 'choice', options: typeof cur === 'string' ? withCurrent(options, cur) : options });
  if (t.type === 'zone') {
    if (key === 'on') return { key, label: 'Zone', icon: 'ac_unit', kind: 'bool', yes: 'Open', no: 'Closed' };
    if (key === 'open') return { key, label: 'How far open', icon: 'tune', kind: 'number', min: 0, max: 100, step: 5, unit: '%' };
    if (key === 'ac') return { key, label: 'Air conditioner', icon: 'power_settings_new', kind: 'bool', yes: 'On', no: 'Off' };
  }
  switch (key) {
    case 'on': return { key, label: t.type === 'internet' ? 'Internet' : t.type === 'vacuum' ? 'Cleaning' : 'Power', icon: 'power_settings_new', kind: 'bool', yes: t.type === 'internet' ? 'Allowed' : t.type === 'vacuum' ? 'Clean' : 'On', no: t.type === 'internet' ? 'Paused' : t.type === 'vacuum' ? 'Dock' : 'Off' };
    case 'bri': return { key, label: 'Brightness', icon: 'brightness_6', kind: 'number', min: 1, max: 100, step: 5, unit: '%' };
    case 'k': return { key, label: 'Colour temperature', icon: 'wb_twilight', kind: 'number', min: 1500, max: 9000, step: 100, unit: 'K' };
    case 'color': return { key, label: 'Colour', icon: 'lightbulb', kind: 'color' };
    case 'hvac': return choice('Climate mode', 'ac_unit', HVAC_MODES);
    case 'target': return { key, label: 'Set temperature', icon: 'thermostat', kind: 'number', min: 16, max: 32, step: 0.5, unit: '°C' };
    case 'fanSpeed': return choice('Fan speed', 'mode_fan', FAN_SPEEDS);
    case 'mode': {
      const seen = t.devices.map(d => d.state?.mode).filter((m): m is string => typeof m === 'string' && !!m);
      return choice('Mode', 'tune', [...FAN_MODES, ...[...new Set(seen)].filter(m => !FAN_MODES.some(o => o.v === m)).map(m => ({ v: m, label: m }))]);
    }
    case 'fanLevel': return { key, label: 'Fan level', icon: 'air', kind: 'number', min: 1, max: levelMax(t.devices), step: 1 };
    case 'activity': return choice('Vacuum', 'cleaning_services', VAC_COMMANDS);
    case 'media': return { key, label: t.caps.has('library') && !t.caps.has('media') ? 'Play a film or show' : 'Play', icon: 'play_arrow', kind: 'media' };
    case 'shuffle': return { key, label: 'Shuffle', icon: 'shuffle', kind: 'bool', yes: 'Shuffled', no: 'In order' };
    case 'paused': return { key, label: 'Pause', icon: 'pause', kind: 'bool', yes: 'Pause', no: 'Carry on' };
    case 'skip': return { key, label: 'Skip', icon: 'skip_next', kind: 'choice', options: [{ v: '1', label: 'Next song' }, { v: '-1', label: 'Previous song' }] };
    case 'vol': return { key, label: 'Volume', icon: 'volume_up', kind: 'number', min: 0, max: 100, step: 5, unit: '%' };
    case 'volStep': return { key, label: 'Volume step', icon: 'volume_up', kind: 'choice', options: [{ v: '1', label: 'Up a step' }, { v: '-1', label: 'Down a step' }] };
    case 'muted': return { key, label: 'Mute', icon: 'volume_off', kind: 'bool', yes: 'Muted', no: 'Unmuted' };
    case 'input': return choice('Input', 'settings_input_hdmi', inputsOf(t, typeof cur === 'string' ? cur : undefined));
    case 'sound': return choice('Sound mode', 'equalizer', SOUND_MODES);
    case 'night': return { key, label: 'Night mode', icon: 'bedtime', kind: 'bool', yes: 'On', no: 'Off' };
    case 'zoneSet': return { key, label: 'Zones', icon: 'apps', kind: 'zones' };
    case 'display': return { key, label: 'Display', icon: 'light_mode', kind: 'bool', yes: 'On', no: 'Off' };
    case 'childLock': return { key, label: 'Child lock', icon: 'lock', kind: 'bool', yes: 'Locked', no: 'Unlocked' };
    case 'extras': return { key, label: 'Extra switches', icon: 'toggle_on', kind: 'extras' };
    default: return { key, label: key, icon: 'tune', kind: typeof cur === 'boolean' ? 'bool' : typeof cur === 'number' ? 'number' : 'choice', yes: 'Yes', no: 'No', options: typeof cur === 'string' ? [{ v: cur, label: cur }] : [] };
  }
}

/** The fields this target can be set to, in order, with any the command already has (so nothing it holds is hidden). */
export function fieldsFor(t: TargetInfo, cmd: Command = {}): CmdField[] {
  const c = cmd as Record<string, unknown>;
  if (t.type === 'zone') return [...ZONE_FIELDS, ...Object.keys(c).filter(k => !(ZONE_FIELDS as readonly string[]).includes(k))].map(k => fieldSpec(k, t, c[k]));
  const keys: string[] = CMD_ORDER.filter(k => k in c || canDo(t.caps, k));
  for (const k of Object.keys(c)) if (!keys.includes(k)) keys.push(k);
  // Zones need zones to set; extras need named extras (from the device or the command).
  return keys.filter(k => k in c || (k !== 'zoneSet' || zonesOf(t).length > 0) && (k !== 'extras' || extrasOf(t).length > 0)).map(k => fieldSpec(k, t, c[k]));
}
/** Fields not yet in the command: what "Add a setting" offers. */
export const freeFields = (t: TargetInfo, cmd: Command = {}) => fieldsFor(t, cmd).filter(f => !(f.key in cmd));

/** The zones of a ducted air conditioner, with their names. */
export function zonesOf(t: TargetInfo, cur?: Command['zoneSet']): { n: string; name: string }[] {
  const out = new Map<string, string>();
  for (const d of t.devices) for (const z of (d.state?.zones as { n: number }[] | null | undefined) ?? []) out.set(String(z.n), d.zoneNames?.[String(z.n)] || `Zone ${z.n}`);
  for (const n of Object.keys(cur ?? {})) if (!out.has(n)) out.set(n, t.devices.find(d => d.zoneNames?.[n])?.zoneNames?.[n] || `Zone ${n}`);
  return [...out].sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, name]) => ({ n, name }));
}
/** The extra switches and settings a device lists (AC eco, sleep, turbo…), with their kind from the value. */
export function extrasOf(t: TargetInfo, cur?: Command['extras']): { key: string; kind: 'bool' | 'number' | 'text'; now?: unknown }[] {
  const out = new Map<string, unknown>();
  for (const d of t.devices) for (const [k, v] of Object.entries((d.state?.extras as Record<string, unknown> | undefined) ?? {})) if (!out.has(k)) out.set(k, v);
  for (const [k, v] of Object.entries(cur ?? {})) out.set(k, v);
  return [...out].map(([key, now]) => ({ key, now, kind: typeof now === 'number' ? 'number' : typeof now === 'string' ? 'text' : 'bool' }));
}

export interface MusicItem { name: string; kind: 'all' | 'loved' | 'playlist'; icon?: string }
/** What a player can be told to play, in groups: stop, the home's sources, Helix music, a station, a film or show. */
export function mediaChoices(t: TargetInfo, sources: { name: string }[], music: MusicItem[], cur?: string | null): Opt[] {
  const l: Opt[] = [{ v: STOP_KEY, label: 'Nothing: stop playing' }];
  if (t.caps.has('media')) for (const s of sources) l.push({ v: `src:${s.name}`, label: s.name });
  if (t.caps.has('queue')) {
    const m = music.length ? music : [{ name: 'Shuffle all', kind: 'all' as const }, { name: 'Loved', kind: 'loved' as const }];
    for (const x of m) l.push({ v: `src:${x.name}`, label: x.kind === 'playlist' ? `Playlist: ${x.name}` : x.name });
    l.push({ v: STATION_KEY, label: 'A station from an artist, album or song…' });
  }
  if (t.caps.has('library')) l.push({ v: TITLE_KEY, label: 'A film or show, by title…' });
  if (typeof cur === 'string' && cur && !l.some(o => o.v === `src:${cur}`) && !cur.startsWith('Station: ')) l.push({ v: `src:${cur}`, label: cur });
  return l;
}
export const STOP_KEY = 'stop', STATION_KEY = 'station', TITLE_KEY = 'title';
/** Which media choice a value is: stop, a station, a typed title (on a library player), or a named source. */
export function mediaKey(v: string | null | undefined, t: TargetInfo, sources: { name: string }[], music: MusicItem[]): string {
  if (v == null) return STOP_KEY;
  if (v.startsWith('Station: ')) return STATION_KEY;
  const named = sources.some(s => s.name === v) || music.some(m => m.name === v) || v === 'Shuffle all' || v === 'Loved';
  if (!named && t.caps.has('library')) return TITLE_KEY;
  return `src:${v}`;
}
/** The media value for a choice (keeping typed text where the choice takes text). */
export function mediaFromKey(k: string, prev: string | null | undefined): string | null {
  if (k === STOP_KEY) return null;
  if (k === STATION_KEY) return prev?.startsWith('Station: ') ? prev : 'Station: ';
  if (k === TITLE_KEY) return prev && !prev.startsWith('Station: ') ? prev : '';
  return k.slice(4);
}

/** The value a field starts with when it's added: what the device is at now where that makes sense. */
export function fieldDefault(key: string, t: TargetInfo, sources: { name: string }[] = [], music: MusicItem[] = []): unknown {
  const now = (k: string) => t.devices.map(d => (d.state as Record<string, unknown> | undefined)?.[k]).find(v => v != null);
  const num = (k: string, d: number) => { const v = Number(now(k)); return Number.isFinite(v) && now(k) != null ? v : d; };
  if (t.type === 'zone' && key === 'open') return 100;
  if (t.type === 'zone' && key === 'ac') return true;
  switch (key) {
    case 'on': return true;
    case 'bri': return Math.max(1, Math.min(100, num('bri', 50)));
    case 'k': return num('k', 2700);
    case 'color': return typeof now('color') === 'string' ? now('color') : '#ffb46b';
    case 'hvac': return (now('hvac') as string) || 'cool';
    case 'target': return num('target', 24);
    case 'fanSpeed': return (now('fanSpeed') as string) || 'auto';
    case 'mode': return 'Auto';
    case 'fanLevel': return 1;
    case 'activity': return 'cleaning';
    case 'media': return t.caps.has('media') && sources[0] ? sources[0].name : t.caps.has('queue') ? (music[0]?.name ?? 'Shuffle all') : '';
    case 'shuffle': return true;
    case 'paused': return true;
    case 'skip': return 1;
    case 'vol': return num('vol', 30);
    case 'volStep': return 1;
    case 'muted': return true;
    case 'input': return inputsOf(t)[0]?.v ?? 'hdmi1';
    case 'sound': return 'standard';
    case 'night': return true;
    case 'zoneSet': { const z = zonesOf(t)[0]; return z ? { [z.n]: { on: true, open: 100 } } : {}; }
    case 'display': return true;
    case 'childLock': return true;
    case 'extras': { const e = extrasOf(t)[0]; return e ? { [e.key]: e.kind === 'bool' ? !(e.now === true) : e.now ?? '' } : {}; }
    default: return true;
  }
}

/** A command with a field added (at its default), set, or removed (undefined). */
export function withField(cmd: Command, key: string, v: unknown): Command {
  const c = { ...(cmd as Record<string, unknown>) };
  if (v === undefined) delete c[key]; else c[key] = v;
  return c as Command;
}

/** What a new row for this target starts as: on, where it can be, or its first setting. */
export function firstCommand(t: TargetInfo | Dev | undefined, sources: { name: string }[] = [], music: MusicItem[] = []): Command {
  if (!t) return { on: true };
  const info: TargetInfo = 'caps' in t ? t : { id: t.id, label: t.name ?? t.id, caps: new Set(t.capabilities ?? []), devices: [t], type: t.type, pseudo: false, missing: false };
  if (info.caps.has('onoff')) return { on: true };
  const f = fieldsFor(info)[0];
  return f ? { [f.key]: fieldDefault(f.key, info, sources, music) } as Command : { on: true };
}

/** A few common settings as one tap ("Off", "On at 50%", "Play Rain"), for this target. Each replaces the command. */
export function presets(t: TargetInfo, sources: { name: string }[], music: MusicItem[] = []): [Command, string][] {
  const c = t.caps, out: [Command, string][] = [];
  if (t.type === 'zone') return ZONE_PRESETS.map(([z, label]) => [z as Command, label]);
  if (t.type === 'internet') return [[{ on: false }, 'Pause internet'], [{ on: true }, 'Allow internet']];
  if (t.type === 'vacuum') return [[{ on: true }, 'Clean'], [{ on: false }, 'Dock']];
  if (c.has('climate')) out.push([{ on: true, hvac: 'cool', target: 24 }, 'Cool to 24°'], [{ on: true, hvac: 'heat', target: 21 }, 'Heat to 21°']);
  if (c.has('fanMode') && !c.has('climate')) out.push([{ on: true, mode: 'Auto' }, 'Auto'], [{ on: true, mode: 'Sleep' }, 'Sleep']);
  if (c.has('media') || c.has('queue') || c.has('library')) {
    out.push([{ on: false, media: null }, 'Stop']);
    if (c.has('pause')) out.push([{ paused: true }, 'Pause']);
    if (c.has('media')) for (const s of sources.slice(0, 3)) out.push([{ on: true, media: s.name, vol: 30 }, `Play ${s.name}`]);
    if (c.has('queue')) out.push([{ on: true, media: music.find(m => m.kind === 'all')?.name ?? 'Shuffle all', shuffle: true }, 'Shuffle all music']);
    return out;
  }
  if (c.has('onoff')) out.push([{ on: false }, 'Off']);
  if (c.has('brightness')) out.push(...[10, 50, 100].map((b): [Command, string] => [{ on: true, bri: b }, `On at ${b}%`]));
  else if (c.has('onoff') && !c.has('climate')) out.push([{ on: true }, 'On']);
  if (c.has('colorTemp')) out.push([{ on: true, k: 2700 }, 'Warm white'], [{ on: true, k: 5000 }, 'Daylight']);
  return out;
}

// Old names, kept for anything that still offers a command as one choice.
export const commandOptions = (d: Dev | undefined, sources: { name: string }[]): [Command, string][] => (d ? presets(targetInfo(d.id, [d], []), sources) : []);
const cmdKey = (c: Command) => JSON.stringify(Object.keys(c).sort().reduce<Record<string, unknown>>((o, k) => { o[k] = (c as Record<string, unknown>)[k]; return o; }, {}));
export const commandKey = cmdKey;
/** A device's preset commands as choices, with the current one (words for anything not a preset) first: for mode, moment and overlay editors. */
export function commandChoices(d: Dev | undefined, sources: { name: string }[], cur?: Command): Opt[] {
  const l = commandOptions(d, sources).map(([c, label]) => ({ v: cmdKey(c), label }));
  if (cur && !l.some(o => o.v === cmdKey(cur))) l.unshift({ v: cmdKey(cur), label: commandWords(cur) });
  return l;
}
export const commandFromKey = (k: string) => JSON.parse(k) as Command;
export const sameCommand = (a: Command, b: Command) => cmdKey(a) === cmdKey(b);

const onOff = (v: unknown, yes: string, no: string) => (v ? yes : no);
/** A command in words, every field it holds ("on, 40%, 2700K", "play Rain, volume 30%"). Never "as set". */
export function commandWords(c: Command, zoneNames: Record<string, string> = {}): string {
  const x = c as Record<string, unknown>, p: string[] = [];
  for (const k of [...CMD_ORDER, ...Object.keys(x).filter(k => !(CMD_ORDER as readonly string[]).includes(k))]) {
    if (!(k in x)) continue;
    const v = x[k];
    switch (k) {
      case 'on': p.push(onOff(v, 'on', 'off')); break;
      case 'bri': p.push(`${v}%`); break;
      case 'k': p.push(`${v}K`); break;
      case 'color': p.push(v ? `colour ${String(v)}` : 'no colour'); break;
      case 'hvac': p.push(labelOf(HVAC_MODES, String(v)).toLowerCase()); break;
      case 'target': p.push(`${v}°`); break;
      case 'fanSpeed': p.push(`fan ${String(v)}`); break;
      case 'mode': p.push(`${String(v)} mode`); break;
      case 'fanLevel': p.push(`fan level ${v}`); break;
      case 'activity': p.push(v === 'returning' || v === 'docked' ? 'back to the dock' : v === 'paused' ? 'pause cleaning' : 'clean'); break;
      case 'media': p.push(v == null ? 'stop playing' : `play ${String(v) || '…'}`); break;
      case 'shuffle': p.push(onOff(v, 'shuffled', 'in order')); break;
      case 'paused': p.push(onOff(v, 'pause', 'carry on playing')); break;
      case 'skip': p.push(Number(v) > 0 ? 'next song' : 'previous song'); break;
      case 'vol': p.push(`volume ${v}%`); break;
      case 'volStep': p.push(Number(v) > 0 ? 'volume up' : 'volume down'); break;
      case 'muted': p.push(onOff(v, 'muted', 'unmuted')); break;
      case 'input': p.push(`input ${INPUT_NAMES[String(v)] ?? String(v)}`); break;
      case 'sound': p.push(`${labelOf(SOUND_MODES, String(v)).toLowerCase()} sound`); break;
      case 'night': p.push(`night mode ${onOff(v, 'on', 'off')}`); break;
      case 'zoneSet': p.push(zoneWords(v as Command['zoneSet'], zoneNames)); break;
      case 'display': p.push(`display ${onOff(v, 'on', 'off')}`); break;
      case 'childLock': p.push(`child lock ${onOff(v, 'on', 'off')}`); break;
      case 'extras': for (const [ek, ev] of Object.entries((v as Record<string, unknown>) ?? {})) p.push(typeof ev === 'boolean' ? `${ek} ${ev ? 'on' : 'off'}` : `${ek} ${String(ev)}`); break;
      default: p.push(typeof v === 'boolean' ? `${k} ${v ? 'on' : 'off'}` : `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
  }
  return p.join(', ') || 'nothing yet';
}
/** Zones in words: "Living on at 50%, Zone 2 off". */
export function zoneWords(z: Command['zoneSet'], names: Record<string, string> = {}): string {
  const l = Object.entries(z ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, s]) => `${names[n] || `zone ${n}`} ${s.on === false ? 'off' : s.on ? `on${s.open != null ? ` at ${s.open}%` : ''}` : s.open != null ? `${s.open}% open` : 'as it is'}`);
  return l.join(', ') || 'no zones';
}

/** Swap one target in a step for another, keeping its place; the new one starts on its first command. */
export function retarget(t: Targets, from: string, to: string, cmd: Command): Targets {
  if (from === to) return t;
  const o: Targets = {};
  for (const [k, c] of Object.entries(t)) { if (k === to) continue; o[k === from ? to : k] = k === from ? cmd : c; }
  return o;
}

/** Keep what a command can carry over to a new target: the fields the new one can do. */
export function carryCommand(cmd: Command, to: TargetInfo, sources: { name: string }[] = [], music: MusicItem[] = []): Command {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cmd)) if (to.type === 'zone' ? (ZONE_FIELDS as readonly string[]).includes(k) && k !== 'on' : canDo(to.caps, k)) kept[k] = v;
  if (to.type === 'zone' && Object.keys(kept).length) return { on: true, ...kept } as Command;
  return Object.keys(kept).length ? kept as Command : firstCommand(to, sources, music);
}

/** The assistant's tool spells extra fields as { set: {...} }; the hub flattens them. Do the same when opening one. */
export function flatCommand(c: Command): Command {
  const x = c as Record<string, unknown>;
  if (!x.set || typeof x.set !== 'object' || Array.isArray(x.set)) return c;
  const { set, ...rest } = x;
  return { ...rest, ...(set as Record<string, unknown>) } as Command;
}

// ------------------------------------------------------------ matches -----

/** One thing a state match can look at, for this device. */
export interface MatchField { key: keyof StateMatch; label: string; kind: 'bool' | 'choice'; yes?: string; no?: string; options?: Opt[] }
const MATCH_ORDER: (keyof StateMatch)[] = ['motion', 'open', 'on', 'online', 'input', 'hvac', 'activity', 'playing', 'muted', 'mode'];
/** Does the device report this part of its state (a motion or door sensor: the key is there, even before it's said)? */
const reports = (d: Dev, k: string) => !!d.state && k in d.state;

/** The parts of a device's state a trigger or condition can match on, from what it can do (and what the match has). */
export function matchFields(d: Dev | undefined, m: StateMatch = {}): MatchField[] {
  const caps = new Set(d?.capabilities ?? []);
  const t: TargetInfo = d ? targetInfo(d.id, [d], []) : { id: '', label: '', caps, devices: [], pseudo: false, missing: true };
  const want = (k: keyof StateMatch) => {
    if (m[k] !== undefined) return true;
    if (!d) return k === 'on' || k === 'online';
    switch (k) {
      case 'motion': case 'open': return reports(d, k);
      case 'on': return caps.has('onoff') || canSet(d);
      case 'online': return true;
      case 'input': return caps.has('input');
      case 'hvac': return caps.has('climate');
      case 'activity': return caps.has('vacuum') || d.type === 'vacuum';
      case 'playing': return isPlayerType(d.type) || caps.has('media') || caps.has('pause');
      case 'muted': return caps.has('mute');
      case 'mode': return caps.has('fanMode') || typeof d.state?.mode === 'string';
    }
  };
  const out: MatchField[] = [];
  for (const k of MATCH_ORDER) {
    if (!want(k)) continue;
    switch (k) {
      case 'motion': out.push({ key: k, label: 'Motion', kind: 'bool', yes: 'Detecting motion', no: 'Clear' }); break;
      case 'open': out.push({ key: k, label: 'Door or window', kind: 'bool', yes: 'Open', no: 'Closed' }); break;
      case 'on': out.push({ key: k, label: d?.type === 'internet' ? 'Internet' : 'Power', kind: 'bool', yes: d?.type === 'internet' ? 'Allowed' : 'On', no: d?.type === 'internet' ? 'Paused' : 'Off' }); break;
      case 'online': out.push({ key: k, label: 'Connection', kind: 'bool', yes: 'Online', no: 'Offline' }); break;
      case 'input': out.push({ key: k, label: 'Input', kind: 'choice', options: inputsOf(t, m.input) }); break;
      case 'hvac': out.push({ key: k, label: 'Climate mode', kind: 'choice', options: withCurrent(HVAC_MODES, m.hvac) }); break;
      case 'activity': out.push({ key: k, label: 'Vacuum', kind: 'choice', options: withCurrent(ACTIVITIES, m.activity) }); break;
      case 'playing': out.push({ key: k, label: 'Playing', kind: 'bool', yes: 'Playing', no: 'Not playing' }); break;
      case 'muted': out.push({ key: k, label: 'Sound', kind: 'bool', yes: 'Muted', no: 'Not muted' }); break;
      case 'mode': {
        const seen = typeof d?.state?.mode === 'string' ? [d.state.mode] : [];
        out.push({ key: k, label: 'Mode', kind: 'choice', options: withCurrent([...FAN_MODES, ...seen.filter(x => !FAN_MODES.some(o => o.v === x)).map(x => ({ v: x, label: x }))], m.mode) });
        break;
      }
    }
  }
  return out;
}

/** A match with one part set (or cleared with undefined); an empty match is undefined. */
export function withMatch(m: StateMatch | undefined, k: keyof StateMatch, v: string | boolean | undefined): StateMatch | undefined {
  const o: Record<string, unknown> = { ...(m ?? {}) };
  if (v === undefined || v === '') delete o[k]; else o[k] = v;
  return Object.keys(o).length ? o as StateMatch : undefined;
}

/** A match in words, as the hub says it ("on HDMI 2 and muted"). */
export function matchWords(m: StateMatch | undefined): string {
  if (!m) return 'anything';
  const parts = [
    m.motion !== undefined ? (m.motion ? 'detecting motion' : 'clear of motion') : '',
    m.open !== undefined ? (m.open ? 'open' : 'closed') : '',
    m.input ? `on ${INPUT_NAMES[m.input] ?? m.input}` : m.on !== undefined ? (m.on ? 'on' : 'off') : '',
    m.online !== undefined ? (m.online ? 'online' : 'offline') : '',
    m.playing !== undefined ? (m.playing ? 'playing' : 'not playing') : '',
    m.hvac ? `on ${m.hvac}` : '', m.activity ? m.activity : '', m.muted !== undefined ? (m.muted ? 'muted' : 'not muted') : '', m.mode ? `on ${m.mode}` : '',
  ].filter(Boolean);
  return parts.join(' and ') || 'anything';
}

// A match as one key, with its keys in a fixed order (kept for older callers and the tests).
export function stateKey(m: StateMatch | undefined): string {
  if (!m) return '';
  const o: Record<string, unknown> = {};
  for (const k of MATCH_ORDER) if (m[k] !== undefined) o[k] = m[k];
  for (const k of Object.keys(m).sort()) if (!(k in o) && (m as Record<string, unknown>)[k] !== undefined) o[k] = (m as Record<string, unknown>)[k];
  return JSON.stringify(o);
}
export const stateFromKey = (k: string): StateMatch | undefined => (k ? JSON.parse(k) as StateMatch : undefined);

// ------------------------------------------------------------ readings ----

/** The readings a device has (from what it reports and can do), with the current one kept. */
export function readingsFor(d: Dev | undefined, cur?: NumericField): Opt<NumericField>[] {
  if (!d) return withCurrent(FIELDS, cur);
  const caps = new Set(d.capabilities ?? []), st = (d.state ?? {}) as Record<string, unknown>;
  const ok = (f: NumericField) => {
    if (f === cur || st[f] !== undefined) return true;
    switch (f) {
      case 'temp': case 'target': return caps.has('climate');
      case 'power': return caps.has('power');
      case 'energy': return caps.has('energy');
      case 'battery': return caps.has('battery');
      case 'bri': return caps.has('brightness');
      case 'vol': return caps.has('volume');
      default: return false;
    }
  };
  const l = FIELDS.filter(f => ok(f.v));
  return l.length ? l : withCurrent(FIELDS, cur);
}
/** The readings a room has (logic for "room:<id>" sources): its temperature, humidity and light level, where it has them. */
export const ROOM_FIELDS: NumericField[] = ['temp', 'humidity', 'lux'];
export function roomReadingsFor(st: Pick<RoomStatus, 'temp' | 'humidity' | 'lux'> | undefined, cur?: NumericField): Opt<NumericField>[] {
  const l = FIELDS.filter(f => ROOM_FIELDS.includes(f.v) && (f.v === cur || f.v === 'temp' || (st && st[f.v as 'temp' | 'humidity' | 'lux'] != null)));
  return cur && !l.some(o => o.v === cur) ? [...l, { v: cur, label: labelOf(FIELDS, cur) }] : l;
}
/** Rooms a numeric trigger or condition can read: each one with a temperature now, as "<Room> temperature". */
export function readingRooms(rooms: Pick<Room, 'id' | 'name'>[], status: Record<string, Pick<RoomStatus, 'temp'>> | undefined, cur?: string): Opt[] {
  return rooms.filter(r => status?.[r.id]?.temp != null || cur === `room:${r.id}`).map(r => ({ v: `room:${r.id}`, label: `${r.name} temperature` }));
}
/** What a numeric trigger or condition reads, for its picker: a room ("Lounge"), else the device as usual. */
export function readingSourceLabel(id: string, devices: Pick<Device, 'id' | 'name' | 'room'>[], rooms: Pick<Room, 'id' | 'name'>[]): string {
  if (id.startsWith('room:')) return rooms.find(r => r.id === id.slice(5))?.name ?? id.slice(5);
  return deviceLabel(id, devices, rooms);
}

/** A reading's unit, for the number boxes. */
export const FIELD_UNIT: Record<NumericField, string> = { temp: '°C', target: '°C', power: 'W', energy: 'kWh', battery: '%', bri: '%', vol: '%', grid: 'W', load: 'W', humidity: '%', lux: 'lux', pm25: 'µg/m³' };

// ------------------------------------------------------------- events -----

/** What a camera tells: people, motion, the doorbell, and (smart cameras) vehicles, animals, packages and sounds. */
export const CAMERA_EVENTS = ['person', 'motion', 'ring', 'vehicle', 'animal', 'package', 'sound'];
/** The events a device sends, from its type and what it can do; everything when unknown. The current one is kept. */
export function eventsFor(d: Dev | undefined, cur?: string): Opt[] {
  if (!d) return withCurrent(EVENTS, cur);
  const caps = new Set(d.capabilities ?? []);
  const keys = new Set<string>();
  if (d.type === 'camera') CAMERA_EVENTS.forEach(k => keys.add(k));
  else if (isSensor(d) && (d.type === 'sensor' || reports(d, 'motion'))) ['motion', 'person'].forEach(k => keys.add(k));
  if (isPlayerType(d.type) || caps.has('media') || caps.has('library')) ['video-started', 'music-started', 'paused', 'resumed', 'stopped', 'ended'].forEach(k => keys.add(k));
  if (d.type === 'tv' || caps.has('library')) ['screen-asleep', 'screen-shutdown', 'screen-awake'].forEach(k => keys.add(k));
  if (d.type === 'internet') ['internet-down', 'internet-up', 'internet-failover', 'new-device', 'threat'].forEach(k => keys.add(k));
  if (caps.has('events') && !keys.size) ['person', 'motion', 'ring'].forEach(k => keys.add(k));
  const l = keys.size ? EVENTS.filter(e => keys.has(e.v)) : EVENTS;
  return withCurrent(l, cur);
}
export const eventWords = (e: string) => EVENTS.find(x => x.v === e)?.label ?? e;

// --------------------------------------------------------------- rooms -----

/** What a room trigger can start on, in the order the picker shows them. */
export const ROOM_EVENTS: Opt<RoomEvent>[] = (['motion', 'person', 'ring', 'opened', 'closed', 'package', 'vehicle', 'animal', 'sound'] as RoomEvent[]).map(v => ({ v, label: ROOM_EVENT_WORDS[v] }));
type Watcher = Pick<Device, 'id' | 'type'> & { kind?: Device['kind']; room?: string; name?: string; integration?: string; state?: Partial<Device['state']> };
/** Cameras and sensors: what tells Kova something happened in a room. */
export const watches = (d: Pick<Device, 'type'> & { kind?: Device['kind'] }) => isCamera(d) || d.kind === 'camera' || isSensor(d);
/** The cameras and sensors in a room. */
export const roomWatchers = <D extends Watcher>(room: string, devices: D[]): D[] => devices.filter(d => d.room === room && watches(d));
const doorbell = (d: Watcher) => /door\s*bell/i.test(`${d.integration ?? ''} ${d.name ?? ''} ${d.id}`);

/**
 * What can happen in a room, from the cameras and sensors in it (hub engine/rooms.ts): a camera sees people,
 * motion, vehicles, animals, packages and hears sounds (a doorbell rings); a motion sensor sees motion; a door or
 * window sensor opens and closes. A room with none of them yet offers everything. The current one is kept.
 */
export function roomEventsFor(room: string, devices: Watcher[], cur?: RoomEvent): Opt<RoomEvent>[] {
  const w = roomWatchers(room, devices), keys = new Set<RoomEvent>();
  for (const d of w) {
    if (isCamera(d) || d.kind === 'camera') { (['person', 'motion', 'vehicle', 'animal', 'package', 'sound'] as RoomEvent[]).forEach(k => keys.add(k)); if (doorbell(d)) keys.add('ring'); continue; }
    if (reports(d as Dev, 'motion')) keys.add('motion');
    if (reports(d as Dev, 'open')) { keys.add('opened'); keys.add('closed'); }
    if ((d.state?.extras as Record<string, unknown> | undefined)?.detected !== undefined) keys.add('sound');
  }
  const l = keys.size ? ROOM_EVENTS.filter(e => keys.has(e.v)) : ROOM_EVENTS;
  return withCurrent(l, cur);
}
/** The rooms to pick from: the home's, in its order, with a gone one kept (and said so). */
export function roomOptions(rooms: Pick<Room, 'id' | 'name'>[], cur?: string): Opt[] {
  const l = rooms.map(r => ({ v: r.id, label: r.name }));
  return cur && !rooms.some(r => r.id === cur) ? [...l, { v: cur, label: `${cur} (missing)` }] : l;
}
/** What's wrong with a room trigger or condition's room, if anything. */
export function roomProblem(room: string, rooms: Pick<Room, 'id'>[]): string | undefined {
  if (!room) return 'Choose a room.';
  if (!rooms.some(r => r.id === room)) return 'That room is gone: choose another.';
  return undefined;
}
/** Under the room: what reports there ("From the Doorbell and the Hall motion sensor"), or that nothing does yet. */
export function roomNote(room: string, devices: Watcher[]): { text: string; warn: boolean } | null {
  if (!room) return null;
  const w = roomWatchers(room, devices).map(d => d.name ?? d.id);
  if (!w.length) return { text: 'Nothing in this room reports activity yet: add a camera, or a motion or door sensor, there.', warn: true };
  return { text: `From ${w.length > 2 ? `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}` : w.join(' and ')}.`, warn: false };
}
/** A room condition's minutes, as the hub takes them (1 to 1440). */
export const withinProblem = (min: number | undefined) => min != null && !(min >= 1 && min <= 1440) ? 'Within 1 to 1440 minutes.' : undefined;

// ------------------------------------------------------------- rhythms -----

export const RHYTHMS = opts([['time', 'At a time'], ['sun:sunrise', 'Sunrise'], ['sun:sunset', 'Sunset'], ['sun:dawn', 'First light'], ['sun:dusk', 'Dusk'], ['prayer:fajr', 'Fajr'], ['prayer:sunrise', 'Shuruq (prayer sunrise)'], ['prayer:dhuhr', 'Dhuhr'], ['prayer:asr', 'Asr'], ['prayer:maghrib', 'Maghrib'], ['prayer:isha', 'Isha']]);
export const rhythmKey = (r: Rhythm | undefined) => !r || r.kind === 'time' ? 'time' : r.kind === 'sun' ? `sun:${r.event}` : `prayer:${r.prayer}`;
/** A rhythm from its choice, keeping the clock time or the offset it had. */
export function rhythmFromKey(k: string, prev?: Rhythm): Rhythm {
  const [kind, name] = k.split(':');
  const off = prev && prev.kind !== 'time' ? prev.offsetMin : undefined;
  if (kind === 'sun') return { kind: 'sun', event: name as SunEvent, ...(off ? { offsetMin: off } : {}) };
  if (kind === 'prayer') return { kind: 'prayer', prayer: name as Prayer, ...(off ? { offsetMin: off } : {}) };
  return { kind: 'time', at: prev?.kind === 'time' ? prev.at : '21:00' };
}
/** A rhythm with a new offset in minutes (0 drops it); clock times have none. */
export function withOffset(r: Rhythm, min: number): Rhythm {
  if (r.kind === 'time') return r;
  const { offsetMin: _o, ...rest } = r;
  return (min ? { ...rest, offsetMin: Math.round(min) } : rest) as Rhythm;
}
export function rhythmWords(r: Rhythm | undefined): string {
  if (!r) return 'any time';
  if (r.kind === 'time') return r.at;
  const name = labelOf(RHYTHMS, rhythmKey(r));
  const off = r.offsetMin ?? 0;
  return off ? `${Math.abs(off)} min ${off > 0 ? 'after' : 'before'} ${name.toLowerCase()}` : name;
}

/** "07:05" ⇄ [7, 5]. Bad input reads as 21:00. */
export function parseClock(s: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return [21, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}
export const clockOf = (h: number, m: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;

/** Days: none (or all seven) means every day. Toggling the last one off goes back to every day. */
export function toggleDay(days: number[] | undefined, i: number): number[] | undefined {
  let d = days && days.length ? days.slice() : [0, 1, 2, 3, 4, 5, 6];
  d = d.includes(i) ? d.filter(x => x !== i) : [...d, i].sort((a, b) => a - b);
  return d.length === 7 || d.length === 0 ? undefined : d;
}
export const dayOn = (days: number[] | undefined, i: number) => !days || !days.length || days.includes(i);
export function daysWords(days: number[] | undefined): string {
  if (!days || !days.length || days.length === 7) return 'every day';
  const k = days.slice().sort().join();
  if (k === '1,2,3,4,5') return 'weekdays';
  if (k === '0,6') return 'weekends';
  return days.slice().sort().map(d => DAY_NAMES[d].slice(0, 3)).join(', ');
}

/** Toggle an id in a list (modes, people). */
export const toggleIn = (l: string[] | undefined, id: string) => (l ?? []).includes(id) ? (l ?? []).filter(x => x !== id) : [...(l ?? []), id];

// ---------------------------------------------------------- one-time -------

// One-time schedules are dates and times on the home's clock ("2026-10-08T15:30"), never the phone's: the hub
// sends its own as `localNow`. Arithmetic is on that wall-clock time, as dates without a zone.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
export interface StampParts { y: number; mo: number; d: number; h: number; mi: number }
export function parseStamp(s: string | undefined | null): StampParts | null {
  const m = STAMP.exec(s ?? '');
  return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] } : null;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** A stamp from parts, rolled over as a calendar would (32 Oct is 1 Nov, minute 75 is the next hour). */
export function stampOf(y: number, mo: number, d: number, h: number, mi: number): string {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}
export function addMinutes(s: string, n: number): string {
  const p = parseStamp(s);
  return p ? stampOf(p.y, p.mo, p.d, p.h, p.mi + n) : s;
}
export const dateOf = (s: string) => s.slice(0, 10);
export const timeOf = (s: string) => s.slice(11, 16);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** A stamp in words near now, as the hub says it: "today at 15:30", "tomorrow at 07:00", "Thu 15 Oct at 09:00". */
export function onceWords(s: string, now: string): string {
  const p = parseStamp(s), n = parseStamp(now);
  if (!p || !n) return s || 'pick a time';
  const time = timeOf(s), today = dateOf(now);
  if (dateOf(s) === today) return `today at ${time}`;
  if (dateOf(s) === dateOf(addMinutes(`${today}T00:00`, 1440))) return `tomorrow at ${time}`;
  if (dateOf(s) === dateOf(addMinutes(`${today}T00:00`, -1440))) return `yesterday at ${time}`;
  return `${WEEKDAYS[weekday(p.y, p.mo, p.d)]} ${p.d} ${MONTHS[p.mo - 1]}${p.y !== n.y ? ` ${p.y}` : ''} at ${time}`;
}
/** Minutes from now to the stamp (negative when it has passed). */
export function minutesUntil(s: string, now: string): number {
  const a = parseStamp(s), b = parseStamp(now);
  if (!a || !b) return NaN;
  return Math.round((Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi) - Date.UTC(b.y, b.mo - 1, b.d, b.h, b.mi)) / 60000);
}
/** "in 25 min", "in 3 h 10 min", "in 2 days"; "passed" once it has. */
export function untilWords(s: string, now: string): string {
  const m = minutesUntil(s, now);
  if (!Number.isFinite(m)) return '';
  if (m <= 0) return m === 0 ? 'now' : 'passed';
  if (m < 60) return `in ${m} min`;
  if (m < 24 * 60) { const h = Math.floor(m / 60), r = m % 60; return `in ${h} h${r ? ` ${r} min` : ''}`; }
  const d = Math.round(m / 1440);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

/** The quick choices for "once": in 15 min, in 1 h, tonight at 21:00 (while it's still to come), tomorrow at 07:00. */
export function onceChips(now: string): { label: string; at: string }[] {
  const p = parseStamp(now);
  if (!p) return [];
  const today = dateOf(now), tomorrow = dateOf(addMinutes(`${today}T00:00`, 1440));
  const l = [{ label: 'In 15 min', at: addMinutes(now, 15) }, { label: 'In 1 h', at: addMinutes(now, 60) }];
  if (`${today}T21:00` > addMinutes(now, 15)) l.push({ label: 'Tonight 21:00', at: `${today}T21:00` });
  else l.push({ label: 'Tomorrow 21:00', at: `${tomorrow}T21:00` });
  l.push({ label: 'Tomorrow 07:00', at: `${tomorrow}T07:00` });
  return l;
}
/** The same clock time, next time it comes round (today if it's still ahead, else tomorrow): for "Schedule again". */
export function nextSameTime(s: string, now: string): string {
  const today = dateOf(now), t = timeOf(s) || '09:00';
  const at = `${today}T${t}`;
  return at > now ? at : `${dateOf(addMinutes(`${today}T00:00`, 1440))}T${t}`;
}
/** The weeks of a month as day numbers (null before the 1st and after the last), weeks starting on Sunday. */
export function monthGrid(y: number, mo: number): (number | null)[][] {
  const first = weekday(y, mo, 1), days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
/** The month before or after ([year, month 1–12]). */
export const shiftMonth = (y: number, mo: number, d: number): [number, number] => { const t = new Date(Date.UTC(y, mo - 1 + d, 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1]; };

/** A one-time schedule: every trigger is "once". */
export const isOneTime = (d: Pick<Draft, 'triggers'>) => d.triggers.length > 0 && d.triggers.every(t => t.kind === 'once');
/** Where a once trigger stands: gone off, missed (Kova was off), passed without going off, or still to come. */
export function onceState(t: Extract<Trigger, { kind: 'once' }>, now: string): 'done' | 'missed' | 'passed' | 'upcoming' {
  if (t.missed) return 'missed';
  if (t.firedAt) return 'done';
  return now && t.at <= now ? 'passed' : 'upcoming';
}
/** A once trigger at a new time: not gone off yet. */
export const onceAt = (at: string): Extract<Trigger, { kind: 'once' }> => ({ kind: 'once', at });
/** "Schedule again": each once at its clock time's next turn, not gone off, switched on. */
export function scheduleAgain(d: Draft, now: string): Draft {
  return { ...d, enabled: true, triggers: d.triggers.map(t => (t.kind === 'once' ? onceAt(nextSameTime(t.at, now)) : t)) };
}
/** A one-time schedule switched on with every time gone by: the hub would refuse it, so say so before sending. */
export function onceProblem(d: Draft, now: string): string | null {
  if (!isOneTime(d) || !d.enabled || !now) return null;
  return d.triggers.some(t => t.kind === 'once' && !t.firedAt && t.at > now) ? null : 'That time has passed: choose a later one';
}

/** The home's clock as "YYYY-MM-DDTHH:MM": the snapshot's localNow, else worked out from its time and timezone. */
export function localNowOf(s: unknown): string {
  const x = s as { localNow?: string; home?: { now?: number; timezone?: string } } | null;
  if (x?.localNow && parseStamp(x.localNow)) return x.localNow;
  const ms = x?.home?.now ?? Date.now();
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: x?.home?.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(q => [q.type, q.value]));
    const st = `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
    if (parseStamp(st)) return st;
  } catch { /* no Intl time zones here */ }
  const d = new Date(ms);
  return stampOf(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes());
}

// ------------------------------------------------------------ durations ----

export type Unit = 's' | 'min' | 'h';
/** A delay in seconds as a number and the biggest unit that divides it. */
export function splitSeconds(sec: number): { n: number; unit: Unit } {
  if (sec >= 3600 && sec % 3600 === 0) return { n: sec / 3600, unit: 'h' };
  if (sec >= 60 && sec % 60 === 0) return { n: sec / 60, unit: 'min' };
  return { n: sec, unit: 's' };
}
export const toSeconds = (n: number, unit: Unit) => Math.max(0, Math.round(n * (unit === 'h' ? 3600 : unit === 'min' ? 60 : 1)));
/** "for" and timeouts are kept in seconds and shown in minutes (one decimal). */
export const secToMin = (sec: number | undefined) => sec ? Math.round(sec / 60 * 10) / 10 : undefined;
export const minToSec = (min: number | undefined) => min ? Math.round(min * 60) : undefined;
/** Seconds in words: "45 s", "5 min", "1 min 30 s", "2 h", "1 h 30 min". */
export function durWords(s: number): string {
  if (s < 60) return `${s} s`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s >= 3600 && s % 60 === 0) return `${Math.floor(s / 3600)} h ${(s % 3600) / 60} min`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

// ------------------------------------------------------------- defaults ----

/** What new parts start with: the home's first device, mode, overlay and so on. */
export interface Ctx {
  device?: string;
  /** The first device a step can set, and what it's set to first. */
  actDevice?: string;
  actCommand?: Command;
  /** The first device that can ramp brightness (or volume, or temperature), and which. */
  rampDevice?: string;
  rampField?: RampField;
  mode?: string;
  overlay?: string;
  /** The home's first room, for room triggers and conditions. */
  room?: string;
  /** Another automation, for "run another automation". */
  other?: string;
  /** The home's clock, for "once". */
  now?: string;
}

export function newTrigger(kind: Trigger['kind'], c: Ctx): Trigger {
  switch (kind) {
    case 'device': return { kind, device: c.device ?? '', to: { on: true } };
    case 'numeric': return { kind, device: c.device ?? '', field: 'temp', above: 28 };
    case 'event': return { kind, device: c.device ?? '', event: 'person' };
    case 'room': return { kind, room: c.room ?? '', event: 'motion' };
    case 'time': return { kind, at: { kind: 'time', at: '21:00' } };
    case 'once': return onceAt(c.now ? addMinutes(c.now, 60) : '');
    case 'every': return { kind, minutes: 15 };
    case 'presence': return { kind, event: 'arrives' };
    case 'mode': return { kind, mode: c.mode ?? '' };
    case 'overlay': return { kind, overlay: c.overlay ?? '', event: 'starts' };
    case 'hub': return { kind, event: 'start' };
  }
}

export function newCondition(kind: Condition['kind'], c: Ctx): Condition {
  switch (kind) {
    case 'device': return { kind, device: c.device ?? '', is: { on: true } };
    case 'numeric': return { kind, device: c.device ?? '', field: 'temp', above: 25 };
    case 'time': return { kind, after: { kind: 'time', at: '18:00' }, before: { kind: 'time', at: '23:00' } };
    case 'presence': return { kind, who: 'anyone', home: true };
    case 'mode': return { kind, modes: c.mode ? [c.mode] : [] };
    case 'overlay': return { kind, active: true };
    case 'room': return { kind, room: c.room ?? '', active: true, withinMin: 10 };
    case 'any': case 'all': case 'not': return { kind, conditions: [newCondition('device', c)] };
  }
}

export function newAction(kind: Action['kind'], c: Ctx): Action {
  switch (kind) {
    case 'set': return { kind, targets: c.actDevice ? { [c.actDevice]: c.actCommand ?? { on: true } } : {} };
    case 'ramp': { const f = c.rampField ?? 'bri'; return { kind, targets: c.rampDevice ? { [c.rampDevice]: { [f]: 100 } as Command } : {}, field: f, to: 100, overSec: 1800, stepSec: 60 }; }
    case 'delay': return { kind, seconds: 300 };
    case 'wait': return { kind, until: newCondition('device', c), timeoutSec: 600 };
    case 'notify': return { kind, message: '' };
    case 'overlay': return { kind, overlay: c.overlay ?? '', op: 'start' };
    case 'if': return { kind, conditions: [newCondition('device', c)], then: [], else: [] };
    case 'repeat': return { kind, times: 2, actions: [] };
    case 'run': return { kind, automation: c.other ?? '' };
    case 'stop': return { kind };
  }
}

/**
 * Change a part's kind. Where the two kinds share a field that means the same (a device, a reading),
 * it's kept, so going from "a device changes" to "a reading crosses" keeps the device picked.
 */
export function changeKind<P extends Trigger | Condition>(cur: P, fresh: P, home?: { devices: Watcher[]; rooms: Pick<Room, 'id'>[] }): P {
  if (cur.kind === fresh.kind) return cur;
  const keep = ['device', 'field', 'above', 'below'] as const;
  const out = { ...fresh } as Record<string, unknown>;
  // From a device to its room: "the doorbell sees a person" becomes "a person in the Front door".
  if (fresh.kind === 'room' && 'device' in cur && home) {
    const d = home.devices.find(x => x.id === cur.device);
    if (d?.room && home.rooms.some(r => r.id === d.room)) out.room = d.room;
    const ev = (cur as { event?: string }).event;
    if (cur.kind === 'event' && 'event' in out && ev && ROOM_EVENTS.some(e => e.v === ev)) out.event = ev;
  }
  for (const k of keep) if (k in out && k in cur && (cur as Record<string, unknown>)[k] !== undefined) out[k] = (cur as Record<string, unknown>)[k];
  // Groups keep what was in them.
  if ('conditions' in fresh && 'conditions' in cur) out.conditions = (cur as { conditions: Condition[] }).conditions;
  return out as P;
}
/** The same for steps: set ⇄ ramp keep their devices, if ⇄ repeat keep the steps inside, wait keeps an if's condition. */
export function changeActionKind(cur: Action, fresh: Action): Action {
  if (cur.kind === fresh.kind) return cur;
  if (fresh.kind === 'ramp' && cur.kind === 'set' && Object.keys(cur.targets).length) {
    return { ...fresh, targets: Object.fromEntries(Object.keys(cur.targets).map(id => [id, { [fresh.field]: fresh.to } as Command])) };
  }
  if (fresh.kind === 'set' && cur.kind === 'ramp' && Object.keys(cur.targets).length) {
    return { kind: 'set', targets: Object.fromEntries(Object.keys(cur.targets).map(id => [id, { [cur.field]: cur.to } as Command])) };
  }
  if (fresh.kind === 'repeat' && cur.kind === 'if') return { ...fresh, actions: cur.then };
  if (fresh.kind === 'if' && cur.kind === 'repeat') return { ...fresh, then: cur.actions };
  if (fresh.kind === 'wait' && cur.kind === 'if' && cur.conditions.length === 1) return { ...fresh, until: cur.conditions[0] };
  return fresh;
}

export const isGroup = (c: Condition): c is { kind: 'all' | 'any' | 'not'; conditions: Condition[] } => c.kind === 'all' || c.kind === 'any' || c.kind === 'not';

// --------------------------------------------------------------- drafts ----

export const blankDraft = (): Draft => ({ name: '', enabled: true, mode: 'single', triggers: [], conditions: [], actions: [] });

/** A one-time schedule to start from: once in an hour (on the home's clock), nothing to do yet. */
export const scheduleDraft = (now: string): Draft => ({ ...blankDraft(), triggers: [onceAt(addMinutes(now, 60))] });

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/** Steps with any { set: {...} } spelling flattened, at every depth. */
function flatActions(l: Action[]): Action[] {
  return l.map(a => {
    switch (a.kind) {
      case 'set': case 'ramp': return { ...a, targets: Object.fromEntries(Object.entries(a.targets ?? {}).map(([k, c]) => [k, flatCommand(c)])) } as Action;
      case 'if': return { ...a, then: flatActions(a.then ?? []), ...(a.else ? { else: flatActions(a.else) } : {}) };
      case 'repeat': return { ...a, actions: flatActions(a.actions ?? []) };
      default: return a;
    }
  });
}

/** The editable part of an automation (or a suggestion), without what the hub adds for lists. */
export function draftOf(a: Partial<Automation> | Idea | null | undefined): Draft {
  if (!a) return blankDraft();
  const d: Draft = {
    name: a.name ?? '', enabled: 'enabled' in a ? a.enabled !== false : true, mode: a.mode ?? 'single',
    triggers: clone(a.triggers ?? []), conditions: clone(a.conditions ?? []), actions: flatActions(clone(a.actions ?? [])),
  };
  if (a.description) d.description = a.description;
  if (a.origin) d.origin = clone(a.origin);
  return d;
}

/** What's sent to the hub on save: empty optional fields left out. */
export function bodyOf(d: Draft): Draft {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clean(x);
      return o;
    }
    return v;
  };
  const b = clean(d) as Draft;
  if (!b.description?.trim()) delete b.description; else b.description = b.description.trim();
  b.name = b.name.trim();
  return b;
}

export const sameDraft = (a: Draft, b: Draft) => JSON.stringify(bodyOf(a)) === JSON.stringify(bodyOf(b));

/** The context for new parts, from the home. */
export function ctxOf(o: { devices: Dev[]; sources: { name: string }[]; music?: MusicItem[]; modes: { id: string }[]; overlays: { id: string }[]; automations: { id: string }[]; rooms?: Pick<Room, 'id'>[]; self?: string | null; now?: string }): Ctx {
  const act = o.devices.find(canSet);
  // Room triggers and conditions start on the first room with a camera or sensor in it, else the first room.
  const rooms = o.rooms ?? [];
  const room = (rooms.find(r => o.devices.some(d => (d as Watcher).room === r.id && watches(d))) ?? rooms[0])?.id;
  const ramp = o.devices.find(d => has(d, 'brightness')) ?? o.devices.find(d => has(d, 'volume')) ?? o.devices.find(d => has(d, 'climate'));
  return {
    device: o.devices[0]?.id, actDevice: act?.id, actCommand: act ? firstCommand(act, o.sources, o.music) : undefined,
    rampDevice: ramp?.id, rampField: ramp ? (has(ramp, 'brightness') ? 'bri' : has(ramp, 'volume') ? 'vol' : 'target') : undefined,
    mode: o.modes[0]?.id, overlay: o.overlays[0]?.id, room, other: o.automations.find(a => a.id !== o.self)?.id, now: o.now,
  };
}
/** Can this device ramp this field? */
export const canRamp = (d: Pick<Device, 'capabilities'>, f: RampField) => has(d, RAMP_CAP[f]);

// ---------------------------------------------------------------- words ----

/** The names the words need, from the home. */
export interface Names {
  devices: { id: string; name: string; zoneNames?: Record<string, string> }[];
  rooms: Pick<Room, 'id' | 'name'>[];
  people: { id: string; name: string }[];
  modes: { id: string; name: string }[];
  overlays: { id: string; name: string }[];
  automations: { id: string; name: string }[];
  now?: string;
}
const nm = (l: { id: string; name: string }[], id: string | undefined) => (id ? l.find(x => x.id === id)?.name ?? id : '');
const dn = (n: Names, id: string) => pseudoLabel(id, n.rooms) ?? (id ? n.devices.find(d => d.id === id)?.name ?? id : 'a device');
/** What a reading comes from, by name: a device, or a room ("room:lounge" → "Lounge"). */
const sn = (n: Names, id: string) => id.startsWith('room:') ? nm(n.rooms, id.slice(5)) : dn(n, id);
const range = (above?: number, below?: number) => above != null && below != null ? `between ${above} and ${below}` : above != null ? `above ${above}` : below != null ? `below ${below}` : '…';
const forW = (s?: number) => (s ? ` for ${durWords(s)}` : '');
const daysW = (days?: number[]) => { const w = daysWords(days); return w === 'every day' ? '' : w === 'weekdays' ? 'on weekdays' : w === 'weekends' ? 'at weekends' : `on ${w}`; };

export function triggerText(t: Trigger, n: Names): string {
  switch (t.kind) {
    case 'device': return `${dn(n, t.device)} ${t.to ? `turns ${matchWords(t.to)}` : `stops being ${matchWords(t.from)}`}${t.to && t.from ? ` from ${matchWords(t.from)}` : ''}${forW(t.forSec)}`;
    case 'numeric': return `${sn(n, t.device)} ${FIELD_WORD[t.field] ?? t.field} goes ${range(t.above, t.below)}${forW(t.forSec)}`;
    case 'event': return `${dn(n, t.device)} ${eventWords(t.event)}`;
    case 'time': return `at ${[rhythmWords(t.at), daysW(t.days)].filter(Boolean).join(' ')}`;
    case 'once': { const w = n.now ? onceWords(t.at, n.now) : t.at; return `once, ${w}${t.missed ? ' (missed)' : t.firedAt ? ' (done)' : ''}`; }
    case 'every': return `every ${durWords(t.minutes * 60)}`;
    case 'presence': {
      const p = t.person ? nm(n.people, t.person) : 'someone';
      return t.event === 'arrives' ? `${p} comes home` : t.event === 'leaves' ? `${p} leaves` : t.event === 'first-arrives' ? 'the first person comes home' : 'the last person leaves';
    }
    case 'mode': return `${nm(n.modes, t.mode) || 'a mode'} starts`;
    case 'overlay': return `${nm(n.overlays, t.overlay) || 'an overlay'} ${t.event === 'ends' ? 'ends' : 'starts'}`;
    case 'hub': return 'Kova starts';
    case 'room': { const r = nm(n.rooms, t.room) || 'a room'; return ROOM_TRIGGER_WORDS[t.event]?.(r) ?? `${t.event} in ${r}`; }
  }
}

export function conditionText(c: Condition, n: Names): string {
  switch (c.kind) {
    case 'device': return `${dn(n, c.device)} is ${matchWords(c.is)}`;
    case 'numeric': return `${sn(n, c.device)} ${FIELD_WORD[c.field] ?? c.field} is ${range(c.above, c.below)}`;
    case 'time': return [c.after && c.before ? `between ${rhythmWords(c.after)} and ${rhythmWords(c.before)}` : c.after ? `after ${rhythmWords(c.after)}` : c.before ? `before ${rhythmWords(c.before)}` : '', daysW(c.days)].filter(Boolean).join(' ') || 'any time';
    case 'presence': return c.who === 'anyone' ? (c.home ? 'someone’s home' : 'nobody’s home') : c.who === 'no-one' ? (c.home ? 'nobody’s home' : 'someone’s home') : `${nm(n.people, c.who)} is ${c.home ? 'home' : 'out'}`;
    case 'mode': return c.modes.length ? `in ${c.modes.map(m => nm(n.modes, m)).join(' or ')}` : 'in a mode (pick one)';
    case 'overlay': return `${c.overlay ? nm(n.overlays, c.overlay) : 'an overlay'} is ${c.active ? 'on' : 'off'}`;
    case 'all': return c.conditions.map(k => conditionText(k, n)).join(' and ') || 'all of (nothing yet)';
    case 'any': return c.conditions.length > 1 ? `either ${c.conditions.map(k => conditionText(k, n)).join(' or ')}` : c.conditions.map(k => conditionText(k, n)).join('') || 'any of (nothing yet)';
    case 'not': return `not (${c.conditions.map(k => conditionText(k, n)).join(' or ') || 'nothing yet'})`;
    case 'room': { const r = nm(n.rooms, c.room) || 'a room', m = c.withinMin ?? ACTIVE_MIN; return c.active === false ? `no activity in ${r} for ${durWords(m * 60)}` : `there’s been activity in ${r} in the last ${durWords(m * 60)}`; }
  }
}

export function targetText(id: string, cmd: Command, n: Names): string {
  if (id.startsWith('zone:')) return `${dn(n, id)}: ${zoneCommandWords(cmd as ZoneCommand)}`;
  const z = n.devices.find(d => d.id === id)?.zoneNames;
  return `${dn(n, id)}: ${commandWords(cmd, z)}`;
}

export function actionText(a: Action, n: Names): string {
  const list = (l: Action[] | undefined) => (l ?? []).map(k => actionText(k, n)).join(', then ') || 'nothing';
  switch (a.kind) {
    case 'set': return Object.entries(a.targets).map(([id, c]) => `set ${targetText(id, c, n)}`).join('; ') || 'set devices (pick one)';
    case 'ramp': return `ramp ${Object.keys(a.targets).map(id => dn(n, id)).join(', ') || '(pick a device)'} ${FIELD_WORD[a.field]}${a.from != null ? ` from ${a.from}` : ''} to ${a.to} over ${durWords(a.overSec)}`;
    case 'delay': return `wait ${durWords(a.seconds)}`;
    case 'wait': return `wait until ${conditionText(a.until, n)}${a.timeoutSec ? ` (at most ${durWords(a.timeoutSec)}${a.stopOnTimeout ? ', else stop' : ''})` : ''}`;
    case 'notify': return `notify ${a.people?.length ? a.people.map(p => nm(n.people, p)).join(' and ') : 'everyone'}: “${a.title ? `${a.title}: ` : ''}${a.message || '…'}”`;
    case 'overlay': return `${a.op === 'end' ? 'end' : 'start'} ${nm(n.overlays, a.overlay) || 'an overlay'}`;
    case 'if': return `if ${a.conditions.map(c => conditionText(c, n)).join(' and ') || '…'}, ${list(a.then)}${a.else?.length ? `; otherwise ${list(a.else)}` : ''}`;
    case 'repeat': return `${a.times} times: ${list(a.actions)}`;
    case 'run': return `run ${nm(n.automations, a.automation) || 'another automation'}`;
    case 'stop': return 'stop';
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The whole automation in plain words, as the editor's live summary. */
export function draftSummary(d: Draft, n: Names): { when: string; onlyIf: string; then: string; sentence: string } {
  const when = d.triggers.map(t => triggerText(t, n)).join(', or ');
  const onlyIf = d.conditions.map(c => conditionText(c, n)).join(', and ');
  const then = d.actions.map(a => actionText(a, n)).join(', then ');
  const sentence = !d.triggers.length && !d.actions.length ? 'Add what starts it, then what it does.'
    : `${isOneTime(d) ? cap(when) : when ? `When ${when}` : 'When (add a trigger)'}${onlyIf ? `, only if ${onlyIf}` : ''}: ${then || '(add a step)'}.`;
  return { when: cap(when), onlyIf: cap(onlyIf), then: cap(then), sentence };
}

/** A name for a one-time schedule left unnamed, the way the assistant names them: "Lamp off at 15:00". */
export function scheduleName(d: Draft, n: Names): string {
  const once = d.triggers.find((t): t is Extract<Trigger, { kind: 'once' }> => t.kind === 'once');
  const first = d.actions[0];
  let what = 'Reminder';
  if (first?.kind === 'set') {
    const [id, c] = Object.entries(first.targets)[0] ?? [];
    if (id) what = `${dn(n, id)} ${commandWords(c!).split(', ').slice(0, 2).join(', ')}`;
  } else if (first?.kind === 'notify') what = first.title || (first.message ? first.message.slice(0, 40) : 'Reminder');
  else if (first) what = cap(actionText(first, n)).slice(0, 50);
  if (!once?.at) return what.slice(0, 80);
  const w = n.now ? onceWords(once.at, n.now) : `${dateOf(once.at)} at ${timeOf(once.at)}`;
  return `${what} ${w.startsWith('today ') ? w.slice(6) : w.startsWith('tomorrow') ? w : `on ${w}`}`.slice(0, 80);
}

// --------------------------------------------------------------- devices ---

export interface DeviceSection { room: string; items: Opt[] }
/** Devices to pick from, by room (rooms in the home's order), filtered by a search over name and room. */
export function deviceSections(devices: Pick<Device, 'id' | 'name' | 'room' | 'type' | 'hidden'>[], rooms: Room[], q: string, only?: (d: Pick<Device, 'type' | 'capabilities'>) => boolean): DeviceSection[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const name = (id: string) => rooms.find(r => r.id === id)?.name ?? (id === WHOLE_HOME ? WHOLE_HOME_NAME : id || 'No room');
  const order = (id: string) => { const i = rooms.findIndex(r => r.id === id); return i < 0 ? rooms.length : i; };
  const by = new Map<string, Opt[]>();
  for (const d of devices.filter(x => !only || only(x as Pick<Device, 'type' | 'capabilities'>)).sort((a, b) => order(a.room) - order(b.room) || a.name.localeCompare(b.name))) {
    const hay = `${d.name} ${name(d.room)}`.toLowerCase();
    if (words.some(w => !hay.includes(w))) continue;
    const l = by.get(d.room) ?? [];
    l.push({ v: d.id, label: d.name });
    by.set(d.room, l);
  }
  return [...by].map(([room, items]) => ({ room: name(room), items }));
}
/** "Lounge · Lamp", a group's words ("All lights"), or the id with (missing) when the device is gone. */
export function deviceLabel(id: string, devices: Pick<Device, 'id' | 'name' | 'room'>[], rooms: Pick<Room, 'id' | 'name'>[]): string {
  const p = pseudoLabel(id, rooms);
  if (p) return p;
  const d = devices.find(x => x.id === id);
  if (!d) return id ? `${id} (missing)` : 'Pick a device';
  const r = rooms.find(x => x.id === d.room)?.name;
  return r ? `${r} · ${d.name}` : d.name;
}

// ----------------------------------------------------------------- list ----

export const RESULT: Record<RunResult, [string, string]> = {
  done: ['Ran', '#7fd4a0'], stopped: ['Ran', '#7fd4a0'], skipped: ['Skipped', '#a3a09a'], cancelled: ['Cancelled', '#a3a09a'], failed: ['Failed', '#ff6b5e'], running: ['Running', '#f2b14c'],
};

/** The last-run line under an automation, and its colour. */
export function lastRunLine(r: AutomationView['lastRun']): [string, string] {
  if (!r) return ['Not run yet', '#6f6d69'];
  const [label, colour] = RESULT[r.result] ?? ['', '#a3a09a'];
  const detail = (r.result === 'skipped' || r.result === 'failed') && r.detail ? ` · ${r.detail}` : '';
  return [`${label} ${r.atLabel}${detail}`, colour];
}

/** Search over the name, description and the words for its parts. */
export function filterAutomations<A extends Pick<AutomationView, 'name' | 'description' | 'triggerLabels' | 'conditionLabels' | 'actionLabels'>>(l: A[], q: string): A[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return l;
  return l.filter(a => {
    const hay = [a.name, a.description ?? '', ...(a.triggerLabels ?? []), ...(a.conditionLabels ?? []), ...(a.actionLabels ?? [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

/** When / Only if / Then, in words. */
export function summary(a: Words): { when: string; onlyIf: string; then: string } {
  return {
    when: (a.triggerLabels ?? []).join(' · or · ') || 'Nothing starts it yet',
    onlyIf: (a.conditionLabels ?? []).join(', '),
    then: (a.actionLabels ?? []).join(' → ') || 'Nothing to do yet',
  };
}

const viewOneTime = (a: AutomationView) => a.oneTime ?? isOneTime(a);
const viewDone = (a: AutomationView) => a.done ?? (isOneTime(a) && a.triggers.every(t => t.kind === 'once' && !!t.firedAt));
/** The list in three: one-time schedules still to come (soonest first), ordinary automations, and finished schedules. */
export function sectionsOf(l: AutomationView[]): { scheduled: AutomationView[]; regular: AutomationView[]; done: AutomationView[] } {
  const scheduled = l.filter(a => viewOneTime(a) && !viewDone(a));
  // Switched on first, then the soonest: by the hub's nextAt, else by the stamp (they sort as text).
  scheduled.sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || ((a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || 0) || onceStamp(a).localeCompare(onceStamp(b)));
  const done = l.filter(a => viewOneTime(a) && viewDone(a)).sort((a, b) => lastFired(b) - lastFired(a));
  return { scheduled, regular: l.filter(a => !viewOneTime(a)), done };
}
/** The next once time of a schedule as a stamp (for sorting and words when the hub hasn't said). */
export const onceStamp = (a: Pick<Draft, 'triggers'>) => a.triggers.map(t => (t.kind === 'once' && !t.firedAt ? t.at : '')).filter(Boolean).sort()[0] ?? a.triggers.map(t => (t.kind === 'once' ? t.at : '')).filter(Boolean).sort().pop() ?? '';
const lastFired = (a: Pick<Draft, 'triggers'>) => Math.max(0, ...a.triggers.map(t => (t.kind === 'once' ? t.firedAt ?? 0 : 0)));
/** A schedule's line: "Today at 15:30 · in 25 min", "Off · was tomorrow at 07:00", "Ran today at 15:30", "Missed: …". */
export function scheduleLine(a: AutomationView, now: string): { text: string; tone: 'amber' | 'stone' | 'green' | 'red' } {
  const st = onceStamp(a), w = st ? onceWords(st, now) : '';
  if (viewDone(a)) {
    const missed = a.triggers.some(t => t.kind === 'once' && t.missed);
    return missed ? { text: `Missed: Kova was off ${w}`, tone: 'red' } : { text: `Ran ${w}`, tone: 'green' };
  }
  if (!a.enabled) return { text: `Off · ${w}`, tone: 'stone' };
  if (a.nextAt == null && st && st <= now && !a.nextLabel) return { text: `${cap(w)} · the time has passed`, tone: 'red' };
  const label = a.nextLabel ?? w;
  const until = st ? untilWords(st, now) : '';
  return { text: `${cap(label)}${until && until !== 'passed' ? ` · ${until}` : ''}`, tone: 'amber' };
}

/** A Home Assistant automation's state: converted, can convert (with what's left out), or needs rebuilding. */
export function haState(a: HaAutomation): { text: string; colour: string; canConvert: boolean } {
  if (a.converted) return { text: 'Converted', colour: '#7fd4a0', canConvert: false };
  if (!a.convertible) return { text: 'Needs rebuilding in Kova', colour: '#a3a09a', canConvert: false };
  const n = a.notes.length;
  return { text: n ? `Can convert · ${n} part${n === 1 ? '' : 's'} left out` : 'Can convert', colour: '#f2b14c', canConvert: true };
}
export const haText = (a: HaAutomation) => `${a.when[0] ?? ''}${a.cond.length ? `, ${a.cond[0].toLowerCase()}` : ''} → ${a.then[0] ?? ''}`;

/** Merge on/off taps not yet confirmed into the list; drop the ones the snapshot now agrees with. */
export function withPending<A extends { id: string; enabled: boolean }>(l: A[], pending: Record<string, boolean>): { list: A[]; settled: string[] } {
  const settled: string[] = [];
  const list = l.map(a => {
    if (!(a.id in pending)) return a;
    if (a.enabled === pending[a.id]) { settled.push(a.id); return a; }
    return { ...a, enabled: pending[a.id] };
  });
  for (const id of Object.keys(pending)) if (!l.some(a => a.id === id)) settled.push(id);
  return { list, settled };
}

/** When a run happened, on the phone's clock: "1 Oct 07:05". */
export function runTime(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clockOf(d.getHours(), d.getMinutes())}`;
}

/** The automations and suggestions in the live snapshot (the app's Snapshot type leaves them out). */
export const automationsOf = (s: unknown): AutomationView[] => (s as { automations?: AutomationView[] } | null)?.automations ?? [];
export const ideasOf = (s: unknown): Idea[] => (s as { automationIdeas?: Idea[] } | null)?.automationIdeas ?? [];

/**
 * Run now answers when the run ends, which for one with a wait or a delay can be minutes away. Give it `ms`;
 * if it's still going then, say so ('running') and let the history and the live list show how it ends.
 */
export function startRun<T>(p: Promise<T>, ms = 4000): Promise<T | 'running'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'running'>(resolve => { timer = setTimeout(() => resolve('running'), ms); });
  p.catch(() => {}); // a late failure, after 'running', has nowhere to go
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** What POST /api/automations/:id/run answers. */
export interface RunAnswer { ran: boolean; run?: AutomationRun | null; why?: string; /** Still going (a wait or a delay): the hub answered early. */ running?: boolean }
/** The toast after Run now: done, failed (and why), still running, or why it didn't start. */
export function runMessage(name: string, r: RunAnswer | 'running'): { text: string; ok: boolean; error: boolean } {
  if (r === 'running' || r.running || r.run?.result === 'running') return { text: `${name} is running`, ok: true, error: false };
  if (!r.ran) return { text: `${name}: ${r.why ?? 'it didn’t start'}`, ok: false, error: false };
  if (r.run?.result === 'failed') return { text: `${name}: failed${r.run.detail ? ` · ${r.run.detail}` : ''}`, ok: false, error: true };
  return { text: `${name}: done`, ok: true, error: false };
}

/** Ideas a new home might start from (the empty state). */
export const EXAMPLES = [
  ['nights_stay', 'Porch light on at sunset, off at 23:00'],
  ['notifications', 'Tell me when the washing machine’s power drops (it’s done)'],
  ['directions_walk', 'Hall light on for 3 minutes when the camera sees someone after dark'],
  ['person', 'Everything off when the last person leaves'],
  ['timer', 'Once: the air conditioner off at 15:00 today'],
] as const;
