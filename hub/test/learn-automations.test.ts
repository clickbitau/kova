import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at, DATE, TZ } from './helpers.ts';
import { addDays } from '../src/util/time.ts';
import { resolveRhythm } from '../src/rhythms/rhythms.ts';
import { buildServer } from '../src/api/server.ts';
import type { Automation, Cause, Command, HomeConfig } from '../src/model/types.ts';
import type { Hub } from '../src/hub.ts';

// Learning about automations from synthetic histories: each pattern, the near-misses that mustn't trigger, and
// applying and undoing each kind of suggestion.

const you: Cause = { kind: 'user', label: 'You' };
const remote: Cause = { kind: 'device', label: 'Samsung TV' };
const day = (k: number) => addDays(DATE, k);
const hm = (h: number, m = 0) => h + m / 60;

function log(hub: Hub, ts: number, device: string, patch: Command, prev: Command, cause: Cause) {
  hub.store.append({ kind: 'state', device, feed: null, what: `${device} changed`, data: { patch, prev }, cause, ts });
}
const byAuto = (a: Pick<Automation, 'id' | 'name'>, detail = 'It’s time'): Cause => ({ kind: 'automation', id: a.id, label: a.name, detail });
function ranByHand(hub: Hub, ts: number, a: Pick<Automation, 'id' | 'name'>) {
  hub.store.append({ kind: 'run', device: null, feed: 'auto', what: `${a.name} · Run by hand`, data: { automation: a.id, changed: [] }, cause: byAuto(a, 'Run by hand'), ts });
}
function overlay(hub: Hub, from: number, to: number, id = 'guests', name = 'Guests') {
  hub.store.append({ kind: 'run', device: null, feed: 'auto', what: `${name} on`, data: { overlay: id, changed: [] }, cause: { kind: 'overlay', id, label: `${name} started` }, ts: from });
  hub.store.append({ kind: 'run', device: null, feed: 'auto', what: `${name} ended`, data: { overlay: id, changed: [] }, cause: { kind: 'overlay', id, label: `${name} ended` }, ts: to });
}

const auto = (a: Partial<Automation> & Pick<Automation, 'id' | 'name' | 'actions'>): Automation => ({ enabled: true, mode: 'single', triggers: [], conditions: [], ...a });

/** A demo hub with these automations, its clock at `now` (no ticking: history is written by the test). */
async function home(automations: Automation[], tweak?: (c: HomeConfig) => void) {
  const t = await testHub(12, c => { c.automations = automations; tweak?.(c); });
  const learner = t.hub.checker.learner;
  const now = (k: number, h = 23.9) => { t.clock.t = at(h, day(k)); };
  const find = (kind: string, automationId?: string) => learner.suggestions().find(s => s.kind === kind && (!automationId || s.automationId === automationId));
  const autoOf = (id: string) => t.hub.config.get().automations!.find(a => a.id === id)!;
  return { ...t, learner, now, find, autoOf };
}

// ---------------------------------------------------------------- 1. early --

const rain = auto({ id: 'rain_bed', name: 'Rain at bedtime', triggers: [{ kind: 'time', at: { kind: 'time', at: '22:00' } }], actions: [{ kind: 'set', targets: { master_speaker: { on: true, vol: 10, media: 'Rain sounds' } } }] });
const startRain = (h: Hub, ts: number) => log(h, ts, 'master_speaker', { on: true, media: 'Rain sounds' }, { on: false, media: null }, you);

/** Starting it early by hand: an automation at 22:00 that you start by hand around 21:15 most nights. */
async function earlyNights(opts: { times: (number | null)[]; tvFirst?: boolean; guests?: boolean } ) {
  const h = await home([rain]);
  // It first ran on day 1, at its time.
  log(h.hub, at(22, day(1)), 'master_speaker', { on: true, vol: 10, media: 'Rain sounds' }, { on: false, media: null }, byAuto(rain));
  opts.times.forEach((t, i) => {
    const d = day(i + 2);
    if (opts.guests) overlay(h.hub, at(18, d), at(23.95, d));
    if (t == null) { log(h.hub, at(22, d), 'master_speaker', { on: true, vol: 10, media: 'Rain sounds' }, { on: false, media: null }, byAuto(rain)); return; }
    if (opts.tvFirst) {
      log(h.hub, at(19, d), 'bedroom_tv', { on: true }, { on: false }, remote);
      log(h.hub, at(t, d) - 5 * 60_000, 'bedroom_tv', { on: false }, { on: true }, remote);
    }
    if (i === 1) ranByHand(h.hub, at(t, d), rain); else startRain(h.hub, at(t, d));
  });
  h.now(opts.times.length + 1);
  return h;
}

