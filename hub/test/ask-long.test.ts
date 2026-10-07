import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';
import { honestReply } from '../src/assistant/ai.ts';

// Long, many-step requests to Ask Kova: the job a client follows, the tools that organise a home, and the hub's
// check that the reply only claims what the tools confirmed.

const follow = async (app: Awaited<ReturnType<typeof askHome>>['app'], id: string, onJob?: (j: any) => void) => {
  let rev = 0;
  for (;;) {
    const j = (await app.inject({ method: 'GET', url: `/api/ask/jobs/${id}?rev=${rev}&wait=10` })).json();
    onJob?.(j);
    if (j.status === 'done') return j;
    rev = j.rev;
  }
};

test('A long ask answers at once with a job; following it shows each step live, then the answer', async () => {
  const model = await fakeModel([
    calls(['create_room', { name: 'Theatre', icon: 'theaters' }]),
    calls(['combine_devices', { members: ['combined_bedroom_oled', 'oled_dlna'], room: 'theatre' }]),
    calls(['update_device', { id: 'lamp', room: 'front' }]),
    say('Theatre is set up with the Bedroom OLED, and the lamp is by the Front door.'),
  ], { delayMs: 150 });
  const h = await askHome();
  await h.useModel(model.url);

  const t0 = Date.now();
  const r = await h.ask('these are all the same TV and it lives in the theatre; the lamp is at the front door', true);
  assert.ok(Date.now() - t0 < 140, 'the hub answered before the model did anything');
  assert.ok(r.job?.id, 'a job came back');
  assert.equal(r.job.status, 'working');
  assert.deepEqual(r.job.engine, { kind: 'cloud', label: 'MiniMax' });

  // While it works, the conversation history lists it as still running.
  const mid = (await h.app.inject({ method: 'GET', url: '/api/ask/history' })).json();
  assert.equal(mid.jobs.length, 1);
  assert.equal(mid.engine.label, 'MiniMax');

  const seen: string[][] = [];
  const done = await follow(h.app, r.job.id, j => seen.push(j.steps.map((s: any) => `${s.label}:${s.status}`)));
  // Steps arrived one by one, worded for the person, with the real names.
  assert.ok(seen.some(s => s.length === 1) && seen.some(s => s.length === 2), JSON.stringify(seen));
  const last = seen[seen.length - 1]!;
  assert.deepEqual(last, ['Making the room Theatre:ok', 'Combining Bedroom OLED and OLED TV:ok', 'Moving Lamp to Front door:ok']);
  assert.equal(done.reply.engine, 'cloud');
  assert.match(done.reply.source, /^MiniMax · sent/);
  assert.match(done.reply.text, /Theatre/);

  // It's in the conversation, with where it came from and its undo, for a phone that comes back later.
  const hist = (await h.app.inject({ method: 'GET', url: '/api/ask/history' })).json();
  assert.equal(hist.jobs.length, 0);
  const turns = hist.turns.filter((t: any) => t.job === r.job.id);
  assert.deepEqual(turns.map((t: any) => t.role), ['user', 'assistant']);
  assert.equal(turns[1].engine, 'cloud');
  assert.ok(turns[1].undo);
  assert.equal(turns[1].text, done.reply.text);
  await h.close(); await model.close();
});

test('Nobody following: the job still finishes and its answer lands in the conversation', async () => {
  const model = await fakeModel([calls(['update_device', { id: 'lamp', name: 'Reading lamp' }]), say('The lamp is now called Reading lamp.')], { delayMs: 60 });
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('call the lamp the reading lamp please', true);
  // The app was closed: nothing polls. The hub carries on.
  for (let i = 0; i < 50 && (await h.app.inject({ method: 'GET', url: '/api/ask/history' })).json().jobs.length; i++) await new Promise(ok => setTimeout(ok, 20));
  const hist = (await h.app.inject({ method: 'GET', url: '/api/ask/history' })).json();
  const reply = hist.turns.find((t: any) => t.job === r.job.id && t.role === 'assistant');
  assert.equal(reply.text, 'The lamp is now called Reading lamp.');
  assert.equal(h.hub.reg.get('lamp')!.name, 'Reading lamp');
  // A job the hub doesn't know (it restarted) says so, not "can't reach".
  const gone = await h.app.inject({ method: 'GET', url: '/api/ask/jobs/nope' });
  assert.equal(gone.statusCode, 404);
  assert.match(gone.json().error, /restarted/);
  await h.close(); await model.close();
});

