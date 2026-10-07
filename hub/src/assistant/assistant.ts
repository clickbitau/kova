import type { Engine } from '../engine/engine.ts';
import type { HelixMusic } from '../services/helix-music.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { RoomClimate } from '../engine/room-climate.ts';
import type { Learner } from '../engine/learn.ts';
import type { Cause, Command, Device, Overlay, RoomEventKind, Targets } from '../model/types.ts';
import { allClosedAfter, hasZones, roomReading, sensibleMode, zonesServing, type ZoneCommand } from '../util/zones.ts';
import { isLight, isPlayer } from '../util/describe.ts';
import { clock, localDate, atLocal } from '../util/time.ts';
import { hardwareSummary, hasHardware } from '../util/hardware.ts';
import { isCamera, isDoorbell, isSensor, reading, type ReadingField } from '../util/sensors.ts';
import { allows, canDevice, currentActor, demand, needs, type Perm } from '../services/actor.ts';

/** A time still to come: "at 9pm", "at 21:30", "in 20 minutes", "in an hour", "tomorrow", "tonight at", "later". */
export const LATER = /\b(at \d{1,2}(:\d{2})? ?(am|pm)|at \d{1,2}:\d{2}|at (noon|midnight)|in (\d+|an?|half an?) (min|mins|minutes?|hours?|hrs?)|tomorrow|tonight at|later (today|on|tonight)|on (mon|tues|wednes|thurs|fri|satur|sun)day)\b/;

// Ask Kova, built in: a deterministic intent parser that runs on the hub.
// No AI, nothing leaves the home. Requests are parsed into an Intent first,
// which the UI can show as "Understood" chips before anything runs.

/** Where an answer came from, shown under every reply. */
export type Source = 'Device control' | 'Helix' | 'From the activity log' | 'From your modes' | 'Built-in · nothing left your home'
  /** Optional AI engines (see ai.ts). The cloud tag says what context was sent. */
  | 'Local AI on your server' | `${string} · sent ${string}`
  /** A phrase the AI handled before, now replayed locally. */
  | 'Learned · no AI needed';

export type Intent =
  | { kind: 'greeting' }
  | { kind: 'power'; on: boolean; label: string; devices: string[] }
  | { kind: 'level'; bri: number; label: string; devices: string[] }
  | { kind: 'overlay'; id: string; name: string; end: boolean }
  | { kind: 'why'; device: string; label: string }
  | { kind: 'tonight' }
  | { kind: 'whoHome' }
  | { kind: 'whatsOn' }
  | { kind: 'status' }
  | { kind: 'learn'; name: string; rooms: string[]; roomNames: string[] }
  | { kind: 'unknownLabel'; word: string }
  /** "play The Office in the lounge": a TV that can find titles itself (a Helix box). */
  | { kind: 'play'; title: string; device: string; label: string }
  | { kind: 'pause'; resume: boolean; label: string; devices: string[] }
  /** "play Bangla Collection on shuffle in the kitchen", "a station from Coke Studio in the lounge": Helix music on speakers. */
  | { kind: 'music'; words: string; shuffle: boolean; station: boolean; label: string; devices: string[] }
  /** "next song", "previous song in the kitchen". */
  | { kind: 'skip'; delta: 1 | -1; label: string; devices: string[] }
  /** "what's playing?", "what song is this?" */
  | { kind: 'nowPlaying' }
  /** "anything at the front door?", "was there motion in the garage today?": from cameras and sensors, by room. */
  | { kind: 'roomEvents'; room: string; label: string; kinds: RoomEventKind[] | null; now: boolean }
  /** "what's the temperature in the bedroom?", "how humid is the lounge?" */
  | { kind: 'reading'; room: string; label: string; field: ReadingField }
  /** "is the garage door open?" */
  | { kind: 'contact'; devices: string[]; label: string }
  /** "is the router OK?", "how much power is the router using?": a device whose hardware Kova reads (the router, from Warden). */
  | { kind: 'hardware'; device: string; label: string }
  /**
   * "cool the lounge", "turn off the AC in the office", "open the lounge zone to 50%": the air conditioner zone serving
   * a room (and the unit's power and mode when that's asked). `targets` is empty when no zone serves the place.
   */
  | { kind: 'zone'; label: string; what: string; targets: Targets; offer: { targets: Targets; label: string } | null }
  /** "turn on the AC in here", "turn the aircon off": a room AC, but which room isn't said (the app doesn't know its room yet). */
  | { kind: 'acWhere'; on: boolean; rooms: { room: string; label: string }[] }
  /**
   * "why do you suggest moving Thunderstorm?", "apply the bedroom LED suggestion", "what have you learned?": what Kova
   * learned from what people do (engine/learn.ts). `id` is the suggestion meant, null when none or several match.
   */
  | { kind: 'suggestion'; op: 'why' | 'apply' | 'list'; id: string | null };

/** A follow-up the user can tap, executed by POST /api/ask/act. */
export type AskAction =
  | { type: 'apply'; targets: Targets; label: string; done: string }
  | { type: 'overlay'; id: string; done: string }
  | { type: 'learnGroup'; name: string; rooms: string[] }
  | { type: 'screen'; screen: string }
  /** A room's AC on or off, by the room-AC policy (engine/room-climate.ts). */
  | { type: 'roomAc'; room: string; on: boolean; done: string }
  /** Apply something Kova learned from what people do (a learned suggestion's id). */
  | { type: 'suggestion'; id: string };

export interface AskReply {
  text: string; source: Source; actions: { label: string; action: AskAction }[]; undo?: string; understood: boolean;
  /** Which engine answered: the built-in parser (or a learned phrase), a local AI, or a cloud AI. */
  engine?: 'builtin' | 'local' | 'cloud';
}

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

/**
 * Words that may sit around an overlay's name in a short, direct command ("start movie mode", "we have guests",
 * "guests are here", "the movie is over"). Anything else left over means the message is about more than that.
 */
const OVERLAY_FILLER = new Set(['start', 'begin', 'end', 'stop', 'finish', 'cancel', 'over', 'turn', 'switch', 'put', 'activate', 'enable', 'disable', 'deactivate', 'on', 'off',
  'the', 'a', 'an', 'our', 'my', 'some', 'mode', 'scene', 'time', 'now', 'please', 'kova', 'hey', 'ok', 'okay', 'its', 'it', 'is', 'lets', 'let', 'us', 'go', 'we', 'were', 're', 'are', 'have', 'got', 'i', 'im', 'am',
  'coming', 'here', 'arrived', 'staying', 'over', 'for', 'tonight', 'night', 'just', 'out', 'yes', 'thanks', 'thank', 'you']);

/** "every day", "every prayer", "each morning": a schedule. (Not "every light", "everything": those are direct.) */
const EVERY = /\b(every|each)\s+(?!(lights?|lamps?|speakers?|devices?|one|thing|room|tv|plug|switch(es)?)\b)\w+/;
/** Words that make a message a rule, a condition or an explanation rather than a direct command. */
const CONDITIONAL = /\b(if|when|whenever|unless|until|during|while|whilst|after|before|then|once|as soon as|in case|because|cause|so that|since|otherwise|except|instead|accordingly|should|must|make sure|so it|so they|so we|so i|rather than|depending)\b/;
/** Two commands joined ("turn off the lamp and play jazz"). */
const TWO_COMMANDS = /\b(and|then|also|plus)\s+(also\s+)?(turn|switch|put|set|dim|brighten|play|pause|resume|start|stop|end|open|close|lock|unlock|make|cool|heat|watch|shuffle)\b/;
/** Longer than this (in words), a message is for the AI: the built-in parser only takes short, direct commands. */
export const DIRECT_MAX_WORDS = 12;

