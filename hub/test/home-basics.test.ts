import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { AiAssistant } from '../src/assistant/ai.ts';

// The basics anyone does from the app, without Ask Kova: rooms (to "unassigned"), groups of rooms, archiving a
// device, and making, changing and deleting modes and overlays.

const webRoot = resolve(import.meta.dirname, '../../web');

async function setup(hour = 12) {
  const t = await testHub(hour);
  const app = await buildServer(t.hub, { webRoot });
  const call = (method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload: payload ?? {} });
  const state = async () => (await app.inject({ method: 'GET', url: '/api/state' })).json();
  return { ...t, app, call, state, done: async () => { await app.close(); await t.hub.stop(); } };
}

test('Rooms: deleting one can leave its devices in no room, and they can be put back in a room', async () => {
  const s = await setup();
  try {
    const inLounge = s.hub.reg.list().filter(d => d.room === 'lounge').map(d => d.id);
    assert.ok(inLounge.length > 1);
    // Groups and speaker groups that named the room forget it.
    await s.call('POST', '/api/groups', { name: 'Downstairs', rooms: ['lounge', 'kitchen'] });
    let r = await s.call('DELETE', '/api/rooms/lounge', { moveTo: 'unassigned' });
    assert.equal(r.statusCode, 200, r.body);
    for (const id of inLounge) assert.equal(s.hub.reg.get(id)!.room, 'unassigned', id);
    assert.deepEqual(s.hub.config.get().groups.Downstairs, ['kitchen']);
    assert.equal(s.hub.reg.get('lamp')!.original!.room, 'lounge', 'the integration’s room is remembered');
    // A device is given a room again, or put in none by hand.
    assert.equal((await s.call('PATCH', '/api/devices/lamp/settings', { room: 'office' })).statusCode, 200);
    assert.equal(s.hub.reg.get('lamp')!.room, 'office');
    assert.equal((await s.call('PATCH', '/api/devices/lamp/settings', { room: 'unassigned' })).statusCode, 200);
    assert.equal(s.hub.reg.get('lamp')!.room, 'unassigned');
    // Undo of the delete brings the room and its devices back.
    await s.call('POST', `/api/undo/${r.json().undo}`);
    assert.ok(s.hub.config.get().rooms.some(x => x.id === 'lounge'));
    // "unassigned" is never a real room's id.
    r = await s.call('POST', '/api/rooms', { name: 'Unassigned' });
    assert.equal(r.json().id, 'unassigned_2');
  } finally { await s.done(); }
});

test('Groups of rooms: made, renamed, changed and deleted; the assistant uses them', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/api/groups', { name: 'Upstairs', rooms: ['master', 'office'] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual((await s.state()).groups, { Upstairs: ['master', 'office'] });
    assert.equal((await s.call('POST', '/api/groups', { name: 'upstairs', rooms: ['master'] })).statusCode, 400, 'names are unique');
    assert.equal((await s.call('POST', '/api/groups', { name: 'Hall', rooms: [] })).statusCode, 400, 'at least one room');
    assert.equal((await s.call('POST', '/api/groups', { name: 'Hall', rooms: ['nowhere'] })).statusCode, 400);
    assert.equal((await s.call('POST', '/api/groups', { name: 'Kitchen', rooms: ['office'] })).statusCode, 400, 'not a room’s name');
    // The assistant turns off a group's lights by its name.
    const parsed = (await s.app.inject({ method: 'POST', url: '/api/ask/parse', payload: { text: 'turn off the upstairs lights' } })).json();
    assert.equal(parsed.understood, true, JSON.stringify(parsed));

    r = await s.call('PUT', '/api/groups/Upstairs', { name: 'First floor', rooms: ['master'] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(s.hub.config.get().groups, { 'First floor': ['master'] });
    assert.equal((await s.call('PUT', '/api/groups/nope', { rooms: ['master'] })).statusCode, 404);
    r = await s.call('DELETE', `/api/groups/${encodeURIComponent('First floor')}`);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(s.hub.config.get().groups, {});
    await s.call('POST', `/api/undo/${r.json().undo}`);
    assert.deepEqual(s.hub.config.get().groups, { 'First floor': ['master'] });
  } finally { await s.done(); }
});

