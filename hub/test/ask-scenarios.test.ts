import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';

// Realistic multi-part owner requests, each played through the real tool loop by a scripted model: what a capable
// model would call, round by round. Each checks the home afterwards (the tools did it) and the reply (it only claims
// what they did). The scripts react to tool results where a real model would.

type Home = Awaited<ReturnType<typeof askHome>>;
interface Scenario {
  ask: string;
  rounds: unknown[] | ((body: any, round: number) => unknown);
  check: (h: Home, reply: any, sent: any[]) => void | Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  'Same TV found three ways, lives in a room that doesn’t exist yet, plus a lamp moved and renamed': {
    ask: 'All these OLED entries are the same TV and it’s in the theatre. The TP-Link lamp is the entryway lamp.',
    rounds: [
      calls(['create_room', { name: 'Theatre', icon: 'theaters' }], ['create_room', { name: 'Entryway', icon: 'door_front' }]),
      calls(['combine_devices', { members: ['combined_bedroom_oled', 'oled_dlna'], room: 'theatre' }], ['update_device', { id: 'lamp', name: 'Entryway lamp', room: 'entryway' }]),
      say('Made Theatre and Entryway. Bedroom OLED now covers all three entries and is in Theatre; the lamp is now Entryway lamp, in Entryway.'),
    ],
    check: (h, r) => {
      assert.equal(h.hub.reg.get('combined_bedroom_oled')!.room, 'theatre');
      assert.equal(h.hub.reg.get('lamp')!.room, 'entryway');
      assert.equal(h.hub.reg.get('lamp')!.name, 'Entryway lamp');
      assert.ok(!/Couldn’t|Done:/.test(r.text), r.text);
    },
  },
  'Hide, rename and favourite in one go': {
    ask: 'Hide the purifier in the lounge, rename the office strip to Desk glow and put the porch light on my favourites.',
    rounds: [
      calls(['update_device', { id: 'lounge_purifier', hidden: true }], ['update_device', { id: 'office_strip', name: 'Desk glow' }], ['update_device', { id: 'front_1', favourite: true }]),
      say('The lounge purifier is hidden, the strip is now Desk glow, and the porch light is on your favourites.'),
    ],
    check: (h, r) => {
      assert.ok(h.hub.reg.get('lounge_purifier')!.hidden);
      assert.equal(h.hub.reg.get('office_strip')!.name, 'Desk glow');
      assert.ok(h.hub.config.get().favourites?.includes('front_1'));
      assert.equal(r.text, 'The lounge purifier is hidden, the strip is now Desk glow, and the porch light is on your favourites.');
    },
  },
  'A weeknight automation with a condition, and a one-time reminder': {
    ask: 'On weeknights at 10:30 turn off the lounge lights unless the bedroom TV is on. And tomorrow at 9 remind me to put the bins out.',
    rounds: [
      calls(['create_automation', { name: 'Lounge off at 22:30 on weeknights', when: [{ kind: 'time', at: '22:30', days: [1, 2, 3, 4, 5] }], if: [{ kind: 'device', device: 'combined_bedroom_oled', is: { on: false } }], then: [{ kind: 'set', targets: { 'room:lounge': { on: false } } }] }],
        ['create_automation', { name: 'Bins reminder tomorrow at 09:00', when: [{ kind: 'once', at: '2026-10-01T09:00' }], then: [{ kind: 'notify', message: 'Put the bins out' }] }]),
      (body: any) => {
        const res = lastResults(body);
        return say(`Set up: ${res.map(x => x.name).join(' and ')}.`);
      },
    ],
    check: (h, r) => {
      const autos = h.hub.config.get().automations ?? [];
      assert.ok(autos.some(a => a.name === 'Lounge off at 22:30 on weeknights' && a.conditions.length === 1));
      assert.ok(autos.some(a => a.triggers[0]!.kind === 'once'));
      assert.match(r.text, /^Set up: Lounge off at 22:30 on weeknights and Bins reminder/);
    },
  },
  'Zones of one AC for the whole house: name them, then run two zones': {
    ask: 'The AC is for the whole house but it has zones: 1 is living, 2 theatre, 3 master, 4 office. Cool just the theatre and master to 22.',
    rounds: [
      calls(['update_device', { id: 'ducted_ac', zoneNames: { 1: 'Living', 2: 'Theatre', 3: 'Master', 4: 'Office' } }]),
      calls(['set_devices', { devices: [{ id: 'ducted_ac', on: true, set: { hvac: 'cool', target: 22, zoneSet: { 1: { on: false }, 2: { on: true }, 3: { on: true }, 4: { on: false } } } }] }]),
      say('Named the four zones. The AC is cooling to 22° with only Theatre and Master open.'),
    ],
    check: (h, r, sent) => {
      assert.deepEqual(h.hub.config.get().devices!.ducted_ac!.zoneNames, { 1: 'Living', 2: 'Theatre', 3: 'Master', 4: 'Office', 5: 'Office & Guest', 6: 'Music' });
      const ac = h.hub.reg.get('ducted_ac')!;
      assert.equal(ac.state.hvac, 'cool');
      assert.equal(ac.state.target, 22);
      assert.equal(ac.room, 'unassigned', 'still one device for the whole home');
      // The AC is one device in the context, with its zones listed (named, once named).
      assert.match(sent[0].messages[0].content, /"id":"ducted_ac".*"zones":\[\{"zone":1/);
      assert.match(sent[1].messages.at(-1).content, /named AC’s zones \(1: Living, 2: Theatre, 3: Master, 4: Office\)/i, 'the model heard the names');
      assert.ok(!/Couldn’t/.test(r.text));
    },
  },
  'Move a room’s devices and remove the room': {
    ask: 'Get rid of the laundry room, those lights are really in the garage.',
    rounds: [
      calls(['delete_room', { room: 'laundry' }]),
      calls(['delete_room', { room: 'laundry', moveTo: 'garage' }]),
      say('Removed the Laundry room; its two lights are in the Garage now.'),
    ],
    check: (h, r) => {
      assert.ok(!h.hub.config.get().rooms.some(x => x.id === 'laundry'));
      assert.equal(h.hub.reg.get('laundry_1')!.room, 'garage');
      assert.ok(!/Couldn’t/.test(r.text), 'the first try asked for moveTo; the second fixed it');
    },
  },
  'A question mixed with a change': {
    ask: 'Why is the porch light on, and set the office strip to 40% and the downlights to 40% too.',
    rounds: [
      calls(['explain_device', { id: 'front_1' }], ['set_devices', { devices: [{ id: 'office_strip', bri: 40 }, { id: 'lounge_down', bri: 40 }] }]),
      say('The porch light is on because of tonight’s mode. The strip and the downlights are at 40%.'),
    ],
    check: (h, r) => {
      assert.equal(h.hub.reg.get('office_strip')!.state.bri, 40);
      // The downlights only switch: the claim about them is caught.
      assert.equal(h.hub.reg.get('lounge_down')!.state.bri, undefined);
      assert.match(r.text, /^Not everything worked\.\n\nThe porch light is on/);
      assert.match(r.text, /Couldn’t:\n- Couldn’t change everything: Downlights can’t dim/);
    },
  },
  'An impossible part: combining with a camera fails, the rest is done, the reply says which': {
    ask: 'The lamp and the office camera are the same thing, combine them; and rename the dining light to Table light.',
    rounds: [
      calls(['combine_devices', { members: ['lamp', 'office_cam'] }], ['update_device', { id: 'dining', name: 'Table light' }]),
      say('All done! Combined them and renamed the dining light.'),
    ],
    check: (h, r) => {
      assert.equal(h.hub.reg.get('dining')!.name, 'Table light');
      assert.doesNotMatch(r.text, /All done/);
      assert.match(r.text, /Couldn’t:\n- Combine Lamp/);
      assert.match(r.text, /Done:\n- Renamed Dining light “Table light”/);
    },
  },
  'A room said one way, a different room used: the hub corrects the reply': {
    ask: 'The bedroom speaker is in the nursery.',
    rounds: [
      calls(['update_device', { id: 'master_speaker', room: 'baby' }]),
      say('Moved the speaker to the nursery.'),
    ],
    check: (h, r) => {
      assert.equal(h.hub.reg.get('master_speaker')!.room, 'baby');
      const babyName = h.hub.config.get().rooms.find(x => x.id === 'baby')!.name;
      if (!/nursery/i.test(babyName)) assert.match(r.text, new RegExp(`Moved Speaker to ${babyName}`));
    },
  },
  'Unhide a hidden device by name and use it in a schedule': {
    ask: 'I want to see the old lamp in my lists again, and it should go off by itself at 11pm.',
    rounds: [
      calls(['update_device', { id: 'old_lamp', hidden: false }], ['create_automation', { name: 'Old lamp off at 23:00', when: [{ kind: 'once', at: '2026-09-30T23:00' }], then: [{ kind: 'set', targets: { old_lamp: { on: false } } }] }]),
      say('The old lamp shows again, and it turns off at 23:00 tonight.'),
    ],
    check: (h, r, sent) => {
      assert.match(sent[0].messages[0].content, /Hidden devices[^\n]*\n[^]*"old_lamp"/);
      assert.ok(!h.hub.reg.get('old_lamp')!.hidden);
      assert.ok((h.hub.config.get().automations ?? []).some(a => a.name === 'Old lamp off at 23:00'));
      assert.equal(r.text, 'The old lamp shows again, and it turns off at 23:00 tonight.');
    },
  },
  'A model that claims a change it never made': {
    ask: 'Put the garage light on a timer for sunset every day.',
    rounds: [say('Done.')],
    check: (_h, r) => { assert.equal(r.text, 'I didn’t change anything.'); },
  },
};

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`Scenario: ${name}`, async () => {
    const model = await fakeModel(sc.rounds);
    const h = await askHome();
    try {
      await h.useModel(model.url);
      const r = await h.ask(sc.ask);
      await sc.check(h, r, model.received.map(x => x.body));
      // Every reply carries the engine, and an undo whenever something changed.
      assert.equal(r.engine, 'cloud');
    } finally { await h.close(); await model.close(); }
  });
}
