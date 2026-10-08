import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub } from './helpers.ts';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';
import { notDirect } from '../src/assistant/assistant.ts';
import { toolDefs } from '../src/assistant/ai.ts';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { prayerView } from '../src/services/prayer.ts';
import type { AnnounceAction, HomeConfig } from '../src/model/types.ts';

/** A Helix box, from an integration of its own. */
class BoxAdapter extends VirtualAdapter { id = 'boxes'; }

/** The owner's request, word for word, as it reached Ask Kova. */
const OWNER = 'Every prayer call (adhan) to be played on all speakers at 15% volume. The Helix box will be paused during the call. Not all speakers are the same volume: most are the same, the Sonos is louder, the bedroom speaker is louder still, and the soundbar is the loudest, so adjust accordingly. I should be able to turn devices off from the automation if required, in case we have guests. And if something was playing on those speakers, it should continue playing after the adhan.';

// --------------------------------------------------------------- the parser --

test('The built-in parser leaves long, conditional or explained requests to the AI: no overlay grabbed from the middle', async () => {
  const { hub } = await testHub(19);
  const LONG = [
    OWNER,
    'When we have guests over, turn the guest room lights on at sunset and keep the music low',
    'If the movie finishes before 10, turn the lounge lights to 30% so we can tidy up',
    'Every morning open the kitchen blinds and play the jazz stream',
    'Turn off the lights in the kitchen because we are going to the party',
    'Play the radio in the guest room in case the guests want something on',
    'Pause the lounge tv during the doorbell and then carry on',
    'set the lamp to 30% when it gets dark',
    'we have guests coming over so make the guest room warm',
    'turn off the lamp and start movie mode',
    'The guests are asleep, keep the music down in the lounge, and no lights in the hall',
    'start movie mode in the lounge for the guests',
  ];
  for (const q of LONG) {
    assert.equal(hub.assistant.parse(q), null, `grabbed: ${q}`);
    const r = await hub.assistant.ask(q);
    assert.equal(r.understood, false, q);
    assert.equal(hub.engine.overlay, null, `started an overlay from: ${q}`);
  }
  assert.equal(notDirect(OWNER), 'long');
  assert.equal(notDirect('set the lamp to 30% when it gets dark'), 'condition');
  assert.equal(notDirect('turn off the lamp and play jazz'), 'two commands');
  assert.equal(notDirect('when is sunset?'), null, 'a question’s own “when” isn’t a condition');
  assert.equal(notDirect('turn off every light'), null, '“every light” is direct');
  // The built-in reply says why, instead of "I didn't catch that".
  assert.match((await hub.assistant.ask(OWNER)).text, /short, direct commands/);
  // "the guest room lights" is the room, never the Guests overlay.
  assert.equal(hub.assistant.parse('turn off the guest room lights')?.kind, 'power');
  assert.equal(hub.engine.overlay, null);
  await hub.stop();
});

test('Short, direct commands still work built in', async () => {
  const { hub, dev } = await testHub(19);
  const kind = (q: string) => hub.assistant.parse(q);
  assert.deepEqual(kind('start movie'), { kind: 'overlay', id: 'movie', name: 'Movie', end: false });
  assert.deepEqual(kind('guests mode on'), { kind: 'overlay', id: 'guests', name: 'Guests', end: false });
  assert.deepEqual(kind('we have guests'), { kind: 'overlay', id: 'guests', name: 'Guests', end: false });
  assert.deepEqual(kind('guests are here'), { kind: 'overlay', id: 'guests', name: 'Guests', end: false });
  assert.deepEqual(kind('end movie mode'), { kind: 'overlay', id: 'movie', name: 'Movie', end: true });
  assert.deepEqual(kind('the movie is over'), { kind: 'overlay', id: 'movie', name: 'Movie', end: true });
  assert.equal(kind("I'm leaving")?.kind, 'overlay');
  assert.equal(kind('lamp to 30%')?.kind, 'level');
  assert.equal(kind('turn off the kitchen lights')?.kind, 'power');
  assert.equal(kind('turn off every light')?.kind, 'power');
  assert.equal(kind("what's happening tonight?")?.kind, 'tonight');
  assert.equal(kind('downstairs is lounge, kitchen and laundry')?.kind, 'learn');
  assert.equal(kind('guests are lounge and kitchen'), null, 'not a definition of a word');
  await hub.assistant.ask('we have guests');
  assert.equal(hub.engine.overlay?.id, 'guests');
  await hub.assistant.ask('lamp to 30%');
  assert.equal(dev('lamp').bri, 30);
  await hub.stop();
});

