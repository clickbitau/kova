import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HomeConfig, Room } from '../model/types.ts';
import type { Integrations } from '../integrations.ts';
import { defaultHome } from '../seed/default-home.ts';

// One-way import from a Home Assistant `.storage` folder: rooms, people,
// location and the local connection details for Tuya, TP-Link Tapo and Cast.
// Kova never talks to Home Assistant; this only reads its files once.
//
//   npx tsx src/tools/import-ha.ts /path/to/homeassistant/.storage [out-dir]

interface Entry { domain: string; title: string; data: Record<string, unknown>; entry_id: string }
interface HaDevice { name?: string; name_by_user?: string; area_id?: string | null; config_entries: string[]; manufacturer?: string; model?: string }

const read = <T>(dir: string, file: string): T | undefined => {
  const p = join(dir, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).data as T) : undefined;
};

const ICONS: [RegExp, string][] = [
  [/living|lounge/, 'weekend'], [/kitchen|pantry|dining/, 'kitchen'], [/office|study/, 'desk'], [/master|bed/, 'bed'],
  [/music/, 'music_note'], [/baby|nursery|kid/, 'crib'], [/guest/, 'single_bed'], [/laundry/, 'local_laundry_service'],
  [/garage/, 'garage_home'], [/front|entry|door/, 'door_front'], [/corridor|hall/, 'door_sliding'], [/garden|yard|outdoor/, 'yard'],
];

export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface ImportResult { home: HomeConfig; integrations: Integrations; report: string[] }