test('Archiving a device: out of favourites, the assistant and alerts; modes leave it alone; restoring brings it back', async () => {
  const s = await setup();
  try {
    await s.call('PATCH', '/api/devices/lamp/settings', { favourite: true });
    let r = await s.call('PATCH', '/api/devices/lamp/settings', { archived: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(s.hub.reg.get('lamp')!.archived, true);
    assert.deepEqual(s.hub.config.get().favourites, [], 'off the Now screen');
    assert.equal((await s.state()).devices.find((d: { id: string }) => d.id === 'lamp').archived, true);
    // Can't be favourited while archived.
    await s.call('PATCH', '/api/devices/lamp/settings', { favourite: true });
    assert.deepEqual(s.hub.config.get().favourites, []);
    // Modes skip it.
    const before = s.hub.reg.get('lamp')!.state.on;
    await s.hub.reg.applyTargets({ lamp: { on: !before } }, { kind: 'mode', label: 'Test' });
    assert.equal(s.hub.reg.get('lamp')!.state.on, before, 'an archived device isn’t switched');
    // Not in what the assistant is told about.
    const ai = new AiAssistant(s.hub.engine, s.hub.reg, s.hub.config, s.hub.store);
    const ctx = ai.buildContext({ names: true, rooms: true, history: false, presence: false, cameras: false });
    assert.ok(!JSON.stringify(ctx).includes('lamp'), 'the assistant doesn’t see it');
    assert.equal((await s.call('PATCH', '/api/devices/lamp/settings', { archived: 'yes' })).statusCode, 400);
    // Restored.
    await s.call('PATCH', '/api/devices/lamp/settings', { archived: false });
    assert.equal(s.hub.reg.get('lamp')!.archived, undefined);
    await s.hub.reg.applyTargets({ lamp: { on: !before } }, { kind: 'mode', label: 'Test' });
    assert.equal(s.hub.reg.get('lamp')!.state.on, !before);
  } finally { await s.done(); }
});

test('Modes: a new one goes where it starts in the day; renamed, recoloured; deleted unless an automation needs it', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/api/modes', { name: 'Dinner', icon: 'restaurant', color: '#E0A060', start: { kind: 'time', at: '18:30' }, copyFrom: 'evening' });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    assert.equal(id, 'dinner');
    const modes = s.hub.config.get().modes;
    const i = modes.findIndex(m => m.id === id);
    assert.ok(i > 0 && modes[i + 1].id === 'wind', `between the modes before and after 18:30: ${modes.map(m => m.id)}`);
    assert.deepEqual(modes[i].targets, modes.find(m => m.id === 'evening')!.targets, 'copied');
    assert.equal(modes[i].color, '#e0a060');
    assert.equal((await s.call('POST', '/api/modes', { name: 'dinner', start: { kind: 'time', at: '19:00' } })).statusCode, 400, 'names are unique');
    assert.equal((await s.call('POST', '/api/modes', { name: 'Late', start: { kind: 'time', at: '26:00' } })).statusCode, 400);
    assert.equal((await s.call('POST', '/api/modes', { name: 'Late', color: 'red', start: { kind: 'time', at: '22:00' } })).statusCode, 400);

    r = await s.call('PUT', `/api/modes/${id}`, { name: 'Supper', icon: 'dinner_dining', color: '#aa5500' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual((({ name, icon, color }) => ({ name, icon, color }))(s.hub.config.get().modes.find(m => m.id === id)!), { name: 'Supper', icon: 'dinner_dining', color: '#aa5500' });

    // An automation that starts with the mode keeps it.
    const a = await s.call('POST', '/api/automations', { name: 'Supper music', enabled: true, mode: 'single', triggers: [{ kind: 'mode', mode: id }], conditions: [], actions: [{ kind: 'notify', message: 'Supper' }] });
    assert.equal(a.statusCode, 200, a.body);
    r = await s.call('DELETE', `/api/modes/${id}`);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Supper music/);
    await s.call('DELETE', `/api/automations/${a.json().id}`);
    r = await s.call('DELETE', `/api/modes/${id}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!s.hub.config.get().modes.some(m => m.id === id));
    await s.call('POST', `/api/undo/${r.json().undo}`);
    assert.ok(s.hub.config.get().modes.some(m => m.id === id));
  } finally { await s.done(); }
});

test('Modes: deleting the one that’s on carries on in the one before it; the last mode stays', async () => {
  const s = await setup(21);
  try {
    assert.equal(s.hub.engine.modeId, 'wind');
    const r = await s.call('DELETE', '/api/modes/wind');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(s.hub.engine.modeId, 'evening');
    for (const m of s.hub.config.get().modes.slice(1)) await s.call('DELETE', `/api/modes/${m.id}`);
    assert.equal(s.hub.config.get().modes.length, 1);
    assert.equal((await s.call('DELETE', `/api/modes/${s.hub.config.get().modes[0].id}`)).statusCode, 400);
  } finally { await s.done(); }
});

test('Overlays: made (or copied), how they end, changed, deleted; not while on', async () => {
  const s = await setup();
  try {
    let r = await s.call('POST', '/api/overlays', { name: 'Reading', icon: 'menu_book', ends: { kind: 'time', at: { kind: 'time', at: '23:00' } }, targets: { lamp: { on: true, bri: 60 } } });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    let o = (await s.state()).overlays.find((x: { id: string }) => x.id === id);
    assert.equal(o.endsLabel, 'Ends at 23:00');
    assert.deepEqual(o.ends, { kind: 'time', at: { kind: 'time', at: '23:00' } });
    assert.equal(o.targets[0].deviceId, 'lamp');

    r = await s.call('PUT', `/api/overlays/${id}`, { name: 'Quiet reading', ends: { kind: 'device_off', device: 'lamp' }, allOff: true });
    assert.equal(r.statusCode, 200, r.body);
    o = (await s.state()).overlays.find((x: { id: string }) => x.id === id);
    assert.equal(o.name, 'Quiet reading');
    assert.equal(o.endsLabel, 'Ends when the lamp turns off');
    assert.equal(o.allOff, true);
    await s.call('PUT', `/api/overlays/${id}`, { ends: { kind: 'arrival' }, allOff: false });
    assert.equal(s.hub.config.get().overlays.find(x => x.id === id)!.endsLabel, 'Ends when someone comes home');
    assert.equal((await s.call('PUT', `/api/overlays/${id}`, { ends: { kind: 'device_off', device: 'nope' } })).statusCode, 400);
    assert.equal((await s.call('POST', '/api/overlays', { name: 'Quiet READING' })).statusCode, 400, 'names are unique');

    // A copy keeps what the original does.
    r = await s.call('POST', '/api/overlays', { name: 'Movie night', copyFrom: 'movie' });
    assert.deepEqual(s.hub.config.get().overlays.find(x => x.id === r.json().id)!.targets, s.hub.config.get().overlays.find(x => x.id === 'movie')!.targets);

    // Not while it's on.
    await s.call('POST', `/api/overlays/${id}/start`);
    assert.equal((await s.call('DELETE', `/api/overlays/${id}`)).statusCode, 400);
    await s.call('POST', '/api/overlays/end');
    r = await s.call('DELETE', `/api/overlays/${id}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(!s.hub.config.get().overlays.some(x => x.id === id));
  } finally { await s.done(); }
});
