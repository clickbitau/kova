import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, DATE } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

test('editing modes: start time, targets, undo, validation', async () => {
  const { hub, advance, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    // Wind down at 21:00 instead of 20:00, and the kitchen ceiling off in it.
    let r = await app.inject({ method: 'PUT', url: '/api/modes/wind', payload: { start: { kind: 'time', at: '21:00' } } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/kitchen_ceiling', payload: { target: { on: false } } });
    assert.equal(r.statusCode, 200);
    // Dim the lamp less, and reject a nonsense target.
    await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/lamp', payload: { target: { on: true, bri: 250 } } });
    assert.equal(hub.config.get().modes.find(m => m.id === 'wind')!.targets.lamp.bri, 100, 'clamped');
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/doorbell', payload: { target: { on: true } } });
    assert.equal(r.statusCode, 400, "a camera can't be switched on");
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind', payload: { start: { kind: 'time', at: '25:00' } } });
    assert.equal(r.statusCode, 400);

    const s = (await app.inject({ url: '/api/state' })).json();
    const wind = s.modes.find((m: { id: string }) => m.id === 'wind');
    assert.equal(wind.startLabel, '21:00');
    assert.ok(wind.targets.some((t: { deviceId: string; label: string }) => t.deviceId === 'kitchen_ceiling' && t.label === 'Ceiling off'));

    await advance(19);
    await advance(20.5);
    assert.equal(hub.engine.modeId, 'evening', 'still Evening at 20:30 now');
    await advance(21.01);
    assert.equal(hub.engine.modeId, 'wind');
    assert.equal(dev('kitchen_ceiling').on, false);

    // Removing a target, then undoing it.
    r = await app.inject({ method: 'PUT', url: '/api/modes/wind/targets/kitchen_ceiling', payload: { target: null } });
    assert.ok(!hub.config.get().modes.find(m => m.id === 'wind')!.targets.kitchen_ceiling);
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.ok(hub.config.get().modes.find(m => m.id === 'wind')!.targets.kitchen_ceiling);
  } finally { await app.close(); await hub.stop(); }
});

test('moments, overlays and stream addresses', async () => {
  const { hub, advance, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'POST', url: '/api/moments', payload: { label: 'Porch off', at: { kind: 'time', at: '22:15' }, targets: { front_1: { on: false } } } });
    assert.equal(r.statusCode, 200);
    const id = r.json().id;
    await advance(19); await advance(22.3);
    assert.equal(dev('front_1').on, false);
    assert.ok(hub.engine.planner.kovaDay(DATE).items.some(i => i.refId === id));
    r = await app.inject({ method: 'DELETE', url: `/api/moments/${id}` });
    assert.ok(!hub.config.get().moments.some(m => m.id === id));

    r = await app.inject({ method: 'PUT', url: '/api/overlays/movie/targets/dining', payload: { target: { on: false } } });
    assert.deepEqual(hub.config.get().overlays.find(o => o.id === 'movie')!.targets.dining, { on: false });

    r = await app.inject({ method: 'PUT', url: '/api/sources/Tarateel', payload: { url: 'https://stream.example/tarateel.mp3' } });
    assert.equal(hub.config.get().sources.find(s => s.name === 'Tarateel')!.url, 'https://stream.example/tarateel.mp3');
    r = await app.inject({ method: 'PUT', url: '/api/sources/Bad', payload: { url: 'ftp://nope' } });
    assert.equal(r.statusCode, 400);
  } finally { await app.close(); await hub.stop(); }
});

test('modes that point at missing devices are flagged and can be cleaned up', async () => {
  const { hub } = await testHub(12);
  hub.config.update(c => { c.modes.find(m => m.id === 'evening')!.targets.old_switch = { on: true }; });
  const f = hub.checker.findings().find(x => x.id === 'missing:evening');
  assert.ok(f);
  assert.match(f.title, /Evening uses 1 device Kova can’t find/);
  hub.checker.fix(f.id);
  assert.ok(!hub.config.get().modes.find(m => m.id === 'evening')!.targets.old_switch);
  await hub.stop();
});
