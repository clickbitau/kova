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
  /**
   * Optional, for announcements (engine/announce.ts): what a speaker plays now, exactly enough to put it back (a queue
   * and the place in it, the stream it was on). Null when it plays nothing. Kept in memory only, so anything goes.
   */
  snapshotPlayback?(device: Device): Promise<unknown | null>;
  /** Optional: play a short clip once, on this speaker alone (out of any group, not as a radio stream). */
  playClip?(device: Device, clip: Clip, cause?: Cause): Promise<void | DeviceState>;
  /**
   * Play a clip on several of this adapter's speakers together: the ones a native group covers through it (sample-
   * locked), the rest each on its own. One result per device, in order. Volumes are set before (Registry.playClips).
   */
  playClipTogether?(devices: Device[], clip: (d: Device) => Clip): Promise<PromiseSettledResult<void | DeviceState>[]>;
  /**
   * Optional: put back what snapshotPlayback saw (null: it played nothing; leave it idle as it was before). Says
   * in words what it did ("resumed Loved at 1:23"), with the state when it knows it.
   */
  restorePlayback?(device: Device, snap: unknown | null): Promise<{ words: string; state?: DeviceState }>;
  /**
   * Optional, for speaker groups (engine/group-sync.ts): sets of this adapter's speakers it can play as one stream in
   * perfect sync. A fixed group (a Cast group made in Google Home) is only used for exactly its members; a dynamic one
   * (Sonos, which can group any of its speakers on the fly) for any two or more of them. Members are Kova device ids.
   */
  nativeGroups?(): NativeGroup[];
  /** Optional: where whatever plays this speaker (it, or the native group it plays through) is in its queue, now. */
  playbackPosition?(device: Device): Promise<PlaybackPosition | null>;
  /** Optional: move whatever plays this speaker to a place in its queue (a song, ms into it), to line it up with others. */
  syncTo?(device: Device, to: { index: number; positionMs: number }): Promise<void>;
  /** Stop where it is for a moment, without it counting as paused (a speaker waiting at a song's end for the others); syncTo plays it again. */
  hold?(device: Device): Promise<void>;
}

/** Speakers an adapter can play as one stream (see Adapter.nativeGroups). */
export interface NativeGroup { via: string; id: string; name: string; members: string[]; dynamic?: boolean }

/**
 * Where a speaker is: the song (its place in Kova's queue), how far into it (ms), when that was true (Date.now() ms),
 * whether it's playing, the song's length when known, and how finely it can seek (Sonos: whole seconds).
 */
export interface PlaybackPosition { index: number; positionMs: number; at: number; playing: boolean; durationMs?: number; seekStepMs?: number }

/** A short piece of audio for a speaker to play once (an announcement). The URL needs no headers. */
export interface Clip { url: string; title: string; contentType: string; durationMs?: number }

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
