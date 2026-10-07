import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import type { Adapter, AdapterContext, Clip, DeviceInfo } from '../src/adapters/sdk.ts';
import type { AnnounceAction, Automation, Command, Device, DeviceState, HomeConfig } from '../src/model/types.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { announceVol, announceWords } from '../src/engine/announce.ts';
import { checkAutomation } from '../src/engine/automation-check.ts';
import { chimeWav } from '../src/services/clips.ts';
import { at } from './helpers.ts';

// Announcements: snapshot each speaker, play at its calibrated level, wait, put everything back.

/**
 * Speakers with their own exact account (as Cast and Sonos give): what they play, where they are in it, and a
 * clip that "plays" until the test says it ended. `fail` speakers refuse the clip.
 */
class ExactSpeakers implements Adapter {
  id = 'exact'; name = 'Exact speakers'; icon = 'speaker'; kind = 'Local' as const;
  ctx?: AdapterContext;
  pos = new Map<string, number>();
  log: string[] = [];
  constructor(private infos: DeviceInfo[], private fail = new Set<string>()) {}
  async start(ctx: AdapterContext) { this.ctx = ctx; ctx.announce(this.infos); }
  async stop() {}
  status() { return { ok: true }; }
  async command(d: Device, cmd: Command) { this.log.push(`${d.id} ${JSON.stringify(cmd)}`); }
  async snapshotPlayback(d: Device) { return d.state.on && d.state.media ? { media: d.state.media, at: this.pos.get(d.id) ?? 0 } : null; }
  async playClip(d: Device, clip: Clip) {
    if (this.fail.has(d.id)) throw new Error('the speaker didn’t answer');
    this.log.push(`${d.id} clip ${clip.title} ${clip.url}`);
  }
  async restorePlayback(d: Device, snap: unknown) {
    const s = snap as { media: string; at: number } | null;
    if (!s) { this.log.push(`${d.id} idle`); return { words: 'idle again', state: { on: false, media: null } as DeviceState }; }
    this.log.push(`${d.id} resume ${s.media} @${s.at}`);
    return { words: `resumed ${s.media} at ${s.at}s`, state: { on: true, media: s.media } };
  }
  /** The clip ended on its own (a speaker reporting idle). */
  ended(id: string) { this.ctx!.report(id, { on: false, media: null }); }
}

const SPEAKERS: DeviceInfo[] = [
  { id: 'kitchen_spk', name: 'Kitchen speaker', room: 'kitchen', type: 'media', integration: 'Exact', address: '10.0.0.21:8009', capabilities: ['onoff', 'media', 'volume', 'queue', 'pause'], state: { on: true, media: 'Loved', vol: 40 } },
  { id: 'loud_spk', name: 'Loud speaker', room: 'lounge', type: 'media', integration: 'Exact', address: '10.0.0.22', capabilities: ['onoff', 'media', 'volume', 'queue', 'pause'], state: { on: false, media: null, vol: 25 } },
  { id: 'broken_spk', name: 'Broken speaker', room: 'office', type: 'media', integration: 'Exact', address: '10.0.0.23', capabilities: ['onoff', 'media', 'volume'], state: { on: true, media: 'Radio', vol: 30 } },
];
const VIRTUAL: DeviceInfo[] = [
  { id: 'plain_spk', name: 'Plain speaker', room: 'master', type: 'media', integration: 'Virtual', address: 'demo.plain', capabilities: ['onoff', 'media', 'volume'], state: { on: true, media: 'Jazz stream', vol: 35 } },
  { id: 'idle_spk', name: 'Idle speaker', room: 'guest', type: 'media', integration: 'Virtual', address: 'demo.idle', capabilities: ['onoff', 'media', 'volume'], state: { on: false, media: null, vol: 10 } },
  { id: 'box', name: 'Lounge box', room: 'lounge', type: 'tv', integration: 'Helix', address: 'demo.box', capabilities: ['onoff', 'media', 'pause', 'library'], state: { on: true, media: 'A film', paused: false } },
];

