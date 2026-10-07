import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { Presence, INDOOR } from '../src/services/presence.ts';
import { inQuiet } from '../src/services/security.ts';
import { automationIdeas } from '../src/engine/automation-ideas.ts';
import { checkAutomation } from '../src/engine/automation-check.ts';
import { triggerWords, condWords } from '../src/engine/automations.ts';
import { AiAssistant, defaultSettings } from '../src/assistant/ai.ts';
import type { Notification } from '../src/services/notify.ts';
import type { Automation } from '../src/model/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise(r => setTimeout(r, 40));

/** A demo hub whose alerts are collected instead of sent. */
async function alertHub(startHour = 12, tweak?: Parameters<typeof testHub>[1]) {
  const t = await testHub(startHour, tweak);
  const sent: Notification[] = [];
  t.hub.security.notify = async n => { sent.push(n); };
  const event = async (id: string, type: string, data: Record<string, unknown> = {}) => { t.hub.reg.deviceEvent(id, type, data); await settle(); await t.hub.security.idle(); };
  const away = async () => { for (const p of t.hub.config.get().people) await t.hub.engine.setPresence(p.id, false, 'test'); };
  return { ...t, sent, event, away };
}

test('cameras can be put in a room, like any device, and that room is where their events happen', async () => {
  const t = await alertHub();
  const app = await buildServer(t.hub, { webRoot });
  try {
    const r = await app.inject({ method: 'PATCH', url: '/api/devices/office_cam/settings', payload: { room: 'lounge' } });
    assert.equal(r.statusCode, 200);
    assert.equal(t.hub.reg.get('office_cam')!.room, 'lounge');
    assert.deepEqual(t.hub.reg.get('office_cam')!.original, { name: 'Camera', room: 'office' });
    await t.event('office_cam', 'person');
    assert.equal(t.hub.engine.rooms.status('lounge').active, true, 'its new room is active');
    assert.equal(t.hub.engine.rooms.status('office').active, false);
    const s = (await app.inject({ url: '/api/state' })).json();
    assert.equal(s.roomStatus.lounge.last.kind, 'person');
    assert.equal(s.security.devices.office_cam.outdoor, false);
    assert.equal(s.security.devices.doorbell.outdoor, true);
    // Back where the integration put it.
    await app.inject({ method: 'PATCH', url: '/api/devices/office_cam/settings', payload: { room: null } });
    assert.equal(t.hub.reg.get('office_cam')!.room, 'office');
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/devices/office_cam/settings', payload: { room: 'nowhere' } })).statusCode, 400);
  } finally { await app.close(); await t.hub.stop(); }
});

test('camera events: a timeline per camera and per room, each with the frame kept from its camera', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-frames-'));
  const t = await testHub(12, undefined, { security: { framesDir: dir, settleMs: 5, frameDelayMs: 5, keepFrames: 2 } });
  const app = await buildServer(t.hub, { webRoot });
  try {
    t.hub.reg.deviceEvent('doorbell', 'person', { eventId: 'e1' });
    t.clock.t = at(12.1);
    t.hub.reg.deviceEvent('doorbell', 'ring');
    t.clock.t = at(12.2);
    t.hub.reg.deviceEvent('garage_cam', 'motion');
    t.virtual.physical('garage_contact', { open: true });
    await settle(); await t.hub.security.idle();
    const door = (await app.inject({ url: '/api/timeline?device=doorbell' })).json().events;
    assert.deepEqual(door.map((e: { kind: string }) => e.kind), ['ring', 'person'], 'newest first');
    assert.match(door[0].frame, /^\/api\/frames\/doorbell\/\d+$/);
    const img = await app.inject({ url: door[0].frame });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/svg+xml');
    assert.match(img.body, /Doorbell/);
    const garage = (await app.inject({ url: '/api/timeline?room=garage' })).json().events;
    assert.deepEqual(garage.map((e: { kind: string; source: string }) => `${e.kind}:${e.source}`), ['opened:sensor', 'motion:camera'], 'cameras and sensors of the room');
    assert.equal(garage[0].frame, null, 'sensors have no pictures');
    assert.equal((await app.inject({ url: '/api/timeline?kinds=person' })).json().events.length, 1);
    assert.equal((await app.inject({ url: '/api/timeline?kinds=dragons' })).statusCode, 400);
    // Only the newest frames per camera are kept.
    t.hub.reg.deviceEvent('doorbell', 'person');
    await settle(); await t.hub.security.idle();
    assert.equal(readdirSync(join(dir, 'doorbell')).length, 2);
    assert.equal((await app.inject({ url: '/api/frames/doorbell/999999' })).statusCode, 404);
    // The snapshot carries the latest events across the home.
    const s = (await app.inject({ url: '/api/state' })).json();
    assert.ok(s.security.recent.length >= 4 && s.security.recent[0].roomName);
  } finally { await app.close(); await t.hub.stop(); rmSync(dir, { recursive: true }); }
});

