import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, LogLevel, Network, NetworkSimulator, ServerNode, VendorId } from '@matter/main';
import { NodeJsEnvironment } from '@matter/nodejs';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { ExtendedColorLightDevice } from '@matter/main/devices/extended-color-light';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { ColorControlServer } from '@matter/main/behaviors/color-control';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { buildServer } from '../src/api/server.ts';
import { testHub } from './helpers.ts';
import type { DeviceInfo } from '../src/adapters/sdk.ts';
import {
  MatterAdapter, briToLevel, levelToBri, kelvinToMireds, miredsToKelvin, hexToHueSat, hueSatToHex, hexToXy, xyToHex, classify, DEVICE_TYPES,
} from '../src/adapters/matter.ts';

// ------------------------------------------------------------- pure maps --

test('Matter mapping: brightness ↔ level', () => {
  assert.equal(briToLevel(0), 1);
  assert.equal(briToLevel(100), 254);
  assert.equal(briToLevel(50), 128);
  assert.equal(briToLevel(150), 254);
  assert.equal(briToLevel(10, 40, 200), 40, 'clamped to the device minimum');
  assert.equal(briToLevel(100, 1, 200), 200, 'clamped to the device maximum');
  assert.equal(levelToBri(254), 100);
  assert.equal(levelToBri(1), 1, 'an on light never reads 0%');
  for (const b of [1, 5, 16, 31, 50, 78, 99, 100]) assert.equal(levelToBri(briToLevel(b)), b, `round trip ${b}%`);
});

test('Matter mapping: Kelvin ↔ mireds', () => {
  assert.equal(kelvinToMireds(2000), 500);
  assert.equal(kelvinToMireds(4000), 250);
  assert.equal(kelvinToMireds(6500, 153, 500), 154);
  assert.equal(kelvinToMireds(1800, 153, 454), 454, 'clamped to the warmest the lamp can do');
  assert.equal(kelvinToMireds(10000, 153, 454), 153, 'clamped to the coolest');
  assert.equal(miredsToKelvin(500), 2000);
  for (const k of [2000, 2200, 2500, 2700, 3000, 4000, 5000]) assert.equal(miredsToKelvin(kelvinToMireds(k)), k, `round trip ${k}K`);
});

test('Matter mapping: colour ↔ hue/saturation and xy', () => {
  assert.deepEqual(hexToHueSat('#ff0000'), { hue: 0, saturation: 254 });
  assert.deepEqual(hexToHueSat('#00ff00'), { hue: 85, saturation: 254 });
  assert.deepEqual(hexToHueSat('#0000ff'), { hue: 169, saturation: 254 });
  assert.deepEqual(hexToHueSat('#ffffff'), { hue: 0, saturation: 0 });
  assert.equal(hueSatToHex(0, 254), '#ff0000');
  assert.equal(hueSatToHex(0, 0), '#ffffff');
  const { hue, saturation } = hexToHueSat('#ff8000');
  assert.equal(hueSatToHex(hue, saturation), '#ff7e00', 'within the 254-step hue resolution');

  // sRGB primaries land on their CIE xy points.
  const red = hexToXy('#ff0000');
  assert.ok(Math.abs(red.colorX / 65536 - 0.64) < 0.005 && Math.abs(red.colorY / 65536 - 0.33) < 0.005, JSON.stringify(red));
  const white = hexToXy('#ffffff');
  assert.ok(Math.abs(white.colorX / 65536 - 0.3127) < 0.005 && Math.abs(white.colorY / 65536 - 0.329) < 0.005);
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#ff8000']) {
    const back = xyToHex(hexToXy(hex).colorX, hexToXy(hex).colorY);
    const [a, b] = [hex, back].map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 3), `xy round trip ${hex} → ${back}`);
  }
  assert.throws(() => hexToHueSat('red'), /Not a colour/);
});

test('Matter mapping: endpoints → Kova device types', () => {
  const base = { onOff: true, level: false, colorTemp: false, hueSat: false, xy: false };
  assert.deepEqual(classify({ ...base, deviceTypes: [DEVICE_TYPES.onOffLight] }), { type: 'light', capabilities: ['onoff'] });
  assert.deepEqual(classify({ ...base, level: true, deviceTypes: [DEVICE_TYPES.dimmableLight] }), { type: 'dimmer', capabilities: ['onoff', 'brightness'] });
  assert.deepEqual(classify({ ...base, level: true, colorTemp: true, deviceTypes: [DEVICE_TYPES.colorTemperatureLight] }), { type: 'dimmer', capabilities: ['onoff', 'brightness', 'colorTemp'] });
  assert.deepEqual(classify({ ...base, level: true, colorTemp: true, xy: true, deviceTypes: [0x13, DEVICE_TYPES.extendedColorLight] }), { type: 'dimmer', capabilities: ['onoff', 'brightness', 'colorTemp', 'color'] });
  assert.deepEqual(classify({ ...base, deviceTypes: [DEVICE_TYPES.onOffPlugInUnit] }), { type: 'plug', capabilities: ['onoff'] });
  assert.equal(classify({ ...base, deviceTypes: [0x2b] }), null, 'a fan is not a light');
  assert.equal(classify({ ...base, onOff: false, deviceTypes: [DEVICE_TYPES.onOffLight] }), null);
});

