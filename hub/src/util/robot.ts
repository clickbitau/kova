import { CLEAN_MODES, STATION_JOBS, SUCTIONS, type CleanMode, type Command, type Device, type RobotState, type RobotCommand, type RobotSettings, type StationJob, type Suction } from '../model/types.ts';

// Robot vacuums beyond start and dock: rooms to clean, how, the base station, wear and settings (RobotState in the
// state, RobotCommand as `robotSet` in a command). Brand-neutral: the adapter maps them to its bot's commands.

export const SUCTION_WORDS: Record<Suction, string> = { quiet: 'Quiet', standard: 'Standard', max: 'Max', 'max+': 'Max+' };
export const MODE_WORDS: Record<CleanMode, string> = { both: 'Vacuum and mop', vacuum: 'Vacuum only', mop: 'Mop only', mopAfter: 'Vacuum, then mop' };
export const JOB_WORDS: Record<StationJob, string> = { empty: 'Empty the dust bin', wash: 'Wash the mop', dry: 'Dry the mop' };

const SETTING_KEYS = ['carpetBoost', 'obstacles', 'childLock', 'voice', 'resume', 'quiet', 'voiceAssistant', 'autoUpdate', 'autoEmpty', 'dryMinutes'] as const;
const BOOL_SETTINGS = new Set(['carpetBoost', 'obstacles', 'childLock', 'resume', 'voiceAssistant', 'autoUpdate', 'autoEmpty']);
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A robotSet as given (an app, Ask Kova, an automation) → the same, checked and in range. Throws on nonsense. */
export function cleanRobotSet(raw: unknown): RobotCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('robotSet must be { rooms, suction, mode, … }');
  const r = raw as Record<string, unknown>;
  const out: RobotCommand = {};
  const ids = (v: unknown, what: string) => {
    const list = Array.isArray(v) ? v : [v];
    if (!list.length || list.some(x => (typeof x !== 'string' && typeof x !== 'number') || String(x) === '')) throw new Error(`${what} are ids`);
    return [...new Set(list.map(String))].slice(0, 40);
  };
  if (r.rooms != null) out.rooms = ids(r.rooms, 'Rooms');
  if (r.areas != null) out.areas = ids(r.areas, 'Areas');
  if (r.suction != null) {
    const s = String(r.suction).toLowerCase().replace(/\s+/g, '').replace('plus', '+').replace('normal', 'standard').replace('strong', 'max');
    if (!SUCTIONS.includes(s as Suction)) throw new Error(`Suction is ${SUCTIONS.join(', ')}`);
    out.suction = s as Suction;
  }
  if (r.mode != null) {
    if (!CLEAN_MODES.includes(r.mode as CleanMode)) throw new Error(`Mode is ${CLEAN_MODES.join(', ')}`);
    out.mode = r.mode as CleanMode;
  }
  if (r.water != null) { const n = Number(r.water); if (!Number.isFinite(n)) throw new Error('Water is a number'); out.water = Math.max(1, Math.round(n)); }
  if (r.passes != null) { const n = Number(r.passes); if (n !== 1 && n !== 2) throw new Error('Passes is 1 or 2'); out.passes = n; }
  if (r.station != null) {
    if (!STATION_JOBS.includes(r.station as StationJob)) throw new Error(`Station job is ${STATION_JOBS.join(', ')}`);
    out.station = r.station as StationJob;
  }
  if (r.locate === true) out.locate = true;
  if (r.resetPart != null) { if (typeof r.resetPart !== 'string' || !r.resetPart) throw new Error('resetPart is a part id'); out.resetPart = r.resetPart; }
  if (r.settings != null) {
    if (typeof r.settings !== 'object' || Array.isArray(r.settings)) throw new Error('settings is { carpetBoost: true, … }');
    const s: NonNullable<RobotCommand['settings']> = {};
    for (const [k, v] of Object.entries(r.settings as Record<string, unknown>)) {
      if (!(SETTING_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown robot setting ${k}`);
      if (BOOL_SETTINGS.has(k)) { if (typeof v !== 'boolean') throw new Error(`${k} is true or false`); (s as Record<string, unknown>)[k] = v; }
      else if (k === 'voice' || k === 'dryMinutes') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${k} is a number`);
        (s as Record<string, unknown>)[k] = Math.round(n);
      } else if (k === 'quiet') {
        const q = v as Record<string, unknown> | null;
        if (!q || typeof q !== 'object') throw new Error('quiet is { on, start: "22:00", end: "08:00" }');
        if (typeof q.on !== 'boolean') throw new Error('quiet.on is true or false');
        const start = q.start == null ? undefined : String(q.start), end = q.end == null ? undefined : String(q.end);
        if ((start && !HHMM.test(start)) || (end && !HHMM.test(end))) throw new Error('quiet hours are "HH:MM"');
        s.quiet = { on: q.on, start: start ?? '22:00', end: end ?? '08:00' };
      }
    }
    if (Object.keys(s).length) out.settings = s;
  }
  if (!Object.keys(out).length) throw new Error('robotSet asks for nothing');
  return out;
}

