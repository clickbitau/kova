import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Hub } from '../hub.ts';
import type { Command, HomeConfig, Rhythm, Targets } from '../model/types.ts';
import { checkAutomation } from '../engine/automation-check.ts';
import { upgradeAutomation } from '../engine/automations.ts';
const autoUpgrade = (a: object) => upgradeAutomation(a as Record<string, unknown>);
import { cleanTarget, validRhythm } from '../engine/validate.ts';

// Editing the home's behaviour: modes, moments, overlays and media sources.
// Every edit returns an undo id, like device commands do.

type Err = { error: string };

export function registerEditRoutes(app: FastifyInstance, hub: Hub): void {
  const edit = (fn: (c: HomeConfig) => void) => ({ undo: hub.engine.registerUndo(hub.config.update(fn)) });
  const bad = (reply: { code: (n: number) => { send: (b: Err) => unknown } }, e: unknown) =>
    reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });

  /** Validate a whole targets map against the devices Kova knows. */
  const cleanTargets = (t: Targets): Targets => {
    const out: Targets = {};
    for (const [id, cmd] of Object.entries(t ?? {})) {
      const d = hub.reg.get(id);
      if (!d) throw new Error(`Unknown device ${id}`);
      out[id] = cleanTarget(d, cmd);
    }
    return out;
  };

  // ---------------------------------------------------------------- modes --
  app.put<{ Params: { id: string }; Body: { name?: string; start?: Rhythm; targets?: Targets; lightTheWay?: boolean; onlyWhenSomeoneHome?: boolean } }>('/api/modes/:id', async (req, reply) => {
    if (!hub.config.get().modes.some(m => m.id === req.params.id)) return reply.code(404).send({ error: 'unknown mode' });
    try {
      const b = req.body ?? {};
      if (b.start !== undefined && !validRhythm(b.start)) throw new Error('That start time isn’t valid');
      if (b.name !== undefined && !String(b.name).trim()) throw new Error('A mode needs a name');
      const targets = b.targets !== undefined ? cleanTargets(b.targets) : undefined;
      return edit(c => {
        const m = c.modes.find(x => x.id === req.params.id)!;
        if (b.name !== undefined) m.name = String(b.name).trim();
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
        const d = hub.reg.get(req.params.device);
        const t = req.body?.target;
        if (t !== null && !d) throw new Error(`Unknown device ${req.params.device}`);
        const clean = t === null ? null : cleanTarget(d!, t);
        return edit(c => {
          const x = (c[kind] as { id: string; targets: Targets }[]).find(y => y.id === req.params.id)!;
          if (clean === null) delete x.targets[req.params.device];
          else x.targets[req.params.device] = clean;
        });
      } catch (e) { return bad(reply, e); }
    });
  targetRoute('modes');
  targetRoute('overlays');

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
  const checkCtx = (self?: string) => ({ device: (id: string) => hub.reg.get(id), cfg: hub.config.get(), self });
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
    return edit(c => { const x = c.automations!.find(y => y.id === req.params.id)!; Object.assign(x, autoUpgrade(x), { enabled: req.body.enabled! }); });
  });
  app.post<{ Params: { id: string } }>('/api/automations/:id/duplicate', async (req, reply) => {
    const a = autos().find(x => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown automation' });
    const name = `${a.name} (copy)`.slice(0, 80), id = slug(name);
    return { id, ...edit(c => { c.automations!.push({ ...structuredClone(a), id, name, enabled: false, origin: undefined }); }) };
  });
  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    if (!autos().some(a => a.id === req.params.id)) return reply.code(404).send({ error: 'unknown automation' });
    const r = edit(c => { c.automations = c.automations!.filter(x => x.id !== req.params.id); });
    hub.engine.automations.prune();
    return r;
  });
  // Run now. With ?check=1 its conditions are checked first, as when a trigger starts it.
  app.post<{ Params: { id: string }; Querystring: { check?: string } }>('/api/automations/:id/run', async (req, reply) => {
    const a = autos().find(x => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'unknown automation' });
    const engine = hub.engine.automations;
    const run = req.query.check ? await engine.start(a, 'Run by hand') : await engine.runNow(a, 'Run by hand');
    const last = engine.lastRun(a.id);
    if (!run) return { ok: false, ran: false, why: last?.result === 'skipped' ? last.detail : engine.running(a.id) ? 'It’s already running' : 'It didn’t start' };
    return { ok: run.result === 'done' || run.result === 'stopped', ran: true, run };
  });

  // -------------------------------------------------------------- sources --
  // Media sources (Tarateel, rain sounds…) need a stream address before speakers can play them.
  app.put<{ Params: { name: string }; Body: { url?: string; icon?: string } }>('/api/sources/:name', async (req, reply) => {
    const url = req.body?.url?.trim();
    if (url && !/^https?:\/\/\S+$/.test(url)) return reply.code(400).send({ error: 'Use an http(s) stream address' });
    return edit(c => {
      const s = c.sources.find(x => x.name === req.params.name);
      if (s) { s.url = url || undefined; if (req.body.icon) s.icon = req.body.icon; }
      else c.sources.push({ name: req.params.name, icon: req.body?.icon ?? 'radio', url: url || undefined });
    });
  });
  app.delete<{ Params: { name: string } }>('/api/sources/:name', async (req, reply) => {
    if (!hub.config.get().sources.some(s => s.name === req.params.name)) return reply.code(404).send({ error: 'unknown source' });
    return edit(c => { c.sources = c.sources.filter(s => s.name !== req.params.name); });
  });
}
