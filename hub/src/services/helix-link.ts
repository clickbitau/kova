import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Hub } from '../hub.ts';
import type { Cause, Command, Device } from '../model/types.ts';
import { LanHttpError, lanJson, trimUrl } from '../util/lan-http.ts';
import { HelixAdapter, helixFeatures, helixHeaders, type HelixScreenSetting } from '../adapters/helix.ts';

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
 * (`inputChangedBy: "helix-auto"` for those only) so Helix never switches back an input someone chose.
 *
 * The PUT is a full replace of the screens, so every screen goes with every field each time, and it leaves out
 * Helix's own `autoSwitch` and `sleepOff` (the owner's switches in Helix: a PUT with them would overwrite the choice).
 * Helix has one URL for Kova and no fallback, so it's sent again whenever Kova's address changes: plain http with
 * an IP literal (Helix follows no redirects and needs a real certificate for https). Afterwards Kova reads
 * `GET /v1/integrations/kova` back for the ids Helix keeps and whether it can reach Kova.
 *
 * Helix's calls (services/helix-link.ts → api/server.ts) have a 3 s timeout: `GET /api/state` comes from what Kova
 * already knows, and a command is answered within `answerMs` while a slow one (a TV waking from deep standby)
 * finishes in the background. Commands to one device run in order, so an `input` right after `on` waits for the TV.
 *
 * The token only reaches those TVs and soundbars: `POST /api/devices/<tv> {on | input}`, the soundbar commands
 * above, and a `GET /api/state` that lists just them. It is made once and kept in helix-link.json.
 */
export interface HelixLinkConfig {
  url?: string;
  token?: string;
  /** Where Helix reaches Kova: http://<IP address>:<port>. Default: this hub's address on the same network as Helix Server. */
  kovaUrl?: string;
  /**
   * Box name → its TV in Kova, the TV input the box is on, its soundbar, and the soundbar input the box's DP
   * adapter feeds (Helix's D101: 7.1 and DTS go straight to the soundbar; default hdmi1). Without one, a box gets
   * the one TV (and the one soundbar) in its room.
   */
  screens?: Record<string, HelixScreenSetting>;
  /** The Helix profile Kova acts as (sent with every call). Default "default". */
  musicProfile?: string;
  /**
   * Kova 0.7.2–0.7.5 turned a TV off when its Helix box shut down, built in (default on). It's an automation now;
   * read once, when that rule is carried over (engine/automation-ideas.ts carryOverTvOff): "off" means it isn't.
   */
  tvOffWithBox?: boolean | 'on' | 'off';
  /** Kova, not Helix, switches the boxes' TVs and soundbars for what they do (default false: Helix does). */
  kovaSwitches?: boolean;
}

export interface Input { id: string; name: string }
/** A box's screen as Kova follows it (Hub.screens). */
interface FollowScreen { player: string; tv: string; input?: string; soundbar?: string; soundbarInputs?: string[] }
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
/** Who last changed an input, as Helix reads it (`inputChangedBy`): "helix-auto" for Helix's own switching only. */
export const HELIX_AUTO: Cause = { kind: 'behaviour', id: 'helix-auto', label: 'Helix (switching for what plays)' };
/** A press on a Helix remote, forwarded: a person. */
export const HELIX_REMOTE: Cause = { kind: 'user', label: 'Helix remote' };

export const isSoundbar = (d: Device) => d.capabilities.includes('sound') || (d.capabilities.includes('mute') && d.capabilities.includes('input') && d.type === 'media');

