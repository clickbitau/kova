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
  if (c.k != null) c.k = Math.max(1500, Math.min(9000, Math.round(Number(c.k))));
  if (c.color != null && !/^#[0-9a-f]{6}$/i.test(String(c.color))) throw new Error('Colour must be #rrggbb');
  if (!Object.keys(c).length) throw new Error(`${d.name} can't do that`);
  return c;
}
