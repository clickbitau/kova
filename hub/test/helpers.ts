import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { atLocal } from '../src/util/time.ts';
import type { HomeConfig } from '../src/model/types.ts';

export const TZ = 'Australia/Perth';
export const DATE = '2026-09-30';
export const at = (hour: number, date = DATE) => atLocal(date, hour, TZ);

/** A demo-home hub on an in-memory database with a clock the test controls. */
export async function testHub(startHour = 12, tweak?: (c: HomeConfig) => void) {
  const clock = { t: at(startHour) };
  const virtual = new VirtualAdapter(demoDevices());
  const hub = new Hub({
    dbPath: ':memory:',
    initialConfig: () => { const c = demoConfig(); tweak?.(c); return c; },
    adapters: [virtual],
    now: () => clock.t,
    tickMs: 0,
  });
  await hub.start();
  const advance = async (hour: number, date = DATE) => { clock.t = at(hour, date); await hub.engine.tick(clock.t); };
  const dev = (id: string) => hub.reg.get(id)!.state;
  return { hub, clock, virtual, advance, dev };
}