test('smart alerts: someone at the door names the room; inside only while nobody’s home; motion never while home', async () => {
  const t = await alertHub(12);
  try {
    await t.event('doorbell', 'person');
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].title, 'Someone’s at the front door');
    assert.match(t.sent[0].url!, /cam=doorbell/);
    // The camera's motion and person for the same moment are one alert, the person.
    await t.event('office_cam', 'motion');
    await t.event('office_cam', 'person');
    assert.equal(t.sent.length, 1, 'someone’s home: nothing from inside');
    assert.equal(t.hub.security.recent()[0].why, 'someone’s home');
    await t.away();
    t.clock.t = at(12.5);
    t.hub.reg.deviceEvent('office_cam', 'motion');
    t.hub.reg.deviceEvent('office_cam', 'person');
    await settle(); await t.hub.security.idle();
    assert.equal(t.sent.length, 2, 'one alert for both');
    assert.equal(t.sent[1].title, 'Someone’s in the Office while nobody’s home');
    assert.match(t.sent[1].body, /Nobody’s marked home/);
    // A door opening while nobody's home.
    t.virtual.physical('garage_contact', { open: true });
    await settle();
    assert.equal(t.sent[2].title, 'Garage door opened while nobody’s home');
    assert.equal(t.sent[2].url, '/phone.html?page=sensors');
  } finally { await t.hub.stop(); }
});

