// Voice and other apps: the room ACs the hub publishes to Google Home, Alexa and Apple Home (one per room a ducted
// zone serves), the bridges' pairing state, the comfortable temperatures Kova chooses with, and the note about the
// air conditioner maker's own link. Words for the Voice screen and the AC's panel; the hub decides everything.

export type HvacMode = 'cool' | 'heat' | 'dry' | 'fan' | 'auto';

export interface RoomAcView {
  room: string; name: string; label: string;
  zones: { device: string; n: number; name: string; shared: string[] }[];
  on: boolean; hvac: HvacMode | null; lastHvac: HvacMode | null; target: number | null;
  temp: number | null; tempFrom: 'room' | 'unit' | null; humidity: number | null; fanSpeed: string | null; online: boolean;
  held: { hvac?: HvacMode; target?: number; fanSpeed?: string } | null;
}

export interface RoomClimateSnap {
  settings: { coolTo: number; heatTo: number; fromElsewhere: 'off' | 'rooms' };
  season: 'summer' | 'autumn' | 'winter' | 'spring' | 'tropical' | null;
  seasonLabel: string | null;
  rooms: RoomAcView[];
  bridges: { matter: boolean; homekit: boolean };
}

/** GET /api/room-climate/pairing. */
export interface VoicePairing {
  matter: { enabled: boolean; running?: boolean; manualCode?: string; qrSvg?: string | null; commissioned?: boolean; fabrics?: { label: string; vendor: string }[]; roomAcs?: { room: string; label: string }[] };
  homekit: { enabled: boolean; pincode?: string; qrSvg?: string | null; paired?: boolean; roomAcs?: { room: string; label: string }[] };
}

const HV: Record<HvacMode, string> = { cool: 'cooling', heat: 'heating', dry: 'drying', fan: 'fan only', auto: 'on auto' };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const zoneWord = (n: string) => (/zone/i.test(n) ? n : `${n} zone`);

/** One room AC as a row: its name, the zone(s) and rooms it shares them with, and what it's doing. */
export function roomAcRow(r: RoomAcView, rooms: { id: string; name: string }[]): { title: string; sub: string; now: string; on: boolean } {
  const shared = [...new Set(r.zones.flatMap(z => z.shared))].map(id => rooms.find(x => x.id === id)?.name).filter((x): x is string => !!x);
  const now = !r.online ? 'Not answering'
    : r.on ? `On, ${r.hvac ? HV[r.hvac] : 'on'}${r.target != null ? ` to ${r.target}°` : ''}${r.held ? ' · your setting' : ''}`
      : `Off${r.temp != null ? ` · ${r.temp}° in the room` : ''}`;
  return { title: r.label, sub: [list(r.zones.map(z => zoneWord(z.name))), shared.length ? `shared with ${list(shared)}` : ''].filter(Boolean).join(' · '), now, on: r.on };
}

/** The steps to do once in Google Home, with the home's own first room AC as the example. */
export function googleSteps(rc: Pick<RoomClimateSnap, 'rooms'>): string[] {
  const ex = rc.rooms[0];
  return [
    'Add Kova: Devices → Add → Matter-enabled device, and scan the Matter bridge’s code.',
    ex ? `Put each room AC in its room: “${ex.label}” goes in the ${ex.name}, with that room’s speaker.` : 'Put each room AC in its room, with that room’s speaker.',
    'Say “Hey Google, turn on the AC” in that room. Google knows which room its speaker is in, so it’s that room’s AC.',
  ];
}

/** The note about the maker's own Google or Alexa link: two ACs there. */
export function clashText(makers: string[]): { title: string; text: string; fix: string } {
  return {
    title: 'Two ACs in Google Home?',
    text: makers.length
      ? `If ${list(makers)} is also linked in Google Home or Alexa, it adds its own whole-home AC beside these, with only mode and fan. “Turn on the AC” may reach that one, and no zone opens.`
      : 'If the air conditioner’s own app is also linked in Google Home or Alexa, it adds its own whole-home AC beside these.',
    fix: 'In Google Home, unlink its maker (Settings → Works with Google), or rename it (say “Whole house AC”) and leave it out of rooms with speakers. Kova doesn’t change anything there.',
  };
}

/** The season line: "Spring at your home", or why there's none. */
export function seasonLine(rc: Pick<RoomClimateSnap, 'season' | 'seasonLabel'>): { title: string; text: string } {
  return rc.season && rc.seasonLabel
    ? { title: `${rc.seasonLabel} at your home`, text: 'From the home’s location and the date. Kova cools when the room or the day is warm, heats when it’s cold, and in spring and autumn goes by the room and the forecast.' }
    : { title: 'No season yet', text: 'Set where the home is in Settings. Until then Kova goes by each room’s temperature and the weather.' };
}

/** A bridge's state in words. */
export function matterState(p: VoicePairing | null): { text: string; paired: boolean } {
  if (!p) return { text: 'Checking…', paired: false };
  const m = p.matter;
  if (!m.enabled) return { text: 'Off: turn it on in Integrations', paired: false };
  if (!m.commissioned) return { text: 'Not paired yet', paired: false };
  const who = [...new Set((m.fabrics ?? []).map(f => (f.vendor === 'Test vendor' ? f.label || 'a controller' : f.vendor)))];
  return { text: `Paired with ${list(who) || 'a controller'}`, paired: true };
}
export function homekitState(p: VoicePairing | null): { text: string; paired: boolean } {
  if (!p) return { text: 'Checking…', paired: false };
  if (!p.homekit.enabled) return { text: 'Off: turn it on in Integrations', paired: false };
  return p.homekit.paired ? { text: 'Paired with the Home app', paired: true } : { text: 'Not paired yet', paired: false };
}

/** The Matter manual code in its groups of digits (1234-567-8901). */
export const manualCode = (c?: string) => (c ? c.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3') : '');

/** A step of a comfortable temperature: the body to PUT, or why not (cool-to below heat-to, out of range). */
export function comfortStep(s: RoomClimateSnap['settings'], key: 'coolTo' | 'heatTo', delta: number): { body: { coolTo?: number; heatTo?: number } } | { error: string } | null {
  const [lo, hi] = key === 'coolTo' ? [18, 30] : [16, 28];
  const v = Math.min(hi, Math.max(lo, Math.round((s[key] + delta) * 2) / 2));
  if (v === s[key]) return null;
  if ((key === 'coolTo' && v < s.heatTo) || (key === 'heatTo' && v > s.coolTo)) return { error: 'Cool to can’t be below heat to' };
  return { body: { [key]: v } };
}
