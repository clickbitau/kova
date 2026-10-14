import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { cleanPlan, fitRobot, place, robotAreaRooms, spots } from '../src/util/floorplan.ts';
import { DEMO_FLOOR_PLAN, DEMO_ROBOT_MAP } from '../src/seed/demo-home.ts';
import type { FloorPlan, PlanRobotFit, RobotMap } from '../src/model/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const box = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

test('floor plan: what is sent is checked, in plain words', () => {
  const ok = cleanPlan({ widthM: 10, heightM: 8, walls: 'concrete', rooms: [{ id: 'a', name: 'Lounge', room: 'lounge', points: box(0, 0, 5, 4) }] }, ['lounge']);
  assert.ok(typeof ok === 'object' && ok.rooms[0]!.room === 'lounge' && ok.walls === 'concrete');
  assert.match(String(cleanPlan({ widthM: 1, heightM: 8, rooms: [] }, [])), /2 to 200 metres/);
  assert.match(String(cleanPlan({ widthM: 10, heightM: 8, walls: 'cheese', rooms: [] }, [])), /Walls are one of/);
  assert.match(String(cleanPlan({ widthM: 10, heightM: 8, rooms: [{ id: 'a', name: 'Lounge', points: box(0, 0, 30, 4) }] }, [])), /Lounge: its shape/);
  assert.match(String(cleanPlan({ widthM: 10, heightM: 8, rooms: [{ id: 'a', name: 'Lounge', room: 'nope', points: box(0, 0, 5, 4) }] }, [])), /no room nope/);
  assert.match(String(cleanPlan({ widthM: 10, heightM: 8, rooms: [{ id: 'a', name: 'A', points: box(0, 0, 5, 4) }, { id: 'a', name: 'B', points: box(5, 0, 5, 4) }] }, [])), /its own id/);
  assert.match(String(cleanPlan({ widthM: 10, heightM: 8, rooms: [], image: 'http://elsewhere/x.png' }, [])), /picture Kova keeps/);
});

test('floor plan: a device shows where it was put, or spread over its room', () => {
  const plan: FloorPlan = { widthM: 10, heightM: 8, rooms: [{ id: 'a', name: 'Lounge', room: 'lounge', points: box(0, 0, 6, 4) }], places: { lamp: [1, 1] } };
  const s = spots(plan, [{ id: 'lamp', room: 'lounge' }, { id: 'tv', room: 'lounge' }, { id: 'fan', room: 'lounge' }, { id: 'away', room: 'garage' }]);
  assert.deepEqual(s.lamp, { x: 1, y: 1 });
  assert.ok(s.tv!.auto && s.fan!.auto && s.tv!.x !== s.fan!.x, 'spread out');
  for (const k of ['tv', 'fan']) assert.ok(s[k]!.x > 0 && s[k]!.x < 6 && s[k]!.y > 0 && s[k]!.y < 4, `${k} inside the lounge`);
  assert.equal(s.away, undefined, 'a room not on the plan: not shown');
});

test('floor plan: a robot’s map is found however it was turned, mirrored and moved, and its areas get their rooms', () => {
  // The robot's map is the demo plan's rooms seen turned, mirrored and moved: each fit must come back.
  for (const want of [{ rot: 90, flip: false, dx: 3, dy: -2 }, { rot: 270, flip: true, dx: -5, dy: 7 }, { rot: 0, flip: false, dx: 0.3, dy: 0.3 }] as PlanRobotFit[]) {
    const back = (x: number, y: number): [number, number] => {
      // The inverse of place(): take off the move, turn back, un-mirror.
      let a = x - want.dx, b = y - want.dy;
      if (want.rot === 90) [a, b] = [b, -a]; else if (want.rot === 180) [a, b] = [-a, -b]; else if (want.rot === 270) [a, b] = [-b, a];
      return [want.flip ? -a : a, b];
    };
    const inner = DEMO_FLOOR_PLAN.rooms.filter(r => ['p1', 'p2', 'p4', 'p5'].includes(r.id));
    const map: RobotMap = { viewBox: [0, 0, 1, 1], walls: '', dock: null, areas: inner.map((r, i) => ({ id: String(i + 1), x: 0, y: 0, path: `M${r.points.map(([x, y]) => back(x, y).map(n => (n / 0.05).toFixed(1)).join(' ')).join('L')}Z` })) };
    // place(back(p)) is p again.
    const [px, py] = place(want, back(4, 2));
    assert.ok(Math.abs(px - 4) < 1e-9 && Math.abs(py - 2) < 1e-9);
    const f = fitRobot(map, DEMO_FLOOR_PLAN)!;
    assert.ok(f.score > 0.95, `score ${f.score}`);
    // Rectangles look the same mirrored and half-turned; what matters is that every area lands on its room.
    const rooms = robotAreaRooms(map, DEMO_FLOOR_PLAN, f.fit);
    assert.deepEqual(rooms.map(a => a.room), ['lounge', 'kitchen', 'master', 'office'], JSON.stringify(f));
    assert.ok(rooms.every(a => a.share > 0.9), JSON.stringify(rooms));
  }
});

