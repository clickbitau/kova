import type { Snapshot } from './snapshot.ts';
import type { Accounts } from '../services/accounts.ts';
import { PERMS, ROLE_LABEL, allows, canDevice, canRoom, scoped, type Actor, type Perm } from '../services/actor.ts';

// The home as one person may see it. Owners and adults see all of it; a child sees only the rooms and devices they
// may use (no cameras, history, automations or settings); a guest the same, and not who's home either. Every
// snapshot (GET /api/state, /api/boot.js and each WebSocket) goes through here, with `me`: who the apps are
// signed in as and what they may do, so they can show only what works.

export interface Me {
  role: Actor['role'];
  roleLabel: string;
  personId: string | null;
  name: string;
  /** Child, guest: the rooms (and, for a guest, devices) they may use. */
  rooms: string[] | null;
  devices: string[] | null;
  /** Guest: when their access ends. */
  until: number | null;
  room: string | null;
  /** Their username for signing in, if they've set one. */
  user: string | null;
  /** How they got in: the hub's master key, a device's own key, or a hub with no key at all. */
  via: Actor['via'];
  can: Record<Perm, boolean>;
}

export function meOf(a: Actor | undefined, accounts?: Accounts): Me {
  const who: Actor = a ?? { role: 'owner', name: 'Owner', via: 'open' };
  const m = accounts?.member(who.personId);
  return {
    role: who.role, roleLabel: ROLE_LABEL[who.role], personId: who.personId ?? null, name: who.name,
    rooms: scoped(who) ? who.rooms ?? [] : null, devices: who.role === 'guest' ? who.devices ?? [] : null,
    until: m?.until ?? null, room: who.room ?? null, user: accounts?.loginOf(who.personId) ?? null, via: who.via,
    can: Object.fromEntries((PERMS.owner as Perm[]).map(p => [p, allows(who, p)])) as Record<Perm, boolean>,
  };
}

export function viewFor(s: Snapshot, a: Actor | undefined, accounts?: Accounts) {
  const me = meOf(a, accounts);
  // Who did what, on each Activity row, by name.
  if (!scoped(a)) {
    const out = { ...s, me };
    // An adult sees the home and its settings, but not the owner's: updates (with the licence) stay the owner's.
    if (!allows(a, 'owner')) return { ...out, update: null };
    // The owner: each person's account (role and limits), so People shows them live.
    return { ...out, accounts: (accounts?.members() ?? []).map(m => ({ personId: m.personId, role: m.role, rooms: m.rooms ?? null, until: m.until ?? null, expired: accounts!.expired(m) })) };
  }
  const devices = s.devices.filter(d => canDevice(a, d));
  const ids = new Set(devices.map(d => d.id));
  const rooms = s.rooms.filter(r => canRoom(a, r.id) || devices.some(d => d.room === r.id));
  const roomIds = new Set(rooms.map(r => r.id));
  const people = allows(a, 'people');
  const bareMode = (m: Snapshot['modes'][number]) => ({ ...m, groups: [], inherit: [], moments: [], targets: [], test: { ...m.test, days: [], text: '' } });
  return {
    ...s,
    me,
    home: { ...s.home, address: a!.role === 'guest' ? null : s.home.address },
    rooms,
    roomStatus: Object.fromEntries(Object.entries(s.roomStatus as Record<string, unknown>).filter(([id]) => roomIds.has(id))) as Snapshot['roomStatus'],
    sensors: [] as unknown as Snapshot['sensors'],
    security: { ...s.security, devices: {}, recent: [], decisions: [] },
    favourites: s.favourites ? s.favourites.filter(id => ids.has(id)) : null,
    speakerGroups: s.speakerGroups.filter(g => ids.has(g.deviceId)),
    groups: Object.fromEntries(Object.entries(s.groups).filter(([, rs]) => rs.every(r => roomIds.has(r)))),
    people: people ? s.people.map(p => ({ ...p, evidence: [] })) : [],
    devices,
    modes: s.modes.map(bareMode),
    day: { ...s.day, items: s.day.items.map(i => ({ ...i, what: '' })), marks: people ? s.day.marks : [] },
    upcoming: s.upcoming.map(u => ({ ...u, what: '' })),
    lightTheWay: [],
    automations: [],
    combineIdeas: [],
    combined: s.combined.filter(c => ids.has(c.deviceId)),
    automationIdeas: [],
    overlays: s.overlays.map(o => ({ ...o, targets: [] })),
    moments: [],
    update: null,
    findings: [],
    insights: [] as unknown as Snapshot['insights'],
    glance: { ...s.glance, inside: s.glance.inside.filter(x => (x.room && roomIds.has(x.room)) || ids.has(x.device)), air: s.glance.air.filter(x => ids.has(x.device)) },
    // What happened with their own devices only (a guest: nothing of the home's history).
    activity: a!.role === 'guest' ? [] : s.activity.filter(x => x.device && ids.has(x.device)),
    integrations: [],
    roomClimate: { ...s.roomClimate, rooms: s.roomClimate.rooms.filter(r => roomIds.has(r.room)) },
    energy: { ...s.energy, devices: s.energy.devices.filter(d => ids.has(d.id)) },
  };
}