/**
 * Why a message isn't a short, direct command, or null when it is. Long messages, several sentences or clauses,
 * conditions ("if", "when", "every", "during", "in case") and explanations ("because", "so that", "should") go to the
 * AI: the built-in parser would grab one word from them ("guests" from a long instruction) and do the wrong thing.
 * A question that starts with its question word ("when is sunset?") isn't a condition.
 */
export function notDirect(q: string): string | null {
  const t = norm(q);
  const words = t ? t.split(' ') : [];
  if (words.length > DIRECT_MAX_WORDS) return 'long';
  // Several sentences, or clauses after a semicolon or a dash, or a list of three or more parts.
  if (/[.!?;]\s+\S/.test(q.trim().replace(/[.!?]+$/, '')) || /\s[–—-]\s/.test(q) || (q.match(/,/g) ?? []).length >= 2) return 'clauses';
  const body = t.replace(/^(when|whens|what|whats|is|are|how|who|which|why|anything)\b.*$/, m => m.replace(/^\w+/, ''));
  if (CONDITIONAL.test(body) || EVERY.test(body)) return 'condition';
  if (TWO_COMMANDS.test(t)) return 'two commands';
  return null;
}

export class Assistant {
  /** Helix music on speakers ("play Bangla Collection on shuffle in the kitchen"), once Helix is set up. */
  music: HelixMusic | null = null;
  /** Room ACs (set by the hub): "turn on the AC in the theatre" goes through its policy. */
  roomClimate: RoomClimate | null = null;

  /** What Kova learned from what people do (set by the hub): "why do you suggest that?", "apply it". */
  learner: Learner | null = null;

  constructor(private engine: Engine, private reg: Registry, private config: ConfigStore) {}

  /** The learned suggestion a question is about: the one sharing the most words with it, or the only one. */
  private suggestionFor(t: string): string | null {
    const all = this.learner?.suggestions() ?? [];
    const STOP = new Set(['why', 'do', 'does', 'you', 'kova', 'suggest', 'suggesting', 'suggestion', 'suggestions', 'the', 'a', 'an', 'this', 'that', 'it', 'to', 'of', 'about', 'for', 'is', 'are', 'apply', 'accept', 'use', 'go', 'ahead', 'with', 'and', 'what', 'whats', 'explain', 'please', 'one', 'your', 'my', 'at', 'on', 'in']);
    const words = t.split(' ').filter(w => w.length > 1 && !STOP.has(w));
    const autos = this.config.get().automations ?? [];
    const scored = all.map(s => {
      const hay = norm(`${s.finding.title} ${s.finding.body} ${autos.find(a => a.id === s.automationId)?.name ?? ''} ${this.reg.get(s.device)?.name ?? ''}`);
      return { s, n: words.filter(w => hay.split(' ').includes(w)).length };
    }).sort((a, b) => b.n - a.n);
    if (scored[0]?.n && (scored.length === 1 || scored[0].n > scored[1].n)) return scored[0].s.id;
    return !words.length && all.length === 1 ? all[0].id : null;
  }

  private rooms() { return this.config.get().rooms; }

  /**
   * The devices answers are about: not archived, not hidden — and so never the parts of a combined device, which
   * stands for them (its parts are hidden while combined). A hidden device is still reached by its exact name.
   */
  private devs(): Device[] { const a = currentActor(); return this.reg.list().filter(d => !d.archived && !d.hidden && canDevice(a, d)); }
  private hiddenNamed(p: string): Device[] { const a = currentActor(); return this.reg.list().filter(d => !d.archived && d.hidden && norm(d.name) === p && canDevice(a, d)); }
  private roomName(id: string) { return this.rooms().find(r => r.id === id)?.name ?? id; }

  /** Devices a phrase refers to: a learned label, a room (optionally + device), a device, or everything. */
  private resolve(phrase: string): { devices: Device[]; label: string } | { unknown: string } | null {
    const raw = norm(phrase).replace(/^(the|all the|all|my|every)\s+/, '').trim();
    const wantsSpeakers = /\b(speakers?|music|audio)\b/.test(raw);
    const p = raw.replace(/\s+(lights?|speakers?|music|audio)$/, '').trim();
    const kind = (ds: Device[]) => ds.filter(d => wantsSpeakers ? isPlayer(d) : isLight(d));
    const noun = wantsSpeakers ? 'speakers' : 'lights';
    const c = this.config.get();
    if (!p || ['everything', 'house', 'home', 'lights', 'light', 'all'].includes(p)) return { devices: kind(this.devs()), label: `All ${noun}` };
    const group = Object.entries(c.groups).find(([g]) => norm(g) === p);
    if (group) return { devices: kind(this.devs().filter(d => group[1].includes(d.room))), label: cap(group[0]) };
    const room = [...this.rooms()].sort((a, b) => b.name.length - a.name.length)
      .find(r => norm(r.name) === p || norm(r.id) === p || p.startsWith(`${norm(r.name)} `) || (p.length > 2 && norm(r.name).startsWith(p)));
    if (room) {
      const rest = p.startsWith(`${norm(room.name)} `) ? p.slice(norm(room.name).length).trim() : '';
      const inRoom = this.devs().filter(d => d.room === room.id);
      const named = rest ? inRoom.filter(d => norm(d.name).includes(rest)) : [];
      if (named.length) return { devices: named, label: `${room.name} ${named.length === 1 ? named[0].name.toLowerCase() : rest}` };
      return { devices: kind(inRoom), label: `${room.name} ${noun}` };
    }
    const dev = this.devs().filter(d => {
      const full = norm(`${this.roomName(d.room)} ${d.name}`);
      return norm(d.name) === p || full === p || full.includes(p) || (p.length > 3 && norm(d.name).includes(p));
    });
    if (dev.length) return { devices: dev, label: dev.length === 1 ? dev[0].name : cap(phrase.trim()) };
    const hid = this.hiddenNamed(p);
    if (hid.length) return { devices: hid, label: hid.length === 1 ? hid[0].name : cap(phrase.trim()) };
    if (/^[a-z]+$/.test(p) && p.length > 2) return { unknown: p };
    return null;
  }

  /** Speakers that can play a queue (Helix music). A Kova speaker group stands for its speakers, so they aren't asked twice. */
  private speakers(): Device[] {
    const all = this.devs().filter(d => d.capabilities.includes('queue') && !d.hidden);
    const real = all.filter(d => d.adapter !== 'groups');
    return real.length ? real : all;
  }

  private speakerLabel(d: Device): string {
    const rn = this.roomName(d.room);
    return norm(d.name).includes(norm(rn)) ? d.name : `${rn} ${d.name}`.trim();
  }

  /** A room, a learned group of rooms, or a device by name: "lounge", "downstairs", "bedroom tv". */
  private place(phrase: string): { label: string; has: (d: Device) => boolean } | null {
    const p = norm(phrase).replace(/^(the|my)\s+/, '').replace(/\s+(tv|telly|box)$/, '').trim();
    if (!p) return null;
    const room = [...this.rooms()].sort((a, b) => b.name.length - a.name.length).find(r => norm(r.name) === p || norm(r.id) === p);
    if (room) return { label: room.name, has: d => d.room === room.id };
    const group = Object.entries(this.config.get().groups).find(([g]) => norm(g) === p);
    if (group) return { label: cap(group[0]), has: d => group[1].includes(d.room) };
    const ids = new Set(this.devs().filter(d => norm(d.name) === p || norm(`${this.roomName(d.room)} ${d.name}`).includes(p)).map(d => d.id));
    return ids.size ? { label: cap(phrase.trim()), has: d => ids.has(d.id) } : null;
  }

