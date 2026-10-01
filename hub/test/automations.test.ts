import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { holds, inRange, matches, upgradeAutomation } from '../src/engine/automations.ts';
import type { Automation } from '../src/model/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise(r => setTimeout(r, 15));

/** A test hub at noon on a Wednesday, an API, and a clock to move on by seconds. */
async function setup(hour = 12) {
  const t = await testHub(hour);
  const app = await buildServer(t.hub, { webRoot });
  const sent: { title: string; body: string; people?: string[]; tag?: string }[] = [];
  t.hub.engine.automations.notify = async n => { sent.push(n); };
  const add = async (a: Partial<Automation>) => {
    const r = await app.inject({ method: 'POST', url: '/api/automations', payload: { mode: 'single', conditions: [], ...a } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().id as string;
  };
  /** Move the clock on and let runs carry on. */
  const later = async (sec: number) => { t.clock.t += sec * 1000; await t.hub.engine.tick(t.clock.t); await settle(); };
  const runs = (id: string) => t.hub.engine.automations.history(id);
  return { ...t, app, add, later, runs, sent, close: async () => { await app.close(); await t.hub.stop(); } };
}

test('device trigger, condition and set: the TV and speaker go off when the player shuts down, only on its input', async () => {
  const h = await setup();
  try {
    const id = await h.add({
      name: 'TV off with the box',
      triggers: [{ kind: 'device', device: 'living_display', to: { online: false } }],
      conditions: [{ kind: 'device', device: 'bedroom_tv', is: { on: true, input: 'hdmi4' } }],
      actions: [{ kind: 'set', targets: { bedroom_tv: { on: false }, master_speaker: { on: false } } }],
    });
    h.virtual.physical('bedroom_tv', { on: true, input: 'hdmi4' });
    h.virtual.physical('master_speaker', { on: true });
    h.virtual.physical('living_display', { online: false });
    await settle();
    assert.equal(h.dev('bedroom_tv').on, false);
    assert.equal(h.dev('master_speaker').on, false);
    assert.equal(h.runs(id)[0].result, 'done');
    assert.equal(h.runs(id)[0].why, 'Living room display turned offline');
    assert.equal(h.runs(id)[0].steps[0].text, 'Set Bedroom OLED, Speaker');
    assert.ok(h.hub.store.between(0, Number.MAX_SAFE_INTEGER, 'run').some(e => e.cause?.kind === 'automation' && /TV off with the box: /.test(e.what)), 'in Activity');

    // Another input: skipped, and the history says why.
    h.virtual.physical('living_display', { online: true });
    h.virtual.physical('bedroom_tv', { on: true, input: 'tv' });
    h.virtual.physical('living_display', { online: false });
    await settle();
    assert.equal(h.dev('bedroom_tv').on, true);
    assert.deepEqual([h.runs(id)[0].result, h.runs(id)[0].detail], ['skipped', 'Bedroom OLED isn’t on HDMI 4']);

    // In the snapshot, in words.
    const s = (await h.app.inject({ url: '/api/state' })).json();
    const a = s.automations.find((x: { id: string }) => x.id === id);
    assert.deepEqual(a.triggerLabels, ['Living room display turns offline']);
    assert.deepEqual(a.conditionLabels, ['Bedroom OLED is on HDMI 4']);
    assert.deepEqual(a.actionLabels, ['Bedroom OLED stops, Speaker stops']);
    assert.equal(a.lastRun.result, 'skipped');
    assert.ok(s.devices.find((d: { id: string }) => d.id === 'bedroom_tv').usedIn.some((u: { kind: string }) => u.kind === 'automation'));
  } finally { await h.close(); }
});

test('“for” a while: only once it has stayed so; turned back before then, nothing', async () => {
  const h = await setup();
  try {
    await h.add({ name: 'Lamp left on', triggers: [{ kind: 'device', device: 'office_plug', to: { on: true }, forSec: 300 }], actions: [{ kind: 'set', targets: { lamp: { on: true, bri: 20 } } }] });
    h.virtual.physical('office_plug', { on: false });
    h.virtual.physical('office_plug', { on: true });
    await h.later(200);
    assert.equal(h.dev('lamp').on, false, 'not yet');
    h.virtual.physical('office_plug', { on: false });
    await h.later(200);
    assert.equal(h.dev('lamp').on, false, 'turned back off before 5 min');
    h.virtual.physical('office_plug', { on: true });
    await h.later(301);
    assert.deepEqual([h.dev('lamp').on, h.dev('lamp').bri], [true, 20]);
  } finally { await h.close(); }
});

test('a reading crossing a value fires on the crossing, not while it stays there', async () => {
  const h = await setup();
  try {
    const id = await h.add({ name: 'Desk drawing a lot', triggers: [{ kind: 'numeric', device: 'office_plug', field: 'power', above: 1000 }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
    h.virtual.physical('office_plug', { power: 1500 });
    await settle();
    assert.equal(h.runs(id).length, 1);
    h.virtual.physical('office_plug', { power: 1800 });
    await settle();
    assert.equal(h.runs(id).length, 1, 'still above: no second start');
    h.virtual.physical('office_plug', { power: 20 });
    h.virtual.physical('office_plug', { power: 1200 });
    await settle();
    assert.equal(h.runs(id).length, 2);
  } finally { await h.close(); }
});

test('times, days and every few minutes', async () => {
  const h = await setup(21);
  try {
    // 2026-09-30 is a Wednesday (3).
    const wk = await h.add({ name: 'Weeknight', triggers: [{ kind: 'time', at: { kind: 'time', at: '21:30' }, days: [1, 2, 3, 4, 5] }], actions: [{ kind: 'set', targets: { lamp: { on: true, bri: 30 } } }] });
    const we = await h.add({ name: 'Weekend', triggers: [{ kind: 'time', at: { kind: 'time', at: '21:30' }, days: [0, 6] }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
    const ev = await h.add({ name: 'Every 15', triggers: [{ kind: 'every', minutes: 15 }], actions: [{ kind: 'set', targets: { dining: { on: true } } }] });
    await h.later(29 * 60);
    assert.equal(h.runs(wk).length, 0);
    await h.later(2 * 60);
    assert.equal(h.runs(wk).length, 1);
    assert.equal(h.runs(we).length, 0, 'not at weekends');
    assert.equal(h.runs(ev).length, 2, '21:15 and 21:30');
    assert.equal(h.runs(wk)[0].why, 'It’s 21:30 on weekdays');
  } finally { await h.close(); }
});

test('people, modes and overlays start automations; “last one out” and “first one home”', async () => {
  const h = await setup();
  try {
    const out = await h.add({ name: 'All off', triggers: [{ kind: 'presence', event: 'last-leaves' }], actions: [{ kind: 'set', targets: { lamp: { on: false } } }] });
    const home = await h.add({ name: 'Welcome', triggers: [{ kind: 'presence', event: 'first-arrives' }], actions: [{ kind: 'notify', message: 'Welcome home', people: ['methel'] }] });
    const movie = await h.add({ name: 'Movie lights', triggers: [{ kind: 'overlay', overlay: 'movie', event: 'starts' }], actions: [{ kind: 'set', targets: { dining: { on: false } } }] });
    const wind = await h.add({ name: 'Wind', triggers: [{ kind: 'mode', mode: 'wind' }], actions: [{ kind: 'set', targets: { office_light: { on: false } } }] });
    h.virtual.physical('lamp', { on: true });
    await h.hub.engine.setPresence('methel', false);
    await settle();
    assert.equal(h.runs(out).length, 0, 'someone is still home');
    await h.hub.engine.setPresence('brishti', false);
    await settle();
    assert.equal(h.runs(out).length, 1);
    assert.equal(h.dev('lamp').on, false);
    await h.hub.engine.setPresence('brishti', true);
    await h.hub.engine.setPresence('methel', true);
    await settle();
    assert.equal(h.runs(home).length, 1, 'only the first');
    assert.deepEqual(h.sent, [{ title: 'Welcome', body: 'Welcome home', people: ['methel'], tag: `automation-${home}` }]);
    await h.hub.engine.startOverlay('movie');
    await settle();
    assert.equal(h.runs(movie).length, 1);
    await h.advance(20.01);
    await settle();
    assert.equal(h.runs(wind).length, 1);
  } finally { await h.close(); }
});

test('steps: wait, wait until (or give up), if / otherwise, repeat, run another, stop', async () => {
  const h = await setup();
  try {
    const helper = await h.add({ name: 'Helper', triggers: [{ kind: 'hub', event: 'start' }], enabled: false, actions: [{ kind: 'set', targets: { kitchen_island: { on: true } } }] });
    const id = await h.add({
      name: 'Steps',
      triggers: [{ kind: 'event', device: 'doorbell', event: 'ring' }],
      actions: [
        { kind: 'set', targets: { lamp: { on: true, bri: 50 } } },
        { kind: 'delay', seconds: 60 },
        { kind: 'set', targets: { lamp: { on: false } } },
        { kind: 'wait', until: { kind: 'device', device: 'office_light', is: { on: true } }, timeoutSec: 120 },
        { kind: 'if', conditions: [{ kind: 'device', device: 'office_light', is: { on: true } }], then: [{ kind: 'set', targets: { office_strip: { on: true, bri: 10 } } }], else: [{ kind: 'set', targets: { dining: { on: true } } }] },
        { kind: 'repeat', times: 2, actions: [{ kind: 'notify', message: 'Ding' }] },
        { kind: 'run', automation: helper },
        { kind: 'stop' },
        { kind: 'set', targets: { kitchen_ceiling: { on: true } } },
      ],
    });
    h.hub.reg.deviceEvent('doorbell', 'ring');
    await settle();
    assert.equal(h.dev('lamp').on, true);
    await h.later(61);
    assert.equal(h.dev('lamp').on, false, 'after the minute');
    await h.later(30);
    h.virtual.physical('office_light', { on: true });
    await settle();
    assert.equal(h.dev('office_strip').on, true, 'waited for the light, then the “if” held');
    assert.equal(h.dev('dining').on, false);
    assert.equal(h.sent.length, 2);
    assert.equal(h.dev('kitchen_island').on, true, 'ran the helper (even switched off)');
    assert.equal(h.dev('kitchen_ceiling').on, false, 'stopped before the last step');
    const r = h.runs(id)[0];
    assert.equal(r.result, 'stopped');
    assert.deepEqual(r.steps.map(s => s.text), ['Set Lamp', 'Wait 1 min', 'Set Lamp', 'Wait until Ceiling is on', 'If Ceiling is on', 'Set LED strip', 'Notify: “Ding”', 'Notify: “Ding”', 'Repeated 2 times', 'Run Helper', 'Stop']);

    // Gives up waiting: carries on, or stops when told to.
    const g = await h.add({ name: 'Give up', triggers: [{ kind: 'event', device: 'doorbell', event: 'person' }], actions: [
      { kind: 'wait', until: { kind: 'device', device: 'garage_light', is: { on: true } }, timeoutSec: 60, stopOnTimeout: true },
      { kind: 'set', targets: { lounge_main: { on: true } } },
    ] });
    h.hub.reg.deviceEvent('doorbell', 'person');
    await h.later(61);
    assert.equal(h.runs(g)[0].result, 'stopped');
    assert.equal(h.dev('lounge_main').on, false);
  } finally { await h.close(); }
});

test('run modes: single ignores, restart cancels, queued waits its turn, parallel runs alongside', async () => {
  const h = await setup();
  try {
    const mk = (mode: Automation['mode'], event: string) => h.add({ name: `M ${mode}`, mode, triggers: [{ kind: 'event', device: 'doorbell', event }], actions: [{ kind: 'delay', seconds: 60 }, { kind: 'notify', message: mode }] });
    const single = await mk('single', 'a'), restart = await mk('restart', 'b'), queued = await mk('queued', 'c'), parallel = await mk('parallel', 'd');
    for (const e of ['a', 'b', 'c', 'd']) h.hub.reg.deviceEvent('doorbell', e);
    await h.later(30);
    for (const e of ['a', 'b', 'c', 'd']) h.hub.reg.deviceEvent('doorbell', e);
    await settle();
    assert.equal(h.runs(single).length, 1, 'second start ignored');
    assert.deepEqual(h.runs(restart).map(r => r.result), ['running', 'cancelled']);
    assert.equal(h.hub.engine.automations.running(queued), 1, 'the second waits');
    assert.equal(h.hub.engine.automations.running(parallel), 2);
    await h.later(31);
    await h.later(60);
    const count = (m: string) => h.sent.filter(n => n.body === m).length;
    assert.deepEqual([count('single'), count('restart'), count('queued'), count('parallel')], [1, 1, 2, 2]);
  } finally { await h.close(); }
});

test('conditions: any / not, a time window across midnight, who’s home, mode, overlay', async () => {
  const h = await setup(23);
  try {
    const x = { reg: h.hub.reg, cfg: h.hub.config.get(), now: h.clock.t, engine: { modeId: h.hub.engine.modeId, overlayId: () => null, people: () => h.hub.engine.people, startOverlay: async () => {}, endOverlay: async () => {}, emitChanged: () => {} } };
    const night = { kind: 'time' as const, after: { kind: 'time' as const, at: '22:00' }, before: { kind: 'time' as const, at: '06:00' } };
    assert.equal(holds(night, x), true, '23:00 is between 22:00 and 06:00');
    assert.equal(holds(night, { ...x, now: at(12) }), false);
    assert.equal(holds({ kind: 'time', days: [0, 6] }, x), false, 'a Wednesday');
    assert.equal(holds({ kind: 'any', conditions: [{ kind: 'device', device: 'lamp', is: { on: true } }, night] }, x), true);
    assert.equal(holds({ kind: 'not', conditions: [night] }, x), false);
    assert.equal(holds({ kind: 'presence', who: 'anyone', home: true }, x), true);
    assert.equal(holds({ kind: 'presence', who: 'no-one', home: true }, x), false);
    assert.equal(holds({ kind: 'mode', modes: [h.hub.engine.modeId] }, x), true);
    assert.equal(holds({ kind: 'overlay', active: false }, x), true);
    const why: string[] = [];
    holds({ kind: 'all', conditions: [night, { kind: 'device', device: 'lamp', is: { on: true } }] }, x, why);
    assert.deepEqual(why, ['Lamp isn’t on']);
    assert.equal(matches({ on: true, paused: false, media: 'Radio' }, { playing: true }), true);
    assert.equal(matches({}, { online: true }), true, 'unknown counts as online');
    assert.equal(inRange(null, 1), false);
    assert.equal(inRange(5, 1, 10), true);
  } finally { await h.close(); }
});

test('loops: an automation is never started by its own change, and one that keeps starting is switched off', async () => {
  const h = await setup();
  try {
    const self = await h.add({ name: 'Self', triggers: [{ kind: 'device', device: 'lamp', to: { on: true } }], actions: [{ kind: 'set', targets: { lamp: { on: false } } }, { kind: 'set', targets: { lamp: { on: true } } }] });
    h.virtual.physical('lamp', { on: true });
    await settle();
    assert.equal(h.runs(self).length, 1);
    // Two that set each other off.
    await h.add({ name: 'Ping', mode: 'parallel', triggers: [{ kind: 'device', device: 'dining', to: { on: true } }], actions: [{ kind: 'set', targets: { dining: { on: false }, kitchen_island: { on: true } } }] });
    await h.add({ name: 'Pong', mode: 'parallel', triggers: [{ kind: 'device', device: 'kitchen_island', to: { on: true } }], actions: [{ kind: 'set', targets: { kitchen_island: { on: false }, dining: { on: true } } }] });
    h.virtual.physical('dining', { on: true });
    for (let i = 0; i < 40; i++) await settle();
    const autos = h.hub.engine.automations.list();
    assert.ok(autos.some(a => !a.enabled && (a.name === 'Ping' || a.name === 'Pong')), 'one of them was switched off');
  } finally { await h.close(); }
});

test('the API: checked when saved, duplicate, history, run now (with or without conditions), delete and undo', async () => {
  const h = await setup();
  try {
    const bad = async (payload: object, msg: RegExp) => {
      const r = await h.app.inject({ method: 'POST', url: '/api/automations', payload });
      assert.equal(r.statusCode, 400, JSON.stringify(payload));
      assert.match(r.json().error, msg);
    };
    const ok = { name: 'x', triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'stop' }] };
    await bad({ ...ok, name: '' }, /needs a name/);
    await bad({ ...ok, triggers: [] }, /at least one trigger/);
    await bad({ ...ok, actions: [] }, /at least one step/);
    await bad({ ...ok, triggers: [{ kind: 'device', device: 'nope', to: { on: true } }] }, /Unknown device nope/);
    await bad({ ...ok, triggers: [{ kind: 'device', device: 'lamp' }] }, /state to turn to/);
    await bad({ ...ok, triggers: [{ kind: 'numeric', device: 'lamp', field: 'bri', above: 50, below: 10 }] }, /less than/);
    await bad({ ...ok, triggers: [{ kind: 'time', at: { kind: 'time', at: '25:00' } }] }, /time isn’t valid/);
    await bad({ ...ok, conditions: [{ kind: 'mode', modes: ['nope'] }] }, /Unknown mode/);
    await bad({ ...ok, actions: [{ kind: 'set', targets: { doorbell: { on: true } } }] }, /can't do that/);
    await bad({ ...ok, actions: [{ kind: 'notify', message: ' ' }] }, /Write the notification/);
    await bad({ ...ok, actions: [{ kind: 'run', automation: 'nope' }] }, /Unknown automation/);
    await bad({ ...ok, mode: 'often' }, /run mode/);

    const id = await h.add({ name: 'Porch', triggers: [{ kind: 'hub', event: 'start' }], conditions: [{ kind: 'device', device: 'lamp', is: { on: true } }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
    let r = await h.app.inject({ method: 'POST', url: `/api/automations/${id}/run?check=1` });
    assert.deepEqual([r.json().ran, r.json().why], [false, 'Lamp isn’t on']);
    r = await h.app.inject({ method: 'POST', url: `/api/automations/${id}/run` });
    assert.equal(r.json().run.result, 'done');
    assert.equal(h.dev('office_light').on, true);
    r = await h.app.inject({ url: `/api/automations/${id}` });
    assert.deepEqual(r.json().runs.map((x: { result: string }) => x.result), ['done', 'skipped']);

    // One with a delay: Run now answers once it has started, without waiting out the delay.
    const slow = await h.add({ name: 'Slow', triggers: [{ kind: 'hub', event: 'start' }], actions: [{ kind: 'delay', seconds: 600 }, { kind: 'stop' }] });
    const t0 = Date.now();
    r = await h.app.inject({ method: 'POST', url: `/api/automations/${slow}/run` });
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual([r.json().ran, r.json().running, r.json().run.result], [true, true, 'running']);
    await h.later(601);
    assert.equal(h.runs(slow)[0].result, 'stopped');

    r = await h.app.inject({ method: 'POST', url: `/api/automations/${id}/duplicate` });
    const copy = h.hub.engine.automations.list().find(a => a.id === r.json().id)!;
    assert.deepEqual([copy.name, copy.enabled], ['Porch (copy)', false]);

    r = await h.app.inject({ method: 'DELETE', url: `/api/automations/${id}` });
    assert.ok(!h.hub.engine.automations.list().some(a => a.id === id));
    await h.app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.ok(h.hub.engine.automations.list().some(a => a.id === id));
  } finally { await h.close(); }
});

test('automations saved by 0.7.6 (when / if / then) are rewritten in the new shape', async () => {
  const old = { id: 'a1', name: 'Old', enabled: true, when: { device: 'living_display', becomes: 'offline' }, if: [{ device: 'bedroom_tv', is: { on: true } }], then: { bedroom_tv: { on: false } } };
  assert.deepEqual(upgradeAutomation(old), {
    id: 'a1', name: 'Old', enabled: true, mode: 'single',
    triggers: [{ kind: 'device', device: 'living_display', to: { online: false } }],
    conditions: [{ kind: 'device', device: 'bedroom_tv', is: { on: true } }],
    actions: [{ kind: 'set', targets: { bedroom_tv: { on: false } } }],
  });
  const t = await testHub(12, c => { (c as unknown as { automations: unknown[] }).automations = [old]; });
  try {
    const saved = t.hub.config.get().automations![0];
    assert.ok(Array.isArray(saved.triggers), 'rewritten in the config');
  } finally { await t.hub.stop(); }
});