test('an automation you start early by hand most nights: move its time to your usual one, undoably', async () => {
  const h = await earlyNights({ times: [hm(21, 10), hm(21, 20), hm(21, 15), null, hm(21, 5), hm(21, 25), hm(21, 12)] });
  const s = h.find('auto-time', 'rain_bed');
  assert.ok(s, 'a timing suggestion');
  assert.equal(s.id, 'learn:auto-time:rain_bed:2115');
  assert.equal(s.days.length, 6);
  assert.match(s.finding.title, /“Rain at bedtime” could start at 21:15/);
  assert.match(s.finding.body, /It runs at 22:00, but on 6 of the last 8 days you started it earlier by hand, around 21:15 \(21:05–21:25\)/);
  assert.equal(s.finding.evidence!.length, 6);
  assert.ok(s.finding.evidence!.some(e => /you ran it by hand/.test(e.text)), 'Run by hand counts');
  assert.equal(s.finding.automationId, 'rain_bed');
  assert.equal(s.finding.learned, true);
  assert.equal(s.finding.alt, 'Not now');
  assert.equal(s.finding.never, 'Don’t suggest again');
  // The simpler habit isn't suggested as well.
  assert.ok(!h.learner.suggestions().some(x => x.kind === 'moment' && x.device === 'master_speaker'));

  const undo = h.hub.checker.fix(s.id);
  assert.deepEqual(h.autoOf('rain_bed').triggers, [{ kind: 'time', at: { kind: 'time', at: '21:15' } }]);
  assert.ok(!h.hub.checker.findings().some(f => f.id === s.id), 'gone once applied');
  undo();
  assert.deepEqual(h.autoOf('rain_bed').triggers, [{ kind: 'time', at: { kind: 'time', at: '22:00' } }]);
  await h.hub.stop();
});

test('a better trigger: the bedroom TV turning off just before you start it', async () => {
  const h = await earlyNights({ times: [hm(21, 10), hm(21, 20), hm(21, 15), null, hm(21, 5), hm(21, 25), hm(21, 12)], tvFirst: true });
  const s = h.find('auto-time', 'rain_bed')!;
  const alt = s.finding.more?.[0];
  assert.ok(alt, 'another way on the same card');
  assert.equal(alt.id, 'learn:auto-trigger:rain_bed:bedroom_tv:false');
  assert.match(alt.title, /could start when the bedroom oled turns off/);
  assert.match(alt.body, /about 5 minutes before you did it/);
  // Not also "when the TV turns off, play Rain sounds": an automation already plays it, even once its time is moved.
  assert.ok(!h.learner.suggestions().some(x => x.kind === 'chain' && x.device === 'master_speaker'));
  const moved = h.hub.checker.fix(s.id);
  h.clock.t += 60_000;
  assert.ok(!h.learner.suggestions().some(x => x.kind === 'chain' && x.device === 'master_speaker'), 'still not, after moving it');
  moved();
  const undo = h.hub.checker.fix(alt.id);
  const a = h.autoOf('rain_bed');
  assert.deepEqual(a.triggers[0], { kind: 'device', device: 'bedroom_tv', to: { on: false } });
  assert.deepEqual(a.triggers[1], { kind: 'time', at: { kind: 'time', at: '22:00' } }, 'its time stays as a backstop');
  assert.deepEqual(a.conditions, [{ kind: 'time', after: { kind: 'time', at: '20:35' }, before: { kind: 'time', at: '23:00' } }]);
  undo();
  assert.equal(h.autoOf('rain_bed').triggers.length, 1);
  await h.hub.stop();
});

