import type { FastifyRequest } from 'fastify';
import { allows, canDevice, canRoom, needs, NOT_YOURS, type Actor, type Perm } from '../services/actor.ts';
import type { Device } from '../model/types.ts';

// Who may call what: one allow-list for every route of the API, checked by one hook (server.ts) before any handler
// runs. A route that isn't listed is the owner's alone, so a new route is closed until someone decides who it's for
// (test/accounts.test.ts fails for a route missing here). The roles and what each may do are in services/actor.ts;
// docs/architecture.md has this table in words.
//
// `public`: no key at all (health checks, the app's updates, signing in, accepting an invite). Otherwise a Perm, and
// for some routes which device or room (a route parameter) must be the caller's own: `device`, `room`, or `self`
// (a person id that must be the caller, unless they're the owner).

export interface Rule { perm: Perm | 'public'; device?: string; room?: string; self?: string }

const r = (perm: Rule['perm'], more: Omit<Rule, 'perm'> = {}): Rule => ({ perm, ...more });

export const ROUTES: Record<string, Rule> = {
  // ---- open: no key
  'GET /api/health': r('public'),
  'GET /api/hello': r('public'),
  'GET /api/app/manifest': r('public'),
  'GET /api/app/assets/:runtime/:update/:key': r('public'),
  'GET /api/snap/:key': r('public'),
  // Announcement audio for the speakers, which can't send a key: the clip's random id is its key (announce-routes.ts).
  'GET /api/clip/:file': r('public'),
  'GET /api/sound/:file': r('public'),
  'POST /api/login/start': r('public'),
  'GET /api/login/poll/:id': r('public'),
  'POST /api/login/password': r('public'),
  'POST /api/invite/peek': r('public'),
  'POST /api/invite/accept': r('public'),

  // ---- anyone signed in
  'GET /api/state': r('view'),
  'GET /api/boot.js': r('view'),
  'GET /api/ws': r('view'),
  'GET /api/me': r('view'),
  'GET /api/connect/addresses': r('view'),
  'GET /api/home/room-icons': r('view'),
  'POST /api/login/approve': r('view'),
  'GET /api/sessions': r('view'),
  'DELETE /api/sessions/:id': r('view'),
  'POST /api/logout': r('view'),
  'POST /api/app/crash': r('view'),
  'GET /api/push/vapid': r('view'),
  'POST /api/push/subscribe': r('view'),
  'POST /api/push/unsubscribe': r('view'),
  'POST /api/push/app': r('view'),
  'DELETE /api/push/app': r('view'),
  'GET /api/notify/prefs': r('view'),
  'PUT /api/notify/prefs': r('view'),
  'POST /api/people/:id/presence': r('view', { self: 'id' }),
  'POST /api/ask': r('view'),
  'POST /api/ask/parse': r('view'),
  'POST /api/ask/act': r('view'),
  'GET /api/ask/jobs/:id': r('view'),
  'GET /api/ask/history': r('view'),
  'GET /api/jev/status': r('view'),

  // ---- casting from Helix's apps (Helix's own token reaches these; the owner's key too)
  'GET /api/helix/speakers': r('owner'),
  'POST /api/helix/play': r('owner'),
  'POST /api/helix/control': r('owner'),
  'POST /api/helix/queue': r('owner'),

  // ---- switching devices (a child or a guest: only theirs)
  'POST /api/devices/:id': r('control', { device: 'id' }),
  'POST /api/rooms/:id/off': r('control', { room: 'id' }),
  'POST /api/room-climate/:room': r('control', { room: 'room' }),
  'POST /api/lights/off': r('control'),
  'POST /api/undo/:id': r('control'),

  // ---- cameras and the home's history
  'POST /api/devices/:id/webrtc': r('cameras'),
  'POST /api/devices/:id/webrtc/:op': r('cameras'),
  'GET /api/devices/:id/snapshot': r('cameras'),
  'GET /api/frames/:device/:id': r('cameras'),
  'GET /api/timeline': r('cameras'),
  'GET /api/security': r('cameras'),
  'GET /api/sensors': r('history'),
  'GET /api/sensors/:id/history/:field': r('history'),

  // ---- modes and overlays: switching
  'POST /api/overlays/:id/start': r('modes'),
  'POST /api/overlays/end': r('modes'),
  'POST /api/plan/skip': r('modes'),
  'GET /api/preview': r('modes'),

  // ---- automations, and editing modes, overlays and moments
  'GET /api/automations': r('automate'),
  'GET /api/automations/:id': r('automate'),
  'POST /api/automations': r('automate'),
  'PUT /api/automations/:id': r('automate'),
  'PATCH /api/automations/:id': r('automate'),
  'DELETE /api/automations/:id': r('automate'),
  'POST /api/automations/:id/run': r('automate'),
  'POST /api/automations/:id/duplicate': r('automate'),
  'POST /api/automations/clear-done': r('automate'),
  'POST /api/modes': r('automate'),
  'PUT /api/modes/:id': r('automate'),
  'PATCH /api/modes/:id': r('automate'),
  'DELETE /api/modes/:id': r('automate'),
  'PUT /api/modes/:id/targets/:device': r('automate'),
  'POST /api/overlays': r('automate'),
  'PUT /api/overlays/:id': r('automate'),
  'DELETE /api/overlays/:id': r('automate'),
  'PUT /api/overlays/:id/targets/:device': r('automate'),
  'POST /api/moments': r('automate'),
  'PUT /api/moments/:id': r('automate'),
  'DELETE /api/moments/:id': r('automate'),
  'POST /api/findings/:id/fix': r('automate'),
  'POST /api/findings/:id/dismiss': r('automate'),
  // Learned suggestions: put off for a week, offered again, and why (the days behind one), like fix and dismiss.
  'POST /api/findings/:id/snooze': r('automate'),
  'POST /api/findings/:id/restore': r('automate'),
  'GET /api/findings/:id/why': r('automate'),

  // ---- the home's everyday settings: rooms, devices, favourites, groups, alerts, Ask Kova's notes
  'PATCH /api/devices/:id/settings': r('home'),
  'PUT /api/favourites': r('home'),
  'POST /api/rooms': r('home'),
  'PUT /api/rooms/order': r('home'),
  'PUT /api/rooms/:id': r('home'),
  'DELETE /api/rooms/:id': r('home'),
  'POST /api/groups': r('home'),
  'PUT /api/groups/:name': r('home'),
  'DELETE /api/groups/:name': r('home'),
  'POST /api/speaker-groups': r('home'),
  'PUT /api/speaker-groups/:id': r('home'),
  'DELETE /api/speaker-groups/:id': r('home'),
  // A group's timing: adults (and the owner) tune it; children and guests don't.
  'GET /api/speaker-groups/:id/sync': r('home'),
  'PUT /api/speaker-groups/:id/offsets': r('home'),
  'PUT /api/speaker-groups/:id/balance': r('home'),
  'POST /api/speaker-groups/:id/sync-test': r('home'),
  'DELETE /api/speaker-groups/:id/sync-test': r('home'),
  'POST /api/combined': r('home'),
  'PUT /api/combined/:id': r('home'),
  'DELETE /api/combined/:id': r('home'),
  'PUT /api/sources/:name': r('home'),
  'DELETE /api/sources/:name': r('home'),
  'PUT /api/security/settings': r('home'),
  'PUT /api/room-climate': r('home'),
  // Announcements: the clips and recordings automations play (making automations), a speaker's loudness test (its settings).
  'GET /api/clips': r('automate'),
  'POST /api/clips': r('automate'),
  'PATCH /api/clips/:id': r('automate'),
  'DELETE /api/clips/:id': r('automate'),
  'GET /api/adhans': r('automate'),
  'POST /api/devices/:id/announce-test': r('home'),
  // Prayer times: anyone may read today's times; switching the integration and its method is the owner's, like any integration.
  'GET /api/prayer': r('view'),
  'PUT /api/prayer': r('owner'),
  'POST /api/insights/:id/snooze': r('home'),
  'DELETE /api/insights/:id/snooze': r('home'),
  'GET /api/maps/static': r('home'),
  'POST /api/push/test': r('home'),
  'GET /api/assistant/memory': r('home'),
  'DELETE /api/assistant/memory/:i': r('home'),
  'PATCH /api/me': r('home'),
  'PUT /api/me/login': r('view'),
  'DELETE /api/me/login': r('view'),

  // ---- the owner: people and accounts, integrations, updates, backups, the hub's keys and location
  'GET /api/members': r('owner'),
  'PUT /api/members/:id': r('owner'),
  'DELETE /api/members/:id': r('owner'),
  'PUT /api/members/:id/login': r('owner'),
  'DELETE /api/members/:id/login': r('owner'),
  'POST /api/invites': r('owner'),
  'POST /api/invites/:id/resend': r('owner'),
  'DELETE /api/invites/:id': r('owner'),
  'POST /api/me/claim': r('owner'),
  'POST /api/people': r('owner'),
  'PUT /api/people/:id': r('owner'),
  'DELETE /api/people/:id': r('owner'),
  'GET /api/presence/setup': r('owner'),
  'GET /api/app-link': r('owner'),
  'PUT /api/home': r('owner'),
  'GET /api/geocode': r('owner'),
  'GET /api/geocode/place': r('owner'),
  'GET /api/geocode/reverse': r('owner'),
  'POST /api/location/parse': r('owner'),
  'GET /api/maps/settings': r('owner'),
  'PUT /api/maps/settings': r('owner'),
  'GET /api/assistant/settings': r('owner'),
  'PUT /api/assistant/settings': r('owner'),
  'GET /api/assistant/requests': r('owner'),
  'GET /api/assistant/learned': r('owner'),
  'DELETE /api/assistant/learned/:key': r('owner'),
  'POST /api/devices/:id/event': r('owner'),
  'POST /api/devices/:id/physical': r('owner'),
  'GET /api/room-climate/pairing': r('owner'),
  'POST /api/jev/decide': r('owner'),
  'POST /api/jev/gate': r('owner'),
  'GET /api/jev/presence-review': r('owner'),
  'GET /api/update': r('owner'),
  'POST /api/update/check': r('owner'),
  'POST /api/update/apply': r('owner'),
  'PUT /api/update/licence': r('owner'),
  'DELETE /api/update/licence': r('owner'),
  'PUT /api/update/settings': r('owner'),
  'GET /api/backups': r('owner'),
  'POST /api/backups': r('owner'),
  'GET /api/backups/:name': r('owner'),
  'GET /api/import/ha': r('owner'),
  'GET /api/import/ha/automations': r('owner'),
  'POST /api/import/ha/automations/convert': r('owner'),
  'POST /api/import/ha/backup': r('owner'),
  'POST /api/import/ha/folder': r('owner'),
  'POST /api/import/ha/review/:id': r('owner'),
  'POST /api/import/ha/apply': r('owner'),
  'DELETE /api/import/ha': r('owner'),
  'GET /api/integrations/catalog': r('owner'),
  'GET /api/integrations/config': r('owner'),
  'PUT /api/integrations/config/:section': r('owner'),
  'DELETE /api/integrations/config/:section': r('owner'),
  'POST /api/integrations/:id/test': r('owner'),
  'GET /api/integrations/homekit': r('owner'),
  'GET /api/integrations/homekit-devices/discover': r('owner'),
  'POST /api/integrations/homekit-devices/pair': r('owner'),
  'GET /api/integrations/matter-bridge': r('owner'),
  'POST /api/integrations/matter/commission': r('owner'),
  'GET /api/integrations/nest/auth-url': r('owner'),
  'POST /api/integrations/nest/auth-code': r('owner'),
  'POST /api/integrations/smartthings/create-app': r('owner'),
  'GET /api/integrations/smartthings/auth-url': r('owner'),
  'POST /api/integrations/smartthings/auth-code': r('owner'),
  'GET /api/integrations/connectlife/auth-url': r('owner'),
  'POST /api/integrations/connectlife/auth-code': r('owner'),
  'POST /api/integrations/samsungtv/pair': r('owner'),
  'POST /api/integrations/tuya/cloud-import': r('owner'),
  'POST /api/integrations/tuya/qr-pair': r('owner'),
  'GET /api/integrations/tuya/qr-pair': r('owner'),
  'POST /api/integrations/warden/link': r('owner'),
  'POST /api/integrations/warden/pair': r('owner'),
  'GET /api/integrations/warden/pair': r('owner'),
  'GET /api/integrations/warden/clients': r('owner'),
  'POST /api/integrations/cast/find': r('owner'),
  'POST /api/integrations/sonos/find': r('owner'),
  'GET /api/integrations/helix/find': r('owner'),
  'POST /api/integrations/helix/pair': r('owner'),
  'GET /api/integrations/helix/pair': r('owner'),
};

/** The rule for a request: its route as registered (`/api/devices/:id`), by method. Unlisted: the owner's. */
export function ruleFor(req: Pick<FastifyRequest, 'method' | 'routeOptions'>): Rule {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const url = req.routeOptions?.url;
  return (url && ROUTES[`${method} ${url}`]) || { perm: 'owner' };
}

/**
 * Whether this person may make this request: the role's permission, then the device, room or person the route is
 * about. An error message (and status) when not.
 */
export function check(rule: Rule, a: Actor, params: Record<string, string>, device: (id: string) => Device | undefined): { status: number; error: string } | null {
  if (rule.perm === 'public') return null;
  if (!allows(a, rule.perm)) return { status: 403, error: needs(rule.perm) };
  if (rule.device && !canDevice(a, device(params[rule.device]))) return device(params[rule.device]) ? { status: 403, error: NOT_YOURS } : null;
  if (rule.room && !canRoom(a, params[rule.room])) return { status: 403, error: NOT_YOURS };
  if (rule.self && a.role !== 'owner' && params[rule.self] !== a.personId) return { status: 403, error: 'You can only do that for yourself.' };
  return null;
}
