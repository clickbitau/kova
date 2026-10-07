// How a device looks and what tapping it does: the same rules as the phone web app (web/phone.html),
// kept free of React Native so the tests can run them under plain Node.
import type { Command, Device, DeviceState, Room, Snapshot } from '../api/types';
import { isSensor } from './sensors.ts';
import { WHOLE_HOME, WHOLE_HOME_ICON, WHOLE_HOME_NAME } from './zones.ts';

/** A device with its state spread on top, the shape every screen works with. */
export type Dev = Device & DeviceState;

const C = { amber: '#f2b14c', blue: '#7cb8f0', green: '#7fd4a0', red: '#ff6b5e', stone: '#a3a09a', card: '#16171a', control: '#232428', muted: '#8a8781', onAmber: '#1a1408' };

export const ICON: Record<string, string> = {
  light: 'lightbulb', dimmer: 'lightbulb', fan: 'air_purifier', media: 'speaker', tv: 'tv', camera: 'videocam',
  plug: 'outlet', sensor: 'sensors', vacuum: 'cleaning_services', internet: 'wifi', climate: 'ac_unit',
};

/** Air conditioner modes: id, name, icon, colour. */
export const HVAC: [NonNullable<Dev['hvac']>, string, string, string][] = [
  ['cool', 'Cool', 'ac_unit', C.blue], ['heat', 'Heat', 'local_fire_department', C.amber], ['dry', 'Dry', 'water_drop', C.green],
  ['fan', 'Fan', 'mode_fan', C.stone], ['auto', 'Auto', 'autorenew', '#c9a0f0'],
];
export const FAN_SPEEDS: [NonNullable<Dev['fanSpeed']>, string][] = [['auto', 'Auto'], ['quiet', 'Quiet'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['turbo', 'Turbo']];

/** The air as a purifier rates it: 1 good … 4 very poor, with its colour. */
export const AIR: Record<number, [string, string]> = { 1: ['Good', C.green], 2: ['Moderate', '#dcd27e'], 3: ['Poor', C.amber], 4: ['Very poor', C.red] };

/** A purifier's filter: how urgent replacing it is. */
export const filterNote = (life?: number | null) => life == null ? '' : life <= 10 ? 'Replace the filter now' : life <= 20 ? 'Replace the filter soon' : '';

export const isLight = (d: Pick<Device, 'type'>) => d.type === 'light' || d.type === 'dimmer';
export const isPlayer = (d: Pick<Device, 'type'>) => d.type === 'media' || d.type === 'tv';
export const has = (d: Pick<Device, 'capabilities'>, c: string) => (d.capabilities ?? []).includes(c);

const VAC: Record<string, string> = { cleaning: 'Cleaning', returning: 'Returning to dock', docked: 'Docked', paused: 'Paused', idle: 'Idle', error: 'Needs attention' };

export { isSensor };

export function devs(s: Pick<Snapshot, 'devices'>): Record<string, Dev> {
  const o: Record<string, Dev> = {};
  for (const d of s.devices) o[d.id] = { ...d, ...d.state, bri: d.state.bri ?? 100 };
  return o;
}

/** The status line under a device's name, and its colour. */
/** Input names for a status line: a soundbar's "tv" is the TV's sound coming in over eARC. */
const INPUT_NAMES: Record<string, string> = { hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };
const inputName = (d: Dev) => d.input ? (d.input === 'tv' ? (has(d, 'sound') ? 'TV (eARC)' : 'TV') : INPUT_NAMES[d.input] ?? d.input) : '';

/** The router (Warden, from its BMC). */
export const ROUTER_ID = 'warden_router';
const PROBLEM: Record<string, string> = { 'no input power': 'No input power', failed: 'Failed', 'predicted to fail': 'Predicted to fail', 'input power out of range': 'Input out of range', 'not installed': 'Not installed' };
const REDUNDANCY: Record<string, [string, string, string]> = { full: ['Full', C.green, 'The supplies back each other up'], degraded: ['Degraded', C.amber, 'Still running, with less backup'], lost: ['Lost', C.red, 'One more failure and it goes off'] };

/** The icon for a device: its type's, or the router's own. */
export const iconOf = (d: Pick<Device, 'id' | 'type'>) => d.id === ROUTER_ID ? 'dns' : ICON[d.type] ?? 'devices';

/** The router's power panel, shown on the Router and on the Internet device: null when Warden can't read its hardware. */
export function routerPanel(s: Pick<Snapshot, 'devices' | 'insights'>, d: Pick<Device, 'id'>) {
  const all = devs(s);
  const R = d.id === ROUTER_ID ? all[ROUTER_ID] : d.id === 'warden_internet' ? all[ROUTER_ID] : undefined;
  if (!R || !(Array.isArray(R.supplies) || Array.isArray(R.sensors) || R.power != null)) return null;
  const red = R.redundancy ? REDUNDANCY[R.redundancy] : undefined;
  const alert = (s.insights ?? []).find(i => i.device === R.id && i.id.startsWith('power:'));
  return {
    title: d.id === R.id ? 'Power' : 'Router power',
    watts: R.power != null ? `${Math.round(R.power)} W` : '—',
    wattsNote: R.online === false ? 'Warden can’t read it right now' : R.power != null ? 'Drawing now' : 'Not measured by this hardware',
    redundancy: red ? { label: red[0], color: red[1], note: red[2] } : { label: '—', color: C.stone, note: 'Not reported' },
    alert: alert ? { text: alert.title, color: alert.level === 'alert' ? C.red : C.amber } : null,
    supplies: (R.supplies ?? []).map(x => {
      const warn = x.problem === 'predicted to fail';
      return { name: x.name, badge: x.ok ? 'OK' : PROBLEM[x.problem ?? ''] ?? 'Not OK', color: x.ok ? C.green : warn ? C.amber : C.red, icon: x.ok ? 'check_circle' : warn ? 'warning' : 'power_off' };
    }),
    temps: (R.sensors ?? []).filter(x => x.kind === 'temp').map(x => ({ name: x.name, value: `${x.value}°`, color: x.value >= 80 ? C.red : x.value >= 65 ? C.amber : '#f1efea' })),
    fans: (R.sensors ?? []).filter(x => x.kind === 'fan').map(x => `${x.name} · ${x.value} rpm`),
    fanMode: R.fanMode ? `${R.fanMode[0].toUpperCase()}${R.fanMode.slice(1)}${R.fanPercent != null ? ` · ${R.fanPercent}%` : ''}` : '',
  };
}

export function stateOf(d: Dev): [string, string] {
  if (d.id === ROUTER_ID) {
    const bad = (d.supplies ?? []).filter(x => !x.ok), w = d.power != null ? `${Math.round(d.power)} W` : '';
    if (d.online === false) return ['Not answering', C.red];
    if (bad.length || (d.redundancy && d.redundancy !== 'full')) {
      const what = bad.length ? `${bad.length === 1 ? bad[0].name : `${bad.length} supplies`} not OK` : `Redundancy ${d.redundancy}`;
      return [[what, w].filter(Boolean).join(' · '), d.redundancy === 'lost' || bad.some(x => x.problem !== 'predicted to fail') ? C.red : C.amber];
    }
    return [w || 'OK', C.green];
  }
  if (d.id === 'warden_internet') return d.online === false ? ['Warden not answering', C.red] : d.on ? ['Internet up', C.green] : ['Internet down', C.red];
  if (isSensor(d)) {
    if (d.online === false) return ['Not responding', C.red];
    const parts = [d.open != null ? (d.open ? 'Open' : 'Closed') : '', d.motion != null ? (d.motion ? 'Motion' : 'Clear') : '', d.temp != null ? `${d.temp}°` : '', d.humidity != null ? `${Math.round(d.humidity)}%` : '', d.power != null ? `${Math.round(d.power)} W` : ''].filter(Boolean);
    return [parts.slice(0, 2).join(' · ') || 'Reporting', d.open || d.motion ? C.amber : C.green];
  }
  if (d.type === 'camera') return d.online === false ? ['Offline', C.red] : ['Live', C.green];
  if (d.online === false) return ['Not responding', C.red];
  if (d.type === 'vacuum') {
    const a = d.activity || (d.on ? 'cleaning' : 'idle');
    return [`${VAC[a] || 'Idle'}${d.battery != null ? ` · ${d.battery}%` : ''}`, a === 'error' ? C.red : a === 'cleaning' ? C.amber : C.stone];
  }
  if (d.type === 'fan') {
    if (!d.on) return ['Off', C.stone];
    if (d.filterLife != null && d.filterLife <= 20) return [`${d.mode || 'On'} · filter ${d.filterLife}%`, C.amber];
    const air = AIR[d.airQuality ?? 0];
    return [[d.mode || 'On', d.mode === 'Manual' && d.fanLevel ? `speed ${d.fanLevel}` : '', air ? `air ${air[0].toLowerCase()}` : ''].filter(Boolean).join(' · '), C.blue];
  }
  if (d.type === 'climate') {
    const m = HVAC.find(h => h[0] === d.hvac), room = d.temp != null ? `${d.room === 'whole_home' ? 'inside' : 'room'} ${d.temp}°` : '';
    return d.on ? [[m?.[1] ?? 'On', d.target != null ? `${d.target}°` : '', room].filter(Boolean).join(' · '), m?.[3] ?? C.blue] : [['Off', room].filter(Boolean).join(' · '), C.stone];
  }
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
  const media = isPlayer(d) || d.type === 'climate';
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
  if (isSensor(d) || d.type === 'camera') return null;
  if (d.type === 'fan') return { on: !d.on };
  if (d.type === 'vacuum') return { on: !d.on };
  if (has(d, 'library')) return d.on ? { paused: !d.paused } : null;
  if (isPlayer(d) && !has(d, 'media')) return { on: !d.on };
  if (isPlayer(d)) return d.on ? { on: false, media: null } : { on: true, media: sources[0]?.name || 'Radio', vol: d.vol ?? 30 };
  return { on: !d.on };
}

/** The Now screen's favourites: the owner's list, or the first few visible lights and plugs. */
export function favourites(s: Pick<Snapshot, 'favourites' | 'devices'>, all: Record<string, Dev>): Dev[] {
  const ids = s.favourites ?? s.devices.filter(d => !d.hidden && !d.archived && !isSensor(d) && (isLight(d) || d.type === 'plug')).slice(0, 4).map(d => d.id);
  return ids.map(id => all[id]).filter((d): d is Dev => !!d && !d.archived);
}

export const TYPES: { id: string; label: string; icon: string; test: (d: Dev) => boolean }[] = [
  { id: 'all', label: 'All', icon: 'apps', test: () => true },
  { id: 'lights', label: 'Lights', icon: 'lightbulb', test: isLight },
  { id: 'media', label: 'Speakers & TV', icon: 'speaker', test: isPlayer },
  { id: 'air', label: 'Air', icon: 'air_purifier', test: d => d.type === 'fan' },
  { id: 'cameras', label: 'Cameras', icon: 'videocam', test: d => d.type === 'camera' },
  { id: 'plugs', label: 'Plugs', icon: 'outlet', test: d => d.type === 'plug' },
  { id: 'vacuum', label: 'Vacuum', icon: 'cleaning_services', test: d => d.type === 'vacuum' },
  { id: 'climate', label: 'Climate', icon: 'ac_unit', test: d => d.type === 'climate' },
  { id: 'other', label: 'Other', icon: 'category', test: d => !['light', 'dimmer', 'media', 'tv', 'fan', 'camera', 'plug', 'vacuum', 'climate'].includes(d.type) },
];

export interface DevGroup { id: string; name: string; icon: string; devices: Dev[]; lightsOn: number }

/**
 * The Devices screen: devices by room in the home's room order (then anything in no room), filtered by
 * room, type and a search over name, room and integration. Hidden devices only when asked for; archived ones never
 * (Customise home → Archived lists them). Sensors never: they only report, and have a screen of their own.
 * Devices that serve the whole home (a ducted air conditioner) come first, under Whole home, never in a room or
 * No room. `zoned`: rooms an air conditioner zone serves, kept even with no devices (the room shows its zone), unless
 * a search or a type other than climate is narrowing the list.
 */
export function groupDevices(all: Dev[], rooms: Room[], f: { room?: string; type?: string; q?: string; showHidden?: boolean; zoned?: string[] }): DevGroup[] {
  const q = (f.q ?? '').trim().toLowerCase();
  const typeTest = TYPES.find(t => t.id === (f.type ?? 'all'))?.test ?? (() => true);
  const roomName = (id: string) => rooms.find(r => r.id === id)?.name ?? (id === 'unassigned' ? 'No room' : id === WHOLE_HOME ? WHOLE_HOME_NAME : id);
  const shown = all.filter(d => !d.archived && !isSensor(d) && (f.showHidden || !d.hidden) && typeTest(d) && (!f.room || f.room === 'all' || d.room === f.room)
    && (!q || `${d.name} ${roomName(d.room)} ${d.integration}`.toLowerCase().includes(q)));
  const keep = new Set(!q && ['all', 'climate'].includes(f.type ?? 'all') ? (f.zoned ?? []).filter(id => !f.room || f.room === 'all' || f.room === id) : []);
  const order = [...(shown.some(d => d.room === WHOLE_HOME) ? [WHOLE_HOME] : []), ...rooms.map(r => r.id), ...new Set(shown.map(d => d.room).filter(id => id !== WHOLE_HOME && !rooms.some(r => r.id === id)))];
  return order.map(id => {
    const devices = shown.filter(d => d.room === id).sort((a, b) => a.name.localeCompare(b.name));
    const icon = rooms.find(r => r.id === id)?.icon ?? (id === WHOLE_HOME ? WHOLE_HOME_ICON : 'category');
    return { id, name: roomName(id), icon, devices, lightsOn: devices.filter(d => isLight(d) && d.on).length };
  }).filter(g => g.devices.length || keep.has(g.id));
}

/** The Devices screen's room pills: every room with something to show (a device, or a zone serving it), Whole home, then No room. */
export function roomPills(all: Pick<Dev, 'room'>[], rooms: Room[], zoned: string[] = []): { id: string; name: string }[] {
  return [
    { id: 'all', name: 'All rooms' },
    ...(all.some(d => d.room === WHOLE_HOME) ? [{ id: WHOLE_HOME, name: WHOLE_HOME_NAME }] : []),
    ...rooms.filter(r => all.some(d => d.room === r.id) || zoned.includes(r.id)),
    ...(all.some(d => d.room === 'unassigned') ? [{ id: 'unassigned', name: 'Other' }] : []),
  ];
}

/** Whether a group's "All off" applies: a room's lights. Never Whole home (that's the air conditioner) or No room. */
export const roomOffApplies = (g: Pick<DevGroup, 'id' | 'lightsOn'>) => g.lightsOn > 0 && g.id !== 'unassigned' && g.id !== WHOLE_HOME;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A device Kova reaches through two integrations, suggested as one (snapshot `combineIdeas`). */
export interface CombineIdea { key: string; name: string; members: string[]; why: string }
/** A device made from several integrations' devices (snapshot `combined`). */
export interface Combined { id: string; name: string; deviceId: string; members: string[]; memberNames: string[] }
export const combineIdeasOf = (s: unknown): CombineIdea[] => (s as { combineIdeas?: CombineIdea[] } | null)?.combineIdeas ?? [];
export const combinedOf = (s: unknown): Combined[] => (s as { combined?: Combined[] } | null)?.combined ?? [];
