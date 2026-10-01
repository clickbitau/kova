import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { Hub } from '../hub.ts';
import type { Cause, Command, Device } from '../model/types.ts';
import type { ChangeEvent, SentEvent } from '../devices/registry.ts';
import { lanJson, trimUrl } from '../util/lan-http.ts';

/**
 * The other half of pairing with Helix: Kova tells Helix Server where it is, gives it a
 * token of its own, and says which TV each Helix box is plugged into
 * (`PUT /v1/integrations/kova`). Helix then turns that TV on and off and switches its
 * input through Kova (`POST /api/devices/<tv>`), from the Helix remotes and apps.
 *
 * The same for the soundbar under each TV, when there is one (`soundbarDeviceId`, Helix's D98.11): Helix sends
 * its remote's soundbar buttons, and its own switching when something plays, as `POST /api/devices/<soundbar>`
 * with one of `{on}`, `{volumeStep: ±1}`, `{volume}`, `{mute}`, `{input}`, `{mode}`, `{nightMode}`. Switching
 * Helix does by itself carries `X-Helix-Origin: auto`; Kova keeps who last changed each input
 * (`inputChangedBy: "helix-auto"` for those) so Helix never switches back an input someone chose.
 *
 * The token only reaches those TVs and soundbars: `POST /api/devices/<tv> {on | input}`, the soundbar commands
 * above, and a `GET /api/state` that lists just them. It is made once and kept in helix-link.json.
 */
export interface HelixLinkConfig {
  url?: string;
  token?: string;
  /** Where Helix reaches Kova. Default: this hub's address on the same network as Helix Server. */
  kovaUrl?: string;
  /**
   * Box name → its TV in Kova, the TV input the box is on, its soundbar, and the soundbar input the box's DP
   * adapter feeds (Helix's D101: 7.1 and DTS go straight to the soundbar; default hdmi1). Without one, a box gets
   * the one TV (and the one soundbar) in its room.
   */
  screens?: Record<string, { tv?: string; input?: string; soundbar?: string; soundbarInput?: string }>;
}

export interface Input { id: string; name: string }
export interface HelixScreen {
  playerId: string; tvDeviceId: string; tvName: string; helixInput?: string;
  /** The inputs Helix may switch the TV to. */
  inputs: Input[];
  soundbarDeviceId?: string; soundbarName?: string;
  soundbarInputs?: Input[];
  soundbarModes?: Input[];
  soundbarNight?: boolean;
  /** The soundbar input the TV's sound arrives on (eARC), and the one the box's DP adapter feeds. */
  soundbarTvInput?: string;
  soundbarAdapterInput?: string;
}

export const TV_INPUTS: Input[] = [{ id: 'tv', name: 'TV' }, { id: 'hdmi1', name: 'HDMI 1' }, { id: 'hdmi2', name: 'HDMI 2' }, { id: 'hdmi3', name: 'HDMI 3' }, { id: 'hdmi4', name: 'HDMI 4' }];
export const SOUNDBAR_INPUTS: Input[] = [{ id: 'tv', name: 'TV (eARC)' }, { id: 'hdmi1', name: 'HDMI in 1' }, { id: 'hdmi2', name: 'HDMI in 2' }, { id: 'bluetooth', name: 'Bluetooth' }, { id: 'wifi', name: 'Wi-Fi' }];
export const SOUNDBAR_MODES: Input[] = [{ id: 'standard', name: 'Standard' }, { id: 'surround', name: 'Surround' }, { id: 'game', name: 'Game' }, { id: 'adaptive', name: 'Adaptive' }];
/** What Helix may send each kind of linked device, by Helix's name, as Kova's command field. */
export const HELIX_TV_FIELDS: Record<string, keyof Command> = { on: 'on', input: 'input' };
export const HELIX_SOUNDBAR_FIELDS: Record<string, keyof Command> = { on: 'on', volumeStep: 'volStep', volume: 'vol', mute: 'muted', input: 'input', mode: 'sound', nightMode: 'night' };
/** Who last changed an input, as Helix reads it (`inputChangedBy`): "helix-auto" for Helix's own switching. */
export const HELIX_AUTO: Cause = { kind: 'behaviour', id: 'helix-auto', label: 'Helix (switching for what plays)' };
export const HELIX_REMOTE: Cause = { kind: 'user', label: 'Helix remote' };

