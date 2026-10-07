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
import { CombinedAdapter } from './adapters/combined.ts';
import type { HomeConfig } from './model/types.ts';
import type { Weather } from './services/weather.ts';
import { Energy } from './services/energy.ts';
import type { HelixMusic } from './services/helix-music.ts';
import { Maps, type MapsOptions } from './services/maps.ts';

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
  /** For tests: what the address search and pasted Google Maps links fetch with, and how. */
  maps?: Partial<Omit<MapsOptions, 'store' | 'near'>>;
}

/** Wires the hub's parts together. One per home. */
/** Something shown on the Integrations screen that isn't a device adapter (e.g. a bridge). */
export interface Service { id: string; name: string; icon: string; kind: 'Local' | 'Cloud'; devices?: number; status(): { ok: boolean; note?: string } }

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
  /** What Kova notices: the home at a glance, and alerts and warnings (services/insights.ts). */
  readonly insights: Insights;
  /** Devices reached through several integrations, shown as one (adapters/combined.ts). */
  readonly combined: CombinedAdapter;
  /** Helix music on any speaker (services/helix-music.ts), once Helix is set up. */
  music: HelixMusic | null = null;
  /** Finding the home: the address search, pasted Google Maps links, the Google Maps key (services/maps.ts). */
  readonly maps: Maps;
  /** Updating the hub itself (services/updates.ts); null without an updater set up (tests, Docker). */
  updates: Updates | null = null;
  /** Which media players sit on which TV (and soundbar), for suggested automations. Helix's screens once it's linked. */
  screens: () => Screen[] = () => [];
  /** What already knows whether a person is home without their phone's location (Warden, the router…); [] when only the phone can. */
  presenceVia: (personId: string) => string[] = () => [];

  /** Let speakers play Helix music: names → play queues, for adapters, the snapshot and Ask. */
  useMusic(m: HelixMusic): void {
    this.music = m;
    this.reg.queues = (media, o) => m.queueFor(media, o);
    this.reg.isMusic = media => m.isMusic(media);
    // Each song a speaker starts counts as played in Helix (Recently played, play counts), as in Helix's own apps.
    this.reg.on('change', e => {
      const t = e.patch.track;
      if (t?.id && t.id !== e.prev.track?.id) void m.played(t.id, e.device.name);
    });
    this.assistant.music = m;
  }

  constructor(private opts: HubOptions) {
    super();
    this.store = new Store(opts.dbPath, opts.now);
    this.config = new ConfigStore(this.store, opts.initialConfig);
    this.reg = new Registry(this.store, name => this.config.get().sources.find(s => s.name === name)?.url, () => this.config.get().devices ?? {});
    this.reg.sourceLoops = name => !!this.config.get().sources.find(s => s.name === name)?.loop;
    this.config.on('changed', () => this.reg.reapplySettings());
    this.groups = new SpeakerGroupsAdapter(this.reg, () => this.config.get().speakerGroups ?? []);
    this.config.on('changed', () => this.groups.sync());
    this.combined = new CombinedAdapter(this.reg, () => this.config.get().combined ?? []);
    this.config.on('changed', () => this.combined.sync());
    this.engine = new Engine(this.store, this.reg, this.config, opts.now);
    this.checker = new Checker(this.engine, this.store, this.config, () => this.reg.devices);
    this.assistant = new Assistant(this.engine, this.reg, this.config);
    this.maps = new Maps({ now: opts.now, ...opts.maps, store: this.store, near: () => { const c = this.config.get(); return c.latitude || c.longitude ? { latitude: c.latitude, longitude: c.longitude } : null; } });
    this.energy = new Energy(this.store, this.reg, () => this.config.get().timezone, opts.now, () => this.config.get().devices ?? {});
    this._demo = !!opts.demo;
    this.weather = opts.weather;
    this.engine.on('changed', () => this.emit('changed'));
    this.insights = new Insights(this.reg, this.store, () => ({
      cfg: this.config.get(), now: this.engine.now(), weather: this.weather ? { current: this.weather.current, today: this.weather.today } : null,
      failing: [...this.reg.adapters.values()].filter(a => a.id !== 'virtual' && !a.status().ok).map(a => ({ id: a.id, name: a.name, note: a.status().note })),
    }));
    this.reg.on('measure', () => this.emit('changed'));
    this.weather?.on('changed', () => this.emit('changed'));
  }

  async start(): Promise<void> {
    for (const a of this.opts.adapters) await this.reg.addAdapter(a);
    // Speaker groups come after the speakers they group.
    await this.reg.addAdapter(this.groups);
    // Combined devices too: they're made of devices other integrations announce.
    await this.reg.addAdapter(this.combined);
    this.engine.start(this.opts.tickMs ?? 1000);
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
    if (this.placeTimer) clearInterval(this.placeTimer);
    this.engine.stop();
    this.energy.stop();
    this.weather?.stop();
    await this.reg.stop();
    this.store.close();
  }
}
