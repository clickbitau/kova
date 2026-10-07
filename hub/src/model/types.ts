// Kova's domain model. Everything in the hub speaks these types; adapters
// translate brand-specific protocols into and out of them.

/**
 * What kind of thing a device is. Drives which capabilities it has. `internet` is a device's internet access (on = allowed),
 * from the router. `climate` is an air conditioner, heat pump or thermostat.
 */
export type DeviceType = 'light' | 'dimmer' | 'fan' | 'media' | 'tv' | 'plug' | 'camera' | 'sensor' | 'vacuum' | 'internet' | 'climate';

/** What an air conditioner or heat pump is doing when it's on. */
export type HvacMode = 'cool' | 'heat' | 'dry' | 'fan' | 'auto';
/** Its fan, from quietest to strongest; `auto` lets the unit choose. */
export type FanSpeed = 'auto' | 'quiet' | 'low' | 'medium' | 'high' | 'turbo';

/**
 * Normalised device state. Every field is optional because devices only carry
 * the capabilities they have. Units are fixed across brands:
 * bri 0–100, k in Kelvin, color as #rrggbb, vol 0–100, power in watts.
 */
export interface DeviceState {
  on?: boolean;
  bri?: number | null;
  k?: number | null;
  color?: string | null;
  /** Fan / purifier mode, e.g. "Auto", "Sleep". */
  mode?: string | null;
  /** Name of the media source playing, or null when idle. Players with the `library` capability also take a title to find and play. */
  media?: string | null;
  /** Playback is paused (players with the `pause` capability). `on` stays true while paused. */
  paused?: boolean;
  vol?: number | null;
  /** The song playing now, on speakers that play a queue (Helix music): read back from the speaker. */
  track?: Track | null;
  /** The queue plays in a shuffled order (Kova shuffles it). */
  shuffle?: boolean;
  /**
   * Input to switch to (devices with the `input` capability). TVs: "hdmi1".."hdmi4" or "tv", not read back from the TV,
   * so it stays null. Soundbars: "tv" (the TV's eARC/optical), "hdmi1", "hdmi2", "bluetooth", "wifi", read back.
   */
  input?: string | null;
  /** Sound is muted (devices with the `mute` capability). */
  muted?: boolean;
  /** Soundbar sound mode, e.g. "standard", "surround", "game", "adaptive" (the `sound` capability). */
  sound?: string | null;
  /** Soundbar night mode: quieter loud parts (the `sound` capability). */
  night?: boolean;
  power?: number | null;
  /** Energy produced (inverters) or used today, in kWh. */
  energy?: number | null;
  /** Grid power in W from a meter: positive = importing, negative = exporting. */
  grid?: number | null;
  /** Whole-home consumption in W, when a meter or hybrid inverter reports it. */
  load?: number | null;
  /** Robot vacuum: what it's doing. `on` is true while cleaning. */
  activity?: VacuumActivity;
  /** Battery charge 0–100. */
  battery?: number | null;
  /** Climate (the `climate` capability): what it's doing when on, the temperature it aims for and the room's, in °C, and its fan. */
  hvac?: HvacMode | null;
  target?: number | null;
  temp?: number | null;
  /** Room humidity % where the device senses it. */
  humidity?: number | null;
  /** Light level in lux where a device senses it. */
  lux?: number | null;
  /** Motion or occupancy sensors: someone (or something) is moving there now. */
  motion?: boolean | null;
  /** Door and window contact sensors: open (true) or closed (false). */
  open?: boolean | null;
  fanSpeed?: FanSpeed | null;
  /** Air purifiers (the `purifier` capability): fan speed 1…fanLevelMax (setting one switches to manual), the air as the
   * purifier rates it (1 good … 4 very poor) and its PM2.5 reading, filter life left in %, and its display and child lock. */
  fanLevel?: number | null;
  fanLevelMax?: number;
  airQuality?: number | null;
  pm25?: number | null;
  filterLife?: number | null;
  display?: boolean;
  childLock?: boolean;
  /** Ducted air conditioners (the `zones` capability): each zone's damper, on or off and how far open (0–100). */
  zones?: Zone[] | null;
  /** Switches and readings the integration reports that Kova has no named field for yet — AC eco/sleep/turbo
   * modes and the like — kept and settable by name (the `extras` capability). */
  extras?: Record<string, boolean | number | string | null>;
  online?: boolean;
}

