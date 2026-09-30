import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Accessory, Categories, Characteristic, HAPStorage, MDNSAdvertiser, Service, uuid } from 'hap-nodejs';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { adaptersFor } from '../src/integrations.ts';
import {
  HomeKitControllerAdapter, HAP, mapAccessories, stateFrom, writesFor, miredToKelvin, kelvinToMired, hsToHex, hexToHs,
  hapBool, fanModeToTarget, targetToFanMode, sanitiseAccessoryId, kovaDeviceId, normaliseSetupCode, pairingErrorMessage,
  pickAddress, serviceName, toHapBrightness, type AccessoryDb,
} from '../src/adapters/homekit-controller.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const USER = { kind: 'user' as const, label: 'You' };

// hap-nodejs keeps the accessory's own pairing store in one global directory per process.
const hapDir = mkdtempSync(join(tmpdir(), 'kova-hap-accessory-'));
HAPStorage.setCustomStoragePath(hapDir);
process.on('exit', () => rmSync(hapDir, { recursive: true, force: true }));

async function waitFor(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

let n = 0;
/** A real HAP accessory: a colour-temperature Lightbulb and an Outlet, served by hap-nodejs. */
function fakeLamp() {
  n++;
  const username = `0E:4B:0A:11:22:${String(n).padStart(2, '0')}`;
  const acc = new Accessory('Desk Lamp', uuid.generate(`kova-test-lamp-${process.pid}-${n}`));
  const bulb = acc.addService(Service.Lightbulb, 'Lamp');
  bulb.addCharacteristic(Characteristic.Brightness).updateValue(40);
  bulb.addCharacteristic(Characteristic.ColorTemperature).updateValue(370);
  const outlet = acc.addService(Service.Outlet, 'Plug');
  const writes: { char: string; value: unknown }[] = [];
  for (const [s, c] of [[bulb, Characteristic.On], [bulb, Characteristic.Brightness], [bulb, Characteristic.ColorTemperature], [outlet, Characteristic.On]] as const) {
    s.getCharacteristic(c).on('change', ch => { if (ch.reason === 'write') writes.push({ char: `${s.displayName}.${c.name}`, value: ch.newValue }); });
  }
  const pincode = '031-45-154';
  let port = 0;
  return {
    acc, bulb, outlet, writes, username, pincode,
    get port() { return port; },
    async publish(p = 0) {
      await acc.publish({ username, pincode, port: p, category: Categories.LIGHTBULB, advertiser: MDNSAdvertiser.CIAO });
      port = ((acc as unknown as { _server: { httpServer: { tcpServer: { address(): AddressInfo } } } })._server.httpServer.tcpServer.address()).port;
    },
    async unpublish() { await acc.unpublish(); },
    async destroy() { await acc.destroy(); },
  };
}

test('HomeKit controller conversions', () => {
  assert.equal(miredToKelvin(370), 2700);
  assert.equal(miredToKelvin(153), 6540);
  assert.equal(miredToKelvin(0), 2700);
  assert.equal(kelvinToMired(2700), 370);
  assert.equal(kelvinToMired(6500), 154);
  assert.equal(kelvinToMired(1000), 500); // clamped to the characteristic's range
  assert.equal(kelvinToMired(9000, 153, 454), 153);
  assert.equal(miredToKelvin(kelvinToMired(3000)), 3000);

  assert.equal(hsToHex(0, 100), '#ff0000');
  assert.equal(hsToHex(120, 100), '#00ff00');
  assert.equal(hsToHex(360, 0), '#ffffff');
  assert.deepEqual(hexToHs('#0096ff'), { h: 205, s: 100 });
  assert.deepEqual(hexToHs('#ffffff'), { h: 0, s: 0 });
  assert.throws(() => hexToHs('blue'), /Not a colour/);

  assert.equal(hapBool(1), true);
  assert.equal(hapBool(true), true);
  assert.equal(hapBool(0), false);
  assert.equal(toHapBrightness(31.6), 32);
  assert.equal(toHapBrightness(140), 100);
  assert.equal(fanModeToTarget('Auto'), 1);
  assert.equal(fanModeToTarget('Sleep'), 0);
  assert.equal(targetToFanMode(1), 'Auto');
  assert.equal(targetToFanMode(0), 'Sleep');

  assert.equal(sanitiseAccessoryId('0E:4B:0A:11:22:33'), '0e4b0a112233');
  assert.equal(kovaDeviceId('0E:4B:0A:11:22:33', 1, 9), 'homekit_0e4b0a112233_1_9');
  assert.equal(normaliseSetupCode('03145154'), '031-45-154');
  assert.equal(normaliseSetupCode('031-45-154'), '031-45-154');
  assert.equal(normaliseSetupCode('031-45-15'), null);
  assert.equal(pairingErrorMessage(2, 'x'), 'Wrong setup code');
  assert.equal(pairingErrorMessage(undefined, 'socket hang up'), 'socket hang up');
  assert.equal(pickAddress(['fe80::1', '192.168.1.20']), '192.168.1.20');

  assert.equal(serviceName('Desk Lamp', undefined, 'Lamp', 'lightbulb', 1), 'Desk Lamp');
  assert.equal(serviceName('Desk Lamp', 'Reading', 'Lamp', 'lightbulb', 1), 'Reading');
  assert.equal(serviceName('Desk Lamp', undefined, 'Plug', 'outlet', 2), 'Plug');
  assert.equal(serviceName('Desk Lamp', 'Desk', 'Plug', 'outlet', 2), 'Desk Plug');
  assert.equal(serviceName('Desk Lamp', undefined, undefined, 'outlet', 2), 'Desk Lamp Outlet');
});

test('HomeKit controller maps services, state and writes', () => {
  const U = (short: string) => `${short.padStart(8, '0')}-0000-1000-8000-0026BB765291`;
  const ch = (iid: number, t: string, value?: unknown, extra = {}) => ({ iid, type: U(t), value, perms: ['pr', 'pw', 'ev'], ...extra });
  const db: AccessoryDb = { accessories: [{
    aid: 1,
    services: [
      { iid: 1, type: HAP.svc.AccessoryInformation, characteristics: [ch(2, '23', 'Purifier')] },
      { iid: 8, type: U('BB'), characteristics: [ch(9, 'B0', 1), ch(10, 'A8', 1), ch(11, 'A9', 2)] },
      { iid: 20, type: U('43'), characteristics: [ch(21, '25', true), ch(22, '8', 55), ch(23, '13', 240), ch(24, '2F', 100)] },
      { iid: 30, type: U('8A'), characteristics: [ch(31, '11', 21)] }, // temperature sensor: ignored for now
    ],
  }] };
  const { services, values } = mapAccessories('AA:BB:CC:DD:EE:FF', db);
  assert.equal(services.length, 2);
  const [fan, light] = services;
  assert.equal(fan.deviceId, 'homekit_aabbccddeeff_1_8');
  assert.equal(fan.type, 'fan');
  assert.deepEqual(fan.capabilities, ['onoff', 'fanMode']);
  assert.deepEqual(stateFrom(fan, values.get(fan.deviceId)!), { on: true, mode: 'Auto' });
  assert.deepEqual(writesFor(fan, { on: false, mode: 'Sleep' }), [[9, 0], [10, 0]]);

  assert.equal(light.type, 'dimmer');
  assert.deepEqual(light.capabilities, ['onoff', 'brightness', 'color']);
  assert.equal(light.name, 'Purifier Light');
  assert.deepEqual(stateFrom(light, values.get(light.deviceId)!), { on: true, bri: 55, color: '#0000ff' });
  assert.deepEqual(writesFor(light, { on: true, bri: 30, color: '#ff0000' }), [[21, true], [22, 30], [23, 0], [24, 100]]);
  assert.deepEqual(writesFor(light, { bri: 0 }), [[21, false]]);
  assert.throws(() => writesFor(light, { k: 3000 }), /no colour temperature/);

  // A bulb with both: whichever was set last wins.
  const both = { ...light, chars: { ...light.chars, ct: 25 }, ctMin: 140, ctMax: 500 };
  const v = new Map<number, unknown>([[21, true], [22, 80], [23, 30], [24, 50], [25, 250]]);
  assert.deepEqual(stateFrom(both, v), { on: true, bri: 80, k: 4000, color: null });
  assert.deepEqual(stateFrom(both, v, 'hs'), { on: true, bri: 80, color: '#ffbf80', k: null });
});

test('HomeKit controller pairs with a real HAP accessory, controls it, follows it, reconnects', { timeout: 60_000 }, async () => {
  const lamp = fakeLamp();
  await lamp.publish();
  const dir = mkdtempSync(join(tmpdir(), 'kova-hkc-'));
  const reg = new Registry(new Store(':memory:'));
  const opts = { storageDir: dir, mdns: false, timeoutMs: 5000, retryMs: 100 };
  let reg2: Registry | undefined;
  try {
    const hk = new HomeKitControllerAdapter(opts);
    await reg.addAdapter(hk);
    assert.equal(reg.list().length, 0);

    // A wrong code is a clear error, and doesn't leave anything behind.
    await assert.rejects(hk.pair(lamp.username, '111-22-333', { host: '127.0.0.1', port: lamp.port }), /Wrong setup code/);
    await assert.rejects(hk.pair(lamp.username, '12-34', { host: '127.0.0.1', port: lamp.port }), /should look like/);
    assert.deepEqual(hk.paired, []);

    const devices = await hk.pair(lamp.username, lamp.pincode, { room: 'study', name: 'Desk', host: '127.0.0.1', port: lamp.port });
    assert.equal(devices.length, 2);
    const aid = 1;
    const bulbIid = lamp.bulb.iid!, outletIid = lamp.outlet.iid!;
    const sid = sanitiseAccessoryId(lamp.username);
    const bulbId = `homekit_${sid}_${aid}_${bulbIid}`, plugId = `homekit_${sid}_${aid}_${outletIid}`;
    const bulb = reg.get(bulbId)!, plug = reg.get(plugId)!;
    assert.equal(bulb.name, 'Desk Lamp');
    assert.equal(bulb.room, 'study');
    assert.equal(bulb.type, 'dimmer');
    assert.equal(bulb.integration, 'HomeKit');
    assert.equal(bulb.adapter, 'homekit');
    assert.deepEqual(bulb.capabilities, ['onoff', 'brightness', 'colorTemp']);
    assert.equal(plug.name, 'Desk Plug');
    assert.equal(plug.type, 'plug');
    assert.deepEqual(bulb.state, { on: false, bri: 40, k: 2700, online: true });
    assert.equal(hk.status().ok, true);

    // Long-term keys on disk, owner-only.
    const file = join(dir, 'pairings.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(saved[lamp.username].pairing.iOSDeviceLTSK);

    // Kova → accessory.
    await reg.command(bulbId, { on: true, bri: 78, k: 4000 }, USER);
    assert.equal(lamp.bulb.getCharacteristic(Characteristic.On).value, true);
    assert.equal(lamp.bulb.getCharacteristic(Characteristic.Brightness).value, 78);
    assert.equal(lamp.bulb.getCharacteristic(Characteristic.ColorTemperature).value, 250);
    await reg.command(plugId, { on: true }, USER);
    assert.equal(lamp.outlet.getCharacteristic(Characteristic.On).value, true);
    assert.ok(lamp.writes.some(w => w.char === 'Plug.On' && w.value === true));

    // Accessory → Kova (someone used the Home app or the button on the lamp).
    lamp.bulb.getCharacteristic(Characteristic.Brightness).updateValue(15);
    lamp.bulb.getCharacteristic(Characteristic.ColorTemperature).updateValue(454);
    lamp.outlet.getCharacteristic(Characteristic.On).updateValue(false);
    await waitFor('bulb event', () => reg.get(bulbId)!.state.bri === 15 && reg.get(bulbId)!.state.k === 2200).catch(e => { console.log(reg.get(bulbId)!.state, reg.get(plugId)!.state); throw e; });
    await waitFor('outlet event', () => reg.get(plugId)!.state.on === false);

    // Restart from storage: no pairing, just pair-verify.
    await reg.stop();
    const hk2 = new HomeKitControllerAdapter(opts);
    reg2 = new Registry(new Store(':memory:'));
    await reg2.addAdapter(hk2);
    // Devices come back from the cached database straight away, offline until verified.
    assert.equal(reg2.list().length, 2);
    await waitFor('reconnect', () => reg2!.get(bulbId)?.state.online === true);
    assert.equal(reg2.get(bulbId)!.state.bri, 15);
    await reg2.command(bulbId, { bri: 60 }, USER);
    assert.equal(lamp.bulb.getCharacteristic(Characteristic.Brightness).value, 60);

    // The accessory goes away: offline, and a clear error on commands.
    await lamp.unpublish();
    await waitFor('offline', () => reg2!.get(bulbId)!.state.online === false);
    await assert.rejects(reg2.command(bulbId, { bri: 20 }, USER), /offline/);
    assert.equal(hk2.status().ok, false);

    // It comes back on the same port: reconnects with backoff, events flow again.
    await lamp.publish(lamp.port);
    await waitFor('back online', () => reg2!.get(bulbId)!.state.online === true, 15_000);
    lamp.bulb.getCharacteristic(Characteristic.On).updateValue(false);
    await waitFor('event after reconnect', () => reg2!.get(bulbId)!.state.on === false);
  } finally {
    await reg.stop();
    await reg2?.stop();
    await lamp.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HomeKit controller: discover over mDNS and pair through the API', { timeout: 60_000 }, async t => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  const dir = mkdtempSync(join(tmpdir(), 'kova-hkc-api-'));
  const lamp = fakeLamp();
  try {
    // No adapter configured: a 400 that says what to do.
    let r = await app.inject({ method: 'POST', url: '/api/integrations/homekit-devices/pair', payload: { id: lamp.username, code: lamp.pincode } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /aren’t set up/);

    const [hk] = adaptersFor({ homekit: {} }, dir);
    assert.ok(hk instanceof HomeKitControllerAdapter);
    (hk as unknown as { opts: { mdns: boolean } }).opts.mdns = false;
    await hub.reg.addAdapter(hk);
    r = await app.inject({ method: 'POST', url: '/api/integrations/homekit-devices/pair', payload: { id: lamp.username } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /id and code are required/);
    r = await app.inject({ method: 'POST', url: '/api/integrations/homekit-devices/pair', payload: { id: 'nope', code: lamp.pincode } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Not a HomeKit accessory id/);

    await lamp.publish();
    let found: { id: string; paired: boolean; port: number; host: string; category: string; name: string } | undefined;
    for (let i = 0; i < 3 && !found; i++) {
      const d = await app.inject({ url: '/api/integrations/homekit-devices/discover' });
      assert.equal(d.statusCode, 200);
      found = d.json().accessories.find((a: { id: string }) => a.id === lamp.username);
    }
    if (!found) { t.skip('mDNS multicast does not reach this sandbox; pairing by host/port is covered above'); return; }
    assert.equal(found.paired, false);
    assert.equal(found.port, lamp.port);
    assert.equal(found.category, 'Lighting');
    assert.match(found.name, /^Desk Lamp/);

    r = await app.inject({ method: 'POST', url: '/api/integrations/homekit-devices/pair', payload: { id: lamp.username, code: lamp.pincode, room: 'lounge' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().devices.length, 2);
    const id = r.json().devices[0].id;
    assert.equal(hub.reg.get(id)!.room, 'lounge');
    const res = await app.inject({ method: 'POST', url: `/api/devices/${id}`, payload: { on: true } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(lamp.bulb.getCharacteristic(Characteristic.On).value, true);

    // Pairing again is refused.
    r = await app.inject({ method: 'POST', url: '/api/integrations/homekit-devices/pair', payload: { id: lamp.username, code: lamp.pincode } });
    assert.equal(r.statusCode, 400);
  } finally {
    await app.close();
    await hub.stop();
    await lamp.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
