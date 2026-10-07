import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_KINDS, CONDITION_KINDS, TRIGGER_KINDS, bodyOf, canMove, changeKind, clockOf, commandFromKey, commandKey, ctxOf, dayOn, daysWords,
  deviceLabel, deviceSections, draftOf, filterAutomations, getAt, haState, lastRunLine, minToSec, moveAt, newAction, newCondition, newTrigger,
  parseClock, pushAt, removeAt, retarget, rhythmFromKey, rhythmKey, rhythmWords, sameDraft, secToMin, setAt, splitSeconds, stateFromKey, stateKey,
  toSeconds, runTime, automationsOf, ideasOf, startRun, runMessage, toggleDay, toggleIn, withCurrent, withOffset, withPending, type Draft, type HaAutomation,
} from '../src/logic/automations.ts';
import type { Device, Room } from '../src/api/types.ts';

const dev = (id: string, type: Device['type'], room: string, caps: string[] = ['onoff']) => ({ id, name: id[0].toUpperCase() + id.slice(1), room, type, capabilities: caps });
const devices = [dev('door', 'camera', 'front'), dev('lamp', 'dimmer', 'lounge', ['onoff', 'brightness']), dev('speaker', 'media', 'kitchen', ['onoff', 'media']), dev('box', 'tv', 'lounge', ['onoff', 'media', 'library']), dev('aircon', 'climate', 'lounge')];
const rooms: Room[] = [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }, { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' }, { id: 'front', name: 'Front', icon: 'door_front' }];
const ctx = ctxOf({ devices, sources: [{ name: 'Rain' }], modes: [{ id: 'day' }], overlays: [{ id: 'movie' }], automations: [{ id: 'self' }, { id: 'other' }], self: 'self' });

const tree = (): Draft => ({
  name: 'Test', enabled: true, mode: 'single',
  triggers: [{ kind: 'time', at: { kind: 'time', at: '07:00' } }],
  conditions: [{ kind: 'any', conditions: [{ kind: 'presence', who: 'anyone', home: true }, { kind: 'mode', modes: ['day'] }] }],
  actions: [{ kind: 'if', conditions: [], then: [{ kind: 'delay', seconds: 60 }, { kind: 'stop' }], else: [] }],
});

test('updates by path copy only the path, and leave the original alone', () => {
  const a = tree();
  const b = setAt(a, ['actions', 0, 'then', 0, 'seconds'], 120);
  assert.equal(getAt(b, ['actions', 0, 'then', 0, 'seconds']), 120);
  assert.equal(getAt(a, ['actions', 0, 'then', 0, 'seconds']), 60, 'original unchanged');
  assert.equal(b.triggers, a.triggers, 'untouched branches are shared');
  assert.notEqual(b.actions, a.actions);
  // undefined drops an object key
  const c = setAt(a, ['conditions', 0, 'conditions', 0, 'home'], undefined);
  assert.equal('home' in (getAt(c, ['conditions', 0, 'conditions', 0]) as object), false);
  // a missing list is made
  const d = pushAt({ x: {} }, ['x', 'list'], 1);
  assert.deepEqual(d, { x: { list: [1] } });
});

test('remove, push and move in nested lists', () => {
  const a = tree();
  const r = removeAt(a, ['conditions', 0, 'conditions', 0]);
  assert.deepEqual(getAt(r, ['conditions', 0, 'conditions']), [{ kind: 'mode', modes: ['day'] }]);
  const m = moveAt(a, ['actions', 0, 'then', 0], 1);
  assert.deepEqual((getAt(m, ['actions', 0, 'then']) as { kind: string }[]).map(x => x.kind), ['stop', 'delay']);
  assert.equal(moveAt(a, ['actions', 0, 'then', 0], -1), a, 'no move past the top');
  assert.equal(canMove(a, ['actions', 0, 'then', 1], 1), false);
  assert.equal(canMove(a, ['actions', 0, 'then', 1], -1), true);
  const p = pushAt(a, ['actions', 0, 'else'], { kind: 'stop' });
  assert.equal((getAt(p, ['actions', 0, 'else']) as unknown[]).length, 1);
  // removing a key from an object (a device from a step's targets)
  const s = removeAt({ t: { a: 1, b: 2 } }, ['t', 'a']);
  assert.deepEqual(s, { t: { b: 2 } });
});

test('every kind has a default, from the home', () => {
  assert.equal(ctx.device, 'door');
  assert.equal(ctx.actDevice, 'lamp', 'cameras are not set');
  assert.deepEqual(ctx.actCommand, { on: true });
  assert.equal(ctx.other, 'other', 'never itself');
  for (const k of TRIGGER_KINDS) assert.equal(newTrigger(k.v, ctx).kind, k.v);
  for (const k of CONDITION_KINDS) assert.equal(newCondition(k.v, ctx).kind, k.v);
  for (const k of ACTION_KINDS) assert.equal(newAction(k.v, ctx).kind, k.v);
  assert.deepEqual(newTrigger('device', ctx), { kind: 'device', device: 'door', to: { on: true } });
  assert.deepEqual(newCondition('any', ctx), { kind: 'any', conditions: [{ kind: 'device', device: 'door', is: { on: true } }] });
  assert.deepEqual(newAction('set', ctx), { kind: 'set', targets: { lamp: { on: true } } });
  assert.deepEqual(newAction('if', ctx), { kind: 'if', conditions: [{ kind: 'device', device: 'door', is: { on: true } }], then: [], else: [] });
  assert.deepEqual(newCondition('mode', {}), { kind: 'mode', modes: [] });
});

test('changing kind keeps the device and a group keeps its conditions', () => {
  const t = changeKind({ kind: 'device', device: 'lamp', to: { on: true } }, newTrigger('numeric', ctx));
  assert.deepEqual(t, { kind: 'numeric', device: 'lamp', field: 'temp', above: 28 });
  const g = changeKind({ kind: 'any', conditions: [{ kind: 'mode', modes: ['day'] }] }, newCondition('not', ctx));
  assert.deepEqual(g, { kind: 'not', conditions: [{ kind: 'mode', modes: ['day'] }] });
  assert.deepEqual(changeKind({ kind: 'device', device: 'lamp', is: { on: true } }, newCondition('presence', ctx)), { kind: 'presence', who: 'anyone', home: true });
});

test('a state match keys the same whatever order its keys come in', () => {
  assert.equal(stateKey({ input: 'hdmi2', on: true }), stateKey({ on: true, input: 'hdmi2' }));
  assert.deepEqual(stateFromKey(stateKey({ on: false })), { on: false });
  assert.equal(stateFromKey(''), undefined);
  assert.equal(stateKey(undefined), '');
  assert.deepEqual(commandFromKey(commandKey({ on: true, bri: 40 })), { bri: 40, on: true });
});

test('swapping a device in a step keeps its place', () => {
  const t = { a: { on: true }, b: { on: false }, c: { on: true } };
  assert.deepEqual(Object.keys(retarget(t, 'b', 'x', { on: true, bri: 5 })), ['a', 'x', 'c']);
  assert.deepEqual(retarget(t, 'b', 'x', { on: true, bri: 5 }).x, { on: true, bri: 5 });
  assert.deepEqual(Object.keys(retarget(t, 'a', 'c', { on: false })), ['c', 'b'], 'picking one already there merges');
});

test('rhythms: clock, sun and prayer, with offsets', () => {
  assert.equal(rhythmKey({ kind: 'sun', event: 'sunset' }), 'sun:sunset');
  assert.equal(rhythmKey(undefined), 'time');
  assert.deepEqual(rhythmFromKey('prayer:isha', { kind: 'sun', event: 'sunset', offsetMin: -10 }), { kind: 'prayer', prayer: 'isha', offsetMin: -10 });
  assert.deepEqual(rhythmFromKey('time', { kind: 'time', at: '06:30' }), { kind: 'time', at: '06:30' });
  assert.deepEqual(rhythmFromKey('time', { kind: 'sun', event: 'sunset' }), { kind: 'time', at: '21:00' });
  assert.deepEqual(withOffset({ kind: 'sun', event: 'dusk', offsetMin: 5 }, 0), { kind: 'sun', event: 'dusk' });
  assert.deepEqual(withOffset({ kind: 'sun', event: 'dusk' }, -15), { kind: 'sun', event: 'dusk', offsetMin: -15 });
  assert.equal(rhythmWords({ kind: 'sun', event: 'sunset', offsetMin: -15 }), '15 min before sunset');
  assert.equal(rhythmWords({ kind: 'prayer', prayer: 'fajr' }), 'Fajr');
  assert.deepEqual(parseClock('7:05'), [7, 5]);
  assert.deepEqual(parseClock('nonsense'), [21, 0]);
  assert.equal(clockOf(25, -5), '01:55');
});

test('days: none means every day, and the last one off goes back to every day', () => {
  assert.deepEqual(toggleDay(undefined, 0), [1, 2, 3, 4, 5, 6]);
  assert.equal(toggleDay([1, 2, 3, 4, 5, 6], 0), undefined);
  assert.equal(toggleDay([3], 3), undefined);
  assert.deepEqual(toggleDay([5], 1), [1, 5]);
  assert.equal(dayOn(undefined, 4), true);
  assert.equal(dayOn([1], 4), false);
  assert.equal(daysWords([1, 2, 3, 4, 5]), 'weekdays');
  assert.equal(daysWords([6, 0]), 'weekends');
  assert.equal(daysWords([1, 3]), 'Mon, Wed');
  assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
});

test('durations: seconds in the biggest unit, minutes with one decimal', () => {
  assert.deepEqual(splitSeconds(7200), { n: 2, unit: 'h' });
  assert.deepEqual(splitSeconds(300), { n: 5, unit: 'min' });
  assert.deepEqual(splitSeconds(90), { n: 90, unit: 's' });
  assert.equal(toSeconds(1.5, 'min'), 90);
  assert.equal(secToMin(90), 1.5);
  assert.equal(secToMin(0), undefined);
  assert.equal(minToSec(2), 120);
  assert.equal(minToSec(undefined), undefined);
});

test('drafts: from an automation or a suggestion, and the body sent on save', () => {
  const view = { id: 'x', ...tree(), description: '  ', triggerLabels: ['At 07:00'], lastRun: null, running: 0 };
  const d = draftOf(view);
  assert.equal('id' in d, false);
  assert.equal('triggerLabels' in d, false);
  d.triggers.push({ kind: 'hub', event: 'start' });
  assert.equal(view.triggers.length, 1, 'a copy');
  const idea = draftOf({ key: 'k', why: 'w', name: 'Idea', mode: 'single', triggers: [], conditions: [], actions: [] });
  assert.equal(idea.enabled, true);
  const b = bodyOf({ ...tree(), name: ' Lights ', description: '  ', triggers: [{ kind: 'presence', event: 'arrives', person: undefined }] });
  assert.equal(b.name, 'Lights');
  assert.equal('description' in b, false);
  assert.equal('person' in b.triggers[0], false);
  assert.ok(sameDraft(tree(), { ...tree(), description: '' }));
  assert.ok(!sameDraft(tree(), setAt(tree(), ['name'], 'Other')));
  assert.deepEqual(draftOf(null).triggers, []);
  const ha = draftOf({ ...tree(), id: 'y', origin: { from: 'home-assistant', id: '1', notes: ['a template'] } });
  assert.deepEqual(ha.origin?.notes, ['a template']);
});

test('device picker: by room, in the home’s order, searchable', () => {
  const s = deviceSections(devices, rooms, '');
  assert.deepEqual(s.map(x => x.room), ['Lounge', 'Kitchen', 'Front']);
  assert.deepEqual(s[0].items.map(x => x.label), ['Aircon', 'Box', 'Lamp']);
  assert.deepEqual(deviceSections(devices, rooms, 'lounge la').flatMap(x => x.items.map(i => i.v)), ['lamp']);
  assert.deepEqual(deviceSections(devices, rooms, '', d => d.type !== 'camera').map(x => x.room), ['Lounge', 'Kitchen']);
  assert.equal(deviceLabel('lamp', devices, rooms), 'Lounge · Lamp');
  assert.equal(deviceLabel('gone', devices, rooms), 'gone (missing)');
});

test('the list: last run lines, search, HA state, optimistic on/off', () => {
  assert.deepEqual(lastRunLine(null), ['Not run yet', '#6f6d69']);
  assert.deepEqual(lastRunLine({ at: 0, atLabel: '07:00', result: 'skipped', why: 'x', detail: 'No one is home' }), ['Skipped 07:00 · No one is home', '#a3a09a']);
  assert.deepEqual(lastRunLine({ at: 0, atLabel: '07:00', result: 'done', why: 'x', detail: 'ignored' }), ['Ran 07:00', '#7fd4a0']);
  assert.equal(lastRunLine({ at: 0, atLabel: '07:00', result: 'failed', why: 'x', detail: null })[1], '#ff6b5e');
  const l = [{ name: 'Porch', triggerLabels: ['At sunset'] }, { name: 'TV off', actionLabels: ['Turn the lounge TV off'], description: 'evenings' }];
  assert.deepEqual(filterAutomations(l, 'sunset').map(a => a.name), ['Porch']);
  assert.deepEqual(filterAutomations(l, 'lounge evenings').map(a => a.name), ['TV off']);
  assert.equal(filterAutomations(l, '  ').length, 2);
  const ha = (x: Partial<HaAutomation>): HaAutomation => ({ id: '1', name: 'n', enabled: true, when: [], cond: [], then: [], converted: null, notes: [], convertible: true, ...x });
  assert.deepEqual(haState(ha({ notes: ['a'] })), { text: 'Can convert · 1 part left out', colour: '#f2b14c', canConvert: true });
  assert.equal(haState(ha({ converted: 'k' })).canConvert, false);
  assert.equal(haState(ha({ convertible: false })).text, 'Needs rebuilding in Kova');
  const { list, settled } = withPending([{ id: 'a', enabled: false }, { id: 'b', enabled: true }], { a: true, b: true, gone: false });
  assert.deepEqual(list.map(x => x.enabled), [true, true]);
  assert.deepEqual(settled.sort(), ['b', 'gone']);
  assert.deepEqual(withCurrent([{ v: 'a', label: 'A' }], 'z').map(o => o.v), ['a', 'z']);
});

test('run now: the answer, or "running" when it takes longer', async () => {
  assert.equal(await startRun(Promise.resolve('done'), 50), 'done');
  assert.equal(await startRun(new Promise(r => setTimeout(() => r('late'), 200)), 20), 'running');
  await assert.rejects(startRun(Promise.reject(new Error('no')), 50), /no/);
  assert.equal(await startRun(new Promise((_, j) => setTimeout(() => j(new Error('late')), 60)), 10), 'running', 'a late failure is swallowed');
  await new Promise(r => setTimeout(r, 80));
});

test('run times and the snapshot’s lists', () => {
  assert.equal(runTime(new Date(2026, 9, 1, 7, 5).getTime()), '1 Oct 07:05');
  assert.deepEqual(automationsOf({}), []);
  assert.deepEqual(ideasOf(null), []);
  assert.equal(automationsOf({ automations: [{ id: 'a' }] }).length, 1);
});

test('run now messages', () => {
  assert.deepEqual(runMessage('Porch', 'running'), { text: 'Porch is running', ok: true, error: false });
  assert.deepEqual(runMessage('Porch', { ran: true, running: true, run: null }), { text: 'Porch is running', ok: true, error: false }, 'the hub answered before the run ended');
  assert.deepEqual(runMessage('Porch', { ran: false, why: 'No one is home' }), { text: 'Porch: No one is home', ok: false, error: false });
  assert.equal(runMessage('Porch', { ran: true, run: { result: 'failed', detail: 'Lamp is offline' } as never }).text, 'Porch: failed · Lamp is offline');
  assert.equal(runMessage('Porch', { ran: true, run: { result: 'done' } as never }).text, 'Porch: done');
});