  /**
   * A room from words: its name or id, part of its name ("front" for "Front door"), a room named in them
   * ("the backyard" for "Backyard"), or "the door": the room with the doorbell.
   */
  private roomFrom(phrase: string): { id: string; name: string } | null {
    const p = norm(phrase).replace(/^(the|my|our)\s+/, '').replace(/\s+(camera|cam|area|room)$/, '').trim();
    if (!p) return null;
    const rooms = [...this.rooms()].sort((a, b) => b.name.length - a.name.length);
    const squash = (x: string) => x.replace(/\s+/g, '');
    const hit = rooms.find(r => norm(r.name) === p || norm(r.id) === p || squash(norm(r.name)) === squash(p))
      ?? rooms.find(r => p.includes(norm(r.name)) || norm(r.name).includes(p) || squash(norm(r.name)).includes(squash(p)) || squash(p).includes(squash(norm(r.name))));
    if (hit) return hit;
    // "the door": wherever the doorbell is.
    if (/\bdoor\b/.test(p)) {
      const bell = this.devs().find(d => isCamera(d) && isDoorbell(d));
      const r = bell && this.rooms().find(x => x.id === bell.room);
      if (r) return r;
    }
    // A camera's name ("the driveway camera").
    const cam = this.devs().find(d => (isCamera(d) || isSensor(d)) && norm(d.name).includes(p));
    const r = cam && this.rooms().find(x => x.id === cam.room);
    return r ?? null;
  }

  /**
   * The air conditioner zones a place means: the zones serving a room ("the lounge"), or a zone by its own name ("the
   * living zone") — on whichever unit has them.
   */
  private zonePlace(phrase: string): { label: string; zones: { d: Device; n: number }[]; room: string | null } | null {
    const p = norm(phrase).replace(/^(the|my|our)\s+/, '').replace(/\s+(zones?|area)$/, '').trim();
    if (!p) return null;
    const settings = this.config.get().devices ?? {};
    const zoned = this.reg.list().filter(d => hasZones(d) && !d.archived);
    const squash = (x: string) => x.replace(/\s+/g, '');
    // A zone by its own name ("Living", "Office & Guest").
    for (const d of zoned) {
      for (const [n, name] of Object.entries(settings[d.id]?.zoneNames ?? {})) {
        if (squash(norm(name)) !== squash(p)) continue;
        return { label: name, zones: [{ d, n: Number(n) }], room: settings[d.id]?.zoneRooms?.[n]?.[0] ?? null };
      }
    }
    const room = this.roomFrom(p);
    if (!room) return null;
    return { label: room.name, zones: zonesServing(room.id, zoned, settings), room: room.id };
  }

  /**
   * "turn on the AC in here", "turn on the aircon": a room AC with no room. The app doesn't know which room it's in
   * yet, so Kova asks, offering the rooms that have one.
   */
  private acWhere(t: string): Intent | null {
    const AC = '(?:ac|a c|aircon|air con|air conditioning|air conditioner|airconditioner)';
    const m = t.match(new RegExp(`^(?:please )?(?:turn|switch|put) (on|off) (?:the )?${AC}(?: (?:in )?here| in this room)?$`))
      ?? t.match(new RegExp(`^(?:please )?(?:turn|switch) (?:the )?${AC}(?: (?:in )?here| in this room)? (on|off)$`));
    if (!m || !this.roomClimate) return null;
    const rooms = this.roomClimate.rooms().map(r => ({ room: r.room, label: r.name }));
    if (!rooms.length) return null;
    return { kind: 'acWhere', on: m[1] === 'on', rooms };
  }

  /** "cool the lounge", "turn on the AC in the office", "close the kitchen zone", "lounge zone to 40%". */
  private zoneIntent(t: string): Intent | null {
    const AC = '(?:ac|a c|aircon|air con|air conditioning|air conditioner|airconditioner|climate)';
    const power = (dir: string): ZoneCommand => dir === 'on' ? { on: true, ac: true } : { on: false };
    const pct = (v?: string) => v ? Math.min(100, Number(v)) : undefined;
    // [pattern, (match) → place, command, what it does in words, and whether the words alone say it's the AC]
    const forms: [RegExp, (m: RegExpMatchArray) => [string, ZoneCommand, string, boolean]][] = [
      [/^(cool|heat|warm)(?: (?:down|up))? (?:the |my )?(.+?)(?: (?:to|at) (\d{2})(?: ?degrees| ?c)?)?$/, m => {
        const hvac = m[1] === 'cool' ? 'cool' : 'heat';
        return [m[2]!, { on: true, hvac, ...(m[3] ? { target: Number(m[3]) } : {}) }, `${hvac === 'cool' ? 'Cool' : 'Heat'}${m[3] ? ` to ${m[3]}°` : ''}`, false];
      }],
      [new RegExp(`^(?:turn|switch|put) (on|off) (?:the )?${AC} (?:in|for|of) (?:the )?(.+)$`), m => [m[2]!, power(m[1]!), m[1] === 'on' ? 'Turn on' : 'Turn off', true]],
      [new RegExp(`^(?:turn|switch) (?:the )?${AC} (?:in|for|of) (?:the )?(.+?) (on|off)$`), m => [m[1]!, power(m[2]!), m[2] === 'on' ? 'Turn on' : 'Turn off', true]],
      [new RegExp(`^(?:turn|switch|put) (on|off) (?:the )?(.+?) (?:${AC}|zone)$`), m => [m[2]!, power(m[1]!), m[1] === 'on' ? 'Turn on' : 'Turn off', true]],
      [new RegExp(`^(?:turn|switch) (?:the )?(.+?) (?:${AC}|zone) (on|off)$`), m => [m[1]!, power(m[2]!), m[2] === 'on' ? 'Turn on' : 'Turn off', true]],
      // Only with the word "zone": "open the garage door" is a door.
      [/^(open|close|shut)(?: up)? (?:the )?(?:zones? (?:in|for) (?:the )?(.+?)|(.+?) zones?)(?: (?:to|at) (\d{1,3}) ?%?)?$/, m => {
        const n = pct(m[4]), place = (m[2] ?? m[3])!;
        return m[1] === 'open' && n !== 0 ? [place, { on: true, ...(n != null ? { open: n } : {}) }, `Open${n != null ? ` ${n}%` : ''}`, true] : [place, { on: false }, 'Close', true];
      }],
      [/^(?:set )?(?:the )?(.+?) zones? (?:to |at )?(\d{1,3}) ?%?$/, m => { const n = pct(m[2])!; return [m[1]!, n === 0 ? { on: false } : { on: true, open: n }, n === 0 ? 'Close' : `Open ${n}%`, true]; }],
    ];
    let hit: [string, ZoneCommand, string, boolean] | null = null;
    for (const [re, f] of forms) { const m = t.match(re); if (m) { hit = f(m); break; } }
    if (!hit) return null;
    let [place, cmd, what] = hit;
    const sure = hit[3];
    const zp = this.zonePlace(place);
    // "cool the lounge" or "open the kitchen" only mean the AC when a zone is there; "turn on the lounge AC" always does.
    if (!zp || (!sure && !zp.zones.length)) return null;
    const settings = this.config.get().devices ?? {};
    const units = [...new Set(zp.zones.map(z => z.d))];
    const off = units.filter(d => !d.state.on);
    const temp = zp.room ? roomReading(zp.room, 'temp', this.reg.list(), settings).value : null;
    // "Turn on the AC in the office" with the unit off: on in a sensible mode for that room.
    if (cmd.ac && off.length) { const s = sensibleMode(off[0].state, temp); cmd = { ...cmd, hvac: s.hvac, target: s.target }; }
    const targets: Targets = {};
    const confirmed = !!zp.room && zp.zones.every(z => settings[z.d.id]?.zoneRooms?.[String(z.n)]?.includes(zp.room!));
    // "Turn on the AC in the theatre": the room AC's policy chooses the mode (or keeps the unit's, when it's running).
    if (zp.zones.length && confirmed && cmd.ac && cmd.on && !hit[1].hvac && this.roomClimate) Object.assign(targets, this.roomClimate.planOn(zp.room!).targets);
    else if (zp.zones.length && confirmed) targets[`zone:${zp.room}`] = cmd as unknown as Command;
    else for (const z of zp.zones) {
      // A zone named in the words but not yet tied to a room: the unit itself.
      const c = (targets[z.d.id] ??= {}) as Command;
      c.zoneSet = { ...(c.zoneSet ?? {}), [String(z.n)]: { ...(cmd.on !== undefined ? { on: cmd.on } : {}), ...(cmd.open != null ? { open: cmd.open } : {}) } };
      if (cmd.ac || cmd.hvac) c.on = true;
      if (cmd.hvac) c.hvac = cmd.hvac;
      if (cmd.target != null) c.target = cmd.target;
      if (cmd.on === false && z.d.state.on && allClosedAfter(z.d, c.zoneSet)) c.on = false;
    }
    // Opening a zone while the unit is off: offer to turn it on, never do it unasked.
    let offer: { targets: Targets; label: string } | null = null;
    if (cmd.on && !cmd.ac && !cmd.hvac && off.length) {
      const s = sensibleMode(off[0].state, temp);
      offer = { label: `Turn the AC on · ${cap(s.hvac)} ${s.target}°`, targets: Object.fromEntries(off.map(d => [d.id, { on: true, hvac: s.hvac, target: s.target }])) };
    }
    return { kind: 'zone', label: zp.label, what, targets, offer };
  }