// ------------------------------------------------------------ prayer times --

test('Prayer times: off by default for a new home; on for one that already used them or chose a method', async () => {
  const make = async (tweak: (c: HomeConfig) => void) => {
    const hub = new Hub({ dbPath: ':memory:', initialConfig: () => { const c = demoConfig(); tweak(c); return c; }, adapters: [new VirtualAdapter(demoDevices())], tickMs: 0 });
    await hub.start();
    const on = hub.config.get().prayer?.on;
    await hub.stop();
    return on;
  };
  const noPrayer = (c: HomeConfig) => { c.modes = c.modes.map(m => m.start.kind === 'prayer' ? { ...m, start: { kind: 'time', at: '05:30' } } : m); c.moments = c.moments.filter(x => x.at.kind !== 'prayer'); };
  assert.equal(await make(noPrayer), false, 'nothing used prayer times: off');
  assert.equal(await make(() => {}), true, 'the demo home starts a mode at Fajr: on');
  assert.equal(await make(c => { noPrayer(c); c.prayerMethod = 'Karachi'; }), true, 'a method chosen: on');
  assert.equal(await make(c => { noPrayer(c); c.automations = [{ id: 'x', name: 'x', enabled: true, mode: 'single', triggers: [{ kind: 'time', at: { kind: 'prayer', prayer: 'isha' } }], conditions: [], actions: [{ kind: 'stop' }] }]; }), true, 'an automation at Isha: on');
  assert.equal(await make(c => { c.prayer = { on: false }; }), false, 'turned off by the owner stays off');
});

test('Prayer times off: no waqt, no recordings, no prayer words for the AI — but a prayer schedule still runs', async () => {
  const { hub, clock } = await testHub(4, c => { c.prayer = { on: false }; });
  const cfg = hub.config.get();
  const off = prayerView(cfg, clock.t);
  assert.equal(off.on, false);
  assert.equal('next' in off, false);
  const { snapshot } = await import('../src/api/snapshot.ts');
  assert.deepEqual(snapshot(hub).adhans, []);
  assert.ok(!JSON.stringify(toolDefs({ prayer: false })).includes("kind:'prayer'"));
  assert.ok(JSON.stringify(toolDefs({ prayer: true })).includes("kind:'prayer'"));
  // The demo's Dawn mode starts at Fajr, prayer times off or not.
  const dawn = hub.engine.planner.modeAt(clock.t + 3 * 3600_000);
  assert.ok(dawn.mode.id === 'dawn' || dawn.next.id === 'dawn' || cfg.modes.some(m => m.id === 'dawn'));
  // On: today's times, the waqt now and next.
  hub.config.update(c => { c.prayer = { on: true }; });
  const on = prayerView(hub.config.get(), clock.t) as ReturnType<typeof prayerView> & { current?: { prayer: string }; next?: { prayer: string; at: number }; times?: Record<string, number> };
  assert.equal(on.current?.prayer, 'isha', 'before Fajr: last night’s Isha');
  assert.equal(on.next?.prayer, 'fajr');
  assert.ok(on.next!.at > clock.t);
  assert.equal(Object.keys(on.times!).length, 6);
  assert.equal(snapshot(hub).adhans.length, 3);
  await hub.stop();
});

test('PUT /api/prayer: method, Asr, adjustments and the adhan; bad input refused', async () => {
  const h = await askHome();
  const put = (payload: object) => h.app.inject({ method: 'PUT', url: '/api/prayer', payload });
  let r = await put({ on: true, method: 'Karachi', madhab: 'hanafi', adjust: { fajr: 2, isha: -3 }, adhan: { media: 'adhan:beautiful', fajr: 'adhan:short' } });
  assert.equal(r.statusCode, 200, r.body);
  const p = r.json();
  assert.equal(p.on, true); assert.equal(p.method, 'Karachi'); assert.equal(p.madhab, 'hanafi');
  assert.deepEqual(p.adjust, { fajr: 2, isha: -3 });
  assert.deepEqual(p.adhan, { media: 'adhan:beautiful', fajr: 'adhan:short' });
  assert.equal(h.hub.config.get().prayerMethod, 'Karachi');
  r = await put({ adjust: { fajr: 90 } });
  assert.equal(r.statusCode, 400);
  r = await put({ adhan: { media: 'clip:000000000000000000000000' } });
  assert.match(r.json().error, /that clip isn’t on the hub/);
  r = await put({ method: 'Nowhere' });
  assert.equal(r.statusCode, 400);
  await h.close();
});

