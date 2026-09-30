import type { Engine } from '../engine/engine.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Cause, Device, Targets } from '../model/types.ts';
import { isLight, isPlayer } from '../util/describe.ts';

/** A follow-up the user can tap, executed by POST /api/ask/act. */
export type AskAction =
  | { type: 'apply'; targets: Targets; label: string; done: string }
  | { type: 'overlay'; id: string; done: string }
  | { type: 'learnGroup'; name: string; rooms: string[]; then?: { on: boolean } }
  | { type: 'screen'; screen: string };

export interface AskReply { text: string; actions: { label: string; action: AskAction }[] }

const CAUSE: Cause = { kind: 'assistant', label: 'Ask Kova' };
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Ask Kova, v1: a deterministic intent parser over the home model. It covers
 * on/off, "why", overlays and learning room groups. The same interface can
 * later be backed by an LLM with these intents as tools.
 */
export class Assistant {
  constructor(private engine: Engine, private reg: Registry, private config: ConfigStore) {}

  private rooms() { return this.config.get().rooms; }

  /** Find devices a phrase refers to: a group, a room, a device name, or "all lights". */
  private resolve(phrase: string): { devices: Device[]; label: string } | { unknown: string } | null {
    const p = norm(phrase).replace(/^(the|all the|all)\s+/, '').replace(/\s+(lights?|speakers?)$/, '').trim();
    const c = this.config.get();
    if (!p || p === 'everything' || p === 'house' || p === 'home') return { devices: this.reg.list(), label: 'Everything' };
    const group = Object.entries(c.groups).find(([g]) => norm(g) === p);
    if (group) return { devices: this.reg.list().filter(d => group[1].includes(d.room)), label: cap(group[0]) };
    const room = this.rooms().find(r => norm(r.name) === p || norm(r.id) === p || norm(r.name).startsWith(p));
    if (room) return { devices: this.reg.list().filter(d => d.room === room.id), label: room.name };
    const dev = this.reg.list().filter(d => {
      const full = norm(`${this.rooms().find(r => r.id === d.room)?.name ?? ''} ${d.name}`);
      return norm(d.name) === p || full === p || full.includes(p);
    });
    if (dev.length) return { devices: dev, label: dev.length === 1 ? dev[0].name : cap(phrase) };
    if (/^[a-z]+$/.test(p)) return { unknown: p };
    return null;
  }

