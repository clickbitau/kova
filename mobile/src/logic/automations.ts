// Automations on the phone: the shapes the hub sends (hub/src/model/types.ts), and the editor's logic kept free
// of React Native so the tests can run it under plain Node. The same rules as the web app's editor
// (web/index.html, kovaAutoVals): the defaults per kind, the state and command choices, rhythms and days.
import type { Command, Device, Room } from '../api/types';

// ------------------------------------------------------------------ shapes --

export interface StateMatch { on?: boolean; online?: boolean; input?: string; hvac?: string; activity?: string; playing?: boolean; muted?: boolean; mode?: string; motion?: boolean; open?: boolean }
export type NumericField = 'temp' | 'target' | 'power' | 'energy' | 'battery' | 'bri' | 'vol' | 'grid' | 'load' | 'humidity' | 'lux' | 'pm25';
/** What a room's cameras and sensors notice (hub engine/rooms.ts). */
export type RoomEvent = 'person' | 'motion' | 'ring' | 'vehicle' | 'animal' | 'package' | 'sound' | 'opened' | 'closed';
export type SunEvent = 'sunrise' | 'sunset' | 'dawn' | 'dusk';
export type Prayer = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
export type Rhythm = { kind: 'time'; at: string } | { kind: 'sun'; event: SunEvent; offsetMin?: number } | { kind: 'prayer'; prayer: Prayer; offsetMin?: number };
export type Targets = Record<string, Command>;

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
  | { kind: 'hub'; event: 'start' };

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

export type Action =
  | { kind: 'set'; targets: Targets }
  | { kind: 'delay'; seconds: number }
  | { kind: 'wait'; until: Condition; timeoutSec?: number; stopOnTimeout?: boolean }
  | { kind: 'notify'; title?: string; message: string; people?: string[] }
  | { kind: 'overlay'; overlay: string; op: 'start' | 'end' }
  | { kind: 'if'; conditions: Condition[]; then: Action[]; else?: Action[] }
  | { kind: 'repeat'; times: number; actions: Action[] }
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

export const TRIGGER_KINDS = opts<Trigger['kind']>([['device', 'A device changes'], ['numeric', 'A reading goes above or below'], ['event', 'A device event'], ['room', 'Something happens in a room'], ['time', 'A time of day'], ['every', 'Every few minutes'], ['presence', 'Someone comes or goes'], ['mode', 'A mode starts'], ['overlay', 'An overlay starts or ends'], ['hub', 'Kova starts']]);
export const CONDITION_KINDS = opts<Condition['kind']>([['device', 'A device is'], ['numeric', 'A reading is above or below'], ['time', 'The time or day'], ['presence', 'Who’s home'], ['mode', 'The mode'], ['overlay', 'An overlay'], ['room', 'Activity in a room'], ['any', 'Any of these'], ['all', 'All of these'], ['not', 'None of these']]);
export const ACTION_KINDS = opts<Action['kind']>([['set', 'Set devices'], ['delay', 'Wait a while'], ['wait', 'Wait until something is true'], ['notify', 'Send a notification'], ['overlay', 'Start or end an overlay'], ['if', 'If … otherwise …'], ['repeat', 'Repeat'], ['run', 'Run another automation'], ['stop', 'Stop here']]);
export const RUN_MODES = opts<RunMode>([['single', 'Ignore the new start'], ['restart', 'Start over'], ['queued', 'Run again after'], ['parallel', 'Run alongside']]);

