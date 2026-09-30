import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

async function setup() {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  return { ...t, app, done: async () => { await app.close(); await t.hub.stop(); } };
}

test('Home settings: rename a device, move it, hide it, favourite it; all undoable', async () => {
  const s = await setup();
  try {
    const call = (method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) => s.app.inject({ method, url, payload: payload ?? {} });
    let r = await call('PATCH', '/api/devices/lamp/settings', { name: 'Reading lamp', room: 'office', favourite: true });
    assert.equal(r.statusCode, 200, r.body);
    const lamp = s.hub.reg.get('lamp')!;
    assert.equal(lamp.name, 'Reading lamp');
    assert.equal(lamp.room, 'office');
    assert.deepEqual(lamp.original, { name: 'Lamp', room: 'lounge' });
    assert.deepEqual(s.hub.config.get().favourites, ['lamp']);
    // The assistant knows the new name.
    const ask = (await s.app.inject({ method: 'POST', url: '/api/ask/parse', payload: { text: 'turn on the reading lamp' } })).json();
    assert.equal(ask.understood, true, JSON.stringify(ask));
    // Undo puts it back.
    await call('POST', `/api/undo/${r.json().undo}`);
    assert.equal(s.hub.reg.get('lamp')!.name, 'Lamp');
    assert.equal(s.hub.reg.get('lamp')!.original, undefined);
    // Hidden, then shown again; setting the name back to the original clears the override.
    r = await call('PATCH', '/api/devices/lamp/settings', { hidden: true, name: 'Lamp' });
    assert.equal(s.hub.reg.get('lamp')!.hidden, true);
    assert.deepEqual(s.hub.config.get().devices!.lamp, { hidden: true });
    await call('PATCH', '/api/devices/lamp/settings', { hidden: false });
    assert.equal(s.hub.reg.get('lamp')!.hidden, undefined);
    assert.equal(s.hub.config.get().devices!.lamp, undefined);
    assert.equal((await call('PATCH', '/api/devices/lamp/settings', { room: 'nowhere' })).statusCode, 400);
    assert.equal((await call('PATCH', '/api/devices/nope/settings', { name: 'x' })).statusCode, 404);
    // The snapshot carries it.
    await call('PATCH', '/api/devices/lamp/settings', { name: 'Reading lamp' });
    const st = (await s.app.inject({ method: 'GET', url: '/api/state' })).json();
    assert.equal(st.devices.find((d: { id: string }) => d.id === 'lamp').name, 'Reading lamp');
  } finally { await s.done(); }
});

test('Home settings: rooms, people and the home name', async () => {
  const s = await setup();
  try {
    const call = (method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) => s.app.inject({ method, url, payload: payload ?? {} });
    assert.equal((await call('PUT', '/api/home', { name: '  Ahmed   home ' })).statusCode, 200);
    assert.equal(s.hub.config.get().name, 'Ahmed home');

    let r = await call('POST', '/api/rooms', { name: 'Hallway', icon: 'stairs' });
    assert.equal(r.json().id, 'hallway');
    assert.equal((await call('POST', '/api/rooms', { name: 'Hallway' })).json().id, 'hallway_2');
    await call('PUT', '/api/rooms/hallway', { name: 'Hall', icon: 'door_front' });
    assert.deepEqual(s.hub.config.get().rooms.find(x => x.id === 'hallway'), { id: 'hallway', name: 'Hall', icon: 'door_front' });
    assert.equal((await call('PUT', '/api/rooms/hallway', { icon: 'rocket' })).statusCode, 400);

    // A room with devices needs somewhere to put them.
    r = await call('DELETE', '/api/rooms/lounge');
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /devices are in this room/);
    r = await call('DELETE', '/api/rooms/lounge', { moveTo: 'hallway' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(s.hub.reg.get('lamp')!.room, 'hallway');
    await call('POST', `/api/undo/${r.json().undo}`);
    assert.equal(s.hub.reg.get('lamp')!.room, 'lounge');
    assert.ok(s.hub.config.get().rooms.some(x => x.id === 'lounge'));

    const ids = s.hub.config.get().rooms.map(x => x.id).reverse();
    assert.equal((await call('PUT', '/api/rooms/order', { ids })).statusCode, 200);
    assert.deepEqual(s.hub.config.get().rooms.map(x => x.id), ids);
    assert.equal((await call('PUT', '/api/rooms/order', { ids: ids.slice(1) })).statusCode, 400);

    r = await call('POST', '/api/people', { name: 'Amma', detail: 'Pixel 9' });
    assert.equal(r.json().id, 'amma');
    const st = (await s.app.inject({ method: 'GET', url: '/api/state' })).json();
    assert.equal(st.people.find((p: { id: string }) => p.id === 'amma').detail, 'Pixel 9');
    await call('PUT', '/api/people/amma', { name: 'Ammu' });
    assert.equal(s.hub.config.get().people.find(p => p.id === 'amma')!.name, 'Ammu');
    await call('DELETE', '/api/people/amma');
    assert.ok(!s.hub.config.get().people.some(p => p.id === 'amma'));
  } finally { await s.done(); }
});