test('alerts: cooldown and de-duplication, stronger covers weaker, quiet hours, per-room and per-camera choices', async () => {
  const t = await alertHub(12);
  try {
    await t.away();
    await t.event('office_cam', 'person');
    t.clock.t = at(12.02);
    await t.event('office_cam', 'person');
    assert.equal(t.sent.length, 1, 'the same alert from the same room waits out the cooldown');
    assert.match(t.hub.security.recent()[0].why, /already told/);
    t.clock.t = at(12.05);
    await t.event('office_cam', 'motion');
    assert.equal(t.sent.length, 1, 'motion just after a person is covered');
    t.clock.t = at(12.2);
    await t.event('office_cam', 'person');
    assert.equal(t.sent.length, 2, 'after the cooldown, again');
    // Per room: no motion alerts from the garage; per camera: the office camera never alerts on people.
    const app = await buildServer(t.hub, { webRoot });
    assert.equal((await app.inject({ method: 'PUT', url: '/api/security/settings', payload: { rooms: { garage: { motion: 'never' } }, cooldownMin: 1 } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/devices/office_cam/settings', payload: { alerts: { person: 'never' } } })).statusCode, 200);
    t.clock.t = at(12.5);
    await t.event('garage_cam', 'motion');
    await t.event('office_cam', 'person');
    assert.equal(t.sent.length, 2);
    assert.match(t.hub.security.recent()[0].why, /person alerts are off for Camera/);
    // Quiet hours hold back what isn't urgent: with someone home, a person at the door waits; the doorbell doesn't.
    assert.equal((await app.inject({ method: 'PUT', url: '/api/security/settings', payload: { quiet: { from: '22:00', to: '07:00' } } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/security/settings', payload: { quiet: { from: 'late', to: '07:00' } } })).statusCode, 400);
    await t.hub.engine.setPresence('methel', true, 'test');
    t.clock.t = at(23);
    await t.event('doorbell', 'person');
    assert.equal(t.sent.length, 2, 'quiet hours');
    assert.equal(t.hub.security.recent()[0].why, 'quiet hours');
    t.hub.reg.deviceEvent('doorbell', 'ring');
    assert.equal(t.hub.security.allowRing({ device: t.hub.reg.get('doorbell')!, type: 'ring', data: {} }), true, 'the doorbell always gets through');
    t.hub.reg.deviceEvent('doorbell', 'ring');
    assert.equal(t.hub.security.allowRing({ device: t.hub.reg.get('doorbell')!, type: 'ring', data: {} }), false, 'pressed twice is one visitor');
    const g = (await app.inject({ url: '/api/security' })).json();
    assert.deepEqual([g.settings.quiet, g.settings.cooldownMin, g.quietNow], [{ from: '22:00', to: '07:00' }, 1, true]);
    assert.ok(g.decisions.length > 3);
    // Clearing a room's choices.
    await app.inject({ method: 'PUT', url: '/api/security/settings', payload: { rooms: { garage: null }, quiet: null } });
    assert.equal(t.hub.config.get().security!.rooms, undefined);
    assert.equal(t.hub.config.get().security!.quiet, undefined);
    await app.close();
  } finally { await t.hub.stop(); }
  assert.equal(inQuiet({ from: '22:00', to: '07:00' }, 6.9), true);
  assert.equal(inQuiet({ from: '22:00', to: '07:00' }, 12), false);
  assert.equal(inQuiet({ from: '13:00', to: '14:00' }, 13.5), true);
});

test('room activity in automations: “motion in a room” triggers (sensors and cameras), and room conditions', async () => {
  const t = await alertHub(21);
  try {
    const add = (a: Omit<Automation, 'id' | 'enabled' | 'mode'>, id: string) => t.hub.config.update(c => { (c.automations ??= []).push({ id, enabled: true, mode: 'single', ...a }); });
    add({ name: 'Kitchen motion', triggers: [{ kind: 'room', room: 'kitchen', event: 'motion' }], conditions: [], actions: [{ kind: 'set', targets: { kitchen_island: { on: true } } }] }, 'km');
    add({ name: 'Office quiet', triggers: [{ kind: 'every', minutes: 15 }], conditions: [{ kind: 'room', room: 'office', active: false, withinMin: 10 }], actions: [{ kind: 'set', targets: { office_light: { on: false } } }] }, 'oq');
    add({ name: 'Door opens', triggers: [{ kind: 'device', device: 'front_contact', to: { open: true } }], conditions: [], actions: [{ kind: 'set', targets: { front_1: { on: true } } }] }, 'do');
    add({ name: 'Humid', triggers: [{ kind: 'numeric', device: 'master_climate', field: 'humidity', above: 65 }], conditions: [], actions: [{ kind: 'set', targets: { master_purifier: { mode: 'Auto' } } }] }, 'hu');
    t.virtual.physical('kitchen_motion', { motion: true });
    await settle();
    assert.equal(t.hub.reg.get('kitchen_island')!.state.on, true, 'a motion sensor in the room');
    assert.equal(t.hub.engine.automations.lastRun('km')!.why, 'Motion in Kitchen');
    // A camera's person counts as motion; a second start within 30 s is the same motion.
    t.hub.config.update(c => { c.devices = { ...(c.devices ?? {}), garage_cam: { room: 'kitchen' } }; });
    t.hub.reg.deviceEvent('garage_cam', 'person');
    await settle();
    assert.equal(t.hub.engine.automations.history('km').length, 1, 'too soon after the last');
    t.clock.t = at(21.1);
    t.hub.reg.deviceEvent('garage_cam', 'person');
    await settle();
    assert.equal(t.hub.engine.automations.history('km').length, 2);
    // Room condition: the office has been still → its light goes off at the next quarter hour.
    await t.hub.engine.command('office_light', { on: true });
    await t.advance(21.26);
    await settle();
    assert.equal(t.hub.reg.get('office_light')!.state.on, false);
    await t.advance(21.45);
    t.hub.reg.deviceEvent('office_cam', 'motion');
    await t.hub.engine.command('office_light', { on: true });
    await t.advance(21.51);
    await settle();
    assert.equal(t.hub.engine.automations.lastRun('oq')!.result, 'skipped');
    assert.match(t.hub.engine.automations.lastRun('oq')!.detail!, /activity in Office/);
    // Sensor state and readings as device and numeric triggers.
    t.virtual.physical('front_contact', { open: true });
    await settle();
    assert.equal(t.hub.reg.get('front_1')!.state.on, true);
    t.virtual.physical('master_climate', { humidity: 70 });
    await settle();
    assert.equal(t.hub.engine.automations.lastRun('hu')!.result, 'done');
    // In words, and checked.
    const w = { reg: t.hub.reg, cfg: t.hub.config.get() };
    assert.equal(triggerWords({ kind: 'room', room: 'front', event: 'person' }, w), 'A person in Front door');
    assert.equal(condWords({ kind: 'room', room: 'office', active: false, withinMin: 10 }, w), 'no activity in Office for 10 min');
    const x = { device: (id: string) => t.hub.reg.get(id), cfg: t.hub.config.get() };
    assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'room', room: 'attic', event: 'motion' }], actions: [{ kind: 'stop' }] }, x), /Unknown room attic/);
    assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'room', room: 'front', event: 'dancing' }], actions: [{ kind: 'stop' }] }, x), /Choose what happens/);
    const ok = checkAutomation({ name: 'x', triggers: [{ kind: 'device', device: 'front_contact', to: { open: true } }], conditions: [{ kind: 'room', room: 'front', active: true }], actions: [{ kind: 'stop' }] }, x);
    assert.deepEqual(ok.conditions, [{ kind: 'room', room: 'front', active: true }]);
  } finally { await settle(); await t.hub.stop(); }
});

