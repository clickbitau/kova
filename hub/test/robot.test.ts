import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

// Robot vacuums through the API and Ask Kova: the floor map, giving its areas rooms, cleaning rooms by name, and the
// rest of what it does (station jobs, settings). The demo home's robot (robot_vacuum) has five areas; the demo
// gives area 1 the lounge and area 2 the kitchen.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const open: (() => Promise<void>)[] = [];
after(async () => { for (const d of open) await d(); });

async function setup() {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, ai: { timeoutMs: 3000 } });
  let closed = false;
  const done = async () => { if (closed) return; closed = true; await app.close(); await t.hub.stop(); };
  open.push(done);
  return { ...t, app, done };
}

async function fakeModel(replies: unknown[]) {
  const received: { body: { messages: { role: string; content: string }[] } }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push({ body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies[Math.min(received.length - 1, replies.length - 1)]));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise<void>(ok => server.close(() => ok())) };
}
const toolCall = (name: string, args: unknown) => ({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (text: string) => ({ id: 'c2', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

test('Robot vacuum: its map with area names and rooms, and the owner giving an area its room', async () => {
  const h = await setup();
  const map = (await h.app.inject({ url: '/api/devices/robot_vacuum/map' })).json();
  assert.deepEqual(map.areas.map((a: { id: string; name: string; room: string | null }) => [a.id, a.name, a.room]), [['1', 'Lounge', 'lounge'], ['2', 'Kitchen', 'kitchen'], ['3', 'Area C', null], ['4', 'Area D', null], ['5', 'Area E', null]]);
  assert.equal(map.areas[0].path, 'M0 0L60 0L60 40L0 40Z');
  assert.deepEqual(map.dock, { x: 96, y: 4 });
  assert.equal((await h.app.inject({ url: '/api/devices/lamp/map' })).statusCode, 404);

  let r = await h.app.inject({ method: 'PATCH', url: '/api/devices/robot_vacuum/settings', payload: { areaRooms: { 3: 'office', 4: 'nowhere' } } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Unknown room nowhere/);
  r = await h.app.inject({ method: 'PATCH', url: '/api/devices/robot_vacuum/settings', payload: { areaRooms: { 3: 'office', 1: null } } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(h.hub.config.get().devices!.robot_vacuum!.areaRooms, { 2: 'kitchen', 3: 'office' });
  const s = (await h.app.inject({ url: '/api/state' })).json();
  assert.deepEqual(s.devices.find((d: { id: string }) => d.id === 'robot_vacuum').areaRooms, { 2: 'kitchen', 3: 'office' });
  r = await h.app.inject({ method: 'PATCH', url: '/api/devices/lamp/settings', payload: { areaRooms: { 1: 'office' } } });
  assert.match(r.json().error, /isn’t a robot vacuum/);

  // Cleaning rooms by name through the commands route: the office is area 3.
  r = await h.app.inject({ method: 'POST', url: '/api/devices/robot_vacuum', payload: { robotSet: { rooms: ['office'], suction: 'max' } } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(h.hub.reg.get('robot_vacuum')!.state.activity, 'cleaning');
  assert.equal(h.hub.reg.get('robot_vacuum')!.state.robot!.suction, 'max');
  r = await h.app.inject({ method: 'POST', url: '/api/devices/robot_vacuum', payload: { robotSet: { rooms: ['garage'] } } });
  assert.notEqual(r.statusCode, 200);
  assert.match(r.body, /doesn’t know where Garage is on its map/);
  await h.done();
});

test('Ask Kova: the robot’s rooms and settings in the context, and "vacuum the kitchen" cleans the kitchen’s area', async () => {
  const fake = await fakeModel([
    toolCall('set_devices', { devices: [{ id: 'robot_vacuum', set: { robotSet: { rooms: ['kitchen'], mode: 'vacuum' } } }] }), say('Vacuuming the kitchen.'),
    toolCall('set_devices', { devices: [{ id: 'robot_vacuum', set: { robotSet: { station: 'empty' } } }] }), say('Emptying its bin.'),
    toolCall('set_devices', { devices: [{ id: 'robot_vacuum', set: { robotSet: { settings: { childLock: true } } } }] }), say('Child lock on.'),
  ]);
  const h = await setup();
  await h.app.inject({ method: 'PUT', url: '/api/assistant/settings', payload: { engine: 'local', local: { url: fake.url, model: 'm' } } });
  const ask = async (text: string) => (await h.app.inject({ method: 'POST', url: '/api/ask', payload: { text } })).json();

  let r = await ask('vacuum the kitchen');
  assert.equal(r.text, 'Vacuuming the kitchen.');
  const sys = fake.received[0].body.messages.find(m => m.role === 'system')!.content;
  assert.match(sys, /"robot":\{"suction":"standard","mode":"both".*"rooms":\["lounge","kitchen"\],"areasWithoutRoom":\["3","4","5"\]/);
  assert.match(sys, /Side brushes \(sideBrush\) 4% left/, 'worn parts are in the context');
  const st = h.hub.reg.get('robot_vacuum')!.state;
  assert.equal(st.activity, 'cleaning');
  assert.equal(st.robot!.mode, 'vacuum');
  assert.ok(r.undo);
  assert.ok(h.hub.store.between(0, Number.MAX_SAFE_INTEGER).some(e => e.what === 'Robot vacuum: cleans Kitchen, vacuum only'), 'said in Activity');

  r = await ask('empty the robot’s bin');
  assert.equal(h.hub.reg.get('robot_vacuum')!.state.robot!.station, 'emptying');
  r = await ask('lock the robot’s buttons');
  assert.equal(h.hub.reg.get('robot_vacuum')!.state.robot!.settings!.childLock, true);
  await h.done(); await fake.close();
});
