import type { HubUpdate } from '../logic/integrations';
// The hub's live snapshot (GET /api/state, and every /api/ws message), as far as the app uses it.
// Source of truth: hub/src/api/snapshot.ts.

export type DeviceType = 'light' | 'dimmer' | 'fan' | 'media' | 'tv' | 'plug' | 'camera' | 'sensor' | 'vacuum' | 'internet' | 'climate';

export interface DeviceState {
  on?: boolean;
  bri?: number | null;
  k?: number | null;
  color?: string | null;
  mode?: string | null;
  media?: string | null;
  paused?: boolean;
  vol?: number | null;
  /** The song playing now, on speakers playing a queue (Helix music). */
  track?: { title: string; artist?: string; album?: string; art?: string } | null;
  /** The queue plays shuffled. */
  shuffle?: boolean;
  /** TV input to switch to: hdmi1..hdmi4 or tv (TVs with `input`). Read back when SmartThings knows the TV, else null. */
  input?: string | null;
  /** Soundbars (`mute`, `sound`): muted, sound mode, night mode. Their input reads back: tv (eARC), hdmi1, hdmi2, bluetooth, wifi. */
  muted?: boolean;
  sound?: string | null;
  night?: boolean;
  power?: number | null;
  energy?: number | null;
  activity?: string;
  battery?: number | null;
  /** Air conditioners (`climate`): cool/heat/dry/fan/auto, the temperature it aims for and the room's (°C), and its fan. */
  hvac?: 'cool' | 'heat' | 'dry' | 'fan' | 'auto' | null;
  target?: number | null;
  temp?: number | null;
  fanSpeed?: 'auto' | 'quiet' | 'low' | 'medium' | 'high' | 'turbo' | null;
  /** Air purifiers (`purifier`): fan speed 1…fanLevelMax, the air (1 good … 4 very poor) and PM2.5, filter left in %, display, child lock. */
  fanLevel?: number | null;
  fanLevelMax?: number;
  airQuality?: number | null;
  pm25?: number | null;
  filterLife?: number | null;
  display?: boolean;
  childLock?: boolean;
  /** Ducted air conditioners (`zones`): each zone's damper, on or off and how far open (0–100). */
  zones?: { n: number; on: boolean; open: number | null; /** The zone's own reading, on systems with a sensor per zone. */ temp?: number | null }[] | null;
  /** Grid power in W from a meter (positive importing, negative exporting) and whole-home use in W. */
  grid?: number | null;
  load?: number | null;
  /** Room humidity % and light level in lux, where a device senses them. */
  humidity?: number | null;
  lux?: number | null;
  /** Switches and readings the integration reports that Kova has no named field for (AC eco, sleep, turbo…), settable by name (`extras`). */
  extras?: Record<string, boolean | number | string | null>;
  /** Motion sensors: moving now. Contact sensors: open. */
  motion?: boolean | null;
  open?: boolean | null;
  /** Server hardware read through its BMC (the router, from Warden): each power supply (a problem while it isn't OK),
   * whether they still back each other up, temperature (°C) and fan (RPM) sensors, and how the fans run. */
  supplies?: { name: string; present?: boolean; ok: boolean; problem?: string | null }[] | null;
  redundancy?: 'full' | 'degraded' | 'lost' | null;
  sensors?: { name: string; kind: 'temp' | 'fan'; value: number; unit: string }[] | null;
  fanMode?: string | null;
  fanPercent?: number | null;
  online?: boolean;
}

/** `skip`: 1 = next song, -1 = previous (speakers with `queue`). `volStep`: 1 = volume up a step, -1 = down. */
export type Command = Partial<DeviceState> & { skip?: number; volStep?: number; /** Some zones of a ducted air conditioner, by number. */ zoneSet?: Record<string, { on?: boolean; open?: number }> };

/** device: something to control; sensor: only reports; camera. (hub util/sensors.ts) */
export type DeviceKind = 'device' | 'sensor' | 'camera';

export interface Device {
  id: string;
  /** Older hubs don't send it: then type 'sensor' is a sensor. */
  kind?: DeviceKind;
  name: string;
  room: string;
  type: DeviceType;
  capabilities: string[];
  adapter: string;
  integration: string;
  address: string;
  state: DeviceState;
  /** What the owner calls a ducted air conditioner's zones, by number. */
  zoneNames?: Record<string, string>;
  /** Ducted air conditioners: the rooms each zone serves, as the owner confirmed them ({ "5": ["office", "guest"] }). */
  zoneRooms?: Record<string, string[]>;
  /** Ducted air conditioners: rooms Kova suggests for named zones not confirmed yet, from their names. */
  zoneSuggest?: Record<string, string[]>;
  hidden?: boolean;
  /** Archived by the owner: out of every list, Ask Kova and alerts; modes leave it alone. Customise home → Archived restores it. */
  archived?: boolean;
  original?: { name: string; room: string };
  why?: { now: string; next: string };
  usedIn?: { kind: string; id: string; name: string }[];
  /** Devices with no meter: the owner's figure for what it draws while on (null: not set) and Kova's typical one. */
  watts?: number | null;
  typicalWatts?: number | null;
  /** Cameras (hub 0.7.58 and later): whether Kova can play its live video. Older hubs don't say. */
  live?: boolean;
  /** Speakers an announcement can play on (type media, can play and set a volume, not a group). */
  canAnnounce?: true;
  /** Speakers: how loud announcements play here, in % of the level asked for (20–200, 100 = as asked). */
  announceTrim?: number;
}

