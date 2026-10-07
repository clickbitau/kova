import { FIVE_PRAYERS, type Action, type AnnounceTarget, type Automation, type Command, type Condition, type Device, type HomeConfig, type NumericField, type PrayerName, type RoomEventKind, type RunMode, type StateMatch, type Trigger } from '../model/types.ts';
import { announceTarget, DEFAULT_ANNOUNCE_LEVEL } from './announce.ts';
import { cleanTarget, isRhythmShape, rhythm } from './validate.ts';
import { FIELD_CAP, PSEUDO_TARGET } from '../util/describe.ts';
import { cleanZoneCommand } from '../util/zones.ts';
import { LOCAL_STAMP, localStamp, stampAt } from '../util/time.ts';

// Checks an automation someone made or edited, against the home it's for, and cleans it: only known fields,
// numbers in range, devices that exist and can do what's asked. Throws with a message a person can act on.

export interface CheckCtx {
  device(id: string): Device | undefined;
  cfg: Pick<HomeConfig, 'modes' | 'overlays' | 'people' | 'rooms'> & { automations?: { id: string }[]; timezone?: string };
  /** The automation being edited (it can't run itself). */
  self?: string;
  /** Now, for one-time schedules ("in 20 minutes", and refusing a time that has passed). Default: the clock. */
  now?: number;
  /** What's wrong with an announcement's media ("That clip isn’t on the hub"), or null when it can play. Unset: any string. */
  media?(m: string): string | null;
}

const FIELDS: NumericField[] = ['temp', 'target', 'power', 'energy', 'battery', 'bri', 'vol', 'grid', 'load', 'humidity', 'lux', 'pm25'];
/** What a room trigger can start on. */
export const ROOM_EVENTS: RoomEventKind[] = ['person', 'motion', 'ring', 'vehicle', 'animal', 'package', 'sound', 'opened', 'closed'];
/** Readings a ramp can ease between values. */
const RAMPABLE: NumericField[] = ['bri', 'vol', 'target'];
const DEVICE_TYPES = ['light', 'dimmer', 'fan', 'media', 'tv', 'plug', 'camera', 'sensor', 'vacuum', 'internet', 'climate'];
const MODES: RunMode[] = ['single', 'restart', 'queued', 'parallel'];
const HVAC = ['cool', 'heat', 'dry', 'fan', 'auto'];
const ACTIVITY = ['cleaning', 'returning', 'docked', 'paused', 'idle', 'error'];
const MAX_DEPTH = 6;

/**
 * A check that failed. `message` is for a person (the editor shows it); `fix` is what to send instead, as a concrete
 * example built from what was sent — Ask Kova's tools hand it to the model so it can correct the call itself.
 */
