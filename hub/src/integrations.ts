import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Adapter } from './adapters/sdk.ts';
import { TuyaAdapter, type TuyaOptions } from './adapters/tuya/index.ts';
import { TapoAdapter, type TapoOptions } from './adapters/tapo.ts';
import { CastAdapter, type CastOptions } from './adapters/cast/index.ts';
import { SonosAdapter, type SonosOptions } from './adapters/sonos.ts';
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
  /** HomeKit accessories Kova controls. Pairing happens in the app; keys live in `<KOVA_DATA>/homekit-controller/`. */
  homekit?: { accessories?: HomeKitAccessoryConfig[] };
}

export function loadIntegrations(path: string): Integrations | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Integrations : null;
}

export function adaptersFor(i: Integrations, dataDir = resolve(process.env.KOVA_DATA ?? 'data')): Adapter[] {
  const out: Adapter[] = [];
  if (i.tuya?.devices.length) out.push(new TuyaAdapter(i.tuya));
  if (i.tapo?.devices.length) out.push(new TapoAdapter(i.tapo));
  if (i.cast) out.push(new CastAdapter(i.cast));
  if (i.sonos) out.push(new SonosAdapter(i.sonos));
  if (i.homekit) out.push(new HomeKitControllerAdapter({ storageDir: join(dataDir, 'homekit-controller'), accessories: i.homekit.accessories }));
  return out;
}