test('automation ideas from rooms, cameras and sensors: generic by room and kind', async () => {
  const t = await testHub(12);
  try {
    const cfg = t.hub.config.get();
    const keys = automationIdeas(cfg, t.hub.reg.devices, []).map(i => i.key);
    assert.ok(keys.includes('motion-light:kitchen'), 'motion sensor + lights in a room');
    assert.ok(keys.includes('door-light:front'), 'a door outside + lights there');
    assert.ok(!keys.includes('camera-light:front'), 'Light the way already lights the door for the doorbell');
    // Without Light the way on the doorbell: someone at the door after dark lights the porch.
    const bare = { ...cfg, lightTheWay: { triggers: [] } };
    const idea = automationIdeas(bare, t.hub.reg.devices, []).find(i => i.key === 'camera-light:front')!;
    assert.deepEqual(idea.triggers, [{ kind: 'room', room: 'front', event: 'person' }, { kind: 'room', room: 'front', event: 'ring' }]);
    assert.deepEqual(idea.conditions, [{ kind: 'time', after: { kind: 'sun', event: 'sunset' }, before: { kind: 'sun', event: 'sunrise' } }]);
    assert.deepEqual(Object.keys((idea.actions[0] as { targets: object }).targets), ['front_1', 'front_2']);
    checkAutomation({ ...idea, enabled: true }, { device: id => t.hub.reg.get(id), cfg });
    // Made already, or dismissed: not suggested again.
    const made = { ...bare, automations: [{ id: 'a', name: 'mine', enabled: true, mode: 'single' as const, triggers: [{ kind: 'room' as const, room: 'kitchen', event: 'motion' as const }], conditions: [], actions: [] }], dismissedFindings: ['idea:door-light:front'] };
    const k2 = automationIdeas(made, t.hub.reg.devices, []).map(i => i.key);
    assert.ok(!k2.includes('motion-light:kitchen') && !k2.includes('door-light:front'));
  } finally { await t.hub.stop(); }
});