// ----------------------------------------------------------- integration --

/**
 * The sandbox this was written in has no IPv6, which matter.js needs for mDNS.
 * Both nodes therefore run on matter.js's own NetworkSimulator: real Matter
 * (PASE, CASE, mDNS discovery, subscriptions) over an in-process network.
 */
Logger.level = LogLevel.WARN;

function simEnv(sim: NetworkSimulator, host: number, dir: string) {
  const env = NodeJsEnvironment();
  env.vars.set('storage.path', dir);
  env.vars.set('runtime.signals', false);
  env.vars.set('runtime.exitcode', false);
  env.set(Network, sim.addHost(host));
  return env;
}

async function virtualLight(sim: NetworkSimulator, dir: string) {
  const environment = simEnv(sim, 20, dir);
  const node = await ServerNode.create({
    environment,
    id: 'virtual-light',
    network: { port: 5540 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    productDescription: { name: 'Kova test light', deviceType: DimmableLightDevice.deviceType },
    basicInformation: { vendorName: 'Kova', vendorId: VendorId(0xfff1), productId: 0x8000, productName: 'Test light', nodeLabel: 'Desk lamp', serialNumber: 'kova-1', uniqueId: 'kova-1' },
  });
  const lamp = await node.add(DimmableLightDevice, { id: 'lamp' });
  const bulb = await node.add(ExtendedColorLightDevice.with(ColorControlServer.with('HueSaturation', 'Xy', 'ColorTemperature')), {
    id: 'bulb',
    colorControl: { colorTempPhysicalMinMireds: 153, colorTempPhysicalMaxMireds: 454, colorTemperatureMireds: 250, coupleColorTempToLevelMinMireds: 153, colorMode: 2 },
  });
  const plug = await node.add(OnOffPlugInUnitDevice, { id: 'plug' });
  await node.start();
  return { node, lamp, bulb, plug, code: node.state.commissioning.pairingCodes.manualPairingCode };
}

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
};

