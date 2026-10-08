import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Hub } from '../src/hub.ts';
import { Store } from '../src/store/db.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { buildServer } from '../src/api/server.ts';
import {
  DRIFT_CORRECT_MS, DRIFT_SEEK_MS, LatencyBook, SEEK_GAP_MS, SYNC_TEST_MEDIA, cleanOffset, driftAction, driftOf, mergeOffsets, partition, planParts, pruneOffsets, schedule,
  type PlanPart,
} from '../src/engine/group-sync.ts';
import { syncTestWav } from '../src/services/clips.ts';
import type { NativeGroup } from '../src/adapters/sdk.ts';
import type { Device, HomeConfig } from '../src/model/types.ts';
import { FakeSpeakers } from './fake-speakers.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cast = (id: string, members: string[], name = id): NativeGroup => ({ via: 'cast', id, name, members });

// ------------------------------------------------------------- partitioning --

test('partition: a native group that is exactly some of the speakers plays as one; the rest alongside', () => {
  const parts = partition(['k', 'd', 'b', 'ray'], [cast('home', ['k', 'd', 'b'], 'Home speakers')]);
  assert.deepEqual(parts.map(p => [p.native?.id ?? null, p.ids]), [['home', ['k', 'd', 'b']], [null, ['ray']]]);
  // A Cast group with a speaker that isn't in the Kova group can't be used (it'd play there too).
  assert.deepEqual(partition(['k', 'd'], [cast('home', ['k', 'd', 'x'])]).map(p => p.ids), [['k'], ['d']]);
});

test('partition: the fewest streams, from overlapping Cast groups; ties go to more speakers in native groups', () => {
  const gs = [cast('abc', ['a', 'b', 'c']), cast('cd', ['c', 'd']), cast('de', ['d', 'e']), cast('ab', ['a', 'b'])];
  const parts = partition(['a', 'b', 'c', 'd', 'e'], gs);
  assert.equal(parts.length, 2, 'abc + de: two streams (not abc + d + e, or ab + cd + e)');
  assert.deepEqual(parts.map(p => p.native?.id).sort(), ['abc', 'de']);
  // Same stream count either way (ab+c or a+bc): the bigger group wins the tie.
  const tie = partition(['a', 'b', 'c'], [cast('ab', ['a', 'b']), cast('abc', ['a', 'b', 'c'])]);
  assert.deepEqual(tie.map(p => p.native?.id), ['abc']);
});

test('partition: Sonos groups any two or more of its speakers; one Sonos speaker plays on its own', () => {
  const sonos: NativeGroup = { via: 'sonos', id: 'group', name: 'Sonos', members: ['s1', 's2', 's3'], dynamic: true };
  assert.deepEqual(partition(['k', 's1', 's3', 'd'], [sonos, cast('kd', ['k', 'd'])]).map(p => [p.native?.via ?? null, p.ids]), [['sonos', ['s1', 's3']], ['cast', ['k', 'd']]]);
  assert.deepEqual(partition(['k', 's2'], [sonos]).map(p => p.ids), [['k'], ['s2']]);
});

test('planParts: keys, the reference (biggest part), and a combined soundbar playing through its Cast member', () => {
  const dev = (id: string, adapter: string, caps: string[] = ['media']): Device => ({ id, name: id.toUpperCase(), room: 'x', type: 'media', adapter, integration: '', address: '', capabilities: caps as Device['capabilities'], state: {} });
  const all = new Map([dev('k', 'cast'), dev('bar_cast', 'cast'), dev('bar_st', 'smartthings', ['onoff']), dev('combined_bar', 'combined'), dev('ray', 'sonos')].map(d => [d.id, d]));
  const parts = planParts(['ray', 'k', 'combined_bar'], id => all.get(id), [cast('home', ['k', 'bar_cast'], 'Home speakers')], [{ id: 'bar', name: 'Bar', members: ['bar_st', 'bar_cast'] }]);
  assert.deepEqual(parts.map(p => ({ key: p.key, ref: p.reference, members: p.members, players: p.players })), [
    { key: 'cast:home', ref: true, members: ['k', 'combined_bar'], players: ['k', 'bar_cast'] },
    { key: 'ray', ref: false, members: ['ray'], players: ['ray'] },
  ]);
  assert.equal(parts[1]!.via, 'sonos');
});

// ---------------------------------------------------------------- scheduling --

