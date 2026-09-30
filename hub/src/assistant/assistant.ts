import type { Engine } from '../engine/engine.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Cause, Device, Overlay, Targets } from '../model/types.ts';
import { isLight, isPlayer } from '../util/describe.ts';
import { clock } from '../util/time.ts';

// Ask Kova, built in: a deterministic intent parser that runs on the hub.
// No AI, nothing leaves the home. Requests are parsed into an Intent first,
// which the UI can show as "Understood" chips before anything runs.

/** Where an answer came from, shown under every reply. */
export type Source = 'Device control' | 'From the activity log' | 'From your modes' | 'Built-in · nothing left your home';

export type Intent =
  | { kind: 'power'; on: boolean; label: string; devices: string[] }
  | { kind: 'level'; bri: number; label: string; devices: string[] }
  | { kind: 'overlay'; id: string; name: string; end: boolean }
  | { kind: 'why'; device: string; label: string }
  | { kind: 'tonight' }
  | { kind: 'whoHome' }
  | { kind: 'whatsOn' }
  | { kind: 'status' }
  | { kind: 'learn'; name: string; rooms: string[]; roomNames: string[] }
  | { kind: 'unknownLabel'; word: string };

/** A follow-up the user can tap, executed by POST /api/ask/act. */
export type AskAction =
  | { type: 'apply'; targets: Targets; label: string; done: string }
  | { type: 'overlay'; id: string; done: string }
  | { type: 'learnGroup'; name: string; rooms: string[] }
  | { type: 'screen'; screen: string };

export interface AskReply { text: string; source: Source; actions: { label: string; action: AskAction }[]; undo?: string; understood: boolean }

const CAUSE: Cause = { kind: 'assistant', label: 'Ask Kova' };
export const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9% ]/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everyday phrases for overlays, on top of their names. */
const OVERLAY_PHRASES: Record<string, RegExp> = {
  away: /\b(leaving|heading out|going out|off out)\b/,
  good_night: /\b(good ?night|bed ?time|going to bed|off to bed)\b/,
  movie: /\b(movie|film|cinema)\b/,
  party: /\bparty\b/,
  date: /\bdate( night)?\b/,
  guests: /\b(guests?|visitors?)\b/,
};
const ARRIVED = /\b(im|i am|we re|were|we are) (home|back)\b|\bback home\b/;

export class Assistant {
  constructor(private engine: Engine, private reg: Registry, private config: ConfigStore) {}

  private rooms() { return this.config.get().rooms; }
  private roomName(id: string) { return this.rooms().find(r => r.id === id)?.name ?? id; }

  /** Devices a phrase refers to: a learned label, a room (optionally + device), a device, or everything. */
  private resolve(phrase: string): { devices: Device[]; label: string } | { unknown: string } | null {
    const raw = norm(phrase).replace(/^(the|all the|all|my)\s+/, '').trim();
    const wantsSpeakers = /\b(speakers?|music|audio)\b/.test(raw);
    const p = raw.replace(/\s+(lights?|speakers?|music|audio)$/, '').trim();
    const kind = (ds: Device[]) => ds.filter(d => wantsSpeakers ? isPlayer(d) : isLight(d));
    const noun = wantsSpeakers ? 'speakers' : 'lights';
    const c = this.config.get();
    if (!p || ['everything', 'house', 'home', 'lights', 'light', 'all'].includes(p)) return { devices: kind(this.reg.list()), label: `All ${noun}` };
    const group = Object.entries(c.groups).find(([g]) => norm(g) === p);
    if (group) return { devices: kind(this.reg.list().filter(d => group[1].includes(d.room))), label: cap(group[0]) };
    const room = [...this.rooms()].sort((a, b) => b.name.length - a.name.length)
      .find(r => norm(r.name) === p || norm(r.id) === p || p.startsWith(`${norm(r.name)} `) || (p.length > 2 && norm(r.name).startsWith(p)));
    if (room) {
      const rest = p.startsWith(`${norm(room.name)} `) ? p.slice(norm(room.name).length).trim() : '';
      const inRoom = this.reg.list().filter(d => d.room === room.id);
      const named = rest ? inRoom.filter(d => norm(d.name).includes(rest)) : [];
      if (named.length) return { devices: named, label: `${room.name} ${named.length === 1 ? named[0].name.toLowerCase() : rest}` };
      return { devices: kind(inRoom), label: `${room.name} ${noun}` };
    }
    const dev = this.reg.list().filter(d => {
      const full = norm(`${this.roomName(d.room)} ${d.name}`);
      return norm(d.name) === p || full === p || full.includes(p) || (p.length > 3 && norm(d.name).includes(p));
    });
    if (dev.length) return { devices: dev, label: dev.length === 1 ? dev[0].name : cap(phrase.trim()) };
    if (/^[a-z]+$/.test(p) && p.length > 2) return { unknown: p };
    return null;
  }

