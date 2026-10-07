import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devs, favourites, groupDevices, iconOf, routerPanel, stateOf, tint, toggleCommand, type Dev } from '../src/logic/devices.ts';
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

test('an air conditioner: mode, target and the room; a tap switches it', () => {
  const ac = { id: 'ac', name: 'Bedroom AC', room: 'bedroom', type: 'climate', capabilities: ['onoff', 'climate'], on: true, hvac: 'cool', target: 24, temp: 27, state: {} } as unknown as Dev;
  assert.deepEqual(stateOf(ac), ['Cool · 24° · room 27°', '#7cb8f0']);
  assert.equal(stateOf({ ...ac, hvac: 'heat', target: 21 } as Dev)[0], 'Heat · 21° · room 27°');
  assert.deepEqual(stateOf({ ...ac, on: false } as Dev), ['Off · room 27°', '#a3a09a']);
  assert.deepEqual(toggleCommand(ac, []), { on: false });
  assert.equal(tint(ac).iconFg, '#7cb8f0');
});

test('devices by room, filtered and searched; hidden ones only on request', () => {
  const rooms = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' }];
  const g = groupDevices(Object.values(all), rooms, {});
  assert.deepEqual(g.map(x => x.name), ['Lounge', 'Kitchen', 'office', 'front'], 'the internet sensor (no room) is on Sensors, not here');
  assert.deepEqual(g[0].devices.map(x => x.id), ['box', 'ceiling', 'lamp']);
  assert.equal(g[0].lightsOn, 1);
  assert.deepEqual(groupDevices(Object.values(all), rooms, { type: 'lights' }).flatMap(x => x.devices.map(y => y.id)), ['ceiling', 'lamp']);
  assert.deepEqual(groupDevices(Object.values(all), rooms, { q: 'kitch' }).flatMap(x => x.devices.map(y => y.id)), ['speaker'], 'search matches the room too');
  assert.ok(!groupDevices(Object.values(all), rooms, {}).some(x => x.devices.some(y => y.id === 'old')));
  assert.ok(groupDevices(Object.values(all), rooms, { showHidden: true }).some(x => x.devices.some(y => y.id === 'old')));
  // Archived: never, not even with hidden ones shown.
  const arch = Object.values(all).map(d => d.id === 'lamp' ? { ...d, archived: true } : d);
  assert.ok(!groupDevices(arch, rooms, { showHidden: true }).some(x => x.devices.some(y => y.id === 'lamp')));
  assert.deepEqual(favourites(snap, all).map(x => x.id), ['lamp', 'ceiling'], 'no favourites set: the first visible lights and plugs');
});

test('notification taps go to the right place', () => {
  assert.deepEqual(routeFor('/phone.html?cam=doorbell'), { cam: 'doorbell' });
  assert.deepEqual(routeFor('/phone.html?do=lights-off'), { lightsOff: true });
  assert.deepEqual(routeFor('/phone.html?page=integrations'), { page: 'integrations' });
  assert.deepEqual(routeFor('/phone.html?embed=1&setup=nest'), { setup: 'nest' });
  assert.deepEqual(routeFor(undefined), {});
});

test('a purifier: a tap switches it on or off; its line says mode, speed, the air, or a filter running out', () => {
  const p = { id: 'p', name: 'Purifier', room: 'r', type: 'fan', capabilities: ['onoff', 'fanMode', 'purifier'], on: true, mode: 'Manual', fanLevel: 2, airQuality: 1, filterLife: 80, state: {} } as unknown as Dev;
  assert.deepEqual(toggleCommand(p, []), { on: false });
  assert.equal(stateOf(p)[0], 'Manual · speed 2 · air good');
  assert.equal(stateOf({ ...p, mode: 'Auto', airQuality: 3 } as Dev)[0], 'Auto · air poor');
  assert.deepEqual(stateOf({ ...p, filterLife: 18 } as Dev), ['Manual · filter 18%', '#f2b14c']);
  assert.equal(stateOf({ ...p, on: false } as Dev)[0], 'Off');
});

test('the router’s power: status line, icon and the panel on the Router and the Internet device', () => {
  const router = d('warden_router', 'sensor', 'unassigned', {
    online: true, power: 268, redundancy: 'lost', fanMode: 'auto', fanPercent: null,
    supplies: [{ name: 'Power supply 1', present: true, ok: false, problem: 'no input power' }, { name: 'Power supply 2', present: true, ok: true }],
    sensors: [{ name: 'Inlet Temp', kind: 'temp', value: 24, unit: 'C' }, { name: 'CPU1 Temp', kind: 'temp', value: 82, unit: 'C' }, { name: 'Fan1', kind: 'fan', value: 5400, unit: 'RPM' }],
  }, { capabilities: ['power', 'events'], adapter: 'warden' });
  const s = { ...snap, devices: [...snap.devices, router], insights: [{ id: 'power:warden_router:Power supply 1=no input power:lost', level: 'alert', icon: 'power_off', title: 'Router power supply 1 has no input power — redundancy lost', device: 'warden_router' }] } as unknown as Snapshot;
  const R = devs(s).warden_router;
  assert.deepEqual(stateOf(R), ['Power supply 1 not OK · 268 W', '#ff6b5e']);
  assert.equal(iconOf(R), 'dns');
  assert.equal(iconOf(all.lamp), 'lightbulb');
  const p = routerPanel(s, R)!;
  assert.deepEqual([p.title, p.watts, p.redundancy.label, p.alert?.text], ['Power', '268 W', 'Lost', 'Router power supply 1 has no input power — redundancy lost']);
  assert.deepEqual(p.supplies.map(x => [x.name, x.badge, x.color]), [['Power supply 1', 'No input power', '#ff6b5e'], ['Power supply 2', 'OK', '#7fd4a0']]);
  assert.deepEqual(p.temps.map(x => [x.value, x.color]), [['24°', '#f1efea'], ['82°', '#ff6b5e']]);
  assert.deepEqual([p.fans, p.fanMode], [['Fan1 · 5400 rpm'], 'Auto']);
  // The same panel on the Internet device; nothing on others, or when Warden can't read the router's hardware.
  assert.equal(routerPanel(s, all.warden_internet)!.title, 'Router power');
  assert.equal(routerPanel(s, all.lamp), null);
  assert.equal(routerPanel(snap, all.warden_internet), null);
  // Fine again.
  const ok = devs({ devices: [{ ...router, state: { ...router.state, redundancy: 'full', supplies: [{ name: 'Power supply 1', ok: true }, { name: 'Power supply 2', ok: true }] } }] } as unknown as Snapshot).warden_router;
  assert.deepEqual(stateOf(ok), ['268 W', '#7fd4a0']);
  const pred = devs({ devices: [{ ...router, state: { ...router.state, redundancy: 'degraded', supplies: [{ name: 'Power supply 1', ok: false, problem: 'predicted to fail' }] } }] } as unknown as Snapshot).warden_router;
  assert.deepEqual(stateOf(pred), ['Power supply 1 not OK · 268 W', '#f2b14c']);
});