const INPUTS = new Set(['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'tv']);

/**
 * Which TV each Helix box sits on: the one named in settings, else the only other TV in its room. Settings are by box
 * name; `aliases` gives the other names a box was known by (before Helix gave it its stable id or a new name), so a
 * home keeps its mappings.
 *
 * `home` keeps the guessing honest: only a room the home really has counts (not "unassigned" or a leftover id a
 * device kept), and a TV or soundbar Kova reaches through several integrations counts once, as the combined device,
 * never as each of its parts. Without it (tests), any room but "unassigned" counts.
 */
export function helixScreens(devices: Iterable<Device>, screens: HelixLinkConfig['screens'] = {}, aliases: (box: Device) => string[] = () => [],
  home?: { rooms: string[]; skip: Set<string> }): HelixScreen[] {
  const all = [...devices];
  const realRoom = (room?: string) => !!room && room !== 'unassigned' && (!home || home.rooms.includes(room));
  // What settings name is used as it is; only a guess leaves out the parts of a combined device (and archived ones).
  const guessable = (d: Device) => !home?.skip.has(d.id);
  const tvs = all.filter(d => d.type === 'tv' && d.adapter !== 'helix' && d.capabilities.includes('onoff'));
  const named = (box: string) => screens[box] ?? Object.entries(screens).find(([k]) => k.toLowerCase() === box.toLowerCase())?.[1];
  const out: HelixScreen[] = [];
  const boxes = all.filter(d => d.adapter === 'helix' && d.type === 'tv');
  for (const box of boxes) {
    const set = [box.original?.name, box.name, ...aliases(box)].filter((n): n is string => !!n).map(named).find(Boolean);
    const inRoom = realRoom(box.room) ? tvs.filter(t => guessable(t) && t.room === box.room) : [];
    // The TV named in settings, else the one in the box's room, else (one box, one TV in the home) that TV.
    const tv = set?.tv ? tvs.find(t => t.id === set.tv) : inRoom.length === 1 ? inRoom[0] : !inRoom.length && boxes.length === 1 && tvs.filter(guessable).length === 1 ? tvs.find(guessable) : undefined;
    if (!tv) continue;
    const input = set?.input && INPUTS.has(set.input) && set.input !== 'helix' ? set.input : undefined;
    const bars = all.filter(isSoundbar);
    const barsInRoom = realRoom(tv.room) ? bars.filter(b => guessable(b) && b.room === tv.room) : [];
    const bar = set?.soundbar ? bars.find(b => b.id === set.soundbar) : barsInRoom.length === 1 ? barsInRoom[0] : !barsInRoom.length && boxes.length === 1 && bars.filter(guessable).length === 1 ? bars.find(guessable) : undefined;
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

// ------------------------------------------------------------ Kova's address --

const bare = (host: string) => host.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
const v4 = (host: string) => bare(host).split('.').map(Number);
const privateV4 = (host: string) => { const [a, b] = v4(host); return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31); };
/** 100.64.0.0/10: carrier-grade NAT, and the addresses a tailnet hands out. */
const sharedV4 = (host: string) => { const [a, b] = v4(host); return a === 100 && b >= 64 && b <= 127; };
const loopback = (host: string) => (isIP(bare(host)) === 4 && v4(host)[0] === 127) || bare(host) === '::1';
const ulaV6 = (host: string) => isIP(bare(host)) === 6 && /^f[cd]/i.test(bare(host));

/**
 * Why Helix can't use this as Kova's URL, or null when it can: plain http to an IP address on a private network
 * (a hostname such as a .local or .ts.net name needs a lookup Helix doesn't do; https needs a real certificate on an
 * address, and Helix follows no redirects, so no path either). Loopback only when Helix runs on the same machine.
 */
export function kovaUrlProblem(value: string, helixUrl = ''): string | null {
  let u: URL;
  try { u = new URL(value); } catch { return `“${value}” isn’t a URL`; }
  if (u.protocol !== 'http:') return 'Use plain http:// for Kova’s address (Helix needs a real certificate for https)';
  if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return 'Kova’s address is http://<IP address>:<port>, with nothing after it';
  const h = bare(u.hostname);
  if (!isIP(h)) return `Use Kova’s IP address, not a name (${h}): Helix doesn’t look names up`;
  let helixHost = '';
  try { helixHost = bare(new URL(helixUrl).hostname); } catch { /* not paired */ }
  if (loopback(h)) return loopback(helixHost) ? null : 'A loopback address only works when Helix runs on this machine';
  if (isIP(h) === 4 ? privateV4(h) || sharedV4(h) : ulaV6(h)) return null;
  return `${h} isn’t an address on a private network`;
}

/** An IP address as it goes in a URL. */
const urlHost = (ip: string) => isIP(bare(ip)) === 6 ? `[${bare(ip)}]` : bare(ip);

/**
 * This hub's address as Helix would reach it, as an IP literal: the interface on Helix's own /24, else the first private
 * IPv4 one, else a tailnet (100.64/10) one, else a unique-local IPv6 one; null when there is none.
 */
export function kovaAddress(helixUrl: string, port: number, nets = os.networkInterfaces()): string | null {
  let host = '';
  try { host = bare(new URL(helixUrl).hostname); } catch { /* no Helix address yet */ }
  const addrs = Object.values(nets).flat().filter(a => a && !a.internal).map(a => bare(a!.address));
  const four = addrs.filter(a => isIP(a) === 4);
  const same = isIP(host) === 4 ? four.find(a => a.split('.').slice(0, 3).join('.') === host.split('.').slice(0, 3).join('.') && (privateV4(a) || sharedV4(a))) : undefined;
  const pick = same ?? four.find(privateV4) ?? four.find(sharedV4) ?? addrs.find(ulaV6);
  return pick ? `http://${urlHost(pick)}:${port}` : null;
}

// ------------------------------------------------------------ the link --

/** How Helix's command came out: done, still going (answered early, finishing in the background), or failed. */
export type HelixReply = { status: 200 | 202; body: { ok: true; pending?: true } } | { status: 403 | 502; body: { error: string } };

interface LinkStatus { ok: boolean; note: string }

export class HelixLink {
  readonly token: string;
  private timer: NodeJS.Timeout | null = null;
  private watch: NodeJS.Timeout | null = null;
  private sent = '';
  private last: LinkStatus | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  /** What Helix said back after the last PUT: the screens it keeps (by its canonical ids) and whether it reaches Kova. */
  private helixView: { reachable?: boolean; playerIds: string[] } | null = null;
  /** Helix's commands per device: the last one asked for, while it waits or runs (an identical one joins it), and the queue. */
  private running = new Map<string, { key: string; done: Promise<void> }>();
  private queue = new Map<string, Promise<unknown>>();
  /** The last Helix command per device that finished, so a retry of it (Helix timed out waiting) isn't sent twice. */
  private recent = new Map<string, { key: string; at: number }>();

  constructor(private hub: Hub, private o: {
    helix: () => HelixLinkConfig | undefined; dataDir: string; port: () => number; debounceMs?: number;
    /** How long Helix's command may take before Kova answers and finishes it in the background. Default 2 s (Helix waits 3). */
    answerMs?: number;
    /** The same for a volume press (default 400 ms): answered "pending" by then, and finished in the background. */
    stepAnswerMs?: number;
    /** How often to check that Kova's address hasn't changed (a new DHCP lease). Default 60 s; 0 turns it off. */
    watchMs?: number;
    /** Interfaces, for tests. */
    nets?: () => ReturnType<typeof os.networkInterfaces>;
    /** Following the boxes: how long after start their events are only Kova's first look (30 s), and when the soundbar is looked at again (15 s). */
    settleMs?: number; recheckMs?: number;
  }) {
    const file = join(o.dataDir, 'helix-link.json');
    let t = '';
    try { if (existsSync(file)) t = String(JSON.parse(readFileSync(file, 'utf8')).token ?? ''); } catch { /* make a new one */ }
    if (!/^kvh_[0-9a-f]{48}$/.test(t)) {
      t = `kvh_${randomBytes(24).toString('hex')}`;
      writeFileSync(file, JSON.stringify({ token: t }, null, 2) + '\n', { mode: 0o600 });
    }
    this.token = t;
    this.hub.reg.on('change', e => {
      const id = e.device.id, now = Date.now();
      if (e.patch.on === true && e.prev.on !== true) this.onAt.set(id, now);
      if (e.patch.on === false || e.patch.online === false) { this.onAt.delete(id); this.inputAt.delete(id); }
      if (e.patch.input !== undefined) this.inputAt.set(id, now + 1);
      if (typeof e.patch.media === 'string' && e.patch.media && e.patch.media !== e.prev.media) this.castBy.set(id, e.cause?.kind ?? 'device');
      else if (e.patch.media === null || e.patch.on === false) this.castBy.delete(id);
    });
  }

  /** When each device last came on, and when its input was last read: whether an input is fresh (state()). */
  private onAt = new Map<string, number>();
  private inputAt = new Map<string, number>();

  // ------------------------------------------------------------ the TV and soundbar follow the box --
  //
  // Helix switches each box's TV and soundbar (the owner's choice), leaving the soundbar alone while Kova plays on it
  // (state().casting). Only with `kovaSwitches: true` in the Helix settings does Kova do it instead, and tell Helix so
  // (screenControl): never both. Then, from the box's own events on Helix's feed:
  //  - it starts or carries on playing, or a person wakes it: the TV on and to the box's input; once the TV is up,
  //    the soundbar on and to the TV's sound (eARC), looked at again a little later (an eARC soundbar can wander);
  //  - it goes to sleep or shuts down: the TV off if it still shows the box, the soundbar off if it's on the TV's
  //    sound or the box's adapter.
  // The soundbar is never touched while Kova plays something on it (casting()), and nothing is switched back later:
  // an input a person chose stays. A screen set to `follow: false` is left alone.

  /** When follow() started listening: events from Kova's first look at the boxes aren't changes anyone made. */
  private followFrom = Infinity;
  private following = new Map<string, NodeJS.Timeout>();
  private onEvent = (e: { device: Device; type: string; data: Record<string, unknown> }) => this.follow(e);
  private static CAUSE: Cause = { kind: 'system', label: 'Helix box', detail: 'switching for what the box does' };

  private follow(e: { device: Device; type: string; data: Record<string, unknown> }): void {
    if (e.device.adapter !== 'helix' || Date.now() < this.followFrom || this.o.helix()?.kovaSwitches !== true) return;
    const on = /-started$|^resumed$/.test(e.type) || (e.type === 'screen-awake' && !['idle', 'suspend', 'play'].includes(String(e.data.by ?? '')));
    const off = e.type === 'screen-asleep' || e.type === 'screen-shutdown';
    if (!on && !off) return;
    const sc = this.hub.screens?.().find(x => x.player === e.device.id);
    if (!sc || this.o.helix()?.screens && Object.values(this.o.helix()!.screens!).some(v => v.follow === false && v.tv === sc.tv)) return;
    const t = this.following.get(e.device.id);
    if (t) { clearTimeout(t); this.following.delete(e.device.id); }
    void (on ? this.screenOn(e.device.id, sc) : this.screenOff(sc)).catch(err => console.warn(`[helix-link] ${e.device.name}: ${(err as Error).message}`));
  }

  private send(id: string, cmd: Command): Promise<void> { return this.hub.reg.command(id, cmd, HelixLink.CAUSE).then(() => {}); }

  private async screenOn(box: string, sc: FollowScreen): Promise<void> {
    const tv = this.hub.reg.get(sc.tv);
    if (!tv) return;
    // An input is only trusted when read since the device came on (it wakes on its own input; the last one is stale).
    const fresh = (id: string, want: string) => this.hub.reg.get(id)?.state.input === want && (this.inputAt.get(id) ?? 0) > (this.onAt.get(id) ?? Infinity);
    const tvWasOn = tv.state.on === true;
    if (!tvWasOn) await this.send(sc.tv, { on: true });
    if (sc.input && !(tvWasOn && fresh(sc.tv, sc.input))) await this.send(sc.tv, { input: sc.input });
    if (!sc.soundbar) return;
    const bar = sc.soundbar, want = sc.soundbarInputs?.[0] ?? 'tv';
    const soundbar = async () => {
      const d = this.hub.reg.get(bar);
      if (!d || this.casting(bar)) return;
      const wasOn = d.state.on === true;
      if (!wasOn) await this.send(bar, { on: true });
      if (!(wasOn && fresh(bar, want))) await this.send(bar, { input: want });
    };
    await soundbar();
    // Once more after the TV has settled (an eARC soundbar follows the TV around as it wakes).
    const t = setTimeout(() => { this.following.delete(box); void soundbar().catch(() => {}); }, this.o.recheckMs ?? 15_000);
    t.unref?.();
    this.following.set(box, t);
  }

  private async screenOff(sc: FollowScreen): Promise<void> {
    const tv = this.hub.reg.get(sc.tv);
    const jobs: Promise<void>[] = [];
    if (tv?.state.on === true && (!sc.input || !tv.state.input || tv.state.input === sc.input)) jobs.push(this.send(sc.tv, { on: false }));
    const bar = sc.soundbar ? this.hub.reg.get(sc.soundbar) : undefined;
    if (bar && bar.state.on === true && !this.casting(bar.id) && (!bar.state.input || (sc.soundbarInputs ?? ['tv', 'hdmi1']).includes(bar.state.input))) jobs.push(this.send(bar.id, { on: false }));
    await Promise.all(jobs);
  }

  start(): void {
    this.followFrom = Date.now() + (this.o.settleMs ?? 30_000);
    this.hub.reg.on('event', this.onEvent);
    const soon = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, this.o.debounceMs ?? 2000);
      this.timer.unref?.();
    };
    this.hub.reg.on('devices', soon);
    this.hub.on('changed', soon);
    soon();
    // Kova's address can change under it (a new lease): Helix has no other way to find it, so it's sent again.
    const every = this.o.watchMs ?? 60_000;
    if (every > 0) { this.watch = setInterval(() => void this.sync(), every); this.watch.unref?.(); }
  }

  stop(): void {
    this.hub.reg.off('event', this.onEvent);
    for (const t of this.following.values()) clearTimeout(t);
    this.following.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.watch) clearInterval(this.watch);
    this.timer = null;
    this.watch = null;
  }

  /** Helix's command for a linked device, as Kova's, or why not: one key, by Helix's names (D98.11). */
  translate(deviceId: string, body: Record<string, unknown>): { cmd: Command } | { error: string } {
    const s = this.screens();
    const tv = s.some(x => x.tvDeviceId === deviceId), bar = s.some(x => x.soundbarDeviceId === deviceId);
    const fields = tv ? HELIX_TV_FIELDS : bar ? HELIX_SOUNDBAR_FIELDS : null;
    const keys = Object.keys(body ?? {});
    if (!fields) return { error: 'Not a TV or soundbar linked to Helix' };
    if (keys.length !== 1 || !(keys[0] in fields)) return { error: `Send one of ${Object.keys(fields).join(', ')}` };
    const k = keys[0], v = body[k];
    const ok = k === 'on' || k === 'mute' || k === 'nightMode' ? typeof v === 'boolean'
      : k === 'volumeStep' ? v === 1 || v === -1
      : k === 'volume' ? typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100
      : k === 'input' ? typeof v === 'string' && (tv ? TV_INPUTS : SOUNDBAR_INPUTS).some(i => i.id === v)
      : k === 'mode' ? typeof v === 'string' && SOUNDBAR_MODES.some(m => m.id === v)
      : false;
    if (!ok) return { error: `${k} can’t be ${JSON.stringify(v)}` };
    return { cmd: { [fields[k]]: v } as Command };
  }

  /**
   * A soundbar's volume press, through its TV's local remote (the TV passes it on over eARC): at once, with no cloud
   * round trip. Only while that TV is on and the soundbar plays the TV's sound (or can't say); false to use the
   * soundbar's own way (SmartThings) instead, also when the TV's key fails.
   */
  private async stepViaTv(bar: string, step: number, cause: Cause): Promise<boolean> {
    const sc = this.screens().find(x => x.soundbarDeviceId === bar);
    const b = this.hub.reg.get(bar);
    if (!sc || !b || this.casting(bar)) return false;
    const tvInput = sc.soundbarTvInput ?? 'tv';
    if (typeof b.state.input === 'string' && b.state.input && b.state.input !== tvInput) return false;
    const c = (this.hub.config.get().combined ?? []).find(x => `combined_${x.id}` === sc.tvDeviceId);
    const local = (c ? c.members : [sc.tvDeviceId]).map(id => this.hub.reg.get(id))
      .find(d => !!d && d.adapter === 'samsungtv' && d.state.on === true && d.state.online !== false);
    if (!local) return false;
    try { await this.hub.reg.command(local.id, { volStep: step }, cause, { quiet: true }); return true; }
    catch { return false; }
  }

  /**
   * Carry out Helix's command (`POST /api/devices/<id>`, one key): answered within `answerMs`. Commands to one device
   * run one after another, so an input right after "on" waits until the TV is up (never refused for that); the same
   * command again while it runs, or just after, isn't sent twice; one still running at `answerMs` is accepted (202)
   * and finished in the background (a TV waking from deep standby).
   */
  async command(deviceId: string, body: Record<string, unknown>, auto: boolean): Promise<HelixReply> {
    const t = this.translate(deviceId, body);
    if ('error' in t) return { status: 403, body: { error: t.error } };
    const key = JSON.stringify(t.cmd);
    const running = this.running.get(deviceId);
    const recent = this.recent.get(deviceId);
    let done: Promise<void>;
    // A volume step is a press, not a state: each one counts.
    const repeatable = t.cmd.volStep === undefined;
    if (repeatable && running?.key === key) done = running.done;
    else if (repeatable && !running && recent?.key === key && Date.now() - recent.at < 5000) return { status: 200, body: { ok: true } };
    else {
      const cause = auto ? HELIX_AUTO : HELIX_REMOTE;
      const before = this.queue.get(deviceId) ?? Promise.resolve();
      done = before.catch(() => {}).then(async () => {
        try {
          if (t.cmd.volStep !== undefined && await this.stepViaTv(deviceId, t.cmd.volStep, cause)) { this.recent.set(deviceId, { key, at: Date.now() }); return; }
          await this.hub.engine.command(deviceId, t.cmd, cause);
          this.recent.set(deviceId, { key, at: Date.now() });
        } finally {
          if (this.running.get(deviceId)?.done === done) this.running.delete(deviceId);
        }
      });
      this.running.set(deviceId, { key, done });
      const tail = done.catch(err => { console.warn(`[helix-link] ${deviceId} ${key}: ${err instanceof Error ? err.message : String(err)}`); });
      this.queue.set(deviceId, tail);
      void tail.then(() => { if (this.queue.get(deviceId) === tail) this.queue.delete(deviceId); });
    }
    let timer: NodeJS.Timeout | undefined;
    // A volume press is answered quickly (the remote should feel instant); a soundbar that's slow finishes it after.
    const wait = t.cmd.volStep !== undefined ? Math.min(this.o.stepAnswerMs ?? 400, this.o.answerMs ?? 2000) : this.o.answerMs ?? 2000;
    const late = new Promise<'late'>(r => { timer = setTimeout(() => r('late'), wait); timer.unref?.(); });
    try {
      const r = await Promise.race([done.then(() => 'done' as const), late]);
      return r === 'done' ? { status: 200, body: { ok: true } } : { status: 202, body: { ok: true, pending: true } };
    } catch (e) {
      return { status: 502, body: { error: e instanceof Error ? e.message : String(e) } };
    } finally { clearTimeout(timer); }
  }

  status(): LinkStatus | null { return this.last; }

  /** The address Kova gives Helix, or why there's none fit for it. */
  private address(): { url: string } | { problem: string } | null {
    const c = this.o.helix();
    if (!c?.url || !c.token) return null;
    if (c.kovaUrl) {
      const problem = kovaUrlProblem(trimUrl(c.kovaUrl), c.url);
      return problem ? { problem } : { url: trimUrl(c.kovaUrl) };
    }
    const auto = kovaAddress(c.url, this.o.port(), this.o.nets?.());
    return auto ? { url: auto } : { problem: 'This hub has no private network address Helix can reach. Set Kova’s address for Helix (http://<IP address>:<port>).' };
  }

  /** Where Helix reaches Kova (null until paired, or when there's no address fit for Helix). */
  kovaUrl(): string | null {
    const a = this.address();
    return a && 'url' in a ? a.url : null;
  }

  /** The other names each box was known by, from the Helix integration (rooms and screens are kept by box name). */
  private aliases = (box: Device): string[] => {
    const helix = this.hub.reg.adapters.get('helix');
    return helix instanceof HelixAdapter ? helix.aliases(box.id) : [];
  };

  screens(): HelixScreen[] {
    const cfg = this.hub.config.get();
    // Parts of a combined device, and archived ones, are never a box's TV or soundbar: the combined device stands for them.
    const skip = new Set([...(cfg.combined ?? []).flatMap(c => c.members), ...Object.entries(cfg.devices ?? {}).filter(([, v]) => v?.archived).map(([id]) => id)]);
    return helixScreens(this.hub.reg.devices.values(), this.o.helix()?.screens, this.aliases, { rooms: cfg.rooms.map(r => r.id), skip });
  }

  /** Is this Helix's token? Constant time. */
  isToken(given: string): boolean {
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** What Helix's token may do: control a linked TV or soundbar, and read them. */
  allows(method: string, path: string): boolean {
    if (method === 'GET' && path === '/api/state') return true;
    // Casting from Helix's apps to Kova's speakers (api/helix-cast-routes.ts).
    if ((method === 'GET' && path === '/api/helix/speakers') || (method === 'POST' && /^\/api\/helix\/(play|control|queue)$/.test(path))) return true;
    const m = method === 'POST' && /^\/api\/devices\/([^/]+)$/.exec(path);
    const id = m ? decodeURIComponent(m[1]) : '';
    return !!m && this.screens().some(x => x.tvDeviceId === id || x.soundbarDeviceId === id);
  }

  /**
   * Every linked TV and soundbar, in the shape of /api/state, for a request made with Helix's token, by Helix's names
   * and types (one wrong type and Helix drops the whole answer): on (bool), online (bool), input (string), volume
   * (integer 0–100), muted (bool), mode (string), nightMode (bool), inputChangedAt (Unix ms), inputChangedBy (string).
   * A field Kova doesn't know is left out, never guessed; a TV that doesn't answer is off. It comes from what Kova
   * already knows (no device is asked), so it's quick: Helix allows 3 s, its devices view 2 s.
   */
  /** Who started what each speaker plays: the kind of cause of its last new media. */
  private castBy = new Map<string, Cause['kind']>();

  /** Whether what Kova plays on this soundbar keeps it from the box: an announcement, or something a person started. */
  private castingHolds(id: string, casting: Device): boolean {
    const parts = [id, ...(this.hub.config.get().combined ?? []).filter(c => c.members.includes(id) || `combined_${c.id}` === id).flatMap(c => [`combined_${c.id}`, ...c.members])];
    if (parts.some(x => this.hub.announcer?.announcing(x))) return true;
    const by = this.castBy.get(casting.id);
    return by === 'user' || by === 'assistant';
  }

  /** The part of a soundbar playing something of Kova's over Wi-Fi (an announcement, music through a speaker group), if one is: its other parts, combined with it. */
  private casting(id: string): Device | undefined {
    const parts = (this.hub.config.get().combined ?? []).filter(c => c.members.includes(id) || `combined_${c.id}` === id)
      .flatMap(c => [`combined_${c.id}`, ...c.members]).filter(x => x !== id);
    return parts.map(x => this.hub.reg.get(x)).find((x): x is Device => !!x && x.capabilities.includes('media') && !!x.state.on && typeof x.state.media === 'string' && !!x.state.media && !x.state.paused && x.adapter !== 'combined');
  }

  state(): { screenControl?: 'kova'; devices: { id: string; name: string; type: string; state: Record<string, unknown> }[] } {
    const ids = [...new Set(this.screens().flatMap(s => [s.tvDeviceId, ...(s.soundbarDeviceId ? [s.soundbarDeviceId] : [])]))];
    return {
      // Only when Kova switches each box's TV and soundbar itself (follow()): Helix then leaves them alone, but for a person's own buttons.
      ...(this.o.helix()?.kovaSwitches === true ? { screenControl: 'kova' as const } : {}),
      devices: ids.flatMap(id => {
        const d = this.hub.reg.devices.get(id);
        if (!d) return [];
        const st = d.state;
        const bar = isSoundbar(d);
        const change = this.hub.reg.inputChange(id);
        const state: Record<string, unknown> = {};
        if (st.online === false) state.on = false;
        else if (typeof st.on === 'boolean') state.on = st.on;
        if (typeof st.online === 'boolean') state.online = st.online;
        // Only an input read back from the device, never the one asked for: Helix skips its own switch when the
        // input it wants is already the one here. A TV that can't say has none. And only one read since the device
        // last came on: the input it had before standby is stale (a TV wakes on its own input, an eARC soundbar
        // follows the TV), and Helix skipping its switch on it left the TV and soundbar on the wrong inputs.
        if (typeof st.input === 'string' && st.input && st.on !== false && st.online !== false && (this.inputAt.get(id) ?? 0) > (this.onAt.get(id) ?? Infinity)) state.input = st.input;
        if (bar) {
          if (typeof st.vol === 'number' && Number.isFinite(st.vol)) state.volume = Math.max(0, Math.min(100, Math.round(st.vol)));
          if (typeof st.muted === 'boolean') state.muted = st.muted;
          if (typeof st.sound === 'string' && st.sound) state.mode = st.sound;
          if (typeof st.night === 'boolean') state.nightMode = st.night;
          // Playing something of Kova's over Wi-Fi (an announcement, music through a speaker group): this soundbar's
          // other parts (its Cast side, combined with it) say so. Helix leaves the input alone while it does.
          const casting = this.casting(id);
          state.casting = !!casting;
          if (casting) {
            state.castingMedia = casting.state.media;
            // The owner's rule: something a person plays on the box gets the soundbar, except an announcement (the
            // adhan) or music a person started on Kova. What Kova started by itself (a mode, an automation's music)
            // gives way: Helix may switch the soundbar to the box then.
            state.castingYields = !this.castingHolds(id, casting);
          }
        }
        if (change && Number.isFinite(change.at)) { state.inputChangedAt = Math.round(change.at); state.inputChangedBy = change.by; }
        return [{ id, name: d.name, type: bar ? 'soundbar' : d.type, state }];
      }),
    };
  }

  /** Tell Helix where Kova is and which TV each box is on, when that changed (or `force`), then read back what it kept. */
  async sync(force = false): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        const c = this.o.helix();
        if (!c?.url || !c.token) { this.last = null; return; }
        const a = this.address();
        if (!a) return;
        if ('problem' in a) { this.last = { ok: false, note: a.problem }; return; }
        const base = trimUrl(c.url);
        const profile = c.musicProfile;
        // Every screen with every field: Helix replaces its list with this one. No autoSwitch or sleepOff: those are the owner's in Helix.
        const body = { url: a.url, token: this.token, screens: this.screens() };
        const key = JSON.stringify({ h: base, t: c.token, ...body });
        if (!force && key === this.sent) return;
        const features = await helixFeatures(base, c.token, profile);
        if (features?.devices === false) { this.sent = ''; this.last = { ok: false, note: 'Helix Server has TV and soundbar control through Kova turned off (Helix Server → Integrations)' }; return; }
        await lanJson(`${base}/v1/integrations/kova`, { method: 'PUT', body, token: c.token, headers: helixHeaders(profile) });
        this.sent = key;
        this.helixView = await lanJson<{ reachable?: boolean; screens?: { playerId?: string }[] }>(`${base}/v1/integrations/kova`, { token: c.token, headers: helixHeaders(profile) })
          .then(r => ({ reachable: typeof r.json?.reachable === 'boolean' ? r.json.reachable : undefined, playerIds: (r.json?.screens ?? []).map(s => String(s.playerId ?? '')).filter(Boolean) }))
          .catch(() => null);
        this.last = this.describe(body.screens, a.url);
        // Helix couldn't reach Kova at that address: try again next time round, even with nothing changed.
        if (this.helixView?.reachable === false) this.sent = '';
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const status = e instanceof LanHttpError ? e.status : 0;
        this.last = { ok: false, note: status === 401 || status === 403 ? 'Helix no longer accepts Kova. Pair again.' : `Couldn’t tell Helix about Kova’s TVs: ${m}` };
      }
    })();
    try { await this.syncing; } finally {
      this.syncing = null;
      if (this.again) { this.again = false; await this.sync(); }
    }
  }

  private describe(screens: HelixScreen[], url: string): LinkStatus {
    const n = screens.length;
    const view = this.helixView;
    if (view?.reachable === false) return { ok: false, note: `Helix can’t reach Kova at ${url}. Check Kova’s address for Helix.` };
    const kept = view ? screens.filter(s => view.playerIds.includes(s.playerId)).length : n;
    const what = n ? `Helix turns on ${n} TV${n === 1 ? '' : 's'} through Kova` : 'Linked. No box shares a room with a TV yet.';
    const missing = view && view.playerIds.length && kept < n ? ` (Helix kept ${kept} of them)` : '';
    return { ok: true, note: `${what}${missing}${view?.reachable ? ' · Helix reaches Kova' : ''}` };
  }
}
