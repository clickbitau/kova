// Modes, overlays and moments on the phone: the editors' choices, words and request bodies, free of React Native so
// the tests run them under plain Node. The hub checks everything again (hub/src/api/edit-routes.ts).
import type { Command, OverlayEnd, TargetRow } from '../api/types';
import { rhythmWords, type Rhythm, type Targets } from './automations.ts';

/** Icons a mode can have: times of day and how the home feels (all in the app's icon font, ui/icon-codes.ts). */
export const MODE_ICONS = ['light_mode', 'wb_sunny', 'sunny', 'partly_cloudy_day', 'wb_twilight', 'nights_stay', 'nightlight', 'bedtime', 'dark_mode', 'kitchen', 'menu_book', 'desk', 'weekend', 'routine', 'mosque', 'home'];
/** Icons an overlay can have: what's happening on top of the mode. */
export const OVERLAY_ICONS = ['movie', 'favorite', 'celebration', 'bedtime', 'flight_takeoff', 'luggage', 'menu_book', 'sports_esports', 'fitness_center', 'cleaning_services', 'music_note', 'tv', 'local_fire_department', 'layers', 'do_not_disturb_on'];
/** Mode colours, as the design picks them. */
export const MODE_COLORS = ['#dcd27e', '#f2b14c', '#ef8f6e', '#8aaef0', '#7fd4a0', '#c9a0f0', '#7cb8f0', '#ff6b5e', '#a3a09a'];

/** A name as the hub keeps it: trimmed, single spaces, at most `max` characters. */
export const clean = (v: string, max = 40) => v.trim().replace(/\s+/g, ' ').slice(0, max);

export interface ModeDraft { name: string; icon: string; color: string; start: Rhythm; lightTheWay: boolean; onlyWhenSomeoneHome: boolean }
export interface OverlayDraft { name: string; icon: string; ends: OverlayEnd; allOff: boolean }
export interface MomentDraft { label: string; what: string; at: Rhythm; targets: Targets }

export const blankMode = (): ModeDraft => ({ name: '', icon: 'routine', color: MODE_COLORS[0], start: { kind: 'time', at: '18:00' }, lightTheWay: false, onlyWhenSomeoneHome: false });
export const blankOverlay = (): OverlayDraft => ({ name: '', icon: 'layers', ends: { kind: 'manual' }, allOff: false });
export const blankMoment = (): MomentDraft => ({ label: '', what: '', at: { kind: 'time', at: '21:00' }, targets: {} });

/** What's still missing before it can be saved, or null. Names must be unique among the others (any case). */
export function modeError(d: ModeDraft, others: { id: string; name: string }[], self?: string): string | null {
  const n = clean(d.name);
  if (!n) return 'Give the mode a name';
  if (others.some(o => o.id !== self && o.name.toLowerCase() === n.toLowerCase())) return `There’s already a mode called ${n}`;
  return null;
}
export function overlayError(d: OverlayDraft, others: { id: string; name: string }[], self?: string): string | null {
  const n = clean(d.name);
  if (!n) return 'Give the overlay a name';
  if (others.some(o => o.id !== self && o.name.toLowerCase() === n.toLowerCase())) return `There’s already an overlay called ${n}`;
  if (d.ends.kind === 'device_off' && !d.ends.device) return 'Pick the device whose switching off ends it';
  return null;
}
export function momentError(d: MomentDraft): string | null {
  if (!clean(d.label)) return 'Give the moment a name';
  if (!Object.keys(d.targets).length) return 'Add at least one device';
  return null;
}

