import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, LogLevel, Network, NetworkSimulator } from '@matter/main';
import { NodeJsEnvironment } from '@matter/nodejs';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { buildServer } from '../src/api/server.ts';
import { MatterAdapter, briToLevel, DEVICE_TYPES } from '../src/adapters/matter.ts';
import { testHub } from './helpers.ts';
import {
  MatterBridge, matterKind, isBridged, matterLabel, deviceLabel, endpointId, isValidPasscode, generatePasscode, generateDiscriminator,
  fanModeFromKova, fanModeCommand, fanPercentCommand, fanState, colorState, colorCommand, causeFor, vendorName, uniqueId,
} from '../src/bridges/matter-bridge.ts';

// ------------------------------------------------------------- pure maps --

test('Matter bridge: which devices are bridged, and as what', () => {
  const d = (type: string, capabilities: string[] = [], adapter = 'tuya', id = 'x') => ({ id, type, capabilities, adapter }) as Parameters<typeof isBridged>[0];
  assert.equal(matterKind(d('light')), 'onOffLight');
  assert.equal(matterKind(d('dimmer', ['onoff', 'brightness'])), 'dimmableLight');
  assert.equal(matterKind(d('dimmer', ['onoff', 'brightness', 'colorTemp'])), 'colorTemperatureLight');
  assert.equal(matterKind(d('dimmer', ['onoff', 'brightness', 'colorTemp', 'color'])), 'extendedColorLight');
  assert.equal(matterKind(d('plug')), 'plug');
  assert.equal(matterKind(d('fan')), 'purifier');
  for (const t of ['media', 'tv', 'camera', 'sensor']) assert.equal(matterKind(d(t)), null, t);

  assert.ok(isBridged(d('light')));
  assert.ok(!isBridged(d('camera')));
  assert.ok(!isBridged(d('light', [], 'matter')), 'devices from Matter are already in those ecosystems');
  assert.ok(!isBridged(d('light', [], 'homekit')));
  assert.ok(isBridged(d('light', [], 'matter'), { adapters: [] }), 'the default exclusions can be replaced');
  assert.ok(!isBridged(d('light', [], 'tuya'), { adapters: ['tuya'] }));
  assert.ok(!isBridged(d('light', [], 'tuya', 'porch'), { devices: ['porch'] }));
});

test('Matter bridge: names, ids, passcodes', () => {
  assert.equal(deviceLabel('Lamp', 'Lounge'), 'Lounge Lamp');
  assert.equal(deviceLabel('Office light', 'Office'), 'Office light', 'no doubled room name');
  assert.equal(deviceLabel('Lamp'), 'Lamp');
  assert.equal(matterLabel('  Front   door\tPorch  '), 'Front door Porch');
  const long = matterLabel('Master bedroom ceiling light over the reading nook');
  assert.ok(long.length <= 32, long);
  assert.equal(long, 'Master bedroom ceiling light');
  assert.equal(matterLabel(''), 'Kova');

  assert.equal(endpointId('device', 'lounge_main'), 'd-lounge_main');
  assert.equal(endpointId('overlay', 'movie'), 'o-movie');
  assert.match(endpointId('device', 'demo.lamp'), /^d-demo_lamp-[0-9a-f]{6}$/);
  assert.notEqual(endpointId('device', 'a.b'), endpointId('device', 'a_b'), 'sanitising never merges two ids');
  assert.equal(endpointId('device', 'a.b'), endpointId('device', 'a.b'), 'stable');
  assert.equal(uniqueId('device', 'lamp').length, 32);
  assert.notEqual(uniqueId('device', 'movie'), uniqueId('overlay', 'movie'));

  for (const p of [0, 11111111, 22222222, 99999999, 12345678, 87654321, 100000000, 1.5, -3]) assert.ok(!isValidPasscode(p), String(p));
  for (const p of [1, 20202021, 99999998, 34970112]) assert.ok(isValidPasscode(p), String(p));
  for (let i = 0; i < 200; i++) assert.ok(isValidPasscode(generatePasscode()));
  const seq = [0, 12345678, 33333333, 20202021];
  let n = 0;
  assert.equal(generatePasscode(() => seq[n++]), 20202021, 'retries until the code is allowed');
  for (let i = 0; i < 50; i++) { const x = generateDiscriminator(); assert.ok(x >= 0 && x <= 4095); }
});

