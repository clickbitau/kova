import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devs, favourites, groupDevices, stateOf, tint, toggleCommand, type Dev } from '../src/logic/devices.ts';
import { routeFor } from '../src/logic/links.ts';
import type { Device, Snapshot } from '../src/api/types.ts';

const d = (id: string, type: Device['type'], room: string, state: Device['state'], extra: Partial<Device> = {}): Device =>
  ({ id, name: id, room, type, capabilities: type === 'dimmer' ? ['onoff', 'brightness'] : ['onoff'], adapter: 'x', integration: 'X', address: id, state, ...extra });

const snap = {
  devices: [
    d('lamp', 'dimmer', 'lounge', { on: true, bri: 40 }),
    d('ceiling', 'light', 'lounge', { on: false }),
    d('speaker', 'media', 'kitchen', { on: false, vol: 20 }, { capabilities: ['onoff', 'media', 'volume'] }),
    d('box', 'tv', 'lounge', { on: true, media: 'Dune', paused: true }, { capabilities: ['onoff', 'media', 'volume', 'pause', 'library'] }),
    d('ipad', 'internet', 'office', { on: false }),
    d('door', 'camera', 'front', { online: true }),
    d('old', 'plug', 'garage', { on: true, power: 12 }, { hidden: true }),
    d('warden_internet', 'sensor', 'unassigned', { on: true, online: true }),
  ],
  favourites: null,
} as unknown as Snapshot;
const all = devs(snap);

test('status lines and colours match the web app', () => {
  assert.deepEqual(stateOf(all.lamp), ['On · 40%', '#f2b14c']);
  assert.deepEqual(stateOf(all.ceiling), ['Off', '#a3a09a']);
  assert.deepEqual(stateOf(all.box), ['Paused · Dune', '#a3a09a']);
  assert.deepEqual(stateOf(all.ipad), ['Internet paused', '#f2b14c']);
  assert.deepEqual(stateOf(all.warden_internet), ['Internet up', '#7fd4a0']);
  assert.deepEqual(stateOf(all.old), ['On · 12 W', '#f2b14c']);
  assert.equal(tint(all.lamp).iconBg, '#f2b14c');
  assert.equal(tint(all.ceiling).bg, '#16171a');
});

test('tapping a tile: lights switch, speakers start the first source, a Helix box pauses, cameras open', () => {
  const src = [{ name: 'Tarateel' }];
  assert.deepEqual(toggleCommand(all.lamp, src), { on: false });
  assert.deepEqual(toggleCommand(all.speaker, src), { on: true, media: 'Tarateel', vol: 20 });
  assert.deepEqual(toggleCommand(all.box, src), { paused: false });
  assert.equal(toggleCommand({ ...all.box, on: false } as Dev, src), null, 'nothing playing: open its panel to pick something');
  assert.equal(toggleCommand(all.door, src), null);
  assert.deepEqual(toggleCommand(all.ipad, src), { on: true });
  // A soundbar Kova controls but can't stream to (SmartThings): on and off, not "play the first source".
  const bar = { ...d('bar', 'media', 'lounge', {}, { capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'] }), on: true, input: 'tv', vol: 19 } as unknown as Dev;
  assert.deepEqual(toggleCommand(bar, src), { on: false });
  assert.equal(stateOf(bar)[0], 'On · TV (eARC)', 'never "Playing"');
  assert.equal(stateOf({ ...bar, input: 'hdmi1' } as Dev)[0], 'On · HDMI 1');
  assert.equal(stateOf({ ...bar, on: false } as Dev)[0], 'Off');
});

test('devices by room, filtered and searched; hidden ones only on request', () => {
  const rooms = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' }];
  const g = groupDevices(Object.values(all), rooms, {});
  assert.deepEqual(g.map(x => x.name), ['Lounge', 'Kitchen', 'office', 'front', 'Other']);
  assert.deepEqual(g[0].devices.map(x => x.id), ['box', 'ceiling', 'lamp']);
  assert.equal(g[0].lightsOn, 1);
  assert.deepEqual(groupDevices(Object.values(all), rooms, { type: 'lights' }).flatMap(x => x.devices.map(y => y.id)), ['ceiling', 'lamp']);
  assert.deepEqual(groupDevices(Object.values(all), rooms, { q: 'kitch' }).flatMap(x => x.devices.map(y => y.id)), ['speaker'], 'search matches the room too');
  assert.ok(!groupDevices(Object.values(all), rooms, {}).some(x => x.devices.some(y => y.id === 'old')));
  assert.ok(groupDevices(Object.values(all), rooms, { showHidden: true }).some(x => x.devices.some(y => y.id === 'old')));
  assert.deepEqual(favourites(snap, all).map(x => x.id), ['lamp', 'ceiling'], 'no favourites set: the first visible lights and plugs');
});

test('notification taps go to the right place', () => {
  assert.deepEqual(routeFor('/phone.html?cam=doorbell'), { cam: 'doorbell' });
  assert.deepEqual(routeFor('/phone.html?do=lights-off'), { lightsOff: true });
  assert.deepEqual(routeFor('/phone.html?page=integrations'), { page: 'integrations' });
  assert.deepEqual(routeFor(undefined), {});
});
