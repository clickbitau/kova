import type { Automation, Condition, Device, HomeConfig, RoomEventKind, Targets, Trigger } from '../model/types.ts';
import { isLight } from '../util/describe.ts';
import { isCamera, isDoorbell, isOutdoor, isSensor, roomOutdoor } from '../util/sensors.ts';

// Automations Kova suggests from how the home's devices are connected. Each one is an ordinary automation
// the owner adds, changes or ignores: nothing here runs by itself.

/** A media player that sits on a TV (a Helix box on the TV's HDMI), and the soundbar that plays that TV. */
export interface Screen { player: string; tv: string; input?: string; soundbar?: string }

export type Idea = Omit<Automation, 'id' | 'enabled'> & { key: string; why: string };

export function automationIdeas(cfg: Pick<HomeConfig, 'automations' | 'dismissedFindings'> & Partial<Pick<HomeConfig, 'rooms' | 'devices' | 'lightTheWay'>>, devices: Map<string, Device>, screens: Screen[]): Idea[] {
  const out: Idea[] = [];
  out.push(...roomIdeas(cfg, devices));
  const have = (cfg.automations ?? []) as Partial<Automation>[];
  for (const s of screens) {
    const player = devices.get(s.player), tv = devices.get(s.tv);
    if (!player || !tv) continue;
    const key = `tv-off-with:${s.player}`;
    // Already made (from this idea or by hand): started by this player going offline, turning this TV off.
    const made = have.some(a => (a.triggers ?? []).some(t => t.kind === 'device' && t.device === s.player && t.to?.online === false)
      && JSON.stringify(a.actions ?? []).includes(`"${s.tv}":{"on":false`));
    if (made || cfg.dismissedFindings.includes(`idea:${key}`)) continue;
    const targets: Targets = { [s.tv]: { on: false }, ...(s.soundbar && devices.has(s.soundbar) ? { [s.soundbar]: { on: false } } : {}) };
    out.push({
      key, name: `${tv.name} off when ${player.name} shuts down`, mode: 'single',
      triggers: [{ kind: 'device', device: s.player, to: { online: false } }],
      conditions: [{ kind: 'device', device: s.tv, is: { on: true, ...(s.input ? { input: s.input } : {}) } }],
      actions: [{ kind: 'set', targets }],
      why: s.input ? `Only while ${tv.name} is still on ${player.name}’s input, so it never turns off a TV someone is watching something else on.` : `Only while ${tv.name} is on.`,
    });
  }
  return out;
}

/**
 * Kova 0.7.2–0.7.5 turned a TV off when its Helix box shut down, built in and on by default. On the first start
 * since, a home that already has a box on a TV keeps that rule, now as an automation it can see and change
 * (unless it had turned the setting off). Done once: a home that links a box later gets it as a suggestion.
 */
export function carryOverTvOff(o: {
  done: () => boolean; markDone: () => void; wasOff: () => boolean;
  ideas: () => Idea[]; add: (a: Omit<Automation, 'id'>) => void;
  /** Wait this long after starting for devices to be found, then stop looking. */
  graceMs?: number; on: (fn: () => void) => () => void;
}): void {
  if (o.done()) return;
  let off: () => void = () => {};
  const finish = () => { off(); clearTimeout(timer); o.markDone(); };
  const tryNow = () => {
    const ideas = o.ideas().filter(i => i.key.startsWith('tv-off-with:'));
    if (!ideas.length) return;
    if (!o.wasOff()) for (const { key: _k, why: _w, ...a } of ideas) o.add({ ...a, enabled: true });
    finish();
  };
  const timer = setTimeout(finish, o.graceMs ?? 120_000);
  timer.unref?.();
  off = o.on(tryNow);
  tryNow();
}

const AFTER_DARK: Condition = { kind: 'time', after: { kind: 'sun', event: 'sunset' }, before: { kind: 'sun', event: 'sunrise' } };

/**
 * Lights that answer what a room's cameras and sensors notice, by room and kind (nothing home-specific):
 * someone at a door or outside after dark lights that room for a few minutes; motion inside after dark lights the
 * room until it's been still a while; a door opening outside after dark lights the way in.
 */
