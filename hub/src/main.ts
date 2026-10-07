import { randomUUID } from 'node:crypto';
import { automationIdeas, carryOverTvOff, upgradeTvOffOnce } from './engine/automation-ideas.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './hub.ts';
import { buildServer } from './api/server.ts';
import { VirtualAdapter } from './adapters/virtual.ts';
import { SonosAdapter } from './adapters/sonos.ts';
import { adaptersFor, loadIntegrations } from './integrations.ts';
import { IntegrationsManager } from './integrations-store.ts';
import { HaImport } from './import/ha-scan.ts';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { HomeConfig } from './model/types.ts';
import { MatterAdapter } from './adapters/matter.ts';
import { Weather } from './services/weather.ts';
import { HomeKitBridge } from './bridges/homekit.ts';
import { MatterBridge } from './bridges/matter-bridge.ts';
import { AirCastBridge } from './bridges/aircast.ts';
import { demoConfig, demoDevices, DEMO_SOLAR } from './seed/demo-home.ts';
import type { Adapter } from './adapters/sdk.ts';
import { Presence } from './services/presence.ts';
import { HelixLink } from './services/helix-link.ts';
import { Updates } from './services/updates.ts';
import { ScreenNotices, SnapLinks } from './services/screen-notices.ts';
import { HelixMusic } from './services/helix-music.ts';
import { WardenLink } from './services/warden-link.ts';
import { Notifier } from './services/notify.ts';
import { JevAdvisor } from './services/jev.ts';
import { Backups, parseBackupTime } from './services/backup.ts';
import { acquireLock, LockedError, type HeldLock } from './util/lock.ts';
import { KOVA_VERSION } from './version.ts';
import { Agent, setGlobalDispatcher } from 'undici';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = resolve(env.KOVA_DATA ?? resolve(here, '../../data'));

// Everything Kova writes (database, pairings, backups) is private to the user it runs as.
process.umask(0o077);

// A dead IPv6 route stalls fetch() until it times out instead of falling back to IPv4 (the Smart
// Life session endpoint apigw.tuyaeu.com resolves to both). Race the families: whichever connects
// first wins, like browsers do.
setGlobalDispatcher(new Agent({ connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300 } }));

// One hub per data folder, and never while a restore is running.
let lock: HeldLock;
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
  lock = acquireLock(dataDir, 'hub');
} catch (err) {
  if (err instanceof LockedError) console.error(`${err.message}. Not starting.`);
  else console.error(`Can't write to the data folder ${dataDir} (${(err as Error).message}). It must belong to the user Kova runs as${process.getuid ? ` (uid ${process.getuid()})` : ''}.`);
  process.exit(1);
}
// Real devices come from integrations.json (see src/tools/import-ha.ts). Without one, run the demo home.
const integrationsFile = resolve(dataDir, 'integrations.json');
const integrations = loadIntegrations(integrationsFile);
const demo = env.KOVA_DEMO ? env.KOVA_DEMO !== '0' : !integrations;
const homeFile = resolve(dataDir, 'home.json');
const initialConfig = (): HomeConfig => !demo && existsSync(homeFile) ? JSON.parse(readFileSync(homeFile, 'utf8')) as HomeConfig : demoConfig();

const adapters: Adapter[] = integrations ? adaptersFor(integrations, dataDir) : [];
// The demo home lives a little: its sensors drift and its cameras see things now and then.
if (demo) adapters.push(new VirtualAdapter(demoDevices(), DEMO_SOLAR, Date.now, { simulate: true }));
// KOVA_SONOS=1 is the older switch; Sonos set up under Integrations (or found there) takes its place.
if (env.KOVA_SONOS === '1' && !integrations?.sonos) adapters.push(new SonosAdapter());
if (env.KOVA_MATTER === '1' && !integrations?.matter) adapters.push(new MatterAdapter({ storageDir: resolve(dataDir, 'matter') }));

