import { existsSync, readFileSync } from 'node:fs';
import type { Adapter } from './adapters/sdk.ts';
import { TuyaAdapter, type TuyaOptions } from './adapters/tuya/index.ts';
import { TapoAdapter, type TapoOptions } from './adapters/tapo.ts';
import { CastAdapter, type CastOptions } from './adapters/cast/index.ts';
import { SonosAdapter, type SonosOptions } from './adapters/sonos.ts';
import { AirPlayAdapter, type AirPlayOptions } from './adapters/airplay.ts';
import type { AirCastOptions } from './bridges/aircast.ts';

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
}

export function loadIntegrations(path: string): Integrations | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Integrations : null;
}

export function adaptersFor(i: Integrations): Adapter[] {
  const out: Adapter[] = [];
  if (i.tuya?.devices.length) out.push(new TuyaAdapter(i.tuya));
  if (i.tapo?.devices.length) out.push(new TapoAdapter(i.tapo));
  if (i.cast) out.push(new CastAdapter(i.cast));
  if (i.sonos) out.push(new SonosAdapter(i.sonos));
  if (i.airplay?.url) out.push(new AirPlayAdapter(i.airplay));
  return out;
}