export const isSoundbar = (d: Device) => d.capabilities.includes('sound') || (d.capabilities.includes('mute') && d.capabilities.includes('input') && d.type === 'media');

const INPUTS = new Set(['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'tv']);

/** Which TV each Helix box sits on: the one named in settings, else the only other TV in its room. */
export function helixScreens(devices: Iterable<Device>, screens: HelixLinkConfig['screens'] = {}): HelixScreen[] {
  const all = [...devices];
  const tvs = all.filter(d => d.type === 'tv' && d.adapter !== 'helix' && d.capabilities.includes('onoff'));
  const named = (box: string) => screens[box] ?? Object.entries(screens).find(([k]) => k.toLowerCase() === box.toLowerCase())?.[1];
  const out: HelixScreen[] = [];
  const boxes = all.filter(d => d.adapter === 'helix' && d.type === 'tv');
  for (const box of boxes) {
    const set = named(box.original?.name ?? box.name) ?? named(box.name);
    const inRoom = box.room && box.room !== 'unassigned' ? tvs.filter(t => t.room === box.room) : [];
    // The TV named in settings, else the one in the box's room, else (one box, one TV in the home) that TV.
    const tv = set?.tv ? tvs.find(t => t.id === set.tv) : inRoom.length === 1 ? inRoom[0] : !inRoom.length && boxes.length === 1 && tvs.length === 1 ? tvs[0] : undefined;
    if (!tv) continue;
    const input = set?.input && INPUTS.has(set.input) && set.input !== 'helix' ? set.input : undefined;
    const bars = all.filter(isSoundbar);
    const barsInRoom = tv.room && tv.room !== 'unassigned' ? bars.filter(b => b.room === tv.room) : [];
    const bar = set?.soundbar ? bars.find(b => b.id === set.soundbar) : barsInRoom.length === 1 ? barsInRoom[0] : !barsInRoom.length && boxes.length === 1 && bars.length === 1 ? bars[0] : undefined;
    const adapterInput = set?.soundbarInput && SOUNDBAR_INPUTS.some(i => i.id === set.soundbarInput && i.id.startsWith('hdmi')) ? set.soundbarInput : 'hdmi1';
    out.push({
      playerId: box.address, tvDeviceId: tv.id, tvName: tv.name, ...(input ? { helixInput: input } : {}), inputs: TV_INPUTS,
      ...(bar ? {
        soundbarDeviceId: bar.id, soundbarName: bar.name, soundbarInputs: SOUNDBAR_INPUTS,
        ...(bar.capabilities.includes('sound') ? { soundbarModes: SOUNDBAR_MODES, soundbarNight: true } : {}),
        soundbarTvInput: 'tv', soundbarAdapterInput: adapterInput,
      } : {}),
    });
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
  /** Who last changed each linked device's input, and when (Helix's inputChangedBy / inputChangedAt). */
  private inputs = new Map<string, { input: string | null; at: number; by: string }>();

  constructor(private hub: Hub, private o: { helix: () => HelixLinkConfig | undefined; dataDir: string; port: () => number; debounceMs?: number }) {
    const file = join(o.dataDir, 'helix-link.json');
    let t = '';
    try { if (existsSync(file)) t = String(JSON.parse(readFileSync(file, 'utf8')).token ?? ''); } catch { /* make a new one */ }
    if (!/^kvh_[0-9a-f]{48}$/.test(t)) {
      t = `kvh_${randomBytes(24).toString('hex')}`;
      writeFileSync(file, JSON.stringify({ token: t }, null, 2) + '\n', { mode: 0o600 });
    }
    this.token = t;
    this.hub.reg.on('sent', this.onSent);
    this.hub.reg.on('change', this.onChange);
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

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hub.reg.off('sent', this.onSent);
    this.hub.reg.off('change', this.onChange);
  }

  /** An input asked for through Kova: by Helix's switching ("helix-auto"), its remote, the app, an automation… */
  private onSent = ({ device, cmd, cause }: SentEvent): void => {
    if (cmd.input === undefined) return;
    this.inputs.set(device.id, { input: cmd.input ?? null, at: Date.now(), by: cause.id === HELIX_AUTO.id ? 'helix-auto' : cause.kind === 'user' ? cause.label : cause.id ?? cause.kind });
  };
  /** An input changed at the device itself (the soundbar's own remote), read back by its integration. */
  private onChange = ({ device, patch, cause }: ChangeEvent): void => {
    if (cause.kind !== 'device' || typeof patch.input !== 'string') return;
    this.inputs.set(device.id, { input: patch.input, at: Date.now(), by: 'remote' });
  };

  /** Helix's command for a linked device, as Kova's, or why not: one key, by Helix's names (D98.11). */
  translate(deviceId: string, body: Record<string, unknown>): { cmd: Command } | { error: string } {
    const s = this.screens();
    const tv = s.some(x => x.tvDeviceId === deviceId), bar = s.some(x => x.soundbarDeviceId === deviceId);
    const fields = tv ? HELIX_TV_FIELDS : bar ? HELIX_SOUNDBAR_FIELDS : null;
    const keys = Object.keys(body);
    if (!fields) return { error: 'Not a TV or soundbar linked to Helix' };
    if (keys.length !== 1 || !(keys[0] in fields)) return { error: `Send one of ${Object.keys(fields).join(', ')}` };
    const k = keys[0], v = body[k];
    const ok = k === 'on' || k === 'mute' || k === 'nightMode' ? typeof v === 'boolean'
      : k === 'volumeStep' ? v === 1 || v === -1
      : k === 'volume' ? typeof v === 'number' && v >= 0 && v <= 100
      : k === 'input' ? typeof v === 'string' && (tv ? TV_INPUTS : SOUNDBAR_INPUTS).some(i => i.id === v)
      : k === 'mode' ? typeof v === 'string' && SOUNDBAR_MODES.some(m => m.id === v)
      : false;
    if (!ok) return { error: `${k} can’t be ${JSON.stringify(v)}` };
    return { cmd: { [fields[k]]: v } as Command };
  }

  status(): { ok: boolean; note: string } | null { return this.last; }

  /** Where Helix reaches Kova (null until paired). */
  kovaUrl(): string | null {
    const c = this.o.helix();
    return c?.url && c.token ? trimUrl(c.kovaUrl || kovaAddress(c.url, this.o.port())) : null;
  }

  screens(): HelixScreen[] { return helixScreens(this.hub.reg.devices.values(), this.o.helix()?.screens); }

  /** Is this Helix's token? Constant time. */
  isToken(given: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** What Helix's token may do: control a linked TV or soundbar, and read them. */
  allows(method: string, path: string): boolean {
    if (method === 'GET' && path === '/api/state') return true;
    const m = method === 'POST' && /^\/api\/devices\/([^/]+)$/.exec(path);
    const id = m ? decodeURIComponent(m[1]) : '';
    return !!m && this.screens().some(x => x.tvDeviceId === id || x.soundbarDeviceId === id);
  }

  /**
   * The linked TVs and soundbars only, in the shape of /api/state, for a request made with Helix's token, with the
   * state by Helix's names: on, input, volume, muted, mode, nightMode, inputChangedAt (Unix ms), inputChangedBy.
   * A TV's input is read back through SmartThings when it knows the TV, else it's the one last asked for through Kova.
   */
  state(): { devices: { id: string; name: string; type: string; state: Record<string, unknown> }[] } {
    const ids = new Set(this.screens().flatMap(s => [s.tvDeviceId, ...(s.soundbarDeviceId ? [s.soundbarDeviceId] : [])]));
    return {
      devices: [...ids].flatMap(id => {
        const d = this.hub.reg.devices.get(id);
        if (!d) return [];
        const st = d.state;
        const bar = isSoundbar(d);
        const changed = this.inputs.get(id);
        // A TV's source is read back where SmartThings knows the TV, else it's the one last asked for through Kova.
        const input = st.input ?? (bar ? null : changed?.input ?? null);
        return [{
          id, name: d.name, type: bar ? 'soundbar' : d.type,
          state: {
            on: !!st.on, online: st.online !== false,
            ...(input ? { input } : {}),
            ...(bar ? { ...(st.vol != null ? { volume: st.vol } : {}), muted: !!st.muted, ...(st.sound ? { mode: st.sound } : {}), nightMode: !!st.night } : {}),
            ...(changed ? { inputChangedAt: changed.at, inputChangedBy: changed.by } : {}),
          },
        }];
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