test('schedule: a queue starts everywhere at one moment: each part asked earlier by its start delay, moved by its offset', () => {
  const sch = schedule([{ key: 'cast:home', latencyMs: 1200 }, { key: 'ray', latencyMs: 300 }], { ray: 100 }, 10_000, false, 150);
  assert.equal(sch.startAt, 10_000 + 1200 + 150);
  assert.equal(sch.sends['cast:home'], 10_000 + 150, 'the slowest is asked first');
  assert.equal(sch.sends.ray, sch.startAt - 100 - 300, 'Ray: +100 ms (earlier) and its own 300 ms delay');
  // A part whose delay isn't learned yet counts as the others' middle one.
  const guess = schedule([{ key: 'a', latencyMs: 800 }, { key: 'b' }], {}, 0, false, 0);
  assert.equal(guess.sends.a, guess.sends.b);
  // Later (−): asked later; never before now.
  const late = schedule([{ key: 'a', latencyMs: 0 }, { key: 'b', latencyMs: 0 }], { b: -250 }, 0, false, 0);
  assert.equal(late.sends.b! - late.sends.a!, 250);
  assert.ok(Object.values(late.sends).every(t => t >= 0));
});

test('schedule: a live stream gets the offsets only (start delays mean nothing there)', () => {
  const sch = schedule([{ key: 'cast:home', latencyMs: 1200 }, { key: 'ray', latencyMs: 300 }, { key: 'x' }], { ray: 200, x: -100 }, 5000, true);
  assert.deepEqual(sch.sends, { 'cast:home': 5200, ray: 5000, x: 5300 });
});

// ------------------------------------------------------------ learned delays --

test('learned start delay: the median of the last 12, kept in the store; nonsense ignored', () => {
  const store = new Store(':memory:');
  const book = new LatencyBook(store);
  assert.equal(book.get('ray'), undefined);
  for (const ms of [400, 420, 5000, 380]) book.record('ray', ms);
  assert.equal(book.get('ray'), 410, 'one slow cold start doesn’t move the median far');
  assert.equal(book.record('ray', -5), false);
  assert.equal(book.record('ray', 60_000), false);
  for (let i = 0; i < 20; i++) book.record('ray', 900);
  assert.equal(book.count('ray'), 12);
  assert.equal(book.get('ray'), 900);
  assert.equal(new LatencyBook(store).get('ray'), 900, 'kept across restarts');
});

// ------------------------------------------------------------------ drift --

test('drift: a part against the reference, after its offset, across a song change; the decision thresholds', () => {
  const ref = { index: 3, positionMs: 10_000, at: 1000, playing: true, durationMs: 200_000 };
  assert.equal(driftOf(ref, { index: 3, positionMs: 10_150, at: 1000, playing: true }), 150);
  assert.equal(driftOf(ref, { index: 3, positionMs: 10_150, at: 1000, playing: true }, 100), 50, 'its offset is where it should be');
  assert.equal(driftOf(ref, { index: 3, positionMs: 10_100, at: 1100, playing: true }), 0, 'readings at different times');
  assert.equal(driftOf({ ...ref, positionMs: 199_900 }, { index: 4, positionMs: 200, at: 1000, playing: true }), 300, 'ahead into the next song');
  assert.equal(driftOf(ref, { index: 5, positionMs: 0, at: 1000, playing: true }), null, 'too far apart to tell');

  assert.equal(driftAction({ live: false, driftMs: DRIFT_CORRECT_MS }), 'none');
  assert.equal(driftAction({ live: false, driftMs: -(DRIFT_CORRECT_MS + 1) }), 'boundary');
  assert.equal(driftAction({ live: false, driftMs: DRIFT_SEEK_MS }), 'boundary');
  assert.equal(driftAction({ live: false, driftMs: DRIFT_SEEK_MS + 1 }), 'seek');
  assert.equal(driftAction({ live: false, driftMs: 900, sinceSeekMs: SEEK_GAP_MS - 1 }), 'boundary', 'not chased again straight after a move');
  assert.equal(driftAction({ live: true, driftMs: 2000 }), 'none', 'never on radio');
  assert.equal(driftAction({ live: false, driftMs: null }), 'none');
});

// -------------------------------------------------------------- validation --

