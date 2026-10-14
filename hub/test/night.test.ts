import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { CastAdapter } from '../src/adapters/cast/index.ts';
import { demoConfig } from '../src/seed/demo-home.ts';
import { chimeWav } from '../src/services/clips.ts';
import type { AnnounceAction, Cause } from '../src/model/types.ts';
import type { Notification } from '../src/services/notify.ts';
import { fakeCast, listen } from './fake-cast.ts';

// A whole night on one Google speaker, the way it goes in a home: the thunderstorm at bedtime, Kova restarted twice
// (an update), the call to prayer at Fajr, and the thunderstorm back after it; then a speaker that doesn't come back
// is tried again, and the owner told when it still isn't.

const STORM = 'http://sounds.example/storm.mp3';
const ID = 'cast_bbbb0000000000000000000000000001';
const fajr: Cause = { kind: 'automation', id: 'call_to_prayer', label: 'Call to prayer', detail: 'It’s Fajr' };

test('A night: the thunderstorm plays endlessly, carries on through restarts, and comes back after the call to prayer — or the owner hears it didn’t', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-night-'));
  const spk = fakeCast('Bedroom Speaker');
  const endpoints = [{ id: 'bbbb0000000000000000000000000001', name: spk.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(spk) }];
  const told: Notification[] = [];
  let cast!: CastAdapter;
  /** Kova starting (again): the same database and data, its own Cast connection. */
  const start = async () => {
    cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, timeoutMs: 400, endpoints });
    const hub = new Hub({
      dbPath: join(dir, 'kova.db'), dataDir: dir,
      initialConfig: () => { const c = demoConfig(); c.sources = [{ name: 'Thunderstorm', icon: 'thunderstorm', url: STORM, loop: true }]; return c; },
      adapters: [cast], tickMs: 0, inputSwitchMs: 0,
    });
    // A hub that can make loops (ffmpeg), with its address on the network.
    hub.loops.available = () => true;
    hub.lanBase = () => 'http://10.0.0.2:8140';
    await hub.start();
    hub.announcer.notify = async n => { told.push(n); };
    (hub.announcer as unknown as { o: { checkMs: number } }).o.checkMs = 300;
    return hub;
  };
  const poll = () => (cast as unknown as { poll(): Promise<void> }).poll();
  const settle = async (ms = 50) => { await new Promise(r => setTimeout(r, ms)); };
  const loads = () => spk.log.filter(l => l.type === 'LOAD' || l.type === 'QUEUE_LOAD');
  const fajrStep = (clip: string): AnnounceAction => ({ kind: 'announce', media: `clip:${clip}`, vol: 20, targets: { [ID]: {} }, restore: true, maxSec: 20 });
  /** The call to prayer, the clip ending by itself a moment in. */
  const callToPrayer = async (hub: Hub) => {
    const clip = hub.clips.add('Fajr adhan', chimeWav(), Date.now());
    const going = hub.announcer.run(fajrStep(clip.id), { cause: fajr, overlay: null, wait: async (ms, done) => { const until = Date.now() + ms; while (Date.now() < until && !done()) await settle(20); } });
    await settle(200);
    assert.equal(hub.reg.get(ID)!.state.media, 'Fajr adhan');
    spk.st.url = '';
    spk.idle('FINISHED');
    await settle(3200);
    return going;
  };

  let hub = await start();
  try {
    // Bedtime: one endless stream from the hub, never a file that ends.
    await poll();
    await hub.reg.command(ID, { on: true, media: 'Thunderstorm' }, { kind: 'automation', label: 'Thunderstorm at bedtime' });
    let load = loads().at(-1)!;
    const media = load.data.media as { contentId: string; streamType: string };
    assert.equal(load.type, 'LOAD');
    assert.equal(media.contentId, 'http://10.0.0.2:8140/api/sound/Thunderstorm.m4a?endless=1');
    assert.equal(media.streamType, 'LIVE');

    // An update restarts Kova; the hub's stream ends with it and the speaker goes quiet. Kova carries on with it.
    await hub.stop();
    spk.st.url = '';
    hub = await start();
    const before = loads().length;
    await poll();
    await settle(100);
    assert.equal(loads().length, before + 1, 'started again');
    assert.match(String((loads().at(-1)!.data.media as { contentId: string }).contentId), /Thunderstorm\.m4a\?endless=1$/);
    assert.equal(hub.reg.get(ID)!.state.media, 'Thunderstorm');
    assert.ok(hub.store.query({ kinds: ['state'], devices: [ID] }).some(e => e.cause.detail === 'carried on after Kova restarted'), 'said in Activity');

    // Restarted again, this time while the speaker still plays from what it holds: Kova knows it by name, and leaves it be.
    await hub.stop();
    hub = await start();
    const n = loads().length;
    await poll();
    await settle(100);
    assert.equal(loads().length, n, 'not loaded again');
    assert.equal(hub.reg.get(ID)!.state.media, 'Thunderstorm', 'by its name, not “Casting”');

    // Fajr: the adhan, then the thunderstorm back, endless again.
    await callToPrayer(hub);
    load = loads().at(-1)!;
    assert.match(String((load.data.media as { contentId: string }).contentId), /Thunderstorm\.m4a\?endless=1$/);
    assert.equal(hub.reg.get(ID)!.state.media, 'Thunderstorm');
    assert.equal(told.length, 0);

    // A speaker that can't play an endless stream gets the repeating queue instead, and still comes back. (A while
    // later: speakers of a Cast group share one putting back for a few seconds.)
    await settle(5200);
    spk.st.refuse = /endless=1/;
    await callToPrayer(hub);
    load = loads().at(-1)!;
    assert.equal(load.type, 'QUEUE_LOAD', JSON.stringify(loads().slice(-4).map(l => [l.type, (l.data.media as { contentId?: string } | undefined)?.contentId])));
    assert.equal(load.data.repeatMode, 'REPEAT_ALL');
    assert.equal(hub.reg.get(ID)!.state.media, 'Thunderstorm');
    spk.st.refuse = null;

    // Not back after the adhan (the speaker didn't answer as Kova put it back), and still not when tried again: the owner is told.
    await settle(5200);
    const clip = hub.clips.add('Fajr adhan', chimeWav(), Date.now());
    const going = hub.announcer.run(fajrStep(clip.id), { cause: fajr, overlay: null, wait: async (ms, done) => { const until = Date.now() + ms; while (Date.now() < until && !done()) await settle(20); } });
    await settle(200);
    spk.st.url = '';
    spk.idle('FINISHED');
    spk.st.deaf = true;
    await going;
    await settle(1800);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.equal(told[0]!.title, 'Not back after Fajr adhan');
    assert.match(told[0]!.body, /Bedroom Speaker \(Thunderstorm\)/);
  } finally {
    spk.st.deaf = false;
    await hub.stop();
    spk.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