test('Matter bridge: fan, colour and vendor conversions', () => {
  assert.equal(fanModeFromKova({ on: false, mode: 'Auto' }), 0);
  assert.equal(fanModeFromKova({ on: true, mode: 'Auto' }), 5);
  assert.equal(fanModeFromKova({ on: true, mode: 'Sleep' }), 1);
  assert.equal(fanModeFromKova({ on: true, mode: 'Manual' }), 3);
  assert.deepEqual(fanModeCommand(0), { on: false });
  assert.deepEqual(fanModeCommand(5), { on: true, mode: 'Auto' });
  assert.deepEqual(fanModeCommand(1), { on: true, mode: 'Sleep' });
  assert.deepEqual(fanModeCommand(2), { on: true, mode: 'Manual' });
  assert.deepEqual(fanModeCommand(4), { on: true });
  assert.deepEqual(fanPercentCommand(0), { on: false });
  assert.deepEqual(fanPercentCommand(20), { on: true, mode: 'Sleep' });
  assert.deepEqual(fanPercentCommand(80), { on: true, mode: 'Manual' });
  assert.equal(fanPercentCommand(null), null);
  assert.deepEqual(fanState({ on: true, mode: 'Auto' }), { fanMode: 5, percentSetting: null, percentCurrent: 50 });
  assert.deepEqual(fanState({ on: false }), { fanMode: 0, percentSetting: 0, percentCurrent: 0 });
  // Every Kova state survives a round trip through the fan mode.
  for (const st of [{ on: false }, { on: true, mode: 'Auto' }, { on: true, mode: 'Sleep' }, { on: true, mode: 'Manual' }]) {
    const back = fanModeCommand(fanModeFromKova(st));
    assert.equal(back.on, st.on);
    if (st.on) assert.equal(back.mode, st.mode);
  }

  assert.deepEqual(colorState({ k: 2700, color: null }, true), { colorMode: 2, enhancedColorMode: 2, colorTemperatureMireds: 370 });
  assert.deepEqual(colorState({ k: 9000 }, false), { colorMode: 2, enhancedColorMode: 2, colorTemperatureMireds: 153 }, 'clamped to the advertised range');
  const red = colorState({ k: null, color: '#ff0000' }, true);
  assert.equal(red.colorMode, 0);
  assert.equal(red.currentHue, 0);
  assert.equal(red.currentSaturation, 254);
  assert.ok(red.currentX! > 0.63 * 65536);
  assert.deepEqual(colorState({ color: '#ff0000' }, false), {}, 'a colour-temperature light ignores colours');
  assert.deepEqual(colorState({}, true), {});
  assert.deepEqual(colorCommand({ colorMode: 2, colorTemperatureMireds: 370 }, true), { k: 2700, color: null });
  assert.deepEqual(colorCommand({ colorMode: 2, colorTemperatureMireds: 400 }, false), { k: 2500 });
  assert.deepEqual(colorCommand({ colorMode: 0, currentHue: 169, currentSaturation: 254 }, true), { color: '#0002ff', k: null }, 'within the 254-step hue resolution');
  assert.equal(colorCommand({ colorMode: 0, currentHue: 169, currentSaturation: 254 }, false), null);
  assert.equal(colorCommand({ colorMode: 1, currentX: 41942, currentY: 21626 }, true)!.color, '#ff0000');

  assert.equal(vendorName(0x6006), 'Google');
  assert.equal(vendorName(0xfff1), 'Test vendor');
  assert.equal(vendorName(0x1234), '0x1234');
  assert.equal(causeFor(0x6006).label, 'Google Home');
  assert.equal(causeFor(0x1349).label, 'Apple Home');
  assert.equal(causeFor(0x1217).label, 'Alexa');
  assert.equal(causeFor(0xfff1).label, 'Google Home');
  assert.equal(causeFor().kind, 'user');
});

// ----------------------------------------------------------- integration --

// No IPv6 in the sandbox: both nodes run on matter.js's NetworkSimulator (see matter.test.ts).
Logger.level = LogLevel.WARN;

