// Settings: the home's timezone and prayer-time method, as lists to pick from.

/** How prayer times can be worked out (the hub's methods), with names a person recognises. */
export const PRAYER_METHODS: [string, string][] = [
  ['MuslimWorldLeague', 'Muslim World League'], ['Egyptian', 'Egyptian General Authority'], ['Karachi', 'University of Islamic Sciences, Karachi'],
  ['UmmAlQura', 'Umm al-Qura, Makkah'], ['Dubai', 'Dubai'], ['MoonsightingCommittee', 'Moonsighting Committee'], ['NorthAmerica', 'ISNA (North America)'],
  ['Kuwait', 'Kuwait'], ['Qatar', 'Qatar'], ['Singapore', 'Singapore'], ['Tehran', 'Tehran'], ['Turkey', 'Diyanet (Turkey)'],
];
export const methodName = (id?: string) => PRAYER_METHODS.find(m => m[0] === id)?.[1] ?? 'Muslim World League';

/** Common timezones, for when the phone's JavaScript can't list them all. */
const COMMON = ['Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart',
  'Pacific/Auckland', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Jakarta', 'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar',
  'Asia/Kuwait', 'Asia/Tehran', 'Europe/Istanbul', 'Africa/Cairo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'UTC'];

export function timezones(current?: string): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* older engines */ }
  if (!all.length) all = COMMON;
  return current && !all.includes(current) ? [current, ...all] : all;
}

/** Timezones matching what's typed: "syd", "new york", "perth". */
export function searchZones(zones: string[], q: string): string[] {
  const t = q.trim().toLowerCase().replace(/\s+/g, '_');
  return t ? zones.filter(z => z.toLowerCase().includes(t)) : zones;
}

export const zoneLabel = (z: string) => z.replace(/_/g, ' ').replace('/', ' / ');
