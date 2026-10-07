import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.ts';
import { LOCATION_SOURCES, ROOM_ICONS, UNASSIGNED_ROOM, WHOLE_HOME, type HomeConfig, type HomeLocation, type LocationSource } from '../model/types.ts';
import { distanceKm, MapsError, PLACE_ID, sameClock, validZone } from '../services/maps.ts';
import { groupDeviceId } from '../adapters/groups.ts';
import { combinedDeviceId } from '../adapters/combined.ts';
import { isPlayer } from '../util/describe.ts';
import { slug } from '../tools/import-ha.ts';
import { cleanAlerts, isCamera, isSensor } from '../util/sensors.ts';
import type { AlertPrefs, FanSpeed, HvacMode, RoomClimateSettings } from '../model/types.ts';

// Customising the home: its name, rooms and groups of rooms, people, favourites, and each device's name, room,
// visibility and whether it's archived. Settings live in the home config (so every phone sees the same), and every change
// returns an undo id.

type Reply = { code: (n: number) => { send: (b: { error: string }) => unknown } };
/** How prayer times can be worked out (adhan's calculation methods). */
/** A new location this far from the old one (km) is another place: its timezone is worked out again. */
const TZ_MOVE_KM = 30;
export const PRAYER_METHODS = ['MuslimWorldLeague', 'Egyptian', 'Karachi', 'UmmAlQura', 'Dubai', 'MoonsightingCommittee', 'NorthAmerica', 'Kuwait', 'Qatar', 'Singapore', 'Tehran', 'Turkey'];