export interface Room { id: string; name: string; icon: string }
export interface PresenceEvidence {
  source: string;
  kind: 'warden' | 'router' | 'ping' | 'app' | 'phone' | 'manual' | 'other';
  home: boolean;
  weight: number;
  reliability: number;
  at: number;
}
export interface Person {
  id: string; name: string; detail: string; home: boolean; since: number | null; sinceLabel: string;
  /** Confidence in the current home/away state, 0–1 (null on older hubs/state). */
  confidence?: number | null;
  confidenceLabel?: string;
  /** The signals behind the latest presence decision, strongest first. */
  evidence?: PresenceEvidence[];
  /** What already tells the hub this person is home without their phone's location (e.g. ['Warden']); empty or missing when nothing does. */
  via?: string[];
}

export interface ModeView {
  id: string; name: string; color: string; icon: string;
  startLabel: string; endLabel: string; nextId: string; start: number | null;
  groups: { room: string; chips: string[] }[];
  test: { days: ('ok' | 'problem' | 'skipped' | 'none')[]; text: string };
  /** When it starts, as the hub keeps it; what it sets; today's moments in it; its behaviours (the mode editor). */
  rhythm?: import('../logic/automations').Rhythm;
  targets?: TargetRow[];
  moments?: { id: string; t: string; text: string }[];
  lightTheWay?: boolean;
  onlyWhenSomeoneHome?: boolean;
}

/** One device a mode, overlay or moment sets: what it's set to, in words and as the command. */
export interface TargetRow { deviceId: string; name: string; label: string; target: Command; missing: boolean }

/** How an overlay ends. */
export type OverlayEnd = { kind: 'manual' } | { kind: 'arrival' } | { kind: 'time'; at: import('../logic/automations').Rhythm } | { kind: 'device_off'; device: string };

/** A one-off timed action ("21:00 rain sounds"). */
export interface MomentView { id: string; label: string; what: string; at: import('../logic/automations').Rhythm; atLabel: string; targets: TargetRow[] }

export interface Finding {
  id: string; modeId: string; kind: string; icon: string; tone: 'alert' | 'check'; title: string; body: string; fix: string; alt: string; done?: string;
  /** Learned from what people do (hubs from 0.7.60): "Not now" puts it off a week (POST …/snooze), `never` dismisses it for good. */
  learned?: boolean; never?: string;
  /** The automation it's about: shown on that automation's own screen too. */
  automationId?: string;
  /** The days it's based on, and what happened each day. */
  evidence?: { day: string; text: string }[];
  /** Other ways to apply it, each fixed by its own id. */
  more?: { id: string; title: string; body: string; fix: string; done?: string }[];
}

/** What Kova has learned (hubs from 0.7.60): every suggestion, with whether it's new, put off or not wanted. */
export interface Learned { on: boolean; items: (Finding & { status: 'new' | 'later' | 'never'; until?: number })[] }

export interface ActivityRow { id: number; ts: number; t: string; type: string; icon: string; what: string; why: string; device?: string | null }

export interface Integration { id: string; name: string; icon: string; kind: string; ok: boolean; note?: string; devices: number; sensors?: number }

