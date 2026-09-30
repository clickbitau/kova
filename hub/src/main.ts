import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.ts';
import { buildServer } from './api/server.ts';
import { VirtualAdapter } from './adapters/virtual.ts';
import { SonosAdapter } from './adapters/sonos.ts';
import { adaptersFor, loadIntegrations } from './integrations.ts';
import { existsSync, readFileSync } from 'node:fs';
import type { HomeConfig } from './model/types.ts';
import { Weather } from './services/weather.ts';
import { demoConfig, demoDevices } from './seed/demo-home.ts';
import type { Adapter } from './adapters/sdk.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = resolve(env.KOVA_DATA ?? resolve(here, '../../data'));
// Real devices come from integrations.json (see src/tools/import-ha.ts). Without one, run the demo home.
const integrations = loadIntegrations(resolve(dataDir, 'integrations.json'));
const demo = env.KOVA_DEMO ? env.KOVA_DEMO !== '0' : !integrations;
const homeFile = resolve(dataDir, 'home.json');
const initialConfig = (): HomeConfig => !demo && existsSync(homeFile) ? JSON.parse(readFileSync(homeFile, 'utf8')) as HomeConfig : demoConfig();

const adapters: Adapter[] = integrations ? adaptersFor(integrations) : [];
if (demo) adapters.push(new VirtualAdapter(demoDevices()));
if (env.KOVA_SONOS === '1') adapters.push(new SonosAdapter());

const hub = new Hub({
  dbPath: resolve(dataDir, 'kova.db'),
  initialConfig,
  adapters,
  demo,
  weather: env.KOVA_WEATHER === '0' ? undefined : new Weather(),
});

await hub.start();

// On a brand-new demo home, put the virtual devices where today's plan says they'd be.
if (demo && !hub.store.get('seeded')) {
  const st = hub.engine.preview(Date.now());
  for (const d of hub.reg.list()) if (d.adapter === 'virtual') d.state = { ...d.state, ...st[d.id] };
  hub.reg.flush();
  hub.store.set('seeded', true);
}

const app = await buildServer(hub, { webRoot: resolve(here, '../../web'), token: env.KOVA_TOKEN || undefined });
const port = Number(env.KOVA_PORT ?? 8140);
await app.listen({ port, host: env.KOVA_HOST ?? '0.0.0.0' });
console.log(`Kova hub listening on http://localhost:${port}${demo ? ' (demo home)' : ''}`);

const shutdown = async () => { await app.close(); await hub.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
