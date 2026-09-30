import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub, at, DATE, TZ } from './helpers.ts';
import { resolveRhythm } from '../src/rhythms/rhythms.ts';
import { demoConfig } from '../src/seed/demo-home.ts';
import { clock } from '../src/util/time.ts';

test('rhythms resolve to sensible Perth times', () => {
  const c = demoConfig();
  const sunset = resolveRhythm({ kind: 'sun', event: 'sunset' }, DATE, c)!;
  const fajr = resolveRhythm({ kind: 'prayer', prayer: 'fajr' }, DATE, c)!;
  const h = (ms: number) => Number(clock(ms, TZ).slice(0, 2));
  assert.ok(h(sunset) >= 17 && h(sunset) <= 18, `sunset ${clock(sunset, TZ)}`);
  assert.ok(h(fajr) >= 4 && h(fajr) <= 5, `fajr ${clock(fajr, TZ)}`);
  assert.equal(clock(resolveRhythm({ kind: 'time', at: '20:00' }, DATE, c)!, TZ), '20:00');
});

test('modes run in order across a Kova day', async () => {
  const { hub } = await testHub();
  const p = hub.engine.planner;
  assert.equal(p.modeAt(at(12)).mode.id, 'day');
  assert.equal(p.modeAt(at(19)).mode.id, 'evening');
  assert.equal(p.modeAt(at(21)).mode.id, 'wind');
  assert.equal(p.modeAt(at(23.75)).mode.id, 'night');
  assert.equal(p.modeAt(at(2)).mode.id, 'night');
  assert.equal(p.modeAt(at(5.2)).mode.id, 'dawn');
  const bands = p.bands(DATE).map(b => b.modeId);
  assert.deepEqual(bands, ['night', 'dawn', 'day', 'evening', 'wind', 'night']);
  const total = p.bands(DATE).reduce((s, b) => s + b.end - b.start, 0);
  assert.ok(Math.abs(total - 24) < 0.01);
  await hub.stop();
});

test('entering a mode applies its targets and logs the cause', async () => {
  const { hub, advance, dev } = await testHub(17.5);
  await advance(19);
  assert.equal(hub.engine.modeId, 'evening');
  assert.equal(dev('kitchen_ceiling').on, true);
  assert.equal(dev('lamp').bri, 78);
  await advance(20 + 0.5 / 60);
  assert.equal(hub.engine.modeId, 'wind');
  assert.equal(dev('lounge_main').on, false);
  assert.equal(dev('lamp').bri, 5);
  assert.equal(hub.engine.why('lamp').now, 'Wind down started set this at 20:00.');
  assert.match(hub.engine.why('kitchen_ceiling').now, /Evening started set this at 19:00 \(10 min before sunset\)/);
  assert.match(hub.engine.why('master_speaker').next, /^21:00 · Rain sounds/);
  await hub.stop();
});

test('skipping tonight leaves the device alone', async () => {
  const { hub, advance, dev } = await testHub(20.5);
  hub.engine.setSkip(`moment:rain@${DATE}`, true);
  await advance(21.2);
  assert.equal(dev('master_speaker').on, false);
  assert.ok(hub.store.feed().some(e => e.what === 'Rain sounds skipped'));
  await hub.stop();
});

test('overlays hold their devices and hand back to the current mode', async () => {
  const { hub, advance, dev } = await testHub(19);
  await advance(19.2);
  await hub.engine.startOverlay('movie');
  assert.equal(dev('lamp').bri, 8);
  // Wind down happens during the movie: lamp is overlay-owned so it waits, lounge_main isn't so it goes off now.
  await advance(20.05);
  assert.equal(dev('lamp').bri, 8);
  assert.equal(dev('lounge_main').on, false);
  await hub.engine.endOverlay();
  assert.equal(dev('lamp').bri, 5, 'returns to Wind down, not to the pre-movie Evening value');
  await hub.stop();
});