export class CheckError extends Error {
  constructor(message: string, readonly fix?: string) { super(message); }
}
const fail = (m: string, fix?: string): never => { throw new CheckError(m, fix); };
/** A compact JS-ish rendering of a value for a "send this instead" example. */
const show = (v: unknown): string => JSON.stringify(v)?.replace(/"([a-zA-Z_]\w*)":/g, '$1:').replace(/"/g, "'") ?? String(v);
const TRIGGER_KINDS = 'time, device, numeric, event, room, every, presence, mode, overlay, hub, once';
const CONDITION_KINDS = 'device, numeric, time, presence, mode, overlay, room, all, any, not';
const STEP_KINDS = 'set, ramp, delay, wait, notify, overlay, if, repeat, run, stop, announce';
const TIME_FIX = "{kind:'time', at:'07:30'}, or a sun or prayer time inside it: {kind:'time', at:{kind:'sun', event:'sunset', offsetMin:-15}}";
const obj = (v: unknown, what: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${what} isn’t valid`));
const list = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : fail(`${what} must be a list`));
const numOrUndef = (v: unknown, what: string, min = -1e9, max = 1e9): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fail(`${what} must be a number${min > -1e9 ? ` from ${min}` : ''}${max < 1e9 ? ` to ${max}` : ''}`);
};
const days = (v: unknown): number[] | undefined => {
  const d = list(v, 'Days').map(Number);
  if (d.some(x => !Number.isInteger(x) || x < 0 || x > 6)) fail('Days are 0 (Sunday) to 6 (Saturday)');
  return d.length ? [...new Set(d)].sort() : undefined;
};

function device(x: CheckCtx, id: unknown, role: string): string {
  if (typeof id !== 'string' || !id) fail(`Choose a device for ${role}`, `Give device: one of the device ids from the Devices list, e.g. device:'lamp'`);
  if (!x.device(id as string)) fail(`Unknown device ${id} (${role})`, `Use a device id exactly as the Devices list shows it (not a name); ${String(id)} isn't one`);
  return id as string;
}

function stateMatch(v: unknown, what: string): StateMatch {
  const m = obj(v, what), out: StateMatch = {};
  for (const k of ['on', 'online', 'playing', 'muted', 'motion', 'open'] as const) if (typeof m[k] === 'boolean') out[k] = m[k] as boolean;
  if (typeof m.input === 'string' && m.input) out.input = m.input;
  if (typeof m.hvac === 'string') out.hvac = HVAC.includes(m.hvac) ? m.hvac as StateMatch['hvac'] : fail(`${m.hvac} isn’t a climate mode`);
  if (typeof m.activity === 'string') out.activity = ACTIVITY.includes(m.activity) ? m.activity as StateMatch['activity'] : fail(`${m.activity} isn’t a vacuum activity`);
  if (typeof m.mode === 'string' && m.mode) out.mode = m.mode;
  if (!Object.keys(out).length) fail(`${what}: say what state to look for`);
  return out;
}

function range(t: Record<string, unknown>, what: string) {
  const above = numOrUndef(t.above, `${what}: above`), below = numOrUndef(t.below, `${what}: below`);
  if (above == null && below == null) fail(`${what}: give a value to go above or below`);
  if (above != null && below != null && above >= below) fail(`${what}: “above” has to be less than “below”`);
  return { above, below };
}
const field = (v: unknown): NumericField => (FIELDS.includes(v as NumericField) ? v as NumericField : fail(`${v} isn’t a reading Kova can compare`));
/** Readings a room has (from its sensors, a device there, or for temperature the zone serving it). */
export const ROOM_FIELDS: NumericField[] = ['temp', 'humidity', 'lux'];

/** What a numeric trigger or condition reads: a device, or "room:<id>" for the room's own reading. */
function numericSource(x: CheckCtx, t: Record<string, unknown>, role: string): { device: string; field: NumericField } {
  const f = field(t.field);
  // { room: "lounge" } is said as the device "room:lounge".
  const id = typeof t.room === 'string' && t.room && !t.device ? `room:${t.room}` : t.device;
  const rm = typeof id === 'string' ? /^room:(.+)$/.exec(id) : null;
  if (rm) {
    if (!x.cfg.rooms.some(r => r.id === rm[1])) fail(`Unknown room ${rm[1]} (${role})`);
    if (!ROOM_FIELDS.includes(f)) fail(`A room has a temperature, humidity and light level, not ${f}`);
    return { device: id as string, field: f };
  }
  return { device: device(x, id, role), field: f };
}

/**
 * Near misses read as what they plainly mean: a bare rhythm ("sunset", "21:00", {kind:'sun', …}, {kind:'prayer', …})
 * is a time trigger at it; a time trigger with its offset beside the rhythm has it moved in.
 */
function looseTrigger(v: unknown): unknown {
  if (typeof v === 'string' && rhythm(v)) return { kind: 'time', at: rhythm(v) };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const t = v as Record<string, unknown>;
  if (t.kind !== 'time' && isRhythmShape(t)) {
    const { days, ...rest } = t;
    const at = rhythm(rest) ?? fail('That time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"', `You sent ${show(v)}. Send ${TIME_FIX}. Offsets are minutes from -240 to 240.`);
    return { kind: 'time', at, ...(days !== undefined ? { days } : {}) };
  }
  if (t.kind === 'time' && !rhythm(t.at)) {
    // {kind:'time', at:'sunset', offset:-15} — the offset sits on the trigger, not the rhythm.
    const { days, kind: _k, ...rest } = t;
    const at = rhythm({ kind: 'time', ...rest }) ?? rhythm(rest);
    if (at) return { kind: 'time', at, ...(days !== undefined ? { days } : {}) };
  }
  const offKey = ['offsetMin', 'offset', 'offsetMinutes'].find(k => t[k] !== undefined);
  if (t.kind === 'time' && offKey) {
    // {kind:'time', at:'sunset', offsetMin:-15}: the offset belongs to the sun time.
    const at = rhythm({ kind: 'time', at: t.at, offsetMin: t[offKey] });
    if (at) { const { offsetMin: _o, offset: _p, offsetMinutes: _q, ...rest } = t; return { ...rest, at }; }
  }
  return v;
}

/** A sun or prayer time given as a condition: after or before it, when it says which. */
function looseCondition(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const c = v as Record<string, unknown>;
  if (c.kind !== 'time' && isRhythmShape(c)) {
    const side = c.when === 'before' || c.before === true ? 'before' : c.when === 'after' || c.after === true ? 'after' : undefined;
    const { before: _b, after: _a, when: _w, days, ...rest } = c;
    const at = rhythm(rest);
    if (at && side) return { kind: 'time', [side]: at, ...(days !== undefined ? { days } : {}) };
    if (at) fail('A sun or prayer time as a condition needs “after” or “before”', `{kind:'time', after:${show(at)}} (or before:)`);
  }
  return v;
}

export function checkTrigger(v0: unknown, x: CheckCtx): Trigger {
  const v = looseTrigger(v0);
  const t = obj(v, 'A trigger');
  const forSec = numOrUndef(t.forSec, 'How long', 0, 7 * 86400);
  switch (t.kind) {
    case 'device': {
      const to = t.to !== undefined ? stateMatch(t.to, 'Turns to') : undefined, from = t.from !== undefined ? stateMatch(t.from, 'Turns from') : undefined;
      if (!to && !from) fail('A device trigger needs a state to turn to (or from)');
      return { kind: 'device', device: device(x, t.device, 'the trigger'), ...(to ? { to } : {}), ...(from ? { from } : {}), ...(forSec ? { forSec } : {}) };
    }
    case 'numeric': return { kind: 'numeric', ...numericSource(x, t, 'the trigger'), ...range(t, 'The trigger'), ...(forSec ? { forSec } : {}) };
    case 'event': {
      if (typeof t.event !== 'string' || !t.event.trim()) fail('Choose the event');
      return { kind: 'event', device: device(x, t.device, 'the trigger'), event: (t.event as string).trim() };
    }
    case 'room': {
      if (!x.cfg.rooms.some(r => r.id === t.room)) fail(t.room ? `Unknown room ${t.room}` : 'Choose the room');
      if (!ROOM_EVENTS.includes(t.event as RoomEventKind)) fail(`Choose what happens in the room (${ROOM_EVENTS.join(', ')})`);
      return { kind: 'room', room: String(t.room), event: t.event as RoomEventKind };
    }
    case 'time': {
      const at = rhythm(t.at) ?? fail('That time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"', `You sent at:${show(t.at)}. Send ${TIME_FIX}. Offsets are minutes from -240 to 240.`);
      const d = days(t.days);
      return { kind: 'time', at, ...(d ? { days: d } : {}) };
    }
    case 'every': {
      const m = numOrUndef(t.minutes, 'Every … minutes', 1, 1440);
      if (!m) fail('Say how many minutes');
      return { kind: 'every', minutes: Math.round(m!) };
    }
    case 'presence': {
      const ev = ['arrives', 'leaves', 'first-arrives', 'last-leaves'];
      if (!ev.includes(String(t.event))) fail('Choose who arrives or leaves');
      if (t.person !== undefined && t.person !== '' && !x.cfg.people.some(p => p.id === t.person)) fail(`Unknown person ${t.person}`);
      return { kind: 'presence', event: t.event as 'arrives', ...(t.person ? { person: String(t.person) } : {}) };
    }
    case 'mode': {
      if (!x.cfg.modes.some(m => m.id === t.mode)) fail(`Unknown mode ${t.mode}`);
      return { kind: 'mode', mode: String(t.mode) };
    }
    case 'overlay': {
      if (!x.cfg.overlays.some(o => o.id === t.overlay)) fail(`Unknown overlay ${t.overlay}`);
      if (t.event !== 'starts' && t.event !== 'ends') fail('Choose starts or ends');
      return { kind: 'overlay', overlay: String(t.overlay), event: t.event as 'starts' };
    }
    case 'hub': return { kind: 'hub', event: 'start' };
    case 'once': {
      const tz = x.cfg.timezone ?? 'UTC', now = x.now ?? Date.now();
      const inMin = numOrUndef(t.inMinutes, 'In … minutes', 1, 366 * 1440);
      let at: string;
      if (inMin) at = localStamp(now + Math.round(inMin) * 60_000, tz);
      else if (typeof t.at === 'string' && LOCAL_STAMP.test(t.at.trim())) at = t.at.trim();
      // A full ISO time with a zone ("…Z", "…+08:00"): the home's own clock time for that instant.
      else if (typeof t.at === 'string' && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t.at) && Number.isFinite(Date.parse(t.at))) at = localStamp(Date.parse(t.at), tz);
      else return fail('Give a date and time for “once”, like "2026-10-08T15:30" (the home’s time), or inMinutes', `You sent at:${show(t.at)}. Send {kind:'once', at:'${localStamp(now + 3600_000, tz)}'} or {kind:'once', inMinutes:60}.`);
      if (stampAt(at, tz) == null) fail(`${at} isn’t a real date and time`);
      const firedAt = typeof t.firedAt === 'number' && Number.isFinite(t.firedAt) ? t.firedAt : undefined;
      return { kind: 'once', at, ...(firedAt ? { firedAt } : {}), ...(firedAt && t.missed === true ? { missed: true } : {}) };
    }
    default: return fail(`Unknown kind of trigger ${String(t.kind)}`, `Trigger kinds are ${TRIGGER_KINDS}. For a time of day send ${TIME_FIX}.`);
  }
}

