import { Insights } from './services/insights.ts';
import type { Screen } from './engine/automation-ideas.ts';
import { EventEmitter } from 'node:events';
import type { Updates } from './services/updates.ts';
import { Store } from './store/db.ts';
import { ConfigStore } from './engine/config.ts';
import { Registry } from './devices/registry.ts';
import { Engine } from './engine/engine.ts';
import { Checker } from './engine/findings.ts';
import { Assistant } from './assistant/assistant.ts';
import type { Adapter } from './adapters/sdk.ts';
import { SpeakerGroupsAdapter } from './adapters/groups.ts';
import { GroupSync, type GroupSyncOptions } from './engine/group-sync.ts';
import { CombinedAdapter } from './adapters/combined.ts';
import type { HomeConfig, MediaSource } from './model/types.ts';
import type { Weather } from './services/weather.ts';
import { Energy } from './services/energy.ts';
import { PlayCounter, type HelixMusic } from './services/helix-music.ts';
import { SensorHistory } from './services/sensors.ts';
import { Security, type SecurityOptions } from './services/security.ts';
import { suggestZoneRooms } from './util/zones.ts';
import { Maps, type MapsOptions } from './services/maps.ts';
import { RoomClimate, outsideFrom } from './engine/room-climate.ts';
import { join } from 'node:path';
import { Loops } from './services/loops.ts';
import { Clips } from './services/clips.ts';
import { Adhans, builtinAdhan } from './services/adhans.ts';
import { Announcer, CHIME_MEDIA } from './engine/announce.ts';
import { migratePrayer } from './services/prayer.ts';

export interface HubOptions {
  dbPath: string;
  initialConfig: () => HomeConfig;
  adapters: Adapter[];
  now?: () => number;
  /** Tick interval for the engine; 0 disables the timer (tests drive it). */
  tickMs?: number;
  demo?: boolean;
  weather?: Weather;
  /** How often to sample power for the Energy screen; 0 disables it (tests call sample()). */
  energyMs?: number;
  /** Camera alerts and event frames (services/security.ts): where frames are kept, and timings for tests. */
  security?: SecurityOptions;
  /** For tests: what the address search and pasted Google Maps links fetch with, and how. */
  maps?: Partial<Omit<MapsOptions, 'store' | 'near'>>;
  /** The data folder: uploaded clips and downloaded recordings live in `clips/` under it. None: no clips. */
  dataDir?: string;
  /** For tests: how the built-in recordings are downloaded. */
  fetch?: typeof fetch;
  /** For tests: speaker groups' timing (how often drift is checked, the sync test's length). */
  groupSync?: Omit<GroupSyncOptions, 'base'>;
}

/** Wires the hub's parts together. One per home. */
/** Something shown on the Integrations screen that isn't a device adapter (e.g. a bridge). */
export interface Service { id: string; name: string; icon: string; kind: 'Local' | 'Cloud'; devices?: number; status(): { ok: boolean; note?: string } }

/**
 * An integration whose only trouble is that some of its devices aren't answering ("7 of 10 not responding", "1 of 1
 * offline") is working: those devices are the offline-devices alert's business, not "needs attention" for the
 * integration (that's for a sign-in, a cloud or a connection of its own failing).
 */
export const onlyDevicesOffline = (note?: string) => !!note && /^\s*\d+ of \d+ (?:not responding|offline)(?: \([^)]*\))?\s*$/i.test(note);

