import type { Automation, AutomationIf, AutomationWhen, Device, HomeConfig, Targets } from '../model/types.ts';
import { targetLabel } from '../util/describe.ts';

// Automations Kova suggests from how the home's devices are connected. Each one is an ordinary automation
// the owner adds, changes or ignores: nothing here runs by itself.

/** A media player that sits on a TV (a Helix box on the TV's HDMI), and the soundbar that plays that TV. */
export interface Screen { player: string; tv: string; input?: string; soundbar?: string }

export type Idea = Omit<Automation, 'id' | 'enabled'> & { key: string; why: string };

export function automationIdeas(cfg: Pick<HomeConfig, 'automations' | 'dismissedFindings'>, devices: Map<string, Device>, screens: Screen[]): Idea[] {
  const out: Idea[] = [];
  const have = cfg.automations ?? [];
  for (const s of screens) {
    const player = devices.get(s.player), tv = devices.get(s.tv);
    if (!player || !tv) continue;
    const key = `tv-off-with:${s.player}`;
    // Already made (from this idea or by hand): the same start, turning the same TV off.
    if (have.some(a => a.when.device === s.player && 'becomes' in a.when && a.when.becomes === 'offline' && a.then[s.tv]?.on === false)) continue;
    if (cfg.dismissedFindings.includes(`idea:${key}`)) continue;
    const then: Targets = { [s.tv]: { on: false }, ...(s.soundbar && devices.has(s.soundbar) ? { [s.soundbar]: { on: false } } : {}) };
    const conds: AutomationIf[] = [{ device: s.tv, is: { on: true, ...(s.input ? { input: s.input } : {}) } }];
    out.push({
      key, name: `${tv.name} off when ${player.name} shuts down`,
      when: { device: s.player, becomes: 'offline' }, if: conds, then,
      why: s.input ? `Only while ${tv.name} is still on ${player.name}’s input, so it never turns off a TV someone is watching something else on.` : `Only while ${tv.name} is on.`,
    });
  }
  return out;
}

const BECOMES: Record<string, string> = { on: 'switches on', off: 'switches off', offline: 'shuts down or goes offline', online: 'comes back online' };
const INPUTS: Record<string, string> = { tv: 'TV', hdmi1: 'HDMI 1', hdmi2: 'HDMI 2', hdmi3: 'HDMI 3', hdmi4: 'HDMI 4', bluetooth: 'Bluetooth', wifi: 'Wi-Fi' };

/** "When Lounge box shuts down or goes offline", for lists. */
export function whenLabel(w: AutomationWhen, devices: Map<string, Device>): string {
  const n = devices.get(w.device)?.name ?? w.device;
  return 'becomes' in w ? `When ${n} ${BECOMES[w.becomes]}` : `When ${n}: ${w.event}`;
}

/** "Lounge TV is on HDMI 4". */
export function ifLabel(c: AutomationIf, devices: Map<string, Device>): string {
  const n = devices.get(c.device)?.name ?? c.device;
  const parts = [
    c.is.on !== undefined ? (c.is.on ? 'on' : 'off') : '',
    c.is.input ? `on ${INPUTS[c.is.input] ?? c.is.input}` : '',
    c.is.online !== undefined ? (c.is.online ? 'online' : 'offline') : '',
    c.is.hvac ? `set to ${c.is.hvac}` : '',
  ].filter(Boolean);
  return `${n} is ${parts.join(' and ').replace(/^on and on /, 'on ')}`;
}

/** What it does, one phrase per device. */
export function thenLabels(t: Targets, devices: Map<string, Device>): string[] {
  return Object.entries(t).map(([id, cmd]) => { const d = devices.get(id); return d ? targetLabel(d, cmd) : id; });
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
