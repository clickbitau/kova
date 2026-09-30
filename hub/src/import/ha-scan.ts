import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import SunCalc from 'suncalc';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { Hub } from '../hub.ts';
import type { Integrations } from '../integrations.ts';
import type { IntegrationsManager } from '../integrations-store.ts';
import { importHomeAssistant, type ImportResult } from '../tools/import-ha.ts';
import { localHour } from '../util/time.ts';
import { CONFIG_FILES, STORAGE_FILES, readHaArchive, readHaFolder, type HaFiles } from './ha-source.ts';

// The in-app "Import from Home Assistant": read a backup (or config folder), show what Kova will
// take over and what needs you, then switch over. The files it keeps live in <KOVA_DATA>/import/ha
// (owner-only: they include device keys) so the import can be reviewed across restarts.

/** Where each Home Assistant integration goes. */
const MOVES: Record<string, string> = { localtuya: 'tuya', tplink: 'tapo', cast: 'cast', samsungtv: 'samsungtv', vesync: 'vesync', goodwe: 'goodwe', ecovacs: 'ecovacs', nest: 'nest' };
/** Kova supports these, but they're set up again in Kova rather than copied (pairings can't move). */
const SET_UP: Record<string, { section: string; how: string }> = {
  sonos: { section: 'sonos', how: 'Kova finds Sonos speakers on your network by itself' },
  matter: { section: 'matter', how: 'Matter devices pair again with Kova (open a pairing window in Home Assistant or Google Home first)' },
  homekit_controller: { section: 'homekit', how: 'HomeKit accessories pair with one controller at a time: remove them from Home Assistant, then pair them in Kova' },
  tuya: { section: 'tuya', how: 'Kova runs Tuya devices locally: fetch their local keys once from the Tuya cloud' },
  mobile_app: { section: 'presence', how: 'Kova’s presence and notifications replace the Home Assistant app on your phones' },
  opnsense: { section: 'presence', how: 'Kova reads who’s home from OPNsense directly' },
  homekit: { section: 'homekitBridge', how: 'Kova’s own Apple Home bridge replaces this' },
  apple_tv: { section: '', how: 'Apple TV isn’t in Kova yet; AirPlay to it works through the AirPlay integration' },
};
/** Home Assistant internals Kova doesn't need (it has its own, or they're HA plumbing). */
const NOT_NEEDED = new Set(['sun', 'met', 'radio_browser', 'google_translate', 'shopping_list', 'backup', 'hassio', 'go2rtc', 'person', 'zone', 'hacs', 'browser_mod', 'cloud',
  'analytics', 'local_calendar', 'thread', 'otbr', 'bluetooth', 'dhcp', 'ssdp', 'zeroconf', 'usb', 'default_config', 'energy', 'history', 'logbook', 'recorder', 'frontend',
  'config', 'automation', 'script', 'scene', 'template', 'group', 'input_boolean', 'input_number', 'input_select', 'input_datetime', 'input_text', 'input_button', 'counter',
  'timer', 'schedule', 'workday', 'holiday', 'utility_meter', 'derivative', 'statistics', 'threshold', 'min_max', 'filter', 'integration', 'tod', 'waze_travel_time',
  'google_assistant_sdk', 'uptime', 'systemmonitor', 'speedtestdotnet', 'mqtt', 'rpi_power', 'islamic_prayer_times', 'wake_on_lan', 'ping', 'forecast_solar', 'upnp', 'webostv']);
