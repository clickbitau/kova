import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Sessions, Session } from './sessions.ts';
import { ROLES, ROLE_LABEL, type Actor, type Role } from './actor.ts';

// Household accounts, kept on the hub (no cloud). A member is one of the home's people with a role; an invite is a
// one-time code (a link and a QR) that gives a new device that person's own key. Keys and invite codes are kept only
// as hashes. The hub's master key stays the owner's, for recovery and for the phone app's original pairing.

export interface Member {
  personId: string;
  role: Role;
  /** Child, guest: the rooms whose devices they may use. */
  rooms?: string[];
  /** Guest: single devices as well. */
  devices?: string[];
  /** Guest: access ends then (Unix ms); none means until it's taken away. */
  until?: number;
  /** Their own room, for "turn off my room" in Ask Kova. */
  room?: string;
  added: number;
}

export interface Invite {
  id: string;
  hash: string;
  role: Role;
  /** Who it's for: an existing person, or a name for a new one; neither lets the invitee pick. */
  personId?: string;
  name?: string;
  rooms?: string[];
  devices?: string[];
  until?: number;
  created: number;
  /** The code works until then (24 hours). */
  expires: number;
  by: string;
  used?: { at: number; personId: string };
}

/** What the owner sees of an invite (never its code once made). */
export interface InviteView { id: string; role: Role; roleLabel: string; personId?: string; name?: string; rooms?: string[]; devices?: string[]; until?: number; created: number; expires: number; expired: boolean; by: string }

const KEY = 'household';
interface Saved { members: Member[]; invites: Invite[] }

export const INVITE_MS = 24 * 3600_000;
/** No 0/O, 1/I/L: a code someone may read off one screen and type on another. 10 of 31 letters: ~49 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha = (t: string) => createHash('sha256').update(`kova-invite\0${t}`).digest('hex');
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const normCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class AccountError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'AccountError'; }
}

/**
 * Guessing codes: each address gets a few wrong tries in a window, and the hub as a whole a few more (so many
 * addresses can't guess together). A right code doesn't count.
 */
export class Attempts {
  private byIp = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private o: { perIp: number; total: number; windowMs: number }, private now: () => number = Date.now) {}
  private fresh(l: number[]) { const t = this.now() - this.o.windowMs; return l.filter(x => x > t); }
  blocked(ip: string): boolean {
    this.all = this.fresh(this.all);
    const mine = this.fresh(this.byIp.get(ip) ?? []);
    this.byIp.set(ip, mine);
    return mine.length >= this.o.perIp || this.all.length >= this.o.total;
  }
  fail(ip: string): void {
    const t = this.now();
    this.byIp.set(ip, [...this.fresh(this.byIp.get(ip) ?? []), t]);
    this.all = [...this.fresh(this.all), t];
    if (this.byIp.size > 5000) this.byIp.clear();
  }
}

export class Accounts {
  readonly attempts: Attempts;
  /** Called when someone loses access (removed, or a guest's time ran out): their phones' push, presence keys. */
  onRevoke: (personId: string) => void = () => {};

  constructor(private store: Store, private config: ConfigStore, readonly sessions: Sessions, private now: () => number = Date.now) {
    this.attempts = new Attempts({ perIp: 10, total: 40, windowMs: 15 * 60_000 }, now);
  }

  private load(): Saved { const s = this.store.get<Saved>(KEY); return { members: s?.members ?? [], invites: s?.invites ?? [] }; }
  private save(s: Saved): void { this.store.set(KEY, s); }

  private person(id: string | undefined) { return id ? this.config.get().people.find(p => p.id === id) : undefined; }

  members(): Member[] {
    // A person deleted from the home is no longer a member.
    const people = new Set(this.config.get().people.map(p => p.id));
    return this.load().members.filter(m => people.has(m.personId));
  }
  member(personId: string | undefined): Member | undefined { return personId ? this.members().find(m => m.personId === personId) : undefined; }

  /** Whether a guest's time is up. */
  expired(m: Member): boolean { return m.until != null && m.until <= this.now(); }

  /**
   * Who a signed-in device is, or null when it no longer gets in (its person was removed from the home or isn't a
   * member, or a guest whose time ran out).
   */
  actorFor(s: Session): Actor | null {
    if (!s.personId) return { role: 'owner', name: 'Owner', via: 'session', sessionId: s.id };
    const p = this.person(s.personId), m = this.member(s.personId);
    if (!p || !m || this.expired(m)) return null;
    return {
      role: m.role, personId: p.id, name: p.name, via: 'session', sessionId: s.id,
      ...(m.role === 'child' || m.role === 'guest' ? { rooms: [...(m.rooms ?? [])] } : {}),
      ...(m.role === 'guest' ? { devices: [...(m.devices ?? [])] } : {}),
      ...(m.room ? { room: m.room } : {}),
    };
  }

  // ------------------------------------------------------------- members --