export class Hub extends EventEmitter<{ changed: [] }> {
  readonly store: Store;
  readonly config: ConfigStore;
  readonly reg: Registry;
  readonly engine: Engine;
  readonly checker: Checker;
  readonly assistant: Assistant;
  private _demo: boolean;
  /** Running the virtual demo home (no integrations.json yet). Ends when a real home is imported. */
  get demo(): boolean { return this._demo; }
  leaveDemo(): void { this._demo = false; this.emit('changed'); }
  readonly weather?: Weather;
  readonly services: Service[] = [];
  readonly energy: Energy;
  /** Speaker groups made in Kova (they're devices of their own). */
  readonly groups: SpeakerGroupsAdapter;
  /** Timing across a speaker group's parts: native groups, speakers played alongside, the sync test (engine/group-sync.ts). */
  readonly groupSync: GroupSync;
  /** What Kova notices: the home at a glance, and alerts and warnings (services/insights.ts). */
  readonly insights: Insights;
  /** Devices reached through several integrations, shown as one (adapters/combined.ts). */
  readonly combined: CombinedAdapter;
  /** Sensors' readings over the day: trends, last changed and last reported (services/sensors.ts). */
  readonly sensors: SensorHistory;
  /** Smart camera and sensor alerts, and the frames kept for camera events (services/security.ts). */
  readonly security: Security;
  /** Helix music on any speaker (services/helix-music.ts), once Helix is set up. */
  music: HelixMusic | null = null;
  /** Finding the home: the address search, pasted Google Maps links, the Google Maps key (services/maps.ts). */
  readonly maps: Maps;
  /** Room ACs: each room a ducted unit's zone serves, turned on and off by voice and other apps (engine/room-climate.ts). */
  readonly roomClimate: RoomClimate;
  /** Updating the hub itself (services/updates.ts); null without an updater set up (tests, Docker). */
  updates: Updates | null = null;
  /** Audio clips kept on the hub for announcements (services/clips.ts). */
  readonly clips: Clips;
  /** Where the hub keeps its files (null in tests that keep nothing). */
  dataDir: string | null;
  /** Seamless loops of sounds that repeat (services/loops.ts). */
  readonly loops: Loops;
  /** The call-to-prayer recordings from Wikimedia Commons, downloaded on first use (services/adhans.ts). */
  readonly adhans: Adhans;
  /** Announcements over the speakers (engine/announce.ts). */
  readonly announcer: Announcer;
  /** The hub's address as a speaker at `host` reaches it ("http://10.0.0.2:8140"); set by the API server. */
  lanBase: (host?: string) => string | null = () => null;

