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
  /** Ducted air conditioners (`zones`): each zone's damper, on or off and how far open (0–100). */
  zones?: { n: number; on: boolean; open: number | null }[] | null;
  online?: boolean;
}

/** `skip`: 1 = next song, -1 = previous (speakers with `queue`). `volStep`: 1 = volume up a step, -1 = down. */
export type Command = Partial<DeviceState> & { skip?: number; volStep?: number; /** Some zones of a ducted air conditioner, by number. */ zoneSet?: Record<string, { on?: boolean; open?: number }> };

export interface Device {
  id: string;
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
  hidden?: boolean;
  original?: { name: string; room: string };
  why?: { now: string; next: string };
  usedIn?: { kind: string; id: string; name: string }[];
  /** Devices with no meter: the owner's figure for what it draws while on (null: not set) and Kova's typical one. */
  watts?: number | null;
  typicalWatts?: number | null;
}

export interface Room { id: string; name: string; icon: string }
export interface Person {
  id: string; name: string; detail: string; home: boolean; since: number | null; sinceLabel: string;
  /** What already tells the hub this person is home without their phone's location (e.g. ['Warden']); empty or missing when nothing does. */
  via?: string[];
}

export interface ModeView {
  id: string; name: string; color: string; icon: string;
  startLabel: string; endLabel: string; nextId: string; start: number | null;
  groups: { room: string; chips: string[] }[];
  test: { days: ('ok' | 'problem' | 'skipped' | 'none')[]; text: string };
}

export interface Finding { id: string; modeId: string; kind: string; icon: string; tone: 'alert' | 'check'; title: string; body: string; fix: string; alt: string; done?: string }

export interface ActivityRow { id: number; ts: number; t: string; type: string; icon: string; what: string; why: string }

export interface Integration { id: string; name: string; icon: string; kind: string; ok: boolean; note?: string; devices: number }

/** A stream speakers can play by name. `loop`: a recording plays again from the start when it ends. */
export interface MediaSource { name: string; icon: string; url?: string; loop?: boolean }

export interface SpeakerGroup { id: string; name: string; members: string[]; deviceId: string; sync: 'perfect' | 'together'; castGroup: string | null; room?: string; missing?: string[] }

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
  home: { name: string; timezone: string; now: number; nowHour: number; date: string; dateLabel: string; clock: string; location?: { latitude: number; longitude: number } };
  rooms: Room[];
  favourites: string[] | null;
  speakerGroups: SpeakerGroup[];
  people: Person[];
  devices: Device[];
  modes: ModeView[];
  current: { modeId: string; since?: number; until?: number; untilLabel: string; nextId: string; overlay: { id: string; name: string; icon: string; endsLabel: string } | null };
  day: { bands: { modeId: string; start: number; end: number }[] };
  upcoming: { id: string; t: string; label: string; what: string; modeId: string | null; skipped: boolean }[];
  overlays: { id: string; name: string; icon: string; endsLabel: string }[];
  sources: MediaSource[];
  /** Helix music any speaker with `queue` can play: Shuffle all, Loved, playlists. Empty until Helix is paired. */
  music?: { name: string; kind: 'all' | 'loved' | 'playlist'; icon: string; tracks?: number }[];
  findings: Finding[];
  activity: ActivityRow[];
  integrations: Integration[];
  /** The hub's own software updates (null when the hub has no updater). */
  update?: HubUpdate | null;
  weather: { temp: number; text: string; icon: string } | null;
  energy: EnergyToday | null;
  demo?: boolean;
}

export interface AskReply {
  text: string;
  source: string;
  actions: { label: string; action: unknown }[];
  undo?: string;
  understood: boolean;
}
