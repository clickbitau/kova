import type { Registry } from '../devices/registry.ts';
import { AccessDenied, NOT_YOURS, canRoom, currentActor, trusted } from '../services/actor.ts';
import type { Store } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { RoomActivity } from './rooms.ts';
import type { Notification } from '../services/notify.ts';
import type { WeatherNow, WeatherToday } from '../services/weather.ts';
import type { Cause, Command, Device, FanSpeed, HomeConfig, HvacMode, RoomClimateSettings, Targets } from '../model/types.ts';
import { hasZones, roomReading, zonesServing } from '../util/zones.ts';
import { localDate } from '../util/time.ts';

// Room air conditioning: "turn on the lounge AC" for a ducted unit that serves the whole home through zones.
//
// Each room a zone serves is a "room AC" of its own, published to Google Home, Alexa and Apple Home by the bridges
// (bridges/matter-bridge.ts, bridges/homekit.ts). Google Home resolves "turn on the AC" to the AC in the speaker's
// room, so a room AC is how Kova knows which speaker asked. This module is what a room AC does:
//
//   on      open the room's zone(s). If the unit is off, turn it on in a mode chosen for the room (below), at the
//           comfortable temperature for that mode, fan on auto; or in the room's last choice, when the owner set one
//           this season. Zones left open while it was off are closed: only the room that asked gets air. If the unit is already running for other rooms, keep its mode, set temperature and fan:
//           never flip other rooms.
//   off     close the room's zone(s). The unit turns off when no zone is left open (registry.expandTargets).
//   set     an explicit mode, set temperature or fan from a person: done as asked (it opens the zone and turns the
//           unit on too), and remembered as the room's choice for its next "on". Kova never changes it back: the
//           policy only chooses when the unit is off, and nothing re-evaluates a running unit.
//
// Choosing the mode (chooseMode): the room's temperature first, then the season for the home's hemisphere, then the
// weather outside. Deadbands keep it from heating a warm room or cooling a cool one.

export type Season = 'summer' | 'autumn' | 'winter' | 'spring' | 'tropical';

/** Comfortable set temperatures: what a room cools to and heats to unless someone chose otherwise. */
export interface Comfort { coolTo: number; heatTo: number }
export const DEFAULT_COMFORT: Comfort = { coolTo: 24, heatTo: 21 };
/** How far past the comfortable temperature a room must be before its reading picks the mode (°C). */
export const DEADBAND = 1;
/** Against the season, the room must be this far past it (°C): heating in summer only when the room is really cold. */
export const AGAINST_SEASON = 3;
/** A unit turned on by Kova within this long isn't "turned on elsewhere". */
export const OWN_CHANGE_MS = 2 * 60_000;

export const SEASON_LABEL: Record<Season, string> = { summer: 'Summer', autumn: 'Autumn', winter: 'Winter', spring: 'Spring', tropical: 'Warm all year' };

