import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHub, NEEDS_A_HUB } from '../src/demo/hub.ts';
import { DEMO_MODES, modeAt, solarAt } from '../src/demo/home.ts';
import { HubError } from '../src/api/client.ts';
import { automationsOf } from '../src/logic/automations.ts';
import { dayBands } from '../src/logic/day.ts';
import { energyView } from '../src/logic/energy.ts';
import type { AskReply, Snapshot } from '../src/api/types.ts';

// A fixed local evening, so the demo's plan is predictable: 19:15 is Evening.
const at = (h: number, m = 0) => { const d = new Date(2026, 9, 7, h, m); return d.getTime(); };
const hubAt = (t: number) => { let now = t; const hub = createDemoHub({ now: () => now }); return { hub, set: (x: number) => { now = x; } }; };
const dev = (s: Snapshot, id: string) => s.devices.find(d => d.id === id)!;

test('the demo snapshot has every part the screens read, in the real shapes', () => {
  const { hub } = hubAt(at(19, 15));
  const s = hub.snapshot();
  assert.equal(s.demo, true);
  assert.equal(s.home.name, 'Demo home');
  assert.equal(s.home.clock, '19:15');
  assert.ok(s.rooms.length >= 6 && s.devices.length >= 20 && s.people.length === 2);
  for (const d of s.devices) {
    assert.ok(s.rooms.some(r => r.id === d.room), `${d.id} is in a known room`);
    assert.ok(Array.isArray(d.capabilities) && d.adapter && d.integration && d.state);
  }
  const types = new Set(s.devices.map(d => d.type));
  for (const t of ['light', 'dimmer', 'fan', 'media', 'tv', 'plug', 'camera', 'sensor', 'vacuum', 'climate']) assert.ok(types.has(t as never), `has a ${t}`);
  assert.deepEqual(s.modes.map(m => m.id), DEMO_MODES.map(m => m.id));
  assert.equal(s.current.modeId, 'evening');
  assert.equal(s.current.nextId, 'wind');
  assert.equal(s.upcoming[0].modeId, 'wind');
  assert.ok(s.overlays.length >= 4 && s.sources.length >= 3);
  assert.ok(automationsOf(s).length >= 3);
  assert.ok(s.activity.length > 0);
  assert.ok(s.integrations.every(i => i.ok));
  assert.equal(s.update, null, 'no hub updates to offer');
  // The day strip covers 24 hours and marks the mode now.
  const bands = dayBands(s);
  assert.ok(Math.abs(bands.reduce((n, b) => n + b.width, 0) - 1) < 1e-9);
  assert.equal(bands.find(b => b.current)?.modeId, 'evening');
  // The evening plan left lights on.
  assert.equal(dev(s, 'porch').state.on, true);
  assert.equal(dev(s, 'lamp').state.bri, 78);
});

test('no real home in the demo: generic names only', () => {
  const s = createDemoHub({ now: () => at(12) }).snapshot();
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /Ahmed|Methel|Brishti|Perth/);
});

test('energy follows the sun and what is on', () => {
  assert.equal(solarAt(3), 0);
  assert.ok(solarAt(12.25) > 4000);
  const { hub } = hubAt(at(12, 30));
  const s = hub.snapshot();
  assert.ok(s.energy && s.energy.now.solar > 3000);
  assert.ok(s.energy.solarKwh > 5);
  const v = energyView(s.energy, 'GoodWe', s.home.nowHour);
  assert.equal(v.available, true);
  const before = s.energy.now.load!;
  hub.request('POST', '/api/devices/lounge_ac', { on: true });
  assert.ok(hub.snapshot().energy!.now.load! > before + 1000, 'the air conditioner shows in the load');
});