export type Trend = 'up' | 'down' | 'steady';
export interface SensorReading { field: string; label: string; value: number | boolean | null; unit: string; text: string; trend: Trend | null; changedAt: number | null; changedLabel: string | null }
/** A sensor as the hub shows it (services/sensors.ts). */
export interface SensorView {
  id: string; name: string; room: string; integration: string; type: DeviceType; kind: string; icon: string; hidden: boolean; outdoor: boolean;
  readings: SensorReading[]; battery: number | null; lowBattery: boolean; online: boolean; seenAt: number | null; seenLabel: string | null; stale: boolean;
}
/** A room's climate and activity, from its sensors and cameras. */
export interface RoomStatus {
  temp: number | null; humidity: number | null; lux: number | null; tempFrom: string[]; outdoor: boolean; active: boolean; occupied: boolean;
  last: { kind: string; at: number; atLabel: string; device: string; what: string } | null; open: string[]; sensors: number;
  /** The air conditioner zones that serve the room (missing on older hubs). */
  zones?: RoomZone[];
}
export type HvacMode = 'cool' | 'heat' | 'dry' | 'fan' | 'auto';
export type FanSpeed = 'auto' | 'quiet' | 'low' | 'medium' | 'high' | 'turbo';
/** One air conditioner zone as a room shows it: the zone, the unit it's on, and a sensible way to turn that unit on for the room (hub util/zones.ts). */
export interface RoomZone {
  device: string; deviceName: string; n: number;
  /** What the owner calls it, else "Zone n". */
  name: string;
  on: boolean; open: number | null; temp: number | null;
  /** Every room the zone serves (this one among them). */
  rooms: string[];
  ac: { on: boolean; hvac: HvacMode | null; target: number | null; temp: number | null; fanSpeed: FanSpeed | null; online: boolean };
  suggest: { hvac: HvacMode; target: number };
}
export type AlertWhen = 'always' | 'away' | 'never';
/** One camera or sensor event, newest first, with its kept picture. */
export interface TimelineEvent { id: number; at: number; t: string; room: string; roomName: string | null; device: string; kind: string; source: 'camera' | 'sensor'; outdoor: boolean; what: string; icon: string; frame: string | null }
export interface SecurityState {
  quiet: { from: string; to: string } | null; cooldownMin: number; rooms: Record<string, Partial<Record<string, AlertWhen>>>; quietNow: boolean; outdoorRooms: string[];
  devices: Record<string, { outdoor: boolean; outdoorSet: boolean; alerts: Record<string, { when: AlertWhen; from: 'device' | 'room' | 'default' }> }>;
  recent: TimelineEvent[];
  decisions: { at: number; atLabel: string; room: string; device: string; kind: string; sent: boolean; why: string; title?: string }[];
}

/** A stream speakers can play by name. `loop`: a recording plays again from the start when it ends. */
export interface MediaSource { name: string; icon: string; url?: string; loop?: boolean }

export type PrayerName = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

/** A clip uploaded to the hub for announcements (`url` is the hub path, /api/clip/<id>.<ext>). */
export interface Clip { id: string; name: string; contentType: string; ext: string; bytes: number; durationMs?: number; added: number; url: string }

/** A built-in public recording of the call to prayer (only while prayer times are on). CC BY-SA: always credit it. */
export interface Adhan {
  id: string; title: string; author: string; licence: string; licenceUrl: string; page: string; durationMs: number; format: string;
  /** False: the hub downloads it on first use. */
  ready: boolean;
}

/** Prayer times, an opt-in part of Kova (Integrations → Prayer times). */
export interface PrayerView {
  on: boolean;
  method: string;
  methods: { id: string; label: string }[];
  /** Asr: standard (Shafi'i, Maliki, Hanbali) or Hanafi (later). */
  madhab: 'shafi' | 'hanafi';
  /** Minutes added to each time (-30 to 30). */
  adjust: Partial<Record<PrayerName, number>>;
  /** The call announcements play by default, and Fajr's own. */
  adhan: { media?: string; fajr?: string };
  /** Only while on: today's times (Unix ms), the latest one passed, and the next one. */
  times?: Record<PrayerName, number>;
  current?: { prayer: PrayerName; at: number };
  next?: { prayer: PrayerName; at: number };
}

/**
 * A part of a speaker group (hubs from 0.7.63): a native group played as one stream ("cast:<id>", "sonos:group"), or a
 * speaker on its own (its device id). The reference is what the others follow; the others have an offset (+ ms
 * earlier, − later) and a learned start delay.
 */
export interface GroupPart {
  key: string; kind: 'native' | 'single'; via: string; name: string; members: string[]; reference: boolean;
  offset: number; latencyMs: number | null; latencyN: number; driftMs: number | null;
  /** A speaker of the reference to listen to this part against. */
  listenWith: string | null;
}

/** What speakers can play as one stream (a Cast group made in Google Home; dynamic: any two or more Sonos speakers). */
export interface NativeGroup { via: string; id: string; name: string; members: string[]; dynamic?: boolean }

export interface SpeakerGroup {
  id: string; name: string; members: string[]; deviceId: string;
  /** perfect: one native group; hybrid: a native group and speakers alongside (hubs from 0.7.63); together: each on its own. */
  sync: 'perfect' | 'hybrid' | 'together'; castGroup: string | null; room?: string; missing?: string[];
  parts?: GroupPart[];
  /** A sync test plays until then (ms). */
  testUntil?: number | null;
}

