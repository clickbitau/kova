// Sensors and what cameras and sensors notice, as the app shows them. Kept free of React Native so the tests can
// run them under plain Node. The hub decides what a sensor is (a device with nothing to control); these only lay out.
import type { AlertWhen, Device, Room, RoomStatus, SecurityState, SensorReading, SensorView, Snapshot, TimelineEvent } from '../api/types';

const C = { amber: '#f2b14c', blue: '#7cb8f0', green: '#7fd4a0', red: '#ff6b5e', stone: '#a3a09a', stone2: '#6f6d69', violet: '#c9a0f0', yellow: '#dcd27e' };

/** A sensor: the hub's kind, or (older hubs) type sensor. */
export const isSensor = (d: Pick<Device, 'kind' | 'type'>) => d.kind ? d.kind === 'sensor' : d.type === 'sensor';
export const isCamera = (d: Pick<Device, 'type'>) => d.type === 'camera';

export const TREND: Record<string, [string, string, string]> = {
  up: ['trending_up', C.amber, 'Rising over the last hour'], down: ['trending_down', C.blue, 'Falling over the last hour'], steady: ['trending_flat', C.stone2, 'Steady'],
};
export const KIND_COLOR: Record<string, string> = { climate: C.blue, motion: C.amber, contact: C.amber, light: C.yellow, air: C.green, energy: C.amber, network: C.green, sound: C.violet, other: C.stone };

export const EV_ICON: Record<string, string> = { person: 'person', motion: 'sensors', ring: 'doorbell', vehicle: 'directions_car', animal: 'pets', package: 'package_2', sound: 'graphic_eq', opened: 'sensor_door', closed: 'sensor_door' };
export const EV_WORD: Record<string, string> = { person: 'A person', motion: 'Motion', ring: 'The doorbell', vehicle: 'A vehicle', animal: 'An animal', package: 'A package', sound: 'A sound', opened: 'Opened', closed: 'Closed' };