test('controlling a device changes the state, tells subscribers, and can be undone', () => {
  const { hub } = hubAt(at(19, 15));
  const seen: Snapshot[] = [];
  const off = hub.subscribe(s => seen.push(s));
  const r = hub.request<{ undo: string }>('POST', '/api/devices/lamp', { on: true, bri: 30 });
  assert.equal(dev(hub.snapshot(), 'lamp').state.bri, 30);
  assert.equal(seen.length, 1);
  assert.equal(dev(seen[0], 'lamp').state.bri, 30);
  assert.match(hub.snapshot().activity[0].what, /lamp/i);
  hub.request('POST', `/api/undo/${r.undo}`);
  assert.equal(dev(hub.snapshot(), 'lamp').state.bri, 78);
  assert.throws(() => hub.request('POST', `/api/undo/${r.undo}`), (e: unknown) => e instanceof HubError && e.status === 410);
  off();
  hub.request('POST', '/api/devices/porch', { on: false });
  assert.equal(seen.length, 2, 'unsubscribed');
});

test('everything off, a room off, overlays on and off', () => {
  const { hub } = hubAt(at(19, 15));
  const lightsOn = (s: Snapshot) => s.devices.filter(d => (d.type === 'light' || d.type === 'dimmer') && d.state.on).length;
  assert.ok(lightsOn(hub.snapshot()) > 3);
  const room = hub.request<{ changed: string[] }>('POST', '/api/rooms/lounge/off');
  assert.ok(room.changed.includes('lamp'));
  assert.equal(dev(hub.snapshot(), 'porch').state.on, true, 'other rooms untouched');
  const all = hub.request<{ changed: string[]; undo: string }>('POST', '/api/lights/off');
  assert.ok(all.changed.length > 0 && all.undo);
  assert.equal(lightsOn(hub.snapshot()), 0);
  hub.request('POST', '/api/overlays/movie/start');
  let s = hub.snapshot();
  assert.equal(s.current.overlay?.id, 'movie');
  assert.equal(dev(s, 'lamp').state.bri, 8);
  assert.equal(dev(s, 'lounge_tv').state.on, true);
  hub.request('POST', '/api/overlays/end');
  s = hub.snapshot();
  assert.equal(s.current.overlay, null);
  assert.equal(dev(s, 'lamp').state.bri, 78, 'back to the mode');
});

test('the plan moves on as time passes', () => {
  const { hub, set } = hubAt(at(20, 25));
  assert.equal(hub.snapshot().current.modeId, 'evening');
  set(at(20, 31));
  hub.tick();
  const s = hub.snapshot();
  assert.equal(s.current.modeId, 'wind');
  assert.equal(dev(s, 'lamp').state.bri, 25);
  assert.equal(modeAt(2).id, 'night', 'night runs past midnight');
});

test('skipping what is next, findings and the home settings', () => {
  const { hub } = hubAt(at(19, 15));
  const id = hub.snapshot().upcoming[0].id;
  hub.request('POST', '/api/plan/skip', { id, skip: true });
  assert.equal(hub.snapshot().upcoming[0].skipped, true);
  const f = hub.snapshot().findings[0];
  hub.request('POST', `/api/findings/${encodeURIComponent(f.id)}/dismiss`);
  assert.equal(hub.snapshot().findings.length, 0);
  hub.request('PUT', '/api/home', { name: 'Our place', pauseForDoorbell: false });
  assert.equal(hub.snapshot().home.name, 'Our place');
  hub.request('PATCH', '/api/devices/porch/settings', { name: 'Front light', favourite: false });
  assert.equal(dev(hub.snapshot(), 'porch').name, 'Front light');
  assert.ok(!hub.snapshot().favourites!.includes('porch'));
  hub.request('POST', '/api/rooms', { name: 'Hallway' });
  assert.ok(hub.snapshot().rooms.some(r => r.name === 'Hallway'));
});

