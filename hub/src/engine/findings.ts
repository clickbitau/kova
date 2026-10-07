import type { Engine } from './engine.ts';
import type { Store } from '../store/db.ts';
import type { ConfigStore } from './config.ts';
import type { Command, Device, Mode, Targets } from '../model/types.ts';
import { isLight } from '../util/describe.ts';
import { addDays } from '../util/time.ts';
import { Learner } from './learn.ts';

export interface Finding {
  id: string;
  modeId: string;
  kind: string;
  icon: string;
  tone: 'alert' | 'check';
  title: string;
  body: string;
  fix: string;
  alt: string;
  /** What the toast says once fixed, when it isn't "<mode> updated". */
  done?: string;
  /** Learned from what people do (engine/learn.ts): "Not now" puts it off for a week, `never` says no for good. */
  learned?: boolean;
  never?: string;
  /** The automation it's about, for its own screen. */
  automationId?: string;
  /** The days it's based on, and what happened on each. */
  evidence?: { day: string; text: string }[];
  /** Other ways to apply it, each with an id of its own for /fix. */
  more?: { id: string; title: string; body: string; fix: string; done?: string }[];
}

export type DayResult = 'ok' | 'problem' | 'skipped' | 'none';

export interface ModeTest { days: DayResult[]; text: string }

const DAYS = 14;

/**
 * "Teach, test, trust": checks each mode two ways.
 *  - Statically, by walking the day's plan (a light one mode turns on that
 *    nothing turns off again stays on all night).
 *  - Against real history in the event log (a mode lit an empty house).
 */
export class Checker {
  readonly learner: Learner;

  constructor(private engine: Engine, private store: Store, private config: ConfigStore, private devices: () => Map<string, Device>, expand?: (t: Targets) => Record<string, Command>) {
    this.learner = new Learner(engine, store, config, devices, expand);
  }

  findings(): Finding[] {
    const dismissed = new Set(this.config.get().dismissedFindings);
    const learned = this.learner.suggestions().map(s => s.finding);
    return [...this.missing(), ...this.emptyHouse(), ...this.staysOn(), ...this.movieStarts(), ...learned].filter(f => !dismissed.has(f.id));
  }

  /** Modes pointing at devices Kova doesn't have (e.g. after swapping the demo for a real home). */
  private missing(): Finding[] {
    const devices = this.devices();
    if (!devices.size) return [];
    return this.config.get().modes.flatMap(m => {
      // A room's zone ("zone:lounge") isn't a device; it's gone only with its room.
      const rooms = this.config.get().rooms;
      const gone = Object.keys(m.targets).filter(id => id.startsWith('zone:') ? !rooms.some(r => r.id === id.slice(5)) : !devices.has(id));
      if (!gone.length) return [];
      return [{
        id: `missing:${m.id}`, modeId: m.id, kind: 'Check', icon: 'link_off', tone: 'alert' as const,
        title: `${m.name} uses ${gone.length} device${gone.length === 1 ? '' : 's'} Kova can’t find`,
        body: `${gone.slice(0, 4).join(', ')}${gone.length > 4 ? '…' : ''}. They may have been renamed or removed. Pick the right devices in the mode, or remove these.`,
        fix: 'Remove them', alt: 'Keep for now',
      }];
    });
  }

