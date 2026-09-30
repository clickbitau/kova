import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.ts';
import { buildServer } from './api/server.ts';
import { VirtualAdapter } from './adapters/virtual.ts';
import { SonosAdapter } from './adapters/sonos.ts';
import { adaptersFor, loadIntegrations } from './integrations.ts';
import { IntegrationsManager } from './integrations-store.ts';
import { existsSync, readFileSync } from 'node:fs';
import type { HomeConfig } from './model/types.ts';
import { MatterAdapter } from './adapters/matter.ts';
import { Weather } from './services/weather.ts';
import { HomeKitBridge } from './bridges/homekit.ts';
import { AirCastBridge } from './bridges/aircast.ts';
import { demoConfig, demoDevices, DEMO_SOLAR } from './seed/demo-home.ts';
import type { Adapter } from './adapters/sdk.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = resolve(env.KOVA_DATA ?? resolve(here, '../../data'));
// Real devices come from integrations.json (see src/tools/import-ha.ts). Without one, run the demo home.
const integrationsFile = resolve(dataDir, 'integrations.json');
const integrations = loadIntegrations(integrationsFile);
const demo = env.KOVA_DEMO ? env.KOVA_DEMO !== '0' : !integrations;
const homeFile = resolve(dataDir, 'home.json');
const initialConfig = (): HomeConfig => !demo && existsSync(homeFile) ? JSON.parse(readFileSync(homeFile, 'utf8')) as HomeConfig : demoConfig();

const adapters: Adapter[] = integrations ? adaptersFor(integrations, dataDir) : [];
if (demo) adapters.push(new VirtualAdapter(demoDevices(), DEMO_SOLAR));
if (env.KOVA_SONOS === '1') adapters.push(new SonosAdapter());
if (env.KOVA_MATTER === '1' && !integrations?.matter) adapters.push(new MatterAdapter({ storageDir: resolve(dataDir, 'matter') }));

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

// iPhone → Cast speakers: AirConnect's aircast, supervised by Kova.
let aircast: AirCastBridge | undefined;
if (integrations?.aircast?.binary) {
  aircast = new AirCastBridge({ ...integrations.aircast, workDir: integrations.aircast.workDir ?? resolve(dataDir, 'aircast') });
  aircast.on('status', () => hub.emit('changed'));
  aircast.start();
  const ac = aircast;
  hub.services.push({
    id: 'aircast', name: 'AirPlay to Cast speakers', icon: 'airplay', kind: 'Local',
    status: () => { const st = ac.status(); return st.running ? { ok: true, note: 'Your Cast speakers and groups appear in AirPlay' } : { ok: false, note: st.error ?? 'Starting…' }; },
  });
}

let homekit: HomeKitBridge | undefined;
if (env.KOVA_HOMEKIT === '1' || integrations?.homekitBridge) {
  homekit = new HomeKitBridge(hub, { storageDir: resolve(dataDir, 'homekit'), port: Number(env.KOVA_HOMEKIT_PORT ?? integrations?.homekitBridge?.port ?? 51826) });
  await homekit.start();
  console.log(`Apple Home bridge published · setup code ${homekit.setupInfo().pincode}`);
}

// In-app setup edits integrations.json and restarts one integration at a time.
const setup = new IntegrationsManager(hub, { path: integrationsFile, dataDir });
const app = await buildServer(hub, { webRoot: resolve(here, '../../web'), token: env.KOVA_TOKEN || undefined, homekit, integrations: setup });
const port = Number(env.KOVA_PORT ?? 8140);
await app.listen({ port, host: env.KOVA_HOST ?? '0.0.0.0' });
console.log(`Kova hub listening on http://localhost:${port}${demo ? ' (demo home)' : ''}`);

const shutdown = async () => { await app.close(); await homekit?.stop(); await aircast?.stop(); await hub.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
