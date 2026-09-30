import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HomeConfig, Room } from '../model/types.ts';
import type { Integrations } from '../integrations.ts';
import { defaultHome } from '../seed/default-home.ts';

// One-way import from a Home Assistant `.storage` folder: rooms, people,
// location, the local connection details for Tuya, TP-Link Tapo, Cast and
// Samsung TVs, the VeSync and Ecovacs account emails (not their passwords), and the
// Google Nest project, Pub/Sub subscription and camera rooms.
// Kova never talks to Home Assistant; this only reads its files once.
//
//   npx tsx src/tools/import-ha.ts /path/to/homeassistant/.storage [out-dir]

interface Entry { domain: string; title: string; data: Record<string, unknown>; entry_id: string }
interface HaDevice { name?: string; name_by_user?: string; area_id?: string | null; config_entries: string[]; manufacturer?: string; model?: string; identifiers?: [string, string][] }

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
  // Device ids are shared by every integration: a Nest Hub is both a Cast speaker and a Nest camera
  // ("living_room_display" twice), and the second one would hide the first.
  const taken = new Set<string>();
  const unique = (id: string): string => {
    let u = id;
    for (let n = 2; taken.has(u); n++) u = `${id}_${n}`;
    taken.add(u);
    return u;
  };

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
          switches[String(e.id)] = { name: e.friendly_name, room, type: 'light', id: unique(`${room}_${slug(e.friendly_name)}`) };
        }
        const version = d.protocol_version === '3.4' || d.protocol_version === '3.5' ? d.protocol_version : '3.3' as const;
        if (!['3.3', '3.4', '3.5'].includes(d.protocol_version ?? '3.3')) report.push(`Tuya ${d.friendly_name}: protocol ${d.protocol_version} isn't supported yet`);
        return { id: d.device_id ?? key, host: d.host, key: d.local_key, version, switches };
      }),
    };
    report.push(`Tuya (local): ${integrations.tuya.devices.length} devices, ${integrations.tuya.devices.reduce((n, d) => n + Object.keys(d.switches ?? {}).length, 0)} switch channels`);
  }
  const tuyaCloud = devices.filter(d => d.config_entries.some(c => entries.find(e => e.entry_id === c)?.domain === 'tuya') && /lighting|light/i.test(d.model ?? ''));
  if (tuyaCloud.length) report.push(`Tuya cloud-only lights to set up locally: ${tuyaCloud.map(d => d.name_by_user ?? d.name).join(', ')}. Fetch their local keys once with src/tools/tuya-keys.ts --merge`);

  // TP-Link Tapo (KLAP). HA keeps a credentials hash we can use directly.
  const tp = entries.filter(e => e.domain === 'tplink');
  if (tp.length) {
    const hash = tp.map(e => e.data.credentials_hash as string | undefined).find(Boolean);
    integrations.tapo = {
      ...(hash ? { authHash: hash } : {}),
      devices: tp.map(e => {
        const alias = String(e.data.alias ?? e.title);
        const room = roomFor(alias, byEntry(e.entry_id)?.area_id);
        return { host: String(e.data.host), room, name: alias, id: unique(`${room}_${slug(alias)}`) };
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
      ids[name] = unique(`${rooms2[name]}_${slug(name.replace(new RegExp(rooms.find(r => r.id === rooms2[name])?.name ?? '^$', 'i'), '')) || 'speaker'}`);
    }
    integrations.cast = { rooms: rooms2, ids };
    const groups = devices.filter(d => d.config_entries.includes(castEntry.entry_id) && /group/i.test(d.model ?? ''));
    report.push(`Google Cast: ${casts.length} speakers/displays${groups.length ? `, ${groups.length} groups for synced audio (${groups.map(g => g.name).join(', ')})` : ''}`);
  }

  // Samsung TVs: host, MAC (for Wake-on-LAN) and name. HA's token was issued to Home Assistant,
  // so Kova pairs itself: the TV asks to allow Kova the first time.
  const tvs = entries.filter(e => e.domain === 'samsungtv' && e.data.host);
  if (tvs.length) {
    integrations.samsungtv = {
      tvs: tvs.map(e => {
        const name = String(e.title || e.data.name || 'TV');
        const room = roomFor(name, byEntry(e.entry_id)?.area_id);
        return { host: String(e.data.host), name, room, ...(e.data.mac ? { mac: String(e.data.mac) } : {}) };
      }),
    };
    report.push(`Samsung TV: ${tvs.length} TV${tvs.length === 1 ? '' : 's'} (each asks you to allow Kova the first time it connects)`);
  }

  // VeSync (Levoit purifiers): cloud-only. Take the account email and purifier rooms; the password stays with you.
  const vs = entries.find(e => e.domain === 'vesync');
  if (vs?.data.username) {
    const vsDevices: Record<string, { room: string }> = {};
    for (const d of devices.filter(d => d.config_entries.includes(vs.entry_id))) {
      const name = d.name ?? '';
      if (name) vsDevices[name] = { room: roomFor(d.name_by_user ?? name, d.area_id) };
    }
    integrations.vesync = { email: String(vs.data.username), password: '', ...(Object.keys(vsDevices).length ? { devices: vsDevices } : {}) };
    report.push(`VeSync (cloud): account ${String(vs.data.username)}${Object.keys(vsDevices).length ? `, ${Object.keys(vsDevices).length} devices` : ''}. Enter your VeSync password as vesync.password in integrations.json: it isn't imported`);
  }

  // GoodWe solar inverter over Modbus TCP.
  const gw = entries.find(e => e.domain === 'goodwe');
  if (gw?.data.host) {
    integrations.goodwe = { host: String(gw.data.host), port: Number(gw.data.port ?? 502), room: roomFor('Solar inverter', byEntry(gw.entry_id)?.area_id), name: 'Solar inverter', id: unique('solar_inverter') };
    report.push(`GoodWe solar: ${gw.data.host}${gw.data.model_family && gw.data.model_family !== 'DT' ? ` (family ${gw.data.model_family}: check the register map)` : ''}`);
  }

  // Ecovacs (DEEBOT vacuums): cloud-only. Take the account email, country and vacuum rooms; the password stays with you.
  const ev = entries.find(e => e.domain === 'ecovacs');
  if (ev?.data.username) {
    const rooms2: Record<string, string> = {};
    for (const d of devices.filter(d => d.config_entries.includes(ev.entry_id))) {
      const name = d.name ?? '';
      if (name) rooms2[name] = roomFor(d.name_by_user ?? name, d.area_id);
    }
    const country = String(ev.data.country ?? '').toLowerCase();
    integrations.ecovacs = {
      email: String(ev.data.username), password: '', country: country || 'us',
      ...(ev.data.continent ? { continent: String(ev.data.continent).toLowerCase() } : {}),
      ...(Object.keys(rooms2).length ? { rooms: rooms2 } : {}),
    };
    report.push(`Ecovacs (cloud): account ${String(ev.data.username)}${country ? ` (${country})` : ' (no country found: set ecovacs.country)'}${Object.keys(rooms2).length ? `, ${Object.keys(rooms2).length} vacuums` : ''}. Enter your Ecovacs password as ecovacs.password in integrations.json: it isn't imported`);
  }

  // Google Nest (SDM cloud): the Device Access project, the Pub/Sub subscription HA created, and camera rooms.
  // HA's OAuth token was issued to your own OAuth client, so it's reused only when both it and that client are stored in plain form.
  const nest = entries.find(e => e.domain === 'nest' && e.data.project_id);
  if (nest) {
    const plain = (v: unknown): v is string => typeof v === 'string' && v.length >= 20 && !/redacted|\*\*\*/i.test(v);
    const tok = (nest.data.token ?? {}) as Record<string, unknown>;
    const creds = read<{ items?: { domain?: string; id?: string; client_id?: string; client_secret?: string }[] }>(storageDir, 'application_credentials')?.items ?? [];
    const cred = creds.find(c => c.domain === 'nest' && (!nest.data.auth_implementation || c.id === nest.data.auth_implementation)) ?? creds.find(c => c.domain === 'nest');
    const clientId = typeof cred?.client_id === 'string' && /\.apps\.googleusercontent\.com$/.test(cred.client_id) ? cred.client_id : '';
    const clientSecret = typeof cred?.client_secret === 'string' && cred.client_secret.length >= 16 && !/redacted/i.test(cred.client_secret) ? cred.client_secret : '';
    const refreshToken = plain(tok.refresh_token) ? tok.refresh_token : '';
    const rooms2: Record<string, string> = {}, ids: Record<string, string> = {};
    const kinds: Record<string, number> = {};
    for (const d of devices.filter(d => d.config_entries.includes(nest.entry_id) && /doorbell|camera|display/i.test(d.model ?? ''))) {
      const name = d.name_by_user ?? d.name ?? '';
      if (!name) continue;
      // HA identifies Nest devices by their SDM name (enterprises/…/devices/…): the most reliable key. Fall back to the name.
      const sdm = d.identifiers?.find(i => i[0] === 'nest' && /^enterprises\/.+\/devices\//.test(String(i[1])))?.[1];
      const key = sdm ?? name;
      const room = roomFor(name.replace(/\b(doorbell|camera|cam|display)\b/gi, '').trim() || name, d.area_id);
      const kind = /doorbell/i.test(d.model ?? '') ? 'doorbell' : /display/i.test(d.model ?? '') ? 'display' : 'cam';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      rooms2[key] = room;
      // The first doorbell keeps the id "doorbell" so Light the way triggers written for it keep working.
      ids[key] = unique(kind === 'doorbell' && !taken.has('doorbell') ? 'doorbell' : `${room}_${kind}`);
    }
    integrations.nest = {
      projectId: String(nest.data.project_id), clientId, clientSecret, refreshToken,
      ...(typeof nest.data.subscription_name === 'string' ? { subscription: nest.data.subscription_name } : {}),
      ...(Object.keys(ids).length ? { rooms: rooms2, ids } : {}),
    };
    const linked = !!(refreshToken && clientId && clientSecret);
    report.push(`Google Nest (cloud): ${Object.keys(ids).length} camera${Object.keys(ids).length === 1 ? '' : 's'}, Device Access project${integrations.nest.subscription ? ' and Pub/Sub subscription' : ' (no Pub/Sub subscription: events won’t arrive until you add one)'} imported. ${linked
      ? 'Your Google sign-in was imported too.'
      : `Link your Google account: ${clientId ? '' : 'add your OAuth client as nest.clientId and nest.clientSecret, then '}open GET /api/integrations/nest/auth-url, approve, and POST the code to /api/integrations/nest/auth-code; save the refresh token it returns as nest.refreshToken (see docs/architecture.md)`}`);
  }

  for (const d of ['sonos', 'matter']) {
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
