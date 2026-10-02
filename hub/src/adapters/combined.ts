import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Capability, Cause, Command, CombinedDevice, Device, DeviceState } from '../model/types.ts';
import type { Registry } from '../devices/registry.ts';
import { FIELD_CAP } from '../util/describe.ts';

// One physical device reached through more than one integration, shown as one Kova device. A Samsung soundbar is
// the usual case: Google Cast plays music to it, SmartThings switches it on, picks its input and sound mode. Each
// part of a command goes to the first member that can do it; the state is each field from the member that owns it.
// The members stay (modes and automations that use them keep working) but are hidden from lists.

export const combinedDeviceId = (c: Pick<CombinedDevice, 'id'>) => `combined_${c.id}`;

/** Which member does a field: the first that has its capability. */
const owner = (field: string, members: Device[]): Device | undefined => {
  const cap = FIELD_CAP[field] as Capability | undefined;
  return (cap && members.find(m => m.capabilities.includes(cap))) || undefined;
};

/** Split a command between members. `on` goes with `media` when a play is asked for, else to the first that switches. */
export function routeCommand(cmd: Command, members: Device[]): Map<string, Command> {
  const out = new Map<string, Command>();
  const put = (d: Device | undefined, k: string, v: unknown) => {
    if (!d) return;
    out.set(d.id, { ...out.get(d.id), [k]: v } as Command);
  };
  const playing = typeof cmd.media === 'string';
  for (const [k, v] of Object.entries(cmd)) {
    if (k === 'on') continue;
    put(owner(k, members) ?? (k === 'media' ? undefined : members[0]), k, v);
  }
  // Playing something always switches on the member that plays it (even when the device as a whole is already on).
  if (playing) put(owner('media', members), 'on', true);
  else if (cmd.on !== undefined) put(owner('on', members), 'on', cmd.on);
  return out;
}

/** The combined state: each field from the member that owns it; on when its switch says so or it's playing. */
export function mergeState(members: Device[]): DeviceState {
  const out: Record<string, unknown> = {};
  const keys = new Set(members.flatMap(m => Object.keys(m.state)));
  for (const k of keys) {
    if (k === 'on' || k === 'online') continue;
    const from = owner(k, members) ?? members.find(m => (m.state as Record<string, unknown>)[k] !== undefined);
    const v = from ? (from.state as Record<string, unknown>)[k] : undefined;
    if (v !== undefined) out[k] = v;
  }
  const power = owner('on', members), media = owner('media', members);
  out.on = !!power?.state.on || !!(media && media.state.on && media.state.media);
  out.online = members.some(m => m.state.online !== false);
  return out as DeviceState;
}

export class CombinedAdapter implements Adapter {
  id = 'combined';
  name = 'Combined devices';
  icon = 'join';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private announced = new Set<string>();
  private onChange = () => this.refresh();