export function checkCondition(v0: unknown, x: CheckCtx, depth = 0): Condition {
  if (depth > MAX_DEPTH) fail('Conditions are nested too deep');
  const v = looseCondition(v0);
  const c = obj(v, 'A condition');
  switch (c.kind) {
    case 'device': return { kind: 'device', device: device(x, c.device, 'a condition'), is: stateMatch(c.is, 'A condition') };
    case 'numeric': return { kind: 'numeric', ...numericSource(x, c, 'a condition'), ...range(c, 'A condition') };
    case 'time': {
      const after = c.after === undefined ? undefined : (rhythm(c.after) ?? fail('The “after” time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"', `You sent after:${show(c.after)}. Send {kind:'time', after:'22:00'} or {kind:'time', after:{kind:'sun', event:'sunset', offsetMin:-15}}.`));
      const before = c.before === undefined ? undefined : (rhythm(c.before) ?? fail('The “before” time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"', `You sent before:${show(c.before)}. Send {kind:'time', before:'06:00'} or {kind:'time', before:{kind:'sun', event:'sunrise'}}.`));
      const d = days(c.days);
      if (!after && !before && !d) fail('A time condition needs times or days');
      return { kind: 'time', ...(after ? { after } : {}), ...(before ? { before } : {}), ...(d ? { days: d } : {}) };
    }
    case 'presence': {
      const who = String(c.who ?? 'anyone');
      if (who !== 'anyone' && who !== 'no-one' && !x.cfg.people.some(p => p.id === who)) fail(`Unknown person ${who}`);
      return { kind: 'presence', who, home: c.home !== false };
    }
    case 'mode': {
      const ms = list(c.modes, 'Modes').map(String);
      if (!ms.length) fail('Choose at least one mode');
      for (const m of ms) if (!x.cfg.modes.some(y => y.id === m)) fail(`Unknown mode ${m}`);
      return { kind: 'mode', modes: ms };
    }
    case 'overlay': {
      if (c.overlay && !x.cfg.overlays.some(o => o.id === c.overlay)) fail(`Unknown overlay ${c.overlay}`);
      return { kind: 'overlay', ...(c.overlay ? { overlay: String(c.overlay) } : {}), active: c.active !== false };
    }
    case 'room': {
      if (!x.cfg.rooms.some(r => r.id === c.room)) fail(c.room ? `Unknown room ${c.room}` : 'Choose the room');
      const withinMin = numOrUndef(c.withinMin, 'Within … minutes', 1, 24 * 60);
      return { kind: 'room', room: String(c.room), active: c.active !== false, ...(withinMin ? { withinMin: Math.round(withinMin) } : {}) };
    }
    case 'all': case 'any': case 'not': {
      const cs = list(c.conditions, 'Conditions').map(k => checkCondition(k, x, depth + 1));
      if (!cs.length) fail(`An “${c.kind}” group needs at least one condition`);
      return { kind: c.kind, conditions: cs };
    }
    default: return fail(`Unknown kind of condition ${String(c.kind)}`, `Condition kinds are ${CONDITION_KINDS}, e.g. {kind:'time', after:{kind:'sun', event:'sunset'}} or {kind:'device', device:'lamp', is:{on:true}}.`);
  }
}

