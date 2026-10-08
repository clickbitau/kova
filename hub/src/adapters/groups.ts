import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Cause, Command, Device, DeviceState, SpeakerGroup } from '../model/types.ts';
import type { Registry } from '../devices/registry.ts';
import type { GroupSync } from '../engine/group-sync.ts';

// Speaker groups the owner makes in Kova: any speakers, any brands, played as one.
// Each group is a Kova device (type media), so it works everywhere a speaker does: tiles,
// modes, moments, the assistant, the Apple Home and Matter bridges. Playing something goes
// through engine/group-sync.ts: members that make up a native group (a Cast group made in
// Google Home, Sonos speakers) play through it, sample-locked; the rest play alongside, each
// started at its moment (its learned start delay and the owner's offset) and kept in time.
// Other commands (volume, pause, next song, stop) go to every member in the same instant.

export const groupDeviceId = (g: SpeakerGroup) => `group_${g.id}`;

/**
 * Each member's level for a group volume: the loudest of the balance plays at `vol`, the others at their share of it
 * (Ray at 40 and the kitchen at 20 in the balance: the group at 60 → 60 and 30). Without a balance, the members' levels
 * now are the balance. Never above 100; one at 0 in the balance stays at 0.
 */
export function balancedVols(vol: number, members: { id: string; vol?: number }[], balance?: Record<string, number>): Record<string, number> {
  const base = members.map(m => ({ id: m.id, b: balance?.[m.id] ?? m.vol ?? 30 }));
  const top = Math.max(0, ...base.map(x => x.b));
  const v = Math.max(0, Math.min(100, vol));
  return Object.fromEntries(base.map(x => [x.id, top > 0 ? Math.max(0, Math.min(100, Math.round(v * x.b / top))) : Math.round(v)]));
}

export class SpeakerGroupsAdapter implements Adapter {
  id = 'groups';
  name = 'Speaker groups';
  icon = 'speaker_group';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private announced = new Set<string>();
  private onChange = () => this.refresh();

  /** Timing across the group's parts (set by the hub). */
  timing: GroupSync | null = null;

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
      capabilities: ['onoff', 'volume', 'media', 'queue', 'pause'], integration: 'Kova speaker group', address: g.members.join(', '),
      state: this.derived(g),
    })));
    this.refresh();
  }

  private members(g: SpeakerGroup): Device[] { return g.members.map(id => this.reg.get(id)).filter((d): d is Device => !!d); }
  private commonRoom(g: SpeakerGroup): string | undefined { const rooms = new Set(this.members(g).map(d => d.room)); return rooms.size === 1 ? [...rooms][0] : undefined; }

  /** The group's state from its members: on if any plays, what they share, its volume (the loudest member's). */
  private derived(g: SpeakerGroup): DeviceState {
    const ms = this.members(g);
    const playing = ms.filter(d => d.state.on);
    const medias = new Set(playing.map(d => d.state.media ?? null));
    const vols = ms.map(d => d.state.vol).filter((v): v is number => typeof v === 'number');
    // The song: from the first speaker that says (they play the same queue in the same order).
    const withTrack = playing.find(d => d.state.track);
    return {
      on: playing.length > 0,
      media: playing.length && medias.size === 1 ? [...medias][0] : playing.length ? 'Mixed' : null,
      track: medias.size === 1 ? withTrack?.state.track ?? null : null,
      shuffle: !!withTrack?.state.shuffle,
      // Paused when every speaker that's on is paused (pausing the group pauses them all).
      paused: playing.length > 0 && playing.every(d => d.state.paused),
      vol: vols.length ? Math.max(...vols) : 30,
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
    // The volume: every member at its share, keeping the balance (and before anything plays, so it starts at it).
    if (typeof cmd.vol === 'number') {
      const levels = balancedVols(cmd.vol, ms.map(d => ({ id: d.id, vol: d.state.vol ?? undefined })), g.balance);
      const rv = await Promise.allSettled(ms.map(d => this.reg.command(d.id, { vol: levels[d.id]! }, via)));
      const rest: Command = { ...cmd };
      delete rest.vol;
      if (!Object.keys(rest).length) {
        this.refresh();
        if (rv.every(r => r.status === 'rejected')) throw (rv[0] as PromiseRejectedResult).reason;
        return;
      }
      cmd = rest;
    }
    // Something to play: each part at its moment, kept in time while it plays.
    if (typeof cmd.media === 'string' && cmd.media && this.timing) {
      const r = await this.timing.play(g, cmd, via);
      this.refresh();
      const bad = r.filter(x => x.result.status === 'rejected');
      if (r.length && bad.length === r.length) throw (bad[0]!.result as PromiseRejectedResult).reason;
      return;
    }
    if (cmd.on === false || cmd.media === null) this.timing?.end(g.id);
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