  constructor(private reg: Registry, private list: () => CombinedDevice[]) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.sync();
    this.reg.on('change', this.onChange);
    this.reg.on('devices', this.onChange);
    this.reg.on('measure', this.onChange);
  }

  async stop(): Promise<void> {
    this.reg.off('change', this.onChange);
    this.reg.off('devices', this.onChange);
    this.reg.off('measure', this.onChange);
  }

  private members(c: CombinedDevice): Device[] { return c.members.map(id => this.reg.get(id)).filter((d): d is Device => !!d); }

  /** Announce the combined devices (once their members are known) and drop removed ones. */
  sync(): void {
    if (!this.ctx) return;
    const list = this.list().filter(c => this.members(c).length);
    const ids = new Set(list.map(combinedDeviceId));
    const gone = [...this.announced].filter(id => !ids.has(id));
    if (gone.length) this.ctx.retract(gone);
    const fresh = list.filter(c => !this.announced.has(combinedDeviceId(c)) || this.changedShape(c));
    this.announced = ids;
    if (fresh.length) {
      this.ctx.announce(fresh.map(c => {
        const ms = this.members(c);
        return {
          id: combinedDeviceId(c), name: c.name, room: c.room ?? ms.find(m => m.room !== 'unassigned')?.room ?? 'unassigned', type: ms[0].type,
          capabilities: [...new Set(ms.flatMap(m => m.capabilities))], integration: ms.map(m => m.integration).join(' + '),
          address: c.members.join(', '), state: mergeState(ms),
        };
      }));
    }
    this.refresh();
  }

  /** A member came or went since it was announced: announce again with the new capabilities. */
  private changedShape(c: CombinedDevice): boolean {
    const d = this.reg.get(combinedDeviceId(c));
    const caps = [...new Set(this.members(c).flatMap(m => m.capabilities))];
    return !d || caps.length !== d.capabilities.length;
  }

  private refresh(): void {
    if (!this.ctx) return;
    for (const c of this.list()) {
      if (!this.reg.get(combinedDeviceId(c))) { if (this.members(c).length) this.sync(); continue; }
      if (this.changedShape(c)) { this.sync(); return; }
      this.ctx.derive(combinedDeviceId(c), mergeState(this.members(c)));
    }
  }

  async command(device: Device, cmd: Command, cause?: Cause): Promise<void> {
    const c = this.list().find(x => combinedDeviceId(x) === device.id);
    if (!c) throw new Error('That device is no longer combined');
    const ms = this.members(c);
    if (!ms.length) throw new Error(`${c.name}: none of its integrations has it right now`);
    const via: Cause = { ...(cause ?? { kind: 'user', label: 'You' }), detail: `through ${c.name}` };
    const parts = routeCommand(cmd, ms);
    if (!parts.size) throw new Error(`${c.name} can't do that`);
    // In order: switching on (and inputs) before playing, so a soundbar is awake when music starts.
    for (const m of ms) { const part = parts.get(m.id); if (part) await this.reg.command(m.id, part, via); }
    this.refresh();
  }

  status(): AdapterStatus {
    const n = this.list().length;
    return { ok: true, note: n ? `${n} combined` : 'None yet' };
  }
}

// ----------------------------------------------------------------- ideas --

const GENERIC = new Set(['speaker', 'speakers', 'room', 'home', 'group', 'display', 'mini', 'nest', 'the', 'and', 'living', 'bedroom', 'kitchen', 'lounge', 'tv', 'samsung', 'google', 'sonos', 'smart']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC.has(w)));

export interface CombineIdea { key: string; name: string; members: string[]; why: string }

/**
 * Devices from different integrations that look like the same thing: players with a distinctive word in common
 * ("Soundbar", a model like "Q930B"), in the same room or not yet in one. The one that switches and picks inputs
 * goes first, the one that plays music after.
 */
export function combineIdeas(devices: Device[], combined: CombinedDevice[], dismissed: string[], hidden: (id: string) => boolean, via: (adapterId: string) => string = id => id): CombineIdea[] {
  const taken = new Set(combined.flatMap(c => c.members));
  const players = devices.filter(d => (d.type === 'media' || d.type === 'tv') && !['groups', 'combined', 'helix'].includes(d.adapter) && !taken.has(d.id) && !hidden(d.id));
  const out: CombineIdea[] = [];
  const used = new Set<string>();
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.adapter === b.adapter || used.has(a.id) || used.has(b.id)) continue;
      const sameRoom = a.room === b.room || a.room === 'unassigned' || b.room === 'unassigned';
      const shared = [...words(a.name)].filter(w => words(b.name).has(w));
      if (!sameRoom || !shared.length) continue;
      const controls = (d: Device) => d.capabilities.includes('input') || d.capabilities.includes('sound') ? 0 : 1;
      const pair = [a, b].sort((x, y) => controls(x) - controls(y));
      const key = `combine:${pair.map(d => d.id).sort().join('+')}`;
      if (dismissed.includes(`idea:${key}`)) continue;
      used.add(a.id); used.add(b.id);
      // The fuller name, without a model number in brackets: "Samsung Soundbar Q930B", "Bedroom Oled".
      const name = pair.map(d => d.name.replace(/\s*\([^)]*\)\s*$/, '').trim()).sort((x, y) => y.length - x.length)[0];
      out.push({
        key, name, members: pair.map(d => d.id),
        why: `“${pair[0].name}” through ${via(pair[0].adapter)} and “${pair[1].name}” through ${via(pair[1].adapter)} look like the same device. As one, ${via(pair[0].adapter)} does what it does best (power, input, sound) and ${via(pair[1].adapter)} plays music.`,
      });
    }
  }
  return out;
}
