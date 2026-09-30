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
import { HomeKitControllerAdapter, type HomeKitAccessoryConfig } from './adapters/homekit-controller.ts';

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
  /** HomeKit accessories Kova controls. Pairing happens in the app; keys live in `<KOVA_DATA>/homekit-controller/`. */
  homekit?: { accessories?: HomeKitAccessoryConfig[] };
}

export function loadIntegrations(path: string): Integrations | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Integrations : null;
}

/** `dataDir` is where adapters keep what they learn (e.g. TV pairing tokens); defaults to $KOVA_DATA or ./data. */
export function adaptersFor(i: Integrations, dataDir = resolve(process.env.KOVA_DATA ?? 'data')): Adapter[] {
  const out: Adapter[] = [];
  if (i.tuya?.devices.length) out.push(new TuyaAdapter(i.tuya));
  if (i.tapo?.devices.length) out.push(new TapoAdapter(i.tapo));
  if (i.cast) out.push(new CastAdapter(i.cast));
  if (i.sonos) out.push(new SonosAdapter(i.sonos));
  if (i.airplay?.url) out.push(new AirPlayAdapter(i.airplay));
  if (i.goodwe?.host) out.push(new GoodWeAdapter(i.goodwe));
  if (i.vesync?.email && i.vesync.password) out.push(new VeSyncAdapter(i.vesync));
  if (i.samsungtv?.tvs.length) out.push(new SamsungTvAdapter({ ...i.samsungtv, storageDir: i.samsungtv.storageDir ?? join(dataDir, 'samsungtv') }));
  if (i.homekit) out.push(new HomeKitControllerAdapter({ storageDir: join(dataDir, 'homekit-controller'), accessories: i.homekit.accessories }));
  return out;
}
