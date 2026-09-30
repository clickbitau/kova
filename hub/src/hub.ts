import { EventEmitter } from 'node:events';
import { Store } from './store/db.ts';
import { ConfigStore } from './engine/config.ts';
import { Registry } from './devices/registry.ts';
import { Engine } from './engine/engine.ts';
import { Checker } from './engine/findings.ts';
import { Assistant } from './assistant/assistant.ts';
import type { Adapter } from './adapters/sdk.ts';
import type { HomeConfig } from './model/types.ts';
import type { Weather } from './services/weather.ts';
import { Energy } from './services/energy.ts';

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

  constructor(private opts: HubOptions) {
    super();
    this.store = new Store(opts.dbPath, opts.now);
    this.config = new ConfigStore(this.store, opts.initialConfig);
    this.reg = new Registry(this.store, name => this.config.get().sources.find(s => s.name === name)?.url, () => this.config.get().devices ?? {});
    this.config.on('changed', () => this.reg.reapplySettings());
    this.engine = new Engine(this.store, this.reg, this.config, opts.now);
    this.checker = new Checker(this.engine, this.store, this.config, () => this.reg.devices);
    this.assistant = new Assistant(this.engine, this.reg, this.config);
    this.energy = new Energy(this.store, this.reg, () => this.config.get().timezone, opts.now);
    this._demo = !!opts.demo;
    this.weather = opts.weather;
    this.engine.on('changed', () => this.emit('changed'));
    this.reg.on('measure', () => this.emit('changed'));
    this.weather?.on('changed', () => this.emit('changed'));
  }

  async start(): Promise<void> {
    for (const a of this.opts.adapters) await this.reg.addAdapter(a);
    this.engine.start(this.opts.tickMs ?? 1000);
    this.energy.start(this.opts.energyMs ?? (this.opts.tickMs === 0 ? 0 : 60_000));
    this.weather?.start(this.config.get());
  }

  async stop(): Promise<void> {
    this.engine.stop();
    this.energy.stop();
    this.weather?.stop();
    await this.reg.stop();
    this.store.close();
  }
}
