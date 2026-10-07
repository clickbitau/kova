// Customise home: rooms, people, favourites, speaker groups and combined devices. Free of React Native so the
// tests run it under plain Node. The hub checks everything again (hub/src/api/home-routes.ts).
import type { Device, Room, SpeakerGroup } from '../api/types';
import { isPlayer } from './devices.ts';

/** The icons a room can have: the same list the hub accepts (GET /api/home/room-icons). */
export const ROOM_ICONS = ['weekend', 'kitchen', 'desk', 'bed', 'single_bed', 'crib', 'music_note', 'local_laundry_service', 'garage_home', 'door_front', 'yard', 'bathtub', 'stairs', 'meeting_room', 'chair', 'tv', 'deck', 'balcony', 'fitness_center', 'checkroom'];

/** A name as the hub keeps it: trimmed, single spaces, at most `max` characters. */
export const cleanName = (v: string, max = 40) => v.trim().replace(/\s+/g, ' ').slice(0, max);

/** Ids with one moved a step up (-1) or down (+1). Null when it can't move (at an end, or not there). */
export function moveStep(ids: string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each room with how many devices are in it, in the home's order. */
export function roomRows(rooms: Room[], devices: Pick<Device, 'room' | 'archived'>[]): { room: Room; count: number; sub: string }[] {
  return rooms.map(room => {
    const count = devices.filter(d => d.room === room.id && !d.archived).length;
    return { room, count, sub: count ? plural(count, 'device') : 'No devices yet' };
  });
}

/** The room id of devices in none of the home's rooms (the hub's UNASSIGNED_ROOM). */
export const UNASSIGNED = 'unassigned';

/**
 * Deleting a room: devices still in it go to no room ("unassigned") unless another room is chosen, so it can always
 * be deleted. `confirm` says what will happen, for the confirmation before it goes.
 */
export function roomDelete(id: string, rooms: Room[], devices: Pick<Device, 'room'>[], chosen?: string | null): { inside: number; moveTo: string | null; body: { moveTo?: string }; confirm: string } {
  const inside = devices.filter(d => d.room === id).length;
  const name = rooms.find(r => r.id === id)?.name ?? 'this room';
  if (!inside) return { inside, moveTo: null, body: {}, confirm: `Delete ${name}? It has no devices.` };
  const to = rooms.find(r => r.id === chosen && r.id !== id);
  const moveTo = to?.id ?? UNASSIGNED;
  const its = inside === 1 ? 'Its device goes' : `Its ${inside} devices go`;
  return { inside, moveTo, body: { moveTo }, confirm: `Delete ${name}? ${its} to ${to ? to.name : 'No room'}${to ? '' : ', until you give them a room'}.` };
}

// --------------------------------------------------------- groups of rooms --

export interface RoomGroup { name: string; rooms: string[]; roomNames: string[] }

/** The home's groups of rooms ("Upstairs" = the bedrooms), with the rooms' names; rooms that are gone are left out. */
export function roomGroups(groups: Record<string, string[]> | null | undefined, rooms: Room[]): RoomGroup[] {
  return Object.entries(groups ?? {}).map(([name, ids]) => {
    const kept = ids.filter(id => rooms.some(r => r.id === id));
    return { name, rooms: kept, roomNames: kept.map(id => rooms.find(r => r.id === id)!.name) };
  });
}

/** What's still missing before a group of rooms can be saved, or null. Names are unique and aren't a room's name. */
export function roomGroupError(name: string, picked: string[], groups: Record<string, string[]> | null | undefined, rooms: Room[], editing?: string | null): string | null {
  const n = cleanName(name);
  if (!n) return 'Give the group a name';
  const clash = Object.keys(groups ?? {}).find(g => g.toLowerCase() === n.toLowerCase() && g !== editing);
  if (clash) return `There’s already a group called ${clash}`;
  if (rooms.some(r => r.name.toLowerCase() === n.toLowerCase())) return `${n} is already a room’s name`;
  if (!picked.length) return 'Pick at least one room';
  return null;
}

// ----------------------------------------------------------------- archived --

/** Devices the owner archived, by name: they're out of every other list. */
export function archivedList<D extends Pick<Device, 'archived' | 'name'>>(devices: D[]): D[] {
  return devices.filter(d => d.archived).sort((a, b) => a.name.localeCompare(b.name));
}

/** Devices a device can be combined with: real devices (not groups or combined ones), not already in one, not archived. */
export function combineChoices<D extends Pick<Device, 'id' | 'name' | 'adapter' | 'archived'>>(self: string, devices: D[], combined: { members: string[] }[], q = ''): D[] {
  const taken = new Set(combined.flatMap(c => c.members));
  const t = q.trim().toLowerCase();
  return devices.filter(d => d.id !== self && !d.archived && d.adapter !== 'groups' && d.adapter !== 'combined' && !taken.has(d.id) && (!t || d.name.toLowerCase().includes(t)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The owner's favourites, in order, leaving out devices that are gone. */
export function favouriteList<D extends Pick<Device, 'id' | 'archived'>>(favs: string[] | null | undefined, devices: D[]): D[] {
  return (favs ?? []).map(id => devices.find(d => d.id === id)).filter((d): d is D => !!d && !d.archived);
}

/** Devices in a room (or in no room the home knows, for 'unassigned'), by name. Archived ones are left out. */
export function devicesIn<D extends Pick<Device, 'room' | 'name' | 'archived'>>(devices: D[], rooms: Room[], room: string): D[] {
  const known = new Set(rooms.map(r => r.id));
  return devices.filter(d => !d.archived && (room === UNASSIGNED ? !known.has(d.room) : d.room === room)).sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ speaker groups --

/** Speakers that can be in a group: speakers and TVs, not other groups, by room then name. */
export function speakerChoices<D extends Pick<Device, 'type' | 'adapter' | 'room' | 'name' | 'archived'>>(devices: D[], rooms: Room[]): D[] {
  const rn = (id: string) => rooms.find(r => r.id === id)?.name ?? '';
  return devices.filter(d => isPlayer(d) && d.adapter !== 'groups' && !d.archived).sort((a, b) => rn(a.room).localeCompare(rn(b.room)) || a.name.localeCompare(b.name));
}

export interface GroupDraft { name: string; members: string[]; room: string }

/** What's still missing before a group can be saved, or null. */
export function groupDraftError(d: GroupDraft): string | null {
  if (!cleanName(d.name)) return 'Give the group a name';
  if (new Set(d.members).size < 2) return 'Pick at least two speakers';
  return null;
}

/** The request body: a new group leaves out an automatic room; an edited one sends null to clear it. */
export function groupBody(d: GroupDraft, editing: boolean): { name: string; members: string[]; room?: string | null } {
  const body = { name: cleanName(d.name), members: [...new Set(d.members)] };
  return d.room ? { ...body, room: d.room } : editing ? { ...body, room: null } : body;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

/** How the picked speakers will play together, in words, as the web app says it. */
export function groupSyncNote(members: Pick<Device, 'adapter'>[], ids: string[], existing?: Pick<SpeakerGroup, 'members' | 'sync' | 'castGroup'> | null): { icon: string; tone: 'muted' | 'green' | 'amber'; title: string; text: string } {
  if (members.length < 2) return { icon: 'speaker_group', tone: 'muted', title: 'Pick at least two speakers', text: 'A group plays the same thing on all of them at once.' };
  if (existing && existing.sync === 'perfect' && same(existing.members, ids)) return { icon: 'graphic_eq', tone: 'green', title: 'Perfect sync', text: `These speakers are the Google Home group “${existing.castGroup}”, so Kova plays through it and they stay locked together.` };
  if (members.every(d => d.adapter === 'cast')) return { icon: 'sync', tone: 'amber', title: 'Starts together', text: 'For perfect sync, make a group with exactly these speakers in the Google Home app. Kova finds it and uses it.' };
  return { icon: 'sync', tone: 'amber', title: 'Starts together', text: 'Different brands start at the same moment but can drift a little over a long session. Great for background music across rooms.' };
}