test('floor plan on a hub: saved, shown with spots, devices placed, a robot lined up and its rooms given, with undo', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  try {
    // The demo home has a plan; the snapshot carries it with where each device shows.
    let s = (await app.inject({ url: '/api/state' })).json();
    assert.equal(s.floorPlan.rooms.length, DEMO_FLOOR_PLAN.rooms.length);
    const lamp = s.devices.find((d: { room: string }) => d.room === 'lounge');
    assert.ok(s.floorPlan.spots[lamp.id], 'a lounge device shows on the plan');

    let r = await app.inject({ method: 'PUT', url: `/api/home/floorplan/places/${lamp.id}`, payload: { x: 1.5, y: 1.25 } });
    assert.equal(r.statusCode, 200);
    s = (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual(s.floorPlan.spots[lamp.id], { x: 1.5, y: 1.25 });
    assert.equal((await app.inject({ method: 'PUT', url: `/api/home/floorplan/places/${lamp.id}`, payload: { x: 99, y: 1 } })).statusCode, 400);

    // A new plan keeps the places it doesn't send.
    r = await app.inject({ method: 'PUT', url: '/api/home/floorplan', payload: { ...DEMO_FLOOR_PLAN, walls: 'concrete' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(t.hub.config.get().floorPlan!.places, { [lamp.id]: [1.5, 1.25] });
    assert.equal((await app.inject({ method: 'PUT', url: '/api/home/floorplan', payload: { widthM: 10, heightM: 8, rooms: [{ id: 'x', name: 'X', room: 'nope', points: box(0, 0, 2, 2) }] } })).json().error, 'X: no room nope');

    // The robot: lined up (nothing saved), then kept with its rooms; areas 4 and 5 get the master bed and the office.
    const fit = (await app.inject({ method: 'POST', url: '/api/home/floorplan/robots/robot_vacuum/fit' })).json();
    assert.ok(fit.good && fit.score > 0.95, JSON.stringify(fit));
    assert.deepEqual(fit.areas.map((a: { id: string; room: string | null }) => [a.id, a.room]), [['1', 'lounge'], ['2', 'kitchen'], ['3', null], ['4', 'master'], ['5', 'office']]);
    assert.equal(fit.areas[2].planRoomName, 'Hallway');
    assert.deepEqual(t.hub.config.get().devices!.robot_vacuum!.areaRooms, { 1: 'lounge', 2: 'kitchen' }, 'not yet');
    r = await app.inject({ method: 'PUT', url: '/api/home/floorplan/robots/robot_vacuum', payload: { fit: fit.fit, rooms: true } });
    assert.equal(r.json().rooms, 4);
    assert.deepEqual(t.hub.config.get().devices!.robot_vacuum!.areaRooms, { 1: 'lounge', 2: 'kitchen', 4: 'master', 5: 'office' });
    assert.deepEqual(t.hub.config.get().floorPlan!.robots!.robot_vacuum, fit.fit);
    // One undo puts both back.
    assert.equal((await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` })).statusCode, 200);
    assert.deepEqual(t.hub.config.get().devices!.robot_vacuum!.areaRooms, { 1: 'lounge', 2: 'kitchen' });
    assert.equal(t.hub.config.get().floorPlan!.robots?.robot_vacuum, undefined);
    assert.equal((await app.inject({ method: 'POST', url: '/api/home/floorplan/robots/lamp/fit' })).statusCode, 404);

    // Removed: no plan in the snapshot.
    await app.inject({ method: 'PUT', url: '/api/home/floorplan', payload: null as never, headers: { 'content-type': 'application/json' } });
  } finally { await app.close(); await t.hub.stop(); }
});
