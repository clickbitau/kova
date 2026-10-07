import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

test('API: state, commands, undo, overlays, preview', async () => {
  const { hub } = await testHub(19.7);
  const app = await buildServer(hub, { webRoot });

  const s = (await app.inject({ url: '/api/state' })).json();
  assert.equal(s.current.modeId, 'evening');
  assert.equal(s.devices.length, 36, '28 home devices, 6 sensors, the simulated inverter and the ducted AC');
  assert.equal(s.devices.filter((d: { kind: string }) => d.kind === 'sensor').length, 7, 'the sensors and the inverter are sensors');
  assert.equal(s.energy.available, true);
  assert.equal(s.modes.length, 5);
  assert.ok(s.findings.some((f: { id: string }) => f.id === 'stays-on:kitchen_ceiling:wind'));

  const r = (await app.inject({ method: 'POST', url: '/api/devices/dining', payload: { on: true } })).json();
  assert.equal(hub.reg.get('dining')!.state.on, true);
  await app.inject({ method: 'POST', url: `/api/undo/${r.undo}` });
  assert.equal(hub.reg.get('dining')!.state.on, false);

  await app.inject({ method: 'POST', url: '/api/overlays/party/start' });
  assert.equal(hub.engine.overlay?.id, 'party');
  await app.inject({ method: 'POST', url: '/api/overlays/end' });
  assert.equal(hub.engine.overlay, null);

  const p = (await app.inject({ url: '/api/preview?hour=23.6' })).json();
  assert.equal(p.modeId, 'night');
  assert.equal(p.devices.living_display.media, 'Tarateel');

  const boot = await app.inject({ url: '/api/boot.js' });
  assert.match(boot.body, /^window\.KOVA_BOOT=/);
  await app.close();
  await hub.stop();
});

test('API: token required when configured', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot, token: 'secret' });
  assert.equal((await app.inject({ url: '/api/state' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/state', headers: { authorization: 'Bearer secret' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/boot.js?token=secret' })).statusCode, 200);
  await app.close();
  await hub.stop();
});
