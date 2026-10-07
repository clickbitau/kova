import type { Action, Automation, Condition, Device, HomeConfig, StateMatch } from '../model/types.ts';

// Automations Kova suggests from how the home's devices are connected. Each one is an ordinary automation
// the owner adds, changes or ignores: nothing here runs by itself.

/**
 * A media player that sits on a TV (a Helix box on the TV's HDMI), and the soundbar that plays that TV: the TV input the
 * player is on (when known), and the soundbar inputs that carry the player's sound (the TV's eARC, the box's own feed).
 */
export interface Screen { player: string; tv: string; input?: string; soundbar?: string; soundbarInputs?: string[] }

export type Idea = Omit<Automation, 'id' | 'enabled'> & { key: string; why: string };

/**
 * "Still showing the player": on, on the player's input, and that input not changed by a person since. A TV whose
 * input the box's settings don't name counts only when Helix itself switched it last.
 */
const stillOnPlayer = (input?: string): StateMatch => input ? { on: true, input, inputByPerson: false } : { on: true, inputBy: 'helix-auto' };

/** The TV (and soundbar) off when the player goes offline, only while they still show it: the backstop for a box that dies. */
function tvOffParts(s: Screen, devices: Map<string, Device>): { conditions: Condition[]; actions: Action[] } {
  const bar = s.soundbar && devices.has(s.soundbar) ? s.soundbar : undefined;
  const barInputs = s.soundbarInputs?.length ? s.soundbarInputs : ['tv'];
  const actions: Action[] = [{ kind: 'set', targets: { [s.tv]: { on: false } } }];
  if (bar) {
    actions.push({
      kind: 'if',
      conditions: [
        { kind: 'device', device: bar, is: { on: true, inputByPerson: false } },
        { kind: 'any', conditions: barInputs.map(input => ({ kind: 'device' as const, device: bar, is: { input } })) },
      ],
      then: [{ kind: 'set', targets: { [bar]: { on: false } } }],
    });
  }
  return { conditions: [{ kind: 'device', device: s.tv, is: stillOnPlayer(s.input) }], actions };
}

export function automationIdeas(cfg: Pick<HomeConfig, 'automations' | 'dismissedFindings'>, devices: Map<string, Device>, screens: Screen[]): Idea[] {
  const out: Idea[] = [];
  const have = (cfg.automations ?? []) as Partial<Automation>[];
  for (const s of screens) {
    const player = devices.get(s.player), tv = devices.get(s.tv);
    if (!player || !tv) continue;
    const key = `tv-off-with:${s.player}`;
    // Already made (from this idea or by hand): started by this player going offline, turning this TV off.
    const made = have.some(a => (a.triggers ?? []).some(t => t.kind === 'device' && t.device === s.player && t.to?.online === false)
      && JSON.stringify(a.actions ?? []).includes(`"${s.tv}":{"on":false`));
    if (made || cfg.dismissedFindings.includes(`idea:${key}`)) continue;
    out.push({
      key, name: `${tv.name} off when ${player.name} shuts down`, mode: 'single',
      triggers: [{ kind: 'device', device: s.player, to: { online: false } }],
      ...tvOffParts(s, devices),
      why: s.input
        ? `Only while ${tv.name} is still on ${player.name}’s input and nobody switched it since, so it never turns off a TV someone is watching something else on.`
        : `Only while ${tv.name} is on and Helix switched it to ${player.name} last, so it never turns off a TV someone switched to something else.`,
    });
  }
  return out;
}

/**
 * Hub 0.7.6–0.7.43 made this automation with only "the TV is on (on the box's input)" as its condition: it turned off a
 * TV a person had switched back to the box, missed TVs whose input Kova can't read, and turned the soundbar off whatever
 * it played. An automation still exactly as Kova made it gets today's conditions; one the owner changed is left alone.
 */
export function upgradeTvOffWithBox(a: Automation, screens: Screen[], devices: Map<string, Device>): Automation | null {
  const [t, ...more] = a.triggers;
  if (more.length || t?.kind !== 'device' || JSON.stringify(t.to) !== '{"online":false}' || t.from || t.forSec) return null;
  const s = screens.find(x => x.player === t.device);
  if (!s || a.conditions.length !== 1 || a.actions.length !== 1) return null;
  const c = a.conditions[0], act = a.actions[0];
  if (c.kind !== 'device' || c.device !== s.tv) return null;
  const is = c.is as Record<string, unknown>;
  if (Object.keys(is).some(k => k !== 'on' && k !== 'input') || is.on !== true) return null;
  if (act.kind !== 'set') return null;
  const ids = Object.keys(act.targets);
  if (!ids.includes(s.tv) || ids.some(id => id !== s.tv && id !== s.soundbar) || ids.some(id => JSON.stringify(act.targets[id]) !== '{"on":false}')) return null;
  const input = typeof is.input === 'string' ? is.input : undefined;
  return { ...a, ...tvOffParts({ ...s, input, soundbar: s.soundbar && ids.includes(s.soundbar) ? s.soundbar : undefined }, devices) };
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

/**
 * Once: give the TV-off automations Kova made before today's conditions (upgradeTvOffWithBox), as soon as their
 * screens are known. Stops looking after `graceMs` either way.
 */
export function upgradeTvOffOnce(o: {
  done: () => boolean; markDone: () => void;
  automations: () => Automation[]; screens: () => Screen[]; devices: () => Map<string, Device>;
  save: (a: Automation) => void;
  graceMs?: number; on: (fn: () => void) => () => void;
}): void {
  if (o.done()) return;
  let off: () => void = () => {};
  const finish = () => { off(); clearTimeout(timer); o.markDone(); };
  const tryNow = () => {
    const screens = o.screens();
    if (!screens.length) return;
    for (const a of o.automations()) { const up = upgradeTvOffWithBox(a, screens, o.devices()); if (up) o.save(up); }
    finish();
  };
  const timer = setTimeout(finish, o.graceMs ?? 120_000);
  timer.unref?.();
  off = o.on(tryNow);
  tryNow();
}
