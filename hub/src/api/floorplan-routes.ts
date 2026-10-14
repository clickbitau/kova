import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Hub } from '../hub.ts';
import type { FloorPlan, HomeConfig } from '../model/types.ts';
import { cleanFit, cleanPlan, fitRobot, robotAreaRooms } from '../util/floorplan.ts';
import { PHOTO_MAX } from './photo-routes.ts';

// The home's floor plan (Settings → Home → Floor plan, and the plan view of Devices): the plan itself, where a device
// is, the picture traced over, and lining a robot vacuum's map up with it so each of its areas gets its room. A change
// is shared with Warden (services/warden-link.ts) for its Wi-Fi survey.

const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** An area is given a room when at least this much of it lies in that room once lined up. */
const AREA_SHARE = 0.5;

export function registerFloorPlanRoutes(app: FastifyInstance, hub: Hub): void {
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
  const edit = (fn: (c: HomeConfig) => void) => { const undo = hub.engine.registerUndo(hub.config.update(fn)); hub.emit('changed'); hub.emit('floorplan'); return { undo }; };
  const plan = () => hub.config.get().floorPlan ?? null;
  const photos = () => (hub.dataDir ? join(hub.dataDir, 'photos') : null);
  // Pictures no longer used by the plan go (an undo that brings one back finds it gone and shows the plan without it).
  const tidy = (keep: string | null | undefined) => {
    const dir = photos();
    if (dir && existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith('floorplan-') && `/api/photo/${f}` !== keep) rmSync(join(dir, f), { force: true });
  };

  app.get('/api/home/floorplan', async () => ({ plan: plan() }));

  // The whole plan (null removes it). What it doesn't send of places, the picture and robots stays as it was.
  app.put<{ Body: Partial<FloorPlan> | null }>('/api/home/floorplan', async (req, reply) => {
    if (req.body === null) { const r = edit(c => { delete c.floorPlan; }); return { ok: true, ...r }; }
    const was = plan();
    const body = { places: was?.places, image: was?.image, robots: was?.robots, ...(req.body ?? {}) };
    const p = cleanPlan(body, hub.config.get().rooms.map(r => r.id));
    if (typeof p === 'string') return bad(reply, p);
    const r = edit(c => { c.floorPlan = p; });
    if (was?.image && was.image !== p.image) tidy(p.image);
    return { ok: true, plan: p, ...r };
  });

  // Where one device is (x, y in metres), or null to show it in its room again.
  app.put<{ Params: { id: string }; Body: { x?: number; y?: number } | null }>('/api/home/floorplan/places/:id', async (req, reply) => {
    const p = plan();
    if (!p) return reply.code(404).send({ error: 'There’s no floor plan yet' });
    if (!hub.reg.get(req.params.id)) return reply.code(404).send({ error: 'Unknown device' });
    const b = req.body;
    if (b === null) return { ok: true, ...edit(c => { if (c.floorPlan?.places) delete c.floorPlan.places[req.params.id]; }) };
    const x = Number(b?.x), y = Number(b?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > p.widthM || y > p.heightM) return bad(reply, 'x and y are a spot inside the plan, in metres');
    return { ok: true, ...edit(c => { if (c.floorPlan) c.floorPlan.places = { ...(c.floorPlan.places ?? {}), [req.params.id]: [Math.round(x * 100) / 100, Math.round(y * 100) / 100] }; }) };
  });

  // The picture of the plan, traced over (the apps shrink it first, like a person's photo).
  app.put('/api/home/floorplan/image', { bodyLimit: PHOTO_MAX }, async (req, reply) => {
    if (!plan()) return reply.code(404).send({ error: 'Set the plan’s size first' });
    const ext = TYPES[String(req.headers['content-type']).split(';')[0]!.trim()];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return bad(reply, 'Send a JPEG, PNG or WebP picture');
    const dir = photos();
    if (!dir) return reply.code(500).send({ error: 'This hub has nowhere to keep pictures' });
    mkdirSync(dir, { recursive: true });
    const file = `floorplan-${randomBytes(8).toString('hex')}.${ext}`;
    writeFileSync(join(dir, file), req.body, { mode: 0o600 });
    const image = `/api/photo/${file}`;
    const r = edit(c => { if (c.floorPlan) c.floorPlan.image = image; });
    tidy(image);
    return { ok: true, image, ...r };
  });
  app.delete('/api/home/floorplan/image', async () => {
    const r = edit(c => { if (c.floorPlan) delete c.floorPlan.image; });
    tidy(null);
    return { ok: true, ...r };
  });

  // Line a robot vacuum's map up with the plan: how it fits, how well, and the room each of its areas would get.
  // Nothing changes until it's saved (PUT below).
  const robotMap = (id: string) => {
    const d = hub.reg.get(id);
    const a = d && hub.reg.adapters.get(d.adapter);
    return d && d.type === 'vacuum' ? { d, map: a?.floorMap?.(d) ?? null } : null;
  };
  app.post<{ Params: { id: string } }>('/api/home/floorplan/robots/:id/fit', async (req, reply) => {
    const p = plan();
    if (!p) return reply.code(404).send({ error: 'There’s no floor plan yet' });
    const r = robotMap(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Unknown robot vacuum' });
    if (!r.map) return reply.code(409).send({ error: `${r.d.name} hasn’t sent its map yet` });
    const f = fitRobot(r.map, p);
    if (!f) return reply.code(409).send({ error: 'The plan needs rooms inside the home first' });
    return { ...f, good: f.score >= 0.75, areas: areasFor(p, r.map, f.fit) };
  });

  // Keep a fit, and (rooms: true) give each area the room it's mostly in. One undo puts both back.
  app.put<{ Params: { id: string }; Body: { fit?: unknown; rooms?: boolean } }>('/api/home/floorplan/robots/:id', async (req, reply) => {
    const p = plan();
    if (!p) return reply.code(404).send({ error: 'There’s no floor plan yet' });
    const r = robotMap(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Unknown robot vacuum' });
    const fit = cleanFit(req.body?.fit);
    if (!fit) return bad(reply, 'fit is { rot, flip, dx, dy }');
    const areas = req.body?.rooms && r.map ? areasFor(p, r.map, fit).filter(a => a.room && a.share >= AREA_SHARE) : [];
    const res = edit(c => {
      if (!c.floorPlan) return;
      c.floorPlan.robots = { ...(c.floorPlan.robots ?? {}), [r.d.id]: fit };
      if (areas.length) {
        const s = (c.devices ??= {})[r.d.id] ??= {};
        s.areaRooms = { ...(s.areaRooms ?? {}), ...Object.fromEntries(areas.map(a => [a.id, a.room!])) };
      }
    });
    return { ok: true, rooms: areas.length, ...res };
  });

  function areasFor(p: FloorPlan, map: NonNullable<ReturnType<typeof robotMap>>['map'] & object, fit: Parameters<typeof robotAreaRooms>[2]) {
    const names = new Map(hub.config.get().rooms.map(r => [r.id, r.name]));
    return robotAreaRooms(map, p, fit).map(a => ({ ...a, planRoomName: p.rooms.find(r => r.id === a.planRoom)?.name ?? null, roomName: a.room ? names.get(a.room) ?? a.room : null }));
  }
}
