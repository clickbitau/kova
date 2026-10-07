import { AsyncLocalStorage } from 'node:async_hooks';
import type { Cause, Device, Targets } from '../model/types.ts';
import { UNASSIGNED_ROOM } from '../model/types.ts';

// Who is asking: the person (and their role) behind a request, carried through everything that request does —
// the engine, Ask Kova's built-in parser and its AI tools — with AsyncLocalStorage. The API's access hook
// (api/access.ts) sets it once per request; nothing else decides who someone is.
//
// What each role may do is here too, in one table (PERMS), so the route allow-list, the engine and Ask Kova all
// ask the same question.

export type Role = 'owner' | 'adult' | 'child' | 'guest';
export const ROLES: Role[] = ['owner', 'adult', 'child', 'guest'];
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', adult: 'Adult', child: 'Child', guest: 'Guest' };

/**
 * What a request may do. `view` is being signed in at all; `control` is switching devices (scoped to some rooms for
 * a child or a guest); `cameras` and `history` are seeing them; `modes` is switching the home's modes and
 * overlays; `automate` is making automations and editing modes; `home` is rooms, device settings and the like;
 * `owner` is people, accounts, integrations, updates and backups.
 */
export type Perm = 'view' | 'control' | 'cameras' | 'history' | 'people' | 'modes' | 'automate' | 'home' | 'owner';
export const PERMS: Record<Role, readonly Perm[]> = {
  owner: ['view', 'control', 'cameras', 'history', 'people', 'modes', 'automate', 'home', 'owner'],
  adult: ['view', 'control', 'cameras', 'history', 'people', 'modes', 'automate', 'home'],
  child: ['view', 'control', 'people'],
  guest: ['view', 'control'],
};

export interface Actor {
  role: Role;
  /** The person this is (a member's own key); none for the hub's master key or a key from before accounts. */
  personId?: string;
  /** How Activity names them: the person's name, or "Owner". */
  name: string;
  /** How they got in. */
  via: 'master' | 'session' | 'open';
  sessionId?: string;
  /** Child and guest: the rooms whose devices they may use. */
  rooms?: string[];
  /** Guest: single devices they may use as well. */
  devices?: string[];
  /** Their own room ("my room"). */
  room?: string;
  /** A trusted inner call (a room AC already checked by room): the engine doesn't check device by device again. */
  trusted?: boolean;
}

export const actors = new AsyncLocalStorage<Actor>();

/** The person behind the code running now, or undefined for the hub itself (modes, automations, timers). */
export const currentActor = (): Actor | undefined => actors.getStore();

/** What everything stored per person is keyed by: the person, or "owner" for the master key and pre-account keys. */
export const actorKey = (a: Actor | undefined): string => a?.personId ?? 'owner';

export const allows = (a: Actor | undefined, p: Perm): boolean => !a || PERMS[a.role].includes(p);

/** Only some rooms (and devices) are theirs to use. */
export const scoped = (a: Actor | undefined): boolean => !!a && (a.role === 'child' || a.role === 'guest');

/** Whether they may use a room's devices. */
export function canRoom(a: Actor | undefined, room: string | undefined): boolean {
  if (!a) return true;
  if (!allows(a, 'control')) return false;
  if (!scoped(a)) return true;
  return !!room && room !== UNASSIGNED_ROOM && (a.rooms ?? []).includes(room);
}

/** Whether they may use (and see) a device. Cameras are never in a child's or a guest's reach. */
export function canDevice(a: Actor | undefined, d: Pick<Device, 'id' | 'room' | 'type'> | undefined): boolean {
  if (!d) return false;
  if (!a) return true;
  if (!allows(a, 'control')) return false;
  if (!scoped(a)) return true;
  if (d.type === 'camera') return false;
  return canRoom(a, d.room) || (a.role === 'guest' && (a.devices ?? []).includes(d.id));
}

export class AccessDenied extends Error {
  readonly statusCode = 403;
  constructor(message: string) { super(message); this.name = 'AccessDenied'; }
}

/** The words a refusal uses. */
export const NOT_YOURS = 'That isn’t one of the rooms or devices you can use.';
export const needs = (p: Perm): string => ({
  view: 'Sign in first.',
  control: 'Your account can’t control devices.',
  cameras: 'Your account can’t see the cameras.',
  history: 'Your account can’t see the home’s history.',
  people: 'Your account can’t see who’s home.',
  modes: 'Your account can’t change the home’s modes.',
  automate: 'Your account can’t make or change automations.',
  home: 'Your account can’t change the home’s settings.',
  owner: 'Only the home’s owner can do that.',
}[p]);

/** Throws AccessDenied unless the person asking may do this. */
export function demand(p: Perm, a: Actor | undefined = currentActor()): void {
  if (!allows(a, p)) throw new AccessDenied(needs(p));
}

/**
 * Check targets before anything is switched: each device, room ("room:<id>") or room AC zone ("zone:<id>") must be
 * theirs. "type:light" (every light in the home) is only for people who aren't limited to some rooms.
 */
export function demandTargets(targets: Targets, device: (id: string) => Device | undefined, a: Actor | undefined = currentActor()): void {
  if (!a || a.trusted) return;
  demand('control', a);
  if (!scoped(a)) return;
  for (const key of Object.keys(targets)) {
    const m = /^(room|zone|type):(.+)$/.exec(key);
    const ok = m ? (m[1] === 'type' ? false : canRoom(a, m[2])) : canDevice(a, device(key));
    if (!ok) throw new AccessDenied(NOT_YOURS);
  }
}

/**
 * The cause of a change someone made, with who they are: "Sam" rather than "You". Only for people's own changes
 * (`user`, `assistant`) from a member's own key; a mode or an automation is never anyone's.
 */
export function withWho(cause: Cause, a: Actor | undefined = currentActor()): Cause {
  // The master key (and a key from before accounts) is no one in particular: Activity reads as it always did.
  if (!a?.personId || (cause.kind !== 'user' && cause.kind !== 'assistant') || cause.by) return cause;
  return { ...cause, by: { id: a.personId, name: a.name } };
}

/** Run fn as the same person, already checked (a room AC asked for by a room they may use). */
export function trusted<T>(fn: () => T): T {
  const a = currentActor();
  return a ? actors.run({ ...a, trusted: true }, fn) : fn();
}
