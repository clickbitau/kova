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
export function roomRows(rooms: Room[], devices: Pick<Device, 'room'>[]): { room: Room; count: number; sub: string }[] {
  return rooms.map(room => {
    const count = devices.filter(d => d.room === room.id).length;
    return { room, count, sub: count ? plural(count, 'device') : 'No devices yet' };
  });
}

/**
 * Deleting a room: devices still in it have to go somewhere, so the hub wants `moveTo` (the first other room unless
 * one was chosen). With no other room to move them to, it can't be deleted.
 */
export function roomDelete(id: string, rooms: Room[], devices: Pick<Device, 'room'>[], chosen?: string | null): { inside: number; moveTo: string | null; body: { moveTo?: string }; blocked?: string } {
  const inside = devices.filter(d => d.room === id).length;
  const others = rooms.filter(r => r.id !== id);
  if (!inside) return { inside, moveTo: null, body: {} };
  const moveTo = others.find(r => r.id === chosen)?.id ?? others[0]?.id ?? null;
  if (!moveTo) return { inside, moveTo: null, body: {}, blocked: 'Add another room first: its devices need somewhere to go.' };
  return { inside, moveTo, body: { moveTo } };
}

/** The owner's favourites, in order, leaving out devices that are gone. */
export function favouriteList<D extends Pick<Device, 'id'>>(favs: string[] | null | undefined, devices: D[]): D[] {
  return (favs ?? []).map(id => devices.find(d => d.id === id)).filter((d): d is D => !!d);
}

/** Devices in a room (or in no room the home knows, for 'unassigned'), by name. */
export function devicesIn<D extends Pick<Device, 'room' | 'name'>>(devices: D[], rooms: Room[], room: string): D[] {
  const known = new Set(rooms.map(r => r.id));
  return devices.filter(d => room === 'unassigned' ? !known.has(d.room) : d.room === room).sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ speaker groups --

/** Speakers that can be in a group: speakers and TVs, not other groups, by room then name. */
export function speakerChoices<D extends Pick<Device, 'type' | 'adapter' | 'room' | 'name'>>(devices: D[], rooms: Room[]): D[] {
  const rn = (id: string) => rooms.find(r => r.id === id)?.name ?? '';
  return devices.filter(d => isPlayer(d) && d.adapter !== 'groups').sort((a, b) => rn(a.room).localeCompare(rn(b.room)) || a.name.localeCompare(b.name));
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
