// How a device looks and what tapping it does: the same rules as the phone web app (web/phone.html),
// kept free of React Native so the tests can run them under plain Node.
import type { Command, Device, DeviceState, Room, Snapshot } from '../api/types';

/** A device with its state spread on top, the shape every screen works with. */
export type Dev = Device & DeviceState;

const C = { amber: '#f2b14c', blue: '#7cb8f0', green: '#7fd4a0', red: '#ff6b5e', stone: '#a3a09a', card: '#16171a', control: '#232428', muted: '#8a8781', onAmber: '#1a1408' };

export const ICON: Record<string, string> = {
  light: 'lightbulb', dimmer: 'lightbulb', fan: 'air_purifier', media: 'speaker', tv: 'tv', camera: 'videocam',
  plug: 'outlet', sensor: 'sensors', vacuum: 'cleaning_services', internet: 'wifi',
};

export const isLight = (d: Pick<Device, 'type'>) => d.type === 'light' || d.type === 'dimmer';
export const isPlayer = (d: Pick<Device, 'type'>) => d.type === 'media' || d.type === 'tv';
export const has = (d: Pick<Device, 'capabilities'>, c: string) => (d.capabilities ?? []).includes(c);

const VAC: Record<string, string> = { cleaning: 'Cleaning', returning: 'Returning to dock', docked: 'Docked', paused: 'Paused', idle: 'Idle', error: 'Needs attention' };

export function devs(s: Pick<Snapshot, 'devices'>): Record<string, Dev> {
  const o: Record<string, Dev> = {};
  for (const d of s.devices) o[d.id] = { ...d, ...d.state, bri: d.state.bri ?? 100 };
  return o;
}

/** The status line under a device's name, and its colour. */
/** Input names for a status line: a soundbar's "tv" is the TV's sound coming in over eARC. */
const INPUT_NAMES: Record<string, string> = { hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };
const inputName = (d: Dev) => d.input ? (d.input === 'tv' ? (has(d, 'sound') ? 'TV (eARC)' : 'TV') : INPUT_NAMES[d.input] ?? d.input) : '';

export function stateOf(d: Dev): [string, string] {
  if (d.id === 'warden_internet') return d.online === false ? ['Warden not answering', C.red] : d.on ? ['Internet up', C.green] : ['Internet down', C.red];
  if (d.type === 'camera' || d.type === 'sensor') return d.online === false ? ['Offline', C.red] : ['Live', C.green];
  if (d.online === false) return ['Not responding', C.red];
  if (d.type === 'vacuum') {
    const a = d.activity || (d.on ? 'cleaning' : 'idle');
    return [`${VAC[a] || 'Idle'}${d.battery != null ? ` · ${d.battery}%` : ''}`, a === 'error' ? C.red : a === 'cleaning' ? C.amber : C.stone];
  }
  if (d.type === 'fan') return [d.mode || 'Auto', C.blue];
  // A soundbar or TV Kova controls but can't stream to: on (and its input) or off, never "Playing".
  if (isPlayer(d) && !has(d, 'media')) return d.on ? [`On${inputName(d) ? ` · ${inputName(d)}` : ''}`, C.blue] : ['Off', C.stone];
  if (isPlayer(d)) return d.on ? [d.paused ? `Paused${d.media ? ` · ${d.media}` : ''}` : d.track ? `Playing ${d.track.title}${d.track.artist ? ` · ${d.track.artist}` : ''}` : d.media ? `Playing ${d.media}` : 'Playing', d.paused ? C.stone : C.blue] : ['Idle', C.stone];
  if (d.type === 'internet') return d.on ? ['Internet on', C.green] : ['Internet paused', C.amber];
  if (!d.on) return ['Off', C.stone];
  if (d.type === 'dimmer') return [`On · ${d.bri}%`, C.amber];
  if (d.type === 'plug') return [d.power != null ? `On · ${d.power} W` : 'On', C.amber];
  return ['On', C.amber];
}