export function registerHomeRoutes(app: FastifyInstance, hub: Hub): void {
  const edit = (fn: (c: HomeConfig) => void) => ({ undo: hub.engine.registerUndo(hub.config.update(fn)) });
  const bad = (reply: Reply, msg: string, code = 400) => reply.code(code).send({ error: msg });
  const text = (v: unknown, max = 60) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';

  app.get('/api/home/room-icons', async () => ({ icons: ROOM_ICONS }));

  // The home's details: only what's sent changes. Location and timezone move sun and prayer times; the prayer
  // method decides how prayer times are worked out. A new location far from the old one (another town) gets the
  // timezone there too, unless one is sent: the answer says so (`timezone`), and Undo puts both back.
  app.put<{ Body: { name?: string; address?: string | null; timezone?: string; timezoneHint?: string; latitude?: number; longitude?: number; location?: { latitude?: number; longitude?: number; radiusM?: number; source?: string; provider?: string; placeId?: string }; prayerMethod?: string; pauseForDoorbell?: boolean } }>('/api/home', async (req, reply) => {
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
    if (b.location?.source !== undefined && !(LOCATION_SOURCES as readonly string[]).includes(b.location.source)) return bad(reply, `location.source is ${LOCATION_SOURCES.slice(0, -1).join(', ')} or ${LOCATION_SOURCES.at(-1)}`);
    if (b.location?.provider !== undefined && b.location.provider !== 'google' && b.location.provider !== 'osm') return bad(reply, 'location.provider is google or osm');
    if (b.location?.placeId !== undefined && !(typeof b.location.placeId === 'string' && PLACE_ID.test(b.location.placeId))) return bad(reply, 'location.placeId isn’t a place id');
    if (b.location?.provider === 'google' && !b.location.placeId) return bad(reply, 'A point from Google needs its placeId');
    if (b.prayerMethod !== undefined && !PRAYER_METHODS.includes(b.prayerMethod)) return bad(reply, `Prayer method is one of ${PRAYER_METHODS.join(', ')}`);
    if (b.pauseForDoorbell !== undefined && typeof b.pauseForDoorbell !== 'boolean') return bad(reply, 'pauseForDoorbell must be true or false');
    const source = b.location?.source as LocationSource | undefined;
    // The timezone of a new place: only when it moved a long way (fine-tuning the pin never changes the clock), and
    // only when that zone keeps a different clock. The phone's own zone is the best guess when it's the phone's location.
    let timezone = b.timezone;
    const before = hub.config.get();
    if (timezone === undefined && latitude !== undefined && longitude !== undefined) {
      const was = before.latitude || before.longitude ? { latitude: before.latitude, longitude: before.longitude } : null;
      if (!was || distanceKm(was, { latitude, longitude }) > TZ_MOVE_KM) {
        const hint = source === 'phone' && b.timezoneHint && validZone(b.timezoneHint) ? b.timezoneHint : null;
        const z = hint ?? await hub.maps.timezoneAt({ latitude, longitude }).catch(() => null);
        if (z && !sameClock(z, before.timezone)) timezone = z;
      }
    }
    // Whose point it is: an address search's match keeps its provider (and Google's place id, so its coordinates can
    // be refreshed within Google's 30 days); a point the owner set (map, typed, phone, import) is their own.
    const from = (): Pick<HomeLocation, 'provider' | 'placeId' | 'fetchedAt'> => source === 'geocode' && b.location?.provider
      ? { provider: b.location.provider as 'google' | 'osm', ...(b.location.placeId ? { placeId: b.location.placeId } : {}), fetchedAt: hub.engine.now() } : {};
    const r = edit(c => {
      if (name) c.name = name;
      if (b.address !== undefined) { const a = b.address ? text(b.address, 200) : ''; if (a) c.address = a; else delete c.address; }
      if (timezone) c.timezone = timezone;
      if (latitude !== undefined) {
        const lat = Math.round(latitude * 1e5) / 1e5, lon = Math.round(longitude! * 1e5) / 1e5;
        c.latitude = lat; c.longitude = lon;
        c.location = { latitude: lat, longitude: lon, ...(b.location?.radiusM !== undefined ? { radiusM: Math.round(b.location.radiusM) } : c.location?.radiusM ? { radiusM: c.location.radiusM } : {}), source: source ?? 'manual', updatedAt: hub.engine.now(), ...from() };
      } else if (b.location) {
        // Only the circle (or the source) changed: the point and whose it is stay.
        const keep = c.location ? { provider: c.location.provider, placeId: c.location.placeId, fetchedAt: c.location.fetchedAt } : {};
        c.location = JSON.parse(JSON.stringify({ ...keep, latitude: c.location?.latitude ?? c.latitude, longitude: c.location?.longitude ?? c.longitude, ...(b.location.radiusM !== undefined ? { radiusM: Math.round(b.location.radiusM) } : c.location?.radiusM ? { radiusM: c.location.radiusM } : {}), source: source ?? c.location?.source ?? 'manual', updatedAt: hub.engine.now() })) as HomeLocation;
      }
      if (b.prayerMethod) c.prayerMethod = b.prayerMethod;
      if (b.pauseForDoorbell !== undefined) c.pauseForDoorbell = b.pauseForDoorbell;
    });
    return { ...r, ...(timezone && timezone !== before.timezone && b.timezone === undefined ? { timezone } : {}) };
  });

  // Finding the home (Settings). All of it goes through the hub, so the Google Maps key never reaches a phone or
  // browser (services/maps.ts). With a key: Google Places suggestions, each looked up with /api/geocode/place when
  // it's picked; without one, OpenStreetMap's Nominatim.
  const lang = (req: { headers: Record<string, string | string[] | undefined> }) => String(req.headers['accept-language'] ?? 'en').split(',')[0].trim().slice(0, 20) || 'en';
  const mapsFail = (reply: Reply, e: unknown) => e instanceof MapsError ? bad(reply, e.message, e.code) : bad(reply, (e as Error).message, 502);
  app.get<{ Querystring: { q?: string } }>('/api/geocode', async (req, reply) => {
    const q = text(req.query.q, 200);
    if (q.length < 4) return bad(reply, 'Type more of the address');
    try { return await hub.maps.search(q, lang(req)); } catch (e) { return mapsFail(reply, e); }
  });
  app.get<{ Querystring: { id?: string; session?: string } }>('/api/geocode/place', async (req, reply) => {
    if (!req.query.id) return bad(reply, 'id is required');
    try { return await hub.maps.place(req.query.id, req.query.session, lang(req)); } catch (e) { return mapsFail(reply, e); }
  });
  // Pasted from Google Maps: a share link (short ones are followed here), a maps address, coordinates or a Plus
  // Code → { latitude, longitude, label?, address? }. Nothing is saved: the apps show it on the map to confirm.
  app.post<{ Body: { text?: string } }>('/api/location/parse', async (req, reply) => {
    if (typeof req.body?.text !== 'string' || !req.body.text.trim()) return bad(reply, 'Paste a Google Maps link or coordinates');
    try { return await hub.maps.locate(req.body.text, lang(req)); } catch (e) { return mapsFail(reply, e); }
  });
  // The address at a point (the map's pin), best effort.
  app.get<{ Querystring: { lat?: string; lon?: string } }>('/api/geocode/reverse', async (req, reply) => {
    const latitude = Number(req.query.lat), longitude = Number(req.query.lon);
    if (!(Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return bad(reply, 'lat and lon are required');
    return { address: await hub.maps.reverse({ latitude, longitude }, lang(req)) };
  });
  // Google's map of a point and the circle (Maps Static API through the hub, so the key stays here): how a point
  // from a Google search is shown, since Google's answers may only be drawn on Google's maps.
  app.get<{ Querystring: { lat?: string; lon?: string; r?: string; w?: string; h?: string } }>('/api/maps/static', async (req, reply) => {
    const latitude = Number(req.query.lat), longitude = Number(req.query.lon);
    if (!(Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return bad(reply, 'lat and lon are required');
    const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    try {
      const img = await hub.maps.staticMap({ latitude, longitude, radiusM: clamp(req.query.r, 50, 1000, 150), width: clamp(req.query.w, 100, 640, 600), height: clamp(req.query.h, 100, 640, 300) });
      return reply.type(img.type).header('cache-control', 'private, max-age=3600').send(img.body);
    } catch (e) { return mapsFail(reply, e); }
  });
  // The Google Maps key, entered in Settings → Home: stored on the hub and never sent back (only whether there is
  // one, and its last 4). It needs the Places API (New) and the Geocoding API enabled, and should be restricted to
  // them (and to the hub's address, if it has a fixed one). "" or null removes it.
  app.get('/api/maps/settings', async () => hub.maps.status());
  app.put<{ Body: { googleKey?: string | null } }>('/api/maps/settings', async (req, reply) => {
    if (!req.body || !('googleKey' in req.body)) return bad(reply, 'Send googleKey (or null to remove it)');
    if (req.body.googleKey != null && typeof req.body.googleKey !== 'string') return bad(reply, 'googleKey is text');
    try { hub.maps.setKey(req.body.googleKey); } catch (e) { return mapsFail(reply, e); }
    hub.emit('changed');
    return hub.maps.status();
  });

  // Not now: an alert or warning on the Now page goes quiet for so many hours (24 by default).
  // hours: 1 to 720; or untilItChanges: hidden for as long as it stays exactly so ("that's expected").
  app.post<{ Params: { id: string }; Body: { hours?: number; untilItChanges?: boolean } }>('/api/insights/:id/snooze', async (req, reply) => {
    const forGood = req.body?.untilItChanges === true;
    const hours = req.body?.hours == null ? 24 : Number(req.body.hours);
    if (!forGood && (!Number.isFinite(hours) || hours < 1 || hours > 720)) return bad(reply, 'hours is 1 to 720');
    hub.insights.snooze(req.params.id, hours, forGood);
    hub.emit('changed');
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/insights/:id/snooze', async req => {
    hub.insights.unsnooze(req.params.id);
    hub.emit('changed');
    return { ok: true };
  });

  // ---------------------------------------------------------------- devices --
  // room: a room id, "unassigned" for none of the home's rooms, "whole_home" for a device that serves the whole home
  // (a ducted air conditioner), or null for the room its integration gave it.
  // zoneRooms: ducted units, the rooms each zone serves ({ "1": ["lounge"], "5": ["office", "guest"] }; a room id alone
  // is one room; [] or null clears that zone). Merged by zone, like zoneNames.
  // archived: out of every list, the assistant and alerts, and modes leave it alone, until it's restored.
  app.patch<{ Params: { id: string }; Body: { name?: string | null; room?: string | null; hidden?: boolean; archived?: boolean; favourite?: boolean; watts?: number | null; zoneNames?: Record<string, string | null>; zoneRooms?: Record<string, string | string[] | null> | null; outdoor?: boolean | null; alerts?: AlertPrefs | null } }>('/api/devices/:id/settings', async (req, reply) => {
    const d = hub.reg.get(req.params.id);
    if (!d) return bad(reply, 'Unknown device', 404);
    const b = req.body ?? {};
    if (b.room != null && b.room !== UNASSIGNED_ROOM && b.room !== WHOLE_HOME && !hub.config.get().rooms.some(r => r.id === b.room)) return bad(reply, 'Unknown room');
    if (b.hidden !== undefined && typeof b.hidden !== 'boolean') return bad(reply, 'hidden must be true or false');
    if (b.archived !== undefined && typeof b.archived !== 'boolean') return bad(reply, 'archived must be true or false');
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
    let zoneRooms: Record<string, string[]> | null | undefined;
    if (b.zoneRooms !== undefined) {
      if (!d.capabilities.includes('zones')) return bad(reply, `${d.name} has no zones`);
      if (b.zoneRooms === null) zoneRooms = null;
      else {
        if (typeof b.zoneRooms !== 'object' || Array.isArray(b.zoneRooms) || Object.keys(b.zoneRooms).some(n => !/^[1-9]\d?$/.test(n))) return bad(reply, 'zoneRooms is { "1": ["lounge"], … }');
        const rooms = hub.config.get().rooms;
        zoneRooms = {};
        for (const [n, v] of Object.entries(b.zoneRooms)) {
          const ids = v == null ? [] : Array.isArray(v) ? v : [v];
          if (ids.some(x => typeof x !== 'string')) return bad(reply, `Zone ${n}: rooms are room ids`);
          const bad1 = ids.find(x => !rooms.some(r => r.id === x));
          if (bad1) return bad(reply, `Zone ${n}: unknown room ${bad1}`);
          if (ids.length > 8) return bad(reply, `Zone ${n}: at most 8 rooms`);
          zoneRooms[n] = [...new Set(ids as string[])];
        }
      }
    }
    return edit(c => {
      const s = { ...(c.devices?.[d.id] ?? {}) };
      const orig = d.original ?? { name: d.name, room: d.room };
      if (b.name !== undefined) { const n = b.name === null ? '' : text(b.name); if (!n || n === orig.name) delete s.name; else s.name = n; }
      if (b.room !== undefined) { if (!b.room || b.room === orig.room) delete s.room; else s.room = b.room; }
      if (b.hidden !== undefined) { if (b.hidden) s.hidden = true; else delete s.hidden; }
      if (b.archived !== undefined) { if (b.archived) s.archived = true; else delete s.archived; }
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
        for (const [n, v] of Object.entries(b.zoneNames)) { const t = v ? text(v, 40) : ''; if (t) z[n] = t; else delete z[n]; }
        if (Object.keys(z).length) s.zoneNames = z; else delete s.zoneNames;
      }
      // Zone rooms merge by zone too: a list sets it, [] or null clears it; null for the whole map clears them all.
      if (zoneRooms === null) delete s.zoneRooms;
      else if (zoneRooms) {
        const z = { ...(s.zoneRooms ?? {}) };
        for (const [n, ids] of Object.entries(zoneRooms)) { if (ids.length) z[n] = ids; else delete z[n]; }
        if (Object.keys(z).length) s.zoneRooms = z; else delete s.zoneRooms;
      }
      c.devices = { ...(c.devices ?? {}) };
      if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
      if (b.favourite !== undefined) {
        const f = (c.favourites ?? []).filter(x => x !== d.id);
        c.favourites = b.favourite && !s.archived ? [...f, d.id] : f;
      }
      // An archived device leaves the Now screen too.
      if (b.archived && c.favourites?.includes(d.id)) c.favourites = c.favourites.filter(x => x !== d.id);
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
    while (rooms.some(r => r.id === id) || id === UNASSIGNED_ROOM || id === WHOLE_HOME || id === 'order') id = `${slug(name) || 'room'}_${n++}`;
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

  // Devices still in the room move to `moveTo`: another room, or "unassigned" (in no room, until they're given one).
  // Without it, a room with devices can't be deleted, so nothing moves by surprise.
  app.delete<{ Params: { id: string }; Body: { moveTo?: string } }>('/api/rooms/:id', async (req, reply) => {
    const id = req.params.id, cfg = hub.config.get();
    if (!cfg.rooms.some(r => r.id === id)) return bad(reply, 'Unknown room', 404);
    const inside = hub.reg.list().filter(d => d.room === id);
    const moveTo = req.body?.moveTo;
    if (inside.length && !moveTo) return bad(reply, `${inside.length} device${inside.length === 1 ? ' is' : 's are'} in this room. Choose where ${inside.length === 1 ? 'it goes' : 'they go'}.`);
    if (moveTo && moveTo !== UNASSIGNED_ROOM && (moveTo === id || !cfg.rooms.some(r => r.id === moveTo))) return bad(reply, 'Unknown room to move devices to');
    return edit(c => {
      c.rooms = c.rooms.filter(r => r.id !== id);
      c.devices = { ...(c.devices ?? {}) };
      for (const d of inside) {
        const orig = d.original?.room ?? d.room;
        const s = { ...(c.devices[d.id] ?? {}) };
        if (moveTo === orig) delete s.room; else s.room = moveTo;
        if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
      }
      // Zones that served it don't any more.
      for (const [did, st] of Object.entries(c.devices)) {
        if (!st.zoneRooms) continue;
        const z = Object.fromEntries(Object.entries(st.zoneRooms).map(([n, rs]) => [n, rs.filter(r => r !== id)]).filter(([, rs]) => rs.length));
        const next = { ...st };
        if (Object.keys(z).length) next.zoneRooms = z; else delete next.zoneRooms;
        if (Object.keys(next).length) c.devices[did] = next; else delete c.devices[did];
      }
      for (const [g, rooms] of Object.entries(c.groups)) c.groups[g] = rooms.filter(r => r !== id);
      // Speaker groups and combined devices that were in it are in no room now.
      for (const g of c.speakerGroups ?? []) if (g.room === id) delete g.room;
      for (const x of c.combined ?? []) if (x.room === id) delete x.room;
    });
  });

  // ------------------------------------------------------- groups of rooms --
  // Named groups of rooms ("Upstairs" = the bedrooms and the bathroom), for "turn off upstairs". Keyed by name.
  const groupRooms = (v: unknown): string[] | string => {
    if (!Array.isArray(v)) return 'Pick the rooms';
    const ids = [...new Set(v.map(String))];
    if (!ids.length) return 'Pick at least one room';
    const unknown = ids.find(r => !hub.config.get().rooms.some(x => x.id === r));
    return unknown ? `Unknown room ${unknown}` : ids;
  };
  const groupNamed = (name: string) => Object.keys(hub.config.get().groups ?? {}).find(g => g.toLowerCase() === name.toLowerCase());
  app.post<{ Body: { name?: string; rooms?: string[] } }>('/api/groups', async (req, reply) => {
    const name = text(req.body?.name, 40);
    if (!name) return bad(reply, 'Give the group a name');
    if (groupNamed(name)) return bad(reply, `There’s already a group called ${groupNamed(name)}`);
    if (hub.config.get().rooms.some(r => r.name.toLowerCase() === name.toLowerCase())) return bad(reply, `${name} is already a room’s name`);
    const rooms = groupRooms(req.body?.rooms);
    if (typeof rooms === 'string') return bad(reply, rooms);
    return { name, ...edit(c => { c.groups = { ...(c.groups ?? {}), [name]: rooms }; }) };
  });
  // Change its rooms, or rename it with `name`.
  app.put<{ Params: { name: string }; Body: { name?: string; rooms?: string[] } }>('/api/groups/:name', async (req, reply) => {
    const cur = groupNamed(req.params.name);
    if (!cur) return bad(reply, 'Unknown group', 404);
    const name = req.body?.name === undefined ? cur : text(req.body.name, 40);
    if (!name) return bad(reply, 'Give the group a name');
    const clash = groupNamed(name);
    if (clash && clash !== cur) return bad(reply, `There’s already a group called ${clash}`);
    if (hub.config.get().rooms.some(r => r.name.toLowerCase() === name.toLowerCase())) return bad(reply, `${name} is already a room’s name`);
    const rooms = req.body?.rooms === undefined ? hub.config.get().groups[cur] : groupRooms(req.body.rooms);
    if (typeof rooms === 'string') return bad(reply, rooms);
    return { name, ...edit(c => {
      // Rebuilt in the same order, so a rename keeps the group where it was.
      c.groups = Object.fromEntries(Object.entries(c.groups ?? {}).map(([g, r]) => g === cur ? [name, rooms] : [g, r]));
    }) };
  });
  app.delete<{ Params: { name: string } }>('/api/groups/:name', async (req, reply) => {
    const cur = groupNamed(req.params.name);
    if (!cur) return bad(reply, 'Unknown group', 404);
    return edit(c => { const g = { ...(c.groups ?? {}) }; delete g[cur]; c.groups = g; });
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

  // ------------------------------------------------------------- room ACs --
  // Room ACs (engine/room-climate.ts): what a room cools to and heats to when Kova chooses, and what Kova does when the
  // air conditioner is turned on from another app with every zone closed ('off' or 'rooms'). null puts a default back.
  app.put<{ Body: { coolTo?: number | null; heatTo?: number | null; fromElsewhere?: 'off' | 'rooms' } }>('/api/room-climate', async (req, reply) => {
    const b = req.body ?? {};
    const cur: RoomClimateSettings = { ...(hub.config.get().roomClimate ?? {}) };
    const temp = (v: unknown, lo: number, hi: number, what: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} is ${lo}–${hi}°`);
      return Math.round(n * 2) / 2;
    };
    try {
      if (b.coolTo === null) delete cur.coolTo; else if (b.coolTo !== undefined) cur.coolTo = temp(b.coolTo, 18, 30, 'Cool to');
      if (b.heatTo === null) delete cur.heatTo; else if (b.heatTo !== undefined) cur.heatTo = temp(b.heatTo, 16, 28, 'Heat to');
      if (b.fromElsewhere !== undefined) {
        if (b.fromElsewhere !== 'off' && b.fromElsewhere !== 'rooms') throw new Error('fromElsewhere is off or rooms');
        cur.fromElsewhere = b.fromElsewhere;
      }
    } catch (e) { return bad(reply, (e as Error).message); }
    if ((cur.coolTo ?? 24) < (cur.heatTo ?? 21)) return bad(reply, 'Cool to can’t be below heat to');
    return edit(c => { c.roomClimate = cur; });
  });

  // A room AC on or off, or set (a mode, a set temperature, a fan speed), as a voice assistant would.
  app.post<{ Params: { room: string }; Body: { on?: boolean; hvac?: HvacMode | 'off'; target?: number; fanSpeed?: FanSpeed } }>('/api/room-climate/:room', async (req, reply) => {
    const b = req.body ?? {};
    if (b.hvac !== undefined && !['cool', 'heat', 'dry', 'fan', 'auto', 'off'].includes(b.hvac)) return bad(reply, `${String(b.hvac)} isn’t a climate mode`);
    if (b.fanSpeed !== undefined && !['auto', 'quiet', 'low', 'medium', 'high', 'turbo'].includes(b.fanSpeed)) return bad(reply, `${String(b.fanSpeed)} isn’t a fan speed`);
    if (b.target !== undefined && !(Number(b.target) >= 16 && Number(b.target) <= 32)) return bad(reply, 'The set temperature is 16–32°');
    if (b.on !== undefined && typeof b.on !== 'boolean') return bad(reply, 'on is true or false');
    try {
      const r = await hub.roomClimate.apply(req.params.room, { on: b.on, hvac: b.hvac, target: b.target != null ? Number(b.target) : undefined, fanSpeed: b.fanSpeed }, { kind: 'user', label: 'You' });
      return { ok: true, changed: r.changed, what: r.what, why: r.why, undo: r.undo ?? null, room: hub.roomClimate.view(req.params.room) };
    } catch (e) { return bad(reply, (e as Error).message); }
  });
}
