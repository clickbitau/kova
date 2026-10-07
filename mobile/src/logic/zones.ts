// Ducted air conditioner zones: which to show and what to call them, the rooms each zone serves (the owner confirms
// Kova's suggestions), a room's zone as a control, and "zone:<room>" targets for automations, modes and overlays.
// Free of React Native so the tests run it under plain Node. The hub's side: hub/src/util/zones.ts.
import type { Command, Device, HvacMode, FanSpeed, Room, RoomStatus, RoomZone } from '../api/types';

export interface ZoneView { n: number; name: string; on: boolean; open: number }

/** The zones in use (on, open, or named) unless `all`; each with its name, or "Zone n". */
export function visibleZones(zones: { n: number; on: boolean; open: number | null }[] | null | undefined, names: Record<string, string> = {}, all = false): ZoneView[] {
  return (zones ?? [])
    .filter(z => all || z.on || (z.open ?? 0) > 0 || !!names[String(z.n)])
    .map(z => ({ n: z.n, name: names[String(z.n)] || `Zone ${z.n}`, on: z.on, open: z.open ?? 0 }));
}

/** Openings move in steps of 5%, as the units do. */
export const snapOpen = (v: number) => Math.max(0, Math.min(100, Math.round(v / 5) * 5));

// ------------------------------------------------------------ whole home --

/** The place of a device that serves the whole home rather than one room (a ducted air conditioner). */
export const WHOLE_HOME = 'whole_home';
export const WHOLE_HOME_NAME = 'Whole home';
export const WHOLE_HOME_ICON = 'home';
export const isWholeHome = (d: Pick<Device, 'room'>) => d.room === WHOLE_HOME;

// ------------------------------------------------------- zones and rooms --

type Named = Pick<Room, 'id' | 'name'>;
/** Rooms by id, in the order given, leaving out ones the home doesn't have any more. */
const known = (ids: string[] | undefined, rooms: Named[]) => (ids ?? []).map(id => rooms.find(r => r.id === id)).filter((r): r is Named => !!r);
/** Room names in words: "Office and Guest room", "Lounge, Kitchen and Music room". */
export function roomWords(ids: string[] | undefined, rooms: Named[]): string {
  const n = known(ids, rooms).map(r => r.name);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? '';
}

/** A zone in the air conditioner's panel, with the rooms it serves and the ones Kova suggests (not yet confirmed). */
export interface ZoneRoomView extends ZoneView { rooms: string[]; suggest: string[] }

/** Each zone with its confirmed rooms, and Kova's suggestion where none is confirmed. Rooms that are gone are left out. */
export function zoneRoomViews(zones: ZoneView[], d: Pick<Device, 'zoneRooms' | 'zoneSuggest'>, rooms: Named[]): ZoneRoomView[] {
  return zones.map(z => {
    const mine = known(d.zoneRooms?.[String(z.n)], rooms).map(r => r.id);
    const sug = mine.length ? [] : known(d.zoneSuggest?.[String(z.n)], rooms).map(r => r.id);
    return { ...z, rooms: mine, suggest: sug };
  });
}

/** A room in or out of a zone's list, keeping the order it was picked in. */
export const toggleRoom = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

/** The settings change for one zone's rooms: a list sets it, none clears it. */
export const zoneRoomsBody = (n: number, ids: string[]) => ({ zoneRooms: { [String(n)]: ids.length ? ids : null } });

/** "Use suggestions": every suggestion Kova has (for rooms the home still has), as one settings change; null when there's none. */
export function suggestionsBody(d: Pick<Device, 'zoneRooms' | 'zoneSuggest'>, rooms: Named[]): { zoneRooms: Record<string, string[]> } | null {
  const out: Record<string, string[]> = {};
  for (const [n, ids] of Object.entries(d.zoneSuggest ?? {})) {
    if (d.zoneRooms?.[n]?.length) continue;
    const k = known(ids, rooms).map(r => r.id);
    if (k.length) out[n] = k;
  }
  return Object.keys(out).length ? { zoneRooms: out } : null;
}

/** What a zone serves, in a line: "Office and Guest room", or that it serves no room yet. */
export const servesLine = (z: Pick<ZoneRoomView, 'rooms'>, rooms: Named[]) => z.rooms.length ? roomWords(z.rooms, rooms) : 'No room yet';

// ------------------------------------------------------ a room's zones --

