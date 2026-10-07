import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckError, checkCondition, checkTrigger } from '../src/engine/automation-check.ts';
import { rhythm } from '../src/engine/validate.ts';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';
import type { Automation } from '../src/model/types.ts';

// What models (and people) send for times of day, read as what they plainly mean; and errors that say what to send.

const ctx = { device: () => undefined, cfg: { modes: [], overlays: [], people: [], rooms: [], timezone: 'UTC' } };
const SUNSET_15 = { kind: 'time', at: { kind: 'sun', event: 'sunset', offsetMin: -15 } };

test('A bare rhythm, or a near miss of one, is a time trigger at it', () => {
  const same: unknown[] = [
    { kind: 'sun', event: 'sunset', offsetMin: -15 },
    { kind: 'sun', event: 'sunset', offset: -15 },
    { kind: 'sun', event: 'sunset', offsetMinutes: '-15' },
    { kind: 'sun', event: 'sunset', before: 15 },
    { event: 'sunset', before: 15 },
    { kind: 'sunset', offsetMin: -15 },
    'sunset-15', 'sunset - 15 min', '15 min before sunset', '15 minutes before Sunset',
    { kind: 'time', at: 'sunset-15' },
    { kind: 'time', at: 'sunset', offsetMin: -15 },
    { kind: 'time', at: 'sunset', offset: -15 },
    { kind: 'time', at: { kind: 'sun', event: 'sunset' }, offsetMin: -15 },
    { kind: 'time', at: { event: 'sunset', offset: -15 } },
    SUNSET_15,
  ];
  for (const t of same) assert.deepEqual(checkTrigger(t, ctx), SUNSET_15, JSON.stringify(t));
  assert.deepEqual(checkTrigger({ kind: 'sun', event: 'sunrise', after: 30, days: [1, 2] }, ctx), { kind: 'time', at: { kind: 'sun', event: 'sunrise', offsetMin: 30 }, days: [1, 2] });
  assert.deepEqual(checkTrigger({ kind: 'prayer', event: 'isha', offset: 10 }, ctx), { kind: 'time', at: { kind: 'prayer', prayer: 'isha', offsetMin: 10 } });
  assert.deepEqual(checkTrigger('21:00', ctx), { kind: 'time', at: { kind: 'time', at: '21:00' } });
  assert.deepEqual(checkTrigger({ kind: 'time', at: '9:05' }, ctx), { kind: 'time', at: { kind: 'time', at: '09:05' } });
  assert.deepEqual(checkTrigger({ kind: 'time', at: 'an hour after sunrise' }, ctx), { kind: 'time', at: { kind: 'sun', event: 'sunrise', offsetMin: 60 } });
  assert.deepEqual(rhythm('isha+10'), { kind: 'prayer', prayer: 'isha', offsetMin: 10 });
  assert.equal(rhythm('teatime'), undefined);
});

test('A sun time as a condition: after or before it when it says which, else an error saying what to send', () => {
  assert.deepEqual(checkCondition({ kind: 'sun', event: 'sunset', when: 'after' }, ctx), { kind: 'time', after: { kind: 'sun', event: 'sunset' } });
  assert.deepEqual(checkCondition({ kind: 'time', after: 'sunset+30', before: '23:00' }, ctx), { kind: 'time', after: { kind: 'sun', event: 'sunset', offsetMin: 30 }, before: { kind: 'time', at: '23:00' } });
  assert.throws(() => checkCondition({ kind: 'sun', event: 'sunset' }, ctx), (e: CheckError) => /after/.test(e.message) && /\{kind:'time', after:\{kind:'sun',event:'sunset'\}\}/.test(e.fix ?? ''));
});

test('Every validation error has a fix built from what was sent (the editor only shows the message)', () => {
  const err = (f: () => unknown) => { try { f(); } catch (e) { return e as CheckError; } throw new Error('did not throw'); };
  const big = err(() => checkTrigger({ kind: 'sun', event: 'sunset', offsetMin: -500 }, ctx));
  assert.match(big.message, /^That time isn’t valid/);
  assert.match(big.fix!, /You sent \{kind:'sun',event:'sunset',offsetMin:-500\}.*offsetMin:-15.*-240 to 240/);
  const kind = err(() => checkTrigger({ kind: 'weather', when: 'rain' }, ctx));
  assert.equal(kind.message, 'Unknown kind of trigger weather');
  assert.match(kind.fix!, /Trigger kinds are time, device/);
  assert.match(err(() => checkCondition({ kind: 'clock' }, ctx)).fix!, /Condition kinds are/);
  assert.match(err(() => checkTrigger({ kind: 'once', at: 'tomorrow' }, ctx)).fix!, /You sent at:'tomorrow'\. Send \{kind:'once', at:'\d{4}-\d\d-\d\dT\d\d:\d\d'\}/);
  assert.match(err(() => checkTrigger({ kind: 'device', device: 'Lamp', to: { on: true } }, ctx)).fix!, /device id exactly as the Devices list shows/);
});