async function announceHub(tweak?: (c: HomeConfig) => void, fail = new Set<string>()) {
  const dir = mkdtempSync(join(tmpdir(), 'kova-announce-'));
  const clock = { t: at(12) };
  const exact = new ExactSpeakers(SPEAKERS.map(d => ({ ...d, state: { ...d.state } })), fail);
  const virtual = new VirtualAdapter([...demoDevices(), ...VIRTUAL.map(d => ({ ...d, state: { ...d.state } }))]);
  const hub = new Hub({
    dbPath: ':memory:', dataDir: dir,
    initialConfig: () => {
      const c = demoConfig();
      c.sources = [...c.sources.filter(s => s.name !== 'Jazz stream' && s.name !== 'Radio'), { name: 'Jazz stream', icon: 'piano', url: 'http://radio.example/jazz' }, { name: 'Radio', icon: 'radio', url: 'http://radio.example/live' }];
      c.speakerGroups = [{ id: 'whole', name: 'Whole home', members: ['kitchen_spk', 'loud_spk', 'plain_spk'] }];
      c.devices = { ...(c.devices ?? {}), loud_spk: { announceTrim: 60 }, plain_spk: { announceTrim: 80 } };
      tweak?.(c);
      return c;
    },
    adapters: [exact, virtual], now: () => clock.t, tickMs: 0, security: { settleMs: 5, frameDelayMs: 5 },
  });
  await hub.start();
  hub.lanBase = host => `http://10.0.0.2:8140${host ? `#${host}` : ''}`;
  const clip = hub.clips.add('Test chime', chimeWav(), clock.t);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  /** Move the engine's clock on by ms, in small steps, letting the run carry on in between. */
  const pass = async (ms: number, step = 500) => { for (let t = 0; t < ms; t += step) { clock.t += step; await hub.engine.tick(clock.t); await settle(); } };
  const close = async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { hub, clock, exact, virtual, clip, settle, pass, close, dev: (id: string) => hub.reg.get(id)!.state };
}

const step = (o: Partial<AnnounceAction> = {}): AnnounceAction => ({ kind: 'announce', media: 'Radio', vol: 20, targets: {}, restore: true, ...o });
const auto = (actions: AnnounceAction[], extra: Partial<Automation> = {}): Automation => ({ id: 'a1', name: 'Call', enabled: true, triggers: [{ kind: 'hub', event: 'start' }], conditions: [], actions, mode: 'single', ...extra });

test('Calibration: the level × each speaker’s loudness, rounded and kept in 1–100', () => {
  assert.equal(announceVol(15, 100), 15);
  assert.equal(announceVol(15, 60), 9);
  assert.equal(announceVol(15, 70), 11);
  assert.equal(announceVol(15, 80), 12);
  assert.equal(announceVol(1, 20), 1, 'never silent when a level was asked for');
  assert.equal(announceVol(90, 200), 100);
  assert.equal(announceVol(0, 150), 0);
});

