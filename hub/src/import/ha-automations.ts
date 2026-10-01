import type { Action, Automation, Command, Condition, Device, Person, Rhythm, RunMode, StateMatch, Trigger } from '../model/types.ts';

// Home Assistant automations (automations.yaml) as Kova automations. Entities are matched to Kova's devices by
// name (or id); what Kova can't do (templates, scripts, scenes, unmatched entities…) is left out and listed in
// the notes, so the owner sees exactly what to check. Converted automations start switched off: Home Assistant
// may still be running the originals.

type Json = Record<string, unknown>;

export interface HaLookup {
  /** The entity's friendly name. */
  name(entityId: string): string;
  devices: Device[];
  people: Person[];
}

export interface Converted { automation: Omit<Automation, 'id'> | null; notes: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const seconds = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(:\d+){0,2}$/.test(v)) {
    const p = v.replace(/^-/, '').split(':').map(Number);
    const [h, m, s] = p.length === 3 ? p : p.length === 2 ? [0, ...p] : [0, 0, p[0]];
    return h * 3600 + m * 60 + s;
  }
  if (v && typeof v === 'object') { const o = v as Json; return Number(o.hours ?? 0) * 3600 + Number(o.minutes ?? 0) * 60 + Number(o.seconds ?? 0); }
  return null;
};
const offsetMin = (v: unknown) => { const s = seconds(v); return s == null ? 0 : Math.round(s / 60) * (String(v).startsWith('-') ? -1 : 1); };
const clock = (v: unknown): string | null => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v)); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const WEEK: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function convertHaAutomation(a: Json, look: HaLookup): Converted {
  const notes: string[] = [];
  const note = (s: string) => { if (!notes.includes(s)) notes.push(s); };

  /** The Kova device for an entity: same name, else the same id. */
  const dev = (eid: string): Device | undefined => {
    const n = norm(look.name(eid)), obj = norm(eid.replace(/^[a-z_]+\./, ''));
    return look.devices.find(d => norm(d.name) === n) ?? look.devices.find(d => norm(d.id) === obj || norm(d.original?.name ?? '') === n);
  };
  const devOrNote = (eid: string, where: string): Device | undefined => {
    const d = dev(eid);
    if (!d) note(`${look.name(eid)} (${eid}) isn’t a Kova device yet, so ${where} was left out`);
    return d;
  };
  const person = (eid: string): Person | undefined => {
    const n = norm(look.name(eid)), obj = norm(eid.replace(/^[a-z_]+\./, ''));
    return look.people.find(p => norm(p.name) === n || norm(p.id) === obj || norm(p.name) === obj);
  };
  const stateMatch = (state: unknown): StateMatch | null => {
    const s = String(state);
    if (s === 'on' || s === 'home' || s === 'open' || s === 'detected') return { on: true };
    if (s === 'off' || s === 'not_home' || s === 'closed' || s === 'clear') return { on: false };
    if (s === 'playing') return { playing: true };
    if (s === 'paused' || s === 'idle' || s === 'standby') return { playing: false };
    if (s === 'unavailable') return { online: false };
    if (['cool', 'heat', 'dry', 'fan_only', 'auto', 'heat_cool'].includes(s)) return { on: true, hvac: (s === 'fan_only' ? 'fan' : s === 'heat_cool' ? 'auto' : s) as StateMatch['hvac'] };
    if (['cleaning', 'returning', 'docked', 'paused', 'idle', 'error'].includes(s)) return { activity: s as StateMatch['activity'] };
    return null;
  };
  const sunRhythm = (event: string, offset: unknown): Rhythm => ({ kind: 'sun', event: event === 'sunrise' ? 'sunrise' : 'sunset', ...(offsetMin(offset) ? { offsetMin: offsetMin(offset) } : {}) });

  // ------------------------------------------------------------- triggers --
  const triggers: Trigger[] = [];
  for (const t0 of arr(a.triggers ?? a.trigger)) {
    const t = t0 as Json, p = String(t.trigger ?? t.platform ?? '');
    const forSec = t.for != null ? seconds(t.for) ?? undefined : undefined;
    if (p === 'state') {
      for (const eid of arr(t.entity_id).map(String)) {
        if (/^(person|device_tracker)\./.test(eid)) {
          const who = person(eid);
          const ev = t.to === 'home' ? 'arrives' : t.to === 'not_home' || t.from === 'home' ? 'leaves' : null;
          if (ev && who) triggers.push({ kind: 'presence', event: ev, person: who.id });
          else note(`“${look.name(eid)} changes” has no Kova person or direction to match`);
          continue;
        }
        if (t.attribute) { note(`A trigger on ${look.name(eid)}’s ${t.attribute} was left out`); continue; }
        const d = devOrNote(eid, 'a trigger');
        if (!d) continue;
        const to = t.to != null ? stateMatch(t.to) : null, from = t.from != null ? stateMatch(t.from) : null;
        if (!to && !from) { note(`A trigger on ${d.name} changing to “${t.to ?? 'anything'}” has no Kova equivalent`); continue; }
        triggers.push({ kind: 'device', device: d.id, ...(to ? { to } : {}), ...(from ? { from } : {}), ...(forSec ? { forSec } : {}) });
      }
    } else if (p === 'numeric_state') {
      for (const eid of arr(t.entity_id).map(String)) {
        const d = devOrNote(eid, 'a trigger');
        if (!d) continue;
        const f = /temp/.test(String(t.attribute ?? eid)) ? 'temp' : /power|watt/.test(eid) ? 'power' : /battery/.test(eid) ? 'battery' : /energy/.test(eid) ? 'energy' : null;
        if (!f || (typeof t.above !== 'number' && typeof t.below !== 'number')) { note(`A number trigger on ${d.name} was left out`); continue; }
        triggers.push({ kind: 'numeric', device: d.id, field: f, ...(typeof t.above === 'number' ? { above: t.above } : {}), ...(typeof t.below === 'number' ? { below: t.below } : {}), ...(forSec ? { forSec } : {}) });
      }
    } else if (p === 'time') {
      for (const at of arr(t.at)) {
        const c = clock(at);
        if (c) triggers.push({ kind: 'time', at: { kind: 'time', at: c } });
        else note(`A time trigger at ${look.name(String(at))} (a helper) was left out`);
      }
    } else if (p === 'sun') {
      triggers.push({ kind: 'time', at: sunRhythm(String(t.event), t.offset) });
    } else if (p === 'time_pattern') {
      const m = /^\/(\d+)$/.exec(String(t.minutes ?? '')), h = /^\/(\d+)$/.exec(String(t.hours ?? ''));
      if (m) triggers.push({ kind: 'every', minutes: Number(m[1]) });
      else if (h) triggers.push({ kind: 'every', minutes: Number(h[1]) * 60 });
      else note('A repeating schedule trigger was left out');
    } else if (p === 'homeassistant' && t.event === 'start') {
      triggers.push({ kind: 'hub', event: 'start' });
    } else if (p === 'zone' && String(t.zone ?? 'zone.home') === 'zone.home') {
      for (const eid of arr(t.entity_id).map(String)) {
        const who = person(eid);
        if (who) triggers.push({ kind: 'presence', event: t.event === 'leave' ? 'leaves' : 'arrives', person: who.id });
        else note(`${look.name(eid)} isn’t a Kova person`);
      }
    } else {
      note(`A “${p || 'unknown'}” trigger has no Kova equivalent yet`);
    }
  }

  // ----------------------------------------------------------- conditions --
  const cond = (c0: unknown): Condition | null => {
    const c = c0 as Json, k = String(c.condition ?? '');
    if (k === 'state') {
      const out: Condition[] = [];
      for (const eid of arr(c.entity_id).map(String)) {
        if (/^(person|device_tracker)\./.test(eid)) {
          const who = person(eid);
          if (who) out.push({ kind: 'presence', who: who.id, home: c.state === 'home' });
          else note(`${look.name(eid)} isn’t a Kova person`);
          continue;
        }
        const d = devOrNote(eid, 'a condition');
        const is = stateMatch(c.state);
        if (d && is) out.push({ kind: 'device', device: d.id, is });
        else if (d) note(`A condition on ${d.name} being “${c.state}” has no Kova equivalent`);
      }
      return out.length === 1 ? out[0] : out.length ? { kind: 'all', conditions: out } : null;
    }
    if (k === 'numeric_state') {
      const d = devOrNote(String(arr(c.entity_id)[0] ?? ''), 'a condition');
      const eid = String(arr(c.entity_id)[0] ?? '');
      const f = /temp/.test(String(c.attribute ?? eid)) ? 'temp' : /power|watt/.test(eid) ? 'power' : /battery/.test(eid) ? 'battery' : null;
      if (!d || !f || (typeof c.above !== 'number' && typeof c.below !== 'number')) return null;
      return { kind: 'numeric', device: d.id, field: f, ...(typeof c.above === 'number' ? { above: c.above } : {}), ...(typeof c.below === 'number' ? { below: c.below } : {}) };
    }
    if (k === 'time') {
      const after = clock(c.after), before = clock(c.before);
      const days = arr(c.weekday).map(w => WEEK[String(w).slice(0, 3).toLowerCase()]).filter(n => n != null);
      if (c.after && !after) note('A time condition using a helper was left out');
      if (!after && !before && !days.length) return null;
      return { kind: 'time', ...(after ? { after: { kind: 'time', at: after } } : {}), ...(before ? { before: { kind: 'time', at: before } } : {}), ...(days.length ? { days } : {}) };
    }
    if (k === 'sun') {
      const after = c.after ? sunRhythm(String(c.after), c.after_offset) : undefined, before = c.before ? sunRhythm(String(c.before), c.before_offset) : undefined;
      return after || before ? { kind: 'time', ...(after ? { after } : {}), ...(before ? { before } : {}) } : null;
    }
    if (k === 'zone') {
      const who = person(String(arr(c.entity_id)[0] ?? ''));
      return who && String(c.zone) === 'zone.home' ? { kind: 'presence', who: who.id, home: true } : (note('A zone condition was left out'), null);
    }
    if (k === 'and' || k === 'or' || k === 'not') {
      const cs = arr(c.conditions).map(cond).filter((x): x is Condition => !!x);
      return cs.length ? { kind: k === 'and' ? 'all' : k === 'or' ? 'any' : 'not', conditions: cs } : null;
    }
    note(`A “${k || 'unknown'}” condition has no Kova equivalent yet`);
    return null;
  };
  const conditions = arr(a.conditions ?? a.condition).map(cond).filter((x): x is Condition => !!x);

  // -------------------------------------------------------------- actions --
  const targetIds = (x: Json): string[] => {
    const tg = (x.target ?? {}) as Json, dt = (x.data ?? {}) as Json;
    if (tg.area_id || tg.device_id) note('Steps aimed at an area or a device id were left out: choose the devices in Kova');
    return arr(tg.entity_id ?? dt.entity_id ?? x.entity_id).map(String);
  };
  const act = (x0: unknown): Action[] => {
    const x = x0 as Json;
    const svc = String(x.action ?? x.service ?? '');
    if (svc) {
      const [dom, op] = svc.split('.');
      const dt = (x.data ?? {}) as Json;
      if (dom === 'notify') {
        const message = String(dt.message ?? '').trim();
        if (!message || /\{\{|\{%/.test(message)) { note('A notification with a template was left out'); return []; }
        return [{ kind: 'notify', message: message.slice(0, 500), ...(dt.title ? { title: String(dt.title).slice(0, 80) } : {}) }];
      }
      if (dom === 'scene' || dom === 'script') { note(`${dom === 'scene' ? 'Scene' : 'Script'} ${targetIds(x).map(look.name).join(', ') || op} was left out: rebuild it as steps or an overlay`); return []; }
      const cmd: Command | null =
        op === 'turn_on' ? { on: true, ...(dt.brightness_pct != null ? { bri: Number(dt.brightness_pct) } : dt.brightness != null ? { bri: Math.round(Number(dt.brightness) / 2.55) } : {}), ...(dt.color_temp_kelvin != null ? { k: Number(dt.color_temp_kelvin) } : {}) }
        : op === 'turn_off' ? { on: false }
        : op === 'media_pause' ? { paused: true } : op === 'media_play' ? { paused: false } : op === 'media_stop' ? { on: false, media: null }
        : op === 'volume_set' ? { vol: Math.round(Number(dt.volume_level ?? 0) * 100) }
        : op === 'set_temperature' ? { target: Number(dt.temperature), ...(dt.hvac_mode ? { on: true, hvac: String(dt.hvac_mode) as never } : {}) }
        : op === 'set_hvac_mode' ? (dt.hvac_mode === 'off' ? { on: false } : { on: true, hvac: String(dt.hvac_mode) as never })
        : op === 'start' && dom === 'vacuum' ? { on: true } : op === 'return_to_base' ? { on: false }
        : null;
      if (!cmd) { note(`“${svc}” has no Kova equivalent yet`); return []; }
      const targets: Record<string, Command> = {};
      for (const eid of targetIds(x)) { const d = devOrNote(eid, `“${svc}”`); if (d) targets[d.id] = cmd; }
      return Object.keys(targets).length ? [{ kind: 'set', targets }] : [];
    }
    if (x.delay != null) { const s = seconds(x.delay); return s ? [{ kind: 'delay', seconds: s }] : (note('A delay using a template was left out'), []); }
    if (x.if) {
      const cs = arr(x.if).map(cond).filter((c): c is Condition => !!c);
      if (!cs.length) { note('An “if” whose condition Kova can’t check was left out'); return []; }
      return [{ kind: 'if', conditions: cs, then: arr(x.then).flatMap(act), ...(x.else ? { else: arr(x.else).flatMap(act) } : {}) }];
    }
    if (x.choose) {
      // Options become nested if / otherwise, in order; "default" is the last otherwise.
      let tail: Action[] = arr(x.default).flatMap(act);
      for (const opt of arr(x.choose).reverse() as Json[]) {
        const cs = arr(opt.conditions).map(cond).filter((c): c is Condition => !!c);
        if (!cs.length) { note('A choice whose condition Kova can’t check was left out'); continue; }
        tail = [{ kind: 'if', conditions: cs, then: arr(opt.sequence).flatMap(act), ...(tail.length ? { else: tail } : {}) }];
      }
      return tail;
    }
    if (x.repeat) {
      const r = x.repeat as Json;
      if (typeof r.count === 'number') return [{ kind: 'repeat', times: Math.min(100, r.count), actions: arr(r.sequence).flatMap(act) }];
      note('A repeat until / while was left out'); return [];
    }
    if (x.condition) { const c = cond(x); return c ? [{ kind: 'if', conditions: [c], then: [], else: [{ kind: 'stop' }] }] : []; }
    if (x.stop !== undefined) return [{ kind: 'stop' }];
    if (x.wait_template || x.wait_for_trigger) { note('A “wait for” step was left out: use “Wait until” in Kova'); return []; }
    if (x.scene) { note(`Scene ${look.name(String(x.scene))} was left out`); return []; }
    note('A step with no Kova equivalent was left out');
    return [];
  };
  const actions = arr(a.actions ?? a.action).flatMap(act).filter(x => x.kind !== 'if' || x.then.length || x.else?.length);

  const mode = (['single', 'restart', 'queued', 'parallel'].includes(String(a.mode)) ? a.mode : 'single') as RunMode;
  const name = String(a.alias ?? a.id ?? 'Home Assistant automation').slice(0, 80);
  if (!triggers.length) note('Nothing Kova can use starts it: add a trigger');
  if (!actions.length) note('Nothing Kova can do in it: add steps');
  if (!triggers.length || !actions.length) return { automation: null, notes };
  return {
    automation: {
      name, enabled: false, mode, triggers, conditions, actions,
      ...(a.description ? { description: String(a.description).slice(0, 300) } : {}),
      origin: { from: 'home-assistant', id: String(a.id ?? name), ...(notes.length ? { notes } : {}) },
    },
    notes,
  };
}