/** Things that belong in the owner's other apps rather than in a home controller. */
const HANDOFF: Record<string, { app: string; letter: string }> = {
  opnsense: { app: 'Warden', letter: 'W' }, unifi: { app: 'Warden', letter: 'W' }, adguard: { app: 'Warden', letter: 'W' }, pi_hole: { app: 'Warden', letter: 'W' },
  plex: { app: 'Helix', letter: 'H' }, qbittorrent: { app: 'Helix', letter: 'H' }, transmission: { app: 'Helix', letter: 'H' }, sonarr: { app: 'Helix', letter: 'H' },
  radarr: { app: 'Helix', letter: 'H' }, jellyfin: { app: 'Helix', letter: 'H' }, tautulli: { app: 'Helix', letter: 'H' }, overseerr: { app: 'Helix', letter: 'H' },
  docker: { app: 'Dockbit', letter: 'D' }, portainer: { app: 'Dockbit', letter: 'D' }, proxmoxve: { app: 'Dockbit', letter: 'D' }, go2rtc: { app: 'Dockbit', letter: 'D' },
};
const NICE: Record<string, string> = { localtuya: 'Tuya (local)', tplink: 'TP-Link Tapo', cast: 'Google Cast', samsungtv: 'Samsung TV', vesync: 'VeSync', goodwe: 'GoodWe',
  ecovacs: 'Ecovacs', nest: 'Google Nest', sonos: 'Sonos', matter: 'Matter', homekit_controller: 'HomeKit devices', tuya: 'Tuya (cloud)', mobile_app: 'Mobile app',
  opnsense: 'OPNsense', homekit: 'HomeKit bridge', apple_tv: 'Apple TV', plex: 'Plex', qbittorrent: 'qBittorrent', docker: 'Docker', proxmoxve: 'Proxmox' };
const nice = (d: string) => NICE[d] ?? d.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

export interface ReviewItem {
  id: string; icon: string; title: string; detail: string;
  /** What the button does: open an integration's setup, go to a screen, or just mark it done. */
  action: { kind: 'integration'; id: string } | { kind: 'screen'; screen: string } | { kind: 'ack' };
  btn: string; doneLabel: string; done: boolean;
}

export interface HaAutomation {
  id: string; name: string; icon: string; kind: 'time' | 'event';
  /** Local hour for the day strip (schedule rules only). */
  at: number | null; label: string;
  when: string[]; cond: string[]; then: string[];
  enabled: boolean; lastRun: string;
  /** How Kova covers this kind of rule. */
  kova: string;
  yaml: string;
}

export interface ImportSummary {
  scanned: true;
  source: { kind: 'backup' | 'folder'; label: string; haVersion: string | null; backupName: string | null; backupDate: string | null; scannedAt: string };
  location: { name: string; timezone: string };
  stats: { n: string; label: string; sub: string }[];
  integrations: { domain: string; name: string; count: number; fate: 'moves' | 'set-up' | 'built-in' | 'handoff' | 'unsupported'; to?: string; note?: string }[];
  review: ReviewItem[];
  handoffs: { id: string; letter: string; app: string; what: string; done: boolean }[];
  automations: { total: number; enabled: number };
  report: string[];
  applied: { at: string; written: string[]; kept: string[]; started: string[] } | null;
}

interface Meta { source: ImportSummary['source']; done: string[]; applied: ImportSummary['applied'] }

type Json = Record<string, unknown>;
const j = (b?: Buffer): Json | undefined => { if (!b) return undefined; try { return JSON.parse(b.toString('utf8')) as Json; } catch { return undefined; } };

export class HaImport {
  readonly dir: string;
  constructor(private hub: Hub, private opts: { dataDir: string; manager?: IntegrationsManager }) {
    this.dir = join(opts.dataDir, 'import', 'ha');
  }

  // ---------------------------------------------------------------- reading --

  async fromBackup(stream: AsyncIterable<Buffer>, key?: string, label = 'Backup file'): Promise<ImportSummary> {
    const files = await readHaArchive(stream, key);
    return this.save(files, { kind: 'backup', label: files.backup?.name ? `Backup “${files.backup.name}”` : label });
  }

  fromFolder(path: string): Promise<ImportSummary> {
    return this.save(readHaFolder(path), { kind: 'folder', label: path });
  }