/** One song in a play queue: what a speaker fetches, and what Kova shows. */
export interface Track { title: string; artist?: string; album?: string; art?: string; durationMs?: number; /** The song's id where it came from (Helix: helix:…), for counting plays. */ id?: string }

export type VacuumActivity = 'cleaning' | 'returning' | 'docked' | 'paused' | 'idle' | 'error';

export type Capability = 'onoff' | 'brightness' | 'colorTemp' | 'color' | 'fanMode' | 'media' | 'volume' | 'power' | 'energy' | 'events' | 'vacuum' | 'battery' | 'pause' | 'library' | 'input' | 'queue' | 'mute' | 'sound' | 'climate' | 'zones' | 'purifier' | 'extras';

export interface Device {
  id: string;
  name: string;
  room: string;
  type: DeviceType;
  capabilities: Capability[];
  /** Adapter that owns this device. */
  adapter: string;
  /** Human-readable integration label, e.g. "Sonos", "Tuya (local)". */
  integration: string;
  /** Stable address inside the adapter (IP, Matter node id, HA-style alias…). */
  address: string;
  state: DeviceState;
  /** Hidden by the owner: kept working, left out of everyday lists. */
  hidden?: boolean;
  /** The name and room the integration gave it, when the owner has changed them. */
  original?: { name: string; room: string };
}

/** When an alert about a camera or sensor event goes to phones: always, only while nobody's home, or never. */
export type AlertWhen = 'always' | 'away' | 'never';
/** Something a camera saw or a sensor noticed in a room. */
export type RoomEventKind = 'person' | 'motion' | 'ring' | 'vehicle' | 'animal' | 'package' | 'sound' | 'opened' | 'closed';
/** Per kind of event, when to alert (unset kinds use the room's, then Kova's defaults). */
export type AlertPrefs = Partial<Record<RoomEventKind, AlertWhen>>;

/** What the owner changed about a device: a better name, the right room, or hidden from lists. */
export interface DeviceSettings {
  name?: string; room?: string; hidden?: boolean;
  /** Cameras and sensors: it looks at (or sits) outside, not inside the home. Unset: from the room, and doorbells are outside. */
  outdoor?: boolean;
  /** Cameras and sensors: when their events alert phones. */
  alerts?: AlertPrefs;
  /** What it draws while on, in W, for the Energy page (devices with no meter). */
  watts?: number;
  /** Ducted air conditioners: what the owner calls each zone, by zone number ("1": "Living"). */
  zoneNames?: Record<string, string>;
}

/**
 * A partial state change requested of a device. Momentary, never kept as state: `skip` 1 = next track, -1 = previous
 * (players with `queue`); `volStep` +1 = volume up a step, -1 = down (devices with `volume`).
 */
export type Command = Partial<DeviceState> & {
  skip?: number; volStep?: number;
  /** Change some zones of a ducted air conditioner, by zone number: on or off, and how far open. */
  zoneSet?: Record<string, { on?: boolean; open?: number }>;
};

/** One zone of a ducted air conditioner, numbered as the unit numbers them. */
export interface Zone { n: number; on: boolean; open: number | null }

/** Why something happened. Attached to every state change and log entry. */
export interface Cause {
  kind: 'mode' | 'moment' | 'overlay' | 'behaviour' | 'user' | 'device' | 'presence' | 'system' | 'undo' | 'assistant' | 'automation';
  /** Id of the mode / overlay / behaviour / person that caused it. */
  id?: string;
  /** Short human label: "Evening started", "Light the way". */
  label: string;
  /** Optional extra: "doorbell camera saw someone". */
  detail?: string;
}

export interface Room {
  id: string;
  name: string;
  icon: string;
  /** Outside the living space (a porch, a yard, the garage): what happens there isn't someone inside. Unset: from its icon. */
  outdoor?: boolean;
}

/** Material Symbols icons a room can have — offered wherever a room is made or renamed. */
export const ROOM_ICONS = ['weekend', 'kitchen', 'desk', 'bed', 'single_bed', 'crib', 'music_note', 'local_laundry_service', 'garage_home', 'door_front', 'yard', 'bathtub', 'stairs', 'meeting_room', 'chair', 'tv', 'deck', 'balcony', 'fitness_center', 'checkroom'];

