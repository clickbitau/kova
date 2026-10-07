import type { Hub } from '../hub.ts';
import type { Device } from '../model/types.ts';
import { wardenFeed, type FeedEvent, type WardenOptions } from '../adapters/warden.ts';
import { LanHttpError, lanJson, trimUrl } from '../util/lan-http.ts';
import { kovaAddress } from './helix-link.ts';

/**
 * What Kova tells Warden (docs/KOVA.md in warden-os, the `integration` scope). Warden never calls Kova;
 * Kova pushes what it knows and answers requests that arrive on Warden's feed:
 *  - its **devices**, with names, kinds, rooms and the ports Kova controls them on (`PUT /integrations/kova/devices`),
 *    so Warden's records get real names and Warden can propose a firewall rule that lets Kova reach exactly those;
 *  - which Warden person each Kova person is (`PUT …/people`) and **arrive/leave** from phones (`POST …/presence`),
 *    so Warden doesn't alarm about the phone of someone Kova knows is home;
 *  - the **house mode** (home, away, night, vacation; `PUT …/mode`, again at least every 6 h): new devices and attacks ring when away;
 *  - which device Kova runs on (`PUT …/hub`);
 *  - which **plug feeds what** (`PUT …/outlets`), and it carries out Warden's **restart requests**
 *    (`power.cycle_requested`: off, wait, on, then `POST /power-cycles/{id}`).
 * A token from before the `integration` scope can't do this: the status says to pair again.
 */
export interface WardenOutlet {
  /** Kova's plug (device id). */
  plug: string;
  /** What it powers: Warden device id (dev_…), MAC or IP. */
  powers: string;
  /** "modem" for the plug feeding the internet modem. */
  role?: string;
  /** The uplink the modem feeds, by Warden's WAN id. */
  wan?: string;
  /** Warden may switch it off and on. Default true: listing a plug here says it's safe to cut. */
  canCycle?: boolean;
}

export type WardenLinkConfig = WardenOptions & { outlets?: WardenOutlet[]; share?: boolean };

/** Kova adapter → the ports Kova uses to control its devices (for Warden's access rule). */
const CONTROLS: Record<string, { protocol: 'tcp' | 'udp'; port: number }[]> = {
  tapo: [{ protocol: 'tcp', port: 80 }],
  tuya: [{ protocol: 'tcp', port: 6668 }],
  samsungtv: [{ protocol: 'tcp', port: 8001 }, { protocol: 'tcp', port: 8002 }, { protocol: 'tcp', port: 9197 }],
  cast: [{ protocol: 'tcp', port: 8008 }, { protocol: 'tcp', port: 8009 }],
  sonos: [{ protocol: 'tcp', port: 1400 }],
  airplay: [{ protocol: 'tcp', port: 7000 }],
  goodwe: [{ protocol: 'udp', port: 8899 }],
  matter: [{ protocol: 'udp', port: 5540 }],
};
/** Devices that aren't on the network in their own right. */
const NOT_ON_LAN = new Set(['virtual', 'warden', 'helix', 'groups']);
const KIND: Record<string, string> = { light: 'light', dimmer: 'light', fan: 'fan', media: 'speaker', tv: 'tv', plug: 'plug', camera: 'camera', sensor: 'sensor', vacuum: 'vacuum', internet: '' };

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
/** `{deviceId}`, `{mac}` or `{ip}` from what the owner typed. */
export function wardenRef(v: string): { deviceId?: string; mac?: string; ip?: string } | null {
  const x = v.trim();
  if (/^dev_\w+$/.test(x)) return { deviceId: x };
  if (MAC.test(x)) return { mac: x.toLowerCase().replace(/-/g, ':') };
  if (IPV4.test(x)) return { ip: x };
  return null;
}

/** Kova's devices as Warden's PUT /integrations/kova/devices wants them. Only devices Kova reaches on the LAN by IP or MAC. */
export function kovaDevicesForWarden(devices: Iterable<Device>, roomName: (id: string) => string | undefined, adapterName: (id: string) => string | undefined) {
  const out: { kovaId: string; ip?: string; mac?: string; name: string; manufacturer?: string; model?: string; kind?: string; room?: string; controls?: { protocol: string; port: number }[] }[] = [];
  for (const d of devices) {
    if (NOT_ON_LAN.has(d.adapter) || d.hidden || d.archived) continue;
    const host = d.address.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const ref = MAC.test(d.address) ? { mac: d.address.toLowerCase().replace(/-/g, ':') } : IPV4.test(host) ? { ip: host } : null;
    if (!ref) continue;
    const kind = KIND[d.type];
    const room = roomName(d.room);
    const maker = adapterName(d.adapter);
    const model = d.integration && d.integration !== maker ? d.integration : undefined;
    out.push({
      kovaId: d.id, ...ref, name: d.name.slice(0, 128),
      ...(maker ? { manufacturer: maker.slice(0, 128) } : {}), ...(model ? { model: model.slice(0, 128) } : {}),
      ...(kind ? { kind } : {}), ...(room ? { room: room.slice(0, 128) } : {}),
      ...(CONTROLS[d.adapter] ? { controls: CONTROLS[d.adapter] } : {}),
    });
  }
  return out.slice(0, 1000).sort((a, b) => a.kovaId.localeCompare(b.kovaId));
}