test('Movie ends when the TV turns off', async () => {
  const { hub, dev } = await testHub(19);
  await hub.engine.command('living_display', { on: true, media: 'Radio' });
  await hub.engine.startOverlay('movie');
  await hub.engine.command('living_display', { on: false, media: null });
  await new Promise(r => setImmediate(r));
  assert.equal(hub.engine.overlay, null);
  assert.notEqual(dev('lamp').bri, 8);
  await hub.stop();
});

test('Light the way runs in dark modes only and turns lights back off', async () => {
  const { hub, advance, dev } = await testHub(12);
  hub.reg.deviceEvent('doorbell', 'person');
  await new Promise(r => setImmediate(r));
  assert.equal(dev('front_1').on, false, 'Day mode has Light the way off');

  await advance(20.5);
  assert.equal(dev('front_1').on, false);
  hub.reg.deviceEvent('doorbell', 'person');
  await new Promise(r => setImmediate(r));
  assert.equal(dev('front_1').on, true);
  assert.match(hub.engine.why('front_1').next, /Light the way turns this off/);
  await advance(20.5 + 6 / 60);
  assert.equal(dev('front_1').on, false);
  await hub.stop();
});

test('a light someone was already using is left on after Light the way', async () => {
  const { hub, advance, dev } = await testHub(20.5);
  await hub.engine.command('garage_light', { on: true });
  hub.reg.deviceEvent('garage_cam', 'person');
  await new Promise(r => setImmediate(r));
  await advance(20.5 + 11 / 60);
  assert.equal(dev('garage_light').on, true);
  await hub.stop();
});

test('"only when someone is home" waits for an arrival', async () => {
  const { hub, advance, dev } = await testHub(17, c => { c.modes[1].onlyWhenSomeoneHome = true; });
  await hub.engine.setPresence('methel', false);
  await hub.engine.setPresence('brishti', false);
  await advance(18.5);
  assert.equal(hub.engine.modeId, 'evening');
  assert.equal(dev('kitchen_ceiling').on, false);
  await hub.engine.setPresence('brishti', true);
  assert.equal(dev('kitchen_ceiling').on, true);
  assert.equal(dev('garage_light').on, true);
  await hub.stop();
});

test('Away ends when someone comes home', async () => {
  const { hub, dev } = await testHub(19);
  await hub.engine.command('lounge_main', { on: true });
  await hub.engine.setPresence('methel', false);
  await hub.engine.setPresence('brishti', false);
  await hub.engine.startOverlay('away');
  assert.equal(dev('lounge_main').on, false);
  await hub.engine.setPresence('methel', true);
  assert.equal(hub.engine.overlay, null);
  assert.equal(dev('lounge_main').on, true);
  await hub.stop();
});

test('undo puts a device back', async () => {
  const { hub, dev } = await testHub(12);
  const undo = await hub.engine.command('lamp', { on: true, bri: 40 });
  assert.equal(dev('lamp').bri, 40);
  await hub.engine.undo(undo);
  assert.equal(dev('lamp').on, false);
  await hub.stop();
});

test('changes made at the device are logged with that cause', async () => {
  const { hub, virtual } = await testHub(12);
  virtual.physical('dining', { on: true });
  const last = hub.store.lastStateChange('dining')!;
  assert.equal(last.cause.kind, 'device');
  assert.match(hub.engine.why('dining').now, /at the device or in another app/);
  await hub.stop();
});

test('device state survives a restart', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { Hub } = await import('../src/hub.ts');
  const { VirtualAdapter } = await import('../src/adapters/virtual.ts');
  const { demoConfig: cfg, demoDevices } = await import('../src/seed/demo-home.ts');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kova-')), 'kova.db');
  const mk = () => new Hub({ dbPath, initialConfig: cfg, adapters: [new VirtualAdapter(demoDevices())], now: () => at(12), tickMs: 0 });
  const a = mk(); await a.start();
  await a.engine.command('dining', { on: true });
  await a.stop();
  const b = mk(); await b.start();
  assert.equal(b.reg.get('dining')!.state.on, true);
  await b.stop();
});
