// Integration setup, as plain TypeScript (tested under Node). The hub's catalog (GET /api/integrations/catalog)
// describes each integrations.json section: its fields and its actions (link an account, pair, find speakers).
// The setup screen is generated from it. This file turns a saved section into form state and back, keeps
// secrets the hub redacted ("••••") as they are unless they're changed, checks what's required, and sorts
// the list so what needs attention comes first.

export interface Option { value: string; label: string }

export interface Field {
  /** Where the value lives in the section. Dots reach into nested objects ("opnsense.url"). */
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'list';
  placeholder?: string;
  help?: string;
  required?: boolean;
  options?: Option[] | 'rooms' | 'people';
  /** text: a list of strings, typed comma-separated. */
  multiple?: boolean;
  item?: Field[];
  /** list: an array of rows, or ('map') an object keyed by the row's `mapKey`, valued by the rest or by `mapValue`. */
  shape?: 'array' | 'map';
  mapKey?: string;
  mapValue?: string;
  addLabel?: string;
}

export interface Action {
  id: string;
  label: string;
  icon: string;
  method: 'GET' | 'POST';
  path: string;
  fields?: Field[];
  help?: string;
  /** The answer has a `url` to open (a sign-in page). */
  opensUrl?: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  icon: string;
  kind: 'Local' | 'Cloud';
  description: string;
  fields: Field[];
  actions?: Action[];
  apply: 'hot' | 'restart';
  testable?: boolean;
}

/** What the hub shows instead of a stored secret. Sending it back keeps the secret. */
export const SECRET = '••••';

/** A form's state: every scalar as a string (what a text field holds), every list as an array of row forms. */
export type Form = { [k: string]: FormValue };
export type FormValue = string | Form[] | Form | undefined;
type Path = (string | number)[];

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
export const keyPath = (f: Field): string[] => f.key.split('.');

export function getIn(o: unknown, path: Path): unknown {
  return path.reduce<unknown>((v, k) => (v != null && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined), o);
}

/** A copy of `o` with `value` at `path` (objects and arrays on the way are copied, not changed). */
export function setIn<T>(o: T, path: Path, value: unknown): T {
  if (!path.length) return value as T;
  const [k, ...rest] = path;
  const base: Record<string | number, unknown> | unknown[] = Array.isArray(o) ? [...o] : isObj(o) ? { ...o } : typeof k === 'number' ? [] : {};
  (base as Record<string | number, unknown>)[k] = setIn((base as Record<string | number, unknown>)[k], rest, value);
  return base as T;
}

function deleteIn(o: Record<string, unknown>, path: string[]): void {
  const parent = getIn(o, path.slice(0, -1));
  if (isObj(parent)) delete parent[path[path.length - 1]];
  // An object left empty by it goes too ("opnsense": {}).
  if (path.length > 1) {
    const p = getIn(o, path.slice(0, -1));
    if (isObj(p) && !Object.keys(p).length) deleteIn(o, path.slice(0, -1));
  }
}

function putIn(o: Record<string, unknown>, path: string[], v: unknown): void {
  let x = o;
  for (const k of path.slice(0, -1)) { if (!isObj(x[k])) x[k] = {}; x = x[k] as Record<string, unknown>; }
  x[path[path.length - 1]] = v;
}

/** A list field's stored value as rows, whether it's an array or a map. */
export function rowsOf(f: Field, v: unknown): Record<string, unknown>[] {
  if (f.shape === 'map') {
    if (!isObj(v)) return [];
    return Object.entries(v).map(([k, x]) => (f.mapValue ? { [f.mapKey!]: k, [f.mapValue]: x } : { ...(isObj(x) ? x : {}), [f.mapKey!]: k }));
  }
  return Array.isArray(v) ? v.filter(isObj) : [];
}