  private async save(files: HaFiles, src: { kind: 'backup' | 'folder'; label: string }): Promise<ImportSummary> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, '.storage'), { recursive: true, mode: 0o700 });
    chmodSync(join(this.dir, '..'), 0o700);
    for (const [n, b] of Object.entries(files.storage)) writeFileSync(join(this.dir, '.storage', n), b, { mode: 0o600 });
    for (const [n, b] of Object.entries(files.config)) writeFileSync(join(this.dir, n), b, { mode: 0o600 });
    const haVersion = files.backup?.haVersion ?? (files.config['.HA_VERSION']?.toString('utf8').trim() || null);
    const meta: Meta = {
      source: { ...src, haVersion, backupName: files.backup?.name ?? null, backupDate: files.backup?.date ?? null, scannedAt: new Date(this.hub.engine.now()).toISOString() },
      done: [], applied: null,
    };
    this.writeMeta(meta);
    this.hub.emit('changed');
    return this.summary()!;
  }

  private meta(): Meta | null { try { return JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf8')) as Meta; } catch { return null; } }
  private writeMeta(m: Meta) { writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(m, null, 2), { mode: 0o600 }); }
  private storage(name: (typeof STORAGE_FILES)[number]): Json | undefined { const p = join(this.dir, '.storage', name); return existsSync(p) ? j(readFileSync(p)) : undefined; }
  private config(name: (typeof CONFIG_FILES)[number]): string | undefined { const p = join(this.dir, name); return existsSync(p) ? readFileSync(p, 'utf8') : undefined; }

  forget(): void { rmSync(this.dir, { recursive: true, force: true }); this.hub.emit('changed'); }

  private result(): ImportResult { return importHomeAssistant(join(this.dir, '.storage')); }

  // ---------------------------------------------------------------- summary --

  summary(): ImportSummary | null {
    const meta = this.meta();
    if (!meta || !existsSync(join(this.dir, '.storage', 'core.config_entries'))) return null;
    const r = this.result();
    const entries = ((this.storage('core.config_entries')?.data as Json | undefined)?.entries ?? []) as { domain: string; title: string; disabled_by?: string | null; data?: Json }[];
    const devices = ((this.storage('core.device_registry')?.data as Json | undefined)?.devices ?? []) as unknown[];
    const entities = ((this.storage('core.entity_registry')?.data as Json | undefined)?.entities ?? []) as unknown[];
    const byDomain = new Map<string, number>();
    for (const e of entries) if (!e.disabled_by) byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);

    const running = new Map<string, { ok: boolean }>();
    for (const a of this.hub.reg.adapters.values()) running.set(a.id, a.status());
    for (const s of this.hub.services) running.set(s.id, s.status());

    const integrations: ImportSummary['integrations'] = [...byDomain].sort((a, b) => b[1] - a[1]).map(([domain, count]) => {
      if (MOVES[domain] && (r.integrations as Json)[MOVES[domain]]) return { domain, name: nice(domain), count, fate: 'moves', to: MOVES[domain] };
      if (HANDOFF[domain]) return { domain, name: nice(domain), count, fate: 'handoff', to: HANDOFF[domain].app };
      if (SET_UP[domain]) return { domain, name: nice(domain), count, fate: 'set-up', to: SET_UP[domain].section, note: SET_UP[domain].how };
      if (NOT_NEEDED.has(domain)) return { domain, name: nice(domain), count, fate: 'built-in' };
      return { domain, name: nice(domain), count, fate: 'unsupported' };
    });
    const of = (f: string) => integrations.filter(i => i.fate === f);
    const autos = this.automations();
    const scripts = this.yamlMap('scripts.yaml');
    const lst = (xs: string[], n = 4) => xs.slice(0, n).join(', ') + (xs.length > n ? '…' : '');

    const done = new Set(meta.done);
    const ok = (id: string) => running.get(id)?.ok === true;
    const review: ReviewItem[] = [];
    const add = (x: Omit<ReviewItem, 'done'>, auto?: boolean) => review.push({ ...x, done: done.has(x.id) || !!auto });
    const I = r.integrations;
    if (I.vesync) add({ id: 'vesync', icon: 'password', title: 'Enter your VeSync password', detail: `Home Assistant doesn’t keep it in a form Kova can use. The account (${I.vesync.email}) and purifier rooms are imported.`, action: { kind: 'integration', id: 'vesync' }, btn: 'Open', doneLabel: 'Connected' }, ok('vesync'));
    if (I.ecovacs) add({ id: 'ecovacs', icon: 'password', title: 'Enter your Ecovacs password', detail: `For ${I.ecovacs.email}. The vacuum rooms are imported.`, action: { kind: 'integration', id: 'ecovacs' }, btn: 'Open', doneLabel: 'Connected' }, ok('ecovacs'));
    if (I.tapo && !I.tapo.authHash) add({ id: 'tapo', icon: 'password', title: 'Sign in to TP-Link', detail: 'No stored TP-Link credentials were found. Your Tapo devices are imported.', action: { kind: 'integration', id: 'tapo' }, btn: 'Open', doneLabel: 'Connected' }, ok('tapo'));
    if (I.nest && !(I.nest.refreshToken && I.nest.clientId && I.nest.clientSecret)) add({ id: 'nest', icon: 'link', title: 'Link your Google account for Nest', detail: `Your Device Access project${I.nest.subscription ? ', event subscription' : ''} and ${Object.keys(I.nest.ids ?? {}).length} cameras are imported. Google needs you to allow Kova once.`, action: { kind: 'integration', id: 'nest' }, btn: 'Link', doneLabel: 'Linked' }, ok('nest'));
    const tuyaCloud = r.report.find(l => l.startsWith('Tuya cloud-only lights'));
    if (tuyaCloud || byDomain.has('tuya')) add({ id: 'tuya-keys', icon: 'key', title: 'Get local keys for your Tuya lights', detail: tuyaCloud ? tuyaCloud.replace(/\. Fetch.*$/, '.').replace('Tuya cloud-only lights to set up locally: ', 'Home Assistant ran these through the Tuya cloud: ') + ' Kova runs them locally once it has their keys.' : 'Some Tuya devices only ran through the Tuya cloud in Home Assistant. Kova runs them locally once it has their keys.', action: { kind: 'integration', id: 'tuya' }, btn: 'Open', doneLabel: 'Done' });
    if (I.samsungtv) add({ id: 'samsungtv', icon: 'tv', title: `Allow Kova on your TV${I.samsungtv.tvs.length === 1 ? '' : 's'}`, detail: 'The first time Kova connects, the TV shows a prompt. Choose Allow with the remote.', action: { kind: 'ack' }, btn: 'Got it', doneLabel: 'Noted' });
    for (const i of of('set-up')) add({ id: `setup:${i.domain}`, icon: 'add_link', title: `Set up ${i.name} in Kova`, detail: i.note ?? '', action: i.to ? { kind: 'integration', id: i.to } : { kind: 'ack' }, btn: i.to ? 'Open' : 'Got it', doneLabel: 'Done' }, !!i.to && ok(i.to) && i.domain !== 'tuya');
    if (of('unsupported').length) add({ id: 'unsupported', icon: 'block', title: `${of('unsupported').length} integration${of('unsupported').length === 1 ? '' : 's'} Kova can’t take over yet`, detail: `${lst(of('unsupported').map(i => i.name), 8)}. Keep Home Assistant running for these, or tell us which matter most.`, action: { kind: 'ack' }, btn: 'Got it', doneLabel: 'Noted' });
    if (autos.length) add({ id: 'automations', icon: 'account_tree', title: `Replace your ${autos.length} automations`, detail: `${autos.filter(a => a.enabled).length} are on. Kova doesn’t copy them one by one: most become modes, moments, Light the way or the Away overlay. Each one shows how.`, action: { kind: 'screen', screen: 'autos' }, btn: 'Review', doneLabel: 'Reviewed' });

    const handoffs = [...new Map(integrations.filter(i => i.fate === 'handoff').map(i => [HANDOFF[i.domain].app, i])).keys()].map(app => {
      const items = integrations.filter(i => i.fate === 'handoff' && HANDOFF[i.domain].app === app);
      const letter = HANDOFF[items[0].domain].letter;
      return { id: `handoff:${app}`, letter, app, what: lst(items.map(i => i.name)), done: done.has(`handoff:${app}`) };
    });

    const areas = ((this.storage('core.area_registry')?.data as Json | undefined)?.areas ?? []) as unknown[];
    const people = ((this.storage('person')?.data as Json | undefined)?.items ?? []) as unknown[];
    const stats = [
      [String(of('moves').length), 'Move to Kova', lst(of('moves').map(i => i.name)) || 'Nothing Kova can import directly'],
      [String(of('set-up').length), 'Set up again in Kova', lst(of('set-up').map(i => i.name)) || 'Nothing to redo'],
      [String(of('built-in').length + of('handoff').length), 'Not needed', of('handoff').length ? `Built into Kova, or belongs in ${[...new Set(of('handoff').map(i => i.to))].join(' and ')}` : 'Built into Kova or Home Assistant plumbing'],
      [String(autos.length), 'Automations', autos.length ? `${autos.filter(a => a.enabled).length} on, ${autos.filter(a => !a.enabled).length} off${scripts.length ? ` · ${scripts.length} script${scripts.length === 1 ? '' : 's'}` : ''}` : 'None found'],
      [String(areas.length || r.home.rooms.length), 'Rooms', `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${devices.length} device${devices.length === 1 ? '' : 's'} · ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`],
    ].map(([n, label, sub]) => ({ n, label, sub }));

    return {
      scanned: true, source: meta.source, location: { name: r.home.name, timezone: r.home.timezone },
      stats, integrations, review, handoffs, automations: { total: autos.length, enabled: autos.filter(a => a.enabled).length }, report: r.report, applied: meta.applied,
    };
  }

  markDone(id: string, done = true): ImportSummary | null {
    const m = this.meta();
    if (!m) return null;
    m.done = done ? [...new Set([...m.done, id])] : m.done.filter(x => x !== id);
    this.writeMeta(m);
    this.hub.emit('changed');
    return this.summary();
  }

  // ------------------------------------------------------------ automations --

  private yamlMap(file: 'scripts.yaml' | 'scenes.yaml'): string[] {
    const t = this.config(file);
    if (!t) return [];
    try { const y = parseYaml(t) as unknown; return Array.isArray(y) ? y.map((x: Json) => String(x.name ?? x.id ?? '')) : y && typeof y === 'object' ? Object.keys(y) : []; } catch { return []; }
  }

  automations(): HaAutomation[] {
    const text = this.config('automations.yaml');
    if (!text) return [];
    let list: Json[];
    try { const y = parseYaml(text) as unknown; list = Array.isArray(y) ? y as Json[] : []; } catch { return []; }
    const ents = ((this.storage('core.entity_registry')?.data as Json | undefined)?.entities ?? []) as { entity_id: string; unique_id?: string; name?: string | null; original_name?: string | null; platform?: string }[];
    const areas = ((this.storage('core.area_registry')?.data as Json | undefined)?.areas ?? []) as { id: string; name: string }[];
    const devs = ((this.storage('core.device_registry')?.data as Json | undefined)?.devices ?? []) as { id: string; name?: string; name_by_user?: string }[];
    const states = ((this.storage('core.restore_state')?.data ?? []) as { state?: { entity_id: string; state: string; attributes?: Json } }[]).map(s => s.state).filter(Boolean) as { entity_id: string; state: string; attributes?: Json }[];
    const core = (this.storage('core.config')?.data ?? {}) as { latitude?: number; longitude?: number; time_zone?: string };
    const tz = core.time_zone ?? this.hub.config.get().timezone;
    const name = (eid: string): string => {
      const e = ents.find(x => x.entity_id === eid);
      const n = e?.name ?? e?.original_name;
      if (n) return n;
      const s = states.find(x => x.entity_id === eid)?.attributes?.friendly_name;
      if (typeof s === 'string') return s;
      return eid.replace(/^[a-z_]+\./, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    };
    const names = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => String(x)).filter(x => x.includes('.')).map(name);
    const lst = (xs: string[]) => xs.length <= 1 ? xs.join('') : xs.length > 3 ? `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
    const dur = (v: unknown): string => {
      if (typeof v === 'number') return v >= 60 ? `${Math.round(v / 60)} min` : `${v} s`;
      if (typeof v === 'string') { const [h, m, s] = v.replace(/^-/, '').split(':').map(Number); const mins = (h || 0) * 60 + (m || 0) + Math.round((s || 0) / 60); return mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : mins ? `${mins} min` : `${s || 0} s`; }
      if (v && typeof v === 'object') { const o = v as Json; const mins = Number(o.hours ?? 0) * 60 + Number(o.minutes ?? 0) + Math.round(Number(o.seconds ?? 0) / 60); return mins ? `${mins} min` : `${o.seconds ?? 0} s`; }
      return '';
    };
    const sunHour = (event: string, offset: unknown): number | null => {
      if (core.latitude == null || core.longitude == null) return null;
      const t = SunCalc.getTimes(new Date(this.hub.engine.now()), core.latitude, core.longitude);
      const base = event === 'sunrise' ? t.sunrise : t.sunset;
      if (!base || isNaN(+base)) return null;
      let off = 0;
      if (typeof offset === 'string') { const neg = offset.startsWith('-'); const [h, m, s] = offset.replace(/^[-+]/, '').split(':').map(Number); off = ((h || 0) * 60 + (m || 0) + (s || 0) / 60) * (neg ? -1 : 1); }
      else if (typeof offset === 'number') off = offset / 60;
      return localHour(+base + off * 60_000, tz);
    };
    const offsetText = (offset: unknown, event: string) => {
      const d = dur(offset);
      if (!d || /^0 /.test(d)) return event;
      return `${d} ${String(offset).startsWith('-') ? 'before' : 'after'} ${event}`;
    };
    const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : v == null ? [] : [v]) as Json[];

    return list.map((a, i) => {
      const triggers = arr(a.triggers ?? a.trigger), conditions = arr(a.conditions ?? a.condition), actions = arr(a.actions ?? a.action);
      let at: number | null = null, label = '', icon = 'bolt', kind = 'event' as 'time' | 'event';
      const kinds = new Set<string>();
      const when = triggers.map(t => {
        const p = String(t.trigger ?? t.platform ?? '');
        kinds.add(p);
        if (p === 'time') {
          kind = 'time'; icon = 'schedule';
          const times = (Array.isArray(t.at) ? t.at : [t.at]).map(String);
          const clock = times.find(x => /^\d{1,2}:\d{2}/.test(x));
          if (clock && at == null) { const [h, m] = clock.split(':').map(Number); at = h + m / 60; label = clock.slice(0, 5); }
          return times.map(x => /^\d/.test(x) ? `Every day at ${x.slice(0, 5)}` : `At ${name(x)}`).join(', ');
        }
        if (p === 'sun') {
          kind = 'time'; icon = t.event === 'sunrise' ? 'wb_sunny' : 'wb_twilight';
          const h = sunHour(String(t.event), t.offset); if (h != null && at == null) { at = h; label = String(t.event) === 'sunrise' ? 'Sunrise' : 'Sunset'; }
          return offsetText(t.offset, String(t.event));
        }
        if (p === 'state') {
          const who = names(t.entity_id), to = t.to == null ? null : String(t.to), from = t.from == null ? null : String(t.from);
          const eids = arr(t.entity_id).map(String);
          if (eids.some(e => /^(person|device_tracker)\./.test(e))) { icon = 'person'; kinds.add('presence'); return to === 'home' ? `${lst(who)} ${who.length > 1 ? 'come' : 'comes'} home` : to === 'not_home' || from === 'home' ? `${lst(who)} ${who.length > 1 ? 'leave' : 'leaves'}` : `${lst(who)} changes`; }
          if (eids.some(e => /^binary_sensor\..*(motion|occupancy|person|presence)/.test(e) || /^event\..*(doorbell|ring)/.test(e))) { icon = 'sensors'; kinds.add('motion'); }
          const forText = t.for ? ` for ${dur(t.for)}` : '';
          return to != null ? `${lst(who)} turns ${to === 'on' ? 'on' : to === 'off' ? 'off' : `to ${to}`}${forText}` : `${lst(who)} changes${forText}`;
        }
        if (p === 'numeric_state') return `${lst(names(t.entity_id))} ${t.above != null ? `above ${t.above}` : ''}${t.above != null && t.below != null ? ' and ' : ''}${t.below != null ? `below ${t.below}` : ''}`.trim();
        if (p === 'zone') { icon = 'person'; kinds.add('presence'); return `${lst(names(t.entity_id))} ${t.event === 'leave' ? 'leaves' : 'enters'} ${name(String(t.zone ?? 'zone.home'))}`; }
        if (p === 'homeassistant') return t.event === 'shutdown' ? 'When Home Assistant stops' : 'When Home Assistant starts';
        if (p === 'time_pattern') { kind = 'time'; return t.minutes ? `Every ${String(t.minutes).replace('/', '')} minutes` : t.hours ? `Every ${String(t.hours).replace('/', '')} hours` : 'On a repeating schedule'; }
        if (p === 'device') { const d = devs.find(x => x.id === t.device_id); if (/motion|occupied|person/.test(String(t.type))) { icon = 'sensors'; kinds.add('motion'); } return `${d?.name_by_user ?? d?.name ?? 'A device'}: ${String(t.type ?? t.subtype ?? 'event').replace(/_/g, ' ')}`; }
        if (p === 'event') return `Event ${t.event_type ?? ''}`.trim();
        if (p === 'webhook') return 'A webhook call';
        if (p === 'template') return 'When a template becomes true';
        if (p === 'tag') return 'An NFC tag is scanned';
        if (p === 'mqtt') return `MQTT ${t.topic ?? ''}`.trim();
        return p ? `${p.replace(/_/g, ' ')} trigger` : 'Trigger';
      });
      const condText = (c: Json): string => {
        const k = String(c.condition ?? '');
        if (k === 'state') return `${lst(names(c.entity_id))} is ${c.state === 'on' ? 'on' : c.state === 'off' ? 'off' : c.state === 'home' ? 'home' : c.state === 'not_home' ? 'away' : String(c.state)}`;
        if (k === 'time') return [c.after ? `after ${String(c.after).slice(0, 5)}` : '', c.before ? `before ${String(c.before).slice(0, 5)}` : '', c.weekday ? `on ${arr(c.weekday).join(', ')}` : ''].filter(Boolean).join(' ').replace(/^./, x => x.toUpperCase()) || 'At certain times';
        if (k === 'sun') return [c.after ? `After ${c.after}` : '', c.before ? `before ${c.before}` : ''].filter(Boolean).join(', ') || 'Depending on the sun';
        if (k === 'numeric_state') return `${lst(names(c.entity_id))} ${c.above != null ? `above ${c.above}` : ''}${c.below != null ? ` below ${c.below}` : ''}`.trim();
        if (k === 'zone') return `${lst(names(c.entity_id))} is in ${name(String(c.zone))}`;
        if (k === 'and' || k === 'or') return arr(c.conditions).map(condText).join(k === 'and' ? ' and ' : ' or ');
        if (k === 'not') return `Not: ${arr(c.conditions).map(condText).join(', ')}`;
        if (k === 'template') return 'A template check';
        return k ? k.replace(/_/g, ' ') : 'A condition';
      };
      const cond = conditions.map(condText);
      const targetsOf = (x: Json): string[] => {
        const tg = (x.target ?? {}) as Json, dt = (x.data ?? {}) as Json;
        const ids = [...arr(tg.entity_id ?? dt.entity_id ?? x.entity_id).map(String)];
        const areaNames = arr(tg.area_id).map(String).map(id => areas.find(ar => ar.id === id)?.name ?? id);
        return [...names(ids), ...areaNames];
      };
      const actText = (x: Json): string => {
        const svc = String(x.action ?? x.service ?? '');
        if (svc) {
          const [dom, op] = svc.split('.');
          const who = targetsOf(x), dt = (x.data ?? {}) as Json;
          if (dom === 'notify' || dom === 'persistent_notification') { kinds.add('notify'); return `Send a notification${dt.message ? `: “${String(dt.message).slice(0, 60)}”` : ''}`; }
          if (dom === 'scene') return `Scene ${lst(who) || ''}`.trim();
          if (dom === 'script') return `Run ${op === 'turn_on' ? lst(who) : name(`script.${op}`)}`;
          if (dom === 'tts') return `Say “${String(dt.message ?? '').slice(0, 50)}”`;
          if (dom === 'media_player' && op === 'play_media') { kinds.add('media'); return `Play ${String(dt.media_content_id ?? 'media').split('/').pop()} on ${lst(who)}`; }
          if (dom === 'media_player' && op === 'volume_set') return `Volume ${Math.round(Number(dt.volume_level ?? 0) * 100)}% on ${lst(who)}`;
          if (/^(light|switch|fan|media_player|cover|climate|input_boolean|homeassistant)$/.test(dom)) {
            kinds.add(dom === 'media_player' ? 'media' : 'lights');
            const bri = dt.brightness_pct != null ? ` at ${dt.brightness_pct}%` : dt.brightness != null ? ` at ${Math.round(Number(dt.brightness) / 2.55)}%` : '';
            const k = dt.color_temp_kelvin ? ` · ${dt.color_temp_kelvin}K` : '';
            const verb = op === 'turn_on' ? 'Turn on' : op === 'turn_off' ? 'Turn off' : op === 'toggle' ? 'Toggle' : op.replace(/_/g, ' ');
            return `${verb} ${lst(who) || dom}${bri}${k}`;
          }
          return `${nice(dom)}: ${op.replace(/_/g, ' ')}${who.length ? ` · ${lst(who)}` : ''}`;
        }
        if (x.delay != null) return `Wait ${dur(x.delay)}`;
        if (x.wait_for_trigger || x.wait_template) return 'Wait for something';
        if (x.choose) return `Choose between ${arr(x.choose).length} options`;
        if (x.if) return 'If … then …';
        if (x.repeat) return 'Repeat';
        if (x.scene) return `Scene ${name(String(x.scene))}`;
        if (x.condition) return `Only if ${condText(x)}`;
        if (x.variables) return 'Set variables';
        if (x.event) return `Fire event ${x.event}`;
        return 'An action';
      };
      const then = actions.map(actText);
      const id = String(a.id ?? `automation_${i + 1}`);
      const ent = ents.find(e => e.platform === 'automation' && e.unique_id === id) ?? ents.find(e => e.entity_id === `automation.${String(a.alias ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`);
      const st = ent ? states.find(s => s.entity_id === ent.entity_id) : undefined;
      const enabled = st ? st.state !== 'off' : a.initial_state !== false;
      const last = st?.attributes?.last_triggered;
      const kova = kinds.has('presence') ? 'Presence and the Away overlay'
        : kinds.has('motion') ? 'Light the way'
        : kinds.has('notify') && !kinds.has('lights') ? 'Notifications'
        : kind === 'time' && (kinds.has('lights') || kinds.has('media')) ? 'A mode or a moment'
        : 'Needs a look';
      return {
        id, name: String(a.alias ?? id), icon, kind, at, label: label || String(a.alias ?? '').slice(0, 14),
        when: when.length ? when : ['No trigger'], cond, then: then.length ? then : ['Nothing'],
        enabled, lastRun: typeof last === 'string' && last ? `Last ran ${new Date(last).toLocaleString('en-AU', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(/\bSept\b/, 'Sep')}` : enabled ? 'Hasn’t run yet' : 'Turned off in Home Assistant',
        kova, yaml: toYaml(a, { lineWidth: 0 }).trimEnd(),
      };
    });
  }

  // ------------------------------------------------------------------ apply --

  /**
   * Switch over: integrations Kova doesn't have yet are written (existing ones are kept) and started
   * where they can run; rooms, people and location come across. From the demo home, the virtual
   * devices go and the imported home replaces the demo one.
   */
  async apply(): Promise<{ written: string[]; kept: string[]; started: string[]; leftDemo: boolean }> {
    if (!this.meta()) throw new Error('Nothing imported yet');
    if (!this.opts.manager) throw new Error('In-app setup isn’t available on this hub');
    const r = this.result();
    const res = await this.opts.manager.importSections(r.integrations);
    const leftDemo = this.hub.demo;
    if (leftDemo) {
      await this.hub.reg.removeAdapter('virtual', { forget: true });
      this.hub.config.update(c => { Object.assign(c, r.home); });
      this.hub.leaveDemo();
    } else {
      this.hub.config.update(c => {
        c.name = r.home.name || c.name; c.timezone = r.home.timezone || c.timezone;
        if (r.home.latitude || r.home.longitude) { c.latitude = r.home.latitude; c.longitude = r.home.longitude; }
        for (const room of r.home.rooms) if (!c.rooms.some(x => x.id === room.id)) c.rooms.push(room);
        for (const p of r.home.people) if (!c.people.some(x => x.id === p.id)) c.people.push(p);
      });
    }
    const m = this.meta()!;
    m.applied = { at: new Date(this.hub.engine.now()).toISOString(), ...res };
    this.writeMeta(m);
    this.hub.emit('changed');
    return { ...res, leftDemo };
  }
}
