// Settings: the home's timezone and prayer-time method, as lists to pick from.

/** How prayer times can be worked out (the hub's methods), with names a person recognises. */
export const PRAYER_METHODS: [string, string][] = [
  ['MuslimWorldLeague', 'Muslim World League'], ['Egyptian', 'Egyptian General Authority'], ['Karachi', 'University of Islamic Sciences, Karachi'],
  ['UmmAlQura', 'Umm al-Qura, Makkah'], ['Dubai', 'Dubai'], ['MoonsightingCommittee', 'Moonsighting Committee'], ['NorthAmerica', 'ISNA (North America)'],
  ['Kuwait', 'Kuwait'], ['Qatar', 'Qatar'], ['Singapore', 'Singapore'], ['Tehran', 'Tehran'], ['Turkey', 'Diyanet (Turkey)'],
];

/** Common timezones, for when the phone's JavaScript can't list them all: a spread across the world. */
const COMMON = ['Europe/London', 'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver', 'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Istanbul', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi',
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong',
  'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];

/** The phone's own timezone, if it says. */
export const phoneZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

export function timezones(current?: string): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* older engines */ }
  if (!all.length) {
    // The phone's own zone first, then the spread.
    const own = phoneZone();
    all = own && !COMMON.includes(own) ? [own, ...COMMON] : own ? [own, ...COMMON.filter(z => z !== own)] : COMMON;
  }
  return current && !all.includes(current) ? [current, ...all] : all;
}

/** Timezones matching what's typed: "syd", "new york", "perth". */
export function searchZones(zones: string[], q: string): string[] {
  const t = q.trim().toLowerCase().replace(/\s+/g, '_');
  return t ? zones.filter(z => z.toLowerCase().includes(t)) : zones;
}

export const zoneLabel = (z: string) => z.replace(/_/g, ' ').replace('/', ' / ');