test('near-misses for timing: too few nights, times all over the place, Guests days, only a few minutes early', async () => {
  for (const [why, opts] of [
    ['3 nights is not a habit', { times: [hm(21, 10), null, hm(21, 15), null, null, hm(21, 20), null] }],
    ['scattered', { times: [hm(19, 5), hm(21, 40), hm(20, 10), hm(21, 55), hm(19, 40), hm(20, 50)] }],
    ['Guests days', { times: [hm(21, 10), hm(21, 20), hm(21, 15), hm(21, 5), hm(21, 25), hm(21, 12)], guests: true }],
    ['5 minutes early', { times: [hm(21, 55), hm(21, 56), hm(21, 54), hm(21, 55), hm(21, 57)] }],
  ] as [string, Parameters<typeof earlyNights>[0]][]) {
    const h = await earlyNights(opts);
    assert.equal(h.find('auto-time'), undefined, why);
    await h.hub.stop();
  }
});

// ----------------------------------------------------------- 2. corrected --

const desk = auto({ id: 'desk', name: 'Desk light', triggers: [{ kind: 'time', at: { kind: 'time', at: '19:00' } }], actions: [{ kind: 'set', targets: { office_strip: { on: true, bri: 80 } } }] });

test('an automation you correct the same way most days: change its value to your usual one', async () => {
  const h = await home([desk]);
  const fixes = [30, 25, 35, 20, null];
  fixes.forEach((v, i) => {
    const d = day(i + 1);
    log(h.hub, at(19, d), 'office_strip', { on: true, bri: 80 }, { on: false, bri: 100 }, byAuto(desk));
    // The strip reports back a step off a few seconds later: the device catching up, not a person.
    log(h.hub, at(19, d) + 8_000, 'office_strip', { bri: 79 }, { bri: 80 }, { kind: 'device', label: 'Tuya' });
    if (v != null) log(h.hub, at(hm(19, 10), d), 'office_strip', { bri: v }, { bri: 79 }, you);
  });
  h.now(5);
  const s = h.find('auto-value', 'desk');
  assert.ok(s);
  assert.equal(s.id, 'learn:auto-value:desk:office_strip:bri30');
  assert.match(s.finding.title, /“Desk light” could leave the office led strip at 30%/);
  assert.match(s.finding.body, /On 4 of the 5 days it set the office led strip, you changed the brightness to 20–35% soon after \(it sets 80%\)/);
  assert.equal(s.finding.fix, 'Make it 30%');
  const undo = h.hub.checker.fix(s.id);
  assert.deepEqual((h.autoOf('desk').actions[0] as Extract<Automation['actions'][0], { kind: 'set' }>).targets.office_strip, { on: true, bri: 30 });
  undo();
  assert.deepEqual((h.autoOf('desk').actions[0] as Extract<Automation['actions'][0], { kind: 'set' }>).targets.office_strip, { on: true, bri: 80 });
  await h.hub.stop();
});

test('dimmed gradually by hand: Kova suggests easing it down instead', async () => {
  const lamp = auto({ id: 'lamp_on', name: 'Lamp on', triggers: [{ kind: 'time', at: { kind: 'time', at: '20:00' } }], actions: [{ kind: 'set', targets: { lamp: { on: true, bri: 90 } } }] });
  const h = await home([lamp]);
  for (let k = 1; k <= 4; k++) {
    const d = day(k);
    log(h.hub, at(20, d), 'lamp', { on: true, bri: 90 }, { on: false }, byAuto(lamp));
    log(h.hub, at(hm(20, 5), d), 'lamp', { bri: 70 }, { bri: 90 }, you);
    log(h.hub, at(hm(20, 7), d), 'lamp', { bri: 50 }, { bri: 70 }, you);
    log(h.hub, at(hm(20, 10), d), 'lamp', { bri: 30 }, { bri: 50 }, you);
  }
  h.now(4);
  const s = h.find('auto-value', 'lamp_on')!;
  assert.equal(s.finding.fix, 'Ease it to 30% over 5 min');
  const undo = h.hub.checker.fix(s.id);
  assert.deepEqual(h.autoOf('lamp_on').actions[1], { kind: 'ramp', targets: { lamp: {} }, field: 'bri', to: 30, overSec: 300, stepSec: 60 });
  undo();
  assert.equal(h.autoOf('lamp_on').actions.length, 1);
  await h.hub.stop();
});