test('automations: switch off, run, edit, duplicate, delete', () => {
  const { hub } = hubAt(at(19, 15));
  const list = () => automationsOf(hub.snapshot());
  const a = list()[1];
  hub.request('PATCH', `/api/automations/${a.id}`, { enabled: false });
  assert.equal(list().find(x => x.id === a.id)!.enabled, false);
  assert.equal(hub.request<{ ran: boolean }>('POST', `/api/automations/${a.id}/run`).ran, false);
  hub.request('PATCH', `/api/automations/${a.id}`, { enabled: true });
  const r = hub.request<{ ran: boolean; run: { result: string } }>('POST', `/api/automations/${a.id}/run`);
  assert.equal(r.ran, true);
  assert.equal(r.run.result, 'done');
  assert.ok(list().find(x => x.id === a.id)!.lastRun);
  const got = hub.request<{ automation: { id: string; name: string } }>('GET', `/api/automations/${a.id}`);
  assert.equal(got.automation.name, a.name);
  const made = hub.request<{ id: string }>('POST', '/api/automations', { name: 'Porch at 21:00', enabled: true, mode: 'single', triggers: [{ kind: 'time', at: { kind: 'time', at: '21:00' } }], conditions: [], actions: [{ kind: 'set', targets: { porch: { on: false } } }] });
  const m = list().find(x => x.id === made.id)!;
  assert.deepEqual(m.triggerLabels, ['21:00']);
  assert.match(m.actionLabels![0], /porch light Off/i);
  hub.request('POST', `/api/automations/${made.id}/duplicate`);
  assert.equal(list().filter(x => x.name.startsWith('Porch at 21:00')).length, 2);
  hub.request('DELETE', `/api/automations/${made.id}`);
  assert.ok(!list().some(x => x.id === made.id));
  assert.throws(() => hub.request('GET', '/api/import/ha/automations'), (e: unknown) => e instanceof HubError && e.status === 503);
});

test('Ask Kova answers on the phone and does what it says', () => {
  const { hub } = hubAt(at(19, 15));
  const ask = (text: string) => hub.request<AskReply>('POST', '/api/ask', { text });
  const off = ask('Turn off the kitchen');
  assert.match(off.text, /Kitchen/);
  assert.ok(off.undo);
  assert.equal(dev(hub.snapshot(), 'kitchen_ceiling').state.on, false);
  ask('Lamp to 30%');
  assert.equal(dev(hub.snapshot(), 'lamp').state.bri, 30);
  assert.match(ask('Who’s home?').text, /Alex/);
  assert.match(ask('Why is the porch light on?').text, /porch light/i);
  const leave = ask('I’m leaving');
  assert.equal(leave.actions[0].label, 'Start Away');
  hub.request('POST', '/api/ask/act', { action: leave.actions[0].action });
  assert.equal(hub.snapshot().current.overlay?.id, 'away');
  assert.equal(ask('flibbertigibbet').understood, false);
  assert.deepEqual(hub.request<{ chips: string[] }>('POST', '/api/ask/parse', { text: 'turn off the kitchen' }).chips, ['Turn off', 'Kitchen']);
});

test('what needs a real hub says so instead of pretending', () => {
  const { hub } = hubAt(at(19, 15));
  for (const [m, p] of [['GET', '/api/integrations/catalog'], ['PUT', '/api/integrations/config/nest'], ['POST', '/api/push/app'], ['GET', '/api/presence/setup'], ['POST', '/api/update/check']] as const) {
    assert.throws(() => hub.request(m, p, {}), (e: unknown) => e instanceof HubError && e.message === NEEDS_A_HUB, `${m} ${p}`);
  }
  assert.throws(() => hub.request('POST', '/api/devices/nope', { on: true }), (e: unknown) => e instanceof HubError && e.status === 404);
});

test('answers are copies: changing one does not change the demo home', () => {
  const { hub } = hubAt(at(19, 15));
  const s = hub.request<Snapshot>('GET', '/api/state');
  s.devices[0].name = 'changed';
  assert.notEqual(hub.snapshot().devices[0].name, 'changed');
});

test('every icon the demo home uses is in the app’s icon font', async () => {
  const { ICON_CODES } = await import('../src/ui/icon-codes.ts');
  const s = createDemoHub({ now: () => at(19, 15) }).snapshot();
  const icons = [...s.rooms, ...s.modes, ...s.overlays, ...s.sources, ...s.integrations, ...s.activity, ...(s.insights ?? [])].map(x => x.icon);
  if (s.weather) icons.push(s.weather.icon);
  for (const i of icons) assert.ok(ICON_CODES[i], `icon ${i}`);
});