/** Tile colours: amber when a light is on, blue for media and air, green for cameras, muted when off. */
export function tint(d: Dev): { bg: string; border: string; iconBg: string; iconFg: string } {
  const media = isPlayer(d);
  if (d.type === 'camera' || d.type === 'sensor') return { bg: C.card, border: 'rgba(255,255,255,0.05)', iconBg: 'rgba(127,212,160,0.15)', iconFg: C.green };
  if (d.type === 'fan' || media) return {
    bg: d.on && media ? 'rgba(124,184,240,0.12)' : C.card, border: d.on && media ? 'rgba(124,184,240,0.3)' : 'rgba(255,255,255,0.05)',
    iconBg: d.on ? 'rgba(124,184,240,0.2)' : C.control, iconFg: d.on ? C.blue : C.muted,
  };
  return d.on
    ? { bg: 'rgba(242,177,76,0.11)', border: 'rgba(242,177,76,0.28)', iconBg: d.color || C.amber, iconFg: C.onAmber }
    : { bg: C.card, border: 'rgba(255,255,255,0.05)', iconBg: C.control, iconFg: C.muted };
}

/**
 * What tapping a tile does. `null` means "open its panel instead" (a camera, or a Helix box with nothing playing).
 * Fans switch Auto/Sleep, a TV that plays its own library pauses and carries on, speakers start the first source.
 */
export function toggleCommand(d: Dev, sources: { name: string }[]): Command | null {
  if (d.type === 'sensor' || d.type === 'camera') return null;
  if (d.type === 'fan') return { mode: d.mode === 'Auto' ? 'Sleep' : 'Auto' };
  if (d.type === 'vacuum') return { on: !d.on };
  if (has(d, 'library')) return d.on ? { paused: !d.paused } : null;
  if (isPlayer(d) && !has(d, 'media')) return { on: !d.on };
  if (isPlayer(d)) return d.on ? { on: false, media: null } : { on: true, media: sources[0]?.name || 'Radio', vol: d.vol ?? 30 };
  return { on: !d.on };
}

/** The Now screen's favourites: the owner's list, or the first few visible lights and plugs. */
export function favourites(s: Pick<Snapshot, 'favourites' | 'devices'>, all: Record<string, Dev>): Dev[] {
  const ids = s.favourites ?? s.devices.filter(d => !d.hidden && (isLight(d) || d.type === 'plug')).slice(0, 4).map(d => d.id);
  return ids.map(id => all[id]).filter((d): d is Dev => !!d);
}

export const TYPES: { id: string; label: string; icon: string; test: (d: Dev) => boolean }[] = [
  { id: 'all', label: 'All', icon: 'apps', test: () => true },
  { id: 'lights', label: 'Lights', icon: 'lightbulb', test: isLight },
  { id: 'media', label: 'Speakers & TV', icon: 'speaker', test: isPlayer },
  { id: 'air', label: 'Air', icon: 'air_purifier', test: d => d.type === 'fan' },
  { id: 'cameras', label: 'Cameras', icon: 'videocam', test: d => d.type === 'camera' },
  { id: 'plugs', label: 'Plugs', icon: 'outlet', test: d => d.type === 'plug' },
  { id: 'vacuum', label: 'Vacuum', icon: 'cleaning_services', test: d => d.type === 'vacuum' },
  { id: 'other', label: 'Other', icon: 'category', test: d => !['light', 'dimmer', 'media', 'tv', 'fan', 'camera', 'plug', 'vacuum'].includes(d.type) },
];

export interface DevGroup { id: string; name: string; icon: string; devices: Dev[]; lightsOn: number }

/**
 * The Devices screen: devices by room in the home's room order (then anything in no room), filtered by
 * room, type and a search over name, room and integration. Hidden devices only when asked for.
 */
export function groupDevices(all: Dev[], rooms: Room[], f: { room?: string; type?: string; q?: string; showHidden?: boolean }): DevGroup[] {
  const q = (f.q ?? '').trim().toLowerCase();
  const typeTest = TYPES.find(t => t.id === (f.type ?? 'all'))?.test ?? (() => true);
  const roomName = (id: string) => rooms.find(r => r.id === id)?.name ?? (id === 'unassigned' ? 'Other' : id);
  const shown = all.filter(d => (f.showHidden || !d.hidden) && typeTest(d) && (!f.room || f.room === 'all' || d.room === f.room)
    && (!q || `${d.name} ${roomName(d.room)} ${d.integration}`.toLowerCase().includes(q)));
  const order = [...rooms.map(r => r.id), ...new Set(shown.map(d => d.room).filter(id => !rooms.some(r => r.id === id)))];
  return order.map(id => {
    const devices = shown.filter(d => d.room === id).sort((a, b) => a.name.localeCompare(b.name));
    return { id, name: roomName(id), icon: rooms.find(r => r.id === id)?.icon ?? 'category', devices, lightsOn: devices.filter(d => isLight(d) && d.on).length };
  }).filter(g => g.devices.length);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
