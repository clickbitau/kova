// Kova's domain model. Everything in the hub speaks these types; adapters
// translate brand-specific protocols into and out of them.

/** What kind of thing a device is. Drives which capabilities it has. `internet` is a device's internet access (on = allowed), from the router. */
export type DeviceType = 'light' | 'dimmer' | 'fan' | 'media' | 'tv' | 'plug' | 'camera' | 'sensor' | 'vacuum' | 'internet';

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
  online?: boolean;
}

export type VacuumActivity = 'cleaning' | 'returning' | 'docked' | 'paused' | 'idle' | 'error';

export type Capability = 'onoff' | 'brightness' | 'colorTemp' | 'color' | 'fanMode' | 'media' | 'volume' | 'power' | 'energy' | 'events' | 'vacuum' | 'battery' | 'pause' | 'library';

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

/** What the owner changed about a device: a better name, the right room, or hidden from lists. */
export interface DeviceSettings { name?: string; room?: string; hidden?: boolean }

/** A partial state change requested of a device. */
export type Command = Partial<DeviceState>;

/** Why something happened. Attached to every state change and log entry. */
export interface Cause {
  kind: 'mode' | 'moment' | 'overlay' | 'behaviour' | 'user' | 'device' | 'presence' | 'system' | 'undo' | 'assistant';
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
}

export interface Person {
  id: string;
  name: string;
  /** Which device reports presence, shown in the UI ("iPhone Air"). */
  detail: string;
}

export interface PersonState {
  home: boolean;
  since: number;
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

export interface HomeConfig {
  name: string;
  timezone: string;
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
  sources: { name: string; icon: string; url?: string }[];
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
  /** Pause what's playing on players that can pause (a Helix box) when the doorbell rings. Default on. */
  pauseForDoorbell?: boolean;
}

export interface SpeakerGroup { id: string; name: string; room?: string; members: string[] }

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