export const FIELDS = opts<NumericField>([['temp', 'temperature'], ['target', 'set temperature'], ['power', 'power (W)'], ['energy', 'energy today (kWh)'], ['battery', 'battery (%)'], ['bri', 'brightness (%)'], ['vol', 'volume (%)'], ['humidity', 'humidity (%)'], ['lux', 'light level (lux)'], ['pm25', 'PM2.5']]);
export const EVENTS = opts([['person', 'sees a person'], ['ring', 'rings'], ['motion', 'detects motion'], ['vehicle', 'sees a vehicle'], ['animal', 'sees an animal'], ['package', 'sees a package'], ['sound', 'hears a sound'], ['video-started', 'starts a video'], ['music-started', 'starts music'], ['paused', 'pauses'], ['stopped', 'stops playing'], ['internet-down', 'internet goes down'], ['internet-up', 'internet comes back'], ['new-device', 'a new device joins']]);
/** What a room trigger starts on. */
export const ROOM_EVENTS = opts<RoomEvent>([['motion', 'motion (or a person)'], ['person', 'a person'], ['ring', 'the doorbell'], ['opened', 'a door or window opens'], ['closed', 'a door or window closes'], ['package', 'a package'], ['vehicle', 'a vehicle'], ['animal', 'an animal'], ['sound', 'a sound']]);
export const PRESENCE_EVENTS = opts<'arrives' | 'leaves' | 'first-arrives' | 'last-leaves'>([['arrives', 'comes home'], ['leaves', 'leaves'], ['first-arrives', 'first home (nobody was)'], ['last-leaves', 'last one out']]);
export const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The option list with the current value in it, even when it isn't one of the usual ones. */
export function withCurrent<V extends string>(list: Opt<V>[], cur: V | undefined): Opt<V>[] {
  return cur == null || cur === '' || list.some(o => o.v === cur) ? list : [...list, { v: cur, label: cur }];
}
export const labelOf = <V extends string>(list: Opt<V>[], v: V | undefined, fallback = '') => list.find(o => o.v === v)?.label ?? (v || fallback);

// A device's state as one choice. The key is the match as JSON with its keys in a fixed order, so a match the
// hub sends back ({ input, on }) finds its option ({ on, input }).
const STATE_ORDER: (keyof StateMatch)[] = ['on', 'online', 'input', 'hvac', 'activity', 'playing', 'muted', 'mode'];
export function stateKey(m: StateMatch | undefined): string {
  if (!m) return '';
  const o: Record<string, unknown> = {};
  for (const k of STATE_ORDER) if (m[k] !== undefined) o[k] = m[k];
  for (const k of Object.keys(m).sort()) if (!(k in o) && (m as Record<string, unknown>)[k] !== undefined) o[k] = (m as Record<string, unknown>)[k];
  return JSON.stringify(o);
}
export const stateFromKey = (k: string): StateMatch | undefined => (k ? JSON.parse(k) as StateMatch : undefined);

const STATES: [StateMatch, string][] = [
  [{ on: true }, 'on'], [{ on: false }, 'off'], [{ online: false }, 'offline'], [{ online: true }, 'online'], [{ playing: true }, 'playing'], [{ playing: false }, 'not playing'],
  ...['tv', 'hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'].map((i): [StateMatch, string] => [{ on: true, input: i }, `on ${i === 'tv' ? 'TV' : `HDMI ${i.slice(4)}`}`]),
  [{ on: true, hvac: 'cool' }, 'cooling'], [{ on: true, hvac: 'heat' }, 'heating'], [{ activity: 'cleaning' }, 'cleaning'], [{ activity: 'docked' }, 'docked'], [{ muted: true }, 'muted'],
  [{ motion: true }, 'detecting motion'], [{ motion: false }, 'clear of motion'], [{ open: true }, 'open'], [{ open: false }, 'closed'],
];
/** The states a device can be matched on, with the current one added when it's unusual. */
export function stateOptions(cur?: StateMatch): Opt[] {
  const l = STATES.map(([m, label]) => ({ v: stateKey(m), label }));
  const k = stateKey(cur);
  return k && !l.some(o => o.v === k) ? [...l, { v: k, label: stateWords(cur!) }] : l;
}
/** A match in words, for one the list doesn't have ("on, input hdmi2, muted"). */
export function stateWords(m: StateMatch): string {
  const known = STATES.find(([x]) => stateKey(x) === stateKey(m));
  if (known) return known[1];
  return Object.entries(m).map(([k, v]) => typeof v === 'boolean' ? (k === 'on' ? (v ? 'on' : 'off') : `${v ? '' : 'not '}${k}`) : `${k} ${v}`).join(', ') || 'any state';
}

type Dev = Pick<Device, 'id' | 'type' | 'capabilities'>;
const has = (d: Dev, c: string) => (d.capabilities ?? []).includes(c);
const isPlayer = (d: Dev) => d.type === 'media' || d.type === 'tv';