export function importHomeAssistant(storageDir: string): ImportResult {
  const report: string[] = [];
  const entries = read<{ entries: Entry[] }>(storageDir, 'core.config_entries')?.entries ?? [];
  const devices = read<{ devices: HaDevice[] }>(storageDir, 'core.device_registry')?.devices ?? [];
  const areas = read<{ areas: { id: string; name: string }[] }>(storageDir, 'core.area_registry')?.areas ?? [];
  const core = read<{ location_name?: string; latitude?: number; longitude?: number; time_zone?: string }>(storageDir, 'core.config') ?? {};
  const persons = read<{ items: { id: string; name: string; device_trackers?: string[] }[] }>(storageDir, 'person')?.items ?? [];

  const rooms: Room[] = areas.map(a => ({ id: a.id, name: a.name, icon: ICONS.find(([re]) => re.test(a.id))?.[1] ?? 'meeting_room' }));
  const addRoom = (name: string): string => {
    const id = slug(name);
    if (!rooms.some(r => r.id === id)) rooms.push({ id, name, icon: ICONS.find(([re]) => re.test(id))?.[1] ?? 'meeting_room' });
    return id;
  };
  /** Best room for a device name like "Kitchen Switch" or "Music Room Speaker". */
  const roomFor = (name: string, areaId?: string | null): string => {
    if (areaId && rooms.some(r => r.id === areaId)) return areaId;
    const n = slug(name);
    const hit = [...rooms].sort((a, b) => b.name.length - a.name.length).find(r => n.includes(slug(r.name)) || n.includes(r.id));
    if (hit) return hit.id;
    const guess = name.replace(/\b(switch|speaker|display|plug|light|lamp|smart)\b/gi, '').trim();
    return addRoom(guess || 'Unassigned');
  };
  const byEntry = (id: string) => devices.find(d => d.config_entries.includes(id));

  const integrations: Integrations = {};

  // Tuya over the local network (from the localtuya custom integration).
  const lt = entries.find(e => e.domain === 'localtuya');
  const ltDevices = (lt?.data.devices ?? {}) as Record<string, { device_id?: string; friendly_name: string; host: string; local_key: string; protocol_version?: string; entities?: { id: number | string; platform: string; friendly_name: string }[] }>;
  if (Object.keys(ltDevices).length) {
    integrations.tuya = {
      devices: Object.entries(ltDevices).map(([key, d]) => {
        const room = roomFor(d.friendly_name);
        const switches: Record<string, { name: string; room: string; type: 'light' | 'plug'; id: string }> = {};
        for (const e of d.entities ?? []) {
          if (e.platform !== 'switch' && e.platform !== 'light') continue;
          switches[String(e.id)] = { name: e.friendly_name, room, type: 'light', id: `${room}_${slug(e.friendly_name)}` };
        }
        const version = d.protocol_version === '3.4' ? '3.4' as const : '3.3' as const;
        if (!['3.3', '3.4'].includes(d.protocol_version ?? '3.3')) report.push(`Tuya ${d.friendly_name}: protocol ${d.protocol_version} isn't supported yet`);
        return { id: d.device_id ?? key, host: d.host, key: d.local_key, version, switches };
      }),
    };
    report.push(`Tuya (local): ${integrations.tuya.devices.length} devices, ${integrations.tuya.devices.reduce((n, d) => n + Object.keys(d.switches ?? {}).length, 0)} switch channels`);
  }
  const tuyaCloud = devices.filter(d => d.config_entries.some(c => entries.find(e => e.entry_id === c)?.domain === 'tuya') && /lighting|light/i.test(d.model ?? ''));
  if (tuyaCloud.length) report.push(`Tuya cloud-only lights to set up locally later: ${tuyaCloud.map(d => d.name_by_user ?? d.name).join(', ')}`);

  // TP-Link Tapo (KLAP). HA keeps a credentials hash we can use directly.
  const tp = entries.filter(e => e.domain === 'tplink');
  if (tp.length) {
    const hash = tp.map(e => e.data.credentials_hash as string | undefined).find(Boolean);
    integrations.tapo = {
      ...(hash ? { authHash: hash } : {}),
      devices: tp.map(e => {
        const alias = String(e.data.alias ?? e.title);
        const room = roomFor(alias, byEntry(e.entry_id)?.area_id);
        return { host: String(e.data.host), room, name: alias, id: `${room}_${slug(alias)}` };
      }),
    };
    report.push(`TP-Link Tapo: ${tp.length} devices${hash ? '' : ' (add your TP-Link email and password: no stored credentials found)'}`);
  }

  // Google Cast: names → rooms. Devices themselves are found on the network by mDNS.
  const castEntry = entries.find(e => e.domain === 'cast');
  const casts = castEntry ? devices.filter(d => d.config_entries.includes(castEntry.entry_id) && !/group/i.test(d.model ?? '')) : [];
  if (castEntry) {
    const rooms2: Record<string, string> = {}, ids: Record<string, string> = {};
    for (const d of casts) {
      const name = d.name_by_user ?? d.name ?? '';
      rooms2[name] = roomFor(name, d.area_id);
      ids[name] = `${rooms2[name]}_${slug(name.replace(new RegExp(rooms.find(r => r.id === rooms2[name])?.name ?? '^$', 'i'), '')) || 'speaker'}`;
    }
    integrations.cast = { rooms: rooms2, ids };
    const groups = devices.filter(d => d.config_entries.includes(castEntry.entry_id) && /group/i.test(d.model ?? ''));
    report.push(`Google Cast: ${casts.length} speakers/displays${groups.length ? `, ${groups.length} groups for synced audio (${groups.map(g => g.name).join(', ')})` : ''}`);
  }

  for (const d of ['sonos', 'matter', 'vesync', 'nest', 'goodwe', 'samsungtv', 'ecovacs']) {
    if (entries.some(e => e.domain === d)) report.push(`${d}: not imported yet`);
  }

  const home = defaultHome({
    name: core.location_name ?? 'Home',
    timezone: core.time_zone ?? 'UTC',
    latitude: core.latitude ?? 0,
    longitude: core.longitude ?? 0,
    rooms,
    people: persons.map(p => ({ id: slug(p.name), name: p.name, detail: p.device_trackers?.[0]?.replace(/^device_tracker\./, '').replace(/_/g, ' ') ?? 'Phone' })),
  });
  report.push(`Home: ${home.rooms.length} rooms, ${home.people.length} people`);
  return { home, integrations, report };
}

// ---------------------------------------------------------------- CLI --
if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, out = resolve(process.cwd(), '../data')] = process.argv.slice(2);
  if (!src) { console.error('Usage: tsx src/tools/import-ha.ts <homeassistant/.storage> [out-dir]'); process.exit(1); }
  const r = importHomeAssistant(resolve(src));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'integrations.json'), JSON.stringify(r.integrations, null, 2), { mode: 0o600 });
  writeFileSync(join(out, 'home.json'), JSON.stringify(r.home, null, 2));
  console.log(r.report.map(l => `• ${l}`).join('\n'));
  console.log(`\nWrote ${join(out, 'integrations.json')} (contains device keys: keep it private) and ${join(out, 'home.json')}.`);
}