/**
 * The map areas a command's Kova rooms are (through the owner's areaRooms), added to the areas it names. A room no
 * area is in is an error that says so, rather than a whole-home clean nobody asked for.
 */
export function resolveRooms(d: Pick<Device, 'name' | 'state'>, rs: RobotCommand, areaRooms: Record<string, string> | undefined, roomName: (id: string) => string): RobotCommand {
  if (!rs.rooms?.length) return rs;
  const known = new Set((d.state.robot?.areas ?? []).map(a => a.id));
  const areas = new Set(rs.areas ?? []);
  const missing: string[] = [];
  for (const room of rs.rooms) {
    const hit = Object.entries(areaRooms ?? {}).filter(([a, r]) => r === room && (!known.size || known.has(a))).map(([a]) => a);
    if (!hit.length) missing.push(roomName(room));
    for (const a of hit) areas.add(a);
  }
  if (missing.length) throw new Error(`${d.name} doesn’t know where ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} on its map yet: give its map areas their rooms in its panel`);
  const { rooms: _rooms, ...rest } = rs;
  return { ...rest, areas: [...areas] };
}

/** What a robotSet does, in words: "cleans Kitchen and Hall · suction Max, mop only". */
export function robotWords(rs: RobotCommand, area: (id: string) => string = id => `area ${id}`, room: (id: string) => string = id => id): string {
  const where = [...(rs.rooms ?? []).map(room), ...(rs.areas ?? []).map(area)];
  return [
    where.length && `cleans ${listWords(where)}`,
    rs.suction && `suction ${SUCTION_WORDS[rs.suction]}`,
    rs.mode && MODE_WORDS[rs.mode].toLowerCase(),
    rs.water != null && `water ${rs.water}`,
    rs.passes != null && (rs.passes === 2 ? 'two passes' : 'one pass'),
    rs.station && JOB_WORDS[rs.station].toLowerCase(),
    rs.locate && 'plays its “I’m here” sound',
    rs.resetPart && `${rs.resetPart} wear reset`,
    ...Object.entries(rs.settings ?? {}).map(([k, v]) => settingWords(k as keyof RobotSettings, v)),
  ].filter(Boolean).join(', ');
}

function settingWords(k: keyof RobotSettings, v: unknown): string {
  const names: Partial<Record<keyof RobotSettings, string>> = { carpetBoost: 'carpet boost', obstacles: 'obstacle avoidance', childLock: 'child lock', resume: 'carry on after charging', voiceAssistant: 'voice assistant', autoUpdate: 'automatic updates', autoEmpty: 'auto-empty' };
  if (k === 'voice') return `voice ${v}`;
  if (k === 'dryMinutes') return `dries the mop ${v} min`;
  if (k === 'quiet') { const q = v as RobotSettings['quiet']; return q?.on ? `do not disturb ${q.start}–${q.end}` : 'do not disturb off'; }
  return `${names[k] ?? k} ${v ? 'on' : 'off'}`;
}

const listWords = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** A robot's area name: its own (from the robot's app), else the Kova room it's in, else a letter (A, B…) by order. */
export function areaName(id: string, areas: { id: string; name: string }[] | undefined, areaRooms: Record<string, string> | undefined, roomName: (id: string) => string): string {
  const a = areas?.find(x => x.id === id);
  if (a?.name) return a.name;
  const r = areaRooms?.[id];
  if (r) return roomName(r);
  const i = areas ? areas.findIndex(x => x.id === id) : -1;
  return i >= 0 ? `Area ${areaLetter(i)}` : `Area ${id}`;
}
export function areaLetter(i: number): string { return i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`; }

/** Whether a command asks a robot to do anything of robotSet's. */
export const hasRobotSet = (c: Command) => !!c.robotSet && Object.keys(c.robotSet).length > 0;

/** A robot's state for Ask Kova, short: the rooms it can clean (by the room ids Ask Kova knows) and what's unnamed. */
export function robotContext(r: RobotState, areaRooms: Record<string, string> | undefined, roomId: (id: string) => string): Record<string, unknown> {
  const rooms = [...new Set(Object.entries(areaRooms ?? {}).filter(([a]) => !r.areas || r.areas.some(x => x.id === a)).map(([, room]) => roomId(room)))];
  const unplaced = (r.areas ?? []).filter(a => !areaRooms?.[a.id]).map(a => a.name ? `${a.id} (${a.name})` : a.id);
  return Object.fromEntries(Object.entries({
    suction: r.suction, mode: r.mode, water: r.water, waterMax: r.waterMax, passes: r.passes, mop: r.mop, station: r.station,
    rooms: rooms.length ? rooms : undefined, areasWithoutRoom: unplaced.length ? unplaced : undefined,
    worn: r.parts?.filter(p => p.left <= 10).map(p => `${p.name} (${p.id}) ${p.left}% left`),
    problems: r.problems?.length ? r.problems.map(p => p.text) : undefined,
    lastClean: r.last ? `${r.last.area} m² in ${r.last.minutes} min` : undefined,
    settings: r.settings,
  }).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
}