/** A saved section (as GET /api/integrations/config gives it, secrets as "••••") as form state. Keys the form doesn't show are kept. */
export function toForm(fields: Field[], saved: unknown): Form {
  const o = (isObj(saved) ? clone(saved) : {}) as Record<string, unknown>;
  for (const f of fields) {
    const p = keyPath(f), v = getIn(o, p);
    if (f.type === 'list') putIn(o, p, rowsOf(f, v).map(r => toForm(f.item ?? [], r)));
    else if (f.multiple) putIn(o, p, Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
    else putIn(o, p, v == null ? '' : String(v));
  }
  return o as Form;
}

/** Form state back to a section to PUT: blanks dropped, numbers as numbers, lists in their stored shape, "••••" left for the hub to keep. */
export function fromForm(fields: Field[], form: Form | undefined): Record<string, unknown> {
  const o = (clone(form) ?? {}) as Record<string, unknown>;
  for (const f of fields) {
    const p = keyPath(f), v = getIn(o, p);
    if (f.type === 'list') {
      const rows = (Array.isArray(v) ? v : []).map(r => fromForm(f.item ?? [], r as Form));
      if (f.shape === 'map') {
        const m: Record<string, unknown> = {};
        for (const r of rows) {
          const k = r[f.mapKey!];
          if (k == null || k === '') continue;
          const rest = { ...r };
          delete rest[f.mapKey!];
          m[String(k)] = f.mapValue ? r[f.mapValue] : rest;
        }
        if (Object.keys(m).length) putIn(o, p, m); else deleteIn(o, p);
      } else if (rows.length || f.required) putIn(o, p, rows);
      else deleteIn(o, p);
    } else if (f.multiple) {
      const xs = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
      if (xs.length) putIn(o, p, xs); else deleteIn(o, p);
    } else if (v == null || String(v).trim() === '') deleteIn(o, p);
    else if (f.type === 'number') { const n = Number(String(v).trim()); putIn(o, p, Number.isFinite(n) ? n : v); }
    else if (f.type !== 'password' && typeof v === 'string') putIn(o, p, v.trim());
  }
  return o;
}

/** A new, empty row for a list field. */
export const blankRow = (f: Field): Form => toForm(f.item ?? [], {});

/** A password field still showing the stored secret: shown as "Saved", with Change. */
export const isLocked = (f: Field, v: unknown) => f.type === 'password' && v === SECRET;

export interface Home { rooms: { id: string; name: string }[]; people: { id: string; name: string }[] }

export function optionsFor(f: Field, home: Home): Option[] {
  if (f.options === 'rooms') return home.rooms.map(r => ({ value: r.id, label: r.name }));
  if (f.options === 'people') return home.people.map(p => ({ value: p.id, label: p.name }));
  return f.options ?? [];
}

/** Few short choices fit a segmented control; more go in a sheet. */
export const segmentable = (opts: Option[]) => opts.length >= 2 && opts.length <= 4 && opts.every(o => o.label.length <= 12);

/** A list's name for one row: "Add speaker" → "Speaker". */
export function nounOf(f: Field): string {
  const n = (f.addLabel ?? 'Row').replace(/^Add (an? )?/, '');
  return n[0].toUpperCase() + n.slice(1);
}

/** One line that says what a row is, for a folded row: its name, room and address, as far as they're filled. */
export function rowSummary(f: Field, row: Form, home: Home): string {
  const items = f.item ?? [];
  const bits: string[] = [];
  for (const it of items) {
    if (it.type === 'list' || it.type === 'password') continue;
    const v = row[it.key];
    if (typeof v !== 'string' || !v.trim()) continue;
    bits.push(it.type === 'select' ? (optionsFor(it, home).find(o => o.value === v)?.label ?? v) : v.trim());
    if (bits.length === 3) break;
  }
  return bits.join(' · ');
}

export interface Problem { path: Path; message: string }

/** What has to be filled in before saving (required, numbers, a map's keys told apart). Paths match the form's. */
export function problems(fields: Field[], form: Form | undefined, base: Path = []): Problem[] {
  const out: Problem[] = [];
  for (const f of fields) {
    const p = [...base, ...keyPath(f)];
    const v = getIn(form, keyPath(f));
    if (f.type === 'list') {
      const rows = Array.isArray(v) ? (v as Form[]) : [];
      if (f.required && !rows.length) out.push({ path: p, message: `Add at least one ${nounOf(f).toLowerCase()}` });
      rows.forEach((r, i) => out.push(...problems(f.item ?? [], r, [...p, i])));
      if (f.shape === 'map' && f.mapKey) {
        const seen = new Set<string>();
        rows.forEach((r, i) => {
          const k = String(r[f.mapKey!] ?? '').trim();
          if (k && seen.has(k)) out.push({ path: [...p, i, f.mapKey!], message: 'Already in the list above' });
          seen.add(k);
        });
      }
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) { if (f.required) out.push({ path: p, message: `${f.label} is needed` }); continue; }
    if (f.type === 'number' && !Number.isFinite(Number(s))) out.push({ path: p, message: 'A number' });
  }
  return out;
}

export const pathKey = (p: Path) => p.join('/');

/** A code pasted from a sign-in: the whole address it ended on works, and so does the code alone. */
export function codeFromPaste(text: string): string {
  const raw = text.trim();
  const m = /[?&#]code=([^&#\s]+)/.exec(raw);
  if (!m) return raw;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

// ------------------------------------------------------------ actions --

/**
 * How an integration's actions are laid out. A sign-in flow is one or more actions that open a page (`opensUrl`)
 * followed by the one that takes the code back; pairing and adding come first (they're how it's set up);
 * looking things up (find, show a code, list devices, send a test) comes after the settings.
 */
export interface ActionPlan {
  /** Sign in elsewhere, then paste the code: steps 1 and 2. */
  signIn: { open: Action[]; finish: Action | null } | null;
  /** Pair, link, add a device, fetch keys: set it up. */
  connect: Action[];
  /** Find, show, list, test. */
  tools: Action[];
}

export const isCodeAction = (a: Action) => !a.opensUrl && a.method === 'POST' && (a.fields ?? []).length === 1 && a.fields![0].key === 'code';

export function planActions(item: Pick<CatalogItem, 'actions'>): ActionPlan {
  const acts = item.actions ?? [];
  const open = acts.filter(a => a.opensUrl);
  const finish = open.length ? acts.find(isCodeAction) ?? null : null;
  const rest = acts.filter(a => !a.opensUrl && a !== finish);
  const tool = (a: Action) => (a.method === 'GET') || a.id === 'find' || a.id === 'test';
  return { signIn: open.length ? { open, finish } : null, connect: rest.filter(a => !tool(a)), tools: rest.filter(tool) };
}

/** The button that runs an action. */
export function actionButton(a: Action): { label: string; icon: string } {
  if (a.opensUrl) return { label: a.fields?.length ? 'Continue to sign-in' : 'Open sign-in', icon: 'open_in_new' };
  if (isCodeAction(a)) return { label: a.label, icon: 'check' };
  if (a.method === 'GET') return { label: a.label.startsWith('Show') || a.label.startsWith('Find') ? a.label : `Show ${a.label[0].toLowerCase()}${a.label.slice(1)}`, icon: a.icon };
  return { label: a.label, icon: a.icon };
}

/** Pairing that finishes in the other app (Warden, Helix): the hub answers with a code, and its GET says when it's done. */
export const pollsAfter = (a: Action, res: unknown): boolean => a.method === 'POST' && /\/pair$/.test(a.path) && isObj(res) && typeof res.code === 'string';

export type PairState = 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'none';
export function pairWords(s: PairState, error?: string): { text: string; tone: 'wait' | 'ok' | 'bad' } {
  if (s === 'pending') return { text: error ? `Waiting for you to approve it… (${error})` : 'Waiting for you to approve it…', tone: 'wait' };
  if (s === 'approved') return { text: 'Paired. Kova is connected.', tone: 'ok' };
  if (s === 'denied') return { text: 'Turned down in the other app. Pair again if that was a mistake.', tone: 'bad' };
  if (s === 'expired') return { text: error ?? 'The code ran out before it was approved. Pair again for a new one.', tone: 'bad' };
  return { text: error ?? 'Pairing stopped. Try again.', tone: 'bad' };
}

export interface ResultRow { label: string; value: string; mono?: boolean; copy?: boolean }
export interface ActionResult { headline?: string; code?: string; rows: ResultRow[] }

const human = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const show = (v: unknown): string => {
  if (Array.isArray(v)) return v.length ? v.map(x => (isObj(x) ? String(x.name ?? x.id ?? x.host ?? JSON.stringify(x)) : String(x))).join('\n') : 'None';
  if (isObj(v)) return Object.entries(v).map(([a, b]) => `${human(a)}: ${isObj(b) || Array.isArray(b) ? JSON.stringify(b) : String(b)}`).join('\n');
  return String(v);
};

/** What an action answered, to show under it: the sentence (`next`) first, a pairing code large, the rest as rows. */
export function describeResult(r: unknown): ActionResult {
  if (!isObj(r)) return { rows: r == null ? [] : [{ label: 'Result', value: String(r) }] };
  if (r.enabled === false) return { headline: 'Not running on this hub yet. Save it, then restart the hub if it says so.', rows: [] };
  const codeKey = ['code', 'setupCode', 'manualCode', 'manualPairingCode', 'pin'].find(k => typeof r[k] === 'string' || typeof r[k] === 'number');
  const skip = new Set(['ok', 'enabled', 'next', 'url', 'redirectUri', ...(codeKey ? [codeKey] : [])]);
  const rows = Object.entries(r).filter(([k, v]) => !skip.has(k) && v != null && v !== '').map(([k, v]) => {
    const mono = /code|payload|pin|url|key|mac|host|ip\b/i.test(k);
    return { label: human(k), value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : show(v), mono, copy: mono || /url|key|link/i.test(k) };
  });
  const headline = typeof r.next === 'string' ? r.next : typeof r.status === 'string' && !rows.length ? r.status : undefined;
  return { headline: headline ?? (!rows.length && !codeKey ? 'Done.' : undefined), code: codeKey ? String(r[codeKey]) : undefined, rows };
}

// --------------------------------------------------------------- list --

export interface Live { id: string; name: string; icon: string; kind: string; ok: boolean; note?: string; devices: number }

/** Bridges the hub lists under their own id: the integrations.json section they're set up in. */
const SECTION_OF: Record<string, string> = { 'matter-bridge': 'matterBridge', 'homekit-bridge': 'homekitBridge' };
/** The live list with each one under its section's id, so it matches the catalog and the saved settings. */
export const bySection = (live: Live[]): Live[] => live.map(i => (SECTION_OF[i.id] ? { ...i, id: SECTION_OF[i.id] } : i));

export interface Entry {
  id: string;
  name: string;
  icon: string;
  kind: string;
  ok: boolean;
  /** The status line: the integration's own note, or what's wrong. */
  note: string;
  devices: number;
  /** In the catalog: it has a setup screen. */
  configurable: boolean;
  /** Saved in integrations.json but not running. */
  idle: boolean;
}

/**
 * The integrations to list: everything running (from the snapshot), and anything saved that isn't running (yet).
 * Needing attention first, then by name.
 */
export function entries(liveIn: Live[], config: Record<string, unknown> | null, catalog: CatalogItem[] | null): Entry[] {
  const live = bySection(liveIn);
  const cat = new Map((catalog ?? []).map(c => [c.id, c]));
  const running = new Set(live.map(i => i.id));
  const out: Entry[] = live.map(i => ({
    id: i.id, name: i.name, icon: i.icon, kind: i.kind, ok: i.ok, devices: i.devices ?? 0,
    note: i.note || (i.ok ? 'Connected' : 'Not responding'), configurable: cat.has(i.id), idle: false,
  }));
  for (const id of Object.keys(config ?? {})) {
    if (running.has(id)) continue;
    const c = cat.get(id);
    out.push({
      id, name: c?.name ?? human(id), icon: c?.icon ?? 'extension', kind: c?.kind ?? 'Local', ok: false, devices: 0, configurable: !!c, idle: true,
      note: c?.apply === 'restart' ? 'Saved. Starts when the hub restarts' : 'Saved, not running. Check its settings',
    });
  }
  return out.sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
}

/** The catalog entries that can be added: not set up and not running, matching the search. */
export function addable(catalog: CatalogItem[], config: Record<string, unknown> | null, live: Live[], q = ''): CatalogItem[] {
  const running = new Set(bySection(live).map(i => i.id));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog
    .filter(c => (config ?? {})[c.id] === undefined && !running.has(c.id))
    .filter(c => words.every(w => `${c.name} ${c.description} ${c.kind}`.toLowerCase().includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type Tone = 'ok' | 'warn' | 'idle';
/** The status at the top of an integration's screen. */
export function statusOf(id: string, live: Live[], saved: boolean, item: CatalogItem | undefined): { tone: Tone; title: string; text: string } {
  const run = bySection(live).find(i => i.id === id);
  if (run) {
    const n = `${run.devices} device${run.devices === 1 ? '' : 's'}`;
    return run.ok
      ? { tone: 'ok', title: 'Connected', text: run.note ? `${run.note} · ${n}` : n }
      : { tone: 'warn', title: 'Needs attention', text: run.note || 'Not responding' };
  }
  if (saved) return { tone: 'warn', title: item?.apply === 'restart' ? 'Saved' : 'Not running', text: item?.apply === 'restart' ? 'It starts when the hub restarts.' : 'Saved, but not running. Check the settings and save again.' };
  const signIn = item?.actions?.some(a => a.opensUrl) && !item.fields.some(f => f.required);
  return { tone: 'idle', title: 'Not set up yet', text: signIn ? 'Link your account below to start.' : item?.fields.length ? 'Fill in the settings and save.' : 'Turn it on to start.' };
}

/** After Save: what the hub did with it. */
export function savedWords(r: { applied?: boolean; restartRequired?: boolean; status?: { ok: boolean; note?: string } | null }, isNew: boolean): { ok: boolean; text: string } {
  if (!r.applied) return { ok: true, text: `Saved. Restart the hub to ${isNew ? 'start' : 'apply'} it.` };
  const st = r.status;
  if (!st) return { ok: true, text: 'Saved.' };
  return { ok: st.ok, text: st.ok ? `Saved and restarted. ${st.note || 'Connected.'}` : `Saved, but it isn’t working yet: ${st.note || 'not responding'}` };
}

/** The hub's error ("A is required. B must be a number") as separate lines. */
export const errorLines = (msg: string) => msg.split(/\.\s+(?=[A-Z“"])/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean);

// ---------------------------------------------------------- hub update --

export interface HubUpdate {
  updater: boolean;
  state: 'idle' | 'checking' | 'updating' | 'requested';
  source: 'release' | 'git' | null;
  note: string | null;
  licence?: { hubId: string; installed: boolean; activated: boolean; edition: string | null; key: string | null; error: string | null };
  current: { version: string };
  available: { version: string; behind: number; changes: string[] } | null;
  checkedAt: number | null;
  checkError: string | null;
  last: { result: 'updated' | 'rolled-back' | 'failed'; from: string; to: string; at: number } | null;
  auto: { on: boolean; hour: number };
}

const ago = (t: number | null, now: number) => {
  if (!t) return 'never';
  const m = Math.round((now - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The hub's own software, as the card on Integrations says it (notifications about hub updates open this screen). */
export function describeHubUpdate(u: HubUpdate, now: number) {
  const a = u.available, l = u.last, busy = u.state !== 'idle';
  const title = u.state === 'updating' ? `Updating Kova to ${a?.version ?? 'the new version'}…` : u.state === 'requested' ? 'Asked the hub to update…'
    : a ? `Kova ${a.version} is available` : `Kova ${u.current.version} is up to date`;
  const last = l ? (l.result === 'updated' ? `Updated ${l.from} → ${l.to} ${ago(l.at, now)}.` : l.result === 'rolled-back' ? `An update didn’t start, so Kova went back to ${l.from} ${ago(l.at, now)}.` : `The last update failed ${ago(l.at, now)}.`) : '';
  const lic = u.licence;
  const showKey = !!lic && (u.source !== 'git' || lic.installed);
  const sub = !u.updater ? 'Updates need the updater on the hub: run deploy/update.sh there once.'
    : [a ? `You have ${u.current.version}. ${a.behind} change${a.behind === 1 ? '' : 's'}.` : `Checked ${ago(u.checkedAt, now)}.`, u.checkError ? `Couldn’t check: ${u.checkError}` : '', u.note ?? '', last,
      showKey && !lic!.activated && lic!.hubId ? `Hub ID ${lic!.hubId} (for the licence).` : '', lic?.error && lic.installed ? `Licence: ${lic.error}` : ''].filter(Boolean).join(' ');
  return {
    title, sub, tone: a ? 'ready' as const : u.checkError ? 'error' as const : 'ok' as const, changes: a ? a.changes.slice(0, 4) : [],
    canUpdate: !!a && !busy && u.updater, canCheck: !busy && u.updater, busy,
    auto: u.auto.on ? `Overnight, at ${String(u.auto.hour).padStart(2, '0')}:00, when one is waiting and nothing plays` : 'Off: you choose when',
    licence: showKey ? (lic!.activated ? `Licence ${lic!.key ?? ''}${lic!.edition ? ` · ${lic!.edition}` : ''}` : lic!.installed ? 'Licence key refused: change it' : 'Add licence key') : null,
    licenceWarn: showKey && !lic!.activated,
  };
}
