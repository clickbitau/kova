import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.ts';
import type { AlertPrefs, HomeConfig, RoomEventKind } from '../model/types.ts';
import { ROOM_EVENTS } from '../engine/automation-check.ts';
import { cleanAlerts, NUMERIC_READINGS, type ReadingField } from '../util/sensors.ts';
import { cleanQuiet } from '../services/security.ts';
import { sensorViews } from '../services/sensors.ts';
import { timelineRows } from './snapshot.ts';
import { clock } from '../util/time.ts';

// Sensors, camera and room timelines with their kept frames, and the home's alert settings.

type Reply = { code: (n: number) => { send: (b: { error: string }) => unknown } };

export function registerSecurityRoutes(app: FastifyInstance, hub: Hub): void {
  const bad = (reply: Reply, msg: string, code = 400) => reply.code(code).send({ error: msg });
  const edit = (fn: (c: HomeConfig) => void) => ({ undo: hub.engine.registerUndo(hub.config.update(fn)) });

  // Every sensor, with its readings; `?history=1` adds each numeric reading's day ([time, value], oldest first).
  app.get<{ Querystring: { history?: string } }>('/api/sensors', async req => {
    const cfg = hub.config.get();
    const list = sensorViews(hub.reg.list(), cfg, hub.sensors);
    if (!req.query.history) return { sensors: list };
    return { sensors: list.map(s => ({ ...s, history: Object.fromEntries(s.readings.filter(r => NUMERIC_READINGS.includes(r.field)).map(r => [r.field, hub.sensors.history(s.id, r.field)])) })) };
  });

  // One reading's day for one device (a sensor, or a device that senses its room).
  app.get<{ Params: { id: string; field: string } }>('/api/sensors/:id/history/:field', async (req, reply) => {
    const d = hub.reg.get(req.params.id);
    if (!d) return bad(reply, 'Unknown device', 404);
    if (!NUMERIC_READINGS.includes(req.params.field as ReadingField)) return bad(reply, `${req.params.field} isn’t a reading with a history`);
    const tz = hub.config.get().timezone;
    return { device: d.id, field: req.params.field, points: hub.sensors.history(d.id, req.params.field as ReadingField).map(([t, v]) => ({ t, v, label: clock(t, tz) })) };
  });

  // What cameras and sensors saw: for one camera or sensor, one room, or the whole home; newest first, with frames.
  app.get<{ Querystring: { device?: string; room?: string; since?: string; until?: string; limit?: string; kinds?: string } }>('/api/timeline', async (req, reply) => {
    const q = req.query;
    if (q.device && !hub.reg.get(q.device)) return bad(reply, 'Unknown device', 404);
    if (q.room && !hub.config.get().rooms.some(r => r.id === q.room)) return bad(reply, 'Unknown room', 404);
    const kinds = q.kinds ? q.kinds.split(',').map(k => k.trim()).filter(Boolean) : undefined;
    if (kinds?.some(k => !ROOM_EVENTS.includes(k as RoomEventKind))) return bad(reply, `kinds are ${ROOM_EVENTS.join(', ')}`);
    const num = (v?: string) => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const events = hub.engine.rooms.timeline({ device: q.device, room: q.room, since: num(q.since), until: num(q.until), limit: num(q.limit) ?? 50, kinds: kinds as RoomEventKind[] | undefined });
    return { events: timelineRows(hub, events) };
  });

  // The picture kept with one camera event.
  app.get<{ Params: { device: string; id: string } }>('/api/frames/:device/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const f = Number.isInteger(id) ? hub.security.frame(req.params.device, id) : null;
    if (!f) return bad(reply, 'No picture for that event', 404);
    return reply.type(f.contentType).header('cache-control', 'private, max-age=86400').send(f.body);
  });

  // The home's alert settings and the latest decisions (sent, or why not).
  app.get('/api/security', async () => {
    const tz = hub.config.get().timezone;
    return { settings: hub.security.settings(), quietNow: hub.security.quietNow(), decisions: hub.security.recent(30).map(d => ({ ...d, atLabel: clock(d.at, tz) })) };
  });

  // Quiet hours, the cooldown, and per-room choices (a room's kinds merge; null clears one, or the whole room).
  app.put<{ Body: { quiet?: { from: string; to: string } | null; cooldownMin?: number; rooms?: Record<string, AlertPrefs | null> } }>('/api/security/settings', async (req, reply) => {
    const b = req.body ?? {};
    const cfg = hub.config.get();
    let quiet: ReturnType<typeof cleanQuiet> | undefined;
    if (b.quiet !== undefined) { try { quiet = cleanQuiet(b.quiet); } catch (e) { return bad(reply, (e as Error).message); } }
    if (b.cooldownMin !== undefined && !(typeof b.cooldownMin === 'number' && b.cooldownMin >= 0 && b.cooldownMin <= 240)) return bad(reply, 'cooldownMin is 0 to 240');
    const rooms: Record<string, AlertPrefs | null> = {};
    for (const [id, prefs] of Object.entries(b.rooms ?? {})) {
      if (!cfg.rooms.some(r => r.id === id)) return bad(reply, `Unknown room ${id}`);
      try { rooms[id] = prefs === null ? null : cleanAlerts(prefs); } catch (e) { return bad(reply, (e as Error).message); }
    }
    return edit(c => {
      const s = { ...(c.security ?? {}) };
      if (quiet !== undefined) { if (quiet) s.quiet = quiet; else delete s.quiet; }
      if (b.cooldownMin !== undefined) s.cooldownMin = Math.round(b.cooldownMin);
      if (Object.keys(rooms).length) {
        const all = { ...(s.rooms ?? {}) };
        for (const [id, prefs] of Object.entries(rooms)) {
          if (prefs === null) { delete all[id]; continue; }
          const merged: AlertPrefs = { ...(all[id] ?? {}), ...prefs };
          for (const [k, v] of Object.entries((b.rooms![id] ?? {}) as Record<string, unknown>)) if (v === null || v === '') delete merged[k as keyof AlertPrefs];
          if (Object.keys(merged).length) all[id] = merged; else delete all[id];
        }
        if (Object.keys(all).length) s.rooms = all; else delete s.rooms;
      }
      if (Object.keys(s).length) c.security = s; else delete c.security;
    });
  });
}