test('offsets: 5 ms steps within ±1000, only for parts played alongside; pruned with the members', () => {
  assert.equal(cleanOffset(123), 125);
  assert.equal(cleanOffset(477), 475);
  assert.equal(cleanOffset('-48'), -50);
  assert.equal(cleanOffset(-1000), -1000);
  assert.throws(() => cleanOffset(1001), /at most 1000 ms/);
  assert.throws(() => cleanOffset('soon'), /number of milliseconds/);
  assert.throws(() => cleanOffset(NaN), /number/);
  const parts = [{ key: 'cast:home', reference: true, name: 'Home speakers' }, { key: 'ray', reference: false, name: 'Ray' }] as PlanPart[];
  assert.deepEqual(mergeOffsets({ old: 30 }, { ray: 502 }, parts), { old: 30, ray: 500 });
  assert.deepEqual(mergeOffsets({ ray: 500 }, { ray: 0 }, parts), {}, '0 clears it');
  assert.throws(() => mergeOffsets({}, { 'cast:home': 100 }, parts), /what the other speakers follow/);
  assert.throws(() => mergeOffsets({}, { nobody: 100 }, parts), /isn’t a part/);
  assert.throws(() => mergeOffsets({}, [100], parts), /Send the delays/);
  assert.deepEqual(pruneOffsets({ ray: 500, gone: 20, 'cast:home': 10 }, ['ray']), { ray: 500, 'cast:home': 10 });
});

test('the sync test’s click track: a tick every second, a tone on the minute, as a WAV', () => {
  const w = syncTestWav(61, 8000);
  assert.equal(w.toString('latin1', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(40), 61 * 8000 * 2);
  const loud = (s: number, fromMs: number, toMs: number) => {
    let m = 0;
    for (let i = Math.round((s + fromMs / 1000) * 8000); i < Math.round((s + toMs / 1000) * 8000); i++) m = Math.max(m, Math.abs(w.readInt16LE(44 + i * 2)));
    return m;
  };
  assert.ok(loud(5, 0, 5) > 10_000, 'a sharp tick at each second');
  assert.ok(loud(5, 30, 900) < 50, 'silence between ticks');
  assert.ok(loud(60, 60, 200) > 10_000, 'the minute’s tone lasts');
  assert.ok(loud(59, 60, 200) < 50, 'other seconds don’t');
});

// ------------------------------------------------------- with fake speakers --

/** A hub with Cast-like speakers (three in a native group, one outside it) and a Sonos-like one; drift checks fast. */
async function home(o: { castLatency?: Record<string, number>; sonosLatency?: Record<string, number>; seekStepMs?: number; checkMs?: number; castGap?: (i: number) => number; hold?: boolean } = {}) {
  const fc = new FakeSpeakers('cast', 'Google Cast', [
    { id: 'kitchen', name: 'Kitchen speaker', room: 'kitchen' }, { id: 'dining', name: 'Dining speaker', room: 'kitchen' },
    { id: 'bed', name: 'Bedroom speaker', room: 'master' }, { id: 'office', name: 'Office speaker', room: 'office' },
  ], { groups: [{ id: 'home', name: 'Home speakers', members: ['kitchen', 'dining', 'bed'] }], latency: o.castLatency ?? {}, seekLatency: 30, ...(o.castGap ? { gapMs: { home: o.castGap } } : {}) });
  const fs = new FakeSpeakers('sonos', 'Sonos', [{ id: 'ray', name: 'Ray', room: 'lounge' }], { dynamic: true, latency: o.sonosLatency ?? {}, seekLatency: 30, seekStepMs: o.seekStepMs ?? 1, canHold: o.hold });
  const hub = new Hub({
    dbPath: ':memory:', tickMs: 0,
    initialConfig: () => { const c: HomeConfig = demoConfig(); c.speakerGroups = [{ id: 'whole', name: 'Whole home', members: ['kitchen', 'dining', 'bed', 'ray'] }]; return c; },
    adapters: [new VirtualAdapter(demoDevices()), fc, fs],
    groupSync: { checkMs: o.checkMs ?? 100, marginMs: 50, testMs: 4000, measureMs: 3000, nearEndMs: 400, pollMs: 100, farPollMs: 200 },
  });
  hub.lanBase = () => 'http://10.0.0.2:8140';
  await hub.start();
  // Helix-like music: songs of 1.5 s, so a song change comes quickly.
  hub.reg.queues = async media => media === 'Loved' ? { label: 'Loved', shuffle: false, tracks: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: `Song ${i}`, url: `http://helix/${i}`, contentType: 'audio/flac', durationMs: 1500 })) } : null;
  const config = hub.config.get();
  hub.config.update(c => { c.sources = [...config.sources.filter(s => s.name !== 'Live radio'), { name: 'Live radio', icon: 'radio', url: 'http://radio.example/live.mp3' }]; });
  return { hub, fc, fs, close: () => hub.stop() };
}