function checkTargets(t: Record<string, unknown>, x: CheckCtx, extra?: Record<string, unknown>): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const [id, cmd] of Object.entries(t)) {
    let c = obj(cmd, `What ${id} should do`);
    // The assistant tool spells extra fields as { set: {...} } — unwrap it here too.
    if (c.set && typeof c.set === 'object' && !Array.isArray(c.set)) { const { set, ...rest } = c; c = { ...rest, ...(set as Record<string, unknown>) }; }
    if (extra) c = { ...c, ...extra };
    // "type:light" / "room:lounge" — every matching device, now and later; each device keeps only what it can do at run time.
    const pm = PSEUDO_TARGET.exec(id);
    // "zone:lounge" — the air conditioner zone serving that room, on whichever unit serves it when it runs.
    if (pm && pm[1] === 'zone') {
      if (!x.cfg.rooms.some(r => r.id === pm[2])) fail(`Unknown room in ${id}`);
      out[id] = cleanZoneCommand(c) as unknown as Command;
      continue;
    }
    if (pm) {
      if (pm[1] === 'room' ? !x.cfg.rooms.some(r => r.id === pm[2]) : !DEVICE_TYPES.includes(pm[2]!)) fail(`Unknown ${pm[1]} target ${id}`, pm[1] === 'room' ? `Use 'room:<room id from the Rooms list>', e.g. 'room:${x.cfg.rooms[0]?.id ?? 'lounge'}'` : `Use 'type:' with one of ${DEVICE_TYPES.join(', ')}, e.g. 'type:light'`);
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c)) {
        if (!FIELD_CAP[k]) fail(`${k} isn’t something devices can do`);
        cleaned[k] = v;
      }
      out[id] = cleaned as Command;
      continue;
    }
    const d = x.device(id) ?? fail(`Unknown device ${id}`, `targets are keyed by device ids from the Devices list (or 'type:light', 'room:<id>'); ${id} isn't one`);
    out[id] = cleanTarget(d, c as Command);
  }
  if (!Object.keys(out).length) fail('Choose at least one device to set');
  return out;
}