export interface Person {
  id: string;
  name: string;
  /** Which device reports presence, shown in the UI ("iPhone Air"). */
  detail: string;
}

/** `camera`: an indoor camera saw someone moving (a weak hint that someone's in, never who). */
export type PresenceSourceKind = 'warden' | 'router' | 'ping' | 'app' | 'phone' | 'manual' | 'camera' | 'other';

/** One signal that helped decide whether someone is home. */
export interface PresenceEvidence {
  /** Human label, e.g. "Router (Warden)" or "Kova app (location)". */
  source: string;
  /** Source family, used for per-person learning. */
  kind: PresenceSourceKind;
  home: boolean;
  /** Effective vote strength after the learned source reliability. */
  weight: number;
  /** Learned reliability for this source/person, 0–1. */
  reliability: number;
  at: number;
}

export interface PersonState {
  home: boolean;
  since: number;
  /** Confidence in `home`, 0–1. */
  confidence?: number;
  /** The signals behind the latest decision, strongest first. */
  evidence?: PresenceEvidence[];
}

// ---------------------------------------------------------------- rhythms --

/**
 * A Rhythm is a time of day that can move: a fixed clock time, a sun event,
 * or a prayer time. Modes, moments and overlay endings are all anchored to one.
 */
export type Rhythm =
  | { kind: 'time'; at: string }
  | { kind: 'sun'; event: 'sunrise' | 'sunset' | 'dawn' | 'dusk'; offsetMin?: number }
  | { kind: 'prayer'; prayer: 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'; offsetMin?: number };

// ------------------------------------------------------------------ modes --

/** Target states for a set of devices, keyed by device id. */
export type Targets = Record<string, Command>;

/** One of the time-of-day states the home moves through. */
export interface Mode {
  id: string;
  name: string;
  color: string;
  icon: string;
  start: Rhythm;
  targets: Targets;
  /** Only switch things on when at least one person is home. */
  onlyWhenSomeoneHome?: boolean;
  /** Whether the Light the way behaviour runs during this mode. */
  lightTheWay?: boolean;
}

/** A one-off timed action ("21:00 rain sounds"). Shown inside whichever mode it falls in. */
export interface Moment {
  id: string;
  label: string;
  what: string;
  at: Rhythm;
  targets: Targets;
}

export type OverlayEnd =
  | { kind: 'manual' }
  | { kind: 'time'; at: Rhythm }
  | { kind: 'device_off'; device: string }
  | { kind: 'arrival' };

/** A temporary state layered on top of the current mode, e.g. Movie or Away. */
export interface Overlay {
  id: string;
  name: string;
  icon: string;
  endsLabel: string;
  targets: Targets;
  /** When true, every light and media player not in targets is switched off. */
  allOff?: boolean;
  ends: OverlayEnd;
  /** Start by itself on a device event ("Movie starts when the lounge Helix plays a film"). */
  startsOn?: { device: string; event: string };
}

export interface LightTheWayTrigger {
  id: string;
  /** A device event (camera person, doorbell ring) or someone arriving. */
  on: { device: string; event: string } | { arrival: true };
  label: string;
  lights: string[];
  minutes: number;
}

// ------------------------------------------------------------ automations --

/**
 * A device's state to match: every field given has to hold. `playing` is a player that's on and not paused.
 * Unknown on/off counts as off; unknown online counts as online.
 */
export interface StateMatch {
  on?: boolean;
  online?: boolean;
  input?: string;
  hvac?: HvacMode;
  activity?: VacuumActivity;
  playing?: boolean;
  muted?: boolean;
  mode?: string;
  /** Motion sensors: detecting motion now (true) or clear (false). */
  motion?: boolean;
  /** Contact sensors: open (true) or closed (false). */
  open?: boolean;
}

/** A device reading a number can be compared on. */
export type NumericField = 'temp' | 'target' | 'power' | 'energy' | 'battery' | 'bri' | 'vol' | 'grid' | 'load' | 'humidity' | 'lux' | 'pm25';

/** What starts an automation. Any one of an automation's triggers starts it. */
export type Trigger =
  /** A device changes to (and/or from) a state; with `forSec`, only once it has stayed so that long. */
  | { kind: 'device'; device: string; to?: StateMatch; from?: StateMatch; forSec?: number }
  /** A reading crosses above and/or below a value (fires on the crossing, not while it stays there). */
  | { kind: 'numeric'; device: string; field: NumericField; above?: number; below?: number; forSec?: number }
  /** A momentary device event: a camera seeing a person, a doorbell ring, a player starting a film. */
  | { kind: 'event'; device: string; event: string }
  /** Something happening in a room, from any camera or sensor there: a person, motion, the doorbell, a door opening. */
  | { kind: 'room'; room: string; event: RoomEventKind }
  /** A time of day (a clock time, sun or prayer time, with an offset), on the given days (0 = Sunday; all when empty). */
  | { kind: 'time'; at: Rhythm; days?: number[] }
  /** Every so many minutes, from local midnight. */
  | { kind: 'every'; minutes: number }
  /** People coming and going: one person (or anyone), the first to arrive, the last to leave. */
  | { kind: 'presence'; event: 'arrives' | 'leaves' | 'first-arrives' | 'last-leaves'; person?: string }
  /** A mode starting. */
  | { kind: 'mode'; mode: string }
  /** An overlay starting or ending. */
  | { kind: 'overlay'; overlay: string; event: 'starts' | 'ends' }
  /** The hub starting (after an update or a power cut). */
  | { kind: 'hub'; event: 'start' };

/** Whether to go ahead. Every condition in a list has to hold, unless grouped with any / not. */
export type Condition =
  | { kind: 'device'; device: string; is: StateMatch }
  | { kind: 'numeric'; device: string; field: NumericField; above?: number; below?: number }
  /** Between two times (may cross midnight), and/or on the given days (0 = Sunday). */
  | { kind: 'time'; after?: Rhythm; before?: Rhythm; days?: number[] }
  /** Someone in particular, anyone, or no one is home. */
  | { kind: 'presence'; who: 'anyone' | 'no-one' | string; home: boolean }
  | { kind: 'mode'; modes: string[] }
  /** An overlay (or any overlay, when none is named) is on, or not. */
  | { kind: 'overlay'; overlay?: string; active: boolean }
  /** A room had activity (a person, motion, a door) in the last `withinMin` minutes (default 10), or not. */
  | { kind: 'room'; room: string; active: boolean; withinMin?: number }
  | { kind: 'all' | 'any' | 'not'; conditions: Condition[] };

/** What an automation does, in order. */
export type Action =
  | { kind: 'set'; targets: Targets }
  | { kind: 'delay'; seconds: number }
  /** Wait until a condition holds; after `timeoutSec`, carry on (or stop when `stopOnTimeout`). */
  | { kind: 'wait'; until: Condition; timeoutSec?: number; stopOnTimeout?: boolean }
  /** A push notification to everyone's phones, or to some people's. */
  | { kind: 'notify'; title?: string; message: string; people?: string[] }
  | { kind: 'overlay'; overlay: string; op: 'start' | 'end' }
  | { kind: 'if'; conditions: Condition[]; then: Action[]; else?: Action[] }
  | { kind: 'repeat'; times: number; actions: Action[] }
  /** Ease a numeric field (brightness, volume, set temperature) toward `to` over `overSec` seconds,
   *  stepping every `stepSec` (default 60). `from` defaults to the first target's current value. */
  | { kind: 'ramp'; targets: Targets; field: NumericField; to: number; from?: number; overSec: number; stepSec?: number }
  /** Run another automation's actions (its triggers and conditions are skipped). */
  | { kind: 'run'; automation: string }
  /** Stop here. */
  | { kind: 'stop' };

/**
 * When it starts again while still running (waiting or in a delay): ignore the new start (single),
 * cancel the run and start over (restart), run after it (queued), or run alongside it (parallel).
 */
export type RunMode = 'single' | 'restart' | 'queued' | 'parallel';

/** The home's own rules: when (any trigger), if (all conditions), then (actions in order). */
export interface Automation {
  id: string;
  name: string;
  description?: string;
  /** Off: kept, but doesn't run. */
  enabled: boolean;
  triggers: Trigger[];
  conditions: Condition[];
  actions: Action[];
  mode: RunMode;
  /** Where it came from, when it was converted from another system. */
  origin?: { from: 'home-assistant'; id: string; notes?: string[] };
}

/** One run of an automation, step by step: for its history. */
export interface AutomationRun {
  id: string;
  automation: string;
  at: number;
  /** What started it, in words. */
  why: string;
  result: 'running' | 'done' | 'stopped' | 'skipped' | 'cancelled' | 'failed';
  /** Why it was skipped (the condition that didn't hold) or failed. */
  detail?: string;
  steps: { at: number; text: string; ok: boolean; detail?: string }[];
  endedAt?: number;
}

/** Something speakers can play by name: a live radio stream, or a recording (rain, thunder, white noise). */
export interface MediaSource {
  name: string;
  icon: string;
  url?: string;
  /**
   * A recording plays again from the start when it ends, until someone stops it (so a one-hour file of rain
   * doesn't go quiet after an hour). Live streams never end, so it doesn't matter for them.
   */
  loop?: boolean;
}

/** The real point Kova treats as "home", and how it was chosen. */
export interface HomeLocation {
  latitude: number;
  longitude: number;
  /** Geofence radius; defaults to the phone app's 150 m when unset. */
  radiusM?: number;
  source?: 'manual' | 'geocode' | 'phone' | 'import';
  updatedAt?: number;
}

export interface HomeConfig {
  name: string;
  /** The home's street address, as the owner chose it in Settings (the location comes from it). */
  address?: string;
  timezone: string;
  /** The real home point and geofence, when saved through the newer location field. */
  location?: HomeLocation;
  latitude: number;
  longitude: number;
  prayerMethod?: string;
  rooms: Room[];
  people: Person[];
  modes: Mode[];
  moments: Moment[];
  overlays: Overlay[];
  lightTheWay: { triggers: LightTheWayTrigger[] };
  /** Media sources that targets can reference by name. */
  sources: MediaSource[];
  /** Named groups of rooms learned from the user ("downstairs"). */
  groups: Record<string, string[]>;
  /** Findings the user chose to keep as they are. */
  dismissedFindings: string[];
  /** Per-device names, rooms and visibility set by the owner (they win over what integrations report). */
  devices?: Record<string, DeviceSettings>;
  /** Devices on the owner's Now screen, in order. */
  favourites?: string[];
  /** Speakers the owner grouped to play together (any brands). Each group is a device of its own. */
  speakerGroups?: SpeakerGroup[];
  /** Devices reached through several integrations, shown as one. */
  combined?: CombinedDevice[];
  /** Pause what's playing on players that can pause (a Helix box) when the doorbell rings. Default on. */
  pauseForDoorbell?: boolean;
  /** When / if / then rules the owner made (or took from a suggestion). */
  automations?: Automation[];
  /** Camera and sensor alerts: quiet hours, how long between alerts, and per-room choices. */
  security?: SecuritySettings;
}

/** How camera and sensor alerts behave across the home. */
export interface SecuritySettings {
  /** No alerts between these local times ("22:30" to "07:00"), except the doorbell and anything while nobody's home. */
  quiet?: { from: string; to: string } | null;
  /** Minutes before the same kind of alert from the same room again. Default 5. */
  cooldownMin?: number;
  /** Per room: when its events alert (a camera's own choices win). */
  rooms?: Record<string, AlertPrefs>;
}

export interface SpeakerGroup { id: string; name: string; room?: string; members: string[] }

/**
 * One physical device that Kova reaches through more than one integration (a soundbar through Google Cast for music
 * and SmartThings for power and input), shown as one. `members` in order of preference: each part of a command goes
 * to the first member that can do it. `hid`: members it hid, shown again when it's separated.
 */
export interface CombinedDevice { id: string; name: string; room?: string; members: string[]; hid?: string[] }

// ------------------------------------------------------------------ plans --

/** A resolved, scheduled thing the home will do (or did) at a specific instant. */
export interface PlanItem {
  /** Stable per-day id: "mode:evening" / "moment:rain". */
  id: string;
  kind: 'mode' | 'moment';
  refId: string;
  at: number;
  label: string;
  what: string;
  targets: Targets;
  modeId?: string;
}
