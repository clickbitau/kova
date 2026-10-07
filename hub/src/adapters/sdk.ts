import type { Cause, Command, Device, DeviceState, Track } from '../model/types.ts';

/**
 * A device as an adapter announces it. The registry fills in the rest.
 * `state` is only a default for when Kova knows nothing yet; send live state with report().
 */
export type DeviceInfo = Omit<Device, 'adapter' | 'state'> & { state?: DeviceState };

export interface AdapterStatus {
  ok: boolean;
  /** Shown on the Integrations screen when something needs attention. */
  note?: string;
}

/** What the hub gives an adapter to talk back with. */
export interface AdapterContext {
  log(msg: string, ...rest: unknown[]): void;
  /** Add or update devices this adapter owns. */
  announce(devices: DeviceInfo[]): void;
  /** Report a state change that happened at the device or in another app. */
  report(deviceId: string, state: DeviceState): void;
  /** Report a momentary event: "person", "ring", "motion", "button". */
  event(deviceId: string, type: string, data?: Record<string, unknown>): void;
  /** Look up a media source's stream URL by name. */
  sourceUrl(name: string): string | undefined;
  /** Whether a source plays again from the start when it ends (a recording set to loop). */
  sourceLoops?(name: string): boolean;
  /**
   * Music by name (Helix: "Shuffle all", "Loved", a playlist, "Station: …") → the tracks to queue, in the order
   * to play them (already shuffled when asked). Null when it isn't music Kova knows. Asked again within a few
   * seconds it answers the same order, so every speaker of a group plays the same queue.
   */
  queueFor(media: string, opts?: QueueOptions): Promise<Queue | null>;
  /** Set the state of a device whose state is worked out from others (a speaker group): quietly, without an Activity entry. */
  derive(deviceId: string, state: DeviceState): void;
  /** Remove devices this adapter no longer has (a deleted group). */
  retract(deviceIds: string[]): void;
  /** Another running adapter, by id (a Samsung TV asks SmartThings to switch its source). */
  peer(adapterId: string): Adapter | undefined;
  /** Whether Kova has had a device by this id (now, or before a restart), so an adapter can keep an id the home already uses. */
  known?(deviceId: string): boolean;
}

/**
 * An adapter connects one brand or protocol to Kova. It announces devices,
 * reports their state, and carries out commands. Adapters never decide
 * anything; the engine does.
 */
export interface Adapter {
  id: string;
  name: string;
  icon: string;
  kind: 'Local' | 'Cloud';
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  /**
   * Apply a partial state. Resolve once the device accepted it. `cause` is why (adapters that act through other devices pass it on).
   * Resolve with state when the device did something more exact than asked (a title it found: "the office" → "Diversity Day").
   */
  command(device: Device, cmd: Command, cause?: Cause): Promise<void | DeviceState>;
  status(): AdapterStatus;
  /** Optional: live camera video over WebRTC, negotiated with the browser through the hub. */
  liveView?: LiveView;
  /** Optional: a still image from a camera (e.g. of its latest event). */
  snapshot?(device: Device): Promise<Snapshot>;
}

/** WebRTC signalling for cameras whose cloud or device speaks WebRTC to the browser directly. */
export interface LiveView {
  /** Whether this camera can stream (e.g. a Nest camera that offers WebRTC, not only RTSP). Unset: every camera can. */
  supports?(device: Device): boolean;
  /** Browser's SDP offer → the camera's answer. The session ends at `expiresAt` unless extended. */
  offer(device: Device, offerSdp: string): Promise<{ answerSdp: string; mediaSessionId: string; expiresAt: string }>;
  extend(device: Device, mediaSessionId: string): Promise<{ mediaSessionId: string; expiresAt: string }>;
  stop(device: Device, mediaSessionId: string): Promise<void>;
}

export interface Snapshot { contentType: string; body: Buffer }

/**
 * What a speaker can play best, for the songs' URLs: "flac" (lossless; Helix serves a fitting file as it is, no
 * transcoding) or "aac" (every song transcoded). Default "aac", which every speaker plays.
 */
export type AudioFormat = 'flac' | 'aac';
export interface QueueOptions { shuffle?: boolean; format?: AudioFormat }

/** One song a speaker can fetch by itself (no headers: any credential is in the URL). */
export interface QueueTrack extends Track { id: string; url: string; contentType: string }

/** A play queue: what was asked for, and the songs in playing order. */
export interface Queue {
  label: string; tracks: QueueTrack[]; shuffle: boolean;
  /** Make the URLs of tracks[from..to) ready to hand to a speaker (Helix signs each song's URL just before it's queued). Of this queue's own tracks, so a copy with the songs reordered signs its own. */
  prepare?(from: number, to: number): Promise<void>;
}