test('Announce: snapshot, calibrated volumes, all at once, wait for the clip, then everything back; the box pauses and carries on', async () => {
  const h = await announceHub();
  try {
    const a = step({ media: `clip:${h.clip.id}`, vol: 15, targets: { kitchen_spk: {}, loud_spk: {}, plain_spk: {}, idle_spk: {} }, pause: ['box'] });
    const going = h.hub.engine.automations.runNow(auto([a]), 'test');
    await h.settle();
    // Playing: every speaker at its own calibrated level, the box paused.
    assert.equal(h.dev('kitchen_spk').vol, 15);
    assert.equal(h.dev('loud_spk').vol, 9, '15 × 60%');
    assert.equal(h.dev('plain_spk').vol, 12, '15 × 80%');
    assert.equal(h.dev('plain_spk').media, 'Test chime', 'a speaker without clip support plays it as a source');
    assert.equal(h.dev('box').paused, true);
    assert.ok(h.exact.log.some(l => l.startsWith('kitchen_spk clip Test chime http://10.0.0.2:8140#10.0.0.21/api/clip/')), 'the URL is the hub’s address on the speaker’s network');
    await h.pass(4500);
    const run = await going;
    assert.equal(run!.result, 'done');
    // Back: volumes, what played (resumed where the speaker can, restarted by name where not), idle stays idle.
    assert.equal(h.dev('kitchen_spk').vol, 40);
    assert.equal(h.dev('kitchen_spk').media, 'Loved');
    assert.ok(h.exact.log.includes('kitchen_spk resume Loved @0'));
    assert.equal(h.dev('loud_spk').vol, 25);
    assert.equal(h.dev('loud_spk').on, false, 'it was off: off again');
    assert.equal(h.dev('plain_spk').media, 'Jazz stream');
    assert.equal(h.dev('plain_spk').vol, 35);
    assert.equal(h.dev('idle_spk').on, false);
    assert.equal(h.dev('idle_spk').vol, 10);
    assert.equal(h.dev('box').paused, false, 'the box carries on');
    const texts = run!.steps.map(s => s.text);
    assert.ok(texts.some(t => /^Announced Test chime on Kitchen speaker 15%, Loud speaker 9%, Plain speaker 12%, Idle speaker 15%/.test(t)), texts.join(' | '));
    assert.ok(texts.includes('Lounge box carried on'));
    const back = run!.steps.find(s => s.text === 'Put the speakers back')!;
    assert.match(back.detail!, /Kitchen speaker: resumed Loved/);
    assert.match(back.detail!, /Plain speaker: Jazz stream again/);
    assert.match(back.detail!, /Idle speaker: off again/);
  } finally { await h.close(); }
});

test('Announce: a failing speaker doesn’t stop the rest, and the history names it', async () => {
  const h = await announceHub(undefined, new Set(['broken_spk']));
  try {
    const going = h.hub.engine.automations.runNow(auto([step({ media: `clip:${h.clip.id}`, targets: { kitchen_spk: {}, broken_spk: {} } })]), 'test');
    await h.settle();
    assert.equal(h.dev('kitchen_spk').vol, 20);
    await h.pass(4500);
    const run = (await going)!;
    const played = run.steps.find(s => s.text.startsWith('Announced'))!;
    assert.equal(played.ok, false);
    assert.match(played.detail!, /Broken speaker didn’t play: the speaker didn’t answer/);
    assert.match(played.text, /Kitchen speaker 20%/);
    // Both are put back, the broken one to its volume and what it played.
    assert.equal(h.dev('broken_spk').vol, 30);
    assert.equal(h.dev('kitchen_spk').vol, 40);
  } finally { await h.close(); }
});

test('Announce: a speaker group stands for its speakers, each at its own loudness; off and “skip while Guests” sit it out', async () => {
  const h = await announceHub();
  try {
    await h.hub.engine.startOverlay('guests', { kind: 'user', label: 'You' });
    const a = step({ media: `clip:${h.clip.id}`, vol: 50, targets: { group_whole: {}, kitchen_spk: { off: true }, idle_spk: { skipWhile: ['guests'] } } });
    const going = h.hub.engine.automations.runNow(auto([a]), 'test');
    await h.settle();
    assert.equal(h.dev('loud_spk').vol, 30, '50 × 60%');
    assert.equal(h.dev('plain_spk').vol, 40, '50 × 80%');
    assert.equal(h.dev('kitchen_spk').vol, 40, 'switched off in the step: left alone, though it’s in the group');
    assert.equal(h.dev('idle_spk').vol, 10, 'skipped while Guests is on');
    await h.pass(4500);
    const run = (await going)!;
    assert.ok(run.steps.some(s => s.text === 'Left out Idle speaker while Guests is on'));
  } finally { await h.close(); }
});

test('Announce: no clip length known — it ends when the speakers say they’ve stopped (or at most maxSec)', async () => {
  const h = await announceHub();
  try {
    const going = h.hub.engine.automations.runNow(auto([step({ media: 'Radio', targets: { kitchen_spk: {} }, maxSec: 60 })]), 'test');
    await h.settle();
    await h.pass(4000);
    h.exact.ended('kitchen_spk');
    await h.settle();
    const run = (await going)!;
    assert.equal(run.result, 'done');
    assert.ok(h.clock.t - at(12) < 10_000, 'didn’t wait the full minute');
    assert.equal(h.dev('kitchen_spk').media, 'Loved');
  } finally { await h.close(); }
});

