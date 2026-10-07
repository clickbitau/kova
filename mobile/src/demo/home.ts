// The demo home: a made-up house the app can run against with no hub at all ("Try the demo" on the first-run
// screen, for anyone without a hub yet and for store reviewers). Modelled on the hub's own demo seed
// (hub/src/seed/demo-home.ts) so every shape matches the real snapshot (api/types.ts), but generic: no real home's
// names or places. Plain TypeScript with no React Native, so the tests run it under Node.
import type { ActivityRow, Command, Device, DeviceState, DeviceType, EnergyToday, Integration, MediaSource, ModeView, Person, Room, Snapshot } from '../api/types.ts';
import type { Action, AutomationView, Condition, Trigger } from '../logic/automations.ts';
import { commandWords, rhythmWords } from '../logic/automations.ts';

export const DEMO_HOME_NAME = 'Demo home';

export const DEMO_ROOMS: Room[] = [
  { id: 'lounge', name: 'Lounge', icon: 'weekend' },
  { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' },
  { id: 'office', name: 'Office', icon: 'desk' },
  { id: 'bedroom', name: 'Bedroom', icon: 'bed' },
  { id: 'kids', name: 'Kids’ room', icon: 'crib' },
  { id: 'laundry', name: 'Laundry', icon: 'local_laundry_service' },
  { id: 'garage', name: 'Garage', icon: 'garage_home' },
  { id: 'front', name: 'Front door', icon: 'door_front' },
];

type Row = [id: string, name: string, room: string, type: DeviceType, integration: string, capabilities: string[], state: DeviceState];
const T = 'Tuya (local)';
const ROWS: Row[] = [
  ['lounge_main', 'Ceiling', 'lounge', 'light', T, ['onoff'], { on: false }],
  ['lounge_down', 'Downlights', 'lounge', 'dimmer', T, ['onoff', 'brightness'], { on: false, bri: 100 }],
  ['lamp', 'Lamp', 'lounge', 'dimmer', 'TP-Link Tapo', ['onoff', 'brightness', 'colorTemp', 'color'], { on: false, bri: 100, k: 2700, color: null }],
  ['lounge_purifier', 'Purifier', 'lounge', 'fan', 'VeSync Levoit', ['onoff', 'fanMode', 'purifier'], { on: true, mode: 'Auto', fanLevel: 2, fanLevelMax: 3, airQuality: 1, pm25: 6, filterLife: 64, display: true, childLock: false }],
  ['lounge_tv', 'TV', 'lounge', 'tv', 'Samsung TV', ['onoff', 'input', 'volume'], { on: false, input: 'tv', vol: 18 }],
  ['lounge_speaker', 'Speaker', 'lounge', 'media', 'Google Cast', ['onoff', 'media', 'volume', 'pause'], { on: false, media: null, vol: 30 }],
  ['lounge_ac', 'Air conditioner', 'lounge', 'climate', 'Hisense ConnectLife', ['onoff', 'climate'], { on: false, hvac: 'cool', target: 23, temp: 24.5, fanSpeed: 'auto' }],
  ['kitchen_ceiling', 'Ceiling', 'kitchen', 'light', T, ['onoff'], { on: false }],
  ['kitchen_island', 'Island', 'kitchen', 'dimmer', T, ['onoff', 'brightness'], { on: false, bri: 80 }],
  ['kitchen_speaker', 'Speaker', 'kitchen', 'media', 'Google Cast', ['onoff', 'media', 'volume', 'pause'], { on: false, media: null, vol: 25 }],
  ['office_light', 'Ceiling', 'office', 'light', T, ['onoff'], { on: false }],
  ['office_strip', 'LED strip', 'office', 'dimmer', 'Tuya', ['onoff', 'brightness', 'color'], { on: false, bri: 60, color: '#7cb8f0' }],
  ['office_plug', 'Desk plug', 'office', 'plug', 'TP-Link Tapo', ['onoff', 'power'], { on: true, power: 42 }],
  ['bedroom_light', 'Ceiling', 'bedroom', 'light', T, ['onoff'], { on: false }],
  ['bedside', 'Bedside lamp', 'bedroom', 'dimmer', 'TP-Link Tapo', ['onoff', 'brightness', 'colorTemp'], { on: false, bri: 40, k: 2200 }],
  ['bedroom_purifier', 'Purifier', 'bedroom', 'fan', 'VeSync Levoit', ['onoff', 'fanMode', 'purifier'], { on: true, mode: 'Sleep', fanLevel: 1, fanLevelMax: 3, airQuality: 1, pm25: 4, filterLife: 18, display: false, childLock: false }],
  ['bedroom_speaker', 'Speaker', 'bedroom', 'media', 'Google Cast', ['onoff', 'media', 'volume', 'pause'], { on: false, media: null, vol: 20 }],
  ['kids_light', 'Ceiling', 'kids', 'light', T, ['onoff'], { on: false }],
  ['kids_nightlight', 'Night light', 'kids', 'dimmer', 'Tuya', ['onoff', 'brightness', 'color'], { on: false, bri: 15, color: '#ffb36b' }],
  ['laundry_light', 'Light', 'laundry', 'light', T, ['onoff'], { on: false }],
  ['washer_plug', 'Washing machine', 'laundry', 'plug', 'TP-Link Tapo', ['onoff', 'power'], { on: true, power: 2 }],
  ['vacuum', 'Robot vacuum', 'kitchen', 'vacuum', 'Ecovacs DEEBOT', ['onoff', 'vacuum', 'battery'], { on: false, activity: 'docked', battery: 100 }],
  ['garage_light', 'Light', 'garage', 'light', T, ['onoff'], { on: false }],
  ['garage_cam', 'Camera', 'garage', 'camera', 'Google Nest', ['events'], { online: true }],
  ['porch', 'Porch light', 'front', 'light', T, ['onoff'], { on: false }],
  ['path', 'Path lights', 'front', 'light', T, ['onoff'], { on: false }],
  ['doorbell', 'Doorbell', 'front', 'camera', 'Google Nest', ['events'], { online: true }],
  ['solar', 'Solar inverter', 'garage', 'sensor', 'GoodWe', ['power', 'energy'], { online: true, power: 0, energy: 0 }],
];

export function demoDevices(): Device[] {
  return ROWS.map(([id, name, room, type, integration, capabilities, state]) => ({
    id, name, room, type, integration, capabilities, adapter: 'demo', address: `demo.${id}`, state: { ...state },
  }));
}

export const DEMO_PEOPLE: Pick<Person, 'id' | 'name' | 'detail'>[] = [
  { id: 'alex', name: 'Alex', detail: 'Pixel' },
  { id: 'sam', name: 'Sam', detail: 'iPhone' },
];

export const DEMO_SOURCES: MediaSource[] = [
  { name: 'Morning radio', icon: 'radio' },
  { name: 'Rain sounds', icon: 'thunderstorm', loop: true },
  { name: 'Jazz stream', icon: 'piano' },
  { name: 'Party mix', icon: 'celebration' },
];

const LIGHTS = ROWS.filter(r => r[3] === 'light' || r[3] === 'dimmer').map(r => r[0]);
const OUTSIDE = ['porch', 'path', 'garage_light'];
type Targets = Record<string, Command>;
const off = (ids: string[]): Targets => Object.fromEntries(ids.map(i => [i, { on: false }]));
const on = (ids: string[]): Targets => Object.fromEntries(ids.map(i => [i, { on: true }]));

/** A mode: when it starts (a local hour, the same every day in the demo) and what it does. */
export interface DemoMode { id: string; name: string; color: string; icon: string; start: number; startLabel: string; targets: Targets }
export const DEMO_MODES: DemoMode[] = [
  { id: 'dawn', name: 'Dawn', color: '#d8a6e0', icon: 'wb_sunny', start: 5, startLabel: 'At first light',
    targets: { kids_nightlight: { on: false }, bedroom_purifier: { mode: 'Auto' } } },
  { id: 'day', name: 'Day', color: '#dcd27e', icon: 'light_mode', start: 6.5, startLabel: 'At sunrise',
    targets: { ...off(OUTSIDE), ...off(['lounge_main', 'lounge_down', 'bedroom_light', 'kids_light']), lounge_purifier: { mode: 'Auto' }, bedroom_purifier: { mode: 'Auto' } } },
  { id: 'evening', name: 'Evening', color: '#f2b14c', icon: 'wb_twilight', start: 18, startLabel: '10 min before sunset',
    targets: { ...on(['porch', 'path', 'kitchen_ceiling', 'lounge_main']), lamp: { on: true, bri: 78, k: 2700, color: null }, lounge_down: { on: true, bri: 60 } } },
  { id: 'wind', name: 'Wind down', color: '#ef8f6e', icon: 'nights_stay', start: 20.5, startLabel: '20:30',
    targets: { ...off(['lounge_main', 'kitchen_ceiling', 'path', 'garage_light', 'office_light']), lamp: { on: true, bri: 25, k: 2200, color: null }, lounge_down: { on: true, bri: 20 }, kids_nightlight: { on: true, bri: 15 } } },
  { id: 'night', name: 'Night', color: '#8aaef0', icon: 'bedtime', start: 23, startLabel: '23:00',
    targets: { ...off(LIGHTS.filter(i => i !== 'kids_nightlight')), lounge_purifier: { mode: 'Sleep' }, bedroom_purifier: { mode: 'Sleep' }, bedroom_speaker: { on: true, media: 'Rain sounds', vol: 15 } } },
];

export interface DemoOverlay { id: string; name: string; icon: string; endsLabel: string; targets: Targets; allOff?: boolean }
export const DEMO_OVERLAYS: DemoOverlay[] = [
  { id: 'movie', name: 'Movie', icon: 'movie', endsLabel: 'Ends when the TV turns off',
    targets: { ...off(['lounge_main', 'kitchen_ceiling', 'kitchen_island']), lamp: { on: true, bri: 8, k: 2200, color: null }, lounge_down: { on: true, bri: 10 }, lounge_tv: { on: true, input: 'hdmi1' }, lounge_purifier: { mode: 'Sleep' } } },
  { id: 'dinner', name: 'Dinner', icon: 'restaurant', endsLabel: 'Ends in 2 hours',
    targets: { kitchen_island: { on: true, bri: 55 }, lamp: { on: true, bri: 40, k: 2700, color: null }, kitchen_speaker: { on: true, media: 'Jazz stream', vol: 20 } } },
  { id: 'party', name: 'Party', icon: 'celebration', endsLabel: 'Ends when you end it',
    targets: { ...on(['lounge_main', 'kitchen_ceiling', 'porch', 'path']), lamp: { on: true, bri: 100, k: null, color: '#0096ff' }, office_strip: { on: true, bri: 100, color: '#ff4fa0' }, lounge_speaker: { on: true, media: 'Party mix', vol: 45 }, kitchen_speaker: { on: true, media: 'Party mix', vol: 40 } } },
  { id: 'good_night', name: 'Good night', icon: 'bedtime', endsLabel: 'Ends at sunrise',
    targets: { ...off(LIGHTS.filter(i => i !== 'bedside' && i !== 'kids_nightlight')), bedside: { on: true, bri: 10, k: 2200 }, lounge_tv: { on: false }, lounge_speaker: { on: false, media: null }, kitchen_speaker: { on: false, media: null } } },
  { id: 'away', name: 'Away', icon: 'flight_takeoff', endsLabel: 'Ends when someone comes home', targets: {}, allOff: true },
];

/** The automations the demo starts with, in the hub's shapes, with their words (the hub writes these). */
export function demoAutomations(now: number): AutomationView[] {
  const ago = (min: number) => now - min * 60_000;
  const run = (min: number, why: string) => ({ at: ago(min), atLabel: clockOf(ago(min)), result: 'done' as const, why, detail: null });
  return [
    { id: 'auto_washing', name: 'Washing’s done', description: 'Tell everyone when the washing machine finishes', enabled: true, mode: 'single',
      triggers: [{ kind: 'numeric', device: 'washer_plug', field: 'power', below: 5, forSec: 120 }], conditions: [],
      actions: [{ kind: 'notify', title: 'Laundry', message: 'The washing’s done' }],
      triggerLabels: ['Washing machine power below 5 W for 2 min'], conditionLabels: [], actionLabels: ['Notify everyone: “The washing’s done”'],
      lastRun: run(190, 'Washing machine power dropped to 2 W'), running: 0 },
    { id: 'auto_last_leaves', name: 'Everything off when we leave', enabled: true, mode: 'single',
      triggers: [{ kind: 'presence', event: 'last-leaves' }], conditions: [],
      actions: [{ kind: 'set', targets: off(LIGHTS) }, { kind: 'overlay', overlay: 'away', op: 'start' }],
      triggerLabels: ['The last person leaves'], conditionLabels: [], actionLabels: [`${LIGHTS.length} lights off`, 'Start Away'],
      lastRun: null, running: 0 },
    { id: 'auto_doorbell', name: 'Doorbell after dark', description: 'Porch light on for 5 minutes', enabled: true, mode: 'restart',
      triggers: [{ kind: 'event', device: 'doorbell', event: 'ring' }], conditions: [{ kind: 'time', after: { kind: 'sun', event: 'sunset' }, before: { kind: 'sun', event: 'sunrise' } }],
      actions: [{ kind: 'set', targets: { porch: { on: true } } }, { kind: 'delay', seconds: 300 }, { kind: 'set', targets: { porch: { on: false } } }],
      triggerLabels: ['The doorbell rings'], conditionLabels: ['Between sunset and sunrise'], actionLabels: ['Porch light on', 'Wait 5 min', 'Porch light off'],
      lastRun: run(60 * 20, 'The doorbell rang'), running: 0 },
    { id: 'auto_hot', name: 'Cool the lounge on hot days', enabled: false, mode: 'single',
      triggers: [{ kind: 'numeric', device: 'lounge_ac', field: 'temp', above: 27 }], conditions: [{ kind: 'presence', who: 'anyone', home: true }],
      actions: [{ kind: 'set', targets: { lounge_ac: { on: true, hvac: 'cool', target: 23 } } }],
      triggerLabels: ['Lounge air conditioner reads above 27°'], conditionLabels: ['Someone is home'], actionLabels: ['Air conditioner on · cool 23°'],
      lastRun: null, running: 0 },
  ];
}

/** Words for an automation the owner made or changed in the demo (the hub has fuller ones; these are enough here). */
export function automationWords(a: { triggers: Trigger[]; conditions: Condition[]; actions: Action[] }, names: Record<string, string>): Pick<AutomationView, 'triggerLabels' | 'conditionLabels' | 'actionLabels'> {
  const n = (id: string) => names[id] ?? id;
  const trig = (t: Trigger): string => {
    switch (t.kind) {
      case 'device': return `${n(t.device)} changes`;
      case 'numeric': return `${n(t.device)} ${t.field}${t.above != null ? ` above ${t.above}` : ''}${t.below != null ? ` below ${t.below}` : ''}`;
      case 'event': return `${n(t.device)}: ${t.event}`;
      case 'time': return rhythmWords(t.at);
      case 'every': return `Every ${t.minutes} min`;
      case 'presence': return t.event === 'last-leaves' ? 'The last person leaves' : t.event === 'first-arrives' ? 'The first person arrives' : `${t.person ? n(t.person) : 'Someone'} ${t.event}`;
      case 'mode': return `${n(t.mode)} starts`;
      case 'overlay': return `${n(t.overlay)} ${t.event}`;
      default: return 'The hub starts';
    }
  };
  const act = (x: Action): string => {
    switch (x.kind) {
      case 'set': return Object.entries(x.targets).map(([id, c]) => `${n(id)} ${commandWords(c)}`).join(', ') || 'Set devices';
      case 'delay': return `Wait ${Math.round(x.seconds / 60) || x.seconds} ${x.seconds >= 60 ? 'min' : 's'}`;
      case 'notify': return `Notify: “${x.message}”`;
      case 'overlay': return `${x.op === 'start' ? 'Start' : 'End'} ${n(x.overlay)}`;
      default: return x.kind[0].toUpperCase() + x.kind.slice(1);
    }
  };
  return { triggerLabels: a.triggers.map(trig), conditionLabels: a.conditions.map(c => c.kind === 'presence' ? 'Someone is home' : c.kind === 'time' ? 'At certain times' : `Only if: ${c.kind}`), actionLabels: a.actions.map(act) };
}

// ------------------------------------------------------------------ time --

const pad = (n: number) => String(n).padStart(2, '0');
export const clockOf = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const hourOf = (t: number) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
const hhmm = (h: number) => `${pad(Math.floor(h) % 24)}:${pad(Math.round((h % 1) * 60))}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The mode in charge at a local hour (modes repeat daily; Night runs past midnight to Dawn). */
export function modeAt(hour: number): DemoMode {
  let m = DEMO_MODES[DEMO_MODES.length - 1];
  for (const x of DEMO_MODES) if (hour >= x.start) m = x;
  return m;
}
const nextMode = (m: DemoMode) => DEMO_MODES[(DEMO_MODES.indexOf(m) + 1) % DEMO_MODES.length];

// ---------------------------------------------------------------- energy --

const SOLAR_PEAK_W = 4200;
/** What the panels make at a local hour on a clear day: a sine from 6:00 to 18:30. */
export const solarAt = (h: number) => (h <= 6 || h >= 18.5 ? 0 : Math.round(SOLAR_PEAK_W * Math.sin((Math.PI * (h - 6)) / 12.5)));
const BASE_W = 260; // fridge, router, the things always on
/** What a device draws now, in watts (the demo's own estimate, like the hub's typical figures). */
export function wattsOf(d: Device): number {
  const s = d.state;
  if (d.type === 'plug') return s.on ? s.power ?? 0 : 0;
  if (d.type === 'sensor' || d.type === 'camera') return d.type === 'camera' ? 4 : 0;
  if (!s.on) return d.type === 'tv' || d.type === 'media' ? 1 : 0;
  switch (d.type) {
    case 'light': return 9;
    case 'dimmer': return Math.max(1, Math.round(10 * (s.bri ?? 100) / 100));
    case 'fan': return s.mode === 'Sleep' ? 6 : 22;
    case 'tv': return 95;
    case 'media': return s.media ? 12 : 3;
    case 'climate': return 1250;
    case 'vacuum': return s.activity === 'cleaning' ? 45 : 3;
    default: return 0;
  }
}

/** Today so far: solar from the curve, use from a base load plus what's on now (earlier hours from a typical day). */
export function demoEnergy(devices: Device[], now: number): EnergyToday {
  const h = hourOf(now);
  const loadNow = BASE_W + devices.reduce((n, d) => n + wattsOf(d), 0);
  const typical = (hr: number) => BASE_W + (hr >= 6 && hr < 8 ? 900 : hr >= 17 && hr < 22 ? 1100 : hr >= 8 && hr < 17 ? 350 : 120);
  const hours = Array.from({ length: 24 }, (_, hr) => {
    if (hr > Math.floor(h)) return { solar: 0, use: null as number | null };
    const share = hr === Math.floor(h) ? h - hr : 1;
    const solar = (solarAt(hr + 0.5) / 1000) * share;
    const use = ((hr === Math.floor(h) ? loadNow : typical(hr)) / 1000) * share;
    return { solar: Math.round(solar * 100) / 100, use: Math.round(use * 100) / 100 };
  });
  const solarKwh = hours.reduce((n, x) => n + x.solar, 0);
  const usedKwh = hours.reduce((n, x) => n + (x.use ?? 0), 0);
  const fromGridKwh = hours.reduce((n, x) => n + Math.max(0, (x.use ?? 0) - x.solar), 0);
  const exportedKwh = hours.reduce((n, x) => n + Math.max(0, x.solar - (x.use ?? 0)), 0);
  const solarNow = solarAt(h);
  let peak: EnergyToday['peak'] = null;
  hours.forEach((x, hr) => { const w = Math.round(x.solar * 1000); if (w > 0 && (!peak || w > peak.w)) peak = { w, hour: hr }; });
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    available: true,
    estimated: true,
    now: { solar: solarNow, load: loadNow, grid: loadNow - solarNow },
    solarKwh: r1(solarKwh), usedKwh: r1(usedKwh), fromGridKwh: r1(fromGridKwh), exportedKwh: r1(exportedKwh),
    hours, peak,
    devices: devices.map(d => ({ id: d.id, name: `${DEMO_ROOMS.find(r => r.id === d.room)?.name ?? ''} ${d.name.toLowerCase()}`.trim(), w: wattsOf(d), ...(d.type === 'plug' ? {} : { estimated: true as const }) }))
      .filter(x => x.w >= 5).sort((a, b) => b.w - a.w).slice(0, 6),
  };
}

// -------------------------------------------------------------- the state --

/** Everything the demo hub keeps; the snapshot is worked out from it. */
export interface DemoState {
  name: string;
  pauseForDoorbell: boolean;
  prayerMethod: string;
  rooms: Room[];
  devices: Device[];
  people: { id: string; name: string; detail: string; home: boolean; since: number }[];
  favourites: string[] | null;
  /** The mode the plan last applied (so a change of mode as time passes is noticed and applied). */
  modeId: string;
  overlay: { id: string; since: number } | null;
  skipped: string[];
  automations: AutomationView[];
  findingsDismissed: string[];
  insightsSnoozed: string[];
  activity: ActivityRow[];
  nextActivity: number;
}

export function applyTargets(devices: Device[], targets: Targets): string[] {
  const changed: string[] = [];
  for (const d of devices) {
    const c = targets[d.id];
    if (!c) continue;
    d.state = applyCommand(d, c);
    changed.push(d.id);
  }
  return changed;
}

/** A command applied to a device's state, the way a real device would end up. */
export function applyCommand(d: Device, c: Command): DeviceState {
  const { skip, volStep, zoneSet, ...rest } = c;
  const s: DeviceState = { ...d.state, ...rest };
  if (volStep) s.vol = Math.max(0, Math.min(100, (s.vol ?? 30) + volStep * 5));
  if (skip) s.track = null;
  if (zoneSet) { /* the demo has no ducted air conditioner */ }
  if (d.type === 'media' && rest.on === false) { s.media = null; s.paused = false; }
  if (d.type === 'vacuum' && rest.on !== undefined) { s.activity = rest.on ? 'cleaning' : 'returning'; }
  if (d.type === 'plug' && rest.on !== undefined) s.power = rest.on ? (d.id === 'washer_plug' ? 2 : 42) : 0;
  if (d.type === 'fan' && rest.mode && rest.on === undefined) s.on = true;
  return s;
}

export function initialState(now: number): DemoState {
  const devices = demoDevices();
  const h = hourOf(now);
  const mode = modeAt(h);
  // Where the day's modes would have left things, then a few things people turned on themselves.
  for (const m of [...DEMO_MODES.filter(x => x.start <= h), ...(h < DEMO_MODES[0].start ? [DEMO_MODES[DEMO_MODES.length - 1]] : [])]) applyTargets(devices, m.targets);
  if (h >= 7 && h < 18) applyTargets(devices, { office_light: { on: true }, office_strip: { on: true }, kitchen_island: { on: true, bri: 70 }, kitchen_speaker: { on: true, media: 'Morning radio', vol: 22 } });
  if (h >= 18 && h < 23) applyTargets(devices, { lounge_tv: { on: true, input: 'tv' } });
  const people = DEMO_PEOPLE.map((p, i) => ({ ...p, home: i === 0 || !(h >= 8.5 && h < 17), since: now - (i === 0 ? 95 : 40) * 60_000 }));
  const st: DemoState = {
    name: DEMO_HOME_NAME, pauseForDoorbell: true, prayerMethod: 'MuslimWorldLeague', rooms: DEMO_ROOMS.map(r => ({ ...r })), devices, people,
    favourites: ['lamp', 'kitchen_island', 'lounge_tv', 'porch'], modeId: mode.id, overlay: null, skipped: [],
    automations: demoAutomations(now), findingsDismissed: [], insightsSnoozed: [], activity: [], nextActivity: 1,
  };
  // A morning's worth of history.
  const past: [number, ActivityRow['type'], string, string, string, string?][] = [
    [190, 'auto', 'notifications', 'Washing’s done', 'Washing machine power dropped to 2 W'],
    [140, 'people', 'person_pin_circle', `${people[1].name} left`, 'Their phone left home'],
    [95, 'auto', 'light_mode', `${mode.name} mode`, 'The plan for today', undefined],
    [60, 'device', 'lightbulb', 'Office ceiling on', 'Tapped in the app', 'office_light'],
    [35, 'people', 'doorbell', 'Doorbell: someone at the door', 'Front door camera saw a person', 'doorbell'],
    [12, 'device', 'speaker', 'Kitchen speaker playing Morning radio', 'Asked Kova', 'kitchen_speaker'],
  ];
  for (const [min, type, icon, what, why, device] of past) log(st, now - min * 60_000, type, icon, what, why, device);
  return st;
}

export function log(st: DemoState, ts: number, type: ActivityRow['type'], icon: string, what: string, why: string, device?: string): void {
  st.activity.unshift({ id: st.nextActivity++, ts, t: clockOf(ts), type, icon, what, why, device: device ?? null });
  st.activity.sort((a, b) => b.ts - a.ts);
  if (st.activity.length > 60) st.activity.length = 60;
}

const roomName = (st: DemoState, id: string) => st.rooms.find(r => r.id === id)?.name ?? 'No room';
export const deviceLabel = (st: DemoState, d: Device) => `${roomName(st, d.room)} ${d.name.toLowerCase()}`;

/** A target in words, as a mode's chips show it: "Lamp 78% · 2700K", "Porch light on". */
function chip(d: Device | undefined, c: Command): string {
  const name = d?.name ?? 'Device';
  if (c.media) return `${name} · ${c.media}${c.vol != null ? ` ${c.vol}%` : ''}`;
  if (c.mode && c.on === undefined) return `${name} on ${c.mode}`;
  if (c.on === false) return `${name} off`;
  if (c.on === true && Object.keys(c).length === 1) return `${name} on`;
  if (c.bri != null) return `${name} ${c.bri}%${c.k ? ` · ${c.k}K` : ''}`;
  return `${name} ${commandWords(c) || 'on'}`;
}

/** A plan in a few words, as the hub's "what's next" says it: "4 lights on, Lounge lamp 78%, purifiers to Sleep". */
export function planWords(st: DemoState, targets: Targets): string {
  const parts: string[] = [];
  const entries = Object.entries(targets).map(([id, c]) => [st.devices.find(d => d.id === id), c] as const);
  const plain = (on: boolean) => entries.filter(([d, c]) => d && (d.type === 'light' || d.type === 'dimmer') && c.on === on && c.bri == null).length;
  const n = (k: number, what: string) => `${k} light${k === 1 ? '' : 's'} ${what}`;
  if (plain(true)) parts.push(n(plain(true), 'on'));
  if (plain(false)) parts.push(n(plain(false), 'off'));
  const fans = entries.filter(([d, c]) => d?.type === 'fan' && c.mode);
  if (fans.length) parts.push(`purifiers to ${fans[0][1].mode}`);
  for (const [d, c] of entries) {
    if (!d || (d.type === 'fan' && c.mode) || ((d.type === 'light' || d.type === 'dimmer') && c.bri == null && c.on !== undefined)) continue;
    parts.push(chip({ ...d, name: deviceLabel(st, d).replace(/^./, x => x.toUpperCase()) }, c));
  }
  return parts.length > 4 ? `${parts.slice(0, 4).join(', ')} and more` : parts.join(', ');
}

function modeView(st: DemoState, m: DemoMode): ModeView {
  const groups: ModeView['groups'] = [];
  for (const [id, c] of Object.entries(m.targets)) {
    const d = st.devices.find(x => x.id === id);
    const room = d ? roomName(st, d.room) : 'Other';
    let g = groups.find(x => x.room === room);
    if (!g) groups.push(g = { room, chips: [] });
    g.chips.push(chip(d, c));
  }
  const next = nextMode(m);
  return {
    id: m.id, name: m.name, color: m.color, icon: m.icon, startLabel: m.startLabel, endLabel: next.startLabel, nextId: next.id, start: m.start, groups,
    test: { days: Array.from({ length: 14 }, (_, i) => (i === 9 && m.id === 'evening' ? 'problem' : 'ok')), text: m.id === 'evening' ? 'Ran as planned 13 of the last 14 days. Once the porch light didn’t answer.' : 'Ran as planned every day for the last 2 weeks.' },
  };
}

const INTEGRATIONS: Integration[] = [
  { id: 'tuya', name: 'Tuya', icon: 'lightbulb', kind: 'Local', ok: true, note: '14 devices on the home network', devices: 14 },
  { id: 'tapo', name: 'TP-Link Tapo', icon: 'outlet', kind: 'Local', ok: true, note: '4 devices', devices: 4 },
  { id: 'cast', name: 'Google Cast', icon: 'cast', kind: 'Local', ok: true, note: '3 speakers', devices: 3 },
  { id: 'nest', name: 'Google Nest', icon: 'videocam', kind: 'Cloud', ok: true, note: 'Doorbell and 1 camera', devices: 2 },
  { id: 'vesync', name: 'VeSync', icon: 'air_purifier', kind: 'Cloud', ok: true, note: '2 purifiers', devices: 2 },
  { id: 'smartthings', name: 'SmartThings', icon: 'tv', kind: 'Cloud', ok: true, note: 'Lounge TV', devices: 1 },
  { id: 'connectlife', name: 'ConnectLife', icon: 'ac_unit', kind: 'Cloud', ok: true, note: '1 air conditioner', devices: 1 },
  { id: 'ecovacs', name: 'Ecovacs', icon: 'cleaning_services', kind: 'Cloud', ok: true, note: 'Robot vacuum', devices: 1 },
  { id: 'goodwe', name: 'GoodWe solar', icon: 'solar_power', kind: 'Local', ok: true, note: 'Inverter on the home network', devices: 1 },
];

/** Work out the live snapshot from the demo state at `now`, the same shape GET /api/state gives. */
export function buildSnapshot(st: DemoState, now: number): Snapshot & Record<string, unknown> {
  const d = new Date(now);
  const h = hourOf(now);
  const mode = modeAt(h);
  const next = nextMode(mode);
  const solar = st.devices.find(x => x.id === 'solar');
  const energy = demoEnergy(st.devices, now);
  if (solar) solar.state = { ...solar.state, power: energy.now.solar, energy: energy.solarKwh };
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ov = st.overlay ? DEMO_OVERLAYS.find(o => o.id === st.overlay!.id) ?? null : null;
  const upcoming: Snapshot['upcoming'] = [];
  for (let i = 1; upcoming.length < 3 && i <= DEMO_MODES.length; i++) {
    const m = DEMO_MODES[(DEMO_MODES.indexOf(mode) + i) % DEMO_MODES.length];
    const id = `mode:${m.id}@${date}`;
    upcoming.push({ id, t: hhmm(m.start), label: m.name, what: planWords(st, m.targets), modeId: m.id, skipped: st.skipped.includes(id) });
  }
  const bands: Snapshot['day']['bands'] = [];
  bands.push({ modeId: DEMO_MODES[DEMO_MODES.length - 1].id, start: 0, end: DEMO_MODES[0].start });
  DEMO_MODES.forEach((m, i) => bands.push({ modeId: m.id, start: m.start, end: DEMO_MODES[i + 1]?.start ?? 24 }));
  const people: Person[] = st.people.map(p => ({
    ...p, sinceLabel: clockOf(p.since), confidence: 0.95, confidenceLabel: 'Sure',
    evidence: [{ source: p.home ? 'Home Wi-Fi' : 'Phone location', kind: p.home ? 'router' : 'app', home: p.home, weight: 1, reliability: 0.95, at: p.since }],
    via: ['Your router'],
  }));
  const purifiers = st.devices.filter(x => x.type === 'fan');
  const ac = st.devices.find(x => x.id === 'lounge_ac');
  const findings = [
    { id: 'stays-on:kitchen_island:night', modeId: 'night', kind: 'Check', icon: 'lightbulb', tone: 'check' as const, title: 'Kitchen island can stay on all night',
      body: 'Nothing turns it off in Wind down or Night, so if someone leaves it on it stays on until morning.', fix: 'Turn it off at Night', alt: 'Keep it as is', done: 'Night turns the island off now' },
  ].filter(f => !st.findingsDismissed.includes(f.id));
  const bedroomPurifier = st.devices.find(x => x.id === 'bedroom_purifier');
  const insights = [
    ...(bedroomPurifier && (bedroomPurifier.state.filterLife ?? 100) <= 20 ? [{ id: 'filter:bedroom_purifier', level: 'warning' as const, icon: 'air_purifier', title: 'Bedroom purifier filter is at 18%', detail: 'Replace it soon to keep the air clean.', device: 'bedroom_purifier' }] : []),
  ].filter(i => !st.insightsSnoozed.includes(i.id));
  const devices: Device[] = st.devices.map(x => ({
    ...x, state: { ...x.state }, typicalWatts: x.type === 'plug' || x.type === 'sensor' ? undefined : wattsOf({ ...x, state: { ...x.state, on: true } }) || null,
    why: { now: 'Demo home: change it and see what happens.', next: (() => { const m = DEMO_MODES.find(mm => mm.targets[x.id] && DEMO_MODES.indexOf(mm) >= 0 && mm.start > h); return m ? `${hhmm(m.start)} · ${m.name}: ${chip(x, m.targets[x.id])}.` : 'Nothing scheduled.'; })() },
    usedIn: DEMO_MODES.filter(m => m.targets[x.id]).map(m => ({ kind: 'mode', id: m.id, name: `${m.name} mode` })),
  }));
  return {
    home: {
      name: st.name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', now, nowHour: h, date,
      dateLabel: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, clock: clockOf(now),
      location: { latitude: 0, longitude: 0 }, prayerMethod: st.prayerMethod, pauseForDoorbell: st.pauseForDoorbell,
    },
    rooms: st.rooms.map(r => ({ ...r })),
    favourites: st.favourites ? [...st.favourites] : null,
    speakerGroups: [],
    people,
    devices,
    modes: DEMO_MODES.map(m => modeView(st, m)),
    current: {
      modeId: mode.id, untilLabel: hhmm(next.start), nextId: next.id,
      overlay: ov ? { id: ov.id, name: ov.name, icon: ov.icon, endsLabel: ov.endsLabel } : null,
    },
    day: { bands },
    upcoming,
    overlays: DEMO_OVERLAYS.map(o => ({ id: o.id, name: o.name, icon: o.icon, endsLabel: o.endsLabel })),
    sources: DEMO_SOURCES.map(s => ({ ...s })),
    music: [],
    findings,
    activity: st.activity.map(a => ({ ...a })),
    integrations: INTEGRATIONS.map(i => ({ ...i })),
    update: null,
    weather: { temp: Math.round(17 + 8 * Math.sin((Math.PI * (h - 8)) / 14)), text: 'Partly cloudy', icon: 'partly_cloudy_day' },
    glance: {
      outside: { temp: Math.round(17 + 8 * Math.sin((Math.PI * (h - 8)) / 14)), text: 'Partly cloudy', icon: 'partly_cloudy_day', high: 25, low: 13, humidity: 48, wind: 12, uvMax: 6 },
      inside: ac?.state.temp != null ? [{ name: 'Lounge', temp: ac.state.temp, device: ac.id }] : [],
      air: purifiers.map(p => ({ name: roomName(st, p.room), level: p.state.airQuality ?? 1, label: p.state.airQuality === 1 ? 'Good' : 'Moderate', device: p.id })),
    },
    insights,
    energy,
    demo: true,
    automations: st.automations.map(a => ({ ...a })),
    automationIdeas: [],
    combined: [],
    combineIdeas: [],
  };
}

/** Apply a mode's plan when the clock reaches it (the demo's stand-in for the hub's engine). Returns true on a change. */
export function followPlan(st: DemoState, now: number): boolean {
  const m = modeAt(hourOf(now));
  if (m.id === st.modeId) return false;
  st.modeId = m.id;
  const id = `mode:${m.id}@${new Date(now).toISOString().slice(0, 10)}`;
  if (st.skipped.includes(id) || st.overlay) { log(st, now, 'auto', m.icon, `${m.name} mode`, st.overlay ? 'Kept what the overlay set' : 'Skipped today'); return true; }
  applyTargets(st.devices, m.targets);
  log(st, now, 'auto', m.icon, `${m.name} mode`, 'The plan for today');
  return true;
}
