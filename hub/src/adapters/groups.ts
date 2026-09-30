import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Cause, Command, Device, DeviceState, SpeakerGroup } from '../model/types.ts';
import type { Registry } from '../devices/registry.ts';

// Speaker groups the owner makes in Kova: any speakers, any brands, played as one.
// Each group is a Kova device (type media), so it works everywhere a speaker does: tiles,
// modes, moments, the assistant, the Apple Home and Matter bridges. A command to the group
// goes to every member in the same instant. When the members are exactly a Cast group made
// in Google Home, the Cast adapter plays through that group: perfect sync. Otherwise the
// speakers start together but aren't sample-locked (different brands can't be).

export const groupDeviceId = (g: SpeakerGroup) => `group_${g.id}`;

export class SpeakerGroupsAdapter implements Adapter {
  id = 'groups';
  name = 'Speaker groups';
  icon = 'speaker_group';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private announced = new Set<string>();
  private onChange = () => this.refresh();

  constructor(private reg: Registry, private groups: () => SpeakerGroup[]) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.sync();
    // Member changes (and new members appearing) update the group's state.
    this.reg.on('change', this.onChange);
    this.reg.on('devices', this.onChange);
    this.reg.on('measure', this.onChange);
  }

  async stop(): Promise<void> {
    this.reg.off('change', this.onChange);
    this.reg.off('devices', this.onChange);
    this.reg.off('measure', this.onChange);
  }

  /** Announce the configured groups and drop deleted ones. Call after the groups change. */
  sync(): void {
    if (!this.ctx) return;
    const gs = this.groups();
    const ids = new Set(gs.map(groupDeviceId));
    const gone = [...this.announced].filter(id => !ids.has(id));
    if (gone.length) this.ctx.retract(gone);
    this.announced = ids;
    this.ctx.announce(gs.map(g => ({
      id: groupDeviceId(g), name: g.name, room: g.room || this.commonRoom(g) || 'unassigned', type: 'media' as const,
      capabilities: ['onoff', 'volume', 'media'], integration: 'Kova speaker group', address: g.members.join(', '),
      state: this.derived(g),
    })));
    this.refresh();
  }

  private members(g: SpeakerGroup): Device[] { return g.members.map(id => this.reg.get(id)).filter((d): d is Device => !!d); }
  private commonRoom(g: SpeakerGroup): string | undefined { const rooms = new Set(this.members(g).map(d => d.room)); return rooms.size === 1 ? [...rooms][0] : undefined; }

  /** The group's state from its members: on if any plays, what they share, their average volume. */
  private derived(g: SpeakerGroup): DeviceState {
    const ms = this.members(g);
    const playing = ms.filter(d => d.state.on);
    const medias = new Set(playing.map(d => d.state.media ?? null));
    const vols = ms.map(d => d.state.vol).filter((v): v is number => typeof v === 'number');
    return {
      on: playing.length > 0,
      media: playing.length && medias.size === 1 ? [...medias][0] : playing.length ? 'Mixed' : null,
      vol: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : 30,
      online: ms.some(d => d.state.online !== false) && ms.length > 0,
    };
  }

  private refresh(): void {
    if (!this.ctx) return;
    for (const g of this.groups()) if (this.reg.get(groupDeviceId(g))) this.ctx.derive(groupDeviceId(g), this.derived(g));
  }

  async command(device: Device, cmd: Command, cause?: Cause): Promise<void> {
    const g = this.groups().find(x => groupDeviceId(x) === device.id);
    if (!g) throw new Error('That speaker group no longer exists');
    const ms = this.members(g);
    if (!ms.length) throw new Error(`${g.name} has no speakers`);
    const via: Cause = { ...(cause ?? { kind: 'user', label: 'You' }), detail: `through ${g.name}` };
    // Same instant for every member, so the Cast adapter can batch them into a Cast group.
    const results = await Promise.allSettled(ms.map(d => this.reg.command(d.id, cmd, via)));
    this.refresh();
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed === ms.length) throw (results[0] as PromiseRejectedResult).reason;
  }

  status(): AdapterStatus {
    const n = this.groups().length;
    return { ok: true, note: n ? `${n} group${n === 1 ? '' : 's'}` : 'No groups yet · make one in Media' };
  }
}