/** Taking one light further than its ramp: an evening ramp for every light ends at 10%, and you take one to 5–7%. */
const glow = auto({
  id: 'glow', name: 'Evening glow', triggers: [{ kind: 'time', at: { kind: 'sun', event: 'sunset', offsetMin: -15 } }],
  actions: [{ kind: 'set', targets: { 'type:light': { on: true, bri: 30 } } }, { kind: 'ramp', targets: { 'type:light': {} }, field: 'bri', to: 10, overSec: 120, stepSec: 60 }],
});

test('a ramp for every light that you take further for one: that light gets its own end, and the ramp honours it', async () => {
  const h = await home([glow]);
  const dims: (number[] | null)[] = [[7, 5], [5], [7], null];
  dims.forEach((vs, i) => {
    const d = day(i + 1);
    log(h.hub, at(18, d), 'office_strip', { on: true, bri: 30 }, { on: false }, byAuto(glow));
    for (const [hh, b] of [[21, 25], [hm(21, 20), 18], [hm(21, 40), 12], [22, 10]] as const) log(h.hub, at(hh, d), 'office_strip', { bri: b }, { bri: 30 }, byAuto(glow));
    vs?.forEach((v, j) => log(h.hub, at(hm(22, 10 + j), d), 'office_strip', { bri: v }, { bri: 10 }, you));
  });
  h.now(4);
  const s = h.find('auto-value', 'glow');
  assert.ok(s);
  assert.match(s.finding.title, /could leave the office led strip at 5%/);
  assert.match(s.finding.body, /to 5–7% soon after \(its ramp ends at 10%\)/);
  const undo = h.hub.checker.fix(s.id);
  const ramp = h.autoOf('glow').actions[1] as Extract<Automation['actions'][0], { kind: 'ramp' }>;
  assert.deepEqual(ramp.toFor, { office_strip: 5 });
  assert.equal(ramp.to, 10, 'the other lights still end at 10%');

  // Run it: every dimmer eases to 10%, the strip to 5%.
  await h.hub.reg.command('lamp', { on: true, bri: 100 }, you);
  await h.hub.reg.command('office_strip', { on: true, bri: 100 }, you);
  const p = h.hub.engine.automations.runNow(h.autoOf('glow'), 'test');
  for (let i = 0; i < 4; i++) { h.clock.t += 60_000; await h.hub.engine.tick(h.clock.t); await new Promise(r => setTimeout(r, 10)); }
  await p;
  assert.equal(h.dev('lamp').bri, 10);
  assert.equal(h.dev('office_strip').bri, 5);
  undo();
  assert.equal((h.autoOf('glow').actions[1] as { toFor?: unknown }).toFor, undefined);
  await h.hub.stop();
});

test('near-misses for corrections: too few days, either way, and only the device catching up', async () => {
  for (const [why, vals, echoOnly] of [
    ['2 of 6 days', [30, null, null, 25, null, null], false],
    ['up some days, down others', [30, 95, 25, 100], false],
    ['device echoes only', [null, null, null, null], true],
  ] as [string, (number | null)[], boolean][]) {
    const h = await home([desk]);
    vals.forEach((v, i) => {
      const d = day(i + 1);
      log(h.hub, at(19, d), 'office_strip', { on: true, bri: 80 }, { on: false }, byAuto(desk));
      if (echoOnly) log(h.hub, at(19, d) + 20_000, 'office_strip', { bri: 60 }, { bri: 80 }, { kind: 'device', label: 'Tuya' });
      if (v != null) log(h.hub, at(hm(19, 10), d), 'office_strip', { bri: v }, { bri: 80 }, you);
    });
    h.now(vals.length);
    assert.equal(h.find('auto-value'), undefined, why);
    await h.hub.stop();
  }
});

// -------------------------------------------------------------- 3. undone --

const sounds = auto({ id: 'sounds', name: 'Bedtime sounds', triggers: [{ kind: 'time', at: { kind: 'time', at: '20:30' } }], actions: [{ kind: 'set', targets: { master_speaker: { on: true, media: 'Rain sounds', vol: 20 } } }] });

