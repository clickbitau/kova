import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Hub } from '../hub.ts';
import type { Automation, Command, HomeConfig, MediaSource, OverlayEnd, Rhythm, Targets } from '../model/types.ts';
import { resolveRhythm, rhythmPhrase } from '../rhythms/rhythms.ts';
import { localDate } from '../util/time.ts';
import { checkAutomation } from '../engine/automation-check.ts';
import { isOneTime, nextOnce, upgradeAutomation } from '../engine/automations.ts';
const autoUpgrade = (a: object) => upgradeAutomation(a as Record<string, unknown>);
import { cleanTarget, validRhythm } from '../engine/validate.ts';
import { cleanZoneCommand } from '../util/zones.ts';

// Editing the home's behaviour: modes, moments, overlays, automations and media sources.
// Every edit returns an undo id, like device commands do.

/** How long Run now waits for a run to end before answering "running". */
const RUN_ANSWER_MS = 1500;

type Err = { error: string };

export function registerEditRoutes(app: FastifyInstance, hub: Hub): void {
  const edit = (fn: (c: HomeConfig) => void) => ({ undo: hub.engine.registerUndo(hub.config.update(fn)) });
  const bad = (reply: { code: (n: number) => { send: (b: Err) => unknown } }, e: unknown) =>
    reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });

  /** Validate a whole targets map against the devices Kova knows. */
  /** One target: a device, or "zone:<room>" for the air conditioner zone serving a room. */
  const cleanOne = (id: string, cmd: Command): Command => {
    const zm = /^zone:(.+)$/.exec(id);
    if (zm) {
      if (!hub.config.get().rooms.some(r => r.id === zm[1])) throw new Error(`Unknown room ${zm[1]}`);
      return cleanZoneCommand(cmd) as unknown as Command;
    }
    const d = hub.reg.get(id);
    if (!d) throw new Error(`Unknown device ${id}`);
    return cleanTarget(d, cmd);
  };
  const cleanTargets = (t: Targets): Targets => {
    const out: Targets = {};
    for (const [id, cmd] of Object.entries(t ?? {})) out[id] = cleanOne(id, cmd);
    return out;
  };

  const name = (v: unknown, max = 40) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
  const idFor = (label: string, taken: (id: string) => boolean, fallback: string) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || fallback;
    let id = base, n = 2;
    while (taken(id)) id = `${base}_${n++}`;
    return id;
  };
  const checkIcon = (v: unknown) => { if (typeof v !== 'string' || !/^[a-z0-9_]{1,40}$/.test(v)) throw new Error('That icon isn’t one Kova knows'); return v; };
  const checkColor = (v: unknown) => { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error('A colour is #rrggbb'); return v.toLowerCase(); };
  /** Automations that name a mode or an overlay, which would stop working without it. */
  const usedBy = (kind: 'mode' | 'overlay', id: string): string[] => {
    const hit = (o: unknown): boolean => {
      if (Array.isArray(o)) return o.some(hit);
      if (!o || typeof o !== 'object') return false;
      const x = o as Record<string, unknown>;
      if (kind === 'mode' && ((x.kind === 'mode' && (x.mode === id || (Array.isArray(x.modes) && x.modes.includes(id)))))) return true;
      if (kind === 'overlay' && x.kind === 'overlay' && x.overlay === id) return true;
      return Object.values(x).some(hit);
    };
    return (hub.config.get().automations ?? []).filter((a: Automation) => hit([a.triggers, a.conditions, a.actions])).map(a => a.name);
  };
  const inUse = (what: string, names: string[]) => `${what} is used by ${names.length === 1 ? 'the automation' : 'the automations'} ${names.map(n => `“${n}”`).join(', ')}. Change ${names.length === 1 ? 'it' : 'them'} first.`;

  // ---------------------------------------------------------------- modes --
  // A new mode goes into the day where its start falls (modes run in order through the day; the first starts it).
  // copyFrom starts it with another mode's targets.
  app.post<{ Body: { name?: string; icon?: string; color?: string; start?: Rhythm; copyFrom?: string } }>('/api/modes', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const n = name(b.name);
      if (!n) throw new Error('A mode needs a name');
      if (!validRhythm(b.start)) throw new Error('That start time isn’t valid');
      const cfg = hub.config.get();
      if (cfg.modes.some(m => m.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already a mode called ${n}`);
      const from = b.copyFrom === undefined ? undefined : cfg.modes.find(m => m.id === b.copyFrom);
      if (b.copyFrom !== undefined && !from) throw new Error('Unknown mode to copy from');
      const icon = b.icon === undefined ? 'routine' : checkIcon(b.icon);
      const color = b.color === undefined ? '#a3a09a' : checkColor(b.color);
      const id = idFor(n, x => cfg.modes.some(m => m.id === x), 'mode');
      const start = b.start;
      // Where it goes: after the modes that start before it, counted from the first mode's start today.
      const today = localDate(hub.engine.now(), cfg.timezone), DAY = 86_400_000;
      const t0 = resolveRhythm(cfg.modes[0].start, today, cfg) ?? 0;
      const rel = (r: Rhythm) => { const t = resolveRhythm(r, today, cfg); return t == null ? DAY : (((t - t0) % DAY) + DAY) % DAY; };
      const mine = rel(start);
      let at = cfg.modes.length;
      for (let i = 1; i < cfg.modes.length; i++) if (rel(cfg.modes[i].start) > mine) { at = i; break; }
      return { id, ...edit(c => { c.modes.splice(at, 0, { id, name: n, icon, color, start, targets: structuredClone(from?.targets ?? {}), ...(from?.lightTheWay ? { lightTheWay: true } : {}), ...(from?.onlyWhenSomeoneHome ? { onlyWhenSomeoneHome: true } : {}) }); }) };
    } catch (e) { return bad(reply, e); }
  });

  app.put<{ Params: { id: string }; Body: { name?: string; icon?: string; color?: string; start?: Rhythm; targets?: Targets; lightTheWay?: boolean; onlyWhenSomeoneHome?: boolean } }>('/api/modes/:id', async (req, reply) => {
    if (!hub.config.get().modes.some(m => m.id === req.params.id)) return reply.code(404).send({ error: 'unknown mode' });
    try {
      const b = req.body ?? {};
      if (b.start !== undefined && !validRhythm(b.start)) throw new Error('That start time isn’t valid');
      if (b.name !== undefined && !String(b.name).trim()) throw new Error('A mode needs a name');
      const n = b.name !== undefined ? name(b.name) : undefined;
      if (n && hub.config.get().modes.some(m => m.id !== req.params.id && m.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already a mode called ${n}`);
      const icon = b.icon !== undefined ? checkIcon(b.icon) : undefined;
      const color = b.color !== undefined ? checkColor(b.color) : undefined;
      const targets = b.targets !== undefined ? cleanTargets(b.targets) : undefined;
      return edit(c => {
        const m = c.modes.find(x => x.id === req.params.id)!;
        if (n) m.name = n;
        if (icon) m.icon = icon;
        if (color) m.color = color;
        if (b.start !== undefined) m.start = b.start;
        if (targets) m.targets = targets;
        if (b.lightTheWay !== undefined) m.lightTheWay = !!b.lightTheWay;
        if (b.onlyWhenSomeoneHome !== undefined) m.onlyWhenSomeoneHome = !!b.onlyWhenSomeoneHome;
      });
    } catch (e) { return bad(reply, e); }
  });

  /** Set (or with null, remove) one device's target in a mode or overlay. */
  const targetRoute = (kind: 'modes' | 'overlays') =>
    app.put<{ Params: { id: string; device: string }; Body: { target: Command | null } }>(`/api/${kind}/:id/targets/:device`, async (req, reply) => {
      const list = hub.config.get()[kind] as { id: string; targets: Targets }[];
      if (!list.some(x => x.id === req.params.id)) return reply.code(404).send({ error: `unknown ${kind.slice(0, -1)}` });
      try {
        const t = req.body?.target;
        const clean = t === null ? null : cleanOne(req.params.device, t);
        return edit(c => {
          const x = (c[kind] as { id: string; targets: Targets }[]).find(y => y.id === req.params.id)!;
          if (clean === null) delete x.targets[req.params.device];
          else x.targets[req.params.device] = clean;
        });
      } catch (e) { return bad(reply, e); }
    });
  targetRoute('modes');
  targetRoute('overlays');

  // The home needs at least one mode, and automations that name a mode keep working only while it's there.
  app.delete<{ Params: { id: string } }>('/api/modes/:id', async (req, reply) => {
    const cfg = hub.config.get(), m = cfg.modes.find(x => x.id === req.params.id);
    if (!m) return reply.code(404).send({ error: 'unknown mode' });
    if (cfg.modes.length < 2) return reply.code(400).send({ error: 'The home needs at least one mode' });
    const users = usedBy('mode', m.id);
    if (users.length) return reply.code(400).send({ error: inUse(m.name, users) });
    const r = edit(c => { c.modes = c.modes.filter(x => x.id !== m.id); });
    // Deleting the mode that's on now: carry on in whichever mode is on at this time without it (nothing changes now).
    if (hub.engine.modeId === m.id) hub.engine.modeId = hub.engine.planner.modeAt(hub.engine.now()).mode.id;
    return r;
  });

  // ------------------------------------------------------------- overlays --
  const endsCheck = (e: unknown): OverlayEnd => {
    const x = (e ?? {}) as Record<string, unknown>;
    if (x.kind === 'manual' || x.kind === 'arrival') return { kind: x.kind };
    if (x.kind === 'time') { if (!validRhythm(x.at)) throw new Error('That end time isn’t valid'); return { kind: 'time', at: x.at }; }
    if (x.kind === 'device_off') { const d = hub.reg.get(String(x.device ?? '')); if (!d) throw new Error('Pick the device whose switching off ends it'); return { kind: 'device_off', device: d.id }; }
    throw new Error('How it ends is manual, time, device_off or arrival');
  };
  const endsLabel = (e: OverlayEnd): string =>
    e.kind === 'manual' ? 'Ends when you end it'
      : e.kind === 'arrival' ? 'Ends when someone comes home'
        : e.kind === 'device_off' ? `Ends when the ${(hub.reg.get(e.device)?.name ?? e.device).toLowerCase()} turns off`
          : e.at.kind === 'time' && e.at.at === '00:00' ? 'Ends at midnight' : `Ends at ${rhythmPhrase(e.at)}`;
  type OverlayBody = { name?: string; icon?: string; ends?: OverlayEnd; allOff?: boolean; targets?: Targets; copyFrom?: string };
  app.post<{ Body: OverlayBody }>('/api/overlays', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const n = name(b.name);
      if (!n) throw new Error('An overlay needs a name');
      const cfg = hub.config.get();
      if (cfg.overlays.some(o => o.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already an overlay called ${n}`);
      const from = b.copyFrom === undefined ? undefined : cfg.overlays.find(o => o.id === b.copyFrom);
      if (b.copyFrom !== undefined && !from) throw new Error('Unknown overlay to copy from');
      const ends = b.ends === undefined ? from?.ends ?? { kind: 'manual' as const } : endsCheck(b.ends);
      const icon = b.icon === undefined ? from?.icon ?? 'layers' : checkIcon(b.icon);
      const targets = b.targets !== undefined ? cleanTargets(b.targets) : structuredClone(from?.targets ?? {});
      const id = idFor(n, x => cfg.overlays.some(o => o.id === x), 'overlay');
      const allOff = b.allOff ?? from?.allOff;
      return { id, ...edit(c => { c.overlays.push({ id, name: n, icon, ends, endsLabel: endsLabel(ends), targets, ...(allOff ? { allOff: true } : {}) }); }) };
    } catch (e) { return bad(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: OverlayBody }>('/api/overlays/:id', async (req, reply) => {
    if (!hub.config.get().overlays.some(o => o.id === req.params.id)) return reply.code(404).send({ error: 'unknown overlay' });
    try {
      const b = req.body ?? {};
      if (b.name !== undefined && !name(b.name)) throw new Error('An overlay needs a name');
      const n = b.name !== undefined ? name(b.name) : undefined;
      if (n && hub.config.get().overlays.some(o => o.id !== req.params.id && o.name.toLowerCase() === n.toLowerCase())) throw new Error(`There’s already an overlay called ${n}`);
      const icon = b.icon !== undefined ? checkIcon(b.icon) : undefined;
      const ends = b.ends !== undefined ? endsCheck(b.ends) : undefined;
      if (b.allOff !== undefined && typeof b.allOff !== 'boolean') throw new Error('allOff must be true or false');
      const targets = b.targets !== undefined ? cleanTargets(b.targets) : undefined;
      return edit(c => {
        const o = c.overlays.find(x => x.id === req.params.id)!;
        if (n) o.name = n;
        if (icon) o.icon = icon;
        if (ends) { o.ends = ends; o.endsLabel = endsLabel(ends); }
        if (b.allOff !== undefined) { if (b.allOff) o.allOff = true; else delete o.allOff; }
        if (targets) o.targets = targets;
      });
    } catch (e) { return bad(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/overlays/:id', async (req, reply) => {
    const o = hub.config.get().overlays.find(x => x.id === req.params.id);
    if (!o) return reply.code(404).send({ error: 'unknown overlay' });
    if (hub.engine.overlay?.id === o.id) return reply.code(400).send({ error: `${o.name} is on now. End it first.` });
    const users = usedBy('overlay', o.id);
    if (users.length) return reply.code(400).send({ error: inUse(o.name, users) });
    return edit(c => { c.overlays = c.overlays.filter(x => x.id !== o.id); });
  });

  // -------------------------------------------------------------- moments --
  type MomentBody = { label: string; what?: string; at: Rhythm; targets: Targets };
  const checkMoment = (b: MomentBody) => {
    if (!b?.label?.trim()) throw new Error('A moment needs a name');
    if (!validRhythm(b.at)) throw new Error('That time isn’t valid');
    const targets = cleanTargets(b.targets);
    if (!Object.keys(targets).length) throw new Error('A moment needs at least one device');
    return { label: b.label.trim(), what: b.what?.trim() ?? '', at: b.at, targets };
  };
  app.post<{ Body: MomentBody }>('/api/moments', async (req, reply) => {
    try {
      const m = checkMoment(req.body);
      const id = `${m.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'moment'}_${randomUUID().slice(0, 4)}`;
      return { id, ...edit(c => { c.moments.push({ id, ...m }); }) };
    } catch (e) { return bad(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: MomentBody }>('/api/moments/:id', async (req, reply) => {
    if (!hub.config.get().moments.some(m => m.id === req.params.id)) return reply.code(404).send({ error: 'unknown moment' });
    try {
      const m = checkMoment(req.body);
      return edit(c => { const i = c.moments.findIndex(x => x.id === req.params.id); c.moments[i] = { id: req.params.id, ...m }; });
    } catch (e) { return bad(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/moments/:id', async (req, reply) => {
    if (!hub.config.get().moments.some(m => m.id === req.params.id)) return reply.code(404).send({ error: 'unknown moment' });
    return edit(c => { c.moments = c.moments.filter(x => x.id !== req.params.id); });
  });

  // ---------------------------------------------------------- automations --
  // When (any trigger) / if (all conditions) / then (steps in order); engine/automations.ts runs them.
  const autos = () => hub.engine.automations.list();
  const checkCtx = (self?: string) => ({ device: (id: string) => hub.reg.get(id), cfg: hub.config.get(), self, now: hub.engine.now(), media: (m: string) => hub.mediaProblem(m) });
  const slug = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'automation'}_${randomUUID().slice(0, 4)}`;
  app.get('/api/automations', async () => ({ automations: autos().map(a => ({ ...a, lastRun: hub.engine.automations.lastRun(a.id) ?? null, running: hub.engine.automations.running(a.id) })) }));
  app.get<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    const a = autos().find(x => x.id === req.params.id);
    return a ? { automation: a, runs: hub.engine.automations.history(a.id) } : reply.code(404).send({ error: 'unknown automation' });
  });
  app.post<{ Body: unknown }>('/api/automations', async (req, reply) => {
    try {
      const a = checkAutomation(req.body, checkCtx());
      const id = slug(a.name);
      return { id, ...edit(c => { (c.automations ??= []).push({ id, ...a }); }) };
    } catch (e) { return bad(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: unknown }>('/api/automations/:id', async (req, reply) => {
    if (!autos().some(a => a.id === req.params.id)) return reply.code(404).send({ error: 'unknown automation' });
    try {
      const a = checkAutomation(req.body, checkCtx(req.params.id));
      return edit(c => { const l = c.automations!; l[l.findIndex(x => x.id === req.params.id)] = { id: req.params.id, ...a }; });
    } catch (e) { return bad(reply, e); }
  });
  // On or off without sending the whole thing.
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/automations/:id', async (req, reply) => {
    if (!autos().some(a => a.id === req.params.id)) return reply.code(404).send({ error: 'unknown automation' });
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    // A one-time schedule whose times have all gone by can't come back on without a new time.
    const cur = autos().find(a => a.id === req.params.id)!;
    if (req.body.enabled && isOneTime(cur) && nextOnce({ ...cur, enabled: true }, hub.config.get().timezone, hub.engine.now()) == null) {
      return reply.code(400).send({ error: 'That time has passed: choose a later one' });
    }
    return edit(c => { const x = c.automations!.find(y => y.id === req.params.id)!; Object.assign(x, autoUpgrade(x), { enabled: req.body.enabled! }); });
  });
  // Clear away one-time schedules that have run (or were missed).
  app.post('/api/automations/clear-done', async () => {
    const done = autos().filter(a => isOneTime(a) && a.triggers.every(t => t.kind === 'once' && t.firedAt)).map(a => a.id);
    const r = edit(c => { c.automations = (c.automations ?? []).filter(x => !done.includes(x.id)); });
    hub.engine.automations.prune();
    return { cleared: done.length, ...r };
  });
  app.post<{ Params: { id: string } }>('/api/automations/:id/duplicate', async (req, reply) => {
    const a = autos().find(x => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown automation' });
    const name = `${a.name} (copy)`.slice(0, 80), id = slug(name);
    return { id, ...edit(c => { const copy = structuredClone(a);
      // A copy of a one-time schedule is a fresh one: not yet run.
      for (const t of copy.triggers) if (t.kind === 'once') { delete t.firedAt; delete t.missed; }
      c.automations!.push({ ...copy, id, name, enabled: false, origin: undefined }); }) };
  });
  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    if (!autos().some(a => a.id === req.params.id)) return reply.code(404).send({ error: 'unknown automation' });
    const r = edit(c => { c.automations = c.automations!.filter(x => x.id !== req.params.id); });
    hub.engine.automations.prune();
    return r;
  });
  // Run now. With ?check=1 its conditions are checked first, as when a trigger starts it. Answers when the run
  // ends, or after a moment with `running: true` when it's still going (a wait or a delay): the history shows the rest.
  app.post<{ Params: { id: string }; Querystring: { check?: string } }>('/api/automations/:id/run', async (req, reply) => {
    const a = autos().find(x => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown automation' });
    const engine = hub.engine.automations;
    const going = req.query.check ? engine.start(a, 'Run by hand') : engine.runNow(a, 'Run by hand');
    going.catch(() => {});
    const quick = await Promise.race([going.then(run => ({ run })), new Promise<null>(r => setTimeout(() => r(null), RUN_ANSWER_MS).unref?.())]);
    if (!quick) return { ok: true, ran: true, running: true, run: engine.lastRun(a.id) ?? null };
    const run = quick.run;
    const last = engine.lastRun(a.id);
    if (!run) return { ok: false, ran: false, why: last?.result === 'skipped' ? last.detail : engine.running(a.id) ? 'It’s already running' : 'It didn’t start' };
    return { ok: run.result === 'done' || run.result === 'stopped', ran: true, run };
  });

  // -------------------------------------------------------------- sources --
  // Media sources (Tarateel, rain sounds…) need a stream address before speakers can play them.
  // Only what's sent changes: { url }, { loop } (a recording plays again when it ends), { icon }.
  // { helix: "<song name or id>" } plays a song from Helix as the sound, looped seamlessly; { helix: null } stops that.
  app.put<{ Params: { name: string }; Body: { url?: string; icon?: string; loop?: boolean; helix?: string | null } }>('/api/sources/:name', async (req, reply) => {
    const b = req.body ?? {};
    const url = typeof b.url === 'string' ? b.url.trim() : undefined;
    if (url && !/^https?:\/\/\S+$/.test(url)) return reply.code(400).send({ error: 'Use an http(s) stream address' });
    if (b.loop !== undefined && typeof b.loop !== 'boolean') return reply.code(400).send({ error: 'loop must be true or false' });
    let song: NonNullable<MediaSource['helix']> | null | undefined;
    if (typeof b.helix === 'string' && b.helix.trim()) {
      if (!hub.music) return reply.code(400).send({ error: 'Pair Kova with Helix first' });
      song = await hub.music.findSong(b.helix);
      if (!song) return reply.code(404).send({ error: `Helix has no song called “${b.helix.trim()}”` });
    } else if (b.helix === null) song = null;
    return edit(c => {
      let s = c.sources.find(x => x.name === req.params.name);
      if (!s) { s = { name: req.params.name, icon: b.icon ?? 'radio' }; c.sources.push(s); }
      if (song) { s.helix = song; s.loop = true; }
      else if (song === null) delete s.helix;
      if (url !== undefined) { s.url = url || undefined; if (url) delete s.helix; }
      if (b.icon) s.icon = b.icon;
      if (b.loop !== undefined) { if (b.loop) s.loop = true; else delete s.loop; }
    });
  });
  app.delete<{ Params: { name: string } }>('/api/sources/:name', async (req, reply) => {
    if (!hub.config.get().sources.some(s => s.name === req.params.name)) return reply.code(404).send({ error: 'unknown source' });
    return edit(c => { c.sources = c.sources.filter(s => s.name !== req.params.name); });
  });
}