function simEnv(sim: NetworkSimulator, host: number | MockHost, dir: string) {
  const env = NodeJsEnvironment();
  env.vars.set('storage.path', dir);
  env.vars.set('runtime.signals', false);
  env.vars.set('runtime.exitcode', false);
  env.set(Network, typeof host === 'number' ? sim.addHost(host) : host);
  return env;
}
type MockHost = ReturnType<NetworkSimulator['addHost']>;

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
};

interface ControllerTarget { node: { endpoints: { for(n: number): { maybeStateOf(c: string): Record<string, unknown> | undefined } } }; endpoint: number }

test('Matter bridge: Kova\'s own controller commissions it, controls devices and overlays, follows changes, and it survives a restart', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kova-matter-bridge-'));
  const sim = new NetworkSimulator();
  const { hub, dev } = await testHub(12);
  // A device Kova got from a Matter controller: already in Google Home, so not bridged again.
  hub.reg.devices.set('matter_9_1', {
    id: 'matter_9_1', name: 'Hue bulb', room: 'lounge', type: 'light', capabilities: ['onoff'], adapter: 'matter',
    integration: 'Matter', address: '9/1', state: { on: false },
  });
  const bridgeDir = join(root, 'bridge');
  const bridgeHost = sim.addHost(30);
  let bridge = new MatterBridge(hub, { storageDir: bridgeDir, environment: simEnv(sim, bridgeHost, bridgeDir), exclude: { adapters: ['matter', 'homekit'], devices: ['garage_light'] } });
  const ctlDir = join(root, 'controller');
  const store = new Store(':memory:');
  let reg = new Registry(store);
  let matter = new MatterAdapter({ storageDir: ctlDir, environment: simEnv(sim, 1, ctlDir), transitionTenths: 0, commandTimeoutMs: 5000 });
  try {
    await bridge.start();
    // 19 exposable devices less the excluded garage light, plus 6 overlays.
    assert.equal(bridge.devices.size, 18);
    assert.equal(bridge.overlays.size, 6);
    assert.ok(!bridge.devices.has('matter_9_1'), 'devices from the Matter adapter are not bridged');
    assert.ok(!bridge.devices.has('garage_light'), 'excluded device');
    assert.ok(!bridge.devices.has('living_display') && !bridge.devices.has('office_cam') && !bridge.devices.has('solar_inverter'));
    const saved = JSON.parse(readFileSync(join(bridgeDir, 'kova-matter-bridge.json'), 'utf8'));
    assert.ok(isValidPasscode(saved.passcode));
    const info = bridge.pairingInfo();
    assert.match(info.manualCode, /^\d{11}$/);
    assert.match(info.qrCode, /^MT:/);
    assert.equal(info.commissioned, false);
    assert.deepEqual(info.fabrics, []);

    // Commission the bridge with Kova's own controller, as Google Home would.
    await reg.addAdapter(matter);
    const added = await matter.commission(info.manualCode);
    const nodeId = added[0].address.split('/')[0];
    const epOf = (id: string) => (bridge.devices.get(id) ?? bridge.overlays.get(id))!.endpoint.number!;
    const ctlId = (id: string) => `matter_${nodeId}_${epOf(id)}`;
    // Lights and plugs (and the overlay switches, which are plug-in units) come through the controller; the purifiers are
    // Matter air purifiers, which Kova's controller doesn't support yet.
    assert.equal(added.length, 16 + 6);
    assert.equal(reg.get(ctlId('lounge_main'))?.type, 'light');
    assert.equal(reg.get(ctlId('lamp'))?.type, 'dimmer');
    assert.deepEqual(reg.get(ctlId('lamp'))?.capabilities, ['onoff', 'brightness', 'colorTemp', 'color']);
    assert.deepEqual(reg.get(ctlId('office_strip'))?.capabilities, ['onoff', 'brightness']);
    assert.equal(reg.get(ctlId('office_plug'))?.type, 'plug');
    assert.equal(reg.get(ctlId('movie'))?.type, 'plug');

    // What the controller sees on each bridged endpoint: names, device types, reachability.
    const client = () => (matter as unknown as { targets: Map<string, ControllerTarget> }).targets.get(ctlId('lamp'))!.node;
    const remote = (id: string, cluster: string) => client().endpoints.for(epOf(id)).maybeStateOf(cluster) as Record<string, unknown>;
    const types = (id: string) => (remote(id, 'descriptor').deviceTypeList as { deviceType: number }[]).map(t => Number(t.deviceType));
    assert.equal(remote('lamp', 'bridgedDeviceBasicInformation').nodeLabel, 'Lounge Lamp');
    assert.equal(remote('front_1', 'bridgedDeviceBasicInformation').nodeLabel, 'Front door Porch light');
    assert.equal(remote('movie', 'bridgedDeviceBasicInformation').nodeLabel, 'Kova Movie');
    assert.equal(remote('lamp', 'bridgedDeviceBasicInformation').reachable, true);
    assert.ok(types('lamp').includes(DEVICE_TYPES.extendedColorLight) && types('lamp').includes(0x13), 'extended colour light, bridged node');
    assert.ok(types('office_strip').includes(DEVICE_TYPES.dimmableLight));
    assert.ok(types('dining').includes(DEVICE_TYPES.onOffLight));
    assert.ok(types('office_plug').includes(DEVICE_TYPES.onOffPlugInUnit));
    assert.ok(types('lounge_purifier').includes(0x2d), 'air purifier');
    assert.equal((remote('lounge_purifier', 'fanControl')).fanMode, 5, 'purifier in Auto');

    const fabrics = bridge.pairingInfo();
    assert.equal(fabrics.commissioned, true);
    assert.deepEqual(fabrics.fabrics, [{ label: 'Kova', vendor: 'Test vendor' }]);

    // Controller → Kova, through the engine, logged with the controller as the cause.
    const you = { kind: 'user' as const, label: 'You' };
    await reg.command(ctlId('dining'), { on: true }, you);
    await until('dining on in Kova', () => dev('dining').on === true);
    const byGoogle = () => hub.store.between(0, Number.MAX_SAFE_INTEGER, 'state').filter(e => e.cause?.label === 'Google Home');
    assert.ok(byGoogle().some(e => e.device === 'dining'), 'logged as done in Google Home');
    await reg.command(ctlId('lamp'), { on: true, bri: 42 }, you);
    await until('lamp at 42%', () => dev('lamp').on === true && dev('lamp').bri === 42);
    await reg.command(ctlId('lamp'), { k: 2500 }, you);
    await until('lamp at 2500K', () => dev('lamp').k === 2500);
    await reg.command(ctlId('lamp'), { color: '#ff0000' }, you);
    await until('lamp red', () => dev('lamp').color === '#ff0000' && dev('lamp').k === null);
    await reg.command(ctlId('office_plug'), { on: false }, you);
    await until('plug off', () => dev('office_plug').on === false);

    // Kova → controller: a change made in Kova (or at the device) reaches the controller.
    await hub.engine.command('lamp', { bri: 64, k: 3000, color: null }, you);
    await until('controller sees 64%', () => reg.get(ctlId('lamp'))!.state.bri === 64);
    await until('controller sees 3000K', () => reg.get(ctlId('lamp'))!.state.k === 3000);
    await hub.engine.command('kitchen_island', { on: true }, you);
    await until('controller sees the island on', () => reg.get(ctlId('kitchen_island'))!.state.on === true);
    await hub.engine.command('lounge_purifier', { mode: 'Sleep' }, you);
    await until('controller sees the purifier on Low', () => remote('lounge_purifier', 'fanControl').fanMode === 1);
    hub.reg.devices.get('dining')!.state.online = false;
    hub.reg.emit('measure');
    await until('dining unreachable', () => remote('dining', 'bridgedDeviceBasicInformation').reachable === false);
    hub.reg.devices.get('dining')!.state.online = true;
    hub.reg.emit('measure');

    // No echo: Kova's own pushes are not read back as controller commands.
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!byGoogle().some(e => e.device === 'kitchen_island'), 'the island was changed in Kova, not in Google Home');
    assert.equal(dev('lamp').bri, 64);

    // Overlay switches start and end overlays.
    await reg.command(ctlId('movie'), { on: true }, you);
    await until('movie started', () => hub.engine.overlay?.id === 'movie');
    assert.equal(dev('lamp').bri, 8);
    await until('controller sees the lamp dim', () => reg.get(ctlId('lamp'))!.state.bri === 8);
    await hub.engine.startOverlay('party');
    await until('movie switch off, party on', () => reg.get(ctlId('movie'))!.state.on === false && reg.get(ctlId('party'))!.state.on === true);
    await reg.command(ctlId('party'), { on: false }, you);
    await until('party ended', () => hub.engine.overlay === null);

    // A device leaving Kova leaves the bridge, and comes back on the same endpoint number.
    const officeEp = epOf('office_light');
    const office = hub.reg.devices.get('office_light')!;
    hub.reg.devices.delete('office_light');
    hub.reg.emit('devices');
    await bridge.reconcile();
    assert.ok(!bridge.devices.has('office_light'));
    hub.reg.devices.set('office_light', office);
    hub.reg.emit('devices');
    await bridge.reconcile();
    assert.equal(epOf('office_light'), officeEp, 'stable endpoint number');

    // The API serves the pairing info.
    const webRoot = join(import.meta.dirname, '../../web');
    const app = await buildServer(hub, { webRoot, matterBridge: bridge });
    const r = (await app.inject({ url: '/api/integrations/matter-bridge' })).json();
    assert.deepEqual(r, { enabled: true, ...bridge.pairingInfo() });
    await app.close();
    const off = await buildServer(hub, { webRoot });
    assert.deepEqual((await off.inject({ url: '/api/integrations/matter-bridge' })).json(), { enabled: false });
    await off.close();

    // Restart: same passcode, still commissioned, same endpoints, and the controller reconnects.
    const lampEp = epOf('lamp');
    await bridge.stop();
    bridge = new MatterBridge(hub, { storageDir: bridgeDir, environment: simEnv(sim, bridgeHost, bridgeDir), exclude: { devices: ['garage_light'] } });
    await bridge.start();
    assert.equal(bridge.identity.passcode, saved.passcode);
    assert.equal(bridge.pairingInfo().manualCode, info.manualCode);
    assert.equal(bridge.pairingInfo().commissioned, true, 'fabric persisted');
    assert.equal(bridge.pairingInfo().fabrics.length, 1);
    assert.equal(epOf('lamp'), lampEp);
    // The controller's session resumes: its commands work straight away.
    await reg.command(ctlId('lamp'), { bri: 16 }, you);
    await until('controller controls after the restart', () => dev('lamp').bri === 16, 10_000);
    // Its subscription only comes back at its own liveness timeout (matter.js: ~1m 46s), so restart it too to see
    // reports flow again: that also shows both ends kept the fabric.
    await reg.stop();
    reg = new Registry(new Store(':memory:'));
    matter = new MatterAdapter({ storageDir: ctlDir, environment: simEnv(sim, 2, ctlDir), transitionTenths: 0, commandTimeoutMs: 5000 });
    await reg.addAdapter(matter);
    await until('controller subscribed again', () => reg.get(ctlId('dining'))?.state.online === true, 20_000);
    await hub.engine.command('dining', { on: false }, you);
    await until('controller sees a change after the restart', () => reg.get(ctlId('dining'))!.state.on === false, 10_000);
    assert.equal(remote('lamp', 'levelControl').currentLevel, briToLevel(16));
  } finally {
    await reg.stop().catch(() => {});
    await bridge.stop().catch(() => {});
    await hub.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Matter bridge: rejects an invalid passcode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-matter-bridge-'));
  const { hub } = await testHub(12);
  try {
    assert.throws(() => new MatterBridge(hub, { storageDir: dir, passcode: 12345678 }), /Invalid Matter passcode/);
    assert.throws(() => new MatterBridge(hub, { storageDir: dir, discriminator: 5000 }), /Invalid Matter discriminator/);
    const b = new MatterBridge(hub, { storageDir: dir, passcode: 20202021, discriminator: 3840 });
    assert.deepEqual([b.identity.passcode, b.identity.discriminator], [20202021, 3840]);
    assert.deepEqual(b.pairingInfo(), { manualCode: '', qrCode: '', commissioned: false, fabrics: [] }, 'not started');
  } finally {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
