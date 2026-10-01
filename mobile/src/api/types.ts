// The hub's live snapshot (GET /api/state, and every /api/ws message), as far as the app uses it.
// Source of truth: hub/src/api/snapshot.ts.

export type DeviceType = 'light' | 'dimmer' | 'fan' | 'media' | 'tv' | 'plug' | 'camera' | 'sensor' | 'vacuum' | 'internet';

export interface DeviceState {
  on?: boolean;
  bri?: number | null;
  k?: number | null;
  color?: string | null;
  mode?: string | null;
  media?: string | null;
  paused?: boolean;
  vol?: number | null;
  /** TV input to switch to: hdmi1..hdmi4 or tv (TVs with `input`). The TV can't say which it's on, so this reads back null. */
  input?: string | null;
  power?: number | null;
  energy?: number | null;
  activity?: string;
  battery?: number | null;
  online?: boolean;
}

export type Command = Partial<DeviceState>;

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
  hidden?: boolean;
  original?: { name: string; room: string };
  why?: { now: string; next: string };
  usedIn?: { kind: string; id: string; name: string }[];
}

export interface Room { id: string; name: string; icon: string }
export interface Person { id: string; name: string; detail: string; home: boolean; since: number | null; sinceLabel: string }

export interface ModeView {
  id: string; name: string; color: string; icon: string;
  startLabel: string; endLabel: string; nextId: string; start: number | null;
  groups: { room: string; chips: string[] }[];
  test: { days: ('ok' | 'problem' | 'skipped' | 'none')[]; text: string };
}

export interface Finding { id: string; modeId: string; kind: string; icon: string; tone: 'alert' | 'check'; title: string; body: string; fix: string; alt: string; done?: string }

export interface ActivityRow { id: number; ts: number; t: string; type: string; icon: string; what: string; why: string }

export interface Integration { id: string; name: string; icon: string; kind: string; ok: boolean; note?: string; devices: number }

export interface Snapshot {
  home: { name: string; timezone: string; now: number; nowHour: number; date: string; dateLabel: string; clock: string; location?: { latitude: number; longitude: number } };
  rooms: Room[];
  favourites: string[] | null;
  speakerGroups: { id: string; name: string; members: string[]; deviceId: string; sync: 'perfect' | 'together'; castGroup: string | null }[];
  people: Person[];
  devices: Device[];
  modes: ModeView[];
  current: { modeId: string; since?: number; until?: number; untilLabel: string; nextId: string; overlay: { id: string; name: string; icon: string; endsLabel: string } | null };
  day: { bands: { modeId: string; start: number; end: number }[] };
  upcoming: { id: string; t: string; label: string; what: string; modeId: string | null; skipped: boolean }[];
  overlays: { id: string; name: string; icon: string; endsLabel: string }[];
  sources: { name: string; icon: string }[];
  findings: Finding[];
  activity: ActivityRow[];
  integrations: Integration[];
  weather: { temp: number; text: string; icon: string } | null;
  energy: unknown;
  demo?: boolean;
}

export interface AskReply {
  text: string;
  source: string;
  actions: { label: string; action: unknown }[];
  undo?: string;
  understood: boolean;
}