  /** Understand a request without doing anything. */
  parse(q: string): Intent | null {
    // "My room" is the room of the person asking (their account's own room).
    const mine = currentActor()?.room;
    if (mine) q = q.replace(/\b(my|our) (bed)?room\b/gi, this.roomName(mine));
    const t = norm(q);
    const raw = q.toLowerCase().trim().replace(/[.!?]+$/, '');
    const c = this.config.get();

    // "downstairs is lounge, kitchen and laundry": every part has to be a room, or it's not a definition.
    const learn = raw.match(/^([a-z]+) (?:is|means|are) (.+)$/);
    if (learn && !/^(it|this|that|there|what|who|which|where|when|why|how|everything|everyone|nothing|guests?|visitors?)$/.test(learn[1]) && learn[2].split(' ').length <= 12) {
      const parts = learn[2].split(/\s*(?:,|\band\b|&)\s*/).map(x => norm(x).replace(/^the\s+/, '')).filter(Boolean);
      const rooms = parts.map(s => this.rooms().find(r => norm(r.name) === s || (s.length > 2 && norm(r.name).startsWith(s))));
      if (parts.length && rooms.every(r => !!r)) {
        const rs = rooms as NonNullable<typeof rooms[number]>[];
        return { kind: 'learn', name: learn[1], rooms: rs.map(r => r.id), roomNames: rs.map(r => r.name) };
      }
    }
    // What Kova learned: "why do you suggest moving Thunderstorm?", "apply that suggestion", "what have you learned?"
    const asking = /^(why|how come|explain|what|whats|tell me|show|list|any|apply|accept|use|go ahead|yes|ok|okay)\b/.test(t);
    if (this.learner && /\b(suggest|suggests|suggesting|suggestions?|learned|learnt|noticed)\b/.test(t) && (asking || !/\b(turn|switch|set|play|dim)\b/.test(t))) {
      const op = /^(apply|accept|use|go ahead|yes|ok|okay)\b/.test(t) ? 'apply' as const
        : /^(what|whats|any|show|list)\b/.test(t) && !/\bwhy\b/.test(t) && /\b(learned|learnt|noticed|suggestions)\b/.test(t) ? 'list' as const : 'why' as const;
      return { kind: 'suggestion', op, id: op === 'list' ? null : this.suggestionFor(t) };
    }
    // A change for later ("lights off at 9pm", "in 20 minutes", "tomorrow morning") is a one-time schedule, not
    // something to do now: left to the AI, which makes one. Questions about the plan ("what's on tonight") stay here.
    if (LATER.test(raw) && !/^(what|whats|what's|when|is|are|anything)\b/.test(raw)) return null;
    // A message that is only a greeting — "hey turn the lights on" still parses as a command.
    if (/^(hi+|hello+|hey+|yo|hiya|howdy|morning|good (morning|afternoon|evening))( there)?( kova)?$/.test(t)) return { kind: 'greeting' };
    // Only short, direct commands and questions from here: anything longer, conditional or explained is the AI's.
    if (notDirect(q)) return null;
    // "is the garage door open?", "is the front door closed"
    const ct = t.match(/^(?:is|are) (?:the |my )?(.+?) (open|closed|shut)$/);
    if (ct) {
      const p = norm(ct[1]);
      const ds = this.devs().filter(d => isSensor(d) && typeof d.state.open === 'boolean' && (norm(d.name).includes(p) || p.includes(norm(d.name)) || norm(`${this.roomName(d.room)} ${d.name}`).includes(p) || norm(this.roomName(d.room)) === p));
      if (ds.length) return { kind: 'contact', devices: ds.map(d => d.id), label: ds.length === 1 ? ds[0].name : cap(ct[1]) };
    }
    // "what's the temperature in the bedroom", "how warm is the baby room", "how humid is it in the lounge"
    const rd = t.match(/^(?:whats|what is|hows|how is|how)\s+(?:the\s+)?(temperature|temp|humidity|humid|warm|hot|cold|cool|bright|light level)\b(?:\s+is\s+it)?(?:\s+(?:in|at|of))?\s+(?:the\s+)?(.+)$/)
      ?? t.match(/^(?:is it|its)\s+(warm|hot|cold|humid)\s+(?:in|at)\s+(?:the\s+)?(.+)$/);
    if (rd) {
      const room = this.roomFrom(rd[2].replace(/^(?:it\s+)?(?:in|at)\s+(?:the\s+)?/, '').replace(/^is\s+(?:it\s+)?(?:in\s+)?(?:the\s+)?/, ''));
      const field: ReadingField = /humid/.test(rd[1]) ? 'humidity' : /bright|light/.test(rd[1]) ? 'lux' : 'temp';
      if (room) return { kind: 'reading', room: room.id, label: room.name, field };
    }
    // "anything at the front door?", "was there motion in the backyard?", "has anyone been in the garage today"
    const re = t.match(/^(?:(?:is|was|were|has|have|did)\s+)?(?:there\s+)?(?:been\s+)?(?:any\s*(?:one|body|thing)?|some\s*(?:one|body)|anybody|anyone|anything|any|someone|somebody|who|what|what happened|whats happened|whats been happening|whats happening|motion|movement|activity|people|a person|a car|a package|a delivery)\b(.*)$/);
    if (re && /\b(at|in|on|by|outside|near)\b/.test(re[1]) && !/\b(on|playing)$/.test(t)) {
      const rest = re[1];
      const where = rest.match(/\b(?:at|in|on|by|outside|near)\s+(?:the\s+)?(.+?)(?:\s+(today|tonight|now|right now|lately|recently|just now|this morning|this evening))?$/);
      const room = where ? this.roomFrom(where[1]) : null;
      if (room) {
        const k = `${rest} ${t}`;
        const kinds: RoomEventKind[] | null = /\b(motion|movement|moving)\b/.test(k) ? ['motion', 'person'] : /\b(package|parcel|delivery)\b/.test(k) ? ['package'] : /\b(car|vehicle)\b/.test(k) ? ['vehicle']
          : /\b(animal|dog|cat)\b/.test(k) ? ['animal'] : /\b(door|window) (open|opened)\b|\bopened\b/.test(k) ? ['opened', 'closed'] : /\b(one|body|person|people|visitor|someone|anyone)\b/.test(k) ? ['person', 'ring', 'motion'] : null;
        return { kind: 'roomEvents', room: room.id, label: room.name, kinds, now: /^is\b|\b(now|right now|just now)\b/.test(t) };
      }
    }
    if (/^who(s| is)?\b.*\b(home|in|here|out)\b/.test(t)) return { kind: 'whoHome' };
    // "is the router ok", "how much power is the router using", "router power supplies", "how hot is the router"
    const hw = this.devs().filter(hasHardware).find(d => new RegExp(`\\b(${[norm(d.name), d.adapter === 'warden' ? 'router|warden' : ''].filter(Boolean).join('|')})\\b`).test(t));
    if (hw && /\b(ok|okay|alright|fine|healthy|good|working|power|watts?|using|draw(ing|s)?|use|supply|supplies|psus?|redundan\w*|temp\w*|hot|warm|fans?|status|how is|hows)\b/.test(t) && !/^(turn|switch|restart|reboot)\b/.test(t)) {
      return { kind: 'hardware', device: hw.id, label: hw.name };
    }
    const aw = this.acWhere(t);
    if (aw) return aw;
    const zi = this.zoneIntent(t);
    if (zi) return zi;
    if (/^why\b/.test(t)) {
      const m = t.match(/^why (?:is|are|did) (?:the )?(.+?)(?: (?:on|off|playing|turn on|come on))?$/);
      const r = m ? this.resolve(m[1]) : null;
      if (r && 'devices' in r && r.devices.length) {
        const d = r.devices.find(isLight) ?? r.devices[0];
        return { kind: 'why', device: d.id, label: `${this.roomName(d.room)} ${d.name.toLowerCase()}` };
      }
    }
    // "What's happening tonight?", but not "turn the porch light on tonight" or a long request that only mentions it.
    if (/\b(tonight|coming up|whats happening|what happens|schedule|whats next)\b/.test(t)
      && (/^(what|whats|when|is|are|anything|show|tell me|list)\b/.test(t) || /\?\s*$/.test(q) || t.split(' ').length <= 3)) return { kind: 'tonight' };

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
    // "pause", "pause the lounge tv", "carry on", "resume"
    const pz = t.match(/^(pause|resume|unpause|carry on|continue|keep playing)(?: (?:the )?(.+))?$/);
    if (pz) {
      const resume = pz[1] !== 'pause';
      const at = pz[2] ? this.place(pz[2]) : null;
      const players = this.devs().filter(d => d.capabilities.includes('pause') && (!at || at.has(d)));
      if (players.length && (!pz[2] || at)) return { kind: 'pause', resume, label: at?.label ?? 'What’s playing', devices: players.filter(d => d.state.on && !!d.state.paused === resume).map(d => d.id) };
    }
    // "what's playing", "what song is this"
    if (/^what(?:'s| is)? (?:playing|this song|song is this|song is playing)|^what song\b|^which song\b/.test(raw.replace(/’/g, "'"))) return { kind: 'nowPlaying' };
    // "next song", "skip", "previous song in the kitchen", "go back a song"
    const sk = raw.match(/^(?:play the )?(next|skip|previous|last|go back)(?: (?:a |one )?(?:song|track|this song|this one|this))?(?: (?:on|in) (?:the )?(.+))?$/);
    if (sk) {
      const at = sk[2] ? this.place(sk[2]) : null;
      if (!sk[2] || at) {
        const playing = this.speakers().filter(d => d.state.on && d.state.track && (!at || at.has(d)));
        return { kind: 'skip', delta: /next|skip/.test(sk[1]) ? 1 : -1, label: at?.label ?? (playing.length === 1 ? this.speakerLabel(playing[0]) : 'What’s playing'), devices: playing.map(d => d.id) };
      }
    }
    // "play the office in the lounge", "watch dune on the bedroom tv", "put on bluey"
    // "play Bangla Collection on shuffle in the kitchen", "shuffle my loved songs", "play a station from Coke Studio in the lounge"
    const pl = raw.match(/^(play|watch|put on|shuffle)\s+(.+)$/);
    if (pl) {
      let words = pl[2].trim();
      const shuffle = pl[1] === 'shuffle' || /\b(?:on |in )?(?:shuffle|shuffled|random)\b/.test(words);
      words = words.replace(/\s*\b(?:on |in |with )?(?:shuffle|shuffled|random(?: order)?)\b\s*/g, ' ').replace(/\s+/g, ' ').trim();
      const split = words.match(/^(.+) (?:on|in) (?:the )?(.+)$/);
      const at = split ? this.place(split[2]) : null;
      let title = (at ? split![1] : words).trim();
      const tvs = this.devs().filter(d => d.capabilities.includes('library'));
      const picked = at ? tvs.filter(d => at.has(d)) : tvs.length === 1 ? tvs : tvs.filter(d => d.state.on);
      const musical = shuffle || pl[1] === 'shuffle' || /\b(songs?|music|playlist|station|radio|album|loved|favou?rites?|tracks?)\b/.test(norm(title)) || / by /.test(title);
      if (pl[1] !== 'shuffle' && !musical && picked.length === 1 && title && !/^(a |the )?(movie|film|something)$/.test(norm(title))) {
        const rn = this.roomName(picked[0].room), dn = picked[0].name;
        return { kind: 'play', title, device: picked[0].id, label: norm(dn).includes(norm(rn)) ? dn : `${rn} ${dn}`.trim() };
      }
      if (pl[1] !== 'watch' && (!split || at)) {
        const st = title.match(/^(?:a |the )?(?:station|radio|mix) (?:from|of|for|like|based on) (.+)$/) ?? title.match(/^(.+?) (?:station|radio|mix)$/);
        if (st) title = st[1].trim();
        const speakers = this.speakers().filter(d => at ? at.has(d) : d.state.on && d.state.track);
        const all = this.speakers();
        const devices = speakers.length ? speakers : !at && all.length === 1 ? all : [];
        if (title) return { kind: 'music', words: title, shuffle: shuffle || !!st, station: !!st, label: at?.label ?? (devices.length === 1 ? this.speakerLabel(devices[0]) : 'the speakers'), devices: devices.map(d => d.id) };
      }
    }
    // An overlay only from a message about nothing else: its name or phrase, and the words around such a command.
    const onlyAbout = (re: RegExp) => { const rest = t.replace(re, ' ').split(' ').filter(w => w && !OVERLAY_FILLER.has(w)); return rest.length === 0; };
    if (ARRIVED.test(t) && this.engine.overlay?.id === 'away' && onlyAbout(new RegExp(ARRIVED.source, 'g'))) return { kind: 'overlay', id: 'away', name: 'Away', end: true };
    const byName = (o: Overlay) => new RegExp(`\\b${norm(o.name)}\\b`, 'g');
    const byPhrase = (o: Overlay) => OVERLAY_PHRASES[o.id] ? new RegExp(OVERLAY_PHRASES[o.id]!.source, 'g') : null;
    const ov = c.overlays.find(o => byName(o).test(t) && onlyAbout(byName(o)))
      ?? c.overlays.find(o => { const re = byPhrase(o); return !!re && re.test(t) && onlyAbout(new RegExp(re.source, 'g')); });
    if (ov) return { kind: 'overlay', id: ov.id, name: ov.name, end: /\b(end|stop|finish|cancel|off|disable|deactivate)\b|\b(is|its|s) over\b/.test(t) };
    // "what's on", "which lights are on", "what lights are on in the kitchen" — only a generic
    // listing question, not "what mode is the helix box on" (that's about a specific device).
    if (/^whats? (is )?(on|running)|^what is (on|running)|anything (is )?(on|running)|which lights|what.*\b(lights?|devices?|speakers?)\b.*\b(on|running)\b/.test(t)) return { kind: 'whatsOn' };
    if (/\b(mode|status|whats going on)\b/.test(t)) {
      // "what's the status" / "what's going on" → home status. But "what mode is the
      // helix box on" names something specific — fall through so the AI can answer it.
      const extra = t.replace(/\b(whats|what|is|are|the|a|an|of|mode|status|going|on|in|now|current|right|home|house|kova|does|do|it|we)\b/g, ' ').trim();
      if (!extra) return { kind: 'status' };
    }
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
      case 'play': return ['Play', `“${i.title}”`, i.label];
      case 'pause': return [i.resume ? 'Carry on' : 'Pause', i.label];
      case 'music': return ['Play', `“${i.words}”${i.station ? ' station' : ''}${i.shuffle && !i.station ? ' on shuffle' : ''}`, i.devices.length ? i.label : 'Which speaker?'];
      case 'skip': return [i.delta > 0 ? 'Next song' : 'Previous song', i.label];
      case 'nowPlaying': return ['Now playing'];
      case 'roomEvents': return ['Cameras and sensors', i.label];
      case 'reading': return [i.field === 'humidity' ? 'Humidity' : i.field === 'lux' ? 'Light' : 'Temperature', i.label];
      case 'contact': return ['Open or closed', i.label];
      case 'greeting': return ['Greeting'];
      case 'hardware': return ['Hardware', i.label];
      case 'zone': return [i.what, `${i.label} zone`];
      case 'acWhere': return [i.on ? 'Turn on' : 'Turn off', 'The AC', 'Which room?'];
      case 'suggestion': return [i.op === 'apply' ? 'Apply' : i.op === 'list' ? 'What Kova learned' : 'Why', i.op === 'list' ? 'From what you do' : 'A suggestion'];
    }
  }

  async ask(q: string): Promise<AskReply> {
    const i = this.parse(q);
    const reply = (text: string, source: Source, extra: Partial<AskReply> = {}): AskReply => ({ text, source, actions: [], understood: true, ...extra });
    if (!i && notDirect(q)) return reply('That’s more than the built-in assistant takes on: it does short, direct commands. For a rule like that, make an automation (Automations → New), or turn on an AI engine in Ask Kova settings and ask again.', 'Built-in · nothing left your home', { understood: false });
    if (!i && LATER.test(q.toLowerCase())) return reply('That’s for later, so it needs a one-time schedule: make one in Automations → Schedule once, or turn on an AI engine in Ask Kova settings and ask again.', 'Built-in · nothing left your home', { understood: false });
    if (!i) return reply('I didn’t catch that. I can switch rooms and devices, set brightness (“lamp to 30%”), start Movie or Away, tell you why something is on, what’s happening tonight, and who’s home.', 'Built-in · nothing left your home', { understood: false });
    // What the asker's role allows (services/actor.ts): a child doesn't see the cameras or change modes here either.
    const need = ({ learn: 'home', overlay: 'modes', whoHome: 'people', roomEvents: 'cameras', contact: 'history', hardware: 'owner' } as Partial<Record<Intent['kind'], Perm>>)[i.kind];
    if (need && !allows(currentActor(), need)) return reply(needs(need), 'Built-in · nothing left your home');
    const tz = this.config.get().timezone;
    switch (i.kind) {
      case 'greeting': {
        const on = this.devs().filter(d => isLight(d) && d.state.on).length;
        return reply(`Hi. ${plural(on, 'light')} ${on === 1 ? 'is' : 'are'} on and the home is in ${this.engine.mode().name}. What do you need?`, 'Built-in · nothing left your home');
      }
      case 'suggestion': {
        const src: Source = 'Built-in · nothing left your home';
        const all = this.learner?.suggestions() ?? [];
        if (!all.length) return reply(this.learner?.on === false ? 'Learning from what you do is off. Turn it on in Settings and Kova will suggest changes when it notices a habit.' : 'Nothing to suggest yet. When Kova notices you doing the same thing by hand on most days, it suggests a change and shows the days it saw.', src);
        const s = i.id ? this.learner!.find(i.id) : undefined;
        if (!s) {
          const which = all.slice(0, 4).map(x => x.finding.title.replace(/\?$/, '')).join('; ');
          return reply(i.op === 'list' ? `Kova noticed ${plural(all.length, 'thing')}: ${which}. Ask “why do you suggest …?” about one.` : `Which one? ${which}.`, src,
            { actions: [{ label: 'Open the suggestions', action: { type: 'screen', screen: 'modes' } }] });
        }
        if (i.op === 'apply') {
          const undo = this.engine.registerUndo(this.learner!.apply(s.id));
          return reply(`${s.finding.done ?? 'Done'}.`, src, { undo });
        }
        return reply(this.learner!.explain(s.id) ?? s.finding.body, src, { actions: [{ label: s.finding.fix, action: { type: 'suggestion', id: s.id } }] });
      }
      case 'learn':
        return reply(`Got it. “${i.name}” will mean ${list(i.roomNames)}.`, 'Built-in · nothing left your home', { actions: [{ label: 'Remember that', action: { type: 'learnGroup', name: i.name, rooms: i.rooms } }] });
      case 'unknownLabel':
        return reply(`I don’t know which rooms are “${i.word}” yet. Tell me once, for example “${i.word} is lounge, kitchen and laundry”, and I’ll remember.`, 'Built-in · nothing left your home');
      case 'power': {
        if (!i.devices.length) return reply(`There’s nothing I can switch ${i.on ? 'on' : 'off'} there.`, 'Device control');
        const targets: Targets = Object.fromEntries(i.devices.map(id => [id, isPlayer(this.reg.get(id)!) && !i.on ? { on: false, media: null } : { on: i.on }]));
        const r = await this.engine.applyMany(targets, { ...CAUSE, label: `${i.label} ${i.on ? 'on' : 'off'}` });
        return reply(r.changed.length ? `Done. ${i.label}: ${plural(r.changed.length, 'thing')} ${i.on ? 'on' : 'off'}.` : `${i.label} ${i.devices.length === 1 ? 'was' : 'were'} already ${i.on ? 'on' : 'off'}.`, 'Device control', { undo: r.changed.length ? r.undo : undefined });
      }
      case 'level': {
        const r = await this.engine.applyMany(Object.fromEntries(i.devices.map(id => [id, { on: true, bri: i.bri }])), { ...CAUSE, label: `${i.label} to ${i.bri}%` });
        return reply(`${i.label} ${r.changed.length ? 'set to' : 'already at'} ${i.bri}%.`, 'Device control', { undo: r.changed.length ? r.undo : undefined });
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
        const on = this.devs().filter(d => isLight(d) && d.state.on);
        const names = on.map(d => `${this.roomName(d.room)} ${d.name.toLowerCase()}`);
        return reply(on.length ? `${plural(on.length, 'light')} ${on.length === 1 ? 'is' : 'are'} on: ${list(names)}.` : 'All the lights are off.', 'Built-in · nothing left your home',
          on.length ? { actions: [{ label: 'Turn them all off', action: { type: 'apply', targets: Object.fromEntries(on.map(d => [d.id, { on: false }])), label: 'All lights off', done: 'All lights are off.' } }] } : {});
      }
      case 'play': {
        try {
          const undo = await this.engine.command(i.device, { on: true, media: i.title }, { ...CAUSE, label: `Play ${i.title}` });
          const d = this.reg.get(i.device);
          return reply(`Playing ${d?.state.media ?? i.title} on ${i.label}.`, 'Device control', { undo });
        } catch (e) {
          return reply(e instanceof Error ? e.message : String(e), 'Device control');
        }
      }
      case 'music': {
        if (!this.music) return reply('Kova plays Helix music once it’s paired with Helix (Integrations → Helix).', 'Device control');
        if (!i.devices.length) return reply(`Where should I play “${i.words}”? Say “in the kitchen”, or the speaker’s name.`, 'Device control');
        let found: { media: string; kind: string } | null;
        try { found = await this.music.find(i.words, { station: i.station }); } catch (e) { return reply(e instanceof Error ? e.message : String(e), 'Device control'); }
        if (!found) return reply(`Helix has nothing called “${i.words}”.`, 'Helix');
        const shuffle = i.shuffle || found.kind === 'all' || found.kind === 'station';
        const results = await Promise.allSettled(i.devices.map(id => this.engine.command(id, { on: true, media: found!.media, shuffle }, { ...CAUSE, label: `Play ${found!.media}` })));
        const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
        if (!ok.length) return reply((results[0] as PromiseRejectedResult).reason?.message ?? 'The speakers didn’t answer.', 'Device control');
        const what = found.media.replace(/^Artist: (.+)$/, 'songs by $1').replace(/^Album: (.+)$/, 'the album $1').replace(/^Song: (.+)$/, '$1, then songs like it')
          .replace(/^Station: (.+)$/, 'a station from $1').replace(/^Shuffle all$/, 'all your music').replace(/^Loved$/, 'your loved songs');
        const first = this.reg.get(i.devices[0])?.state.track;
        return reply(`Playing ${what}${shuffle && found.kind !== 'all' && found.kind !== 'station' ? ' on shuffle' : ''} ${/^(the speakers|.* speaker.*)$/i.test(i.label) ? 'on' : 'in'} ${i.label}${first ? `: ${first.title}${first.artist ? ` by ${first.artist}` : ''}` : ''}.`, 'Helix', { undo: ok[0].value });
      }
      case 'skip': {
        if (!i.devices.length) return reply('Nothing is playing a playlist to skip.', 'Device control');
        const results = await Promise.allSettled(i.devices.map(id => this.reg.command(id, { skip: i.delta }, { ...CAUSE, label: i.delta > 0 ? 'Next song' : 'Previous song' })));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed && results.every(r => r.status === 'rejected')) return reply(failed.reason?.message ?? 'The speaker didn’t answer.', 'Device control');
        const t = this.reg.get(i.devices[0])?.state.track;
        return reply(t ? `${i.delta > 0 ? 'Next' : 'Back'}: ${t.title}${t.artist ? ` by ${t.artist}` : ''}.` : 'Done.', 'Device control');
      }
      case 'nowPlaying': {
        const playing = this.speakers().filter(d => d.state.on && d.state.track);
        if (!playing.length) return reply('No speaker is playing a song from Helix right now.', 'Device control');
        // Speakers playing the same song together are said once.
        const bySong = new Map<string, Device[]>();
        for (const d of playing) { const k = `${d.state.track!.title}\0${d.state.media}`; bySong.set(k, [...(bySong.get(k) ?? []), d]); }
        const lines = [...bySong.values()].map(ds => {
          const t = ds[0].state.track!;
          return `${list(ds.map(d => this.speakerLabel(d)))}: ${t.title}${t.artist ? ` by ${t.artist}` : ''}${ds[0].state.media ? ` (${ds[0].state.media})` : ''}`;
        });
        return reply(`${lines.join('. ')}.`, 'Device control');
      }
      case 'pause': {
        if (!i.devices.length) return reply(i.resume ? 'Nothing is paused.' : 'Nothing is playing that I can pause.', 'Device control');
        const r = await this.engine.applyMany(Object.fromEntries(i.devices.map(id => [id, { paused: !i.resume }])), { ...CAUSE, label: i.resume ? 'Carry on' : 'Pause' });
        return reply(i.resume ? `Carrying on: ${i.label}.` : `Paused: ${i.label}.`, 'Device control', { undo: r.changed.length ? r.undo : undefined });
      }
      case 'roomEvents': return this.roomEventsReply(i);
      case 'reading': {
        const ds = this.devs().filter(d => d.room === i.room && !d.hidden && d.state.online !== false && reading(d, i.field));
        const sensors = ds.filter(isSensor);
        const from = sensors.length ? sensors : ds;
        // No sensor or device there: the air conditioner zone serving it, where the zone has its own sensor.
        if (!from.length && i.field === 'temp') {
          const z = roomReading(i.room, 'temp', this.reg.list(), this.config.get().devices ?? {});
          if (z.value != null) return reply(`It’s ${z.value}° in the ${i.label} (from its air conditioner zone).`, 'Built-in · nothing left your home');
        }
        if (!from.length) return reply(`Nothing in the ${i.label} measures ${i.field === 'humidity' ? 'humidity' : i.field === 'lux' ? 'the light' : 'the temperature'}.`, 'Built-in · nothing left your home');
        const vals = from.map(d => reading(d, i.field)!.value as number);
        const v = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
        const text = i.field === 'humidity' ? `${Math.round(v)}% humidity` : i.field === 'lux' ? `${Math.round(v)} lux` : `${v}°`;
        const hum = i.field === 'temp' ? from.map(d => d.state.humidity).filter((x): x is number => typeof x === 'number') : [];
        return reply(`It’s ${text} in the ${i.label}${hum.length ? `, ${Math.round(hum.reduce((a, b) => a + b, 0) / hum.length)}% humidity` : ''}${from.length > 1 ? ` (from ${from.length} ${sensors.length ? 'sensors' : 'devices'})` : ` (${from[0].name})`}.`, 'Built-in · nothing left your home');
      }
      case 'contact': {
        const ds = i.devices.map(id => this.reg.get(id)!).filter(Boolean);
        const open = ds.filter(d => d.state.open === true), off = ds.filter(d => d.state.online === false);
        if (ds.length === 1) {
          const d = ds[0];
          return reply(d.state.online === false ? `${d.name} isn’t answering, so I can’t tell.` : `${d.name} is ${d.state.open ? 'open' : 'closed'}.`, 'Built-in · nothing left your home');
        }
        return reply(open.length ? `${list(open.map(d => d.name))} ${open.length === 1 ? 'is' : 'are'} open.` : `All closed${off.length ? ` (${list(off.map(d => d.name))} isn’t answering)` : ''}.`, 'Built-in · nothing left your home');
      }
      case 'zone': {
        if (!Object.keys(i.targets).length) return reply(`No air conditioner zone serves the ${i.label} yet. Choose the rooms each zone serves in the AC’s settings.`, 'Device control');
        const r = await this.engine.applyMany(i.targets, { ...CAUSE, label: `${i.label} zone: ${i.what.toLowerCase()}` });
        const unit = Object.keys(this.reg.expandTargets(i.targets)).map(id => this.reg.get(id)).find((d): d is Device => !!d && hasZones(d));
        const ac = unit?.state;
        const HV: Record<string, string> = { cool: 'cooling', heat: 'heating', dry: 'drying', fan: 'on fan only', auto: 'on auto' };
        const acText = !ac ? '' : ac.on ? ` The AC is ${HV[ac.hvac ?? ''] ?? 'on'}${ac.target != null ? ` to ${ac.target}°` : ''}.` : ' The AC is off.';
        const done = r.changed.length ? `Done. ${i.label} zone: ${i.what.toLowerCase()}.` : `The ${i.label} zone was already like that.`;
        const acts = i.offer && !ac?.on ? [{ label: i.offer.label, action: { type: 'apply' as const, targets: i.offer.targets, label: 'AC on', done: 'The AC is on.' } }] : [];
        return reply(`${done}${acText}`, 'Device control', { undo: r.changed.length ? r.undo : undefined, actions: acts });
      }
      case 'acWhere': {
        const shown = i.rooms.slice(0, 8);
        return reply(`Which room? I don’t know where you are yet. Each room with an air conditioner zone has its own AC.`, 'Device control', {
          actions: shown.map(r => ({ label: r.label, action: { type: 'roomAc' as const, room: r.room, on: i.on, done: `${r.label} AC ${i.on ? 'on' : 'off'}.` } })),
        });
      }
      case 'hardware': {
        const d = this.reg.get(i.device);
        return reply(d ? hardwareSummary(d) : 'Kova can’t read that right now.', 'Built-in · nothing left your home');
      }
      case 'status': {
        const now = this.engine.planner.modeAt(this.engine.now());
        return reply(`The home is in ${now.mode.name} until ${clock(now.until, tz)}, then ${now.next.name}.`, 'From your modes');
      }
    }
  }

  /** What a room's cameras and sensors saw: now, or today (with the last time before that when today was quiet). */
  private roomEventsReply(i: Extract<Intent, { kind: 'roomEvents' }>): AskReply {
    const cfg = this.config.get(), tz = cfg.timezone, t = this.engine.now();
    const rooms = this.engine.rooms;
    const watchers = this.devs().filter(d => d.room === i.room && (isCamera(d) || (isSensor(d) && (typeof d.state.motion === 'boolean' || typeof d.state.open === 'boolean'))));
    const src: Source = 'From the activity log';
    const acts = [{ label: 'Open Security', action: { type: 'screen' as const, screen: 'security' } }];
    const reply = (text: string): AskReply => ({ text, source: src, actions: acts, understood: true });
    if (!watchers.length) return reply(`There’s no camera or sensor in the ${i.label}, so I can’t tell.`);
    // "at the front door", "in the garage"
    const where = `${/door|porch|gate|drive/i.test(i.label) ? 'at' : 'in'} the ${i.label}`;
    const kinds = i.kinds ?? undefined;
    const ago = (at: number) => { const m = Math.round((t - at) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `at ${clock(at, tz)}`; };
    const name = (id: string) => this.reg.get(id)?.name ?? 'A camera';
    const WORDS: Record<string, [string, string]> = { person: ['a person', 'people'], motion: ['motion', 'motion'], ring: ['the doorbell', 'the doorbell'], vehicle: ['a vehicle', 'vehicles'], animal: ['an animal', 'animals'], package: ['a package', 'packages'], sound: ['a sound', 'sounds'], opened: ['a door opening', 'doors opening'], closed: ['a door closing', 'doors closing'] };
    if (i.now) {
      const st = rooms.status(i.room);
      const last = rooms.latest(i.room, kinds ?? ['person', 'motion', 'ring', 'opened', 'closed', 'package', 'vehicle', 'animal'], t - 10 * 60_000);
      const DID: Record<string, string> = { person: 'saw a person', motion: 'noticed motion', ring: 'rang', vehicle: 'saw a vehicle', animal: 'saw an animal', package: 'saw a package', sound: 'heard a sound', opened: 'opened', closed: 'closed' };
      if (last) return reply(`Yes: ${name(last.device)} ${DID[last.kind] ?? last.kind} ${ago(last.at)}.`);
      if (st.occupied) return reply(`A motion sensor ${where} says someone’s moving there now.`);
    }
    const midnight = atLocal(localDate(t, tz), 0, tz);
    const today = rooms.summary(i.room, midnight).filter(x => !kinds || kinds.includes(x.kind));
    if (today.length) {
      const parts = today.map(x => `${WORDS[x.kind]?.[0] ?? x.kind}${x.count > 1 ? ` ${x.count} times` : ''} (${x.count > 1 ? 'last ' : ''}${clock(x.last, tz)})`);
      return reply(`${i.now ? 'Nothing in the last 10 minutes. ' : ''}Today ${where}: ${list(parts)}.`);
    }
    const before = rooms.latest(i.room, kinds ?? ['person', 'motion', 'ring', 'opened', 'closed', 'package', 'vehicle', 'animal']);
    const what = kinds?.includes('motion') ? 'No motion' : kinds?.includes('person') ? 'Nobody' : 'Nothing';
    return reply(`${what} ${where} today.${before ? ` The last was ${WORDS[before.kind]?.[0] ?? before.kind} ${localDate(before.at, tz) === localDate(t - 86400_000, tz) ? 'yesterday' : `on ${new Date(before.at).toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz })}`} at ${clock(before.at, tz)}.` : ''}`);
  }

  async act(a: AskAction): Promise<{ text: string; undo?: string }> {
    if (a.type === 'apply') { const r = await this.engine.applyMany(a.targets, { ...CAUSE, label: a.label }); return { text: a.done, undo: r.undo }; }
    if (a.type === 'overlay') return { text: a.done, undo: await this.engine.startOverlay(a.id, CAUSE) };
    if (a.type === 'roomAc') {
      if (!this.roomClimate) return { text: 'Room ACs aren’t available on this hub.' };
      const r = await this.roomClimate.apply(a.room, { on: a.on }, CAUSE);
      const unit = this.roomClimate.view(a.room);
      const HV: Record<string, string> = { cool: 'cooling', heat: 'heating', dry: 'drying', fan: 'on fan only', auto: 'on auto' };
      const how = a.on && unit?.on && unit.hvac ? ` The AC is ${HV[unit.hvac] ?? 'on'}${unit.target != null ? ` to ${unit.target}°` : ''}${r.why ? `, because ${r.why}` : ''}.` : '';
      return { text: `${a.done}${how}`, undo: r.changed.length ? r.undo : undefined };
    }
    if (a.type === 'suggestion') {
      const s = this.learner?.find(a.id);
      if (!s) return { text: 'That suggestion no longer applies.' };
      return { text: `${s.finding.done ?? 'Done'}.`, undo: this.engine.registerUndo(this.learner!.apply(a.id)) };
    }
    if (a.type === 'learnGroup') {
      demand('home');
      const undo = this.config.update(c => { c.groups[a.name] = a.rooms; });
      return { text: `Saved. Try “turn off ${a.name}”.`, undo: this.engine.registerUndo(undo) };
    }
    return { text: '' };
  }
}
