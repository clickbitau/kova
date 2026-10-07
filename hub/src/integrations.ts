import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { HomeKitControllerAdapter, type HomeKitAccessoryConfig } from './adapters/homekit-controller.ts';
import { EcovacsAdapter, type EcovacsOptions } from './adapters/ecovacs.ts';
import { NestAdapter, type NestOptions } from './adapters/nest.ts';
import type { PresenceOptions } from './services/presence.ts';
import type { NotifyOptions } from './services/notify.ts';
import { MatterAdapter } from './adapters/matter.ts';
import { WardenAdapter, type WardenOptions } from './adapters/warden.ts';
import { HelixAdapter, type HelixOptions } from './adapters/helix.ts';
import { SmartThingsAdapter, type SmartThingsOptions } from './adapters/smartthings.ts';
import { ConnectLifeAdapter, type ConnectLifeOptions } from './adapters/connectlife.ts';

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
  /** Hand Kova's devices to Apple Home (same as KOVA_HOMEKIT=1). */
  homekitBridge?: { port?: number; pincode?: string; exclude?: { adapters?: string[]; devices?: string[] } };
  /** Matter controller on or off; its fabric lives in <KOVA_DATA>/matter. Same as KOVA_MATTER=1. */
  matter?: Record<string, never>;
  /**
   * Kova as a Matter bridge, for Google Home, Alexa, SmartThings and Apple Home. Same as KOVA_MATTER_BRIDGE=1.
   * Its passcode and fabrics live in <KOVA_DATA>/matter-bridge. `exclude.adapters` defaults to ['matter', 'homekit'].
   */
  matterBridge?: { port?: number; exclude?: { adapters?: string[]; devices?: string[] } };
  /** Levoit purifiers through the VeSync cloud (needs the VeSync account). */
  vesync?: VeSyncOptions;
  /** Samsung TVs on the local network. Pairing tokens go in `<dataDir>/samsungtv/` unless storageDir is set. */
  samsungtv?: Omit<SamsungTvOptions, 'storageDir'> & { storageDir?: string };
  /** HomeKit accessories Kova controls. Pairing happens in the app; keys live in `<KOVA_DATA>/homekit-controller/`. */
  homekit?: { accessories?: HomeKitAccessoryConfig[] };
  /** DEEBOT robot vacuums through the Ecovacs cloud (needs the Ecovacs account). */
  ecovacs?: Omit<EcovacsOptions, 'storageDir'>;
  /** Nest cameras and doorbells through Google's SDM cloud API. Starts once projectId and refreshToken are set. */
  nest?: NestOptions;
  /** Warden OS, the router: internet status and alerts, per-device internet pause, and who's home from phones on the network. */
  warden?: WardenOptions;
  /** Helix, the media server and TV boxes: what's playing, pause, play by name, Movie mode by itself. */
  helix?: HelixOptions;
  /** Samsung soundbars through SmartThings (power, input, volume, mute, sound and night mode). Sign-in kept in <KOVA_DATA>/smartthings/. */
  smartthings?: Omit<SmartThingsOptions, 'storageDir'>;
  /** Hisense air conditioners through the ConnectLife cloud. Sign-in kept in <KOVA_DATA>/connectlife/. */
  connectlife?: Omit<ConnectLifeOptions, 'storageDir'>;
  /** Who's home: phone MACs from the router (Warden or OPNsense), a TCP ping, and phone automations. */
  presence?: PresenceOptions;
  /** Push notifications: Web Push to the phone app (no config needed) and/or ntfy, plus which built-in rules run. */
  notify?: NotifyOptions;
}

export function loadIntegrations(path: string): Integrations | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Integrations : null;
}

/** Write integrations.json with owner-only permissions (it holds device keys). */
export function saveIntegrations(path: string, i: Integrations): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(i, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

type Factories = { [K in keyof Integrations]-?: ((cfg: NonNullable<Integrations[K]>, dataDir: string) => Adapter | null) | null };

/**
 * How each section runs. A device adapter's id is its section name, so in-app
 * setup can stop and restart one section on its own (see integrations-store.ts).
 * `null` marks a section that isn't an adapter (the bridges, presence and notifications are services main.ts starts).
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
  ecovacs: (c, dataDir) => c.email && c.password ? new EcovacsAdapter({ ...c, storageDir: join(dataDir, 'ecovacs') }) : null,
  homekit: (c, dataDir) => new HomeKitControllerAdapter({ storageDir: join(dataDir, 'homekit-controller'), accessories: c.accessories }),
  nest: (c, dataDir) => c.projectId && c.refreshToken ? new NestAdapter({ ...c, storageDir: c.storageDir ?? join(dataDir, 'nest') }) : null,
  warden: c => c.url && c.token ? new WardenAdapter(c) : null,
  helix: (c, dataDir) => c.url ? new HelixAdapter({ ...c, storageDir: c.storageDir ?? join(dataDir, 'helix') }) : null,
  smartthings: (c, dataDir) => c.token || (c.clientId && c.clientSecret) ? new SmartThingsAdapter({ ...c, storageDir: join(dataDir, 'smartthings') }) : null,
  connectlife: (c, dataDir) => new ConnectLifeAdapter({ ...c, storageDir: join(dataDir, 'connectlife') }),
  homekitBridge: null,
  matterBridge: null,
  presence: null,
  notify: null,
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