test('an automation you undo when the TV is on: only run it when nobody is watching', async () => {
  const h = await home([sounds]);
  const tvOn = [true, true, false, true, true, true, false];
  tvOn.forEach((tv, i) => {
    const d = day(i + 1);
    if (tv) log(h.hub, at(20, d), 'bedroom_tv', { on: true }, { on: false }, remote);
    log(h.hub, at(hm(20, 30), d), 'master_speaker', { on: true, media: 'Rain sounds', vol: 20 }, { on: false, media: null }, byAuto(sounds));
    if (tv) log(h.hub, at(hm(20, 35), d), 'master_speaker', { on: false, media: null }, { on: true, media: 'Rain sounds' }, you);
    if (tv) log(h.hub, at(23, d), 'bedroom_tv', { on: false }, { on: true }, remote);
  });
  h.now(7);
  const s = h.find('auto-condition', 'sounds');
  assert.ok(s);
  assert.match(s.finding.title, /“Bedtime sounds” could run only when nobody’s watching the bedroom oled/);
  assert.match(s.finding.body, /On 5 of the 7 days it started the master bed speaker, you stopped it within 20 minutes, each time the bedroom oled was on/);
  assert.equal(s.finding.evidence!.length, 7, 'kept days shown too');
  const undo = h.hub.checker.fix(s.id);
  assert.deepEqual(h.autoOf('sounds').conditions, [{ kind: 'device', device: 'bedroom_tv', is: { on: false } }]);
  undo();
  assert.deepEqual(h.autoOf('sounds').conditions, []);
  await h.hub.stop();
});