  /**
   * A TV that tells Kova when a film starts (a Helix box) and a Movie overlay that has to be started by hand:
   * offer to start it by itself, and end it when the film stops.
   */
  private movieStarts(): Finding[] {
    const c = this.config.get();
    const movie = c.overlays.find(o => o.id === 'movie') ?? c.overlays.find(o => /movie|film|cinema/i.test(o.name));
    if (!movie || movie.startsOn || !c.modes.length) return [];
    const tvs = [...this.devices().values()].filter(d => d.capabilities.includes('library') && !d.hidden);
    if (!tvs.length) return [];
    // The box in the room Movie already sets up, else the first one.
    const rooms = new Set(Object.keys(movie.targets).map(id => this.devices().get(id)?.room).filter(Boolean));
    const tv = tvs.find(d => rooms.has(d.room)) ?? tvs[0];
    const mode = c.modes.find(m => /evening|night/i.test(m.name)) ?? c.modes[0];
    const where = roomName(c, tv.room);
    return [{
      id: `movie-starts:${movie.id}:${tv.id}`, modeId: mode.id, kind: 'Suggestion', icon: 'movie', tone: 'check',
      title: `Start ${movie.name} when ${where && !tv.name.toLowerCase().includes(where.toLowerCase()) ? `the ${where.toLowerCase()} ` : ''}${tv.name} plays a film`,
      body: `${tv.name} tells Kova when something starts. ${movie.name} could start by itself then${movie.ends.kind === 'manual' || movie.ends.kind === 'device_off' ? ', and end when it stops' : ''}, instead of you starting it.`,
      fix: `Start ${movie.name} by itself`, alt: 'I’ll start it myself', done: `${movie.name} starts with ${tv.name} now`,
    }];
  }

  /** Lights left on across a mode that never mentions them, into a later mode. */
  private staysOn(): Finding[] {
    const c = this.config.get();
    const devices = this.devices();
    const seq = c.modes;
    const out: Finding[] = [];
    const seen = new Set<string>();
    // Walk the day in mode order and remember who last set each light, and to what.
    const lastSet = new Map<string, { mode: number; cmd: Command }>();
    const on = new Map<string, boolean>();
    seq.forEach((m, i) => {
      // Check what's still on as this mode starts, before applying its own targets.
      if (i >= 2) {
        for (const [id, isOn] of on) {
          const d = devices.get(id);
          const ls = lastSet.get(id);
          if (!d || !isOn || !ls || !isLight(d) || m.targets[id]) continue;
          const bright = ls.cmd.bri == null || ls.cmd.bri > 20;
          if (ls.mode >= i - 1 || !bright || seen.has(id)) continue;
          seen.add(id);
          const setter = seq[ls.mode], fixIn = seq[ls.mode + 1];
          const name = `${roomName(c, d.room)} ${d.name.toLowerCase()}`;
          out.push({
            id: `stays-on:${id}:${fixIn.id}`, modeId: fixIn.id, kind: 'Check', icon: 'lightbulb', tone: 'check',
            title: `${cap(name)} stays on all ${m.name.toLowerCase() === 'night' ? 'night' : `through ${m.name}`}`,
            body: `${setter.name} turns it on, but ${fixIn.name} doesn’t turn it off, so it stays on until ${nextOff(seq, id, i)?.name ?? 'someone turns it off'}. Is that on purpose?`,
            fix: `Turn it off in ${fixIn.name}`, alt: 'Keep it on',
          });
        }
      }
      for (const [id, cmd] of Object.entries(m.targets)) {
        lastSet.set(id, { mode: i, cmd });
        if (cmd.on !== undefined) on.set(id, cmd.on);
        else if (cmd.bri != null) on.set(id, true);
      }
    });
    return out;
  }

  /** Modes that switched lights on while nobody was home, from the event log. */
  private emptyHouse(): Finding[] {
    const out: Finding[] = [];
    for (const m of this.config.get().modes) {
      if (m.onlyWhenSomeoneHome) continue;
      const bad = this.runs(m).filter(r => r && !r.data.skipped && !r.data.anyoneHome && (r.data.lightsTurnedOn as number) > 0);
      if (!bad.length) continue;
      const n = Math.max(...bad.map(r => r!.data.lightsTurnedOn as number));
      out.push({
        id: `empty-house:${m.id}`, modeId: m.id, kind: 'Tested on history', icon: 'history', tone: 'alert',
        title: `${m.name} lights come on when nobody’s home`,
        body: `Over the last ${DAYS} days, ${n} light${n === 1 ? '' : 's'} lit an empty house on ${bad.length} ${bad.length === 1 ? 'day' : 'days'}.`,
        fix: 'Only when someone’s home', alt: 'Keep as is',
      });
    }
    return out;
  }