test('presence: an indoor camera is only a weak “someone’s still in” hint, never who; outdoor cameras don’t count', async () => {
  const t = await testHub(12);
  const presence = new Presence(t.hub, { pingHosts: { methel: '10.255.255.1' }, probeTimeoutMs: 50, awayAfterMin: 0, pollSec: 0 });
  presence.start();
  try {
    // The phone drops off the network, but the office camera just saw someone: not away yet.
    t.hub.reg.deviceEvent('office_cam', 'person');
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, true);
    assert.ok(t.hub.engine.people.methel.evidence!.some(e => e.source === INDOOR && e.kind === 'camera' && e.weight < 0.2));
    // Twenty minutes later the hint has gone: away.
    t.clock.t = at(12.35);
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, false);
    // Now away: a person seen inside doesn't bring anyone home (it can't say who).
    t.hub.reg.deviceEvent('office_cam', 'person');
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, false);
    // Outdoor cameras and doorbells don't count at all.
    await t.hub.engine.setPresence('methel', true, 'test');
    t.clock.t = at(13);
    t.hub.reg.deviceEvent('doorbell', 'person');
    await presence.poll();
    assert.equal(t.hub.engine.people.methel.home, false);
  } finally { presence.stop(); await t.hub.stop(); }
});

test('Ask Kova: anything at the front door, motion in a room, a room’s temperature, a door open — from the history, locally', async () => {
  const t = await testHub(12);
  try {
    const ask = async (q: string) => (await t.hub.assistant.ask(q)).text;
    assert.equal(await ask('anything at the front door?'), 'Nothing at the Front door today.');
    t.clock.t = at(9);
    t.hub.reg.deviceEvent('doorbell', 'person');
    t.clock.t = at(11.5);
    t.hub.reg.deviceEvent('doorbell', 'person');
    t.hub.reg.deviceEvent('doorbell', 'ring');
    t.clock.t = at(12);
    assert.equal(await ask('Anything at the front door?'), 'Today at the Front door: the doorbell (11:30) and a person 2 times (last 11:30).');
    assert.equal(await ask('is anyone at the door right now'), 'Nothing in the last 10 minutes. Today at the Front door: the doorbell (11:30) and a person 2 times (last 11:30).');
    t.hub.reg.deviceEvent('garage_cam', 'motion');
    assert.equal(await ask('was there motion in the garage?'), 'Today in the Garage: motion (12:00).');
    assert.equal(await ask('is there anyone in the garage now'), 'Yes: Camera noticed motion just now.');
    assert.equal(await ask('any motion in the music room today'), 'There’s no camera or sensor in the Music room, so I can’t tell.');
    assert.equal(await ask('what’s the temperature in the lounge'), 'It’s 22.4° in the Lounge, 48% humidity (Climate sensor).');
    assert.equal(await ask('how humid is it in the master bed'), 'It’s 52% humidity in the Master bed (Climate sensor).');
    assert.equal(await ask('is the garage door open?'), 'Garage door is closed.');
    t.virtual.physical('garage_contact', { open: true });
    assert.equal(await ask('is the garage door open'), 'Garage door is open.');
    assert.deepEqual(t.hub.assistant.chips(t.hub.assistant.parse('anything at the front door?')), ['Cameras and sensors', 'Front door']);
  } finally { await t.hub.stop(); }
});

test('cloud AI context: cameras never; sensors read-only with readings; room activity only as summaries, and only when shared', async () => {
  const t = await testHub(12);
  try {
    t.hub.reg.deviceEvent('doorbell', 'person', { eventId: 'secret-session' });
    const ai = new AiAssistant(t.hub.engine, t.hub.reg, t.hub.config, t.hub.store);
    const share = defaultSettings().share;
    const ctx = ai.buildContext(share);
    assert.ok(!/doorbell|garage_cam|office_cam|secret-session/.test(ctx.text), 'no camera ids, names or event data');
    assert.match(ctx.text, /Sensors \(read only/);
    assert.match(ctx.text, /"id":"lounge_climate".*"temp":"22.4°"/);
    assert.ok(!/Room activity/.test(ctx.text), 'not shared by default');
    const withRooms = ai.buildContext({ ...share, security: true });
    assert.match(withRooms.text, /Room activity today \(from cameras and sensors; no pictures\): front: a person ×1, last 12:00/);
    assert.ok(withRooms.shared.includes('room activity'));
    assert.ok(!/Doorbell|secret-session|frame|\/api\/frames/.test(withRooms.text));
    // Without names, rooms are aliases.
    const anon = ai.buildContext({ ...share, names: false, security: true });
    assert.match(anon.text, /room10: a person/);
    assert.ok(!/Front door/.test(anon.text));
  } finally { await t.hub.stop(); }
});
