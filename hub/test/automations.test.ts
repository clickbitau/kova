import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { becameOf, holds } from '../src/engine/engine.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise(r => setTimeout(r, 20));

test('automations: when a player shuts down, if the TV is still on its input, the TV and speaker go off', async () => {
  const { hub, virtual, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'POST', url: '/api/automations', payload: {
      name: 'TV off with the box',
      when: { device: 'living_display', becomes: 'offline' },
      if: [{ device: 'bedroom_tv', is: { on: true, input: 'hdmi4' } }],
      then: { bedroom_tv: { on: false }, master_speaker: { on: false } },
    } });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id as string;

    // On the box's input: the box goes dark, the TV and speaker go off, and Activity says why.
    virtual.physical('bedroom_tv', { on: true, input: 'hdmi4' });
    virtual.physical('master_speaker', { on: true });
    virtual.physical('living_display', { online: false });
    await settle();
    assert.equal(dev('bedroom_tv').on, false);
    assert.equal(dev('master_speaker').on, false);
    const run = hub.store.between(0, Number.MAX_SAFE_INTEGER, 'run').find(e => e.cause?.kind === 'automation');
    assert.match(run!.what, /^TV off with the box: .* · Living room display went offline$/);

    // On another input: nothing (someone is watching something else).
    virtual.physical('living_display', { online: true });
    virtual.physical('bedroom_tv', { on: true, input: 'tv' });
    virtual.physical('living_display', { online: false });
    await settle();
    assert.equal(dev('bedroom_tv').on, true);

    // Switched off: kept, but doesn't run.
    await app.inject({ method: 'PATCH', url: `/api/automations/${id}`, payload: { enabled: false } });
    virtual.physical('living_display', { online: true });
    virtual.physical('bedroom_tv', { input: 'hdmi4' });
    virtual.physical('living_display', { online: false });
    await settle();
    assert.equal(dev('bedroom_tv').on, true);

    // Run by hand: its "if" is still checked.
    r = await app.inject({ method: 'POST', url: `/api/automations/${id}/run` });
    assert.deepEqual(r.json().ran, true);
    assert.equal(dev('bedroom_tv').on, false);
    r = await app.inject({ method: 'POST', url: `/api/automations/${id}/run` });
    assert.equal(r.json().ran, false, 'the TV is off now, so its "if" fails');

    // In the snapshot, in words; and listed on the devices it uses.
    const s = (await app.inject({ url: '/api/state' })).json();
    const a = s.automations.find((x: { id: string }) => x.id === id);
    assert.equal(a.whenLabel, 'When Living room display shuts down or goes offline');
    assert.deepEqual(a.ifLabels, ['Bedroom OLED is on HDMI 4']);
    assert.deepEqual(a.thenLabels, ['Bedroom OLED stops', 'Speaker stops']);
    assert.ok(s.devices.find((d: { id: string }) => d.id === 'bedroom_tv').usedIn.some((u: { kind: string }) => u.kind === 'automation'));

    // Deleted, then undone.
    r = await app.inject({ method: 'DELETE', url: `/api/automations/${id}` });
    assert.equal(hub.config.get().automations!.length, 0);
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.equal(hub.config.get().automations!.length, 1);
  } finally { await app.close(); await hub.stop(); }
});