  /** Understand a request without doing anything. */
  parse(q: string): Intent | null {
    const t = norm(q);
    const raw = q.toLowerCase().trim().replace(/[.!?]+$/, '');
    const c = this.config.get();

    const learn = raw.match(/^([a-z]+) (?:is|means|are) (.+)$/);
    if (learn) {
      const rooms = learn[2].split(/\s*(?:,|\band\b|&)\s*/).map(norm).filter(Boolean)
        .map(s => this.rooms().find(r => norm(r.name) === s || norm(r.name).startsWith(s))).filter((r): r is NonNullable<typeof r> => !!r);
      if (rooms.length) return { kind: 'learn', name: learn[1], rooms: rooms.map(r => r.id), roomNames: rooms.map(r => r.name) };
    }
    if (/^who(s| is)?\b.*\b(home|in|here|out)\b/.test(t)) return { kind: 'whoHome' };
    if (/^why\b/.test(t)) {
      const m = t.match(/^why (?:is|are|did) (?:the )?(.+?)(?: (?:on|off|playing|turn on|come on))?$/);
      const r = m ? this.resolve(m[1]) : null;
      if (r && 'devices' in r && r.devices.length) {
        const d = r.devices.find(isLight) ?? r.devices[0];
        return { kind: 'why', device: d.id, label: `${this.roomName(d.room)} ${d.name.toLowerCase()}` };
      }
    }
    if (/\b(tonight|coming up|whats happening|what happens|schedule|whats next)\b/.test(t)) return { kind: 'tonight' };

    // "lamp to 30%", "dim the lounge to 20", "set office strip 50%"
    const lvl = t.match(/^(?:set |dim |brighten |turn )?(?:the )?(.+?) (?:to |at )?(\d{1,3}) ?%?$/);
    if (lvl && !/^(turn|switch) (on|off)\b/.test(t)) {
      const r = this.resolve(lvl[1]);
      if (r && 'devices' in r) {
        const ds = r.devices.filter(d => d.capabilities.includes('brightness'));
        if (ds.length) return { kind: 'level', bri: Math.max(1, Math.min(100, Number(lvl[2]))), label: r.label, devices: ds.map(d => d.id) };
      }
    }
    const m1 = t.match(/^(?:turn|switch|put) (on|off) (?:the )?(.+)$/), m2 = t.match(/^(?:turn|switch) (?:the )?(.+) (on|off)$/);
    const dir = m1?.[1] ?? m2?.[2], what = m1?.[2] ?? m2?.[1];
    if (dir && what) {
      const r = this.resolve(what);
      if (r && 'unknown' in r) return { kind: 'unknownLabel', word: r.unknown };
      if (r && 'devices' in r) return { kind: 'power', on: dir === 'on', label: r.label, devices: r.devices.filter(d => isLight(d) || isPlayer(d) || d.type === 'plug').map(d => d.id) };
    }
    if (ARRIVED.test(t) && this.engine.overlay?.id === 'away') return { kind: 'overlay', id: 'away', name: 'Away', end: true };
    const ov = c.overlays.find(o => new RegExp(`\\b${norm(o.name)}\\b`).test(t)) ?? c.overlays.find(o => OVERLAY_PHRASES[o.id]?.test(t));
    if (ov) return { kind: 'overlay', id: ov.id, name: ov.name, end: /\b(end|stop|finish|cancel|over)\b/.test(t) };
    if (/what.*\b(on|running)\b|which lights/.test(t)) return { kind: 'whatsOn' };
    if (/\b(mode|status|whats going on)\b/.test(t)) return { kind: 'status' };
    return null;
  }

  /** The "Understood" chips for a parse, e.g. [Turn off] [Kitchen lights] [3 devices]. */
  chips(i: Intent | null): string[] {
    if (!i) return [];
    switch (i.kind) {
      case 'power': return [i.on ? 'Turn on' : 'Turn off', i.label, plural(i.devices.length, 'device')];
      case 'level': return [`Set to ${i.bri}%`, i.label, plural(i.devices.length, 'device')];
      case 'overlay': return [i.end ? 'End' : 'Start', i.name];
      case 'why': return ['Why', cap(i.label)];
      case 'tonight': return ['Tonight', 'From your modes'];
      case 'whoHome': return ['Who’s home'];
      case 'whatsOn': return ['What’s on'];
      case 'status': return ['Current mode'];
      case 'learn': return ['Remember', `“${i.name}”`, list(i.roomNames)];
      case 'unknownLabel': return ['Turn', `“${i.word}”`, 'New label'];
    }
  }

