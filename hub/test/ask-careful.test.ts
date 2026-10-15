import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';
import { applyEdits, changesBetween, DECLINED, unasked } from '../src/assistant/auto-edit.ts';
import { honestReply } from '../src/assistant/ai.ts';
import type { AnnounceAction, HomeConfig } from '../src/model/types.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';

/** A Helix box, from an integration of its own. */
class BoxAdapter extends VirtualAdapter { id = 'boxes'; }

// Ask Kova changes only what it's asked to, whichever AI runs it: a detail is an edit (the rest is kept by the hub),
// a change the owner's words don't account for is sent back, "No" changes nothing, and the hub — not the model — says
// what changed. Each test replays a conversation an owner really had.

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
const SPEAKERS = ['living_display', 'master_speaker', 'music_speaker', 'baby_speaker', 'guest_speaker'];

/** A home whose call to prayer plays the owner's own recordings on every speaker, one speaker kept quieter. */
const prayerHome = (c: HomeConfig) => {
  c.prayer = { on: true, adhan: { media: 'adhan:azeez' } };
  c.speakerGroups = [{ id: 'whole_home', name: 'Whole home', members: SPEAKERS }];
  c.automations = [{
    id: 'call_to_prayer_1f94', name: 'Call to prayer', enabled: true, mode: 'single',
    triggers: PRAYERS.map(p => ({ kind: 'time' as const, at: { kind: 'prayer' as const, prayer: p } })), conditions: [],
    actions: [{ kind: 'announce', media: 'adhan:beautiful', mediaFor: { fajr: 'adhan:short' }, vol: 20, targets: { group_whole_home: {}, music_speaker: { vol: 12 } }, pause: ['lounge_box'], restore: true }],
  }];
};
const prayerAutos = (h: Awaited<ReturnType<typeof askHome>>) => h.hub.config.get().automations!;