export function roomIdeas(cfg: Pick<HomeConfig, 'automations' | 'dismissedFindings'> & Partial<Pick<HomeConfig, 'rooms' | 'devices' | 'lightTheWay'>>, devices: Map<string, Device>): Idea[] {
  const out: Idea[] = [];
  const rooms = cfg.rooms ?? [];
  const have = (cfg.automations ?? []) as Partial<Automation>[];
  const all = [...devices.values()].filter(d => !cfg.devices?.[d.id]?.hidden && !d.hidden);
  const place = { rooms, devices: cfg.devices };
  const made = (room: string, events: RoomEventKind[]) => have.some(a => (a.triggers ?? []).some(t => t.kind === 'room' && t.room === room && events.includes(t.event)));
  const ltw = (cfg.lightTheWay?.triggers ?? []).flatMap(t => 'device' in t.on ? [t.on.device] : []);
  for (const r of rooms) {
    const here = all.filter(d => d.room === r.id);
    const lights = here.filter(isLight).map(d => d.id);
    if (!lights.length) continue;
    const on: Targets = Object.fromEntries(lights.map(id => [id, { on: true }]));
    const off: Targets = Object.fromEntries(lights.map(id => [id, { on: false }]));
    const lightNames = here.filter(isLight).map(d => d.name.toLowerCase());
    const what = lightNames.length === 1 ? `the ${lightNames[0]}` : `the ${r.name} lights`;
    const skip = (key: string, events: RoomEventKind[]) => made(r.id, events) || cfg.dismissedFindings.includes(`idea:${key}`);
    // Someone at the door, or outside, after dark: light it for five minutes.
    const outsideCams = here.filter(d => isCamera(d) && isOutdoor(d, place));
    if (outsideCams.length && !outsideCams.some(c => ltw.includes(c.id))) {
      const key = `camera-light:${r.id}`;
      const bell = outsideCams.some(isDoorbell);
      if (!skip(key, ['person', 'ring'])) {
        const triggers: Trigger[] = [{ kind: 'room', room: r.id, event: 'person' }, ...(bell ? [{ kind: 'room' as const, room: r.id, event: 'ring' as const }] : [])];
        out.push({ key, name: `${r.name} light when someone’s there after dark`, mode: 'restart', triggers, conditions: [AFTER_DARK],
          actions: [{ kind: 'set', targets: on }, { kind: 'delay', seconds: 300 }, { kind: 'set', targets: off }],
          why: `${outsideCams.map(c => c.name).join(' and ')} ${outsideCams.length === 1 ? 'sees' : 'see'} people in the ${r.name}: ${what} come on for five minutes when ${bell ? 'someone rings or is seen' : 'someone is seen'} after dark.` });
      }
    }
    // Motion inside after dark: light the room until it's been still for five minutes.
    const motion = here.filter(d => isSensor(d) && typeof d.state.motion === 'boolean' && !isOutdoor(d, place));
    if (motion.length && !roomOutdoor(r)) {
      const key = `motion-light:${r.id}`;
      if (!skip(key, ['motion', 'person'])) {
        out.push({ key, name: `${r.name} lights with motion after dark`, mode: 'restart', triggers: [{ kind: 'room', room: r.id, event: 'motion' }], conditions: [AFTER_DARK],
          actions: [{ kind: 'set', targets: on }, { kind: 'wait', until: { kind: 'room', room: r.id, active: false, withinMin: 5 }, timeoutSec: 3600 }, { kind: 'set', targets: off }],
          why: `${motion[0].name} notices people in the ${r.name}: ${what} come on, and go off once it’s been still for five minutes.` });
      }
    }
    // A door outside opening after dark: light the way in.
    const doors = here.filter(d => isSensor(d) && typeof d.state.open === 'boolean');
    if (doors.length && roomOutdoor(r)) {
      const key = `door-light:${r.id}`;
      if (!skip(key, ['opened'])) {
        out.push({ key, name: `${r.name} light when the door opens after dark`, mode: 'restart', triggers: [{ kind: 'room', room: r.id, event: 'opened' }], conditions: [AFTER_DARK],
          actions: [{ kind: 'set', targets: on }, { kind: 'delay', seconds: 300 }, { kind: 'set', targets: off }],
          why: `${doors[0].name} opening after dark turns on ${what} for five minutes.` });
      }
    }
  }
  return out;
}
