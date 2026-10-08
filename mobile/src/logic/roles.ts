// Household accounts in the app: who this phone is signed in as, and what their role lets the app show. The hub
// decides (it refuses anything else with 403 and its own words); this only keeps the app from offering what won't
// work. Kept free of React Native so it can be tested under Node.

export type Role = 'owner' | 'adult' | 'child' | 'guest';
export type Perm = 'view' | 'control' | 'cameras' | 'history' | 'people' | 'modes' | 'automate' | 'home' | 'owner';

/** Who the app is signed in as (the hub's snapshot `me`, hubs from 0.7.61). */
export interface Me {
  role: Role;
  roleLabel: string;
  personId: string | null;
  name: string;
  rooms: string[] | null;
  devices: string[] | null;
  until: number | null;
  room: string | null;
  /** Their username for signing in, if set. */
  user?: string | null;
  via: 'master' | 'session' | 'open';
  can: Record<Perm, boolean>;
}

const ALL: Perm[] = ['view', 'control', 'cameras', 'history', 'people', 'modes', 'automate', 'home', 'owner'];

/** A hub from before accounts sends no `me`: the app has the master key there, so it's the owner. */
export const OWNER: Me = { role: 'owner', roleLabel: 'Owner', personId: null, name: 'Owner', rooms: null, devices: null, until: null, room: null, via: 'master', can: Object.fromEntries(ALL.map(p => [p, true])) as Record<Perm, boolean> };

export function meOf(s: { me?: Partial<Me> | null } | null | undefined): Me {
  const m = s?.me;
  if (!m || !m.role) return OWNER;
  return { ...OWNER, ...m, can: { ...Object.fromEntries(ALL.map(p => [p, false])), ...(m.can ?? {}) } as Record<Perm, boolean> };
}

export const ROLES: { id: Role; label: string; text: string }[] = [
  { id: 'owner', label: 'Owner', text: 'Everything, including people, integrations, updates and backups.' },
  { id: 'adult', label: 'Adult', text: 'Devices, modes, automations and Ask Kova. Not integrations, updates, accounts or backups.' },
  { id: 'child', label: 'Child', text: 'Devices in the rooms you choose. No automations or settings.' },
  { id: 'guest', label: 'Guest', text: 'The rooms or devices you choose, until a time you set. No history or cameras.' },
];
export const roleText = (r: Role) => ROLES.find(x => x.id === r)?.text ?? '';
/** Child and guest use only some rooms. */
export const roomsMatter = (r: Role) => r === 'child' || r === 'guest';

/** What the app shows for this person: tabs, More's rows, Now's controls. */
export function features(me: Me) {
  return {
    security: me.can.cameras,
    modes: me.can.modes,
    automations: me.can.automate,
    activity: me.role !== 'guest',
    sensors: me.can.history,
    energy: me.can.history,
    settings: me.can.home,
    customise: me.can.home,
    integrations: me.can.owner,
    manage: me.can.owner,
  };
}

export type TabName = 'Now' | 'Devices' | 'Ask' | 'Security' | 'More';
export function tabsFor(me: Me): TabName[] {
  return (['Now', 'Devices', 'Ask', 'Security', 'More'] as TabName[]).filter(t => t !== 'Security' || features(me).security);
}

/** "Owner", "Child · Baby room", "Guest · Guest room · until Sun 18:00". */
export function roleLine(me: Pick<Me, 'roleLabel' | 'rooms' | 'until'>, roomName: (id: string) => string, now = Date.now()): string {
  return [me.roleLabel, me.rooms?.length ? me.rooms.map(roomName).join(', ') : me.rooms ? 'No rooms yet' : '', me.until ? untilWords(me.until, now) : ''].filter(Boolean).join(' · ');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "until 18:00 today", "until tomorrow 18:00", "until Sun 18:00", "until 3 Nov"; "ended" once past. */
export function untilWords(t: number, now = Date.now()): string {
  if (t <= now) return 'access ended';
  const d = new Date(t), n = new Date(now);
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60_000) / 86400_000);
  const diff = day(d) - day(n);
  if (diff === 0) return `until ${hm(d)} today`;
  if (diff === 1) return `until tomorrow ${hm(d)}`;
  if (diff < 7) return `until ${DAYS[d.getDay()]} ${hm(d)}`;
  return `until ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
}

/** A guest's end time, as quick choices: tonight, tomorrow, until Sunday, a week; or no end. Each at a round hour. */
export function untilPresets(now = Date.now()): { id: string; label: string; at: number | null }[] {
  const at = (days: number, hour: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const n = new Date(now);
  const toSunday = (7 - n.getDay()) % 7 || 7;
  const tonight = at(0, 23);
  return [
    ...(tonight > now + 30 * 60_000 ? [{ id: 'tonight', label: 'Tonight', at: tonight }] : []),
    { id: 'tomorrow', label: 'Tomorrow', at: at(1, 18) },
    { id: 'sunday', label: 'Until Sunday', at: at(toSunday, 18) },
    { id: 'week', label: 'A week', at: at(7, 18) },
    { id: 'none', label: 'No end', at: null },
  ];
}

/** "just now", "5 min ago", "yesterday", "3 d ago", "never". */
export function seenWords(t: number | null | undefined, now = Date.now()): string {
  if (!t) return 'not seen yet';
  const m = Math.round((now - t) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : m < 2880 ? 'yesterday' : `${Math.round(m / 1440)} d ago`;
}

/** The presence key in an arrive/leave URL from GET /api/me (…/presence?key=…&home=1). */
export function presenceKeyFrom(url: string | null | undefined): string | null {
  const m = /[?&]key=([^&]+)/.exec(url ?? '');
  return m ? decodeURIComponent(m[1]!) : null;
}

/** What an invite or a member change sends: rooms only for a child or a guest, an end time only for a guest. */
export function accessBody(d: { role: Role; rooms: string[]; until: number | null }): { role: Role; rooms?: string[]; until?: number | null } {
  return { role: d.role, ...(roomsMatter(d.role) ? { rooms: d.rooms } : {}), ...(d.role === 'guest' ? { until: d.until } : {}) };
}

/** Why an invite can't be made yet, or null. */
export function inviteProblem(d: { role: Role; rooms: string[] }): string | null {
  if (roomsMatter(d.role) && !d.rooms.length) return `Choose at least one room ${d.role === 'child' ? 'they' : 'your guest'} can use.`;
  return null;
}

/** How a pending invite reads: "Adult · for Sam · expires in 23 h". */
export function inviteLine(i: { roleLabel: string; name?: string | null; personId?: string; expires: number; expired?: boolean }, personName: (id: string) => string, now = Date.now()): string {
  const who = i.personId ? `for ${personName(i.personId)}` : i.name ? `for ${i.name}` : 'anyone';
  const h = Math.max(0, Math.round((i.expires - now) / 3600_000));
  return [i.roleLabel, who, i.expired || i.expires <= now ? 'expired: resend it' : h < 1 ? 'expires within the hour' : `expires in ${h} h`].join(' · ');
}