test('hybrid playback: the Cast group plays as one stream; Ray joins once it plays, lined up with it, however slow it was', async () => {
  const h = await home({ castLatency: { home: 300 }, sonosLatency: { ray: 80 } });
  try {
    const plan = h.hub.groupSync.plan(h.hub.config.get().speakerGroups![0]!);
    assert.deepEqual(plan.map(p => p.key), ['cast:home', 'ray']);
    const st = (await (await buildServer(h.hub, { webRoot })).inject({ method: 'GET', url: '/api/state' })).json();
    const sg = st.speakerGroups[0];
    assert.equal(sg.sync, 'hybrid');
    assert.equal(sg.castGroup, 'Home speakers');
    assert.deepEqual(sg.parts.map((p: { key: string; reference: boolean }) => [p.key, p.reference]), [['cast:home', true], ['ray', false]]);
    assert.ok(st.nativeGroups.some((g: NativeGroup) => g.id === 'home'));
    h.hub.groupSync.book.record('seek:ray', 30);

    const from = h.fc.asked.length, fromR = h.fs.asked.length;
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    assert.equal(h.hub.reg.get('ray')!.state.media, 'Loved');
    const book = h.hub.groupSync.book;
    assert.ok(Math.abs(book.get('cast:home')! - 300) < 80, `Cast group's delay learned: ${book.get('cast:home')}`);
    // Ray isn't asked until the Cast group plays, so it can't start before it.
    const castAt = h.fc.asked[from]!.at, rayAt = h.fs.asked[fromR]!.at;
    assert.ok(rayAt - castAt >= 300, `Ray asked ${rayAt - castAt} ms after the Cast group`);
    let t = Date.now() + 100, c = h.fc.where('kitchen', t)!, r = h.fs.where('ray', t)!;
    assert.equal(c.index, r.index);
    assert.ok(Math.abs(r.positionMs - c.positionMs) < 60, `Ray ${r.positionMs - c.positionMs} ms from the Cast group`);
    assert.match(h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n'), /Home speakers first, then Ray once it plays/);

    // A song the Cast group is much slower to start (it fetches and buffers each one) than it learned, with Ray 100 ms
    // earlier: Ray still waits for it, and plays 100 ms ahead, as tuned.
    await h.hub.reg.command('group_whole', { on: false, media: null }, { kind: 'user', label: 'You' });
    h.hub.config.update(c => { c.groupOffsets = { whole: { ray: 100 } }; });
    (h.fc as unknown as { o: { latency: Record<string, number> } }).o.latency.home = 1200;
    const fromC2 = h.fc.asked.length, fromR2 = h.fs.asked.length;
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    assert.ok(h.fs.asked[fromR2]!.at - h.fc.asked[fromC2]!.at >= 1200, 'Ray waited for the slow start');
    t = Date.now() + 100; c = h.fc.where('kitchen', t)!; r = h.fs.where('ray', t)!;
    assert.equal(c.index, r.index);
    assert.ok(Math.abs(r.positionMs - c.positionMs - 100) < 60, `Ray ${r.positionMs - c.positionMs} ms ahead`);
    assert.match(h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n'), /Home speakers started 1\.\d\d s after it was asked/);
  } finally { await h.close(); }
});

test('a part asked to play later (−) is asked that much after the main part starts', async () => {
  const h = await home({ castLatency: { home: 200 } });
  try {
    h.hub.groupSync.book.record('seek:ray', 30);
    h.hub.config.update(c => { c.groupOffsets = { whole: { ray: -300 } }; });
    const from = h.fc.asked.length, fromR = h.fs.asked.length;
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    assert.ok(h.fs.asked[fromR]!.at - h.fc.asked[from]!.at >= 480, 'after the start, and 300 ms more');
    await sleep(100);
    const t = Date.now(), c = h.fc.where('kitchen', t)!, r = h.fs.where('ray', t)!;
    const gap = (r.index * 1500 + r.positionMs) - (c.index * 1500 + c.positionMs);
    assert.ok(Math.abs(gap + 300) < 70, `and 300 ms behind it: ${gap}\n${h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n')}`);
  } finally { await h.close(); }
});

test('song changes: the Cast group’s gap between songs (different every song) never builds up: Ray waits for it, then joins', async () => {
  // Gaps of 250, 600, 400… ms between songs; Ray (Sonos) goes straight on by itself, and can wait.
  const gaps = [250, 600, 400, 700, 300];
  const h = await home({ castGap: i => gaps[i % gaps.length]!, hold: true, checkMs: 200 });
  try {
    h.hub.groupSync.book.record('seek:ray', 30);
    h.hub.config.update(c => { c.groupOffsets = { whole: { ray: 40 } }; });
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    // Through four song changes: every 100 ms, where both play the same song (past its first 0.6 s, when a joining
    // speaker may still be settling), Ray is where the Cast group is, plus its 40 ms.
    const seen: number[] = [];
    for (let k = 0; k < 75; k++) {
      await sleep(100);
      const c = h.fc.where('kitchen')!, r = h.fs.where('ray')!;
      if (c.playing && r.playing && c.index === r.index && c.positionMs > 600) seen.push(Math.round(r.positionMs - c.positionMs));
    }
    assert.ok(seen.length >= 15, `looked ${seen.length} times`);
    const off = seen.filter(g => Math.abs(g - 40) >= 60);
    assert.ok(off.length <= seen.length / 10, `Ray out of time ${off.length} of ${seen.length} looks: ${off.join(', ')}\n${h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n')}`);
    assert.ok(h.fs.holds.length >= 2, `Ray waited at song ends: ${h.fs.holds.length}`);
    assert.match(h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n'), /Next song: Ray waited [\d.]+ s for Home speakers, then joined/);
  } finally { await h.close(); }
});

test('drift: a small slip is lined up at the next song (on the shared time); a big one is moved at once, and said', async () => {
  const h = await home();
  try {
    h.hub.groupSync.book.record('seek:ray', 30);
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await sleep(200);
    const n0 = h.fs.seeks.length;
    h.fs.drift('ray', 200);
    // Within the next song change (1.5 s songs): no move mid-song, then lined up with the next song once it plays.
    await sleep(1800);
    const log = () => h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n');
    assert.match(log(), /Next song: Ray lined up with Home speakers \(it was (1|2)\d\d ms ahead\)/);
    assert.ok(h.fs.seeks.length > n0, 'lined up');
    assert.ok(h.fs.seeks[n0]!.index >= 1, 'in the next song');
    assert.ok(h.fs.seeks[n0]!.positionMs < 500, 'near its start');
    let t = Date.now();
    assert.ok(Math.abs(h.fs.where('ray', t)!.positionMs - h.fc.where('kitchen', t)!.positionMs) < 60, 'back in time');
    // A big slip: moved now, mid-song, and the log says so.
    const n = h.fs.seeks.length;
    h.fs.drift('ray', -650);
    await sleep(350);
    assert.equal(h.fs.seeks.length, n + 1);
    assert.match(log(), /Ray is 6\d\d ms behind: more than 400 ms, so moved now, mid-song/);
    t = Date.now() + 50;
    assert.ok(Math.abs(h.fs.where('ray', t)!.positionMs - h.fc.where('kitchen', t)!.positionMs) < 60);
  } finally { await h.close(); }
});

test('another app casts to one of the Cast group’s speakers: the group’s music is over, so Ray stops too', async () => {
  const h = await home();
  try {
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await sleep(300);
    assert.equal(h.hub.reg.get('ray')!.state.media, 'Loved');
    // A phone app casts something else to the kitchen speaker: the Cast group ends; Ray carries on alone for now.
    h.fc.takeOver(['kitchen'], 'Something else');
    assert.equal(h.hub.reg.get('ray')!.state.on, true);
    await sleep(400);
    assert.equal(h.hub.reg.get('ray')!.state.on, false, 'Ray stopped');
    assert.equal(h.hub.reg.get('kitchen')!.state.media, 'Something else', 'what the other app plays is left alone');
    assert.equal(h.hub.groupSync.session('whole'), undefined);
    assert.match(h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n'), /Home speakers stopped playing Loved .*: stopped Ray too/);
  } finally { await h.close(); }
});

test('a speaker of the Cast group drops off: the music carries on without it, on the rest, from where it had got to', async () => {
  const h = await home();
  try {
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await sleep(1900);
    const was = h.fs.where('ray')!.index;
    assert.ok(was >= 1, 'into the second song');
    h.fc.unplug('bed');
    await sleep(700);
    const log = h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n');
    assert.match(log, /Bedroom speaker turned off, which ended Home speakers: carrying on without it, from song \d/);
    for (const id of ['kitchen', 'dining', 'ray']) assert.equal(h.hub.reg.get(id)!.state.media, 'Loved', id);
    assert.ok(h.hub.groupSync.session('whole'), 'kept in time again');
    const t = Date.now(), k = h.fc.where('kitchen', t)!, r = h.fs.where('ray', t)!;
    assert.ok(k.index >= was && r.index >= was, `carried on from song ${was + 1}: kitchen ${k.index + 1}, Ray ${r.index + 1}`);
    assert.equal(h.fc.where('bed', t), null);
  } finally { await h.close(); }
});

test('a soundbar in the Cast group is switched off (its own power, beside its Cast speaker): the rest carry on', async () => {
  const h = await home();
  try {
    // The bedroom speaker stands in for a soundbar's Cast speaker, the living-room display for its own power.
    h.hub.config.update(c => { c.combined = [{ id: 'bar', name: 'Soundbar', members: ['living_display', 'bed'] }]; });
    await h.hub.reg.command('living_display', { on: true }, { kind: 'user', label: 'You' });
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await sleep(500);
    await h.hub.reg.command('living_display', { on: false }, { kind: 'user', label: 'You' });
    h.fc.takeOver(['bed']);
    await sleep(700);
    assert.match(h.hub.groupSync.view('whole')!.log.map(l => l.text).join('\n'), /Bedroom speaker turned off, which ended Home speakers: carrying on without it/);
    for (const id of ['kitchen', 'dining', 'ray']) assert.equal(h.hub.reg.get(id)!.state.media, 'Loved', id);
  } finally { await h.close(); }
});

test('the group’s music carries on while it plays, and paused isn’t stopped', async () => {
  const h = await home();
  try {
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await h.hub.reg.command('group_whole', { paused: true }, { kind: 'user', label: 'You' });
    await sleep(600);
    assert.equal(h.hub.reg.get('ray')!.state.on, true);
    assert.ok(h.hub.groupSync.session('whole'));
  } finally { await h.close(); }
});

test('drift: a speaker that seeks in whole seconds (Sonos) is asked at the moment its second lands right', async () => {
  const h = await home({ seekStepMs: 1000 });
  try {
    h.hub.groupSync.book.record('seek:ray', 30);
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved' }, { kind: 'user', label: 'You' });
    await sleep(150);
    const n0 = h.fs.seeks.length;
    h.fs.drift('ray', -700);
    // The move: asked at the moment its whole second lands right; looked at just after it lands.
    for (let k = 0; k < 40 && !h.fs.seeks.slice(n0).some(x => x.positionMs > 0); k++) await sleep(50);
    const s = h.fs.seeks.slice(n0).find(x => x.positionMs > 0);
    assert.ok(s, 'moved');
    assert.equal(s.positionMs % 1000, 0, 'whole seconds');
    await sleep(60);
    const t = Date.now();
    const w = h.fs.where('ray', t)!, c = h.fc.where('kitchen', t)!;
    assert.ok(Math.abs((w.index * 1500 + w.positionMs) - (c.index * 1500 + c.positionMs)) < 70, 'and it lands in time');
  } finally { await h.close(); }
});

test('radio: offsets only, never corrected', async () => {
  const h = await home({ castLatency: { home: 300 } });
  try {
    h.hub.groupSync.book.record('cast:home', 300);
    h.hub.config.update(c => { c.groupOffsets = { whole: { ray: -200 } }; });
    const from = h.fc.asked.length;
    await h.hub.reg.command('group_whole', { on: true, media: 'Live radio' }, { kind: 'user', label: 'You' });
    const gap = h.fs.asked.at(-1)!.at - h.fc.asked[from]!.at;
    assert.ok(gap >= 180 && gap < 260, `Ray asked 200 ms later, its start delay not used: ${gap}`);
    h.fs.drift('ray', 900);
    await sleep(400);
    assert.equal(h.fs.seeks.length + h.fc.seeks.length, 0);
    assert.equal(h.hub.groupSync.view('whole')!.playing!.live, true);
  } finally { await h.close(); }
});

test('the sync test: low on every speaker, through the group’s timing, then each put back as it was', async () => {
  const h = await home();
  const app = await buildServer(h.hub, { webRoot });
  try {
    const you = { kind: 'user' as const, label: 'You' };
    await h.hub.reg.command('ray', { on: true, media: 'Live radio', vol: 35 }, you);
    await h.hub.reg.command('kitchen', { vol: 50 }, you);
    const r = await app.inject({ method: 'POST', url: '/api/speaker-groups/whole/sync-test', payload: {} });
    assert.equal(r.statusCode, 200, r.body);
    for (const id of ['kitchen', 'dining', 'bed', 'ray']) {
      assert.equal(h.hub.reg.get(id)!.state.media, SYNC_TEST_MEDIA, id);
      assert.equal(h.hub.reg.get(id)!.state.vol, 15, `${id} at the safe level`);
    }
    // The click track comes from the hub, as a one-song queue.
    const q = await h.hub.reg.ownQueues.get(SYNC_TEST_MEDIA)!({});
    assert.match(q!.tracks[0]!.url, /^http:\/\/[\d.]+:\d+\/api\/clip\/sync-test\.wav$/);
    const wav = await app.inject({ method: 'GET', url: '/api/clip/sync-test.wav', headers: { range: 'bytes=0-43' } });
    assert.equal(wav.statusCode, 206);
    assert.equal(wav.rawPayload.toString('latin1', 8, 12), 'WAVE');
    // Tuning while it plays is heard at once.
    const put = await app.inject({ method: 'PUT', url: '/api/speaker-groups/whole/offsets', payload: { offsets: { ray: 250 } } });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().offsets, { ray: 250 });
    assert.ok(put.json().undo);
    await sleep(500);
    assert.ok(h.fs.seeks.length >= 1, 'Ray moved to its new offset');
    assert.equal((await app.inject({ method: 'GET', url: '/api/state' })).json().speakerGroups[0].testUntil > Date.now(), true);
    // Stop: everything back.
    const stop = await app.inject({ method: 'DELETE', url: '/api/speaker-groups/whole/sync-test' });
    assert.equal(stop.statusCode, 200);
    assert.equal(h.hub.reg.get('ray')!.state.media, 'Live radio');
    assert.equal(h.hub.reg.get('ray')!.state.vol, 35);
    assert.equal(h.hub.reg.get('kitchen')!.state.vol, 50);
    assert.equal(h.hub.reg.get('kitchen')!.state.on, false);
    assert.equal(h.hub.groupSync.testing('whole'), false);
    // It also ends by itself after its length.
    await app.inject({ method: 'POST', url: '/api/speaker-groups/whole/sync-test', payload: {} });
    await sleep(4000 + 3300);
    assert.equal(h.hub.groupSync.testing('whole'), false);
    assert.equal(h.hub.reg.get('ray')!.state.media, 'Live radio');
  } finally { await app.close(); await h.close(); }
});

test('API: offsets are checked, saved per group and member, undoable, and pruned when a member leaves', async () => {
  const h = await home();
  const app = await buildServer(h.hub, { webRoot });
  try {
    const put = (offsets: unknown) => app.inject({ method: 'PUT', url: '/api/speaker-groups/whole/offsets', payload: { offsets } });
    assert.match((await put({ ray: 5000 })).json().error, /at most 1000 ms/);
    assert.match((await put({ 'cast:home': 50 })).json().error, /follow/);
    assert.match((await put({ lamp: 50 })).json().error, /isn’t a part/);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/speaker-groups/nope/offsets', payload: { offsets: {} } })).statusCode, 404);
    const ok = await put({ ray: -333 });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(h.hub.config.get().groupOffsets, { whole: { ray: -335 } });
    await app.inject({ method: 'POST', url: `/api/undo/${ok.json().undo}` });
    assert.equal(h.hub.config.get().groupOffsets?.whole, undefined);
    await put({ ray: 200 });
    const v = (await app.inject({ method: 'GET', url: '/api/speaker-groups/whole/sync' })).json();
    assert.deepEqual(v.parts.map((p: { key: string; offset: number }) => [p.key, p.offset]), [['cast:home', 0], ['ray', 200]]);
    // Ray leaves the group: its timing goes too.
    await app.inject({ method: 'PUT', url: '/api/speaker-groups/whole', payload: { members: ['kitchen', 'dining', 'bed', 'office'] } });
    assert.equal(h.hub.config.get().groupOffsets?.whole, undefined);
    const st = (await app.inject({ method: 'GET', url: '/api/state' })).json().speakerGroups[0];
    assert.deepEqual(st.parts.map((p: { key: string }) => p.key), ['cast:home', 'office']);
  } finally { await app.close(); await h.close(); }
});

test('Ask Kova: “Ray is about half a second behind” → +500 ms, said back first; “a bit early”; “sync the speakers” explains', async () => {
  const h = await home();
  try {
    const a = h.hub.assistant;
    let r = await a.ask('Ray is about half a second behind');
    assert.match(r.text, /Whole home plays Home speakers as one Cast group, in perfect sync, and Ray alongside/);
    assert.match(r.text, /from 0 ms to \+500 ms\. Shall I\?/);
    const set = r.actions.find(x => x.action.type === 'groupOffset')!;
    assert.deepEqual(set.action, { type: 'groupOffset', group: 'whole', part: 'ray', ms: 500, done: 'Ray now plays at +500 ms in Whole home. Run the sync test to check it.' });
    assert.equal(h.hub.config.get().groupOffsets?.whole, undefined, 'nothing changes until confirmed');
    const done = await a.act(set.action);
    assert.deepEqual(h.hub.config.get().groupOffsets?.whole, { ray: 500 });
    assert.ok(done.undo);
    r = await a.ask('Ray is a bit early');
    assert.match(r.text, /later by 50 ms, its timing goes from \+500 ms to \+450 ms/);
    r = await a.ask('Ray is 200 ms late');
    assert.equal((r.actions[0]!.action as { ms: number }).ms, 700);
    r = await a.ask('Ray is 0.8 seconds behind');
    assert.match(r.text, /\+1000 ms\. That’s as far as it goes/);
    // A speaker of the Cast group: the others follow it, so Ray moves the other way.
    r = await a.ask('the kitchen speaker is late');
    assert.match(r.text, /Ray later by 50 ms/);
    r = await a.ask('sync the speakers');
    assert.match(r.text, /Stand between Kitchen speaker and Ray/);
    assert.equal(r.actions[0]!.action.type, 'tune');
    // Not about timing: left alone.
    assert.notEqual(a.parse('turn off the speakers')?.kind, 'groupSync');
    assert.notEqual(a.parse('play Loved in the kitchen')?.kind, 'groupSync');
  } finally { await h.close(); }
});

test('volume: the group’s volume keeps the balance between speakers; the balance is set from the speakers’ own levels', async () => {
  const { balancedVols } = await import('../src/adapters/groups.ts');
  assert.deepEqual(balancedVols(60, [{ id: 'ray', vol: 40 }, { id: 'k', vol: 20 }]), { ray: 60, k: 30 }, 'no balance: their levels now');
  assert.deepEqual(balancedVols(60, [{ id: 'ray', vol: 10 }, { id: 'k', vol: 10 }], { ray: 40, k: 20 }), { ray: 60, k: 30 }, 'a balance kept: from it');
  assert.deepEqual(balancedVols(100, [{ id: 'a', vol: 50 }, { id: 'b', vol: 0 }]), { a: 100, b: 0 });
  assert.deepEqual(balancedVols(30, [{ id: 'a', vol: 0 }, { id: 'b', vol: 0 }]), { a: 30, b: 30 }, 'all at 0: all to the level');
  const h = await home();
  try {
    const app = await buildServer(h.hub, { webRoot });
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/speaker-groups/whole/balance', payload });
    assert.match((await put({ levels: { lamp: 10 } })).json().error, /isn’t in Whole home/);
    assert.match((await put({ levels: { ray: 120 } })).json().error, /0–100/);
    // Sounding alike where the owner sits: the Cast speakers at 60, Ray at 30.
    const r = await put({ levels: { kitchen: 60, dining: 60, bed: 60, ray: 30 } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(h.hub.config.get().speakerGroups![0]!.balance, { kitchen: 60, dining: 60, bed: 60, ray: 30 });
    assert.equal(h.hub.reg.get('ray')!.state.vol, 30);
    assert.equal(h.hub.reg.get('group_whole')!.state.vol, 60, 'the group’s volume is its loudest');
    // The group's volume: all of them, balance kept.
    await h.hub.reg.command('group_whole', { vol: 40 }, { kind: 'user', label: 'You' });
    assert.deepEqual(['kitchen', 'dining', 'bed', 'ray'].map(id => h.hub.reg.get(id)!.state.vol), [40, 40, 40, 20]);
    // Played with a volume: the same.
    await h.hub.reg.command('group_whole', { on: true, media: 'Loved', vol: 80 }, { kind: 'user', label: 'You' });
    assert.deepEqual(['kitchen', 'ray'].map(id => h.hub.reg.get(id)!.state.vol), [80, 40]);
    // A speaker leaving takes its place in the balance with it.
    await app.inject({ method: 'PUT', url: '/api/speaker-groups/whole', payload: { members: ['kitchen', 'dining', 'bed'] } });
    assert.deepEqual(h.hub.config.get().speakerGroups![0]!.balance, { kitchen: 60, dining: 60, bed: 60 });
    assert.equal((await put({ reset: true })).statusCode, 200);
    assert.equal(h.hub.config.get().speakerGroups![0]!.balance, undefined);
    await app.close();
  } finally { await h.close(); }
});