  async ask(q: string): Promise<AskReply> {
    const i = this.parse(q);
    const reply = (text: string, source: Source, extra: Partial<AskReply> = {}): AskReply => ({ text, source, actions: [], understood: true, ...extra });
    if (!i) return reply('I didn’t catch that. I can switch rooms and devices, set brightness (“lamp to 30%”), start Movie or Away, tell you why something is on, what’s happening tonight, and who’s home.', 'Built-in · nothing left your home', { understood: false });
    const tz = this.config.get().timezone;
    switch (i.kind) {
      case 'learn':
        return reply(`Got it. “${i.name}” will mean ${list(i.roomNames)}.`, 'Built-in · nothing left your home', { actions: [{ label: 'Remember that', action: { type: 'learnGroup', name: i.name, rooms: i.rooms } }] });
      case 'unknownLabel':
        return reply(`I don’t know which rooms are “${i.word}” yet. Tell me once, for example “${i.word} is lounge, kitchen and laundry”, and I’ll remember.`, 'Built-in · nothing left your home');
      case 'power': {
        if (!i.devices.length) return reply(`There’s nothing I can switch ${i.on ? 'on' : 'off'} there.`, 'Device control');
        const targets: Targets = Object.fromEntries(i.devices.map(id => [id, isPlayer(this.reg.get(id)!) && !i.on ? { on: false, media: null } : { on: i.on }]));
        const r = await this.engine.applyMany(targets, { ...CAUSE, label: `${i.label} ${i.on ? 'on' : 'off'}` });
        return reply(r.changed.length ? `Done. ${i.label}: ${plural(r.changed.length, 'thing')} ${i.on ? 'on' : 'off'}.` : `${i.label} ${i.devices.length === 1 ? 'was' : 'were'} already ${i.on ? 'on' : 'off'}.`, 'Device control', { undo: r.undo });
      }
      case 'level': {
        const r = await this.engine.applyMany(Object.fromEntries(i.devices.map(id => [id, { on: true, bri: i.bri }])), { ...CAUSE, label: `${i.label} to ${i.bri}%` });
        return reply(`${i.label} ${r.changed.length ? 'set to' : 'already at'} ${i.bri}%.`, 'Device control', { undo: r.undo });
      }
      case 'overlay': {
        const o = this.config.get().overlays.find(x => x.id === i.id) as Overlay;
        if (i.end) {
          if (this.engine.overlay?.id !== i.id) return reply(`${o.name} isn’t on.`, 'Device control');
          await this.engine.endOverlay('user');
          return reply(`${o.name} is off. Back to ${this.engine.mode().name}.`, 'Device control');
        }
        const undo = await this.engine.startOverlay(i.id, CAUSE);
        return reply(`${o.name} is on. ${o.endsLabel}.`, 'Device control', { undo });
      }
      case 'why': {
        const d = this.reg.get(i.device)!;
        const w = this.engine.why(d.id);
        const acts = d.state.on && (isLight(d) || isPlayer(d)) ? [{ label: 'Turn it off now', action: { type: 'apply' as const, targets: { [d.id]: { on: false } }, label: `${d.name} off`, done: `${d.name} is off.` } }] : [];
        return reply(`${cap(i.label)} is ${d.state.on ? 'on' : 'off'}. ${w.now} Next: ${w.next}`, 'From the activity log', { actions: acts });
      }
      case 'tonight': {
        const now = this.engine.now();
        const items = this.engine.planner.itemsBetween(now, this.engine.planner.kovaDayAt(now).end).filter(x => !this.engine.skips.has(x.id));
        if (!items.length) return reply('Nothing else is planned until morning.', 'From your modes');
        return reply(items.slice(0, 5).map(x => `${clock(x.at, tz)} ${x.label}: ${x.what}`).join('. ') + '.', 'From your modes', { actions: [{ label: 'Open Modes', action: { type: 'screen', screen: 'modes' } }] });
      }
      case 'whoHome': {
        const ps = this.config.get().people.map(p => ({ p, home: this.engine.people[p.id]?.home !== false }));
        const home = ps.filter(x => x.home).map(x => x.p.name), away = ps.filter(x => !x.home).map(x => x.p.name);
        const text = !ps.length ? 'No one is set up yet.'
          : !away.length ? `${home.length === 2 ? 'Both' : 'Everyone'} home: ${list(home)}.`
          : !home.length ? `Nobody’s home. ${list(away)} ${away.length === 1 ? 'is' : 'are'} out.`
          : `${list(home)} ${home.length === 1 ? 'is' : 'are'} home. ${list(away)} ${away.length === 1 ? 'is' : 'are'} out.`;
        return reply(text, 'From the activity log');
      }
      case 'whatsOn': {
        const on = this.reg.list().filter(d => isLight(d) && d.state.on);
        const names = on.map(d => `${this.roomName(d.room)} ${d.name.toLowerCase()}`);
        return reply(on.length ? `${plural(on.length, 'light')} ${on.length === 1 ? 'is' : 'are'} on: ${list(names)}.` : 'All the lights are off.', 'Built-in · nothing left your home',
          on.length ? { actions: [{ label: 'Turn them all off', action: { type: 'apply', targets: Object.fromEntries(on.map(d => [d.id, { on: false }])), label: 'All lights off', done: 'All lights are off.' } }] } : {});
      }
      case 'status': {
        const now = this.engine.planner.modeAt(this.engine.now());
        return reply(`The home is in ${now.mode.name} until ${clock(now.until, tz)}, then ${now.next.name}.`, 'From your modes');
      }
    }
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