  /** What's wrong with an announcement's media, or null when it can play (for the automation checker). */
  mediaProblem(m: string): string | null {
    if (m === CHIME_MEDIA) return null;
    if (m.startsWith('clip:')) return this.clips.get(m.slice(5)) ? null : 'that clip isn’t on the hub';
    if (m.startsWith('adhan:')) return builtinAdhan(m) ? null : 'Kova doesn’t know that recording';
    if (/^https?:\/\//i.test(m)) return /^https?:\/\/\S+$/i.test(m) ? null : 'that link isn’t valid';
    if (/^song: \S/i.test(m)) return this.music ? null : 'Helix music isn’t set up';
    return this.config.get().sources.some(s => s.name === m) ? null : `there’s no source called “${m}” (use a source’s name, a clip, a recording or a link)`;
  }
  /** Which media players sit on which TV (and soundbar), for suggested automations. Helix's screens once it's linked. */
  screens: () => Screen[] = () => [];
  /** What already knows whether a person is home without their phone's location (Warden, the router…); [] when only the phone can. */
  presenceVia: (personId: string) => string[] = () => [];

  /** Let speakers play Helix music: names → play queues, for adapters, the snapshot and Ask. */
  useMusic(m: HelixMusic): void {
    this.music = m;
    this.reg.queues = (media, o) => m.queueFor(media, o);
    this.reg.queueAgain = media => m.again(media);
    this.reg.isMusic = media => m.isMusic(media);
    // A song a speaker played to (nearly) the end counts as played in Helix (Recently played, play counts), as in
    // Helix's own apps; one skipped part-way doesn't.
    const plays = new PlayCounter((id, player, durationMs) => void m.played(id, player, durationMs), this.opts.now);
    this.reg.on('change', e => { if (e.device.state.track !== undefined || e.prev.track) plays.seen(e.device); });
    this.assistant.music = m;
  }

  constructor(private opts: HubOptions) {
    super();
    this.store = new Store(opts.dbPath, opts.now);
    this.config = new ConfigStore(this.store, opts.initialConfig);
    migratePrayer(this.config);
    this.reg = new Registry(this.store, name => {
      const s = this.config.get().sources.find(x => x.name === name);
      // A sound that repeats (or a Helix song): from the hub, which serves it as a seamless loop (api/sound).
      if (s && this.viaHub(s)) { const base = this.lanBase(); return base ? `${base}/api/sound/${encodeURIComponent(s.name)}.m4a` : s.url; }
      return s?.url;
    }, () => this.config.get().devices ?? {});
    this.reg.sourceLoops = name => { const s = this.config.get().sources.find(x => x.name === name); return !!(s?.loop || s?.helix); };
    this.config.on('changed', () => this.reg.reapplySettings());
    this.config.on('changed', () => this.prepareLoops());
    this.groups = new SpeakerGroupsAdapter(this.reg, () => this.config.get().speakerGroups ?? []);
    this.config.on('changed', () => this.groups.sync());
    this.groupSync = new GroupSync(this.reg, this.config, this.store, { base: host => this.lanBase(host), ...opts.groupSync });
    this.groups.timing = this.groupSync;
    this.groupSync.on('changed', () => this.emit('changed'));
    this.combined = new CombinedAdapter(this.reg, () => this.config.get().combined ?? []);
    this.config.on('changed', () => this.combined.sync());
    this.config.on('changed', () => this.linkNamedZones());
    this.engine = new Engine(this.store, this.reg, this.config, opts.now);
    this.dataDir = opts.dataDir ?? null;
    const clipDir = opts.dataDir ? join(opts.dataDir, 'clips') : null;
    this.clips = new Clips(clipDir);
    this.loops = new Loops(opts.dataDir ? join(opts.dataDir, 'loops') : null);
    this.adhans = new Adhans(clipDir, { fetch: opts.fetch });
    this.announcer = new Announcer(this.reg, this.config, { clips: this.clips, adhans: this.adhans, base: host => this.lanBase(host), now: () => this.engine.now() });
    this.engine.automations.announcer = this.announcer;
    this.checker = new Checker(this.engine, this.store, this.config, () => this.reg.devices, t => this.reg.expandTargets(t));
    this.assistant = new Assistant(this.engine, this.reg, this.config);
    this.assistant.learner = this.checker.learner;
    this.assistant.groupSync = this.groupSync;
    this.maps = new Maps({ now: opts.now, ...opts.maps, store: this.store, near: () => { const c = this.config.get(); return c.latitude || c.longitude ? { latitude: c.latitude, longitude: c.longitude } : null; } });
    this.energy = new Energy(this.store, this.reg, () => this.config.get().timezone, opts.now, () => this.config.get().devices ?? {});
    this._demo = !!opts.demo;
    this.weather = opts.weather;
    this.engine.on('changed', () => this.emit('changed'));
    this.insights = new Insights(this.reg, this.store, () => ({
      cfg: this.config.get(), now: this.engine.now(), weather: this.weather ? { current: this.weather.current, today: this.weather.today } : null,
      failing: [...this.reg.adapters.values()].filter(a => a.id !== 'virtual' && !a.status().ok && !this.coveredElsewhere(a.id) && !onlyDevicesOffline(a.status().note)).map(a => ({ id: a.id, name: a.name, note: a.status().note })),
    }));
    this.reg.on('measure', () => this.emit('changed'));
    this.weather?.on('changed', () => this.emit('changed'));
    this.sensors = new SensorHistory(this.reg, this.store, () => this.engine.now());
    this.security = new Security(this, opts.security ?? {});
    this.roomClimate = new RoomClimate({
      reg: this.reg, config: this.config, store: this.store, rooms: this.engine.rooms, now: () => this.engine.now(),
      apply: (targets, cause) => this.engine.applyMany(targets, cause),
      outside: () => outsideFrom(this.weather ? { current: this.weather.current, today: this.weather.today } : null),
    });
    this.assistant.roomClimate = this.roomClimate;
    this.linkNamedZones();
  }

  /**
   * Zones whose names plainly are rooms ("Theatre", "Office & Guest") are linked to those rooms without asking: the
   * owner already said which is which by naming them. Each zone name is linked once; changing or removing a link
   * afterwards is the owner's and stays.
   */
  linkNamedZones(): void {
    const cfg = this.config.get();
    const todo: [string, string, string[], string][] = [];
    for (const [id, s] of Object.entries(cfg.devices ?? {})) {
      if (!s?.zoneNames) continue;
      const sug = suggestZoneRooms(s.zoneNames, cfg.rooms);
      for (const [n, rooms] of Object.entries(sug)) {
        const name = s.zoneNames[n]!;
        if (s.zoneRooms?.[n]?.length || s.zoneRoomsAuto?.[n] === name) continue;
        todo.push([id, n, rooms, name]);
      }
    }
    if (!todo.length) return;
    this.config.update(c => {
      for (const [id, n, rooms, name] of todo) {
        const s = (c.devices ??= {})[id] ??= {};
        (s.zoneRooms ??= {})[n] = rooms;
        (s.zoneRoomsAuto ??= {})[n] = name;
      }
    });
    for (const [id, n, rooms, name] of todo) {
      this.store.append({ kind: 'system', device: id, feed: 'system', what: `Zone ${n} (“${name}”) serves ${rooms.map(r => cfg.rooms.find(x => x.id === r)?.name ?? r).join(' and ')}`, data: { zone: n, rooms }, cause: { kind: 'system', label: 'Kova', detail: 'matched by the zone’s name' } });
    }
  }

  /**
   * An integration that isn't working needs no alert when every device it reaches is also reached another way and
   * that way works: a TV combined from its local connection and SmartThings keeps working when the TV refuses the
   * local one. The integration page still says what's wrong.
   */
  private coveredElsewhere(adapterId: string): boolean {
    const mine = [...this.reg.devices.values()].filter(d => d.adapter === adapterId);
    if (!mine.length) return false;
    const combos = this.config.get().combined ?? [];
    return mine.every(d => combos.some(c => c.members.includes(d.id) && c.members.some(m => {
      const o = this.reg.get(m);
      return !!o && o.adapter !== adapterId && o.state.online !== false && this.reg.adapters.get(o.adapter)?.status().ok !== false;
    })));
  }

  /** Whether speakers get this sound from the hub: a Helix song, or a recording that repeats when the hub makes loops. */
  viaHub(s: MediaSource): boolean { return !!s.helix || (!!s.loop && !!s.url && !!this.loops?.available()); }

  /**
   * Make the seamless loop of every sound that repeats, one at a time, ahead of when it plays (an hour of it takes a
   * minute or two); drop loops no sound uses any more.
   */
  private loopsTimer: NodeJS.Timeout | null = null;
  prepareLoops(): void {
    // (Config can change while the hub is still being put together.)
    if (!this.loops?.available()) return;
    if (this.loopsTimer) clearTimeout(this.loopsTimer);
    this.loopsTimer = setTimeout(() => {
      this.loopsTimer = null;
      void (async () => {
        const keep = new Set<string>();
        for (const s of this.config.get().sources) {
          if (!this.viaHub(s)) continue;
          // Helix makes a Helix song's loop itself: asked for now, so it's ready when it plays.
          if (s.helix && this.music?.offersLoops()) {
            const ok = await this.music.loopUrl(s.helix.id).then(() => true, () => false);
            if (ok) continue;
          }
          const stable = s.helix?.id ?? s.url!;
          const key = this.loops.key(stable);
          keep.add(key);
          if (this.loops.ready(key) || this.loops.problem(key)) continue;
          try {
            const input = s.helix ? await this.music?.songUrl(s.helix.id) : s.url;
            if (input) await this.loops.make(input, stable);
          } catch (e) { console.warn(`[loops] ${s.name}: ${(e as Error).message}`); }
        }
        this.loops.prune(keep);
      })();
    }, 5000);
    this.loopsTimer.unref?.();
  }

  async start(): Promise<void> {
    for (const a of this.opts.adapters) await this.reg.addAdapter(a);
    // Speaker groups come after the speakers they group.
    await this.reg.addAdapter(this.groups);
    // Combined devices too: they're made of devices other integrations announce.
    await this.reg.addAdapter(this.combined);
    this.prepareLoops();
    this.engine.start(this.opts.tickMs ?? 1000);
    this.security.start();
    this.energy.start(this.opts.energyMs ?? (this.opts.tickMs === 0 ? 0 : 60_000));
    this.weather?.start(this.config.get());
    // A new location or timezone in Settings: the forecast for the new place.
    this.config.on('changed', () => this.weather?.moved(this.config.get()));
    // A home point from Google is refreshed before Google's 30 days are up: a minute after starting, then daily.
    if (this.opts.tickMs !== 0) {
      const first = setTimeout(() => void this.refreshPlace(), 60_000);
      this.placeTimer = setInterval(() => void this.refreshPlace(), 86_400_000);
      first.unref?.(); this.placeTimer.unref?.();
    }
  }

  private placeTimer: NodeJS.Timeout | null = null;
  /** Ask the place's provider for the home's point again when it's due (services/maps.ts refresh). */
  async refreshPlace(): Promise<boolean> {
    const before = this.config.get().location;
    const r = await this.maps.refresh(this.config.get()).catch(() => null);
    // Not if the owner moved the home meanwhile.
    if (!r || this.config.get().location?.updatedAt !== before?.updatedAt) return false;
    this.config.update(c => {
      c.location = r.location; c.latitude = r.location.latitude; c.longitude = r.location.longitude;
      if (r.address) c.address = r.address;
    });
    return true;
  }

  async stop(): Promise<void> {
    this.groupSync.stop();
    await this.security.stop();
    this.sensors.flush();
    if (this.placeTimer) clearInterval(this.placeTimer);
    this.engine.stop();
    this.energy.stop();
    this.weather?.stop();
    await this.reg.stop();
    this.store.close();
  }
}