/** What a step can set a device to: [command, words], as the web app offers them. */
export function commandOptions(d: Dev | undefined, sources: { name: string }[]): [Command, string][] {
  if (!d) return [];
  if (d.type === 'fan') return [[{ mode: 'Auto' }, 'Auto'], [{ mode: 'Sleep' }, 'Sleep'], [{ on: false }, 'Off']];
  if (d.type === 'climate') return [[{ on: true, hvac: 'cool', target: 24 }, 'Cool to 24°'], [{ on: true, hvac: 'heat', target: 21 }, 'Heat to 21°'], [{ on: true, hvac: 'auto', target: 23 }, 'Auto at 23°'], [{ on: false }, 'Off']];
  if (d.type === 'internet') return [[{ on: false }, 'Pause internet'], [{ on: true }, 'Internet on']];
  if (has(d, 'library')) return [[{ paused: true }, 'Pause'], [{ on: false, media: null }, 'Stop']];
  if (isPlayer(d) && !has(d, 'media')) return [[{ on: false }, 'Off'], [{ on: true }, 'On']];
  if (isPlayer(d)) return [[{ on: false, media: null }, 'Stop'], ...sources.map((s): [Command, string] => [{ on: true, media: s.name, vol: 30 }, `Play ${s.name} at 30%`])];
  if (d.type === 'dimmer') return [[{ on: false }, 'Off'], ...[5, 10, 25, 50, 78, 100].map((b): [Command, string] => [{ on: true, bri: b }, `On at ${b}%`])];
  return [[{ on: true }, 'On'], [{ on: false }, 'Off']];
}
const cmdKey = (c: Command) => JSON.stringify(Object.keys(c).sort().reduce<Record<string, unknown>>((o, k) => { o[k] = (c as Record<string, unknown>)[k]; return o; }, {}));
/** Command choices for a device as options keyed by JSON, with the current command kept when it isn't one of them. */
export function commandChoices(d: Dev | undefined, sources: { name: string }[], cur?: Command): Opt[] {
  const l = commandOptions(d, sources).map(([c, label]) => ({ v: cmdKey(c), label }));
  if (cur && !l.some(o => o.v === cmdKey(cur))) l.unshift({ v: cmdKey(cur), label: commandWords(cur) });
  return l;
}
export const commandKey = cmdKey;
export const commandFromKey = (k: string) => JSON.parse(k) as Command;
/** A command in words, for one set elsewhere ("on, 40%"). */
export function commandWords(c: Command): string {
  const p: string[] = [];
  if (c.on === true) p.push('On'); else if (c.on === false) p.push('Off');
  if (c.bri != null) p.push(`${c.bri}%`);
  if (c.k != null) p.push(`${c.k}K`);
  if (c.hvac) p.push(c.hvac);
  if (c.target != null) p.push(`${c.target}°`);
  if (c.media) p.push(`play ${c.media}`);
  if (c.vol != null) p.push(`volume ${c.vol}%`);
  if (c.input) p.push(`input ${c.input}`);
  if (c.mode) p.push(c.mode);
  if (c.paused === true) p.push('Pause');
  return p.join(', ') || 'As set';
}
/** The first thing a device can be set to (what a new row starts with). */
export const firstCommand = (d: Dev | undefined, sources: { name: string }[]): Command => commandOptions(d, sources)[0]?.[0] ?? { on: true };

/** Swap one device in a step's targets for another, keeping its place; the new one starts on its first command. */
export function retarget(t: Targets, from: string, to: string, cmd: Command): Targets {
  if (from === to) return t;
  const o: Targets = {};
  for (const [k, c] of Object.entries(t)) { if (k === to) continue; o[k === from ? to : k] = k === from ? cmd : c; }
  return o;
}

// ------------------------------------------------------------- rhythms -----

export const RHYTHMS = opts([['time', 'At a time'], ['sun:sunrise', 'Sunrise'], ['sun:sunset', 'Sunset'], ['sun:dawn', 'First light'], ['sun:dusk', 'Dusk'], ['prayer:fajr', 'Fajr'], ['prayer:dhuhr', 'Dhuhr'], ['prayer:asr', 'Asr'], ['prayer:maghrib', 'Maghrib'], ['prayer:isha', 'Isha']]);
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

// ------------------------------------------------------------- defaults ----

/** What new parts start with: the home's first device, mode, overlay and so on. */
export interface Ctx {
  device?: string;
  /** The first device a step can set, and what it's set to first. */
  actDevice?: string;
  actCommand?: Command;
  mode?: string;
  overlay?: string;
  /** The home's first room, for room triggers and conditions. */
  room?: string;
  /** Another automation, for "run another automation". */
  other?: string;
}