  /** This mode's start entry in the log for each of the last 14 Kova days (oldest first). */
  private runs(m: Mode) {
    const today = this.engine.planner.kovaDayAt(this.engine.now()).date;
    const out = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const kd = this.engine.planner.kovaDay(addDays(today, -i));
      const entry = this.store.between(kd.start, kd.end, 'mode').find(e => e.data.modeId === m.id);
      out.push(entry);
    }
    return out;
  }

  test(modeId: string): ModeTest {
    const m = this.config.get().modes.find(x => x.id === modeId);
    if (!m) return { days: [], text: '' };
    const runs = this.runs(m);
    const days: DayResult[] = runs.map(r => !r ? 'none'
      : r.data.skipped || r.data.waitForSomeone ? 'skipped'
      : !r.data.anyoneHome && (r.data.lightsTurnedOn as number) > 0 ? 'problem' : 'ok');
    const ran = days.filter(d => d !== 'none').length;
    const problems = days.filter(d => d === 'problem').length;
    const skipped = days.filter(d => d === 'skipped').length;
    const first = this.store.firstTs();
    let text: string;
    if (!ran) text = first ? 'Hasn’t run yet. Kova checks every run against what actually happened.' : 'No history yet. Kova checks every run against what actually happened.';
    else if (problems) text = `Ran ${ran} time${ran === 1 ? '' : 's'}. On ${problems} ${problems === 1 ? 'day' : 'days'} nobody was home, so lights lit an empty house.`;
    else text = `Ran ${ran} time${ran === 1 ? '' : 's'}${skipped ? ` and waited or skipped on ${skipped}` : ''}. No problems found.`;
    return { days, text };
  }

  /** Apply a finding's fix. Returns a function that undoes it. */
  fix(id: string): () => void {
    if (id.startsWith('learn:')) return this.learner.apply(id);
    const [kind, a, b] = id.split(':');
    if (kind === 'empty-house') return this.config.update(c => { const m = c.modes.find(x => x.id === a); if (m) m.onlyWhenSomeoneHome = true; });
    if (kind === 'missing') return this.config.update(c => { const m = c.modes.find(x => x.id === a); const devices = this.devices(); if (m) for (const id of Object.keys(m.targets)) if (id.startsWith('zone:') ? !c.rooms.some(r => r.id === id.slice(5)) : !devices.has(id)) delete m.targets[id]; });
    if (kind === 'movie-starts') {
      const tv = this.devices().get(b);
      return this.config.update(c => {
        const o = c.overlays.find(x => x.id === a);
        if (!o || !tv) return;
        o.startsOn = { device: tv.id, event: 'video-started' };
        if (o.ends.kind === 'manual' || o.ends.kind === 'device_off') { o.ends = { kind: 'device_off', device: tv.id }; o.endsLabel = `Ends when ${tv.name} stops`; }
      });
    }
    if (kind === 'stays-on') return this.config.update(c => { const m = c.modes.find(x => x.id === b); if (m) m.targets[a] = { on: false }; });
    throw new Error(`Unknown finding ${id}`);
  }

  /** "Not now" on a learned suggestion: it comes back in a week. Other findings have no "later". */
  snooze(id: string): () => void {
    if (!id.startsWith('learn:')) return this.dismiss(id);
    return this.learner.snooze(id);
  }

  /** Suggest it again: no longer put off or dismissed. */
  restore(id: string): () => void { return this.learner.restore(id); }

  dismiss(id: string): () => void {
    return this.config.update(c => { if (!c.dismissedFindings.includes(id)) c.dismissedFindings.push(id); });
  }
}

function nextOff(seq: Mode[], id: string, from: number): Mode | undefined {
  for (let k = 1; k <= seq.length; k++) {
    const m = seq[(from + k) % seq.length];
    if (m.targets[id]?.on === false) return m;
  }
  return undefined;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
function roomName(c: { rooms: { id: string; name: string }[] }, id: string) { return c.rooms.find(r => r.id === id)?.name ?? ''; }