/** Kova's mode or overlay, and whether anyone is home, as Warden's house mode. */
export function houseMode(names: string[], anyoneHome: boolean | null): 'home' | 'away' | 'night' | 'vacation' {
  const n = names.join(' ').toLowerCase();
  if (/vacation|holiday/.test(n)) return 'vacation';
  if (anyoneHome === false || /\baway\b/.test(n)) return 'away';
  if (/night|sleep|bed/.test(n)) return 'night';
  return 'home';
}

const MODE_EVERY_MS = 6 * 3600_000;

export class WardenLink {
  private timer: NodeJS.Timeout | null = null;
  private sent = new Map<string, string>();
  private modeAt = 0;
  private note: { ok: boolean; note: string } | null = null;
  private needsScope = false;
  private syncing: Promise<void> | null = null;
  private again = false;
  private cycles = new Set<string>();
  private onFeed = (ev: FeedEvent) => { if (ev.type === 'power.cycle_requested') void this.powerCycle(ev); };

  constructor(private hub: Hub, private o: { warden: () => WardenLinkConfig | undefined; port: () => number; people?: () => Record<string, { wardenPerson?: string }> | undefined; debounceMs?: number; now?: () => number }) {}

  private get now(): number { return this.o.now?.() ?? Date.now(); }

  start(): void {
    const soon = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, this.o.debounceMs ?? 3000);
      this.timer.unref?.();
    };
    this.hub.reg.on('devices', soon);
    this.hub.on('changed', soon);
    wardenFeed.on('event', this.onFeed);
    soon();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    wardenFeed.off('event', this.onFeed);
  }

  status(): { ok: boolean; note: string } | null { return this.note; }

  private linked(): (WardenLinkConfig & { token: string }) | null {
    const c = this.o.warden();
    return c?.url && c.token && c.share !== false ? c as WardenLinkConfig & { token: string } : null;
  }

  private call<T = unknown>(c: WardenLinkConfig, method: 'PUT' | 'POST' | 'GET', path: string, body?: unknown): Promise<T> {
    return lanJson<T>(`${trimUrl(c.url)}/api/v1${path}`, { method, body, token: c.token, fingerprint: c.fingerprint, publicKeySha256: c.publicKeySha256 }).then(r => r.json);
  }

  /** PUT a document when it changed since it was last accepted. */
  private async put(c: WardenLinkConfig, path: string, body: unknown, force = false): Promise<unknown> {
    const key = JSON.stringify(body);
    if (!force && this.sent.get(path) === key) return undefined;
    const r = await this.call(c, 'PUT', path, body);
    this.sent.set(path, key);
    return r;
  }

  /** Push whatever changed: devices, people, outlets, the hub, the house mode. */
  async sync(): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      const c = this.linked();
      if (!c) { this.note = null; return; }
      try {
        const cfg = this.hub.config.get();
        const rooms = new Map(cfg.rooms.map(r => [r.id, r.name]));
        const devices = kovaDevicesForWarden(this.hub.reg.devices.values(), id => rooms.get(id), id => this.hub.reg.adapters.get(id)?.name);
        const dev = await this.put(c, '/integrations/kova/devices', devices) as { matched?: { kovaId: string; deviceId?: string }[] } | undefined;
        const people = Object.entries(this.o.people?.() ?? {}).filter(([, p]) => p.wardenPerson).map(([id, p]) => ({ kovaPersonId: id, wardenPersonId: p.wardenPerson! }));
        await this.put(c, '/integrations/kova/people', people);
        await this.put(c, '/integrations/kova/outlets', this.outlets(c));
        const ip = /https?:\/\/([^:/]+)/.exec(kovaAddress(c.url, this.o.port()) ?? '')?.[1];
        if (ip && IPV4.test(ip)) await this.put(c, '/integrations/kova/hub', { ip });
        await this.sendMode(c);
        this.needsScope = false;
        const matched = dev?.matched ? dev.matched.filter(m => m.deviceId).length : undefined;
        const access = await this.call<{ approved?: unknown; waiting?: boolean; proposal?: unknown; problem?: string }>(c, 'GET', '/integrations/kova/access').catch(() => null);
        const rule = access?.problem ? ` · access rule: ${access.problem}` : access?.approved ? ' · access rule approved' : access?.waiting || access?.proposal ? ' · access rule waiting for your Warden admin' : '';
        this.note = { ok: true, note: `Warden knows ${devices.length} of Kova’s devices${matched !== undefined ? ` (${matched} matched)` : ''} · house mode ${this.lastMode}${rule}` };
      } catch (e) {
        if (e instanceof LanHttpError && e.status === 403) {
          this.needsScope = true;
          this.note = { ok: false, note: 'Pair with Warden again so Kova can share its devices, presence and plugs (Kova’s token predates that permission).' };
        } else if (e instanceof LanHttpError && e.status === 404) {
          this.note = { ok: true, note: 'This Warden doesn’t take Kova’s devices yet.' };
        } else {
          this.note = { ok: false, note: `Couldn’t update Warden: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
    })();
    try { await this.syncing; } finally {
      this.syncing = null;
      if (this.again) { this.again = false; await this.sync(); }
    }
  }

  private lastMode = 'home';

  private async sendMode(c: WardenLinkConfig): Promise<void> {
    const e = this.hub.engine;
    const names = [e.mode().name, e.mode().id, e.overlay?.id ?? '', e.overlay ? (this.hub.config.get().overlays.find(o => o.id === e.overlay!.id)?.name ?? '') : ''];
    const people = Object.values(e.people);
    const mode = houseMode(names, people.length ? people.some(p => p.home) : null);
    const force = this.now - this.modeAt >= MODE_EVERY_MS;
    if (mode === this.lastMode && !force && this.sent.has('/integrations/kova/mode')) return;
    await this.put(c, '/integrations/kova/mode', { mode }, true);
    this.lastMode = mode;
    this.modeAt = this.now;
  }

  private outlets(c: WardenLinkConfig) {
    const rooms = new Map(this.hub.config.get().rooms.map(r => [r.id, r.name]));
    return (c.outlets ?? []).flatMap(o => {
      const plug = this.hub.reg.get(o.plug);
      const powers = wardenRef(o.powers);
      if (!plug || !powers) return [];
      return [{
        outletId: plug.id, name: plug.name, ...(rooms.get(plug.room) ? { room: rooms.get(plug.room) } : {}),
        powers, canCycle: o.canCycle !== false,
        ...(o.role ? { role: o.role } : {}), ...(o.wan ? { wan: o.wan } : {}),
      }];
    }).slice(0, 256);
  }

  /** Phones and the app: tell Warden who arrived or left. */
  async presence(personId: string, home: boolean, source: string): Promise<void> {
    const c = this.linked();
    if (!c || this.needsScope) return;
    const name = this.hub.config.get().people.find(p => p.id === personId)?.name;
    const mapped = this.o.people?.()?.[personId]?.wardenPerson;
    const src = /app/i.test(source) ? 'app' : /manual|you|test/i.test(source) ? 'manual' : 'geofence';
    await this.call(c, 'POST', '/integrations/kova/presence', { person: mapped ?? personId, ...(name ? { kovaPersonName: name } : {}), home, at: new Date(this.now).toISOString(), source: src })
      .catch(e => { if (e instanceof LanHttpError && e.status === 403) this.needsScope = true; });
  }

  private log(what: string, device: string, d: Record<string, unknown>): void {
    const why = d.reason === 'unresponsive' ? 'it stopped responding' : d.reason === 'modem' ? 'the internet was down' : 'asked from Warden';
    this.hub.store.append({ kind: 'system', device, feed: 'system', what, data: { requestId: d.requestId, deviceId: d.deviceId }, cause: { kind: 'system', label: 'Warden', detail: why } });
    this.hub.emit('changed');
  }

  /** Warden asks Kova to restart something through its plug: off, wait, on, then say how it went. */
  async powerCycle(ev: FeedEvent): Promise<void> {
    const d = ev.data ?? {};
    const id = String(d.requestId ?? '');
    const c = this.linked();
    if (!id || !c || this.cycles.has(id)) return;
    this.cycles.add(id);
    const answer = (status: 'done' | 'failed' | 'refused', error?: string) =>
      this.call(c, 'POST', `/power-cycles/${encodeURIComponent(id)}`, { status, ...(error ? { error: error.slice(0, 300) } : {}) }).catch(() => {});
    // Never act on a request that has run out (a replayed one, or one that waited too long).
    if (d.expiresAt && Date.parse(d.expiresAt) <= this.now) return;
    const outlet = (c.outlets ?? []).find(o => o.plug === d.outletId);
    const plug = outlet && this.hub.reg.get(outlet.plug);
    if (!outlet || outlet.canCycle === false || !plug) { await answer('refused', `Kova has no plug ${d.outletId} it may switch off`); return; }
    const cause = { kind: 'system' as const, label: 'Warden', detail: `Restarting ${d.deviceName ?? 'a device'} (${d.reason ?? 'asked'})` };
    const off = Math.min(Math.max(Number(d.offSeconds) || 10, 1), 60);
    try {
      await this.hub.engine.command(plug.id, { on: false }, cause);
      await new Promise(r => setTimeout(r, off * 1000));
      await this.hub.engine.command(plug.id, { on: true }, cause);
      await answer('done');
      this.log(`Restarted ${d.deviceName ?? 'a device'} by switching ${plug.name} off and on`, plug.id, d);
    } catch (e) {
      // Whatever happened, try to leave the plug on.
      await this.hub.engine.command(plug.id, { on: true }, cause).catch(() => {});
      const m = e instanceof Error ? e.message : String(e);
      await answer('failed', m);
      this.log(`Couldn’t restart ${d.deviceName ?? 'a device'} with ${plug.name}: ${m}`, plug.id, d);
    }
  }
}