const hub = new Hub({
  dbPath: resolve(dataDir, 'kova.db'),
  initialConfig,
  adapters,
  demo,
  weather: env.KOVA_WEATHER === '0' ? undefined : new Weather(Date.now),
  // The picture of each camera event, kept with it for the timelines.
  security: { framesDir: resolve(dataDir, 'frames') },
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
  aircast = new AirCastBridge({
    ...integrations.aircast, workDir: integrations.aircast.workDir ?? resolve(dataDir, 'aircast'),
    // Leaving a speaker out needs its Cast id: Kova's Cast adapter has it (started above).
    castIds: names => (hub.reg.adapters.get('cast') as { castIdsByName?: (n: string[]) => Record<string, string> } | undefined)?.castIdsByName?.(names) ?? {},
  });
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
  const hk = integrations?.homekitBridge ?? {};
  homekit = new HomeKitBridge(hub, { storageDir: resolve(dataDir, 'homekit'), port: Number(env.KOVA_HOMEKIT_PORT ?? hk.port ?? 51826), pincode: hk.pincode, exclude: hk.exclude });
  await homekit.start();
  console.log(`Apple Home bridge published · setup code ${homekit.setupInfo().pincode}`);
  // Listed with the integrations, like the Matter bridge, so the app can say it's running and whether it's paired.
  const hb = homekit;
  hub.services.push({
    id: 'homekit-bridge', name: 'Apple Home bridge', icon: 'home', kind: 'Local',
    status: () => ({ ok: true, note: hb.paired ? 'Paired with the Home app' : `Not paired yet · code ${hb.setupInfo().pincode}` }),
  });
}

// Google Home, Alexa, SmartThings, Apple Home: Kova as a Matter bridge.
let matterBridge: MatterBridge | undefined;
if (env.KOVA_MATTER_BRIDGE === '1' || integrations?.matterBridge) {
  const cfg = integrations?.matterBridge ?? {};
  const mb = new MatterBridge(hub, {
    storageDir: resolve(dataDir, 'matter-bridge'),
    port: env.KOVA_MATTER_BRIDGE_PORT ? Number(env.KOVA_MATTER_BRIDGE_PORT) : cfg.port,
    exclude: cfg.exclude,
    name: hub.config.get().name || 'Kova',
  });
  try {
    await mb.start();
    matterBridge = mb;
    const info = mb.pairingInfo();
    console.log(`Matter bridge running · pairing code ${info.manualCode}${info.commissioned ? ` · paired with ${info.fabrics.map(f => f.label || f.vendor).join(', ')}` : ''}`);
    hub.services.push({
      id: 'matter-bridge', name: 'Matter bridge', icon: 'hub', kind: 'Local',
      get devices() { return mb.devices.size + mb.overlays.size; },
      status: () => {
        const p = mb.pairingInfo();
        return { ok: true, note: p.commissioned ? `Paired with ${p.fabrics.map(f => f.label || f.vendor).join(', ')}` : `Not paired yet · code ${p.manualCode}` };
      },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}


// In-app setup edits integrations.json and restarts one integration at a time.
const setup = new IntegrationsManager(hub, { path: integrationsFile, dataDir });

// Who's home (router, ping, phone automations). Always on so phone automations get per-person keys;
// the router and ping sources only run when configured.
// Helix music on any Cast or Sonos speaker: Shuffle all, Loved, playlists, stations (services/helix-music.ts).
const music = new HelixMusic(() => setup.raw('helix'));
hub.useMusic(music);
const refreshMusic = () => void music.catalog(true).then(() => hub.emit('changed')).catch(() => {});
refreshMusic();
setInterval(refreshMusic, 5 * 60_000).unref();

// Helix: once paired, Kova tells Helix Server where it is and which TV each box is on.
const helixLink = new HelixLink(hub, { helix: () => setup.raw('helix'), dataDir, port: () => Number(env.KOVA_PORT ?? 8140) });
helixLink.start();
// A Helix box going dark while its TV still shows it: suggested as an automation the owner can add.
hub.screens = () => helixLink.screens().flatMap(s => {
  const box = [...hub.reg.devices.values()].find(d => d.adapter === 'helix' && d.address === s.playerId);
  return box ? [{
    player: box.id, tv: s.tvDeviceId, input: s.helixInput, soundbar: s.soundbarDeviceId,
    ...(s.soundbarDeviceId ? { soundbarInputs: [...new Set([s.soundbarTvInput ?? 'tv', s.soundbarAdapterInput ?? 'hdmi1'])] } : {}),
  }] : [];
});
carryOverTvOff({
  done: () => !!hub.store.get('carried.tvOffWithBox'), markDone: () => hub.store.set('carried.tvOffWithBox', true),
  wasOff: () => { const v = (setup.raw('helix') as { tvOffWithBox?: unknown } | undefined)?.tvOffWithBox; return v === false || v === 'off'; },
  ideas: () => automationIdeas(hub.config.get(), hub.reg.devices, hub.screens()),
  add: a => { hub.config.update(c => { (c.automations ??= []).push({ id: `tv_off_${randomUUID().slice(0, 6)}`, ...a }); }); },
  on: fn => { hub.reg.on('devices', fn); return () => hub.reg.off('devices', fn); },
});
// The TV-off automations made before 0.7.44 get today's conditions: still on the box's input, and nobody switched it.
upgradeTvOffOnce({
  done: () => !!hub.store.get('carried.tvOffWithBox.v2'), markDone: () => hub.store.set('carried.tvOffWithBox.v2', true),
  automations: () => hub.config.get().automations ?? [], screens: () => hub.screens(), devices: () => hub.reg.devices,
  save: a => { hub.config.update(c => { c.automations = (c.automations ?? []).map(x => x.id === a.id ? a : x); }); },
  on: fn => { hub.reg.on('devices', fn); return () => hub.reg.off('devices', fn); },
});
// The doorbell on the TV: a card with its snapshot on every Helix screen that's on.
const snapLinks = new SnapLinks();
const screenNotices = new ScreenNotices(hub, { links: snapLinks, kovaUrl: () => helixLink.kovaUrl() });
screenNotices.start();
hub.services.push({ id: 'helix-link', name: 'Helix TVs', icon: 'tv', kind: 'Local', get devices() { return helixLink.screens().length; }, status: () => helixLink.status() ?? { ok: true, note: 'Pair with Helix to turn TVs on from Helix' } });

// Warden: Kova shares its devices, people, house mode and plugs, and restarts frozen equipment when Warden asks.
const wardenLink = new WardenLink(hub, { warden: () => setup.raw('warden'), port: () => Number(env.KOVA_PORT ?? 8140), people: () => setup.raw('presence')?.people });
wardenLink.start();
hub.services.push({ id: 'warden-link', name: 'Kova in Warden', icon: 'router', kind: 'Local', status: () => wardenLink.status() ?? { ok: true, note: 'Pair with Warden to share Kova’s devices with it' } });

const presence = new Presence(hub, integrations?.presence ?? {}, { warden: () => setup.raw('warden'), onReport: (id, home, source) => void wardenLink.presence(id, home, source) });
presence.start();
hub.presenceVia = id => presence.coveredBy(id);
hub.services.push({ id: 'presence', name: 'Presence', icon: 'person_pin_circle', kind: 'Local', status: () => presence.status() });

// Notifications: Web Push to the phone app needs no config (VAPID keys are made on first run); ntfy when configured.
const notifier = new Notifier(hub, integrations?.notify ?? {}, { dataDir });
// Updating the hub itself, through the updater on the box (deploy/updater.sh): what's new, the Update button, overnight updates.
hub.updates = new Updates(hub, {
  dataDir, notify: n => notifier.notify(n),
  // ClickBit's release catalog (the defaults are production); the root updater reads the same from kova.env.
  catalog: { url: env.KOVA_UPDATE_URL || undefined, channel: env.KOVA_UPDATE_CHANNEL || undefined, product: env.KOVA_PRODUCT || env.CLICKBIT_PRODUCT_ID || undefined },
});
hub.updates.start();
// ClickBIT's location service (Google without a key of the home's own), signed in with the licence, once it runs.
if (env.KOVA_LOCATION_PROXY_URL) { const cat = hub.updates.catalog; hub.maps.useProxy(env.KOVA_LOCATION_PROXY_URL, () => cat.token()); }
notifier.start();
// Automations' "Notify" steps go to the same phones, and so do camera and sensor alerts.
hub.engine.automations.notify = n => notifier.notify(n);
hub.security.notify = n => notifier.notify(n);
// Cloud: Web Push is delivered by Apple's / Google's push service (and ntfy.sh unless self-hosted).
hub.services.push({ id: 'notify', name: 'Notifications', icon: 'notifications', kind: 'Cloud', status: () => notifier.status() });

// Import from Home Assistant, in the app (Import screen).
const haImport = new HaImport(hub, { dataDir, manager: setup });

// Nightly backups of the database, integrations.json, home.json and pairing folders.
const backups = new Backups({
  db: hub.store.db,
  dataDir,
  dir: env.KOVA_BACKUP_DIR ? resolve(env.KOVA_BACKUP_DIR) : undefined,
  hour: parseBackupTime(env.KOVA_BACKUP_TIME),
  keep: Number(env.KOVA_BACKUP_KEEP ?? 14) || 14,
  timezone: () => hub.config.get().timezone,
  version: KOVA_VERSION,
  log: e => hub.store.append(e),
  beforeBackup: () => hub.reg.flush(),
  onChange: () => hub.emit('changed'),
});
backups.start();
hub.services.push({ id: 'backups', name: 'Backups', icon: 'backup', kind: 'Local', status: () => backups.status() });

const jev = JevAdvisor.fromEnv(env, hub.store);
if (jev.configured) hub.services.push({ id: 'jev', name: 'Jev decisions', icon: 'psychology', kind: 'Cloud', status: () => ({ ok: true, note: 'Structured advisory decisions enabled' }) });

const app = await buildServer(hub, {
  webRoot: resolve(here, '../../web'), token: env.KOVA_TOKEN || undefined,
  homekit, matterBridge, nest: integrations?.nest, presence, helixLink, snapLinks, otaDir: env.KOVA_OTA_DIR ? resolve(env.KOVA_OTA_DIR) : resolve(here, '../../ota'), notifier, integrationsPath: integrationsFile, integrations: setup, haImport, backups,
  jev,
  // The phone app's address away from home: KOVA_REMOTE_URL, else the public URL notifications link to.
  remoteUrl: () => env.KOVA_REMOTE_URL || setup.raw('notify')?.publicUrl,
});
await app.listen({ port: Number(env.KOVA_PORT ?? 8140), host: env.KOVA_HOST ?? '0.0.0.0' });
const addr = app.server.address();
const port = typeof addr === 'object' && addr ? addr.port : Number(env.KOVA_PORT ?? 8140);
console.log(`Kova ${KOVA_VERSION} hub listening on http://localhost:${port}${demo ? ' (demo home)' : ''}`);

// Stop cleanly: no new requests, bridges down, a backup in progress finished, device
// state flushed, the database closed (which checkpoints its WAL), then the lock released.
// Each step is guarded so one failure doesn't stop the rest, and a watchdog exits if something hangs.
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping Kova…`);
  const watchdog = setTimeout(() => { console.error('Shutdown took too long; exiting.'); try { hub.reg.flush(); } catch { /* best effort */ } lock.release(); process.exit(1); }, 15_000);
  watchdog.unref();
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); } catch (err) { console.error(`Stopping ${name} failed:`, err); }
  };
  presence.stop();
  helixLink.stop();
  hub.updates?.stop();
  screenNotices.stop();
  wardenLink.stop();
  await step('web server', () => app.close());
  await step('notifications', () => notifier.stop());
  await step('Apple Home bridge', () => homekit?.stop());
  await step('Matter bridge', () => matterBridge?.stop());
  await step('aircast', () => aircast?.stop());
  await step('backups', () => backups.stop());
  await step('hub', () => hub.stop()); // flushes device state and closes kova.db
  lock.release();
  clearTimeout(watchdog);
  console.log('Kova stopped.');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
