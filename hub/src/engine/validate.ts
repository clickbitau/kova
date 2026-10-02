import type { Command, Device, Rhythm } from '../model/types.ts';
import { fitCommand } from '../util/describe.ts';

// Checks for anything a person edits: rhythms and device targets.

const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const SUN = ['sunrise', 'sunset', 'dawn', 'dusk'];

export function validRhythm(r: unknown): r is Rhythm {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  const off = x.offsetMin === undefined || (typeof x.offsetMin === 'number' && Math.abs(x.offsetMin) <= 240);
  if (x.kind === 'time') return typeof x.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.at);
  if (x.kind === 'sun') return SUN.includes(String(x.event)) && off;
  if (x.kind === 'prayer') return PRAYERS.includes(String(x.prayer)) && off;
  return false;
}

/** A Rhythm given loosely — "21:00", "sunset", "isha", or the full object. */
export function rhythm(r: unknown): Rhythm | undefined {
  if (typeof r === 'string') {
    const s = r.trim().toLowerCase();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return { kind: 'time', at: s };
    if (SUN.includes(s)) return { kind: 'sun', event: s as 'sunrise' };
    if (PRAYERS.includes(s)) return { kind: 'prayer', prayer: s as 'fajr' };
    return undefined;
  }
  return validRhythm(r) ? r : undefined;
}

/** Clean a target so it only sets things the device can do, in range. Throws on nonsense. */
export function cleanTarget(d: Device, cmd: Command): Command {
  const c = fitCommand(d, cmd);
  if (c.bri != null) c.bri = Math.max(1, Math.min(100, Math.round(Number(c.bri))));
  if (c.vol != null) c.vol = Math.max(0, Math.min(100, Math.round(Number(c.vol))));
  if (c.zoneSet != null) {
    if (typeof c.zoneSet !== 'object') throw new Error('Zones must be { "1": { on, open } }');
    const z: NonNullable<Command['zoneSet']> = {};
    for (const [n, v] of Object.entries(c.zoneSet)) {
      if (!/^[1-9]\d?$/.test(n) || !v || typeof v !== 'object') throw new Error(`Zone ${n} isn’t valid`);
      z[n] = { ...(typeof v.on === 'boolean' ? { on: v.on } : {}), ...(v.open != null ? { open: Math.max(0, Math.min(100, Math.round(Number(v.open)))) } : {}) };
    }
    c.zoneSet = z;
  }
  if (c.extras != null) {
    if (typeof c.extras !== 'object' || Array.isArray(c.extras)) throw new Error('Extras must be { name: value }');
    const ex: NonNullable<Command['extras']> = {};
    for (const [k, v] of Object.entries(c.extras)) {
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v)) ex[k] = v;
    }
    if (Object.keys(ex).length) c.extras = ex; else delete c.extras;
  }
  if (c.k != null) c.k = Math.max(1500, Math.min(9000, Math.round(Number(c.k))));
  if (c.color != null && !/^#[0-9a-f]{6}$/i.test(String(c.color))) throw new Error('Colour must be #rrggbb');
  if (!Object.keys(c).length) throw new Error(`${d.name} can't do that`);
  return c;
}
