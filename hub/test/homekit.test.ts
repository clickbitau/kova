import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accessory, Categories, Characteristic, Service, uuid } from 'hap-nodejs';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import {
  HomeKitBridge, kelvinToMired, miredToKelvin, hsToHex, hexToHs, toHomeKitBrightness, brightnessCommand,
  fanModeToTarget, targetToFanMode, generatePincode, isValidPincode, setupURI, homeKitName, deviceUUID,
  roomAcUUID, heaterCoolerTarget, heaterCoolerMode, heaterCoolerCurrent,
} from '../src/bridges/homekit.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

test('HomeKit conversions: mireds, colour, brightness, purifier mode', () => {
  assert.equal(kelvinToMired(2700), 370);
  assert.equal(kelvinToMired(6500), 154);
  assert.equal(kelvinToMired(1800), 500); // clamped
  assert.equal(kelvinToMired(9000), 140); // clamped
  assert.equal(miredToKelvin(370), 2700);
  assert.equal(miredToKelvin(140), 7140);
  assert.equal(miredToKelvin(600), 2000); // clamped to 500 first
  assert.equal(miredToKelvin(kelvinToMired(3000)), 3000);

  assert.equal(hsToHex(0, 100), '#ff0000');
  assert.equal(hsToHex(120, 100), '#00ff00');
  assert.equal(hsToHex(240, 100), '#0000ff');
  assert.equal(hsToHex(0, 0), '#ffffff');
  assert.deepEqual(hexToHs('#ff0000'), { h: 0, s: 100 });
  assert.deepEqual(hexToHs('#0096ff'), { h: 205, s: 100 });
  assert.deepEqual(hexToHs('#ffffff'), { h: 0, s: 0 });
  assert.deepEqual(hexToHs('nope'), { h: 0, s: 0 });
  // Integer hue/saturation round-trips to within a few steps per channel.
  const { h, s } = hexToHs('#ff8c64');
  const back = hsToHex(h, s);
  for (const i of [1, 3, 5]) assert.ok(Math.abs(parseInt(back.slice(i, i + 2), 16) - parseInt('#ff8c64'.slice(i, i + 2), 16)) <= 3, back);

  assert.equal(toHomeKitBrightness(null), 100);
  assert.equal(toHomeKitBrightness(31.6), 32);
  assert.deepEqual(brightnessCommand(0), { on: false });
  assert.deepEqual(brightnessCommand(40), { on: true, bri: 40 });

  const T = Characteristic.TargetAirPurifierState;
  assert.equal(fanModeToTarget('Auto'), T.AUTO);
  assert.equal(fanModeToTarget('Sleep'), T.MANUAL);
  assert.equal(targetToFanMode(T.AUTO, 'Sleep'), 'Auto');
  assert.equal(targetToFanMode(T.MANUAL, 'Turbo'), 'Turbo');
  assert.equal(targetToFanMode(T.MANUAL, 'Auto'), 'Sleep');

  assert.equal(homeKitName('Front door · Porch light!'), 'Front door Porch light');
});

test('HomeKit setup codes and QR payload', () => {
  for (let i = 0; i < 200; i++) assert.ok(isValidPincode(generatePincode()));
  assert.ok(!isValidPincode('123-45-678'));
  assert.ok(!isValidPincode('111-11-111'));
  assert.ok(!isValidPincode('12345678'));
  // A generator stuck on a trivial code keeps trying.
  const digits = [...'1234567803145154'].map(Number);
  let n = 0;
  assert.equal(generatePincode(() => digits[n++]), '031-45-154');

  // Same payload hap-nodejs produces for a published accessory.
  for (const [pin, cat] of [['031-45-154', Categories.BRIDGE], ['482-91-736', Categories.LIGHTBULB]] as const) {
    const a = new Accessory('x', uuid.generate(pin));
    Object.assign(a, { _accessoryInfo: { pincode: pin, category: cat }, _setupID: 'AB12' });
    assert.equal(setupURI(pin, 'AB12', cat), a.setupURI());
  }
});