/** "just now", "4 min ago", "2 h ago". */
export function ago(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

export interface SensorCard {
  id: string; name: string; icon: string; color: string; live: boolean;
  main: string; mainColor: string; trend: [string, string, string] | null; sub: string; foot: string;
  pills: { icon: string; text: string; color: string }[]; online: boolean; label: string;
}

/** Is this reading "something happening" (motion now, a door open)? */
const lit = (r?: SensorReading) => !!r && (r.field === 'motion' || r.field === 'open') && r.value === true;

/** One sensor as a card: its main reading big, with which way it's heading; the rest below; battery, offline, quiet. */
export function sensorCard(x: SensorView, now = Date.now()): SensorCard {
  const main = x.readings.find(r => r.field !== 'battery') ?? x.readings[0];
  const rest = x.readings.filter(r => r !== main && r.field !== 'battery');
  const color = KIND_COLOR[x.kind] ?? C.stone;
  const live = lit(main);
  const pills = [
    ...(x.online ? [] : [{ icon: 'cloud_off', text: 'Not responding', color: C.red }]),
    ...(x.stale ? [{ icon: 'schedule', text: 'Quiet a while', color: C.amber }] : []),
    ...(x.battery != null ? [{ icon: x.lowBattery ? 'battery_alert' : 'battery_full', text: `${x.battery}%`, color: x.lowBattery ? C.red : C.stone }] : []),
  ];
  const moment = main?.field === 'motion' || main?.field === 'open';
  const foot = [main?.changedLabel ? `${moment ? 'Last' : 'Changed'} ${main.changedLabel}` : '', x.seenAt ? `seen ${ago(x.seenAt, now)}` : ''].filter(Boolean).join(' · ');
  const trend = main?.trend ? TREND[main.trend] ?? null : null;
  return {
    id: x.id, name: x.name, icon: x.icon, color, live, main: main?.text ?? '—', mainColor: live ? color : '#f1efea', trend,
    sub: rest.map(r => r.text).join(' · ') || x.integration, foot, pills, online: x.online,
    label: [x.name, main?.text, ...rest.map(r => `${r.label} ${r.text}`), x.battery != null ? `battery ${x.battery}%` : '', x.online ? '' : 'not responding'].filter(Boolean).join(', '),
  };
}

export interface SensorGroup { id: string; name: string; icon: string; summary: string; cards: SensorCard[] }

/** A room's line: temperature, humidity, what last happened. */
export function roomLine(rs: RoomStatus | undefined, now = Date.now()): string {
  if (!rs) return '';
  return [rs.temp != null ? `${rs.temp}°` : '', rs.humidity != null ? `${Math.round(rs.humidity)}% humidity` : '', rs.last ? `${(EV_WORD[rs.last.kind] ?? rs.last.kind).toLowerCase()} ${ago(rs.last.at, now)}` : '', rs.outdoor ? 'outside' : ''].filter(Boolean).join(' · ');
}

/** Sensors by room, in the home's room order (then no room); hidden ones only when asked. */
export function groupSensors(s: Pick<Snapshot, 'sensors' | 'rooms' | 'roomStatus'>, o: { showHidden?: boolean; now?: number } = {}): SensorGroup[] {
  const shown = (s.sensors ?? []).filter(x => o.showHidden || !x.hidden);
  const order = [...s.rooms.map(r => r.id), ...new Set(shown.map(x => x.room).filter(id => !s.rooms.some(r => r.id === id)))];
  return order.map(id => {
    const xs = shown.filter(x => x.room === id);
    const r = s.rooms.find(q => q.id === id);
    return { id, name: r?.name ?? 'No room', icon: r?.icon ?? 'category', summary: roomLine(s.roomStatus?.[id], o.now), cards: xs.map(x => sensorCard(x, o.now)) };
  }).filter(g => g.cards.length);
}

/** What's worth a look across the sensors: low batteries, not responding, doors open. */
export function sensorFlags(sensors: SensorView[], rooms: Room[]): { icon: string; text: string; color: string }[] {
  const live = sensors.filter(x => !x.hidden);
  const low = live.filter(x => x.lowBattery), off = live.filter(x => !x.online), open = live.filter(x => x.readings.some(r => r.field === 'open' && r.value === true));
  const rn = (id: string) => rooms.find(r => r.id === id)?.name ?? 'no room';
  return [
    ...(low.length ? [{ icon: 'battery_alert', text: low.length === 1 ? `${low[0].name} (${rn(low[0].room)}): battery ${low[0].battery}%` : `${low.length} batteries low`, color: C.red }] : []),
    ...(off.length ? [{ icon: 'cloud_off', text: off.length === 1 ? `${off[0].name} isn’t responding` : `${off.length} sensors not responding`, color: C.red }] : []),
    ...(open.length ? [{ icon: 'sensor_door', text: `${open.map(x => x.name).join(', ')} open`, color: C.amber }] : []),
  ];
}

// ------------------------------------------------------------------ alerts --

export const ALERT_KINDS: [string, string, string][] = [['person', 'People', 'person'], ['ring', 'The doorbell', 'doorbell'], ['package', 'Packages', 'package_2'], ['motion', 'Motion', 'sensors'], ['vehicle', 'Vehicles', 'directions_car'], ['animal', 'Animals', 'pets'], ['sound', 'Sounds', 'graphic_eq'], ['opened', 'Door or window opens', 'sensor_door']];
export const ALERT_WORD: Record<AlertWhen, string> = { always: 'Always', away: 'While nobody’s home', never: 'Never' };

export interface AlertRow { kind: string; label: string; icon: string; value: AlertWhen | ''; note: string }

/** The alert choices a camera or sensor has: which kinds apply to it, its own choice, and where the rest come from. */
export function alertRows(d: Pick<Device, 'id' | 'type' | 'name' | 'integration' | 'state'>, sec: SecurityState | undefined): AlertRow[] {
  const s = sec?.devices[d.id];
  if (!s) return [];
  const cam = d.type === 'camera';
  const bell = /doorbell/i.test(`${d.integration} ${d.name}`);
  const kinds = ALERT_KINDS.filter(([k]) => cam ? k !== 'opened' && (k !== 'ring' || bell) : (k === 'motion' && typeof d.state.motion === 'boolean') || (k === 'opened' && typeof d.state.open === 'boolean'));
  return kinds.map(([kind, label, icon]) => {
    const a = s.alerts[kind] ?? { when: 'never' as AlertWhen, from: 'default' as const };
    const w = ALERT_WORD[a.when].toLowerCase();
    return { kind, label, icon, value: a.from === 'device' ? a.when : '', note: a.from === 'device' ? 'Set for this one' : a.from === 'room' ? `The room’s choice: ${w}` : `Kova’s default: ${w}` };
  });
}

/** Quiet hours in words. */
export function quietText(sec: SecurityState | undefined): string {
  const q = sec?.quiet;
  return q ? `${q.from} to ${q.to}: only the doorbell, and anything while nobody’s home${sec?.quietNow ? ' · on now' : ''}` : 'Off: alerts come any time';
}

/** A decision about an alert, in words: sent, or why not. */
export function decisionText(d: SecurityState['decisions'][number], rooms: Room[]): string {
  const rn = rooms.find(r => r.id === d.room)?.name ?? d.room;
  const what = d.kind === 'ring' ? 'The doorbell' : EV_WORD[d.kind] ?? d.kind;
  return d.sent ? (d.title ?? `${what} · ${rn}`) : `${what} in ${rn}: not sent, ${d.why}`;
}

// -------------------------------------------------------------- timelines --

export interface TimelineRow { key: string; t: string; what: string; where: string; icon: string; color: string; frame: string | null }

export function timelineRows(events: TimelineEvent[]): TimelineRow[] {
  return events.map(e => ({
    key: String(e.id), t: e.t, what: e.what, where: [e.roomName ?? 'No room', e.source === 'sensor' ? 'sensor' : ''].filter(Boolean).join(' · '),
    icon: e.icon || EV_ICON[e.kind] || 'videocam', color: e.kind === 'ring' ? C.blue : e.kind === 'person' ? C.amber : C.green, frame: e.frame,
  }));
}

/** A day of readings as an SVG path, in a w × h box (the area under it closes along the bottom). */
export function sparkPath(points: [number, number][], w: number, h: number): { line: string; area: string; min: number; max: number } | null {
  if (points.length < 2) return null;
  const vs = points.map(p => p[1]), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const t0 = points[0][0], t1 = points[points.length - 1][0], dt = t1 - t0 || 1;
  const xy = points.map(([t, v]) => [((t - t0) / dt) * (w - 4) + 2, h - 4 - ((v - lo) / span) * (h - 10)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${(w - 2).toFixed(1)} ${h} L2 ${h} Z`, min: lo, max: hi };
}

// ---------------------------------------------------------------- security --

export interface SecurityStatus { title: string; sub: string; color: string; icon: string }

/**
 * The top of Security in a few words: what's wrong (the internet, a camera offline), movement while nobody's home,
 * or that all is well; then who's home, the cameras, and quiet hours.
 */
export function securityStatus(x: { people: { name: string; home: boolean }[]; cams: { online?: boolean }[]; rooms: Room[]; roomStatus?: Record<string, RoomStatus>; netDown: boolean; quietNow: boolean }): SecurityStatus {
  const home = x.people.filter(p => p.home);
  const off = x.cams.filter(c => c.online === false).length;
  const busy = x.rooms.filter(r => x.roomStatus?.[r.id]?.occupied && !x.roomStatus?.[r.id]?.outdoor).map(r => r.name);
  const who = !x.people.length ? '' : !home.length ? 'Nobody home' : home.length === x.people.length && home.length > 1 ? 'Everyone home' : `${home.map(p => p.name).join(' and ')} home`;
  const cams = x.cams.length ? `${x.cams.length - off} of ${x.cams.length} camera${x.cams.length === 1 ? '' : 's'} live` : '';
  const sub = [who, cams, x.quietNow ? 'quiet hours' : ''].filter(Boolean).join(' · ');
  if (x.netDown) return { title: 'The internet is down', sub, color: C.red, icon: 'wifi_off' };
  if (off) return { title: off === 1 ? 'A camera is offline' : `${off} cameras are offline`, sub, color: C.red, icon: 'videocam_off' };
  if (x.people.length && !home.length && busy.length) return { title: busy.length === 1 ? `Movement in the ${busy[0]}` : `Movement in ${busy.length} rooms`, sub: `While nobody’s home${cams ? ` · ${cams}` : ''}`, color: C.amber, icon: 'directions_walk' };
  return { title: home.length ? 'All well' : 'All quiet', sub, color: C.green, icon: 'shield' };
}

const WHEN_SHORT: Record<AlertWhen, string> = { always: 'always', away: 'when away', never: 'off' };

/** A room's alert settings in one line: "People: always · Motion: default". */
export function roomAlertLine(sec: Pick<SecurityState, 'rooms'> | undefined, room: string): string {
  const r = sec?.rooms[room] ?? {};
  const w = (k: string) => { const v = r[k]; return v ? WHEN_SHORT[v] : 'default'; };
  return `People: ${w('person')} · Motion: ${w('motion')}`;
}