  async ask(q: string): Promise<AskReply> {
    const t = norm(q);
    const c = this.config.get();

    // "downstairs is lounge, kitchen and laundry" — learn a group of rooms.
    const learn = q.toLowerCase().trim().replace(/[.!?]+$/, '').match(/^([a-z]+) (?:is|means|are) (.+)$/);
    if (learn) {
      const rooms = learn[2].split(/\s*(?:,|\band\b|&)\s*/).map(norm).filter(Boolean).map(s => this.rooms().find(r => norm(r.name) === s || norm(r.name).startsWith(s))).filter(Boolean);
      if (rooms.length) {
        const names = rooms.map(r => r!.name);
        return { text: `Got it. “${learn[1]}” will mean ${list(names)}.`, actions: [{ label: 'Remember that', action: { type: 'learnGroup', name: learn[1], rooms: rooms.map(r => r!.id) } }] };
      }
    }

    // Overlays: "start movie", "movie mode", "we're going away", "end party".
    const ov = c.overlays.find(o => t.includes(norm(o.name)));
    if (ov && /\b(end|stop|finish)\b/.test(t) && this.engine.overlay?.id === ov.id) {
      await this.engine.endOverlay('user');
      return { text: `${ov.name} is off. Back to ${this.engine.mode().name}.`, actions: [] };
    }
    if (ov && !/\b(turn|switch)\b/.test(t)) {
      await this.engine.startOverlay(ov.id, CAUSE);
      return { text: `${ov.name} is on. ${ov.endsLabel}.`, actions: [] };
    }

    // "why is the garage light on?"
    const why = t.match(/^why (?:is|are) (?:the )?(.+?)(?: (?:on|off|playing))?$/);
    if (why) {
      const r = this.resolve(why[1]);
      if (r && 'devices' in r && r.devices.length) {
        const d = r.devices.find(isLight) ?? r.devices[0];
        const w = this.engine.why(d.id);
        const state = d.state.on ? 'on' : 'off';
        const acts = d.state.on && (isLight(d) || isPlayer(d)) ? [{ label: 'Turn it off now', action: { type: 'apply' as const, targets: { [d.id]: { on: false } }, label: `${d.name} off`, done: `${d.name} is off.` } }] : [];
        return { text: `${d.name} is ${state}. ${w.now} Next: ${w.next}`, actions: acts };
      }
    }

    // "turn off downstairs", "lights on in the office".
    let dir: string | undefined, what: string | undefined;
    const m1 = t.match(/^(?:turn|switch|put) (on|off) (?:the )?(.+)$/);
    const m2 = t.match(/^(?:turn|switch) (?:the )?(.+) (on|off)$/);
    if (m1) { dir = m1[1]; what = m1[2]; } else if (m2) { dir = m2[2]; what = m2[1]; }
    if (dir && what) {
      const on = dir === 'on';
      const r = this.resolve(what);
      if (r && 'unknown' in r) {
        return { text: `I don’t know which rooms are “${r.unknown}” yet. Tell me, for example: “${r.unknown} is lounge, kitchen and laundry”, and I’ll remember.`, actions: [] };
      }
      if (r && 'devices' in r) {
        const wantsSpeakers = /speaker|music|media/.test(what);
        const ds = r.devices.filter(d => wantsSpeakers ? isPlayer(d) : isLight(d) || (!on && isPlayer(d) && /everything/.test(t)));
        if (!ds.length) return { text: `There’s nothing I can switch ${dir} in ${r.label}.`, actions: [] };
        const targets: Targets = Object.fromEntries(ds.map(d => [d.id, isPlayer(d) && !on ? { on: false, media: null } : { on }]));
        const { changed } = await this.engine.applyMany(targets, { ...CAUSE, label: `${r.label} ${dir}` });
        return { text: changed.length ? `Done. ${r.label}: ${changed.length} ${changed.length === 1 ? 'thing' : 'things'} ${dir}.` : `${r.label} was already ${dir}.`, actions: [] };
      }
    }

    if (/what.*(on|running)|which lights/.test(t)) {
      const on = this.reg.list().filter(d => isLight(d) && d.state.on);
      const names = on.map(d => `${this.rooms().find(r => r.id === d.room)?.name} ${d.name.toLowerCase()}`);
      return { text: on.length ? `${on.length} lights are on: ${list(names)}.` : 'All the lights are off.', actions: on.length ? [{ label: 'Turn them all off', action: { type: 'apply', targets: Object.fromEntries(on.map(d => [d.id, { on: false }])), label: 'All lights off', done: 'All lights are off.' } }] : [] };
    }

    if (/power|energy|using/.test(t)) {
      const plugs = this.reg.list().filter(d => d.state.power != null && d.state.on);
      if (!plugs.length) return { text: 'Nothing that measures power is connected yet. Add an energy integration and I’ll track it.', actions: [{ label: 'Open Integrations', action: { type: 'screen', screen: 'integrations' } }] };
      const top = [...plugs].sort((a, b) => (b.state.power ?? 0) - (a.state.power ?? 0));
      return { text: `Right now ${list(top.slice(0, 3).map(d => `${d.name} ${d.state.power} W`))}.`, actions: [{ label: 'Open Energy', action: { type: 'screen', screen: 'energy' } }] };
    }

    if (/mode|what.*happening|status/.test(t)) {
      const now = this.engine.planner.modeAt(this.engine.now());
      return { text: `The home is in ${now.mode.name}. ${now.next.name} starts next.`, actions: [] };
    }

    return { text: 'I can switch rooms and devices on or off, explain why something is on, start an overlay like Movie or Away, and learn names like “downstairs”.', actions: [] };
  }

  async act(a: AskAction): Promise<{ text: string; undo?: string }> {
    if (a.type === 'apply') { const r = await this.engine.applyMany(a.targets, { ...CAUSE, label: a.label }); return { text: a.done, undo: r.undo }; }
    if (a.type === 'overlay') return { text: a.done, undo: await this.engine.startOverlay(a.id, CAUSE) };
    if (a.type === 'learnGroup') {
      const undo = this.config.update(c => { c.groups[a.name] = a.rooms; });
      return { text: `Saved. Try “turn off ${a.name}”.`, undo: this.engine.registerUndo(undo) };
    }
    return { text: '' };
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
function list(xs: string[]): string { return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`; }