const sunsetAutos = (c: { automations?: Automation[] }) => {
  const set = (id: string, name: string, at: Automation['triggers'][number], targets: Record<string, object>): Automation =>
    ({ id, name, enabled: true, mode: 'single', triggers: [at], conditions: [], actions: [{ kind: 'set', targets }] });
  c.automations = [
    ...(c.automations ?? []),
    set('porch_on_sunset_ab12', 'Porch light at sunset', { kind: 'time', at: { kind: 'sun', event: 'sunset' } }, { front_1: { on: true } }),
    set('lounge_glow_cd34', 'Lounge glow at sunset', { kind: 'time', at: { kind: 'sun', event: 'sunset' } }, { lamp: { on: true, bri: 40 } }),
    set('blinds_sunset_ef56', 'Speaker chime at sunset', { kind: 'time', at: { kind: 'sun', event: 'sunset' } }, { master_speaker: { on: true, media: 'Radio' } }),
    set('garden_sunrise_gh78', 'Path lights off at sunrise', { kind: 'time', at: { kind: 'sun', event: 'sunrise' } }, { front_2: { on: false } }),
  ];
};

test('Regression: “start the sunset light automations 15 min before sunset” — the bad shape is accepted, each one updated, the reply names each', async () => {
  // Exactly the call the model made: a bare sun rhythm as the trigger, which the hub used to refuse ("Unknown kind of trigger sun").
  const model = await fakeModel([
    (body: any) => {
      const sys = body.messages[0].content as string;
      assert.match(sys, /porch_on_sunset_ab12 "Porch light at sunset".*when At sunset/);
      return calls(
        ['update_automation', { id: 'porch_on_sunset_ab12', when: [{ kind: 'sun', event: 'sunset', offsetMin: -15 }] }],
        ['update_automation', { id: 'lounge_glow_cd34', when: [{ kind: 'sun', event: 'sunset', offsetMin: -15 }] }],
      );
    },
    (body: any) => {
      const res = lastResults(body);
      assert.ok(res.every(r => r.ok), JSON.stringify(res));
      return say(`These now start 15 minutes before sunset:\n${res.map(r => `- ${r.name}`).join('\n')}`);
    },
  ]);
  const h = await askHome({ tweak: sunsetAutos });
  await h.useModel(model.url);
  const r = await h.ask('Change the light automations that started on sunset to start 15 min before sunset');
  const autos = h.hub.config.get().automations!;
  for (const id of ['porch_on_sunset_ab12', 'lounge_glow_cd34']) assert.deepEqual(autos.find(a => a.id === id)!.triggers, [SUNSET_15], id);
  // Not a light, and not at sunset: left alone.
  assert.deepEqual(autos.find(a => a.id === 'blinds_sunset_ef56')!.triggers, [{ kind: 'time', at: { kind: 'sun', event: 'sunset' } }]);
  assert.deepEqual(autos.find(a => a.id === 'garden_sunrise_gh78')!.triggers, [{ kind: 'time', at: { kind: 'sun', event: 'sunrise' } }]);
  assert.equal(r.text, 'These now start 15 minutes before sunset:\n- Porch light at sunset\n- Lounge glow at sunset');
  assert.doesNotMatch(r.text, /format|kind|trigger/i, 'no jargon reached the owner');
  await h.close(); await model.close();
});

test('A shape the hub can’t read: the error says what to send, the model corrects itself, the owner never sees it', async () => {
  const model = await fakeModel([
    calls(['update_automation', { id: 'porch_on_sunset_ab12', when: [{ kind: 'sundown', minutes: 'fifteen' }] }]),
    (body: any) => {
      const [res] = lastResults(body);
      assert.equal(res.ok, false);
      assert.match(res.sendInstead, /\{kind:'time', at:\{kind:'sun', event:'sunset', offsetMin:-15\}\}/);
      assert.match(res.next, /Never ask the user about formats/);
      return calls(['update_automation', { id: 'porch_on_sunset_ab12', when: [SUNSET_15] }]);
    },
    say('Porch light at sunset now starts 15 minutes before sunset.'),
  ]);
  const h = await askHome({ tweak: sunsetAutos });
  await h.useModel(model.url);
  const r = await h.ask('make the porch sunset automation start a quarter hour earlier');
  assert.deepEqual(h.hub.config.get().automations!.find(a => a.id === 'porch_on_sunset_ab12')!.triggers, [SUNSET_15]);
  assert.equal(r.text, 'Porch light at sunset now starts 15 minutes before sunset.', 'the fixed failure is not reported');
  // The system prompt forbids format questions.
  assert.match(model.received[0]!.body.messages[0].content, /Never ask the user about formats, ids, schemas or tool shapes/);
  await h.close(); await model.close();
});