export function checkAction(v: unknown, x: CheckCtx, depth = 0): Action {
  if (depth > MAX_DEPTH) fail('Steps are nested too deep');
  const a = obj(v, 'A step');
  const steps = (w: unknown, what: string) => list(w, what).map(k => checkAction(k, x, depth + 1));
  switch (a.kind) {
    case 'set': return { kind: 'set', targets: checkTargets(obj(a.targets, 'Devices to set'), x) };
    case 'ramp': {
      const f = RAMPABLE.includes(a.field as NumericField) ? a.field as NumericField : fail(`Ramp can only ease ${RAMPABLE.join(', ')}`);
      const to = numOrUndef(a.to, 'Ramp to');
      const overSec = numOrUndef(a.overSec ?? (a.overMin !== undefined && a.overMin !== null && a.overMin !== '' ? Number(a.overMin) * 60 : undefined), 'Ramp over', 10, 12 * 3600);
      const stepSec = numOrUndef(a.stepSec, 'Ramp step', 5, 3600);
      const from = a.from === undefined || a.from === null || a.from === '' ? undefined : numOrUndef(a.from, 'Ramp from');
      if (to === undefined) fail('Say what to ramp to');
      if (!overSec) fail('Say how long the ramp takes');
      // Devices that ease to their own end (learned from how someone sets them): known devices, numbers only.
      const toFor: Record<string, number> = {};
      if (a.toFor && typeof a.toFor === 'object' && !Array.isArray(a.toFor)) {
        for (const [id, v] of Object.entries(a.toFor as Record<string, unknown>)) {
          if (!x.device(id)) fail(`Unknown device ${id}`, 'toFor is keyed by device ids from the Devices list');
          toFor[id] = numOrUndef(v, `Ramp ${id} to`) ?? fail(`Say what ${id} ramps to`);
        }
      }
      return { kind: 'ramp', targets: checkTargets(obj(a.targets, 'Devices to ramp'), x, { [f]: to }), field: f, to: to!, overSec: Math.round(overSec!), ...(from !== undefined ? { from } : {}), stepSec: Math.round(stepSec ?? 60), ...(Object.keys(toFor).length ? { toFor } : {}) };
    }
    case 'delay': {
      const s = numOrUndef(a.seconds, 'Wait', 1, 7 * 86400);
      if (!s) fail('Say how long to wait');
      return { kind: 'delay', seconds: Math.round(s!) };
    }
    case 'wait': {
      const timeoutSec = numOrUndef(a.timeoutSec, 'At most', 1, 7 * 86400);
      return { kind: 'wait', until: checkCondition(a.until, x, depth + 1), ...(timeoutSec ? { timeoutSec: Math.round(timeoutSec), stopOnTimeout: a.stopOnTimeout === true } : {}) };
    }
    case 'notify': {
      const message = typeof a.message === 'string' ? a.message.trim() : '';
      if (!message) fail('Write the notification');
      if (message.length > 500) fail('Keep the notification under 500 characters');
      const people = list(a.people, 'People').map(String);
      for (const p of people) if (!x.cfg.people.some(q => q.id === p)) fail(`Unknown person ${p}`);
      const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 80) : undefined;
      return { kind: 'notify', message, ...(title ? { title } : {}), ...(people.length ? { people } : {}) };
    }
    case 'overlay': {
      if (!x.cfg.overlays.some(o => o.id === a.overlay)) fail(`Unknown overlay ${a.overlay}`);
      if (a.op !== 'start' && a.op !== 'end') fail('Choose start or end');
      return { kind: 'overlay', overlay: String(a.overlay), op: a.op as 'start' };
    }
    case 'if': {
      const conditions = list(a.conditions, 'If').map(k => checkCondition(k, x, depth + 1));
      if (!conditions.length) fail('“If” needs at least one condition');
      const then = steps(a.then, 'Then'), els = steps(a.else, 'Otherwise');
      if (!then.length && !els.length) fail('“If” needs something to do');
      return { kind: 'if', conditions, then, ...(els.length ? { else: els } : {}) };
    }
    case 'repeat': {
      const times = numOrUndef(a.times, 'Repeat', 1, 100);
      const acts = steps(a.actions, 'Repeat');
      if (!times || !acts.length) fail('Say how many times, and what to repeat');
      return { kind: 'repeat', times: Math.round(times!), actions: acts };
    }
    case 'run': {
      if (a.automation === x.self) fail('An automation can’t run itself');
      if (!x.cfg.automations?.some(o => o.id === a.automation)) fail(`Unknown automation ${a.automation}`);
      return { kind: 'run', automation: String(a.automation) };
    }
    case 'stop': return { kind: 'stop' };
    case 'announce': return checkAnnounce(a, x);
    default: return fail(`Unknown kind of step ${String(a.kind)}`, `Step kinds are ${STEP_KINDS}, e.g. {kind:'set', targets:{lamp:{on:true, bri:40}}} or {kind:'notify', message:'…'}.`);
  }
}

