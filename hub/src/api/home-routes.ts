import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.ts';
import { ROOM_ICONS, type HomeConfig } from '../model/types.ts';
import { groupDeviceId } from '../adapters/groups.ts';
import { combinedDeviceId } from '../adapters/combined.ts';
import { isPlayer } from '../util/describe.ts';
import { slug } from '../tools/import-ha.ts';
import { cleanAlerts, isCamera, isSensor } from '../util/sensors.ts';
import type { AlertPrefs } from '../model/types.ts';

// Customising the home: its name, rooms, people, favourites, and each device's name, room and
// visibility. Settings live in the home config (so every phone sees the same), and every change
// returns an undo id.

type Reply = { code: (n: number) => { send: (b: { error: string }) => unknown } };
/** How prayer times can be worked out (adhan's calculation methods). */
export const PRAYER_METHODS = ['MuslimWorldLeague', 'Egyptian', 'Karachi', 'UmmAlQura', 'Dubai', 'MoonsightingCommittee', 'NorthAmerica', 'Kuwait', 'Qatar', 'Singapore', 'Tehran', 'Turkey'];

export function registerHomeRoutes(app: FastifyInstance, hub: Hub): void {
  const edit = (fn: (c: HomeConfig) => void) => ({ undo: hub.engine.registerUndo(hub.config.update(fn)) });
  const bad = (reply: Reply, msg: string, code = 400) => reply.code(code).send({ error: msg });
  const text = (v: unknown, max = 60) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';

  app.get('/api/home/room-icons', async () => ({ icons: ROOM_ICONS }));

  // The home's details: only what's sent changes. Location and timezone move sun and prayer times; the prayer
  // method decides how prayer times are worked out.
  app.put<{ Body: { name?: string; address?: string | null; timezone?: string; latitude?: number; longitude?: number; location?: { latitude?: number; longitude?: number; radiusM?: number; source?: string }; prayerMethod?: string; pauseForDoorbell?: boolean } }>('/api/home', async (req, reply) => {
    const b = req.body ?? {};
    const name = b.name === undefined ? undefined : text(b.name);
    if (name === '') return bad(reply, 'Give the home a name');
    if (b.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { return bad(reply, `${b.timezone} isn’t a timezone (e.g. Australia/Perth)`); }
    }
    const latitude = b.location?.latitude ?? b.latitude;
    const longitude = b.location?.longitude ?? b.longitude;
    if ((latitude === undefined) !== (longitude === undefined)) return bad(reply, 'Send latitude and longitude together');
    if (latitude !== undefined && !(typeof latitude === 'number' && Math.abs(latitude) <= 90 && typeof longitude === 'number' && Math.abs(longitude) <= 180)) return bad(reply, 'Latitude is −90 to 90, longitude −180 to 180');
    if (b.location?.radiusM !== undefined && !(typeof b.location.radiusM === 'number' && b.location.radiusM >= 50 && b.location.radiusM <= 1000)) return bad(reply, 'location.radiusM is 50–1000');
    if (b.location?.source !== undefined && !['manual', 'geocode', 'phone', 'import'].includes(b.location.source)) return bad(reply, 'location.source is manual, geocode, phone or import');
    if (b.prayerMethod !== undefined && !PRAYER_METHODS.includes(b.prayerMethod)) return bad(reply, `Prayer method is one of ${PRAYER_METHODS.join(', ')}`);
    if (b.pauseForDoorbell !== undefined && typeof b.pauseForDoorbell !== 'boolean') return bad(reply, 'pauseForDoorbell must be true or false');
    return edit(c => {
      if (name) c.name = name;
      if (b.address !== undefined) { const a = b.address ? text(b.address, 200) : ''; if (a) c.address = a; else delete c.address; }
      if (b.timezone) c.timezone = b.timezone;
      if (latitude !== undefined) {
        const lat = Math.round(latitude * 1e5) / 1e5, lon = Math.round(longitude! * 1e5) / 1e5;
        c.latitude = lat; c.longitude = lon;
        c.location = { latitude: lat, longitude: lon, ...(b.location?.radiusM !== undefined ? { radiusM: Math.round(b.location.radiusM) } : c.location?.radiusM ? { radiusM: c.location.radiusM } : {}), source: (b.location?.source ?? 'manual') as 'manual' | 'geocode' | 'phone' | 'import', updatedAt: hub.engine.now() };
      } else if (b.location) {
        c.location = { latitude: c.location?.latitude ?? c.latitude, longitude: c.location?.longitude ?? c.longitude, ...(b.location.radiusM !== undefined ? { radiusM: Math.round(b.location.radiusM) } : c.location?.radiusM ? { radiusM: c.location.radiusM } : {}), source: (b.location.source ?? c.location?.source ?? 'manual') as 'manual' | 'geocode' | 'phone' | 'import', updatedAt: hub.engine.now() };
      }
      if (b.prayerMethod) c.prayerMethod = b.prayerMethod;
      if (b.pauseForDoorbell !== undefined) c.pauseForDoorbell = b.pauseForDoorbell;
    });
  });

  // Finding the home's address (Settings): Google Maps when a server-side key is configured, otherwise OpenStreetMap's
  // Nominatim. Both go through the hub so no API key is ever in a phone/browser app. Answers are cached for a day.
  const geoCache = new Map<string, { at: number; results: unknown[] }>();
  let geoLast = 0;
  app.get<{ Querystring: { q?: string } }>('/api/geocode', async (req, reply) => {
    const q = text(req.query.q, 200);
    if (q.length < 4) return bad(reply, 'Type more of the address');
    const googleKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.KOVA_GOOGLE_MAPS_API_KEY;
    const cf = hub.config.get(), key = `${googleKey ? 'google' : 'osm'}:${q.toLowerCase()}@${Math.round(cf.latitude)},${Math.round(cf.longitude)}`;
    const hit = geoCache.get(key);
    if (hit && Date.now() - hit.at < 86_400_000) return { results: hit.results };
    const wait = geoLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    geoLast = Date.now();
    try {
      // Matches near where the home already is come first (a box ±3° around it, not a limit), so a street name that
      // exists in many countries finds the local one.
      if (googleKey) {
        try {
          const c = hub.config.get();
          const params: Record<string, string> = { address: q, key: googleKey, language: req.headers['accept-language'] ?? 'en' };
          if (c.latitude || c.longitude) params.bounds = `${c.latitude - 3},${c.longitude - 3}|${c.latitude + 3},${c.longitude + 3}`;
          const u = `https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams(params)}`;
          const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const j = await res.json() as { status: string; results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[] };
            if (j.status === 'OK' || j.status === 'ZERO_RESULTS') {
              const results = (j.results ?? []).map(r => ({ label: r.formatted_address ?? '', latitude: Number(r.geometry?.location?.lat), longitude: Number(r.geometry?.location?.lng) })).filter(r => r.label && Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
              geoCache.set(key, { at: Date.now(), results });
              return { results };
            }
          }
        } catch { /* fall back to OpenStreetMap below */ }
      }
      const c = hub.config.get(), near: Record<string, string> = c.latitude || c.longitude ? { viewbox: [c.longitude - 3, c.latitude + 3, c.longitude + 3, c.latitude - 3].map(n => n.toFixed(3)).join(','), bounded: '0' } : {};
      const u = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '0', ...near })}`;
      const res = await fetch(u, { headers: { 'User-Agent': 'Kova (https://github.com/clickbitau/kova)', 'Accept-Language': req.headers['accept-language'] ?? 'en' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return bad(reply, `The address search answered HTTP ${res.status}`, 502);
      const results = ((await res.json()) as { display_name: string; lat: string; lon: string }[]).map(r => ({ label: r.display_name, latitude: Number(r.lat), longitude: Number(r.lon) }));
      geoCache.set(key, { at: Date.now(), results });
      return { results };
    } catch { return bad(reply, 'Couldn’t reach the address search: is the hub online?', 502); }
  });

  // Not now: an alert or warning on the Now page goes quiet for so many hours (24 by default).
  app.post<{ Params: { id: string }; Body: { hours?: number } }>('/api/insights/:id/snooze', async (req, reply) => {
    const hours = req.body?.hours == null ? 24 : Number(req.body.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) return bad(reply, 'hours is 1 to 720');
    hub.insights.snooze(req.params.id, hours);
    hub.emit('changed');
    return { ok: true };
  });

  // ---------------------------------------------------------------- devices --
  app.patch<{ Params: { id: string }; Body: { name?: string | null; room?: string | null; hidden?: boolean; favourite?: boolean; watts?: number | null; zoneNames?: Record<string, string | null>; outdoor?: boolean | null; alerts?: AlertPrefs | null } }>('/api/devices/:id/settings', async (req, reply) => {
    const d = hub.reg.get(req.params.id);
    if (!d) return bad(reply, 'Unknown device', 404);
    const b = req.body ?? {};
    if (b.room != null && !hub.config.get().rooms.some(r => r.id === b.room)) return bad(reply, 'Unknown room');
    if (b.name !== undefined && b.name !== null && !text(b.name)) return bad(reply, 'Give it a name');
    if (b.watts != null && !(typeof b.watts === 'number' && b.watts >= 0 && b.watts <= 10_000)) return bad(reply, 'watts must be 0–10000');
    // Cameras and sensors: inside or outside, and when their events alert.
    const watched = isCamera(d) || isSensor(d);
    if (b.outdoor !== undefined && b.outdoor !== null && typeof b.outdoor !== 'boolean') return bad(reply, 'outdoor must be true, false or null');
    if ((b.outdoor != null || b.alerts) && !watched) return bad(reply, `${d.name} isn’t a camera or sensor`);
    let alerts: AlertPrefs | null | undefined;
    if (b.alerts !== undefined) { try { alerts = b.alerts === null ? null : cleanAlerts(b.alerts); } catch (e) { return bad(reply, (e as Error).message); } }
    if (b.zoneNames !== undefined) {
      if (!d.capabilities.includes('zones')) return bad(reply, `${d.name} has no zones`);
      if (!b.zoneNames || typeof b.zoneNames !== 'object' || Object.keys(b.zoneNames).some(n => !/^[1-9]\d?$/.test(n))) return bad(reply, 'zoneNames is { "1": "Living", … }');
    }
    return edit(c => {
      const s = { ...(c.devices?.[d.id] ?? {}) };
      const orig = d.original ?? { name: d.name, room: d.room };
      if (b.name !== undefined) { const n = b.name === null ? '' : text(b.name); if (!n || n === orig.name) delete s.name; else s.name = n; }
      if (b.room !== undefined) { if (!b.room || b.room === orig.room) delete s.room; else s.room = b.room; }
      if (b.hidden !== undefined) { if (b.hidden) s.hidden = true; else delete s.hidden; }
      if (b.watts !== undefined) { if (b.watts == null) delete s.watts; else s.watts = Math.round(b.watts); }
      if (b.outdoor !== undefined) { if (b.outdoor == null) delete s.outdoor; else s.outdoor = b.outdoor; }
      // Alerts merge by kind: a choice sets it, null clears it (back to the room's or Kova's).
      if (alerts === null) delete s.alerts;
      else if (alerts) {
        const raw = b.alerts as Record<string, unknown>;
        const merged: AlertPrefs = { ...(s.alerts ?? {}), ...alerts };
        for (const [k, v] of Object.entries(raw)) if (v === null || v === '') delete merged[k as keyof AlertPrefs];
        if (Object.keys(merged).length) s.alerts = merged; else delete s.alerts;
      }
      // Zone names merge: a name sets it, null or "" clears it.
      if (b.zoneNames) {
        const z = { ...(s.zoneNames ?? {}) };
        for (const [n, v] of Object.entries(b.zoneNames)) { const t = v ? text(v, 30) : ''; if (t) z[n] = t; else delete z[n]; }
        if (Object.keys(z).length) s.zoneNames = z; else delete s.zoneNames;
      }
      c.devices = { ...(c.devices ?? {}) };
      if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
      if (b.favourite !== undefined) {
        const f = (c.favourites ?? []).filter(x => x !== d.id);
        c.favourites = b.favourite ? [...f, d.id] : f;
      }
    });
  });

  app.put<{ Body: { ids?: string[] } }>('/api/favourites', async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body!.ids.map(String))] : null;
    if (!ids) return bad(reply, 'ids is required');
    const unknown = ids.find(id => !hub.reg.get(id));
    if (unknown) return bad(reply, `Unknown device ${unknown}`);
    return edit(c => { c.favourites = ids; });
  });

  // ------------------------------------------------------------------ rooms --
  app.post<{ Body: { name?: string; icon?: string } }>('/api/rooms', async (req, reply) => {
    const name = text(req.body?.name, 40);
    if (!name) return bad(reply, 'Give the room a name');
    const rooms = hub.config.get().rooms;
    let id = slug(name) || 'room', n = 2;
    while (rooms.some(r => r.id === id)) id = `${slug(name) || 'room'}_${n++}`;
    const icon = ROOM_ICONS.includes(String(req.body?.icon)) ? String(req.body!.icon) : 'meeting_room';
    return { id, ...edit(c => { c.rooms.push({ id, name, icon }); }) };
  });

  // Order first, so "order" isn't taken for a room id.
  app.put<{ Body: { ids?: string[] } }>('/api/rooms/order', async (req, reply) => {
    const ids = req.body?.ids ?? [];
    const rooms = hub.config.get().rooms;
    if (ids.length !== rooms.length || !rooms.every(r => ids.includes(r.id))) return bad(reply, 'Send every room id once, in the new order');
    return edit(c => { c.rooms = ids.map(id => c.rooms.find(r => r.id === id)!); });
  });

  app.put<{ Params: { id: string }; Body: { name?: string; icon?: string; outdoor?: boolean | null } }>('/api/rooms/:id', async (req, reply) => {
    if (!hub.config.get().rooms.some(r => r.id === req.params.id)) return bad(reply, 'Unknown room', 404);
    const name = req.body?.name === undefined ? undefined : text(req.body.name, 40);
    if (name === '') return bad(reply, 'Give the room a name');
    const icon = req.body?.icon;
    if (icon !== undefined && !ROOM_ICONS.includes(icon)) return bad(reply, 'Unknown icon');
    const outdoor = req.body?.outdoor;
    if (outdoor !== undefined && outdoor !== null && typeof outdoor !== 'boolean') return bad(reply, 'outdoor must be true, false or null');
    return edit(c => {
      const r = c.rooms.find(x => x.id === req.params.id)!;
      if (name) r.name = name; if (icon) r.icon = icon;
      // Outside the living space (a porch, the yard): its cameras' and sensors' events aren't someone inside.
      if (outdoor === null) delete r.outdoor; else if (outdoor !== undefined) r.outdoor = outdoor;
    });
  });

  // Devices still in the room move to `moveTo`; without it, a room with devices can't be deleted.
  app.delete<{ Params: { id: string }; Body: { moveTo?: string } }>('/api/rooms/:id', async (req, reply) => {
    const id = req.params.id, cfg = hub.config.get();
    if (!cfg.rooms.some(r => r.id === id)) return bad(reply, 'Unknown room', 404);
    const inside = hub.reg.list().filter(d => d.room === id);
    const moveTo = req.body?.moveTo;
    if (inside.length && !moveTo) return bad(reply, `${inside.length} device${inside.length === 1 ? ' is' : 's are'} in this room. Choose where ${inside.length === 1 ? 'it goes' : 'they go'}.`);
    if (moveTo && (moveTo === id || !cfg.rooms.some(r => r.id === moveTo))) return bad(reply, 'Unknown room to move devices to');
    return edit(c => {
      c.rooms = c.rooms.filter(r => r.id !== id);
      c.devices = { ...(c.devices ?? {}) };
      for (const d of inside) {
        const orig = d.original?.room ?? d.room;
        const s = { ...(c.devices[d.id] ?? {}) };
        if (moveTo === orig) delete s.room; else s.room = moveTo;
        if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
      }
      for (const [g, rooms] of Object.entries(c.groups)) c.groups[g] = rooms.filter(r => r !== id);
    });
  });

  // --------------------------------------------------------- speaker groups --
  // Any speakers, any brands, played as one. Members must be speakers or TVs (not other groups).
  const checkMembers = (members: unknown): string | null => {
    if (!Array.isArray(members)) return 'Pick the speakers';
    const ids = [...new Set(members.map(String))];
    if (ids.length < 2) return 'Pick at least two speakers';
    for (const id of ids) {
      const d = hub.reg.get(id);
      if (!d || !isPlayer(d) || d.adapter === 'groups') return `${d?.name ?? id} can’t be in a speaker group`;
    }
    return null;
  };
  app.post<{ Body: { name?: string; members?: string[]; room?: string } }>('/api/speaker-groups', async (req, reply) => {
    const name = text(req.body?.name, 40);
    if (!name) return bad(reply, 'Give the group a name');
    const err = checkMembers(req.body?.members);
    if (err) return bad(reply, err);
    const room = req.body?.room && hub.config.get().rooms.some(r => r.id === req.body!.room) ? req.body.room : undefined;
    const groups = hub.config.get().speakerGroups ?? [];
    let id = slug(name) || 'group', n = 2;
    while (groups.some(g => g.id === id)) id = `${slug(name) || 'group'}_${n++}`;
    const r = edit(c => { c.speakerGroups = [...(c.speakerGroups ?? []), { id, name, members: [...new Set(req.body!.members!.map(String))], ...(room ? { room } : {}) }]; });
    return { id, deviceId: groupDeviceId({ id, name, members: [] }), ...r };
  });
  app.put<{ Params: { id: string }; Body: { name?: string; members?: string[]; room?: string | null } }>('/api/speaker-groups/:id', async (req, reply) => {
    if (!(hub.config.get().speakerGroups ?? []).some(g => g.id === req.params.id)) return bad(reply, 'Unknown group', 404);
    const name = req.body?.name === undefined ? undefined : text(req.body.name, 40);
    if (name === '') return bad(reply, 'Give the group a name');
    if (req.body?.members !== undefined) { const err = checkMembers(req.body.members); if (err) return bad(reply, err); }
    if (req.body?.room && !hub.config.get().rooms.some(r => r.id === req.body!.room)) return bad(reply, 'Unknown room');
    return edit(c => {
      const g = (c.speakerGroups ?? []).find(x => x.id === req.params.id)!;
      if (name) g.name = name;
      if (req.body?.members) g.members = [...new Set(req.body.members.map(String))];
      if (req.body?.room !== undefined) { if (req.body.room) g.room = req.body.room; else delete g.room; }
    });
  });
  app.delete<{ Params: { id: string } }>('/api/speaker-groups/:id', async (req, reply) => {
    if (!(hub.config.get().speakerGroups ?? []).some(g => g.id === req.params.id)) return bad(reply, 'Unknown group', 404);
    return edit(c => { c.speakerGroups = (c.speakerGroups ?? []).filter(g => g.id !== req.params.id); });
  });

  // --------------------------------------------------------------- combined --
  // One physical device reached through several integrations, shown as one. Its members are hidden while it is,
  // and shown again when it's separated (unless the owner had hidden them before).
  const checkCombined = (members: unknown, self?: string): string | null => {
    if (!Array.isArray(members)) return 'Pick the devices';
    const ids = [...new Set(members.map(String))];
    if (ids.length < 2) return 'Pick at least two devices';
    const others = (hub.config.get().combined ?? []).filter(c => c.id !== self).flatMap(c => c.members);
    for (const id of ids) {
      const d = hub.reg.get(id);
      if (!d) return `Unknown device ${id}`;
      if (d.adapter === 'combined' || d.adapter === 'groups') return `${d.name} is already more than one device`;
      if (others.includes(id)) return `${d.name} is already part of another combined device`;
    }
    return null;
  };
  app.post<{ Body: { name?: string; members?: string[]; room?: string } }>('/api/combined', async (req, reply) => {
    const err = checkCombined(req.body?.members);
    if (err) return bad(reply, err);
    const members = [...new Set(req.body!.members!.map(String))];
    const name = text(req.body?.name, 60) || hub.reg.get(members[0])!.name;
    const room = req.body?.room && hub.config.get().rooms.some(r => r.id === req.body!.room) ? req.body.room : undefined;
    const list = hub.config.get().combined ?? [];
    let id = slug(name) || 'device', n = 2;
    while (list.some(c => c.id === id)) id = `${slug(name) || 'device'}_${n++}`;
    const r = edit(c => {
      const hid = members.filter(m => !c.devices?.[m]?.hidden);
      c.devices ??= {};
      for (const m of hid) c.devices[m] = { ...c.devices[m], hidden: true };
      c.combined = [...(c.combined ?? []), { id, name, members, hid, ...(room ? { room } : {}) }];
    });
    return { id, deviceId: combinedDeviceId({ id }), ...r };
  });
  app.put<{ Params: { id: string }; Body: { name?: string; members?: string[]; room?: string | null } }>('/api/combined/:id', async (req, reply) => {
    if (!(hub.config.get().combined ?? []).some(c => c.id === req.params.id)) return bad(reply, 'Unknown combined device', 404);
    const name = req.body?.name === undefined ? undefined : text(req.body.name, 60);
    if (name === '') return bad(reply, 'Give it a name');
    if (req.body?.members !== undefined) { const err = checkCombined(req.body.members, req.params.id); if (err) return bad(reply, err); }
    if (req.body?.room && !hub.config.get().rooms.some(r => r.id === req.body!.room)) return bad(reply, 'Unknown room');
    return edit(c => {
      const x = c.combined!.find(y => y.id === req.params.id)!;
      if (name) x.name = name;
      if (req.body?.members) x.members = [...new Set(req.body.members.map(String))];
      if (req.body?.room !== undefined) { if (req.body.room) x.room = req.body.room; else delete x.room; }
    });
  });
  app.delete<{ Params: { id: string } }>('/api/combined/:id', async (req, reply) => {
    const x = (hub.config.get().combined ?? []).find(c => c.id === req.params.id);
    if (!x) return bad(reply, 'Unknown combined device', 404);
    return edit(c => {
      for (const m of x.hid ?? []) if (c.devices?.[m]) { delete c.devices[m].hidden; }
      c.combined = (c.combined ?? []).filter(y => y.id !== req.params.id);
    });
  });

  // ----------------------------------------------------------------- people --
  app.post<{ Body: { name?: string; detail?: string } }>('/api/people', async (req, reply) => {
    const name = text(req.body?.name, 40);
    if (!name) return bad(reply, 'Give them a name');
    const people = hub.config.get().people;
    let id = slug(name) || 'person', n = 2;
    while (people.some(p => p.id === id)) id = `${slug(name) || 'person'}_${n++}`;
    hub.engine.people[id] ??= { home: true, since: hub.engine.now() };
    return { id, ...edit(c => { c.people.push({ id, name, detail: text(req.body?.detail, 40) || 'Phone' }); }) };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; detail?: string } }>('/api/people/:id', async (req, reply) => {
    if (!hub.config.get().people.some(p => p.id === req.params.id)) return bad(reply, 'Unknown person', 404);
    const name = req.body?.name === undefined ? undefined : text(req.body.name, 40);
    if (name === '') return bad(reply, 'Give them a name');
    const detail = req.body?.detail === undefined ? undefined : text(req.body.detail, 40);
    return edit(c => { const p = c.people.find(x => x.id === req.params.id)!; if (name) p.name = name; if (detail !== undefined) p.detail = detail || 'Phone'; });
  });

  app.delete<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    if (!hub.config.get().people.some(p => p.id === req.params.id)) return bad(reply, 'Unknown person', 404);
    return edit(c => { c.people = c.people.filter(p => p.id !== req.params.id); });
  });
}