test('HomeKit bridge maps Kova devices and overlays both ways', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-homekit-'));
  const { hub, dev } = await testHub(12);
  const hk = new HomeKitBridge(hub, { storageDir: dir });
  try {
    // 19 exposable devices (13 lights, 3 dimmers, a plug, 2 purifiers) + 6 overlays; no media, TVs or cameras.
    assert.equal(hk.devices.size, 19);
    assert.equal(hk.overlays.size, 6);
    assert.equal(hk.bridge.bridgedAccessories.length, 25);
    assert.ok(!hk.devices.has('living_display') && !hk.devices.has('doorbell'));

    const lamp = hk.devices.get('lamp')!.accessory;
    assert.equal(lamp.UUID, deviceUUID('lamp'));
    assert.equal(lamp.displayName, 'Lounge Lamp');
    const bulb = lamp.getService(Service.Lightbulb)!;
    const on = bulb.getCharacteristic(Characteristic.On);
    const bri = bulb.getCharacteristic(Characteristic.Brightness);
    assert.ok(bulb.testCharacteristic(Characteristic.ColorTemperature));
    assert.ok(bulb.testCharacteristic(Characteristic.Hue));
    assert.ok(!hk.devices.get('tv_backlight')!.accessory.getService(Service.Lightbulb)!.testCharacteristic(Characteristic.ColorTemperature));
    assert.ok(!hk.devices.get('dining')!.accessory.getService(Service.Lightbulb)!.testCharacteristic(Characteristic.Brightness));

    // Home app → Kova.
    await on.handleSetRequest(true);
    assert.equal(dev('lamp').on, true);
    await bri.handleSetRequest(42);
    assert.equal(dev('lamp').bri, 42);
    await bulb.getCharacteristic(Characteristic.ColorTemperature).handleSetRequest(400);
    assert.equal(dev('lamp').k, 2500);
    await bulb.getCharacteristic(Characteristic.Saturation).handleSetRequest(100);
    await bulb.getCharacteristic(Characteristic.Hue).handleSetRequest(240);
    assert.equal(dev('lamp').color, '#0000ff');
    assert.equal(dev('lamp').k, null);
    assert.equal(await bri.handleGetRequest(), 42);

    // Kova → Home app.
    await hub.engine.command('lamp', { bri: 64 }, { kind: 'user', label: 'You' });
    assert.equal(bri.value, 64);
    await hub.engine.command('dining', { on: true }, { kind: 'user', label: 'You' });
    assert.equal(hk.devices.get('dining')!.accessory.getService(Service.Lightbulb)!.getCharacteristic(Characteristic.On).value, true);

    // Purifier.
    const pur = hk.devices.get('lounge_purifier')!.accessory.getService(Service.AirPurifier)!;
    const target = pur.getCharacteristic(Characteristic.TargetAirPurifierState);
    assert.equal(target.value, Characteristic.TargetAirPurifierState.AUTO);
    await target.handleSetRequest(Characteristic.TargetAirPurifierState.MANUAL);
    assert.equal(dev('lounge_purifier').mode, 'Sleep');
    await pur.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.INACTIVE);
    assert.equal(dev('lounge_purifier').on, false);
    assert.equal(pur.getCharacteristic(Characteristic.CurrentAirPurifierState).value, Characteristic.CurrentAirPurifierState.INACTIVE);

    // Plug.
    const outlet = hk.devices.get('office_plug')!.accessory.getService(Service.Outlet)!;
    assert.equal(outlet.getCharacteristic(Characteristic.On).value, true);
    await outlet.getCharacteristic(Characteristic.On).handleSetRequest(false);
    assert.equal(dev('office_plug').on, false);

    // Movie switch starts and ends the overlay; other switches follow the engine.
    const sw = (id: string) => hk.overlays.get(id)!.accessory.getService(Service.Switch)!.getCharacteristic(Characteristic.On);
    await sw('movie').handleSetRequest(true);
    assert.equal(hub.engine.overlay?.id, 'movie');
    assert.equal(dev('lamp').bri, 8);
    assert.equal(sw('movie').value, true);
    await hub.engine.startOverlay('party');
    assert.equal(sw('movie').value, false);
    assert.equal(sw('party').value, true);
    await sw('movie').handleSetRequest(false); // not active: leaves Party alone
    assert.equal(hub.engine.overlay?.id, 'party');
    await sw('party').handleSetRequest(false);
    assert.equal(hub.engine.overlay, null);
    assert.equal(sw('party').value, false);

    // Offline devices report a communication failure instead of stale state.
    hub.reg.get('dining')!.state.online = false;
    await assert.rejects(hk.devices.get('dining')!.accessory.getService(Service.Lightbulb)!.getCharacteristic(Characteristic.On).handleGetRequest());

    // Devices leaving the registry leave the bridge.
    hub.reg.devices.delete('garage_light');
    hub.reg.emit('devices');
    assert.ok(!hk.devices.has('garage_light'));
    assert.equal(hk.bridge.bridgedAccessories.length, 24);

    // Pairing info is stable across restarts and served by the API.
    const info = hk.setupInfo();
    assert.ok(isValidPincode(info.pincode));
    assert.match(info.setupURI, /^X-HM:\/\/[0-9A-Z]{9}[0-9A-Z]{4}$/);
    const saved = JSON.parse(readFileSync(join(dir, 'kova-bridge.json'), 'utf8'));
    assert.equal(saved.pincode, info.pincode);
    const again = new HomeKitBridge(hub, { storageDir: dir });
    assert.deepEqual(again.setupInfo(), info);
    assert.equal(again.identity.username, hk.identity.username);
    await again.stop();

    const app = await buildServer(hub, { webRoot, homekit: hk });
    const r = (await app.inject({ url: '/api/integrations/homekit' })).json();
    assert.deepEqual(r, { enabled: true, ...info, paired: false });
    await app.close();
    const off = await buildServer(hub, { webRoot });
    assert.deepEqual((await off.inject({ url: '/api/integrations/homekit' })).json(), { enabled: false });
    await off.close();
  } finally {
    await hk.stop();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HomeKit bridge uses a given pincode and rejects trivial ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-homekit-'));
  const { hub } = await testHub(12);
  try {
    const hk = new HomeKitBridge(hub, { storageDir: dir, pincode: '031-45-154', name: 'Kova' });
    assert.equal(hk.setupInfo().pincode, '031-45-154');
    assert.equal(hk.bridge.displayName, 'Kova');
    await hk.stop();
    assert.throws(() => new HomeKitBridge(hub, { storageDir: dir, pincode: '123-45-678' }), /Invalid HomeKit pincode/);
  } finally {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HomeKit bridge: TVs as their own accessories, and no duplicates of Apple/Matter devices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-homekit-'));
  const { hub, dev } = await testHub(12);
  // Pretend the lamp came from HomeKit: it's already in Apple Home, so the bridge must leave it out.
  hub.reg.get('lamp')!.adapter = 'homekit';
  const hk = new HomeKitBridge(hub, { storageDir: dir, exclude: { devices: ['dining'] } });
  try {
    assert.ok(!hk.devices.has('lamp'), 'HomeKit-sourced device not re-exported');
    assert.ok(!hk.devices.has('dining'), 'explicitly excluded');
    assert.ok(hk.devices.has('kitchen_ceiling'));

    const tv = hk.tvs.get('bedroom_tv')!;
    assert.ok(tv, 'the TV is exposed');
    assert.ok(!hk.bridge.bridgedAccessories.includes(tv.accessory), 'TVs are published on their own, not bridged');
    assert.equal(tv.accessory.category, Categories.TELEVISION);
    const svc = tv.accessory.getService(Service.Television)!;
    await svc.getCharacteristic(Characteristic.Active).handleSetRequest(Characteristic.Active.ACTIVE);
    assert.equal(dev('bedroom_tv').on, true);
    const speaker = tv.accessory.getService(Service.TelevisionSpeaker)!;
    await speaker.getCharacteristic(Characteristic.Volume).handleSetRequest(22);
    assert.equal(dev('bedroom_tv').vol, 22);
    await speaker.getCharacteristic(Characteristic.VolumeSelector).handleSetRequest(Characteristic.VolumeSelector.INCREMENT);
    assert.equal(dev('bedroom_tv').vol, 27);
    await hub.engine.command('bedroom_tv', { on: false });
    assert.equal(svc.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE, 'Kova changes reach the Home app');
  } finally {
    await hk.stop();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HomeKit bridge: a HeaterCooler per room a zone serves, through the room-AC policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-homekit-'));
  const { hub, dev } = await testHub(12, c => { c.devices!.ducted_ac = { ...c.devices!.ducted_ac, zoneRooms: { 1: ['lounge'], 3: ['master'] } }; });
  const hk = new HomeKitBridge(hub, { storageDir: dir });
  try {
    assert.equal(heaterCoolerTarget('heat'), 1);
    assert.equal(heaterCoolerTarget('cool'), 2);
    assert.equal(heaterCoolerTarget('dry'), 0);
    assert.equal(heaterCoolerMode(2), 'cool');
    assert.equal(heaterCoolerCurrent(false, 'cool'), 0);
    assert.equal(heaterCoolerCurrent(true, 'heat'), 2);
    assert.equal(heaterCoolerCurrent(true, 'fan'), 1);

    assert.deepEqual(hk.roomAcList(), [{ room: 'lounge', label: 'Lounge AC' }, { room: 'master', label: 'Master bed AC' }]);
    const acc = hk.roomAcs.get('master')!.accessory;
    assert.equal(acc.UUID, roomAcUUID('master'));
    assert.equal(acc.category, Categories.AIR_CONDITIONER);
    const hc = acc.getService(Service.HeaterCooler)!;
    const active = hc.getCharacteristic(Characteristic.Active);
    assert.equal(active.value, 0);
    assert.ok(Math.abs(Number(hc.getCharacteristic(Characteristic.CurrentTemperature).value) - 21.2) < 0.01, 'the room’s temperature');
    // On from the Home app or Siri: the master bed's zone, the unit on in a mode Kova chooses (spring, 21.2°: heat 21).
    await active.handleSetRequest(1);
    assert.equal(dev('ducted_ac').on, true);
    assert.equal(dev('ducted_ac').hvac, 'heat');
    assert.equal(dev('ducted_ac').zones!.find(z => z.n === 3)!.on, true);
    assert.equal(dev('ducted_ac').zones!.find(z => z.n === 1)!.on, false);
    assert.equal(hc.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value, 2);
    // Cool to 23: explicit.
    await hc.getCharacteristic(Characteristic.TargetHeaterCoolerState).handleSetRequest(2);
    await hc.getCharacteristic(Characteristic.CoolingThresholdTemperature).handleSetRequest(23);
    assert.deepEqual([dev('ducted_ac').hvac, dev('ducted_ac').target], ['cool', 23]);
    assert.equal(hk.roomAcs.get('lounge')!.accessory.getService(Service.HeaterCooler)!.getCharacteristic(Characteristic.Active).value, 0);
    await active.handleSetRequest(0);
    assert.equal(dev('ducted_ac').on, false, 'the last zone closing turns the unit off');
    assert.equal(active.value, 0);
  } finally {
    await hk.stop();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