test('“All prayers 1.5× louder except Fajr”: a rebuild that swaps the recording and drops speakers is sent back; copy + edit keeps everything else', async () => {
  const model = await fakeModel([
    // What a model did on a real hub: rebuilt the step from the words it saw — the owner's "chosen" recording, two speakers.
    calls(['update_automation', { id: 'call_to_prayer_1f94', then: [{ kind: 'announce', media: 'adhan:azeez', vol: 30, targets: { living_display: {}, master_speaker: {} }, pause: ['lounge_box'], restore: true }] }]),
    (body: any) => {
      const [res] = lastResults(body);
      assert.equal(res.ok, false);
      assert.match(res.error, /Not saved/);
      assert.match(res.error, /didn’t ask to change what it plays/);
      assert.match(res.error, /didn’t ask to take Whole home, Music Room speaker out|didn’t ask to take .*Whole home/);
      assert.match(res.error, /use edit/);
      // The right way: Fajr is a copy of it as it is, then the original loses Fajr and gets louder.
      return calls(
        ['create_automation', { name: 'Call to prayer – Fajr', from: 'call_to_prayer_1f94', when: [{ kind: 'time', at: { kind: 'prayer', prayer: 'fajr' } }] }],
        ['update_automation', { id: 'call_to_prayer_1f94', edit: { 'when.0': null, 'then.0.vol': 30, 'then.0.targets.music_speaker.vol': 18 } }],
      );
    },
    (body: any) => {
      const [made, changed] = lastResults(body);
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.equal(changed.ok, true, JSON.stringify(changed));
      assert.ok(changed.changed.includes('Volume 20% → 30%'), changed.changed.join(' | '));
      assert.match(changed.check, /didn’t ask for, put it back/);
      return say('Done. Fajr stays as it was, and the other four calls to prayer are now 1.5× louder.');
    },
  ]);
  const h = await askHome({ tweak: prayerHome });
  await h.hub.reg.addAdapter(new BoxAdapter([{ id: 'lounge_box', name: 'Lounge box', room: 'lounge', type: 'tv', integration: 'Helix', address: 'demo.box', capabilities: ['onoff', 'media', 'pause', 'library'], state: { on: false, media: null } }]));
  await h.useModel(model.url);
  const r = await h.ask('The prayer calls except fajr should play at 1.5x the volume it plays now');

  // The model reads each automation exactly as saved, and is told the owner's "chosen" recording is for new ones.
  const system = model.received[0]!.body.messages[0].content as string;
  assert.match(system, /exact: \{"when":\[\{"kind":"time","at":\{"kind":"prayer","prayer":"fajr"\}\}/);
  assert.match(system, /"mediaFor":\{"fajr":"adhan:short"\}/);
  assert.match(system, /An automation that already plays something keeps it/);
  assert.match(system, /"Except X" leaves X as it was before this conversation/);

  const autos = prayerAutos(h);
  const fajr = autos.find(a => a.name === 'Call to prayer – Fajr')!;
  const rest = autos.find(a => a.id === 'call_to_prayer_1f94')!;
  assert.deepEqual(fajr.triggers, [{ kind: 'time', at: { kind: 'prayer', prayer: 'fajr' } }]);
  const fa = fajr.actions[0] as AnnounceAction, ra = rest.actions[0] as AnnounceAction;
  // Fajr: exactly as it was — its recording, every speaker, the quieter one, the box paused.
  assert.equal(fa.vol, 20);
  assert.equal(fa.media, 'adhan:beautiful');
  assert.deepEqual(fa.mediaFor, { fajr: 'adhan:short' });
  assert.deepEqual(fa.targets, { group_whole_home: {}, music_speaker: { vol: 12 } });
  assert.deepEqual(fa.pause, ['lounge_box']);
  // The other four: louder, the quieter speaker in proportion, nothing else touched.
  assert.deepEqual(rest.triggers.map(t => t.kind === 'time' && t.at.kind === 'prayer' && t.at.prayer), ['dhuhr', 'asr', 'maghrib', 'isha']);
  assert.equal(ra.vol, 30);
  assert.equal(ra.media, 'adhan:beautiful');
  assert.deepEqual(ra.targets, { group_whole_home: {}, music_speaker: { vol: 18 } });
  assert.deepEqual(ra.pause, ['lounge_box']);

  // The owner reads what changed, in the hub's words.
  assert.match(r.text, /^Done\. Fajr stays as it was/);
  assert.match(r.text, /Made “Call to prayer – Fajr”:\n- A copy of “Call to prayer”\n- Starts: At .*Dhuhr.* removed/);
  assert.match(r.text, /Changed in “Call to prayer”:\n- Starts: At Fajr removed\n- Volume 20% → 30%\n- Speakers: Speaker’s volume 12% → 18%$/);
  await h.close(); await model.close();
});

test('“No” to a question changes nothing, whatever the model makes of it', async () => {
  const asks = await fakeModel([say('The soundbar is at 100% loudness for announcements. Shall I set it to 10% for every prayer?')]);
  const h = await askHome({ tweak: prayerHome });
  await h.useModel(asks.url);
  await h.ask('The soundbar is louder than the others for prayer, adjust it');
  await asks.close();

  const no = await fakeModel([
    calls(['update_device', { id: 'music_speaker', loudness: 30 }]),
    (body: any) => {
      const [res] = lastResults(body);
      assert.equal(res.ok, false);
      assert.match(res.error, /said no/);
      return say('OK, I’ve left it as it is. What level would you like the soundbar at?');
    },
  ]);
  await h.useModel(no.url);
  const r = await h.ask('No');
  assert.equal(h.hub.config.get().devices?.music_speaker?.announceTrim, undefined, 'its loudness is untouched');
  assert.equal(r.text, 'OK, I’ve left it as it is. What level would you like the soundbar at?');
  assert.equal(r.undo, undefined);
  await h.close(); await no.close();

  // Only a refusal on its own counts: "no, make it 30" is an answer with a change in it.
  assert.ok(DECLINED.test('No') && DECLINED.test('nope.') && DECLINED.test('leave it') && DECLINED.test('Don’t'));
  assert.ok(!DECLINED.test('No, make it 30') && !DECLINED.test('not that one, the other'));
});

test('A change claimed with no tool called is never passed on: the claim goes, the question stays', () => {
  const none = { done: [], couldnt: [] };
  // "Set ac to 19" → "I didn't change anything. Master Bed zone set to 19°." was what an owner got.
  assert.equal(honestReply('Master Bed zone set to 19°.', none, { changed: false, command: true }).text, 'I didn’t change anything.');
  assert.equal(honestReply('You’re right, I apologize — I did set it to 5%, it just came out wrong. Bedroom LED is now at 5%.', none, { changed: false, command: true }).text, 'I didn’t change anything.');
  assert.equal(honestReply('Done. Want me to dim the hall too?', none, { changed: false, command: true }).text, 'I didn’t change anything. Want me to dim the hall too?');
  // Answering a question about state isn't claiming a change.
  assert.equal(honestReply('No, it’s turned off.', none, { changed: false, command: false }).text, 'No, it’s turned off.');
});

test('Edits: paths through when/if/then; null removes; one past the end adds; a path that isn’t there says so', () => {
  const def = { when: [{ kind: 'time', at: '07:00' }], if: [], then: [{ kind: 'announce', vol: 20, targets: { a: {}, b: { vol: 12 } } }] };
  const out = applyEdits(def, { 'then.0.vol': 30, 'then[0].targets.b.vol': 18, 'then.0.targets.c': {}, 'then.0.targets.a': null, 'when.1': { kind: 'time', at: '19:00' } });
  assert.deepEqual(out, { when: [{ kind: 'time', at: '07:00' }, { kind: 'time', at: '19:00' }], if: [], then: [{ kind: 'announce', vol: 30, targets: { b: { vol: 18 }, c: {} } }] });
  assert.equal(def.then[0]!.vol, 20, 'the original is untouched');
  assert.throws(() => applyEdits(def, { 'then.3.vol': 1 }), /then has 1 entry \(0–0\)/);
  assert.throws(() => applyEdits(def, { 'vol': 1 }), /starts with when, if or then/);
  assert.throws(() => applyEdits(def, { 'then': [] }), /send then itself/);
  assert.throws(() => applyEdits(def, { 'then.0.vol.x': 1 }), /is a value/);
  assert.deepEqual(changesBetween({ a: 1, b: [1, 2] }, { a: 2, b: [1] }), [{ path: 'a', was: 1, now: 2 }, { path: 'b.1', was: 2, now: undefined }]);
});

test('What counts as asked: audio changes when the owner names it or asks for other audio; speakers go when named or narrowed to', () => {
  const step = (media: string, targets: Record<string, object>) => ({ when: [], if: [], then: [{ kind: 'announce', media, vol: 20, targets }] });
  const names: Record<string, string> = { whole: 'Whole home', kitchen: 'Kitchen speaker', bar: 'Soundbar' };
  const name = (id: string) => names[id] ?? id;
  const media = (m: string) => ({ 'adhan:azeez': 'The Adhan – Aaqib Azeez', 'Song: Adhan (feat. Abdul Waheed Meerkar)': 'Adhan (feat. Abdul Waheed Meerkar)' } as Record<string, string>)[m] ?? m;
  const was = step('Song: Adhan (feat. Abdul Waheed Meerkar)', { whole: {}, bar: { vol: 12 } });
  const check = (said: string, now: ReturnType<typeof step>) => unasked(was, now, said, name, media);
  const swapped = step('adhan:azeez', { whole: {}, bar: { vol: 12 } });
  assert.equal(check('The prayer calls except fajr should play at 1.5x the volume it plays now', swapped).length, 1, 'louder isn’t other audio');
  assert.equal(check('make the adhan louder, change it to 30', swapped).length, 1);
  assert.deepEqual(check('use the Azeez one', swapped), [], 'named');
  assert.deepEqual(check('play a different recording', swapped), [], 'asked for other audio');
  const fewer = step('Song: Adhan (feat. Abdul Waheed Meerkar)', { kitchen: {} });
  assert.equal(check('play it at 30 on all speakers except at fajr', fewer).length, 1, '“except” about prayers drops no speaker');
  assert.deepEqual(check('only on the kitchen speaker', fewer), [], 'narrowed to the kitchen');
  assert.deepEqual(check('not on the soundbar or the whole home group', fewer), [], 'each named');
});
