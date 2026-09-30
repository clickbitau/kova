import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';

/**
 * Simulated devices. Lets the whole product run with no hardware: for
 * development, tests, demos and the "try Kova" experience.
 */
export class VirtualAdapter implements Adapter {
  id = 'virtual';
  name = 'Virtual devices';
  icon = 'science';
  kind = 'Local' as const;
  private ctx?: AdapterContext;

  constructor(private devices: DeviceInfo[]) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.announce(this.devices);
  }

  async stop(): Promise<void> {}

  async command(_d: Device, _cmd: Command): Promise<void> {
    // A real device would acknowledge here; virtual ones always accept.
  }

  /** Simulate a change made at the device itself (a wall switch, another app). */
  physical(id: string, state: Command): void { this.ctx?.report(id, state); }

  status(): AdapterStatus { return { ok: true, note: `${this.devices.length} simulated devices` }; }
}
