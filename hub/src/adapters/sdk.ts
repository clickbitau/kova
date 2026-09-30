import type { Command, Device, DeviceState } from '../model/types.ts';

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
  /** Apply a partial state. Resolve once the device accepted it. */
  command(device: Device, cmd: Command): Promise<void>;
  status(): AdapterStatus;
}