/** Meteorological seasons: December–February is winter in the north and summer in the south. Within 15° of the equator, warm all year. */
export function seasonAt(latitude: number, month: number): Season {
  if (Math.abs(latitude) < 15) return 'tropical';
  const north: Season[] = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
  const s = north[(Math.round(month) - 1 + 12) % 12];
  if (latitude >= 0) return s;
  return ({ winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' } as Record<string, Season>)[s];
}

/** The season at the home now, or null when the home has no location yet. */
export function seasonOf(cfg: Pick<HomeConfig, 'latitude' | 'longitude' | 'location' | 'timezone'>, t: number): Season | null {
  const lat = cfg.location?.latitude ?? cfg.latitude, lon = cfg.location?.longitude ?? cfg.longitude;
  if (!Number.isFinite(lat) || (!lat && !lon)) return null;
  return seasonAt(lat, Number(localDate(t, cfg.timezone).slice(5, 7)));
}

/** The owner's comfort settings, with the defaults filled in and kept sensible. */
export function comfortOf(s: RoomClimateSettings | undefined): Comfort {
  const ok = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  return { coolTo: ok(s?.coolTo, 18, 30, DEFAULT_COMFORT.coolTo), heatTo: ok(s?.heatTo, 16, 28, DEFAULT_COMFORT.heatTo) };
}

export interface Outside { temp: number | null; high: number | null; low: number | null }

export interface ModeChoice { hvac: 'cool' | 'heat'; why: string }

/**
 * Cool or heat for a room, from (in order):
 *  1. the room's temperature, when it's clearly warm (DEADBAND above the cool-to temperature) or cold (below the
 *     heat-to one) — against the season only when it's AGAINST_SEASON past it;
 *  2. the season: summer (and the tropics) cool, winter heats;
 *  3. in spring and autumn, the weather: a hot day (high 28°+, or 26°+ now) cools, a cold one (high 18° or less, or
 *     14° or less now) heats; else the room's (or outside) temperature against the middle of the comfortable band;
 *  4. with nothing to go on: spring cools, autumn heats.
 */
export function chooseMode(i: { room: number | null; outside: Outside | null; season: Season | null; comfort: Comfort }): ModeChoice {
  const { room, outside, season, comfort: c } = i;
  const warm = season === 'summer' || season === 'tropical', cold = season === 'winter';
  if (room != null) {
    if (room >= c.coolTo + (cold ? AGAINST_SEASON : DEADBAND)) return { hvac: 'cool', why: `the room is ${room}°` };
    if (room <= c.heatTo - (warm ? AGAINST_SEASON : DEADBAND)) return { hvac: 'heat', why: `the room is ${room}°` };
  }
  if (warm) return { hvac: 'cool', why: season === 'tropical' ? 'it’s warm all year here' : 'it’s summer' };
  if (cold) return { hvac: 'heat', why: 'it’s winter' };
  const o = outside;
  if (o && ((o.high != null && o.high >= 28) || (o.temp != null && o.temp >= 26))) return { hvac: 'cool', why: `it’s ${o.high != null && o.high >= 28 ? `${o.high}° today` : `${o.temp}° outside`}` };
  if (o && ((o.high != null && o.high <= 18) || (o.temp != null && o.temp <= 14))) return { hvac: 'heat', why: `it’s ${o.temp != null && o.temp <= 14 ? `${o.temp}° outside` : `only ${o.high}° today`}` };
  const mid = (c.coolTo + c.heatTo) / 2;
  const t = room ?? o?.temp ?? null;
  if (t != null) return t >= mid ? { hvac: 'cool', why: `${room != null ? 'the room' : 'outside'} is ${t}°` } : { hvac: 'heat', why: `${room != null ? 'the room' : 'outside'} is ${t}°` };
  return season === 'autumn' ? { hvac: 'heat', why: 'it’s autumn' } : { hvac: 'cool', why: season === 'spring' ? 'it’s spring' : 'nothing says otherwise' };
}

/** The comfortable set temperature for a mode. */
export function comfortTarget(hvac: HvacMode, c: Comfort, unitTarget?: number | null): number {
  if (hvac === 'cool') return c.coolTo;
  if (hvac === 'heat') return c.heatTo;
  return typeof unitTarget === 'number' ? unitTarget : cleanTarget((c.coolTo + c.heatTo) / 2);
}

/** Set temperatures a ducted unit takes: 16–32°, in half degrees. */
export const cleanTarget = (t: number) => Math.min(32, Math.max(16, Math.round(t * 2) / 2));

/** What a room asked for, and kept: its last explicit choice and whether it's holding now. */
export interface RoomMemory {
  hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed;
  /** The mode the unit ran in when the set temperature was chosen: 22° set while heating is for heating. */
  targetMode?: HvacMode | null;
  /** The season it was chosen in: a summer "cool" isn't brought back in winter. */
  season?: Season | null;
  at?: number;
  /** A person set it while the room's AC was on; it holds until the room's AC is turned off. */
  held?: boolean;
}

/** A change to a room's AC, from voice or an app. `hvac: 'off'` is the same as `on: false`. */
export interface RoomAcChange { on?: boolean; hvac?: HvacMode | 'off'; target?: number; fanSpeed?: FanSpeed }

/** One room AC as the apps and bridges show it. */
export interface RoomAc {
  room: string;
  /** The room's name, and the name the bridges publish ("Lounge AC"). */
  name: string;
  label: string;
  /** The zones that serve it. */
  zones: { device: string; n: number; name: string; shared: string[] }[];
  /** On: the unit is on and the room's zone is open. */
  on: boolean;
  hvac: HvacMode | null;
  /** The mode it last ran in (for controllers that switch "on" back to it). */
  lastHvac: HvacMode | null;
  target: number | null;
  /** The room's temperature: its sensors, else its zone, else the unit's own reading. */
  temp: number | null;
  tempFrom: 'room' | 'unit' | null;
  humidity: number | null;
  fanSpeed: FanSpeed | null;
  online: boolean;
  /** The room's explicit choice, while it holds. */
  held: { hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed } | null;
}

export interface Plan { targets: Targets; what: string; why: string | null }

type Deps = {
  reg: Registry; config: ConfigStore; store: Store; rooms?: RoomActivity; now: () => number;
  apply: (targets: Targets, cause: Cause) => Promise<{ changed: string[]; failed: { id: string; error: string }[]; undo?: string }>;
  outside?: () => Outside | null;
};

const MEMORY_KEY = 'room-climate';
const HVAC_WORD: Record<HvacMode, string> = { cool: 'cool', heat: 'heat', dry: 'dry', fan: 'fan only', auto: 'auto' };

/** Outside now and today, from the forecast. */
export function outsideFrom(w: { current: WeatherNow | null; today: WeatherToday | null } | null | undefined): Outside | null {
  if (!w?.current && !w?.today) return null;
  return { temp: w.current?.temp ?? null, high: w.today?.high ?? null, low: w.today?.low ?? null };
}

export class RoomClimate {
  /** Sends a phone notification (set by main.ts, like automations.notify). */
  notify: ((n: Notification) => Promise<unknown>) | null = null;
  private memory: Record<string, RoomMemory>;
  private lastSent = new Map<string, number>();
  private listeners: ((room: string | null) => void)[] = [];

  constructor(private d: Deps) {
    this.memory = d.store.get<Record<string, RoomMemory>>(MEMORY_KEY) ?? {};
    d.reg.on('sent', e => { if (hasZones(e.device)) this.lastSent.set(e.device.id, d.now()); });
    d.reg.on('change', e => { void this.onChange(e.device, e.prev, e.patch, e.cause); });
  }

  /** Called when a room's remembered choice changes (the bridges show the held setting). */
  onMemory(fn: (room: string | null) => void): void { this.listeners.push(fn); }

  private get cfg() { return this.d.config.get(); }
  settings(): Required<Pick<RoomClimateSettings, 'coolTo' | 'heatTo' | 'fromElsewhere'>> {
    const s = this.cfg.roomClimate;
    return { ...comfortOf(s), fromElsewhere: s?.fromElsewhere === 'rooms' ? 'rooms' : 'off' };
  }
  season(): Season | null { return seasonOf(this.cfg, this.d.now()); }
  outside(): Outside | null { return this.d.outside?.() ?? null; }
  remembered(room: string): RoomMemory | null { return this.memory[room] ?? null; }

  private remember(room: string, m: RoomMemory | null): void {
    if (m) this.memory[room] = m; else delete this.memory[room];
    this.d.store.set(MEMORY_KEY, this.memory);
    for (const fn of this.listeners) fn(room);
  }

  private settingsMap() { return this.cfg.devices ?? {}; }
  private units(room: string) {
    const by = new Map<string, { d: Device; ns: number[] }>();
    for (const { d, n } of zonesServing(room, this.d.reg.list(), this.settingsMap())) {
      const u = by.get(d.id) ?? { d, ns: [] };
      u.ns.push(n);
      by.set(d.id, u);
    }
    return [...by.values()];
  }

  /** Rooms that have a room AC: every real room a zone serves, in the home's room order. */
  rooms(): RoomAc[] {
    return this.cfg.rooms.map(r => this.view(r.id)).filter((x): x is RoomAc => !!x);
  }

  view(room: string): RoomAc | null {
    const r = this.cfg.rooms.find(x => x.id === room);
    const units = r ? this.units(room) : [];
    if (!r || !units.length) return null;
    const settings = this.settingsMap();
    const devices = this.d.reg.list();
    const zones = units.flatMap(({ d, ns }) => ns.map(n => ({
      device: d.id, n, name: settings[d.id]?.zoneNames?.[String(n)] || `Zone ${n}`,
      shared: (settings[d.id]?.zoneRooms?.[String(n)] ?? []).filter(x => x !== room),
    })));
    const open = units.some(({ d, ns }) => d.state.on === true && ns.some(n => d.state.zones?.find(z => z.n === n)?.on));
    const u = units.find(x => x.d.state.on) ?? units[0];
    const s = u.d.state;
    const reading = roomReading(room, 'temp', devices, settings).value;
    const hum = roomReading(room, 'humidity', devices, settings).value;
    const m = this.memory[room];
    const temp = reading ?? (typeof s.temp === 'number' ? s.temp : null);
    return {
      room, name: r.name, label: `${r.name} AC`, zones, on: open,
      hvac: open ? s.hvac ?? null : null, lastHvac: s.hvac ?? m?.hvac ?? null,
      target: typeof s.target === 'number' ? s.target : null,
      temp, tempFrom: reading != null ? 'room' : temp != null ? 'unit' : null, humidity: hum,
      fanSpeed: s.fanSpeed ?? null, online: units.every(x => x.d.state.online !== false),
      held: open && m?.held ? { ...(m.hvac ? { hvac: m.hvac } : {}), ...(m.target != null ? { target: m.target } : {}), ...(m.fanSpeed ? { fanSpeed: m.fanSpeed } : {}) } : null,
    };
  }

  // -------------------------------------------------------------- plans --

  /** What the unit should run in for this room, when it's off. */
  private choose(room: string, d: Device, given: { hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed } = {}): { hvac: HvacMode; target: number; fanSpeed: FanSpeed; why: string } {
    const c = comfortOf(this.cfg.roomClimate), season = this.season();
    const m = this.memory[room];
    const mine = m && m.season === season ? m : undefined;
    let hvac = given.hvac, why = '';
    if (!hvac && mine?.hvac) { hvac = mine.hvac; why = 'as you last set it'; }
    if (!hvac) {
      const temp = roomReading(room, 'temp', this.d.reg.list(), this.settingsMap()).value;
      const ch = chooseMode({ room: temp, outside: this.outside(), season, comfort: c });
      hvac = ch.hvac; why = ch.why;
    }
    const target = given.target ?? (mine?.target != null && (mine.targetMode ?? mine.hvac) === hvac ? mine.target : comfortTarget(hvac, c, d.state.target));
    const fanSpeed = given.fanSpeed ?? mine?.fanSpeed ?? 'auto';
    return { hvac, target: cleanTarget(target), fanSpeed, why };
  }

  /** "Turn on the <room> AC": open its zones; turn the unit on in a mode chosen for the room, or keep what it's doing. */
  planOn(room: string): Plan {
    const targets: Targets = {};
    let what = 'on', why: string | null = null;
    for (const { d, ns } of this.units(room)) {
      const zoneSet: Record<string, { on: boolean }> = Object.fromEntries(ns.map(n => [String(n), { on: true }]));
      if (d.state.on) { targets[d.id] = { zoneSet }; what = `on, keeping the AC on ${HVAC_WORD[d.state.hvac ?? 'auto']}${d.state.target != null ? ` ${d.state.target}°` : ''}`; continue; }
      // The unit is off, so no room is on: zones left open from before would get air they didn't ask for. Close them.
      for (const z of d.state.zones ?? []) if (z.on && !ns.includes(z.n)) zoneSet[String(z.n)] = { on: false };
      const ch = this.choose(room, d);
      targets[d.id] = { zoneSet, on: true, hvac: ch.hvac, target: ch.target, fanSpeed: ch.fanSpeed };
      what = `on, ${HVAC_WORD[ch.hvac]} to ${ch.target}°`;
      why = ch.why;
    }
    return { targets, what, why };
  }

  /** "Turn off the <room> AC": close its zones (the unit goes off with the last one). */
  planOff(room: string): Plan {
    return { targets: this.units(room).length ? { [`zone:${room}`]: { on: false } } : {}, what: 'off', why: null };
  }

  /** An explicit mode, set temperature or fan: done as asked, opening the room's zone and turning the unit on. */
  planSet(room: string, c: { hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed }): Plan {
    const targets: Targets = {};
    const comfort = comfortOf(this.cfg.roomClimate);
    for (const { d, ns } of this.units(room)) {
      const zoneSet = Object.fromEntries(ns.map(n => [String(n), { on: true }]));
      const cmd: Command = { zoneSet, on: true };
      if (d.state.on) {
        if (c.hvac) cmd.hvac = c.hvac;
        // A new mode without a temperature: that mode's comfortable one (heating to a cooling set point is too warm).
        if (c.target != null) cmd.target = cleanTarget(c.target);
        else if (c.hvac && c.hvac !== d.state.hvac && (c.hvac === 'cool' || c.hvac === 'heat')) cmd.target = comfortTarget(c.hvac, comfort);
        if (c.fanSpeed) cmd.fanSpeed = c.fanSpeed;
      } else {
        for (const z of d.state.zones ?? []) if (z.on && !ns.includes(z.n)) (zoneSet as Record<string, { on: boolean }>)[String(z.n)] = { on: false };
        const ch = this.choose(room, d, c);
        Object.assign(cmd, { hvac: ch.hvac, target: ch.target, fanSpeed: ch.fanSpeed });
      }
      targets[d.id] = cmd;
    }
    const what = [c.hvac ? HVAC_WORD[c.hvac] : '', c.target != null ? `${cleanTarget(c.target)}°` : '', c.fanSpeed ? `fan ${c.fanSpeed}` : ''].filter(Boolean).join(', ');
    return { targets, what: what || 'on', why: null };
  }

  // ------------------------------------------------------------ actions --

  /**
   * Do what a controller or a person asked of a room's AC. On/off without anything else is left to the policy;
   * a mode, temperature or fan is explicit.
   */
  async apply(room: string, change: RoomAcChange, cause: Cause): Promise<{ changed: string[]; failed: { id: string; error: string }[]; undo?: string; what: string; why: string | null }> {
    // A room AC is the whole home's unit reached through a room's zone: whoever may use the room may use it.
    if (!canRoom(currentActor(), room)) throw new AccessDenied(NOT_YOURS);
    const view = this.view(room);
    if (!view) throw new Error('No air conditioner zone serves that room');
    const off = change.on === false || change.hvac === 'off';
    const explicit = { ...(change.hvac && change.hvac !== 'off' ? { hvac: change.hvac } : {}), ...(change.target != null ? { target: cleanTarget(change.target) } : {}), ...(change.fanSpeed ? { fanSpeed: change.fanSpeed } : {}) };
    let plan: Plan;
    if (off) plan = this.planOff(room);
    else if (Object.keys(explicit).length) plan = this.planSet(room, explicit);
    else if (view.on) return { changed: [], failed: [], what: 'already on', why: null };
    else plan = this.planOn(room);
    const r = await trusted(() => this.d.apply(plan.targets, { ...cause, detail: `${view.label} ${plan.what}${plan.why ? ` (${plan.why})` : ''}` }));
    const m = this.memory[room];
    if (off) { if (m?.held) this.remember(room, { ...m, held: false }); }
    else if (Object.keys(explicit).length) {
      // The room's choice: kept for its next "on" this season, and holding until it's turned off.
      const was = m && m.season === this.season() ? m : {};
      const ran = this.view(room)?.hvac ?? explicit.hvac ?? null;
      this.remember(room, { ...was, ...explicit, ...(explicit.target != null ? { targetMode: ran } : explicit.hvac && was.target != null && was.targetMode !== explicit.hvac ? { target: undefined, targetMode: undefined } : {}), season: this.season(), at: this.d.now(), held: true });
    }
    return { ...r, what: plan.what, why: plan.why };
  }

  /** Forget a room's remembered choice. */
  forget(room: string): void { if (this.memory[room]) this.remember(room, null); }

  // --------------------------------------------- turned on from elsewhere --

  /**
   * The unit turned on from somewhere other than Kova (the maker's own app, or its Google or Alexa link) with every
   * zone closed. With the setting on: open the zones of rooms where someone is now (a motion sensor, a person or
   * motion seen in the last few minutes, or a TV or player going there), keeping the mode it was turned on in;
   * nobody anywhere: ask on the phones. Off (the default): nothing.
   */
  private async onChange(d: Device, prev: Command, patch: Command, cause: Cause): Promise<void> {
    if (!hasZones(d) || cause.kind !== 'device' || patch.on !== true || prev.on === true) return;
    if (this.settings().fromElsewhere !== 'rooms') return;
    const sent = this.lastSent.get(d.id);
    if (sent != null && this.d.now() - sent < OWN_CHANGE_MS) return;
    if ((d.state.zones ?? []).some(z => z.on)) return;
    const rooms = this.occupiedRooms(d);
    const fromCause: Cause = { kind: 'system', label: 'AC turned on elsewhere' };
    if (rooms.length) {
      const names = rooms.map(r => this.cfg.rooms.find(x => x.id === r)?.name ?? r);
      const targets: Targets = Object.fromEntries(rooms.map(r => [`zone:${r}`, { on: true }]));
      await this.d.apply(targets, { ...fromCause, detail: `opened ${names.join(', ')}, where someone is` }).catch(() => {});
      return;
    }
    this.d.store.append({ kind: 'system', device: d.id, feed: 'device', what: `${d.name} turned on from another app with every zone closed`, data: {}, cause: fromCause });
    await this.notify?.({
      title: `${d.name} is on with every zone closed`,
      body: 'It was turned on from another app, and Kova couldn’t tell which room. Open Kova to choose the rooms.',
      tag: `room-climate-${d.id}`, url: `/phone.html?device=${encodeURIComponent(d.id)}`,
    }).catch(() => {});
  }

  /** Rooms this unit serves where someone is now. */
  occupiedRooms(d: Device): string[] {
    const settings = this.settingsMap()[d.id]?.zoneRooms ?? {};
    const served = [...new Set(Object.values(settings).flat())].filter(r => this.cfg.rooms.some(x => x.id === r));
    const devices = this.d.reg.list();
    return served.filter(r => {
      const st = this.d.rooms?.status(r);
      if (st?.occupied) return true;
      // A TV on, or a speaker playing, there.
      return devices.some(x => x.room === r && !x.archived && x.state.online !== false && x.state.on === true && (x.type === 'tv' || (x.type === 'media' && !!x.state.media && !x.state.paused)));
    });
  }
}
