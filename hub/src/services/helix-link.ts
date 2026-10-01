import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { Hub } from '../hub.ts';
import type { Device } from '../model/types.ts';
import { lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * The other half of pairing with Helix: Kova tells Helix Server where it is, gives it a
 * token of its own, and says which TV each Helix box is plugged into
 * (`PUT /v1/integrations/kova`). Helix then turns that TV on and off and switches its
 * input through Kova (`POST /api/devices/<tv>`), from the Helix remotes and apps.
 *
 * The token only reaches those TVs: `POST /api/devices/<tv> {on | input}` and a
 * `GET /api/state` that lists just them. It is made once and kept in helix-link.json.
 */
export interface HelixLinkConfig {
  url?: string;
  token?: string;
  /** Where Helix reaches Kova. Default: this hub's address on the same network as Helix Server. */
  kovaUrl?: string;
  /** Box name → its TV in Kova, and the TV input the box is on. Without one, a box gets the one TV in its room. */
  screens?: Record<string, { tv?: string; input?: string }>;
}

export interface HelixScreen { playerId: string; tvDeviceId: string; tvName: string; helixInput?: string }

const INPUTS = new Set(['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'tv']);

/** Which TV each Helix box sits on: the one named in settings, else the only other TV in its room. */
export function helixScreens(devices: Iterable<Device>, screens: HelixLinkConfig['screens'] = {}): HelixScreen[] {
  const all = [...devices];
  const tvs = all.filter(d => d.type === 'tv' && d.adapter !== 'helix' && d.capabilities.includes('onoff'));
  const named = (box: string) => screens[box] ?? Object.entries(screens).find(([k]) => k.toLowerCase() === box.toLowerCase())?.[1];
  const out: HelixScreen[] = [];
  for (const box of all.filter(d => d.adapter === 'helix' && d.type === 'tv')) {
    const set = named(box.original?.name ?? box.name) ?? named(box.name);
    const inRoom = box.room && box.room !== 'unassigned' ? tvs.filter(t => t.room === box.room) : [];
    const tv = set?.tv ? tvs.find(t => t.id === set.tv) : inRoom.length === 1 ? inRoom[0] : undefined;
    if (!tv) continue;
    const input = set?.input && INPUTS.has(set.input) && set.input !== 'helix' ? set.input : undefined;
    out.push({ playerId: box.address, tvDeviceId: tv.id, tvName: tv.name, ...(input ? { helixInput: input } : {}) });
  }
  return out.sort((a, b) => a.playerId.localeCompare(b.playerId));
}

/** This hub's address as Helix would reach it: the interface on Helix's own /24, else the first private one. */
export function kovaAddress(helixUrl: string, port: number, nets = os.networkInterfaces()): string {
  let host = '';
  try { host = new URL(helixUrl).hostname; } catch { /* no Helix address yet */ }
  const v4 = Object.values(nets).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a!.address);
  const same = v4.find(a => host && a.split('.').slice(0, 3).join('.') === host.split('.').slice(0, 3).join('.'));
  const priv = v4.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return `http://${same ?? priv ?? v4[0] ?? 'localhost'}:${port}`;
}

export class HelixLink {
  readonly token: string;
  private timer: NodeJS.Timeout | null = null;
  private sent = '';
  private last: { ok: boolean; note: string } | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;

  constructor(private hub: Hub, private o: { helix: () => HelixLinkConfig | undefined; dataDir: string; port: () => number; debounceMs?: number }) {
    const file = join(o.dataDir, 'helix-link.json');
    let t = '';
    try { if (existsSync(file)) t = String(JSON.parse(readFileSync(file, 'utf8')).token ?? ''); } catch { /* make a new one */ }
    if (!/^kvh_[0-9a-f]{48}$/.test(t)) {
      t = `kvh_${randomBytes(24).toString('hex')}`;
      writeFileSync(file, JSON.stringify({ token: t }, null, 2) + '\n', { mode: 0o600 });
    }
    this.token = t;
  }

  start(): void {
    const soon = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, this.o.debounceMs ?? 2000);
      this.timer.unref?.();
    };
    this.hub.reg.on('devices', soon);
    this.hub.on('changed', soon);
    soon();
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  status(): { ok: boolean; note: string } | null { return this.last; }

  screens(): HelixScreen[] { return helixScreens(this.hub.reg.devices.values(), this.o.helix()?.screens); }

  /** Is this Helix's token? Constant time. */
  isToken(given: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** What Helix's token may do: switch a linked TV on or off or change its input, and read those TVs. */
  allows(method: string, path: string): boolean {
    if (method === 'GET' && path === '/api/state') return true;
    const m = method === 'POST' && /^\/api\/devices\/([^/]+)$/.exec(path);
    return !!m && this.screens().some(s => s.tvDeviceId === decodeURIComponent(m[1]));
  }

  /** The linked TVs only, in the shape of /api/state, for a request made with Helix's token. */
  state(): { devices: { id: string; name: string; type: string; state: { on: boolean; online: boolean } }[] } {
    const ids = new Set(this.screens().map(s => s.tvDeviceId));
    return {
      devices: [...ids].flatMap(id => {
        const d = this.hub.reg.devices.get(id);
        return d ? [{ id, name: d.name, type: d.type, state: { on: !!d.state.on, online: d.state.online !== false } }] : [];
      }),
    };
  }

  /** Tell Helix where Kova is and which TV each box is on, when that changed (or `force`). */
  async sync(force = false): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        const c = this.o.helix();
        if (!c?.url || !c.token) { this.last = null; return; }
        const kovaUrl = trimUrl(c.kovaUrl || kovaAddress(c.url, this.o.port()));
        const body = { url: kovaUrl, token: this.token, screens: this.screens() };
        const key = JSON.stringify({ h: trimUrl(c.url), t: c.token, ...body });
        if (!force && key === this.sent) return;
        await lanJson(`${trimUrl(c.url)}/v1/integrations/kova`, {
          method: 'PUT', body, token: c.token, headers: { 'x-helix-client': 'kova/1', 'x-helix-device': 'Kova' },
        });
        this.sent = key;
        const n = body.screens.length;
        this.last = { ok: true, note: n ? `Helix turns on ${n} TV${n === 1 ? '' : 's'} through Kova` : 'Linked. No box shares a room with a TV yet.' };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        this.last = { ok: false, note: `Couldn’t tell Helix about Kova’s TVs: ${m}` };
      }
    })();
    try { await this.syncing; } finally {
      this.syncing = null;
      if (this.again) { this.again = false; await this.sync(); }
    }
  }
}