/** Today's energy (hub services/energy.ts). Watts and kWh; `use` null when nothing meters the home. */
export interface EnergyToday {
  available: boolean;
  now: { solar: number; load: number | null; grid: number | null };
  solarKwh: number;
  usedKwh: number | null;
  fromGridKwh: number | null;
  exportedKwh: number | null;
  hours: { solar: number; use: number | null }[];
  peak: { w: number; hour: number } | null;
  estimated?: boolean;
  devices: { id: string; name: string; w: number; estimated?: true }[];
}

export interface Snapshot {
  home: { name: string; timezone: string; now: number; nowHour: number; date: string; dateLabel: string; clock: string; location?: { latitude: number; longitude: number; radiusM?: number; source?: 'manual' | 'geocode' | 'phone' | 'import' | 'map'; updatedAt?: number | null; /** Google's point (shown on Google's map only) or OpenStreetMap's, from an address search. */ provider?: 'google' | 'osm' }; /** Whether the address search goes through Google. */ maps?: { google: boolean }; prayerMethod?: string; pauseForDoorbell?: boolean; /** The street address chosen in Settings. */ address?: string | null; /** Kova learns from what people do (hubs from 0.7.60; unset: on). */ learnFromYou?: boolean };
  rooms: Room[];
  /** Groups of rooms by name ("Upstairs": room ids), for "turn off upstairs". */
  groups?: Record<string, string[]>;
  favourites: string[] | null;
  speakerGroups: SpeakerGroup[];
  /** What the speakers can play as one stream, for the group editor's note (hubs from 0.7.63). */
  nativeGroups?: NativeGroup[];
  people: Person[];
  devices: Device[];
  /** Sensors with their readings (hubs from 0.7.46). */
  sensors?: SensorView[];
  roomStatus?: Record<string, RoomStatus>;
  security?: SecurityState;
  modes: ModeView[];
  current: { modeId: string; since?: number; until?: number; untilLabel: string; nextId: string; overlay: { id: string; name: string; icon: string; endsLabel: string } | null };
  day: { bands: { modeId: string; start: number; end: number }[] };
  upcoming: { id: string; t: string; label: string; what: string; modeId: string | null; skipped: boolean }[];
  overlays: { id: string; name: string; icon: string; endsLabel: string; ends?: OverlayEnd; allOff?: boolean; targets?: TargetRow[] }[];
  moments?: MomentView[];
  sources: MediaSource[];
  /** Clips uploaded for announcements. */
  clips?: Clip[];
  /** Built-in recordings of the call to prayer (empty while prayer times are off). */
  adhans?: Adhan[];
  /** Prayer times (missing on older hubs, where prayer options always show). */
  prayer?: PrayerView;
  /** Helix music any speaker with `queue` can play: Shuffle all, Loved, playlists. Empty until Helix is paired. */
  music?: { name: string; kind: 'all' | 'loved' | 'playlist'; icon: string; tracks?: number }[];
  findings: Finding[];
  learned?: Learned;
  activity: ActivityRow[];
  /** The engine Ask Kova hands what the built-in parser can't do to (hubs from 0.7.53). */
  assistant?: { kind: 'builtin' | 'local' | 'cloud'; label: string; model?: string; ready?: boolean };
  integrations: Integration[];
  /** The hub's own software updates (null when the hub has no updater). */
  update?: HubUpdate | null;
  weather: { temp: number; text: string; icon: string } | null;
  /** Room ACs for voice assistants and other apps (hubs from 0.7.57). */
  roomClimate?: import('../logic/voice').RoomClimateSnap;
  /** The home at a glance (hub services/insights.ts): outside (with today), inside temperatures, the air. */
  glance?: Glance;
  /** Alerts and warnings worth acting on, most urgent first. */
  insights?: Insight[];
  energy: EnergyToday | null;
  /** The home's clock, "YYYY-MM-DDTHH:MM", for picking a date and time (one-time schedules). */
  localNow?: string;
  demo?: boolean;
  /** Who this phone is signed in as, and what their role may do (household accounts, hubs from 0.7.61). Read it with logic/roles.ts meOf. */
  me?: import('../logic/roles').Me;
}

export interface AskReply {
  text: string;
  source: string;
  actions: { label: string; action: unknown }[];
  undo?: string;
  understood: boolean;
  /** Which engine answered (hubs from 0.7.53). */
  engine?: 'builtin' | 'local' | 'cloud';
  /** Set by the app: this is about a request that didn't get its answer (logic/ask.ts). */
  failed?: boolean;
}

export interface Glance {
  outside: { temp: number; text: string; icon: string; feels?: number; humidity?: number; wind?: number; uv?: number; high?: number; low?: number; uvMax?: number | null; rain?: string | null } | null;
  inside: { name: string; temp: number; humidity?: number; device: string; room?: string }[];
  air: { name: string; level: number; label: string; device: string }[];
}
export interface Insight { id: string; level: 'alert' | 'warning' | 'info'; icon: string; title: string; detail?: string; device?: string }