test('automations: started by a device event; checked when saved', async () => {
  const { hub, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    let r = await app.inject({ method: 'POST', url: '/api/automations', payload: { name: 'Lamp for the door', when: { device: 'doorbell', event: 'ring' }, if: [], then: { lamp: { on: true, bri: 40 } } } });
    assert.equal(r.statusCode, 200, r.body);
    hub.reg.emit('event', { device: hub.reg.get('doorbell')!, type: 'ring', data: {} });
    await settle();
    assert.deepEqual([dev('lamp').on, dev('lamp').bri], [true, 40]);

    const bad = async (payload: object, msg: RegExp) => {
      const x = await app.inject({ method: 'POST', url: '/api/automations', payload });
      assert.equal(x.statusCode, 400);
      assert.match(x.json().error, msg);
    };
    await bad({ when: { device: 'lamp', becomes: 'on' }, then: { lamp: { on: false } } }, /name/);
    await bad({ name: 'x', when: { device: 'nope', becomes: 'on' }, then: { lamp: { on: false } } }, /device that starts it/);
    await bad({ name: 'x', when: { device: 'lamp', becomes: 'purple' }, then: { lamp: { on: false } } }, /switches on or off/);
    await bad({ name: 'x', when: { device: 'lamp', becomes: 'on' }, if: [{ device: 'lamp', is: {} }], then: { lamp: { on: false } } }, /something to check/);
    await bad({ name: 'x', when: { device: 'lamp', becomes: 'on' }, then: {} }, /at least one thing/);
    await bad({ name: 'x', when: { device: 'lamp', becomes: 'on' }, then: { doorbell: { on: true } } }, /can't do that/);
    r = await app.inject({ method: 'PUT', url: '/api/automations/nope', payload: {} });
    assert.equal(r.statusCode, 404);
  } finally { await app.close(); await hub.stop(); }
});

test('automations: one never sets itself off again; suggestions come from how devices are connected', async () => {
  const { hub, virtual, dev } = await testHub(12);
  const app = await buildServer(hub, { webRoot });
  try {
    // "When the lamp switches off, switch it off" mustn't loop; "on → on" for another device runs once.
    await app.inject({ method: 'POST', url: '/api/automations', payload: { name: 'Pair', when: { device: 'lamp', becomes: 'on' }, if: [], then: { lamp: { on: true, bri: 50 }, office_light: { on: true } } } });
    virtual.physical('lamp', { on: true });
    await settle();
    assert.equal(dev('office_light').on, true);
    assert.equal(hub.store.between(0, Number.MAX_SAFE_INTEGER, 'run').filter(e => e.cause?.kind === 'automation').length, 1);

    // A player on a TV: suggested, not running, until added.
    hub.screens = () => [{ player: 'living_display', tv: 'bedroom_tv', input: 'hdmi2', soundbar: 'master_speaker' }];
    let s = (await app.inject({ url: '/api/state' })).json();
    assert.equal(s.automationIdeas.length, 1);
    const idea = s.automationIdeas[0];
    assert.equal(idea.name, 'Bedroom OLED off when Living room display shuts down');
    assert.deepEqual(idea.if, [{ device: 'bedroom_tv', is: { on: true, input: 'hdmi2' } }]);
    assert.deepEqual(idea.then, { bedroom_tv: { on: false }, master_speaker: { on: false } });
    // Added as it is: no longer suggested.
    await app.inject({ method: 'POST', url: '/api/automations', payload: idea });
    s = (await app.inject({ url: '/api/state' })).json();
    assert.equal(s.automationIdeas.length, 0);
    // Or dismissed instead.
    hub.config.update(c => { c.automations = []; });
    await app.inject({ method: 'POST', url: `/api/findings/${encodeURIComponent(`idea:${idea.key}`)}/dismiss` });
    s = (await app.inject({ url: '/api/state' })).json();
    assert.equal(s.automationIdeas.length, 0);
  } finally { await app.close(); await hub.stop(); }
});

test('what a change made a device become, and whether a device is like this', () => {
  assert.deepEqual(becameOf({ prev: { on: true }, patch: { on: false } }), ['off']);
  assert.deepEqual(becameOf({ prev: {}, patch: { on: false } }), [], 'first heard of: not "switched off"');
  assert.deepEqual(becameOf({ prev: {}, patch: { online: false } }), ['offline']);
  assert.deepEqual(becameOf({ prev: { online: false }, patch: { online: true } }), ['online']);
  assert.deepEqual(becameOf({ prev: {}, patch: { online: true } }), [], 'first heard of: not "back"');
  assert.equal(holds({ on: true, input: 'hdmi4' }, { on: true, input: 'hdmi4' }), true);
  assert.equal(holds({}, { on: false }), true, 'unknown counts as off');
  assert.equal(holds({}, { online: true }), true, 'unknown counts as online');
  assert.equal(holds({ on: true, input: null }, { input: 'hdmi4' }), false, 'input unknown: not on it');
});