export function newTrigger(kind: Trigger['kind'], c: Ctx): Trigger {
  switch (kind) {
    case 'device': return { kind, device: c.device ?? '', to: { on: true } };
    case 'numeric': return { kind, device: c.device ?? '', field: 'temp', above: 28 };
    case 'event': return { kind, device: c.device ?? '', event: 'person' };
    case 'room': return { kind, room: c.room ?? '', event: 'motion' };
    case 'time': return { kind, at: { kind: 'time', at: '21:00' } };
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
export function changeKind<P extends Trigger | Condition>(cur: P, fresh: P): P {
  const keep = ['device', 'field', 'above', 'below'] as const;
  const out = { ...fresh } as Record<string, unknown>;
  for (const k of keep) if (k in out && k in cur && (cur as Record<string, unknown>)[k] !== undefined) out[k] = (cur as Record<string, unknown>)[k];
  // Groups keep what was in them.
  if ('conditions' in fresh && 'conditions' in cur) out.conditions = (cur as { conditions: Condition[] }).conditions;
  return out as P;
}

export const isGroup = (c: Condition): c is { kind: 'all' | 'any' | 'not'; conditions: Condition[] } => c.kind === 'all' || c.kind === 'any' || c.kind === 'not';

// --------------------------------------------------------------- drafts ----

export const blankDraft = (): Draft => ({ name: '', enabled: true, mode: 'single', triggers: [], conditions: [], actions: [] });

/** The editable part of an automation (or a suggestion), without what the hub adds for lists. */
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

export function draftOf(a: Partial<Automation> | Idea | null | undefined): Draft {
  if (!a) return blankDraft();
  const d: Draft = {
    name: a.name ?? '', enabled: 'enabled' in a ? a.enabled !== false : true, mode: a.mode ?? 'single',
    triggers: clone(a.triggers ?? []), conditions: clone(a.conditions ?? []), actions: clone(a.actions ?? []),
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
export function ctxOf(o: { devices: Dev[]; sources: { name: string }[]; modes: { id: string }[]; overlays: { id: string }[]; automations: { id: string }[]; rooms?: { id: string }[]; self?: string | null }): Ctx {
  const act = o.devices.find(canSet);
  return {
    device: o.devices[0]?.id, actDevice: act?.id, actCommand: act ? firstCommand(act, o.sources) : undefined,
    mode: o.modes[0]?.id, overlay: o.overlays[0]?.id, room: o.rooms?.[0]?.id, other: o.automations.find(a => a.id !== o.self)?.id,
  };
}
/** Devices a step can set (cameras and sensors only report). */
export const canSet = (d: Pick<Device, 'type'> & { kind?: string }) => d.type !== 'camera' && d.type !== 'sensor' && d.kind !== 'sensor';

// --------------------------------------------------------------- devices ---

export interface DeviceSection { room: string; items: Opt[] }
/** Devices to pick from, by room (rooms in the home's order), filtered by a search over name and room. */
export function deviceSections(devices: Pick<Device, 'id' | 'name' | 'room' | 'type' | 'hidden'>[], rooms: Room[], q: string, only?: (d: Pick<Device, 'type'>) => boolean): DeviceSection[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const name = (id: string) => rooms.find(r => r.id === id)?.name ?? (id || 'No room');
  const order = (id: string) => { const i = rooms.findIndex(r => r.id === id); return i < 0 ? rooms.length : i; };
  const by = new Map<string, Opt[]>();
  for (const d of devices.filter(x => !only || only(x)).sort((a, b) => order(a.room) - order(b.room) || a.name.localeCompare(b.name))) {
    const hay = `${d.name} ${name(d.room)}`.toLowerCase();
    if (words.some(w => !hay.includes(w))) continue;
    const l = by.get(d.room) ?? [];
    l.push({ v: d.id, label: d.name });
    by.set(d.room, l);
  }
  return [...by].map(([room, items]) => ({ room: name(room), items }));
}
/** "Lounge · Lamp", or the id with (missing) when the device is gone. */
export function deviceLabel(id: string, devices: Pick<Device, 'id' | 'name' | 'room'>[], rooms: Room[]): string {
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  ['ac_unit', 'Air conditioner on when the lounge goes above 28°, only if someone’s home'],
] as const;