const HVAC_WORD: Record<HvacMode, string> = { cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan', auto: 'Auto' };
export const hvacWord = (h: HvacMode | null | undefined) => (h ? HVAC_WORD[h] ?? h : '');

/** The zones serving each room, from the snapshot (rooms with none are left out). */
export function zonesByRoom(status: Record<string, Pick<RoomStatus, 'zones'>> | null | undefined): Record<string, RoomZone[]> {
  const out: Record<string, RoomZone[]> = {};
  for (const [id, st] of Object.entries(status ?? {})) if (st?.zones?.length) out[id] = st.zones;
  return out;
}

/** The zone itself, in a few words: "Open 60%", "Closed". */
export const zoneState = (z: Pick<RoomZone, 'on' | 'open'>) => (z.on ? (z.open != null ? `Open ${z.open}%` : 'Open') : 'Closed');

/** The air conditioner behind a zone: "AC cool 23°", "AC off", "AC not responding". */
export function acState(z: Pick<RoomZone, 'ac'>): string {
  if (!z.ac.online) return 'AC not responding';
  if (!z.ac.on) return 'AC off';
  return ['AC', hvacWord(z.ac.hvac).toLowerCase() || 'on', z.ac.target != null ? `${z.ac.target}°` : ''].filter(Boolean).join(' ');
}

/** A room's zone in a line, as the room shows it: "Open 60% · AC cool 23°". */
export const roomZoneLine = (z: Pick<RoomZone, 'on' | 'open' | 'ac'>) => `${zoneState(z)} · ${acState(z)}`;

/** The other rooms a zone serves, for "Shared with Guest room". */
export const sharedWith = (z: Pick<RoomZone, 'rooms'>, room: string, rooms: Named[]) => roomWords(z.rooms.filter(r => r !== room), rooms);

/** Open or close a room's zone. It never touches the air conditioner itself (closing the last zone is the hub's to handle). */
export const zoneSwitch = (z: Pick<RoomZone, 'n'>, on: boolean): Command => ({ zoneSet: { [String(z.n)]: { on } } });
/** Open a zone this far (0 closes it). */
export const zoneOpenAt = (z: Pick<RoomZone, 'n'>, open: number): Command => {
  const v = snapOpen(open);
  return { zoneSet: { [String(z.n)]: v > 0 ? { on: true, open: v } : { on: false } } };
};
/** Turn the air conditioner on for this room, in the mode Kova suggests, with the zone open. */
export const acOnFor = (z: Pick<RoomZone, 'n' | 'suggest'>): Command => ({ on: true, hvac: z.suggest.hvac, target: z.suggest.target, zoneSet: { [String(z.n)]: { on: true } } });
/** The suggestion in words: "Cool at 24°". */
export const suggestWords = (z: Pick<RoomZone, 'suggest'>) => `${hvacWord(z.suggest.hvac)} at ${z.suggest.target}°`;
/** The zone is open but the unit is off: offer to turn it on (never silently). */
export const offersAcOn = (z: Pick<RoomZone, 'on' | 'ac'>) => z.on && !z.ac.on && z.ac.online;

// ---------------------------------------------------- "zone:<room>" targets --

/** What a room's zone target asks (hub ZoneCommand): its zone open or closed, how far open, and optionally the unit. */
export interface ZoneCommand { on?: boolean; open?: number; hvac?: HvacMode; target?: number; fanSpeed?: FanSpeed; ac?: boolean }
export const ZONE_TARGET = /^zone:(.+)$/;
export const isZoneTarget = (id: string) => ZONE_TARGET.test(id);
export const zoneTarget = (room: string) => `zone:${room}`;
export const zoneTargetRoom = (id: string) => ZONE_TARGET.exec(id)?.[1] ?? null;
/** "Lounge zone" (or the room id, when the room is gone). */
export const zoneTargetLabel = (id: string, rooms: Named[]) => { const r = zoneTargetRoom(id) ?? id; return `${rooms.find(x => x.id === r)?.name ?? r} zone`; };

/** Rooms a zone serves now (confirmed on a zoned unit that isn't archived), in the home's order. */
export function zonedRooms<R extends Named>(devices: Pick<Device, 'capabilities' | 'archived' | 'zoneRooms'>[], rooms: R[]): R[] {
  const ids = new Set<string>();
  for (const d of devices) if (!d.archived && (d.capabilities ?? []).includes('zones')) for (const rs of Object.values(d.zoneRooms ?? {})) for (const r of rs) ids.add(r);
  return rooms.filter(r => ids.has(r.id));
}
/** The "<Room> zone" targets a step, mode or overlay can set. */
export const zoneTargetOptions = (devices: Pick<Device, 'capabilities' | 'archived' | 'zoneRooms'>[], rooms: Named[]) =>
  zonedRooms(devices, rooms).map(r => ({ v: zoneTarget(r.id), label: `${r.name} zone` }));

/** A zone target in words, as the hub says it: "open 50%, AC cool 23°", "closed". */
export function zoneCommandWords(c: ZoneCommand): string {
  const zone = c.on === false ? 'closed' : c.open != null ? (c.open === 0 ? 'closed' : `open ${c.open}%`) : c.on ? 'open' : '';
  const unit = [c.hvac ?? (c.ac ? 'on' : ''), c.target != null ? `${c.target}°` : '', c.fanSpeed ? `fan ${c.fanSpeed}` : ''].filter(Boolean).join(' ');
  const ac = c.ac === false ? 'AC off' : unit ? `AC ${unit}` : '';
  return [zone, ac].filter(Boolean).join(', ') || 'as it is';
}
/** A few zone targets as one tap, each replacing the command. */
export const ZONE_PRESETS: [ZoneCommand, string][] = [
  [{ on: true }, 'Open'], [{ on: true, open: 50 }, 'Open 50%'], [{ on: false }, 'Closed'],
  [{ on: true, hvac: 'cool', target: 24 }, 'Open, cool to 24°'], [{ on: true, hvac: 'heat', target: 21 }, 'Open, heat to 21°'],
];
/** The fields a zone target takes, in the order they're shown. */
export const ZONE_FIELDS = ['on', 'open', 'hvac', 'target', 'fanSpeed', 'ac'] as const;
