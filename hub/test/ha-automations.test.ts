import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { testHub } from './helpers.ts';
import { convertHaAutomation } from '../src/import/ha-automations.ts';
import { checkAutomation } from '../src/engine/automation-check.ts';

const YAML = `
- id: '1001'
  alias: Porch at sunset
  mode: restart
  triggers:
    - trigger: sun
      event: sunset
      offset: "-00:15:00"
  conditions:
    - condition: state
      entity_id: person.methel
      state: home
    - condition: time
      weekday: [mon, tue, wed, thu, fri]
  actions:
    - action: light.turn_on
      target: { entity_id: light.lamp }
      data: { brightness_pct: 40, color_temp_kelvin: 2700 }
    - delay: "00:10:00"
    - action: notify.mobile_app_phone
      data: { title: Porch, message: Lamp is on }
    - choose:
        - conditions:
            - condition: state
              entity_id: light.office_light
              state: "on"
          sequence:
            - action: light.turn_off
              target: { entity_id: light.office_light }
      default:
        - action: switch.turn_on
          target: { entity_id: switch.desk_plug }
- id: '1002'
  alias: Motion hall
  triggers:
    - trigger: state
      entity_id: binary_sensor.hall_motion
      to: "on"
  actions:
    - action: scene.turn_on
      target: { entity_id: scene.evening }
- id: '1003'
  alias: Last one out
  triggers:
    - trigger: state
      entity_id: person.brishti
      from: home
    - trigger: state
      entity_id: light.lamp
      to: "on"
      for: { minutes: 30 }
  actions:
    - action: light.turn_off
      target: { entity_id: [light.lamp, light.kitchen_thing] }
    - action: script.bedtime
`;

test('Home Assistant automations become Kova automations; what Kova can’t do is listed', async () => {
  const t = await testHub(12);
  try {
    const names: Record<string, string> = { 'light.lamp': 'Lamp', 'light.office_light': 'Office Light', 'switch.desk_plug': 'Desk plug', 'light.kitchen_thing': 'Kitchen thing', 'person.methel': 'Methel', 'person.brishti': 'Brishti', 'binary_sensor.hall_motion': 'Hall motion' };
    // The office light is called "Ceiling" in Kova; its id matches.
    const look = { name: (e: string) => names[e] ?? e, devices: t.hub.reg.list(), people: t.hub.config.get().people };
    const [porch, hall, out] = (parse(YAML) as Record<string, unknown>[]).map(a => convertHaAutomation(a, look));

    const p = porch.automation!;
    assert.equal(p.mode, 'restart');
    assert.equal(p.enabled, false, 'starts off: HA may still run it');
    assert.deepEqual(p.triggers, [{ kind: 'time', at: { kind: 'sun', event: 'sunset', offsetMin: -15 } }]);
    assert.deepEqual(p.conditions, [{ kind: 'presence', who: 'methel', home: true }, { kind: 'time', days: [1, 2, 3, 4, 5] }]);
    assert.deepEqual(p.actions[0], { kind: 'set', targets: { lamp: { on: true, bri: 40, k: 2700 } } });
    assert.deepEqual(p.actions[1], { kind: 'delay', seconds: 600 });
    assert.deepEqual(p.actions[2], { kind: 'notify', message: 'Lamp is on', title: 'Porch' });
    assert.deepEqual(p.actions[3], { kind: 'if', conditions: [{ kind: 'device', device: 'office_light', is: { on: true } }], then: [{ kind: 'set', targets: { office_light: { on: false } } }], else: [{ kind: 'set', targets: { office_plug: { on: true } } }] });
    assert.deepEqual(porch.notes, []);
    // It passes Kova's own checks.
    checkAutomation(p, { device: id => t.hub.reg.get(id), cfg: t.hub.config.get() });

    // Unknown sensor, and a scene: nothing Kova can run.
    assert.equal(hall.automation, null);
    assert.ok(hall.notes.some(n => /Hall motion .* isn’t a Kova device/.test(n)));
    assert.ok(hall.notes.some(n => /Scene/.test(n)));

    // A person leaving, a state held for 30 min; the unmatched light and the script are noted.
    const o = out.automation!;
    assert.deepEqual(o.triggers, [{ kind: 'presence', event: 'leaves', person: 'brishti' }, { kind: 'device', device: 'lamp', to: { on: true }, forSec: 1800 }]);
    assert.deepEqual(o.actions, [{ kind: 'set', targets: { lamp: { on: false } } }]);
    assert.ok(out.notes.some(n => /Kitchen thing/.test(n)));
    assert.ok(out.notes.some(n => /Script/.test(n)));
    assert.deepEqual(o.origin, { from: 'home-assistant', id: '1003', notes: out.notes });
  } finally { await t.hub.stop(); }
});
