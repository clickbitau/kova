import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';

// Signing a browser in without handing it the hub's master key. The browser asks for a short code, someone already
// signed in (the phone app, or another browser) approves it, and the browser gets a key of its own: kept on the hub
// only as a hash, listed with the device it came from, and signed out on its own.

/**
 * A signed-in device. `personId`: whose it is (household accounts, services/accounts.ts). A key made before
 * accounts existed has none and is the owner's (`owner: true`, set once on upgrade).
 */
export interface Session { id: string; name: string; hash: string; created: number; lastSeen: number; personId?: string; owner?: boolean }
export interface SessionView { id: string; name: string; created: number; lastSeen: number; current?: boolean; personId?: string }

/** Who a new key belongs to: a person, or (the master key, an owner key from before accounts) the owner. */
export interface Owner { personId?: string }

interface Pending { id: string; code: string; name: string; until: number; approved?: { token: string; by: string } }

/** No 0/O, 1/I/L: a code someone reads off one screen and types on another. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_MS = 5 * 60_000;
const MAX_PENDING = 10;
const KEY = 'web-sessions';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** "Chrome on Mac", "Safari on iPhone": enough to tell sessions apart in a list. */
export function deviceName(ua = ''): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** A name a device gave itself: plain text, short, or nothing. */
function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.replace(/[\u0000-\u001f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  return n || null;
}

export class Sessions {
  private pending: Pending[] = [];
  private seenWrite = 0;

  constructor(private store: Store, private now: () => number = Date.now) {
    // Upgrading to household accounts: every key signed in before is the owner's, as it always had full access.
    const l = this.all();
    if (l.some(x => !x.personId && !x.owner)) this.save(l.map(x => (x.personId || x.owner ? x : { ...x, owner: true })));
  }

  all(): Session[] { return this.store.get<Session[]>(KEY) ?? []; }
  private save(l: Session[]): void { this.store.set(KEY, l); }

  /** The session a key belongs to (and note it was used), or null. */
  check(token: string | undefined): Session | null {
    if (!token || token.length < 32) return null;
    const h = sha(token);
    const s = this.all().find(x => eq(x.hash, h));
    if (!s) return null;
    // Last seen, at most once a minute (every request would be a write).
    if (this.now() - s.lastSeen > 60_000 && this.now() - this.seenWrite > 1000) {
      this.seenWrite = this.now();
      this.save(this.all().map(x => (x.id === s.id ? { ...x, lastSeen: this.now() } : x)));
    }
    return s;
  }

  /**
   * A browser (or the phone app, signing in again) asks to sign in: a code to show, and an id to wait on.
   * `name` is what it calls itself ("Kova app on iPhone"); without one it's named from its user agent.
   */
  start(ua?: string, name?: unknown): { id: string; code: string; expiresAt: number } {
    const t = this.now();
    this.pending = this.pending.filter(p => p.until > t);
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    const raw = randomBytes(8);
    const code = Array.from(raw, b => ALPHABET[b % ALPHABET.length]).join('');
    const p: Pending = { id: randomUUID(), code: `${code.slice(0, 4)}-${code.slice(4)}`, name: cleanName(name) ?? deviceName(ua), until: t + CODE_MS };
    this.pending.push(p);
    return { id: p.id, code: p.code, expiresAt: p.until };
  }

  /**
   * Someone signed in typed the code: the browser gets its key the next time it asks. The key is the approver's:
   * it signs in *them* on another device (their person, or the owner for the master key).
   */
  approve(code: string, by: string, owner: Owner = {}): { name: string } | null {
    const want = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = this.pending.find(x => x.until > this.now() && !x.approved && x.code.replace('-', '') === want);
    if (!p) return null;
    p.approved = { token: this.issue(p.name, owner).token, by };
    return { name: p.name };
  }

  /** A new key for a device, kept only as its hash: an invite accepted, or a phone taking a person's own key. */
  issue(name: unknown, owner: Owner = {}): { token: string; session: Session } {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    const session: Session = { id: randomUUID(), name: cleanName(name) ?? 'A device', hash: sha(token), created: t, lastSeen: t, ...(owner.personId ? { personId: owner.personId } : { owner: true }) };
    this.save([...this.all(), session]);
    return { token, session };
  }

  /** The browser waiting: its key once (then the code is gone), or still waiting, or expired. */
  poll(id: string): { state: 'waiting' | 'expired' } | { state: 'approved'; token: string } {
    const p = this.pending.find(x => x.id === id);
    if (!p || p.until <= this.now()) return { state: 'expired' };
    if (!p.approved) return { state: 'waiting' };
    this.pending = this.pending.filter(x => x !== p);
    return { state: 'approved', token: p.approved.token };
  }

  /** Signed-in devices, most recently used first; `only` keeps one person's ("owner": the owner's unlinked keys). */
  list(current?: string, only?: (s: Session) => boolean): SessionView[] {
    const h = current ? sha(current) : '';
    return this.all().filter(s => !only || only(s)).map(s => ({ id: s.id, name: s.name, created: s.created, lastSeen: s.lastSeen, ...(s.personId ? { personId: s.personId } : {}), ...(h && eq(s.hash, h) ? { current: true } : {}) }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get(id: string): Session | undefined { return this.all().find(s => s.id === id); }

  /** Sign out every device of a person (a member removed). How many there were. */
  removePerson(personId: string): number {
    const l = this.all();
    const keep = l.filter(s => s.personId !== personId);
    if (keep.length !== l.length) this.save(keep);
    return l.length - keep.length;
  }

  /** Give an owner key from before accounts to a person (the owner saying "this is me"). */
  assign(id: string, personId: string): boolean {
    const l = this.all();
    if (!l.some(s => s.id === id)) return false;
    this.save(l.map(s => (s.id === id ? { ...s, personId, owner: undefined } : s)));
    return true;
  }

  /** Sign a session out. */
  remove(id: string): boolean {
    const l = this.all();
    if (!l.some(s => s.id === id)) return false;
    this.save(l.filter(s => s.id !== id));
    return true;
  }
}
