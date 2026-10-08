import type { Store } from '../store/db.ts';

// What each person hears about, and how often (services/notify.ts asks before every send).
//
// Every notification has a kind (the doorbell, Warden's blocked attacks, the home's alerts…). Each person chooses, per
// kind: every time, at most once an hour / every 6 hours / once a day, or never. Phones of no one in particular (and
// ntfy, which the household shares) follow the household's choices ("*"), which the owner sets. A kind held back is
// counted, and the next one that goes says how many there were ("and 35 more like this in the last 6 hours").
// The household's on/off switches in Integrations → Notifications still turn a kind off for everyone.

export type NotifyKind =
  | 'doorbell' | 'camera' | 'everyoneOut' | 'offline' | 'links' | 'internet' | 'newDevice' | 'threats' | 'power'
  | 'home' | 'automations' | 'updates';

/** A choice: every time, at most once in that many hours, or never. */
export type NotifyPref = 'on' | 'off' | 1 | 6 | 24;

export const NOTIFY_KINDS: { id: NotifyKind; label: string; help: string; icon: string; group: 'home' | 'network' | 'kova' }[] = [
  { id: 'doorbell', label: 'Doorbell rings', help: 'Someone at the door, with the camera', icon: 'doorbell', group: 'home' },
  { id: 'camera', label: 'Cameras', help: 'People, cars or animals a camera is set to tell you about', icon: 'videocam', group: 'home' },
  { id: 'everyoneOut', label: 'Lights left on', help: 'Everyone’s out and lights are still on', icon: 'lightbulb', group: 'home' },
  { id: 'home', label: 'Home alerts', help: 'A filter to replace, poor air, heat and cold, low batteries', icon: 'home', group: 'home' },
  { id: 'offline', label: 'A device stops responding', help: 'Offline for 10 minutes or more', icon: 'wifi_off', group: 'home' },
  { id: 'automations', label: 'Messages from automations', help: 'Automations with a “Tell me” step', icon: 'bolt', group: 'home' },
  { id: 'internet', label: 'The internet', help: 'Down, back, or on the backup connection', icon: 'router', group: 'network' },
  { id: 'threats', label: 'Attacks Warden blocked', help: 'Password guessing, scans: Warden already blocks them', icon: 'shield', group: 'network' },
  { id: 'newDevice', label: 'New devices on the network', help: 'Something joined your Wi-Fi', icon: 'devices', group: 'network' },
  { id: 'power', label: 'Router power', help: 'A power supply failed or came back', icon: 'power', group: 'network' },
  { id: 'links', label: 'Kova lost a link', help: 'Helix, Warden or a cloud stopped answering', icon: 'link_off', group: 'kova' },
  { id: 'updates', label: 'Kova updates', help: 'A new version, and how an update went', icon: 'cloud_download', group: 'kova' },
];

export const NOTIFY_CHOICES: { value: NotifyPref; label: string }[] = [
  { value: 'on', label: 'Every time' },
  { value: 1, label: 'At most once an hour' },
  { value: 6, label: 'At most every 6 hours' },
  { value: 24, label: 'At most once a day' },
  { value: 'off', label: 'Never' },
];

/** Out of the box: everything, except Warden's blocked attacks (they can come every few minutes), every 6 hours. */
export const NOTIFY_DEFAULTS: Partial<Record<NotifyKind, NotifyPref>> = { threats: 6 };

/** Phones of no one in particular, and ntfy. */
export const HOUSEHOLD = '*';

/** A notification's kind, from its tag (each sender tags what it sends). Null: always goes (a test). */
export function kindOf(tag: string | undefined): NotifyKind | null {
  const t = tag ?? '';
  if (t.startsWith('ring-')) return 'doorbell';
  if (t.startsWith('security-')) return 'camera';
  if (t === 'everyone-out') return 'everyoneOut';
  if (t.startsWith('offline-')) return 'offline';
  if (t.startsWith('link-')) return 'links';
  if (t === 'internet') return 'internet';
  if (t === 'warden-new-device') return 'newDevice';
  if (t === 'warden-threat') return 'threats';
  if (t.startsWith('power-')) return 'power';
  if (t.startsWith('automation-')) return 'automations';
  if (t === 'kova-update') return 'updates';
  if (t === 'test' || !t) return null;
  return 'home';
}

export function cleanPref(v: unknown): NotifyPref {
  if (v === 'on' || v === 'off') return v;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (n === 1 || n === 6 || n === 24) return n;
  throw new Error('Choose every time, at most once an hour, every 6 hours, once a day, or never');
}

interface Held { last: number; held: number }

export class NotifyPrefs {
  constructor(private store: Store) {}

  private all(): Record<string, Partial<Record<NotifyKind, NotifyPref>>> { return this.store.get('notifyPrefs') ?? {}; }

  /** A person's choices (or the household's), every kind filled in. */
  of(who: string | undefined): Record<NotifyKind, NotifyPref> {
    const all = this.all(), own = all[who ?? HOUSEHOLD] ?? {}, house = all[HOUSEHOLD] ?? {};
    // A person who hasn't chosen follows the household's choice, then the default.
    return Object.fromEntries(NOTIFY_KINDS.map(k => [k.id, own[k.id] ?? house[k.id] ?? NOTIFY_DEFAULTS[k.id] ?? 'on'])) as Record<NotifyKind, NotifyPref>;
  }

  set(who: string | undefined, kind: string, value: unknown): Record<NotifyKind, NotifyPref> {
    if (!NOTIFY_KINDS.some(k => k.id === kind)) throw new Error(`“${kind}” isn’t a kind of notification`);
    const v = cleanPref(value);
    const all = this.all(), key = who ?? HOUSEHOLD;
    all[key] = { ...(all[key] ?? {}), [kind]: v };
    this.store.set('notifyPrefs', all);
    return this.of(who);
  }

  /** A person who left: their choices go too. */
  forget(who: string): void {
    const all = this.all();
    if (!(who in all)) return;
    delete all[who];
    this.store.set('notifyPrefs', all);
    const h = this.store.get<Record<string, Held>>('notifyHeld') ?? {};
    for (const k of Object.keys(h)) if (k.startsWith(`${who}|`)) delete h[k];
    this.store.set('notifyHeld', h);
  }

  /**
   * Whether one of this kind goes to this person now. When it does after some were held back, `more` says how many,
   * and over how long. A held one is counted.
   */
  gate(who: string | undefined, kind: NotifyKind | null, now: number): { send: boolean; more?: { n: number; hours: number } } {
    if (!kind) return { send: true };
    const p = this.of(who)[kind];
    if (p === 'off') return { send: false };
    if (p === 'on') return { send: true };
    const h = this.store.get<Record<string, Held>>('notifyHeld') ?? {};
    const key = `${who ?? HOUSEHOLD}|${kind}`, cur = h[key];
    if (cur && now - cur.last < p * 3_600_000) {
      h[key] = { ...cur, held: cur.held + 1 };
      this.store.set('notifyHeld', h);
      return { send: false };
    }
    h[key] = { last: now, held: 0 };
    this.store.set('notifyHeld', h);
    return cur?.held ? { send: true, more: { n: cur.held, hours: p } } : { send: true };
  }
}

/** "And 35 more like this in the last 6 hours." */
export const moreWords = (m: { n: number; hours: number }) =>
  `And ${m.n} more like this in the last ${m.hours === 1 ? 'hour' : m.hours === 24 ? 'day' : `${m.hours} hours`}.`;