const PRAYERS: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

function announceMedia(v: unknown, x: CheckCtx, what: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return fail(`${what} must be the name of a source, a clip or a link`);
  const m = v.trim().slice(0, 500);
  const bad = x.media?.(m);
  if (bad) fail(`${what}: ${bad}`);
  return m;
}

/** An announcement: what plays, on which speakers at what level, what pauses, and putting it all back. */
function checkAnnounce(a: Record<string, unknown>, x: CheckCtx): Action {
  const media = announceMedia(a.media, x, 'What to play');
  const mf = a.mediaFor === undefined || a.mediaFor === null ? {} : obj(a.mediaFor, 'Audio for a prayer');
  const mediaFor: Partial<Record<PrayerName, string>> = {};
  for (const [k, v] of Object.entries(mf)) {
    if (!PRAYERS.includes(k as PrayerName)) fail(`${k} isn’t a prayer (${PRAYERS.join(', ')})`);
    const m = announceMedia(v, x, `Audio for ${k}`);
    if (m && m !== media) mediaFor[k as PrayerName] = m;
  }
  const t0 = obj(a.targets, 'Speakers');
  const targets: Record<string, AnnounceTarget> = {};
  for (const [id, raw] of Object.entries(t0)) {
    const d = x.device(id) ?? fail(`Unknown device ${id}`, `targets are keyed by speaker ids from the Devices list (type media, can volume); ${id} isn't one`);
    if (!announceTarget(d)) fail(`${d.name} isn’t a speaker Kova can announce on`, `Use speakers (type media with volume) or a speaker group as targets; put TVs and Helix boxes in pause instead`);
    const t = raw === true || raw === null || raw === undefined ? {} : typeof raw === 'number' ? { vol: raw } : obj(raw, `${d.name}`);
    const vol = numOrUndef((t as Record<string, unknown>).vol, `${d.name}: level`, 0, 100);
    const skip = list((t as Record<string, unknown>).skipWhile, `${d.name}: skip while`).map(String);
    for (const o of skip) if (!x.cfg.overlays.some(y => y.id === o)) fail(`Unknown overlay ${o}`);
    targets[id] = { ...(vol !== undefined ? { vol: Math.round(vol) } : {}), ...((t as Record<string, unknown>).off === true ? { off: true } : {}), ...(skip.length ? { skipWhile: [...new Set(skip)] } : {}) };
  }
  if (!Object.keys(targets).length) fail('Choose at least one speaker', `targets:{<speaker id>:{}, …} — every speaker the announcement plays on`);
  if (Object.values(targets).every(t => t.off)) fail('Every speaker is switched off: switch one on');
  const tv = Object.values(targets).map(t => t.vol).filter((v): v is number => v !== undefined);
  const vol = numOrUndef(a.vol, 'Level', 0, 100) ?? (tv.length && tv.every(v => v === tv[0]) ? tv[0]! : DEFAULT_ANNOUNCE_LEVEL);
  // A target's own level that is the step's level is the step's.
  for (const t of Object.values(targets)) if (t.vol === Math.round(vol)) delete t.vol;
  const pause = [...new Set(list(a.pause, 'Pause').map(String))];
  for (const id of pause) {
    const d = x.device(id) ?? fail(`Unknown device ${id} (pause)`);
    if (!d.capabilities.includes('pause')) fail(`${d.name} can’t pause`);
  }
  const maxSec = numOrUndef(a.maxSec, 'At most', 5, 1800);
  return {
    kind: 'announce', ...(media ? { media } : {}), ...(Object.keys(mediaFor).length ? { mediaFor } : {}), vol: Math.round(vol), targets,
    ...(pause.length ? { pause } : {}), restore: a.restore !== false, ...(maxSec ? { maxSec: Math.round(maxSec) } : {}),
  };
}