test('an automation you undo with no pattern Kova can see: pause it', async () => {
  const hall = auto({ id: 'hall', name: 'Office light on', triggers: [{ kind: 'time', at: { kind: 'time', at: '19:00' } }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
  const h = await home([hall]);
  for (let k = 1; k <= 5; k++) {
    log(h.hub, at(19, day(k)), 'office_light', { on: true }, { on: false }, byAuto(hall));
    if (k <= 4) log(h.hub, at(hm(19, 5), day(k)), 'office_light', { on: false }, { on: true }, you);
  }
  h.now(5);
  const s = h.find('auto-pause', 'hall')!;
  assert.match(s.finding.title, /You usually undo “Office light on”/);
  assert.equal(s.finding.fix, 'Pause it');
  const undo = h.hub.checker.fix(s.id);
  assert.equal(h.autoOf('hall').enabled, false);
  undo();
  assert.equal(h.autoOf('hall').enabled, true);
  await h.hub.stop();
});

test('near-misses for undoing: turned off much later, or only now and then', async () => {
  for (const [why, offAt, days] of [['45 minutes later is just the evening', hm(19, 45), [1, 2, 3, 4, 5]], ['2 of 6 days', hm(19, 5), [1, 4]]] as [string, number, number[]][]) {
    const hall = auto({ id: 'hall', name: 'Office light on', triggers: [{ kind: 'time', at: { kind: 'time', at: '19:00' } }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
    const h = await home([hall]);
    for (let k = 1; k <= 6; k++) {
      log(h.hub, at(19, day(k)), 'office_light', { on: true }, { on: false }, byAuto(hall));
      if (days.includes(k)) log(h.hub, at(offAt, day(k)), 'office_light', { on: false }, { on: true }, you);
    }
    h.now(6);
    assert.equal(h.find('auto-pause') ?? h.find('auto-condition'), undefined, why);
    await h.hub.stop();
  }
});

// -------------------------------------------------------------- 4. chains --

test('A then B by hand on most days: suggest “when A, do B”, and undo it', async () => {
  const h = await home([]);
  for (let k = 1; k <= 6; k++) {
    const d = day(k);
    log(h.hub, at(19, d), 'bedroom_tv', { on: true }, { on: false }, remote);
    log(h.hub, at(22, d) + k * 60_000, 'bedroom_tv', { on: false }, { on: true }, remote);
    if (k <= 5) log(h.hub, at(22, d) + (k + 2) * 60_000, 'office_light', { on: false }, { on: true }, you);
  }
  h.now(6);
  const s = h.find('chain');
  assert.ok(s);
  assert.equal(s.id, 'learn:chain:bedroom_tv:off:office_light:off');
  assert.match(s.finding.title, /When the bedroom oled turns off, turn off the office ceiling\?/);
  assert.match(s.finding.body, /On 5 of the 6 days the bedroom oled turned off, you did the office ceiling by hand about 2 minutes later, always between 22:03 and 22:07/);
  const undo = h.hub.checker.fix(s.id);
  const a = h.hub.config.get().automations!.find(x => x.id === 'learned_bedroom_tv_off_office_light')!;
  assert.deepEqual(a.triggers, [{ kind: 'device', device: 'bedroom_tv', to: { on: false } }]);
  assert.deepEqual(a.actions, [{ kind: 'set', targets: { office_light: { on: false } } }]);
  assert.deepEqual(a.conditions, [{ kind: 'time', after: { kind: 'time', at: '21:00' }, before: { kind: 'time', at: '23:10' } }]);
  assert.ok(!h.learner.suggestions().some(x => x.kind === 'chain'), 'not suggested again once it exists');
  undo();
  assert.ok(!(h.hub.config.get().automations ?? []).some(x => x.id === a.id));
  await h.hub.stop();
});

test('near-misses for chains: B only sometimes after A, or in the same instant (one command)', async () => {
  for (const [why, gapMs, bDays] of [['2 of 6 days', 2 * 60_000, [1, 4]], ['same burst', 1_000, [1, 2, 3, 4, 5, 6]]] as [string, number, number[]][]) {
    const h = await home([]);
    for (let k = 1; k <= 6; k++) {
      const d = day(k);
      log(h.hub, at(19, d), 'bedroom_tv', { on: true }, { on: false }, remote);
      log(h.hub, at(22, d), 'bedroom_tv', { on: false }, { on: true }, you);
      if (bDays.includes(k)) log(h.hub, at(22, d) + gapMs, 'office_light', { on: false }, { on: true }, you);
    }
    h.now(6);
    assert.equal(h.find('chain'), undefined, why);
    await h.hub.stop();
  }
});

// --------------------------------------------------------------- 5. drift --

const sunset = (k: number, plusMin: number) => resolveRhythm({ kind: 'sun', event: 'sunset' }, day(k), { timezone: TZ, latitude: -31.95, longitude: 115.86 })! + plusMin * 60_000;

test('a time that moves with sunset: the habit follows sunset, not a fixed time', async () => {
  const h = await home([]);
  const jitter = [0, 1, -1, 1, 0, -1, 1, 0, -1, 0, 1, -1, 0, 1];
  for (let k = 1; k <= 14; k++) log(h.hub, sunset(k, 12 + jitter[k - 1]), 'front_1', { on: true }, { on: false }, you);
  h.now(14);
  const s = h.learner.suggestions().find(x => x.kind === 'moment' && x.device === 'front_1');
  assert.ok(s);
  assert.deepEqual(s.rhythm, { kind: 'sun', event: 'sunset', offsetMin: 10 });
  assert.match(s.finding.body, /moved with sunset/);
  const undo = h.hub.checker.fix(s.id);
  assert.deepEqual(h.hub.config.get().moments.find(m => m.targets.front_1)!.at, { kind: 'sun', event: 'sunset', offsetMin: 10 });
  undo();
  await h.hub.stop();
});

test('an automation at a fixed time that you beat by hand around sunset: follow sunset', async () => {
  const porch = auto({ id: 'porch', name: 'Path lights on', triggers: [{ kind: 'time', at: { kind: 'time', at: '19:30' } }], actions: [{ kind: 'set', targets: { front_2: { on: true } } }] });
  const h = await home([porch]);
  h.hub.store.append({ kind: 'run', device: null, feed: 'auto', what: 'Path lights on', data: { automation: 'porch', changed: [] }, cause: byAuto(porch), ts: at(19.5, day(1)) });
  const jitter = [0, 1, -1, 1, 0, -1, 1, 0, -1, 0, 1, -1, 0, 1, 0, -1];
  for (let k = 2; k <= 17; k++) log(h.hub, sunset(k, 5 + jitter[k - 2]), 'front_2', { on: true }, { on: false }, you);
  h.now(17);
  const s = h.find('auto-time', 'porch')!;
  assert.match(s.finding.title, /could follow sunset/);
  h.hub.checker.fix(s.id);
  assert.deepEqual(h.autoOf('porch').triggers[0], { kind: 'time', at: { kind: 'sun', event: 'sunset', offsetMin: 5 } });
  await h.hub.stop();
});

test('a fixed-time habit stays a fixed time', async () => {
  const h = await home([]);
  const mins = [20, 22, 18, 21, 19, 23, 20, 17, 22, 20, 19, 21, 18, 20];
  for (let k = 1; k <= 14; k++) log(h.hub, at(hm(18, mins[k - 1]), day(k)), 'front_1', { on: true }, { on: false }, you);
  h.now(14);
  const s = h.learner.suggestions().find(x => x.kind === 'moment' && x.device === 'front_1')!;
  assert.equal(s.rhythm, undefined);
  assert.equal(s.at, '18:20');
  await h.hub.stop();
});

// ---------------------------------------------- Not now, never, Ask Kova --

test('Not now, Don’t suggest again, Suggest again, the learning switch and What Kova has learned', async () => {
  const h = await earlyNights({ times: [hm(21, 10), hm(21, 20), hm(21, 15), null, hm(21, 5), hm(21, 25), hm(21, 12)] });
  const app = await buildServer(h.hub, { webRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../web') });
  try {
    const id = 'learn:auto-time:rain_bed:2115';
    const post = (url: string, payload?: object) => app.inject({ method: url.startsWith('PUT ') ? 'PUT' : 'POST', url: url.replace(/^PUT /, ''), payload: payload ?? {} });
    assert.ok(h.hub.checker.findings().some(f => f.id === id));

    let r = await post(`/api/findings/${encodeURIComponent(id)}/snooze`);
    assert.equal(r.statusCode, 200);
    assert.ok(!h.hub.checker.findings().some(f => f.id === id), 'put off');
    assert.equal(h.learner.view().items.find(i => i.id === id)!.status, 'later');
    h.clock.t += 8 * 86400_000;
    assert.equal(h.learner.status(id), 'new', 'back after a week');
    h.clock.t -= 8 * 86400_000;

    r = await post(`/api/findings/${encodeURIComponent(id)}/dismiss`);
    assert.equal(h.learner.view().items.find(i => i.id === id)!.status, 'never');
    r = await post(`/api/findings/${encodeURIComponent(id)}/restore`);
    assert.equal(r.statusCode, 200);
    assert.ok(h.hub.checker.findings().some(f => f.id === id), 'suggested again');

    r = await app.inject({ method: 'GET', url: `/api/findings/${encodeURIComponent(id)}/why` });
    assert.match(r.json().text, /The days: .*21:10/);

    r = await post('PUT /api/home', { learnFromYou: false });
    assert.equal(r.statusCode, 200);
    assert.ok(!h.hub.checker.findings().some(f => f.learned), 'learning off: nothing learned shown');
    assert.equal(h.learner.view().on, false);
    r = await post('PUT /api/home', { learnFromYou: true });
    assert.ok(h.hub.checker.findings().some(f => f.id === id));
    r = await post('PUT /api/home', { learnFromYou: 'yes' });
    assert.equal(r.statusCode, 400);
  } finally { await app.close(); await h.hub.stop(); }
});

test('Ask Kova explains a suggestion and applies it when asked', async () => {
  const h = await earlyNights({ times: [hm(21, 10), hm(21, 20), hm(21, 15), null, hm(21, 5), hm(21, 25), hm(21, 12)] });
  let r = await h.hub.assistant.ask('Why do you suggest moving rain at bedtime?');
  assert.match(r.text, /could start at 21:15.*The days: /);
  assert.equal(r.source, 'Built-in · nothing left your home');
  assert.deepEqual(r.actions[0].action, { type: 'suggestion', id: 'learn:auto-time:rain_bed:2115' });
  const done = await h.hub.assistant.act(r.actions[0].action);
  assert.match(done.text, /Rain at bedtime now starts at 21:15/);
  assert.deepEqual(h.autoOf('rain_bed').triggers[0], { kind: 'time', at: { kind: 'time', at: '21:15' } });
  await h.hub.engine.undo(done.undo!);
  assert.deepEqual(h.autoOf('rain_bed').triggers[0], { kind: 'time', at: { kind: 'time', at: '22:00' } });

  r = await h.hub.assistant.ask('what have you learned?');
  assert.match(r.text, /Kova noticed 1 thing: “Rain at bedtime” could start at 21:15/);
  r = await h.hub.assistant.ask('apply the rain at bedtime suggestion');
  assert.match(r.text, /now starts at 21:15/);
  assert.ok(r.undo);
  await h.hub.stop();
});