test('A long poll comes back early with nothing new; asking again picks up where it left off', async () => {
  const model = await fakeModel([calls(['list_schedule', {}]), say('Nothing much tonight.')], { delayMs: 400 });
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('look over the plan and tell me if anything clashes', true);
  const t0 = Date.now();
  const a = (await h.app.inject({ method: 'GET', url: `/api/ask/jobs/${r.job.id}?rev=${r.job.rev}&wait=0.2` })).json();
  assert.ok(Date.now() - t0 >= 150 && a.status === 'working', 'waited, then came back still working');
  const done = await follow(h.app, r.job.id);
  assert.equal(done.reply.text, 'Nothing much tonight.');
  await h.close(); await model.close();
});

test('Built-in answers never make a job; the reply says it came from the built-in engine', async () => {
  const h = await askHome();
  const model = await fakeModel([say('never')]);
  await h.useModel(model.url);
  const r = await h.ask('lamp to 30%', true);
  assert.equal(r.job, undefined);
  assert.equal(r.engine, 'builtin');
  assert.equal(model.received.length, 0);
  // The snapshot names the engine for headers.
  const snap = (await h.app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.deepEqual({ kind: snap.assistant.kind, label: snap.assistant.label }, { kind: 'cloud', label: 'MiniMax' });
  await h.put({ engine: 'builtin' });
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/state' })).json().assistant.kind, 'builtin');
  await h.close(); await model.close();
});

test('The owner’s request, as it went wrong: the combined TV gains a member without separating, the room is created, the reply is true', async () => {
  // What the model did in the real request: combine [a part, the combined id], then the lamp to a room that
  // "seemed close". Now the first call works (the part and the combined id mean the same device), and the
  // room mismatch is caught.
  const model = await fakeModel([
    calls(['combine_devices', { members: ['bedroom_tv', 'combined_bedroom_oled', 'oled_dlna'], name: 'Bedroom OLED', room: 'music' }],
      ['update_device', { id: 'lamp', room: 'front' }]),
    say('All done:\n- Bedroom OLED is now in the Music room\n- The lamp is in the entryway'),
  ]);
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('all these oled are the same device, they are in the music room; the lamp is in the entryway');
  const c = h.hub.config.get().combined!;
  assert.equal(c.length, 1, 'still one combined device, not a second');
  assert.equal(c[0]!.id, 'bedroom_oled', 'it kept its id');
  assert.deepEqual([...c[0]!.members].sort(), ['bedroom_tv', 'oled_cast', 'oled_dlna']);
  assert.ok(h.hub.reg.get('oled_dlna')!.hidden, 'the new part is hidden');
  assert.equal(h.hub.reg.get('combined_bedroom_oled')!.room, 'music');
  // The model was told what happened, in words.
  const res = lastResults(model.received[1]!.body);
  assert.match(res[0].result, /Added OLED TV to Bedroom OLED — it now stands for/);
  assert.equal(res[1].roomName, 'Front door');
  // The reply said "entryway", but the lamp went to Front door: the hub's summary says so.
  assert.match(r.text, /Moved Lamp to Front door/);
  // Undo puts everything back.
  await h.app.inject({ method: 'POST', url: `/api/undo/${r.undo}` });
  assert.deepEqual([...h.hub.config.get().combined![0]!.members].sort(), ['bedroom_tv', 'oled_cast']);
  assert.ok(!h.hub.reg.get('oled_dlna')!.hidden);
  await h.close(); await model.close();
});

test('Separate, then combine again within one ask — even with the old combined id', async () => {
  const model = await fakeModel([
    calls(['separate_devices', { id: 'combined_bedroom_oled' }]),
    calls(['combine_devices', { members: ['combined_bedroom_oled', 'oled_dlna'], name: 'Bedroom TV' }]),
    calls(['update_device', { id: 'combined_bedroom_tv', room: 'master' }]),
    say('Bedroom TV is one device again, in the Master bedroom.'),
  ]);
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('redo the bedroom tv so all three entries are one device called bedroom tv in the master bedroom');
  const c = h.hub.config.get().combined!;
  assert.equal(c.length, 1);
  assert.deepEqual([...c[0]!.members].sort(), ['bedroom_tv', 'oled_cast', 'oled_dlna']);
  assert.equal(c[0]!.name, 'Bedroom TV');
  // The device made during the ask could be moved by its new id.
  assert.equal(h.hub.reg.get('combined_bedroom_tv')!.room, 'master');
  for (const m of ['bedroom_tv', 'oled_cast', 'oled_dlna']) assert.ok(h.hub.reg.get(m)!.hidden, `${m} hidden`);
  assert.equal(r.text, 'Bedroom TV is one device again, in the Master bedroom.', 'nothing to flag');
  await h.close(); await model.close();
});

test('A failed combine with an "All done" reply: the hub says what didn’t work', async () => {
  const model = await fakeModel([
    calls(['combine_devices', { members: ['lamp', 'office_cam'] }]),
    calls(['update_device', { id: 'office_strip', name: 'Desk glow' }]),
    say('All done! The lamp and the camera are one device and the strip is Desk glow.'),
  ]);
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('the lamp and the office camera are one thing, and call the strip desk glow');
  assert.doesNotMatch(r.text, /^All done/);
  assert.match(r.text, /^Not everything worked\./);
  assert.match(r.text, /Done:\n- Renamed LED strip “Desk glow”/);
  assert.match(r.text, /Couldn’t:\n- Combine Lamp and “office_cam”: Ask Kova can’t use that device/);
  assert.equal((h.hub.config.get().combined ?? []).length, 1, 'nothing combined');
  // The request log marks it as not clean.
  const log = (await h.app.inject({ method: 'GET', url: '/api/assistant/requests' })).json();
  assert.equal(log[0].ok, false);
  await h.close(); await model.close();
});

test('A corrected retry is allowed and its earlier failure isn’t reported; the same failing call twice is stopped', async () => {
  const model = await fakeModel([
    calls(['update_device', { id: 'lamp', room: 'entryway' }]),
    calls(['update_device', { id: 'lamp', room: 'entryway' }]),
    calls(['create_room', { name: 'Entryway' }]),
    calls(['update_device', { id: 'lamp', room: 'entryway' }]),
    say('Made an Entryway room and moved the lamp into it.'),
  ]);
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('the lamp lives in the entryway now');
  const res = lastResults(model.received[2]!.body);
  assert.match(res[0].error, /exact call already failed/);
  assert.equal(h.hub.reg.get('lamp')!.room, 'entryway');
  assert.equal(r.text, 'Made an Entryway room and moved the lamp into it.');
  await h.close(); await model.close();
});

test('Running out of rounds keeps what was done and says so', async () => {
  const model = await fakeModel((_b, round) => calls(['update_device', { id: 'lamp', name: `Lamp ${round}` }]));
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('keep renaming the lamp forever');
  assert.match(r.text, /^I didn’t get to the end of that\. Here’s where it stands:/);
  assert.match(r.text, /Done:\n- Renamed Lamp 12 “Lamp 13”/);
  assert.equal(h.hub.reg.get('lamp')!.name, 'Lamp 13');
  assert.ok(r.undo);
  await h.close(); await model.close();
});

test('An engine error mid-way still reports what was done', async () => {
  let n = 0;
  const model = await fakeModel(() => (n++ === 0 ? calls(['update_device', { id: 'lamp', hidden: true }]) : { nonsense: true }));
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('hide the lamp and then do something clever');
  assert.match(r.text, /^MiniMax at .* sent an empty reply\./);
  assert.match(r.text, /Done:\n- Hid Lamp/);
  assert.ok(r.undo);
  await h.close(); await model.close();
});

test('The home context: a combined device stands for its parts; hidden apart; archived gone', async () => {
  const model = await fakeModel([calls(['separate_devices', { id: 'oled_cast' }]), say('Separated.')]);
  const h = await askHome();
  await h.useModel(model.url);
  await h.ask('split the cast part off the bedroom tv');
  const sys = model.received[0]!.body.messages[0].content as string;
  const devLines = sys.split('\n').filter(l => l.startsWith('{"id"'));
  const tvLine = devLines.find(l => l.includes('"combined_bedroom_oled"'))!;
  assert.match(tvLine, /"combined":true/);
  assert.match(tvLine, /"parts":\[\{"id":"bedroom_tv","name":"Bedroom OLED","integration":"Samsung TV"\},\{"id":"oled_cast"/);
  // No part is listed as a device of its own.
  assert.ok(!devLines.some(l => l.startsWith('{"id":"bedroom_tv"') || l.startsWith('{"id":"oled_cast"')));
  // Hidden: apart, by name. Archived: nowhere.
  const hiddenAt = sys.indexOf('Hidden devices');
  assert.ok(hiddenAt > 0 && sys.indexOf('"old_lamp"') > hiddenAt);
  assert.ok(!sys.includes('gone_plug'));
  // A part's id still works: separating by it found its combined device.
  assert.equal((h.hub.config.get().combined ?? []).length, 0);
  assert.ok(!h.hub.reg.get('oled_cast')!.hidden);
  await h.close(); await model.close();
});

test('Names private: devices made during the ask get neutral ids the model can use', async () => {
  const model = await fakeModel([
    calls(['combine_devices', { members: ['device1', 'device2'], name: 'Telly' }]),
    say('ok'),
  ]);
  const h = await askHome();
  await h.put({ engine: 'cloud', cloud: { provider: 'minimax', apiKey: 'k', baseUrl: model.url }, share: { names: false } });
  await h.ask('these two are the same');
  const res = lastResults(model.received[1]!.body)[0];
  assert.equal(res.ok, true);
  assert.match(res.id, /^device\d+$/, 'no real id (which spells names) leaked');
  await h.close(); await model.close();
});

test('Zones: the AC’s zones are named, then one zone is switched; the reply uses the zone names', async () => {
  const model = await fakeModel([
    calls(['update_device', { id: 'ducted_ac', zoneNames: { 1: 'Living', 2: 'Theatre', 3: 'Master' } }]),
    calls(['set_devices', { devices: [{ id: 'ducted_ac', set: { zoneSet: { 2: { on: true, open: 100 } } } }] }]),
    calls(['update_device', { id: 'ducted_ac', zoneNames: { 9: 'Garage' } }]),
    say('Zones named; the Theatre zone is open. There is no zone 9.'),
  ]);
  const h = await askHome();
  await h.useModel(model.url);
  const r = await h.ask('zone 1 is living, 2 theatre, 3 master. turn on just the theatre zone. 9 is the garage');
  assert.deepEqual(h.hub.config.get().devices!.ducted_ac!.zoneNames, { 1: 'Living', 2: 'Theatre', 3: 'Master', 4: 'Baby', 5: 'Office & Guest', 6: 'Music' }, 'named zones are kept; only those given change');
  const zoneRes = lastResults(model.received[2]!.body)[0];
  assert.equal(zoneRes.ok, true);
  assert.match(zoneRes.result, /AC/);
  // The bad zone failed, and the reply was honest about it, so the guard adds its summary.
  assert.match(r.text, /Couldn’t:\n- Name AC’s zones: AC has no zone 9/);
  await h.close(); await model.close();
});

test('honestReply: clean replies pass; "Done" with nothing done is corrected', () => {
  assert.deepEqual(honestReply('Lamp is at 30%.', { done: ['Lamp to 30%'], couldnt: [] }, { changed: true }), { text: 'Lamp is at 30%.', flagged: false });
  assert.equal(honestReply('Done.', { done: [], couldnt: [] }, { changed: false }).text, 'I didn’t change anything.');
  assert.equal(honestReply('Done — I’ll remember that.', { done: [], couldnt: [] }, { changed: false }).text, 'I didn’t change anything. I’ll remember that.');
  const r = honestReply('Everything is done. The lamp is in Theatre.', { done: [], couldnt: ['Move Lamp to Theatre: Unknown room theatre.'] }, { changed: false });
  assert.equal(r.text, 'That didn’t work.\n\nCouldn’t:\n- Move Lamp to Theatre: Unknown room theatre.', 'its claim that the lamp moved is dropped');
});

test('Built-in answers: a combined device stands for its parts, hidden ones stay out of lists', async () => {
  const h = await askHome();
  await h.hub.engine.command('old_lamp', { on: true });
  await h.hub.engine.command('lounge_main', { on: true });
  const r = await h.ask('what lights are on?');
  assert.match(r.text, /Lounge ceiling/);
  assert.doesNotMatch(r.text, /old lamp/i, 'a hidden light isn’t listed');
  // "Turn on the bedroom oled": the combined device, not it and its part as well.
  const t = await h.ask('turn on the bedroom oled');
  assert.match(t.text, /1 thing on/);
  // A hidden device is still reached by its exact name.
  const o = await h.ask('turn off the old lamp');
  assert.match(o.text, /Old lamp: 1 thing off/);
  await h.close();
});