// ---------------------------------------------------------------- Ask Kova --

const SPEAKER_EXTRA = (c: HomeConfig) => {
  c.prayer = { on: true };
  c.speakerGroups = [{ id: 'whole_home', name: 'Whole home', members: ['living_display', 'master_speaker', 'music_speaker', 'baby_speaker', 'guest_speaker'] }];
};

test('The owner’s message with the AI: one automation, five prayers, every speaker at 15, the box paused, and a question about the audio', async () => {
  const speakers = ['living_display', 'master_speaker', 'music_speaker', 'baby_speaker', 'guest_speaker'];
  let firstSystem = '';
  const model = await fakeModel([
    (body: any) => {
      firstSystem = body.messages[0].content;
      return calls(['create_automation', {
        name: 'Call to prayer', when: [{ kind: 'time', at: { kind: 'prayer', prayer: 'all' } }],
        then: [{ kind: 'announce', vol: 15, targets: Object.fromEntries(speakers.map(id => [id, {}])), pause: ['lounge_box'], restore: true }],
      }]);
    },
    say('I made “Call to prayer”: at each of the five prayers it plays over every speaker at 15% and puts them back after. Which call to prayer should it play: Beautiful adhan, Adhan (short) or The Adhan – Aaqib Azeez? It stays off until you choose. For the loudness, I suggest the bedroom speaker at 70% and the rest as they are. Shall I set that?'),
  ]);
  const h = await askHome({ tweak: SPEAKER_EXTRA });
  await h.hub.reg.addAdapter(new BoxAdapter([{ id: 'lounge_box', name: 'Lounge box', room: 'lounge', type: 'tv', integration: 'Helix', address: 'demo.box', capabilities: ['onoff', 'media', 'pause', 'library'], state: { on: false, media: null } }]));
  await h.useModel(model.url);
  const r = await h.ask(OWNER);
  // The built-in parser didn't take it (no Guests overlay): the AI did.
  assert.equal(h.hub.engine.overlay, null);
  assert.ok(model.received.length >= 2);
  assert.match(firstSystem, /Prayer times: "every prayer"/);
  assert.match(firstSystem, /"speaker":true,"loudness":100/);
  assert.match(firstSystem, /adhan:beautiful \(Beautiful adhan · Adam-synagda · CC0/);
  const autos = h.hub.config.get().automations ?? [];
  assert.equal(autos.length, 1);
  const a = autos[0]!;
  assert.deepEqual(a.triggers.map(t => t.kind === 'time' && t.at.kind === 'prayer' ? t.at.prayer : '?'), ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
  const x = a.actions[0] as AnnounceAction;
  assert.equal(x.kind, 'announce');
  assert.equal(x.vol, 15);
  assert.deepEqual(Object.keys(x.targets).sort(), [...speakers].sort());
  assert.equal(x.media, undefined, 'no audio guessed');
  assert.deepEqual(x.pause, ['lounge_box']);
  assert.equal(x.restore, true);
  assert.equal(a.enabled, false, 'kept off until the audio is chosen');
  // The tool told the model to ask, and the reply does.
  const res = lastResults(model.received[model.received.length - 1]!.body).find((y: any) => y.ok);
  assert.match(res.next, /Ask the user which audio/);
  assert.match(r.text, /Which call to prayer should it play/);
  assert.match(r.text, /switched off until its audio is chosen|stays off until you choose/);
  await h.close(); await model.close();
});

test('The owner confirms: loudness set on each speaker, the audio chosen, the automation switches on; the reply says what each is', async () => {
  const model = await fakeModel([
    calls(['update_device', { id: 'master_speaker', loudness: 70 }], ['update_device', { id: 'music_speaker', loudness: 80 }], ['update_device', { id: 'living_display', loudness: 60 }]),
    (body: any) => {
      const auto = (body.messages[0].content as string).match(/- (call_to_prayer_\w+) "Call to prayer"/)![1];
      return calls(['update_automation', { id: auto, then: [{ kind: 'announce', media: 'adhan:beautiful', vol: 15, targets: { master_speaker: {}, music_speaker: {}, living_display: {} }, restore: true }] }]);
    },
    say('Set: the bedroom speaker plays announcements at 70%, the music room speaker at 80% and the living room display at 60%. Call to prayer now plays the Beautiful adhan, and it’s on.'),
  ]);
  const h = await askHome({
    tweak: c => {
      SPEAKER_EXTRA(c);
      c.automations = [{ id: 'call_to_prayer_ab12', name: 'Call to prayer', enabled: false, mode: 'single', conditions: [],
        triggers: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map(p => ({ kind: 'time' as const, at: { kind: 'prayer' as const, prayer: p as 'fajr' } })),
        actions: [{ kind: 'announce', vol: 15, targets: { master_speaker: {}, music_speaker: {}, living_display: {} }, restore: true }] }];
    },
  });
  await h.useModel(model.url);
  const r = await h.ask('yes set those, and use the beautiful adhan');
  const devs = h.hub.config.get().devices!;
  assert.equal(devs.master_speaker!.announceTrim, 70);
  assert.equal(devs.music_speaker!.announceTrim, 80);
  assert.equal(devs.living_display!.announceTrim, 60);
  const a = h.hub.config.get().automations![0]!;
  assert.equal((a.actions[0] as AnnounceAction).media, 'adhan:beautiful');
  assert.equal(a.enabled, true, 'it had been waiting for its audio');
  assert.match(r.text, /70%/);
  assert.equal(h.hub.reg.get('master_speaker') && h.hub.engine.overlay, null);
  await h.close(); await model.close();
});

test('With prayer times off, the AI can’t start an automation on one', async () => {
  const model = await fakeModel([
    calls(['create_automation', { name: 'x', when: [{ kind: 'time', at: { kind: 'prayer', prayer: 'isha' } }], then: [{ kind: 'notify', message: 'Isha' }] }]),
    say('Prayer times are off in this home, so I can’t do that.'),
  ]);
  const h = await askHome({ tweak: c => { c.prayer = { on: false }; } });
  await h.useModel(model.url);
  await h.ask('remind me at isha every day please, thank you very much kova');
  const sys = model.received[0]!.body.messages[0].content as string;
  assert.match(sys, /Prayer times are off in this home/);
  assert.ok(!JSON.stringify(model.received[0]!.body.tools).includes("kind:'prayer'"));
  assert.match(lastResults(model.received[1]!.body)[0].error, /Prayer times are off/);
  assert.equal((h.hub.config.get().automations ?? []).length, 0);
  await h.close(); await model.close();
});

test('Ask: “I added Fajr adhan in Helix” → looked up with find_music, and its media used for Fajr at the group’s level', async () => {
  const looked: string[] = [];
  const model = await fakeModel([
    calls(['find_music', { name: 'Fajr adhan' }]),
    (body: any) => {
      const found = lastResults(body)[0];
      assert.deepEqual(found, { ok: true, media: 'Album: Fajr Adhan (feat. Abdul Waheed Meerkar)', kind: 'album', announce: 'Song: Fajr Adhan (feat. Abdul Waheed Meerkar)' });
      return calls(['create_automation', {
        name: 'Fajr adhan', when: [{ kind: 'time', at: { kind: 'prayer', prayer: 'fajr' } }],
        then: [{ kind: 'announce', media: found.announce, vol: 10, targets: { group_whole_home: {} }, restore: true }],
      }]);
    },
    say('Done: “Fajr adhan” plays your Fajr Adhan from Helix on Whole home at 10% at Fajr.'),
  ]);
  const h = await askHome({ tweak: c => { c.prayer = { on: true }; c.speakerGroups = [{ id: 'whole_home', name: 'Whole home', members: ['living_display', 'master_speaker'] }]; } });
  (h.hub as unknown as { music: unknown }).music = {
    find: async (w: string) => { looked.push(w); return { media: 'Album: Fajr Adhan (feat. Abdul Waheed Meerkar)', kind: 'album' }; },
    cached: () => [], isMusic: (m: string) => /^song: /i.test(m),
  };
  await h.useModel(model.url);
  await h.ask('I have added Fajr adhan in Helix, use that for Fajr on whole home at 10%');
  assert.deepEqual(looked, ['Fajr adhan']);
  const a = (h.hub.config.get().automations ?? []).find(x => x.name === 'Fajr adhan');
  assert.ok(a, 'made');
  assert.equal((a!.actions[0] as AnnounceAction).media, 'Song: Fajr Adhan (feat. Abdul Waheed Meerkar)');
  assert.ok(toolDefs({ prayer: true }).some(t => t.name === 'find_music'));
  await h.close?.();
  await model.close?.();
});