/** "Every prayer": {kind:'time', at:{kind:'prayer', prayer:'all'}} (or a bare {kind:'prayer', prayer:'all'}) is the five. */
function expandPrayers(list0: unknown[]): unknown[] {
  return list0.flatMap(v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [v];
    const t = v as Record<string, unknown>;
    const at = t.kind === 'time' && t.at && typeof t.at === 'object' ? t.at as Record<string, unknown> : t.kind === 'prayer' ? t : null;
    if (!at || at.kind !== 'prayer' || !['all', 'every', 'each', 'five', 'all five', 'every prayer'].includes(String(at.prayer).toLowerCase())) return [v];
    const off = at.offsetMin ?? at.offset;
    return FIVE_PRAYERS.map(p => ({ kind: 'time', at: { kind: 'prayer', prayer: p, ...(off !== undefined ? { offsetMin: off } : {}) }, ...(t.days !== undefined ? { days: t.days } : {}) }));
  });
}

/** Does an automation start on, or wait for, a prayer time anywhere? */
export function usesPrayer(a: Pick<Automation, 'triggers' | 'conditions' | 'actions'>): boolean {
  return JSON.stringify([a.triggers, a.conditions, a.actions]).includes('"kind":"prayer"');
}

/** Announce steps (anywhere, nested too) still waiting for their audio. */
export function announceWithoutMedia(actions: Action[]): boolean {
  return actions.some(x => x.kind === 'announce' ? !x.media : x.kind === 'if' ? announceWithoutMedia(x.then) || announceWithoutMedia(x.else ?? []) : x.kind === 'repeat' ? announceWithoutMedia(x.actions) : false);
}