/** Request bodies. A new mode or overlay can start as a copy of another. */
export const modeBody = (d: ModeDraft, copyFrom?: string) => ({ name: clean(d.name), icon: d.icon, color: d.color, start: d.start, ...(copyFrom ? { copyFrom } : { lightTheWay: d.lightTheWay, onlyWhenSomeoneHome: d.onlyWhenSomeoneHome }) });
export const overlayBody = (d: OverlayDraft, copyFrom?: string) => ({ name: clean(d.name), icon: d.icon, ends: d.ends, allOff: d.allOff, ...(copyFrom ? { copyFrom } : {}) });
export const momentBody = (d: MomentDraft) => ({ label: clean(d.label), what: clean(d.what, 80), at: d.at, targets: d.targets });

/** A mode as the snapshot has it, as a draft. */
export function modeDraftOf(m: { name: string; icon: string; color: string; rhythm?: Rhythm; lightTheWay?: boolean; onlyWhenSomeoneHome?: boolean }): ModeDraft {
  return { name: m.name, icon: m.icon, color: m.color, start: m.rhythm ?? { kind: 'time', at: '18:00' }, lightTheWay: !!m.lightTheWay, onlyWhenSomeoneHome: !!m.onlyWhenSomeoneHome };
}
export function overlayDraftOf(o: { name: string; icon: string; ends?: OverlayEnd; allOff?: boolean }): OverlayDraft {
  return { name: o.name, icon: o.icon, ends: o.ends ?? { kind: 'manual' }, allOff: !!o.allOff };
}
/** Targets rows back into the map the hub takes (devices that are gone are left out). */
export const targetsOf = (rows: TargetRow[] | undefined): Targets => Object.fromEntries((rows ?? []).filter(r => !r.missing).map(r => [r.deviceId, r.target as Command]));
export function momentDraftOf(m: { label: string; what: string; at: Rhythm; targets: TargetRow[] }): MomentDraft {
  return { label: m.label, what: m.what, at: m.at, targets: targetsOf(m.targets) };
}

/** Did anything change? */
export const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------- endings --

export type EndKind = OverlayEnd['kind'];
export const END_KINDS: { id: EndKind; label: string }[] = [
  { id: 'manual', label: 'When you end it' }, { id: 'time', label: 'At a time' }, { id: 'device_off', label: 'A device turns off' }, { id: 'arrival', label: 'Someone comes home' },
];
/** A new ending of that kind, keeping what fits from the one before. */
export function endOf(kind: EndKind, prev: OverlayEnd, firstDevice = ''): OverlayEnd {
  if (kind === prev.kind) return prev;
  if (kind === 'time') return { kind, at: { kind: 'time', at: '00:00' } };
  if (kind === 'device_off') return { kind, device: firstDevice };
  return { kind };
}
/** How it ends in words, as the hub writes the label. */
export function endWords(e: OverlayEnd, deviceName: (id: string) => string = id => id): string {
  switch (e.kind) {
    case 'manual': return 'Ends when you end it';
    case 'arrival': return 'Ends when someone comes home';
    case 'device_off': return e.device ? `Ends when the ${deviceName(e.device).toLowerCase()} turns off` : 'Ends when a device turns off';
    case 'time': return e.at.kind === 'time' && e.at.at === '00:00' ? 'Ends at midnight' : `Ends at ${rhythmWords(e.at).replace(/^At /, '').toLowerCase()}`;
  }
}

/** Offsets offered for sun and prayer times, in minutes. */
export const OFFSETS = [-60, -30, -15, -10, 0, 10, 15, 30, 60];
export const offsetWords = (m: number) => m === 0 ? 'On time' : `${Math.abs(m)} min ${m < 0 ? 'before' : 'after'}`;

/** Moments by id, in the order of the ids, leaving out ones the snapshot doesn't have. */
export function momentsIn<M extends { id: string }>(all: M[] | undefined, ids: string[]): M[] {
  return ids.map(id => (all ?? []).find(m => m.id === id)).filter((m): m is M => !!m);
}

/** Set (or with null, remove) one device in a targets map. */
export function setTarget(t: Targets, device: string, cmd: Command | null): Targets {
  const o = { ...t };
  if (cmd === null) delete o[device]; else o[device] = cmd;
  return o;
}
