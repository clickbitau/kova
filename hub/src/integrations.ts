import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Adapter } from './adapters/sdk.ts';
import { TuyaAdapter, type TuyaOptions } from './adapters/tuya/index.ts';
import { TapoAdapter, type TapoOptions } from './adapters/tapo.ts';
import { CastAdapter, type CastOptions } from './adapters/cast/index.ts';
import { SonosAdapter, type SonosOptions } from './adapters/sonos.ts';
import { AirPlayAdapter, type AirPlayOptions } from './adapters/airplay.ts';
import { GoodWeAdapter, type GoodWeOptions } from './adapters/goodwe.ts';
import type { AirCastOptions } from './bridges/aircast.ts';
import { VeSyncAdapter, type VeSyncOptions } from './adapters/vesync.ts';
import { SamsungTvAdapter, type SamsungTvOptions } from './adapters/samsung-tv.ts';
import { MatterAdapter } from './adapters/matter.ts';

/**
 * What's connected in this home, and how to reach it. Lives in
 * `<KOVA_DATA>/integrations.json`, next to the database. It holds device keys,
 * so it's created with owner-only permissions and never goes in git.
 */
export interface Integrations {
  tuya?: TuyaOptions;
  tapo?: TapoOptions;
  cast?: CastOptions;
  sonos?: SonosOptions;
  /** Kova → AirPlay devices, through an OwnTone server. */
  airplay?: AirPlayOptions;
  /** iPhone → Cast speakers: runs AirConnect's aircast. `workDir` defaults to <KOVA_DATA>/aircast. */
  aircast?: Omit<AirCastOptions, 'workDir'> & { workDir?: string };
  /** Solar inverter(s) over Modbus TCP. */
  goodwe?: GoodWeOptions;
  /** Matter controller on or off; its fabric lives in <KOVA_DATA>/matter. Same as KOVA_MATTER=1. */
  matter?: Record<string, never>;
  /** Levoit purifiers through the VeSync cloud (needs the VeSync account). */
  vesync?: VeSyncOptions;
  /** Samsung TVs on the local network. Pairing tokens go in `<dataDir>/samsungtv/` unless storageDir is set. */
  samsungtv?: Omit<SamsungTvOptions, 'storageDir'> & { storageDir?: string };
  /** Kova → Apple Home: publish the HomeKit bridge (same as KOVA_HOMEKIT=1). Its pairings live in <KOVA_DATA>/homekit. */
  homekitBridge?: { port?: number };
}

export function loadIntegrations(path: string): Integrations | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Integrations : null;
}

type Factories = { [K in keyof Integrations]-?: ((cfg: NonNullable<Integrations[K]>, dataDir: string) => Adapter | null) | null };

/**
 * How each section runs. A device adapter's id is its section name, so in-app
 * setup can stop and restart one section on its own (see integrations-store.ts).
 * `null` marks a section that isn't an adapter (aircast and homekitBridge are bridges main.ts starts).
 * Typed over every key of Integrations, so a new section can't be forgotten here.
 */
export const ADAPTER_FACTORIES: Factories = {
  tuya: c => c.devices?.length ? new TuyaAdapter(c) : null,
  tapo: c => c.devices?.length ? new TapoAdapter(c) : null,
  cast: c => new CastAdapter(c),
  sonos: c => new SonosAdapter(c),
  airplay: c => c.url ? new AirPlayAdapter(c) : null,
  aircast: null,
  goodwe: c => c.host ? new GoodWeAdapter(c) : null,
  matter: (_c, dataDir) => new MatterAdapter({ storageDir: join(dataDir, 'matter') }),
  vesync: c => c.email && c.password ? new VeSyncAdapter(c) : null,
  samsungtv: (c, dataDir) => c.tvs?.length ? new SamsungTvAdapter({ ...c, storageDir: c.storageDir ?? join(dataDir, 'samsungtv') }) : null,
  homekitBridge: null,
};

export const INTEGRATION_SECTIONS = Object.keys(ADAPTER_FACTORIES) as (keyof Integrations)[];

const defaultDataDir = () => resolve(process.env.KOVA_DATA ?? 'data');

/** The adapter for one section, or null when the section isn't an adapter or isn't set up enough to run. */
export function adapterFor(section: keyof Integrations, i: Integrations, dataDir = defaultDataDir()): Adapter | null {
  const cfg = i[section];
  const f = ADAPTER_FACTORIES[section] as ((c: unknown, d: string) => Adapter | null) | null;
  return cfg && f ? f(cfg, dataDir) : null;
}

/** `dataDir` is where adapters keep what they learn (e.g. TV pairing tokens); defaults to $KOVA_DATA or ./data. */
export function adaptersFor(i: Integrations, dataDir = defaultDataDir()): Adapter[] {
  return INTEGRATION_SECTIONS.map(k => adapterFor(k, i, dataDir)).filter((a): a is Adapter => !!a);
}
