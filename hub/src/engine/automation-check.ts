import type { Action, Automation, Command, Condition, Device, HomeConfig, NumericField, RoomEventKind, RunMode, StateMatch, Trigger } from '../model/types.ts';
import { cleanTarget, rhythm } from './validate.ts';
import { FIELD_CAP, PSEUDO_TARGET } from '../util/describe.ts';

// Checks an automation someone made or edited, against the home it's for, and cleans it: only known fields,
// numbers in range, devices that exist and can do what's asked. Throws with a message a person can act on.

export interface CheckCtx {
  device(id: string): Device | undefined;
  cfg: Pick<HomeConfig, 'modes' | 'overlays' | 'people' | 'rooms'> & { automations?: { id: string }[] };
  /** The automation being edited (it can't run itself). */
  self?: string;
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

const fail = (m: string): never => { throw new Error(m); };
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
  if (typeof id !== 'string' || !id) fail(`Choose a device for ${role}`);
  if (!x.device(id as string)) fail(`Unknown device ${id} (${role})`);
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

export function checkTrigger(v: unknown, x: CheckCtx): Trigger {
  const t = obj(v, 'A trigger');
  const forSec = numOrUndef(t.forSec, 'How long', 0, 7 * 86400);
  switch (t.kind) {
    case 'device': {
      const to = t.to !== undefined ? stateMatch(t.to, 'Turns to') : undefined, from = t.from !== undefined ? stateMatch(t.from, 'Turns from') : undefined;
      if (!to && !from) fail('A device trigger needs a state to turn to (or from)');
      return { kind: 'device', device: device(x, t.device, 'the trigger'), ...(to ? { to } : {}), ...(from ? { from } : {}), ...(forSec ? { forSec } : {}) };
    }
    case 'numeric': return { kind: 'numeric', device: device(x, t.device, 'the trigger'), field: field(t.field), ...range(t, 'The trigger'), ...(forSec ? { forSec } : {}) };
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
      const at = rhythm(t.at) ?? fail('That time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"');
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
    default: return fail(`Unknown kind of trigger ${String(t.kind)}`);
  }
}

export function checkCondition(v: unknown, x: CheckCtx, depth = 0): Condition {
  if (depth > MAX_DEPTH) fail('Conditions are nested too deep');
  const c = obj(v, 'A condition');
  switch (c.kind) {
    case 'device': return { kind: 'device', device: device(x, c.device, 'a condition'), is: stateMatch(c.is, 'A condition') };
    case 'numeric': return { kind: 'numeric', device: device(x, c.device, 'a condition'), field: field(c.field), ...range(c, 'A condition') };
    case 'time': {
      const after = c.after === undefined ? undefined : (rhythm(c.after) ?? fail('The “after” time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"'));
      const before = c.before === undefined ? undefined : (rhythm(c.before) ?? fail('The “before” time isn’t valid — use "HH:MM", a sun event like "sunset", or a prayer like "isha"'));
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
    default: return fail(`Unknown kind of condition ${String(c.kind)}`);
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
    if (pm) {
      if (pm[1] === 'room' ? !x.cfg.rooms.some(r => r.id === pm[2]) : !DEVICE_TYPES.includes(pm[2]!)) fail(`Unknown ${pm[1]} target ${id}`);
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c)) {
        if (!FIELD_CAP[k]) fail(`${k} isn’t something devices can do`);
        cleaned[k] = v;
      }
      out[id] = cleaned as Command;
      continue;
    }
    const d = x.device(id) ?? fail(`Unknown device ${id}`);
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
      return { kind: 'ramp', targets: checkTargets(obj(a.targets, 'Devices to ramp'), x, { [f]: to }), field: f, to: to!, overSec: Math.round(overSec!), ...(from !== undefined ? { from } : {}), stepSec: Math.round(stepSec ?? 60) };
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
    default: return fail(`Unknown kind of step ${String(a.kind)}`);
  }
}

/** A whole automation from the editor, cleaned. */
export function checkAutomation(v: unknown, x: CheckCtx): Omit<Automation, 'id'> {
  const b = obj(v, 'The automation');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) fail('An automation needs a name');
  if (name.length > 80) fail('Keep the name under 80 characters');
  const triggers = list(b.triggers, 'Triggers').map(t => checkTrigger(t, x));
  if (!triggers.length) fail('Add at least one trigger: what starts it');
  if (triggers.length > 20) fail('Up to 20 triggers');
  const conditions = list(b.conditions, 'Conditions').map(c => checkCondition(c, x));
  const actions = list(b.actions, 'Steps').map(a => checkAction(a, x));
  if (!actions.length) fail('Add at least one step: what it does');
  const mode = b.mode === undefined ? 'single' : MODES.includes(b.mode as RunMode) ? b.mode as RunMode : fail(`${b.mode} isn’t a run mode`);
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 300) : undefined;
  const origin = b.origin && typeof b.origin === 'object' ? b.origin as Automation['origin'] : undefined;
  return { name, ...(description ? { description } : {}), enabled: b.enabled !== false, triggers, conditions, actions, mode, ...(origin ? { origin } : {}) };
}