  private clean(role: unknown, b: { rooms?: unknown; devices?: unknown; until?: unknown; room?: unknown }, was?: Member) {
    if (!ROLES.includes(role as Role)) throw new AccountError('Choose a role: owner, adult, child or guest');
    const r = role as Role;
    const cfg = this.config.get();
    const ids = (v: unknown, known: (id: string) => boolean, what: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v)) throw new AccountError(`${what} is a list`);
      const out = [...new Set(v.map(String))];
      const bad = out.find(x => !known(x));
      if (bad) throw new AccountError(`There’s no ${what === 'rooms' ? 'room' : 'device'} “${bad}”`);
      return out;
    };
    const rooms = ids(b.rooms, id => cfg.rooms.some(x => x.id === id), 'rooms') ?? was?.rooms;
    const devices = ids(b.devices, () => true, 'devices') ?? was?.devices;
    let until = b.until === undefined ? was?.until : b.until === null ? undefined : Number(b.until);
    if (until !== undefined && (!Number.isFinite(until) || until <= this.now())) throw new AccountError('Choose when their access ends, later than now');
    if (r !== 'guest') until = undefined;
    const room = b.room === undefined ? was?.room : b.room === null || b.room === '' ? undefined : String(b.room);
    if (room && !cfg.rooms.some(x => x.id === room)) throw new AccountError('There’s no such room');
    return {
      role: r,
      ...(r === 'child' || r === 'guest' ? { rooms: rooms ?? [] } : {}),
      ...(r === 'guest' ? { devices: devices ?? [] } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(room ? { room } : {}),
    };
  }

  /** Change a member's role, rooms, devices, end time or own room. */
  update(personId: string, b: { role?: unknown; rooms?: unknown; devices?: unknown; until?: unknown; room?: unknown }): Member {
    const s = this.load();
    const was = s.members.find(m => m.personId === personId);
    if (!was || !this.person(personId)) throw new AccountError('They aren’t a member of this home', 404);
    const m: Member = { personId, added: was.added, ...this.clean(b.role ?? was.role, b, was) };
    this.save({ ...s, members: s.members.map(x => (x.personId === personId ? m : x)) });
    return m;
  }

  /** Remove a member: every device of theirs is signed out, their invites stop working, and onRevoke runs. */
  remove(personId: string): { signedOut: number } {
    const s = this.load();
    if (!s.members.some(m => m.personId === personId)) throw new AccountError('They aren’t a member of this home', 404);
    this.save({ members: s.members.filter(m => m.personId !== personId), invites: s.invites.filter(i => i.personId !== personId || !!i.used) });
    const signedOut = this.sessions.removePerson(personId);
    this.onRevoke(personId);
    return { signedOut };
  }

  /** Make someone a member (the owner saying "this is me", or an invite accepted). */
  private join(personId: string, role: Role, b: Partial<Member>): Member {
    const s = this.load();
    const was = s.members.find(m => m.personId === personId);
    if (was) return was;
    const m: Member = { personId, added: this.now(), ...this.clean(role, b) };
    this.save({ ...s, members: [...s.members, m] });
    return m;
  }

  /**
   * The owner (master key, or an owner key from before accounts) says which of the people they are: that person
   * becomes an owner member (if not a member yet). A signed-in key (`sessionId`) becomes theirs; with the master key,
   * a new key of theirs is made for this device.
   */
  claim(personId: string, deviceName: unknown, sessionId?: string): { token: string | null; member: Member } {
    if (!this.person(personId)) throw new AccountError('Unknown person', 404);
    const member = this.join(personId, 'owner', {});
    if (sessionId) { this.sessions.assign(sessionId, personId); return { token: null, member }; }
    return { token: this.sessions.issue(deviceName, { personId }).token, member };
  }

  // ------------------------------------------------------------- invites --

  private code(): string {
    const raw = randomBytes(10);
    const c = Array.from(raw, b => ALPHABET[b % ALPHABET.length]).join('');
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  }

  invites(): InviteView[] {
    const t = this.now();
    return this.load().invites.filter(i => !i.used).map(i => this.view(i, t)).sort((a, b) => b.created - a.created);
  }
  private view(i: Invite, t = this.now()): InviteView {
    const { hash: _h, used: _u, ...rest } = i;
    return { ...rest, roleLabel: ROLE_LABEL[i.role], expired: i.expires <= t };
  }

  /** A new invite: its code is shown once (in the link and the QR) and kept only as a hash. */
  invite(b: { role?: unknown; personId?: unknown; name?: unknown; rooms?: unknown; devices?: unknown; until?: unknown }, by: string): { invite: InviteView; code: string } {
    const personId = typeof b.personId === 'string' && b.personId ? b.personId : undefined;
    if (personId && !this.person(personId)) throw new AccountError('Unknown person', 404);
    if (personId && this.member(personId)) throw new AccountError(`${this.person(personId)!.name} already has an account: sign in another device of theirs from one they use, or remove them first`);
    const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || undefined : undefined;
    const rules = this.clean(b.role ?? 'adult', b);
    const code = this.code(), t = this.now();
    const i: Invite = { id: randomUUID(), hash: sha(normCode(code)), ...rules, ...(personId ? { personId } : name ? { name } : {}), created: t, expires: t + INVITE_MS, by };
    const s = this.load();
    // Used invites are kept a week (who joined with which), then dropped; lapsed ones a week too.
    const keep = s.invites.filter(x => (x.used ? x.used.at : x.expires) > t - 7 * 86400_000);
    this.save({ ...s, invites: [...keep, i] });
    return { invite: this.view(i), code };
  }

  /** A fresh code for an invite (the old one stops working), good for another 24 hours. */
  resend(id: string): { invite: InviteView; code: string } {
    const s = this.load();
    const i = s.invites.find(x => x.id === id && !x.used);
    if (!i) throw new AccountError('No such invite', 404);
    const code = this.code(), t = this.now();
    const n: Invite = { ...i, hash: sha(normCode(code)), created: t, expires: t + INVITE_MS };
    this.save({ ...s, invites: s.invites.map(x => (x.id === id ? n : x)) });
    return { invite: this.view(n), code };
  }

  cancel(id: string): boolean {
    const s = this.load();
    if (!s.invites.some(x => x.id === id && !x.used)) return false;
    this.save({ ...s, invites: s.invites.filter(x => x.id !== id) });
    return true;
  }

  /** The invite a code belongs to, if it still works; a wrong code counts against the address that sent it. */
  private find(code: unknown, ip: string): Invite {
    if (this.attempts.blocked(ip)) throw new AccountError('Too many tries. Wait a few minutes, then try again.', 429);
    const want = normCode(code);
    const h = want.length === 10 ? sha(want) : '';
    const i = h ? this.load().invites.find(x => eq(x.hash, h)) : undefined;
    if (!i || i.used || i.expires <= this.now()) {
      this.attempts.fail(ip);
      throw new AccountError(i?.used ? 'This invite has been used. Ask for a new one.' : i ? 'This invite has expired. Ask for a new one.' : 'That invite code isn’t right.', i ? 410 : 404);
    }
    return i;
  }

  /** What an invite is for, shown before it's accepted: the home, the role, and who they can be. */
  peek(code: unknown, ip: string) {
    const i = this.find(code, ip);
    const cfg = this.config.get();
    const taken = new Set(this.members().map(m => m.personId));
    const fixed = i.personId ? this.person(i.personId) : undefined;
    return {
      home: cfg.name, role: i.role, roleLabel: ROLE_LABEL[i.role], expires: i.expires, ...(i.until ? { until: i.until } : {}),
      rooms: (i.rooms ?? []).map(id => cfg.rooms.find(r => r.id === id)?.name ?? id),
      // A named invite is for that person; otherwise the invitee picks one of the home's people without an account, or is someone new.
      person: fixed ? { id: fixed.id, name: fixed.name } : null,
      name: i.name ?? null,
      people: fixed || i.name ? [] : cfg.people.filter(p => !taken.has(p.id)).map(p => ({ id: p.id, name: p.name })),
    };
  }

  /**
   * Accept an invite: the person (picked, or new with `name`), their membership, and this device's own key. The code
   * is used up at once, so it can't be accepted twice.
   */
  accept(code: unknown, b: { personId?: unknown; name?: unknown; device?: unknown }, ip: string, addPerson: (name: string) => string): { token: string; personId: string; name: string; role: Role; session: Session } {
    const i = this.find(code, ip);
    const cfg = this.config.get();
    let personId = i.personId;
    if (!personId && typeof b.personId === 'string' && b.personId && !i.name) {
      if (!cfg.people.some(p => p.id === b.personId)) throw new AccountError('Unknown person', 404);
      if (this.member(b.personId)) throw new AccountError('That person already has an account. Pick yourself, or add yourself as someone new.');
      personId = b.personId;
    }
    if (!personId) {
      const name = (typeof b.name === 'string' ? b.name : i.name ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) throw new AccountError('Pick who you are, or type your name');
      personId = addPerson(name);
    }
    if (this.member(personId)) throw new AccountError('That person already has an account.');
    const rules = this.clean(i.role, { rooms: i.rooms, devices: i.devices, until: i.until });
    // The code is used up, and they're a member, in one write.
    const s = this.load();
    const m: Member = { personId, added: this.now(), ...rules };
    this.save({ members: [...s.members.filter(x => x.personId !== personId), m], invites: s.invites.map(x => (x.id === i.id ? { ...x, used: { at: this.now(), personId: personId! } } : x)) });
    const { token, session } = this.sessions.issue(b.device, { personId });
    return { token, personId, name: this.person(personId)?.name ?? personId, role: m.role, session };
  }
}