test('Matter: commission a virtual light, control it, follow changes, reconnect after restart', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kova-matter-'));
  const sim = new NetworkSimulator();
  const dev = await virtualLight(sim, join(root, 'device'));
  const storageDir = join(root, 'controller');
  const store = new Store(':memory:');
  let reg = new Registry(store);
  let matter = new MatterAdapter({ storageDir, environment: simEnv(sim, 1, storageDir), transitionTenths: 0, commandTimeoutMs: 5000 });
  let reg2: Registry | undefined;
  try {
    await reg.addAdapter(matter);
    assert.equal(matter.status().ok, true);
    assert.match(matter.status().note!, /No devices/);

    await assert.rejects(matter.commission('1234'), /11 or 21 digits/);
    const added = await matter.commission(dev.code, { room: 'study' });
    assert.equal(added.length, 3);
    const nodeId = added[0].address.split('/')[0];
    const lampId = `matter_${nodeId}_1`, bulbId = `matter_${nodeId}_2`, plugId = `matter_${nodeId}_3`;

    const lamp = reg.get(lampId)!;
    assert.ok(lamp, 'dimmer announced');
    assert.equal(lamp.type, 'dimmer');
    assert.deepEqual(lamp.capabilities, ['onoff', 'brightness']);
    assert.equal(lamp.room, 'study');
    assert.equal(lamp.integration, 'Matter');
    assert.equal(lamp.address, `${nodeId}/1`);
    assert.equal(lamp.name, 'Desk lamp 1');
    assert.equal(lamp.state.on, false);
    assert.deepEqual(reg.get(bulbId)!.capabilities, ['onoff', 'brightness', 'colorTemp', 'color']);
    assert.equal(reg.get(bulbId)!.state.k, 4000);
    assert.equal(reg.get(plugId)!.type, 'plug');
    assert.equal(matter.status().note, '3 devices');
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, 'kova-nodes.json'), 'utf8')), { [nodeId]: { room: 'study' } });

    // Kova → device.
    await reg.command(lampId, { on: true, bri: 50 }, { kind: 'user', label: 'You' });
    await until('lamp on at 50%', () => dev.lamp.state.onOff.onOff === true && dev.lamp.state.levelControl.currentLevel === 128);
    assert.equal(reg.get(lampId)!.state.bri, 50);

    await reg.command(bulbId, { on: true, bri: 78, k: 2700 }, { kind: 'user', label: 'You' });
    await until('bulb warm', () => dev.bulb.state.colorControl.colorTemperatureMireds === 370 && dev.bulb.state.onOff.onOff === true);
    await reg.command(bulbId, { color: '#ff0000', k: null }, { kind: 'user', label: 'You' });
    await until('bulb red', () => dev.bulb.state.colorControl.colorMode === 0 && dev.bulb.state.colorControl.currentHue === 0 && dev.bulb.state.colorControl.currentSaturation === 254);

    await reg.command(plugId, { on: true }, { kind: 'user', label: 'You' });
    await until('plug on', () => dev.plug.state.onOff.onOff === true);
    await reg.command(plugId, { on: false }, { kind: 'user', label: 'You' });
    await until('plug off', () => dev.plug.state.onOff.onOff === false);

    // Echoes of Kova's own commands are not logged as changes made elsewhere.
    await new Promise(r => setTimeout(r, 600));
    const fromDevice = () => store.between(0, Number.MAX_SAFE_INTEGER, 'state').filter(e => e.cause?.kind === 'device');
    assert.equal(fromDevice().length, 0, JSON.stringify(fromDevice()));
    assert.equal(reg.get(bulbId)!.state.color, '#ff0000');

    // Device → Kova: a change made at the light (or in another app) is reported.
    await dev.lamp.set({ levelControl: { currentLevel: 254 } });
    await until('brightness report', () => reg.get(lampId)!.state.bri === 100);
    await dev.lamp.set({ onOff: { onOff: false } });
    await until('off report', () => reg.get(lampId)!.state.on === false);
    assert.ok(fromDevice().some(e => e.device === lampId), 'logged as changed at the device');

    // Restart: the controller reconnects to the node from storage and re-announces it.
    await reg.stop();
    reg2 = new Registry(new Store(':memory:'));
    matter = new MatterAdapter({ storageDir, environment: simEnv(sim, 2, storageDir), transitionTenths: 0, commandTimeoutMs: 2000 });
    await reg2.addAdapter(matter);
    assert.equal(reg2.get(lampId)?.room, 'study', 'room kept across restarts');
    await until('subscription back', () => reg2!.get(lampId)!.state.online === true, 20_000);
    await dev.lamp.set({ onOff: { onOff: true } });
    await until('report after restart', () => reg2!.get(lampId)!.state.on === true, 10_000);
    await reg2.command(lampId, { bri: 16 }, { kind: 'user', label: 'You' });
    await until('command after restart', () => dev.lamp.state.levelControl.currentLevel === briToLevel(16));

    // Unreachable device (its packets are dropped, like a bulb switched off at the wall):
    // commands fail with a clear error instead of hanging, and stop() still shuts down cleanly.
    const deviceIps = ['abcd::14', '10.10.10.20'];
    sim.router.intercept((packet, route) => { if (!deviceIps.includes(packet.sourceAddress) && !deviceIps.includes(packet.destAddress)) route(packet); });
    await assert.rejects(reg2.command(lampId, { bri: 90 }, { kind: 'user', label: 'You' }), /Matter: .*didn't respond/);

    // Removing an unreachable node falls back to forgetting it locally.
    await matter.remove(nodeId);
    assert.equal(matter.status().note, 'No devices yet. Add one with its pairing code.');
    assert.equal(reg2.get(lampId)!.state.online, false);
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, 'kova-nodes.json'), 'utf8')), {});
    await assert.rejects(matter.remove(nodeId), /Unknown Matter node/);
  } finally {
    await reg2?.stop();
    await reg.stop().catch(() => {});
    await dev.node.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Matter: POST /api/integrations/matter/commission', async () => {
  const { hub } = await testHub();
  const app = await buildServer(hub, { webRoot: join(import.meta.dirname, '../../web') });
  const post = (payload: object) => app.inject({ method: 'POST', url: '/api/integrations/matter/commission', payload });
  try {
    let r = await post({ code: '34970112332' });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /KOVA_MATTER/);

    // A stand-in adapter (not started) so the route can be exercised without a network.
    const calls: unknown[][] = [];
    class StubMatter extends MatterAdapter {
      override async commission(code: string, opts?: { room?: string; name?: string }): Promise<DeviceInfo[]> {
        calls.push([code, opts]);
        if (code === 'bad') throw new Error("Couldn't add the Matter device: timed out");
        return [{ id: 'matter_1_1', name: 'Lamp', room: 'study', type: 'dimmer', capabilities: ['onoff', 'brightness'], integration: 'Matter', address: '1/1' }];
      }
    }
    hub.reg.adapters.set('matter', new StubMatter({ storageDir: join(tmpdir(), 'unused') }));

    r = await post({});
    assert.equal(r.statusCode, 400);
    r = await post({ code: '3497-011-2332', room: 'study', name: 'Lamp' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().ok, true);
    assert.equal(r.json().devices[0].id, 'matter_1_1');
    assert.deepEqual(calls[0], ['3497-011-2332', { room: 'study', name: 'Lamp' }]);
    r = await post({ code: 'bad' });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /timed out/);
  } finally {
    await app.close();
    hub.reg.adapters.delete('matter');
    await hub.stop();
  }
});