/** A whole automation from the editor, cleaned. */
export function checkAutomation(v: unknown, x: CheckCtx): Omit<Automation, 'id'> {
  const b = obj(v, 'The automation');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) fail('An automation needs a name');
  if (name.length > 80) fail('Keep the name under 80 characters');
  const triggers = expandPrayers(list(b.triggers, 'Triggers')).map(t => checkTrigger(t, x));
  // The same trigger twice (the five prayers added twice) is once.
  for (let i = triggers.length - 1; i >= 0; i--) if (triggers.findIndex(t => JSON.stringify(t) === JSON.stringify(triggers[i])) < i) triggers.splice(i, 1);
  if (!triggers.length) fail('Add at least one trigger: what starts it', `Give when:[…], e.g. when:[${TIME_FIX.split(', or')[0]}]`);
  if (triggers.length > 20) fail('Up to 20 triggers');
  // A one-time schedule switched on has to have a time still to come; a time moved later goes off again.
  const tz = x.cfg.timezone ?? 'UTC', now = x.now ?? Date.now();
  for (const t of triggers) if (t.kind === 'once' && t.firedAt && (stampAt(t.at, tz) ?? 0) > now) { delete t.firedAt; delete t.missed; }
  const onceOnly = triggers.every(t => t.kind === 'once');
  if (onceOnly && b.enabled !== false && !triggers.some(t => t.kind === 'once' && !t.firedAt && (stampAt(t.at, tz) ?? 0) > now - 60_000)) {
    fail('That time has passed: choose a later one');
  }
  const conditions = list(b.conditions, 'Conditions').map(c => checkCondition(c, x));
  const actions = list(b.actions, 'Steps').map(a => checkAction(a, x));
  if (!actions.length) fail('Add at least one step: what it does', `Give then:[…], e.g. then:[{kind:'set', targets:{'type:light':{on:false}}}]`);
  const mode = b.mode === undefined ? 'single' : MODES.includes(b.mode as RunMode) ? b.mode as RunMode : fail(`${b.mode} isn’t a run mode`);
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 300) : undefined;
  const origin = b.origin && typeof b.origin === 'object' ? b.origin as Automation['origin'] : undefined;
  // An announcement whose audio isn't chosen yet (Ask Kova asks which) is kept, switched off until it is.
  const enabled = b.enabled !== false && !announceWithoutMedia(actions);
  return { name, ...(description ? { description } : {}), enabled, triggers, conditions, actions, mode, ...(origin ? { origin } : {}) };
}
