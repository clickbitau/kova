import type { Cause, Command, Device, DeviceState } from '../model/types.ts';

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
  /** Set the state of a device whose state is worked out from others (a speaker group): quietly, without an Activity entry. */
  derive(deviceId: string, state: DeviceState): void;
  /** Remove devices this adapter no longer has (a deleted group). */
  retract(deviceIds: string[]): void;
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
  /** Browser's SDP offer → the camera's answer. The session ends at `expiresAt` unless extended. */
  offer(device: Device, offerSdp: string): Promise<{ answerSdp: string; mediaSessionId: string; expiresAt: string }>;
  extend(device: Device, mediaSessionId: string): Promise<{ mediaSessionId: string; expiresAt: string }>;
  stop(device: Device, mediaSessionId: string): Promise<void>;
}

export interface Snapshot { contentType: string; body: Buffer }