test('Announce: restore off puts volumes back and leaves the speakers idle', async () => {
  const h = await announceHub();
  try {
    const going = h.hub.engine.automations.runNow(auto([step({ media: `clip:${h.clip.id}`, targets: { plain_spk: {} }, restore: false })]), 'test');
    await h.settle();
    await h.pass(4500);
    await going;
    assert.equal(h.dev('plain_spk').vol, 35);
    assert.ok(!h.dev('plain_spk').media, 'idle');
  } finally { await h.close(); }
});

test('Prayer triggers: "every prayer" is five; Fajr plays its own clip; the checker cleans an announce step', async () => {
  const h = await announceHub(c => { c.prayer = { on: true }; });
  try {
    const fajrClip = h.hub.clips.add('Fajr chime', chimeWav(), h.clock.t);
    const ctx = { device: (id: string) => h.hub.reg.get(id), cfg: h.hub.config.get(), media: (m: string) => h.hub.mediaProblem(m) };
    const a = checkAutomation({
      name: 'Call to prayer', triggers: [{ kind: 'time', at: { kind: 'prayer', prayer: 'all' } }],
      actions: [{ kind: 'announce', media: `clip:${h.clip.id}`, mediaFor: { fajr: `clip:${fajrClip.id}` }, targets: { kitchen_spk: { vol: 15 }, loud_spk: { vol: 15 } }, pause: ['box'] }],
    }, ctx);
    assert.deepEqual(a.triggers.map(t => t.kind === 'time' && t.at.kind === 'prayer' ? t.at.prayer : '?'), ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
    const x = a.actions[0] as AnnounceAction;
    assert.equal(x.vol, 15, 'the same level on every target is the step’s');
    assert.deepEqual(x.targets, { kitchen_spk: {}, loud_spk: {} });
    assert.equal(x.restore, true);
    assert.match(announceWords(x, id => h.hub.reg.get(id)!.name, id => h.hub.clips.get(id)?.name), /^Announce Test chime \(Fajr: Fajr chime\) on 2 speakers at 15%, pausing Lounge box, then back to what they played$/);
    // Bad shapes are refused with what to do.
    assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub' }], actions: [{ kind: 'announce', media: 'Radio', targets: { box: {} } }] }, ctx), /Lounge box isn’t a speaker/);
    assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub' }], actions: [{ kind: 'announce', media: 'clip:000000000000000000000000', targets: { kitchen_spk: {} } }] }, ctx), /that clip isn’t on the hub/);
    assert.throws(() => checkAutomation({ name: 'x', triggers: [{ kind: 'hub' }], actions: [{ kind: 'announce', media: 'Radio', targets: { kitchen_spk: { off: true } } }] }, ctx), /switched off/);
    // Without its audio it's kept, switched off.
    assert.equal(checkAutomation({ name: 'x', triggers: [{ kind: 'hub' }], actions: [{ kind: 'announce', targets: { kitchen_spk: {} } }] }, ctx).enabled, false);

    // At Fajr's time, the run picks Fajr's clip.
    const { prayerDay } = await import('../src/rhythms/rhythms.ts');
    const { localDate } = await import('../src/util/time.ts');
    const tomorrow = localDate(h.clock.t + 86400_000, h.hub.config.get().timezone);
    const fajr = prayerDay(tomorrow, h.hub.config.get()).fajr!;
    h.clock.t = fajr - 1000;
    await h.hub.engine.tick(h.clock.t);
    h.hub.config.update(c => { c.automations = [{ id: 'prayer_calls', ...a }]; });
    h.clock.t = fajr + 1000;
    await h.hub.engine.tick(h.clock.t);
    await h.settle();
    assert.ok(h.exact.log.some(l => l.startsWith('kitchen_spk clip Fajr chime')), h.exact.log.join('\n'));
    await h.pass(4500);
    const run = h.hub.engine.automations.lastRun('prayer_calls')!;
    assert.equal(run.why, 'It’s Fajr');
    assert.equal(run.result, 'done');
  } finally { await h.close(); }
});
