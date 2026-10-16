import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { CastAdapter } from '../src/adapters/cast/index.ts';
import { NS } from '../src/adapters/cast/channel.ts';
import { fakeCast, listen } from './fake-cast.ts';

test('Cast: several speakers playing the same thing use their Cast group (perfect sync)', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker'), c = fakeCast('Guest Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Ocean waves' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20, rooms: { 'Music Room Speaker': 'music', 'Baby Room speaker': 'baby' },
    endpoints: [
      await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'),
      await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'),
      await ep(c, 'cccc0000000000000000000000000003', 'Nest Audio'),
      await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group'),
    ],
  });
  await reg.addAdapter(cast);
  try {
    assert.equal(reg.list().length, 3, 'groups are not devices');
    assert.equal(reg.get('cast_aaaa0000000000000000000000000001')!.room, 'music');
    assert.deepEqual(cast.groupList()[0].members.sort(), ['cast_aaaa0000000000000000000000000001', 'cast_bbbb0000000000000000000000000002']);

    // Both group members at once → one LOAD on the group, volumes set per speaker.
    const { changed } = await reg.applyTargets({
      cast_aaaa0000000000000000000000000001: { on: true, media: 'Ocean waves', vol: 15 },
      cast_bbbb0000000000000000000000000002: { on: true, media: 'Ocean waves', vol: 20 },
    }, { kind: 'mode', label: 'Night started' });
    assert.equal(changed.length, 2);
    assert.equal(g.loads(), 1);
    assert.equal(a.loads() + b.loads(), 0);
    assert.equal(g.st.url, 'https://stream.example/tarateel.mp3');
    assert.equal(a.st.level, 0.15);
    assert.equal(b.st.level, 0.2);

    // A speaker with no exact group plays on its own.
    await reg.command('cast_cccc0000000000000000000000000003', { on: true, media: 'Ocean waves' }, { kind: 'user', label: 'You' });
    assert.equal(c.loads(), 1);

    // Stopping one member mutes it; stopping the rest stops the group session.
    await reg.command('cast_aaaa0000000000000000000000000001', { on: false, media: null }, { kind: 'user', label: 'You' });
    assert.equal(a.st.muted, true);
    assert.ok(g.st.app, 'group still playing for the other speaker');
    await reg.command('cast_bbbb0000000000000000000000000002', { on: false, media: null }, { kind: 'user', label: 'You' });
    assert.equal(g.st.app, null);
  } finally {
    await reg.stop();
    for (const f of [a, b, c, g]) f.server.close();
  }
});

test('Cast: an announcement plays on each speaker on its own, never through their Cast group: loaded paused at its volume, then all started together; a speaker that doesn’t answer is left out without holding up the rest', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker'), c = fakeCast('Guest Room speaker'), dead = fakeCast('Soundbar');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20, clipLoadMs: 1500,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(c, 'cccc0000000000000000000000000003', 'Nest Audio'), await ep(dead, 'eeee0000000000000000000000000005', 'Q990D'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  try {
    const clip = { url: 'http://hub/api/clip/adhan.mp3', title: 'Adhan', contentType: 'audio/mpeg', durationMs: 3000 };
    const ids = ['cast_aaaa0000000000000000000000000001', 'cast_bbbb0000000000000000000000000002', 'cast_cccc0000000000000000000000000003', 'cast_eeee0000000000000000000000000005'];
    const snaps = await Promise.all(ids.map(id => reg.snapshotPlayback(id)));
    // The soundbar stops answering (busy on its TV input).
    dead.st.deaf = true;
    const t0 = Date.now();
    const r = await reg.playClips([{ id: ids[0]!, clip, vol: 10 }, { id: ids[1]!, clip, vol: 5 }, { id: ids[2]!, clip, vol: 8 }, { id: ids[3]!, clip, vol: 12 }], { kind: 'automation', label: 'Call to prayer' }, { startWaitMs: 0 });
    assert.deepEqual(r.map(x => x.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
    assert.ok(Date.now() - t0 < 5000, 'the silent soundbar held nobody up for long');
    assert.equal(g.loads(), 0, 'nothing through the Cast group');
    for (const f of [a, b, c]) {
      const steps = f.log.map(l => l.type).filter(t => ['LOAD', 'SET_VOLUME', 'PLAY'].includes(t));
      assert.deepEqual(steps, ['LOAD', 'SET_VOLUME', 'PLAY'], `${f.name}: loaded paused, its volume, then played`);
      assert.equal(f.log.find(l => l.type === 'LOAD')!.data.autoplay, false);
    }
    assert.deepEqual([a.st.level, b.st.level, c.st.level], [0.1, 0.05, 0.08], 'each at its own volume');
    assert.equal(reg.get(ids[0]!)!.state.media, 'Adhan');
    dead.st.deaf = false;
    await Promise.all(ids.slice(0, 3).map((id, i) => reg.restorePlayback(id, snaps[i]!, { kind: 'automation', label: 'Call to prayer' })));
    for (const f of [a, b, c]) assert.equal(f.st.app, null, `${f.name} idle again`);
  } finally {
    await reg.stop();
    for (const f of [a, b, c, dead, g]) f.server.close();
  }
});

test('Cast: an announcement on several speakers stays together: a speaker that started late joins where the rest are, and one that drifts is moved back in step', async () => {
  const a = fakeCast('Kitchen Speaker'), b = fakeCast('Bedroom Speaker'), bar = fakeCast('Soundbar');
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20, clipReadyMs: 300, unstickMs: 400, syncChecksMs: [700, 1100],
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(bar, 'eeee0000000000000000000000000005', 'Q930B')],
  });
  await reg.addAdapter(cast);
  try {
    const clip = { url: 'http://hub/api/clip/adhan.mp3', title: 'Adhan', contentType: 'audio/mpeg', durationMs: 200_000 };
    const ids = ['cast_aaaa0000000000000000000000000001', 'cast_bbbb0000000000000000000000000002', 'cast_eeee0000000000000000000000000005'];
    // The soundbar is slow to fetch the file (it was on its TV input).
    bar.st.buffering = true;
    const r = await reg.playClips(ids.map(id => ({ id, clip, vol: 20 })), { kind: 'automation', label: 'Call to prayer' }, { startWaitMs: 0 });
    assert.deepEqual(r.map(x => x.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    // Still stuck when checked: loaded again where the others are, not from the start.
    await new Promise(res => setTimeout(res, 600));
    const again = bar.log.filter(l => l.type === 'LOAD')[1];
    assert.ok(again, 'the soundbar was loaded again');
    assert.equal(again!.data.autoplay, true);
    assert.ok(Number(again!.data.currentTime) > 0.2, `it joined ${again!.data.currentTime} s in, with the others`);
    bar.st.buffering = false;
    // The speakers say where they are: the kitchen and the soundbar together, the bedroom 4 s behind.
    const since = Date.now();
    a.st.time = 5; bar.st.time = 5; b.st.time = 1;
    await new Promise(res => setTimeout(res, 800));
    const seek = b.log.find(l => l.type === 'SEEK');
    assert.ok(seek, 'the bedroom speaker was moved back in step');
    const elapsed = (Date.now() - since) / 1000;
    assert.ok(Math.abs(Number(seek!.data.currentTime) - 5) < 0.5 + elapsed, `to where the others are (${seek!.data.currentTime} s)`);
    assert.equal(seek!.data.resumeState, 'PLAYBACK_START');
    assert.ok(!a.log.some(l => l.type === 'SEEK') && !bar.log.some(l => l.type === 'SEEK'), 'the ones in step are left alone');
  } finally {
    await reg.stop();
    for (const f of [a, b, bar]) f.server.close();
  }
});

test('Cast: a group that stopped answering is stopped speaker by speaker', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Ocean waves' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  try {
    await reg.applyTargets({ cast_aaaa0000000000000000000000000001: { on: true, media: 'Ocean waves' }, cast_bbbb0000000000000000000000000002: { on: true, media: 'Ocean waves' } }, { kind: 'user', label: 'You' });
    assert.equal(g.loads(), 1);
    a.st.app = { appId: 'CC1AD845', sessionId: 's', transportId: 'web-1' };
    b.st.app = { appId: 'CC1AD845', sessionId: 's', transportId: 'web-1' };
    g.st.deaf = true;
    await reg.applyTargets({ cast_aaaa0000000000000000000000000001: { on: false, media: null }, cast_bbbb0000000000000000000000000002: { on: false, media: null } }, { kind: 'user', label: 'You' });
    assert.ok(a.log.some(l => l.type === 'STOP') && b.log.some(l => l.type === 'STOP'), 'each speaker told to stop');
    assert.equal(a.st.app, null);
    assert.equal(b.st.app, null);
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
  }
});

test('Cast: a speaker taken out of a playing group goes quiet and off, and back in rejoins without a restart', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Ocean waves' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  const A = 'cast_aaaa0000000000000000000000000001', B = 'cast_bbbb0000000000000000000000000002';
  const poll = () => (cast as unknown as { poll(): Promise<void> }).poll();
  try {
    await reg.applyTargets({ [A]: { on: true, media: 'Ocean waves' }, [B]: { on: true, media: 'Ocean waves' } }, { kind: 'user', label: 'You' });
    assert.equal(g.loads(), 1);
    // The speakers say they're in the group's session.
    a.st.app = b.st.app = { appId: 'MZ', sessionId: 's', transportId: 't' };

    await reg.command(A, { on: false, media: null }, { kind: 'user', label: 'You' });
    assert.equal(a.st.muted, true, 'muted, not stopping the group');
    assert.ok(g.st.app, 'the group plays on for the other speaker');
    await poll();
    assert.equal(reg.get(A)!.state.on, false, 'shown as off while taken out');
    assert.equal(reg.get(B)!.state.on, true);

    await reg.command(A, { on: true }, { kind: 'user', label: 'You' });
    assert.equal(a.st.muted, false, 'unmuted');
    assert.equal(g.loads() + a.loads(), 1, 'no new stream: it rejoins the group');
    await poll();
    assert.equal(reg.get(A)!.state.on, true);
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
  }
});

test('Cast: pause keeps the music on hold, and play carries on (not stop)', async () => {
  const a = fakeCast('Kitchen Speaker');
  const reg = new Registry(new Store(':memory:'), n => (n === 'Ocean waves' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, endpoints: [{ id: 'aaaa0000000000000000000000000001', name: a.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(a) }] });
  await reg.addAdapter(cast);
  const id = 'cast_aaaa0000000000000000000000000001';
  try {
    assert.ok(reg.get(id)!.capabilities.includes('pause'));
    await reg.command(id, { on: true, media: 'Ocean waves' }, { kind: 'user', label: 'You' });
    await reg.command(id, { paused: true }, { kind: 'user', label: 'You' });
    assert.equal(a.st.paused, true, 'PAUSE sent to the media session');
    assert.ok(a.st.app, 'the session is kept, not stopped');
    assert.equal(reg.get(id)!.state.paused, true);
    assert.equal(reg.get(id)!.state.on, true, 'paused is still on');
    await reg.command(id, { paused: false }, { kind: 'user', label: 'You' });
    assert.equal(a.st.paused, false, 'PLAY carries on');
    assert.equal(a.loads(), 1, 'nothing reloaded');
  } finally {
    await reg.stop();
    a.server.close();
  }
});

test('Cast: a group that gave no members at start is read again, so its Kova group gets perfect sync later', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const members: string[] = []; // the group doesn't list its speakers yet (busy, or just changed in Google Home)
  const g = fakeCast('Home Speaker Group', members);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  const both = () => [reg.get('cast_aaaa0000000000000000000000000001')!, reg.get('cast_bbbb0000000000000000000000000002')!];
  try {
    assert.equal(cast.castGroupFor(both()), undefined, 'no members known yet');
    members.push('aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002');
    await (cast as unknown as { poll(): Promise<void> }).poll();
    assert.equal(cast.castGroupFor(both()), 'Home Speaker Group');
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
  }
});


test('Cast: a Kova speaker group whose speakers are a Cast group plays through it (perfect sync)', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Ocean waves' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  const { SpeakerGroupsAdapter } = await import('../src/adapters/groups.ts');
  const groups = new SpeakerGroupsAdapter(reg, () => [{ id: 'kids', name: 'Kids rooms', members: ['cast_aaaa0000000000000000000000000001', 'cast_bbbb0000000000000000000000000002'] }]);
  await reg.addAdapter(cast);
  await reg.addAdapter(groups);
  try {
    assert.equal(cast.castGroupFor([reg.get('cast_aaaa0000000000000000000000000001')!, reg.get('cast_bbbb0000000000000000000000000002')!]), 'Home Speaker Group');
    await reg.command('group_kids', { on: true, media: 'Ocean waves', vol: 20 }, { kind: 'user', label: 'You' });
    assert.equal(g.loads(), 1, 'one LOAD on the Cast group');
    assert.equal(a.loads() + b.loads(), 0, 'not on each speaker separately');
    assert.equal(reg.get('group_kids')!.state.media, 'Ocean waves');
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
  }
});

test('Cast: a recording set to repeat loops on the speaker; a stream plays once', async () => {
  const a = fakeCast('Bedroom Speaker');
  const urls: Record<string, string> = { Rain: 'https://sounds.example/rain-1h.mp3', Radio: 'https://radio.example/live' };
  const reg = new Registry(new Store(':memory:'), n => urls[n]);
  reg.sourceLoops = n => n === 'Rain';
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, endpoints: [{ id: 'aaaa0000000000000000000000000002', name: a.name, model: 'Nest Mini', host: '127.0.0.1', port: await listen(a) }] });
  await reg.addAdapter(cast);
  const id = 'cast_aaaa0000000000000000000000000002';
  try {
    await reg.command(id, { on: true, media: 'Rain' }, { kind: 'user', label: 'You' });
    const q = a.log.find(l => l.type === 'QUEUE_LOAD')!;
    assert.equal(q.data.repeatMode, 'REPEAT_ALL', 'plays again from the start, until stopped');
    assert.equal((q.data.items as unknown[]).length, 2, 'the next copy is fetched before this one ends: no gap');
    assert.equal((q.data.items as { media: { streamType: string } }[])[0].media.streamType, 'BUFFERED');
    assert.equal(a.st.url, urls.Rain);
    // The speaker drops it by itself (the recording couldn't be fetched again): started again; stopped by a person: not.
    a.idle('ERROR');
    await new Promise(r => setTimeout(r, 2600));
    assert.equal(a.log.filter(l => l.type === 'QUEUE_LOAD').length, 2, 'started again');
    a.idle('CANCELLED');
    await new Promise(r => setTimeout(r, 2600));
    assert.equal(a.log.filter(l => l.type === 'QUEUE_LOAD').length, 2, 'a person’s stop stays stopped');
    await reg.command(id, { on: true, media: 'Radio' }, { kind: 'user', label: 'You' });
    assert.equal(a.log.filter(l => l.type === 'LOAD').length, 1, 'a stream is a plain LOAD');
    assert.equal(a.st.url, urls.Radio);
  } finally {
    await reg.stop();
    a.server.close();
  }
});

test('Cast: after Kova restarts, what a speaker still plays is Kova’s own again: shown by name, and back after an announcement; a media player left open after one shows as off', async () => {
  const a = fakeCast('Bedroom Speaker');
  const urls: Record<string, string> = { Thunderstorm: 'http://hub/api/sound/Thunderstorm' };
  const endpoints = [{ id: 'aaaa0000000000000000000000000002', name: a.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(a) }];
  const id = 'cast_aaaa0000000000000000000000000002';
  const start = async () => {
    const reg = new Registry(new Store(':memory:'), n => urls[n]);
    reg.sourceLoops = n => n === 'Thunderstorm';
    const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, endpoints });
    await reg.addAdapter(cast);
    return { reg, poll: () => (cast as unknown as { poll(): Promise<void> }).poll() };
  };
  let k = await start();
  try {
    await k.reg.command(id, { on: true, media: 'Thunderstorm' }, { kind: 'user', label: 'You' });
    await k.reg.stop();
    // Kova restarts; the speaker carries on.
    k = await start();
    await k.poll();
    assert.equal(k.reg.get(id)!.state.media, 'Thunderstorm', 'by its name, not “Casting”');
    const snap = await k.reg.snapshotPlayback(id);
    await k.reg.playClip(id, { url: 'http://hub/api/clip/adhan.mp3', title: 'Adhan', contentType: 'audio/mpeg', durationMs: 3000 }, 20, { kind: 'automation', label: 'Call to prayer' });
    const words = await k.reg.restorePlayback(id, snap, { kind: 'automation', label: 'Call to prayer' });
    assert.equal(words, 'back to Thunderstorm');
    assert.equal(a.st.url, urls.Thunderstorm);
    assert.equal(a.st.repeat, 'REPEAT_ALL', 'looping again');
    // An announcement that ended leaves the media player open a few minutes, holding nothing: off, not “Casting”.
    a.st.url = '';
    await k.reg.stop();
    k = await start();
    await k.poll();
    assert.equal(k.reg.get(id)!.state.on, false);
  } finally {
    await k.reg.stop();
    a.server.close();
  }
});

test('Finding speakers on another network: addresses, Cast devices by their info page, and groups on a high port', async () => {
  const { expandSubnet, findCastDevices, findCastGroups } = await import('../src/services/lan-find.ts');
  assert.equal(expandSubnet('192.168.1.0/24').length, 254);
  assert.deepEqual(expandSubnet('192.168.1.0/24').slice(0, 2), ['192.168.1.1', '192.168.1.2']);
  assert.deepEqual(expandSubnet('192.168.1.5'), ['192.168.1.5']);
  assert.throws(() => expandSubnet('10.0.0.0/16'), /a \/22 or smaller/);
  assert.throws(() => expandSubnet('kitchen'), /isn't a network/);

  const info = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'Kitchen Speaker', ssdp_udn: 'AAAA0000-0000-0000-0000-000000000001', device_info: { model_name: 'Google Nest Audio' } }));
  });
  await new Promise<void>(r => info.listen(0, '127.0.0.1', r));
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const gport = await listen(g);
  try {
    const found = await findCastDevices(['127.0.0.1'], 1000, (info.address() as AddressInfo).port);
    assert.deepEqual(found, [{ id: 'aaaa0000000000000000000000000001', name: 'Kitchen Speaker', model: 'Google Nest Audio', host: '127.0.0.1', port: 8009 }]);
    const groups = await findCastGroups(['127.0.0.1'], { ports: { from: gport - 1, to: gport + 1 }, insecure: true });
    assert.deepEqual(groups, [{ host: '127.0.0.1', port: gport, members: ['aaaa0000000000000000000000000001', 'bbbb0000000000000000000000000002'] }]);
  } finally { info.close(); g.server.close(); }
});

test('Cast: a speaker group that moved (another VLAN, no mDNS) is found again at its new port', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const gport = await listen(g);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const speakers = [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio')];
  // Its saved address: a port nothing listens on any more (taken after the fakes have theirs).
  const gone = net.createServer(); await new Promise<void>(r => gone.listen(0, '127.0.0.1', r));
  const oldPort = (gone.address() as AddressInfo).port; gone.close();
  const reg = new Registry(new Store(':memory:'));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20, timeoutMs: 500, groupPorts: { from: gport, to: gport },
    endpoints: [...speakers, { id: 'dddd0000000000000000000000000004', name: 'Home Speaker Group', model: 'Google Cast Group', host: '127.0.0.1', port: oldPort }],
  });
  await reg.addAdapter(cast);
  const both = () => [reg.get('cast_aaaa0000000000000000000000000001')!, reg.get('cast_bbbb0000000000000000000000000002')!];
  try {
    // Not answering where it was (at start, and the first poll): looked for, and followed to its new port.
    assert.equal(cast.castGroupFor(both()), 'Home Speaker Group', 'followed to its new port');
    assert.ok(g.log.some(l => l.ns === NS.multizone), 'asked at the new port');
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
  }
});

test('Cast: a group plus a speaker outside it, at once: the Cast group plays as one, the other on its own; positions and moves', async () => {
  const a = fakeCast('Kitchen speaker'), b = fakeCast('Dining speaker'), c = fakeCast('Office speaker');
  const g = fakeCast('Home speakers', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'));
  reg.queues = async () => ({ label: 'Loved', shuffle: false, tracks: [1, 2, 3].map(i => ({ id: `t${i}`, title: `Song ${i}`, url: `http://helix/${i}.flac`, contentType: 'audio/flac', durationMs: 180_000 })) });
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(c, 'cccc0000000000000000000000000003', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  try {
    assert.deepEqual(cast.nativeGroups().map(n => [n.via, n.name, n.members.sort()]), [['cast', 'Home speakers', ['cast_aaaa0000000000000000000000000001', 'cast_bbbb0000000000000000000000000002']]]);
    const you = { kind: 'user' as const, label: 'You' };
    await reg.applyTargets({ cast_aaaa0000000000000000000000000001: { on: true, media: 'Loved' }, cast_bbbb0000000000000000000000000002: { on: true, media: 'Loved' }, cast_cccc0000000000000000000000000003: { on: true, media: 'Loved' } }, you);
    const qloads = (f: ReturnType<typeof fakeCast>) => f.log.filter(l => l.type === 'QUEUE_LOAD').length;
    assert.deepEqual([qloads(g), qloads(a), qloads(b), qloads(c)], [1, 0, 0, 1], 'not three separate speakers: the group, and the office alone');
    // A group's speaker answers with the group's place.
    g.st.time = 42.25;
    const pos = await cast.playbackPosition(reg.get('cast_aaaa0000000000000000000000000001')!);
    assert.equal(pos!.positionMs, 42_250);
    assert.equal(pos!.durationMs, 180_000);
    assert.equal(pos!.playing, true);
    assert.ok(Math.abs(pos!.at - Date.now()) < 1000);
    // Moving the office: a seek in the same song, a jump to the next.
    await cast.syncTo(reg.get('cast_cccc0000000000000000000000000003')!, { index: 0, positionMs: 42_500 });
    assert.equal(c.log.find(l => l.type === 'SEEK')!.data.currentTime, 42.5);
    await cast.syncTo(reg.get('cast_cccc0000000000000000000000000003')!, { index: 1, positionMs: 0 });
    assert.deepEqual([c.log.find(l => l.type === 'QUEUE_UPDATE')!.data.jump, c.log.find(l => l.type === 'QUEUE_UPDATE')!.data.currentTime], [1, 0]);
    assert.equal(g.log.filter(l => l.type === 'SEEK').length, 0, 'the group is left alone');
  } finally {
    await reg.stop();
    for (const f of [a, b, c, g]) f.server.close();
  }
});

test('Cast: an endless stream a speaker never got going falls back to the repeating queue, however long it took to give up', async () => {
  const spk = fakeCast('Bedroom Speaker');
  const reg = new Registry(new Store(':memory:'), n => (n === 'Rain' ? 'http://10.0.0.2:8140/api/sound/Rain.m4a' : undefined));
  reg.sourceLoops = () => true;
  reg.endlessUrl = n => `http://10.0.0.2:8140/api/sound/${n}.m4a?endless=1`;
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, timeoutMs: 400, endpoints: [{ id: 'eeee0000000000000000000000000005', name: spk.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(spk) }] });
  await reg.addAdapter(cast);
  const ID = 'cast_eeee0000000000000000000000000005';
  const loads = () => spk.log.filter(l => l.type === 'LOAD' || l.type === 'QUEUE_LOAD');
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const realNow = Date.now;
  try {
    // Played, then dropped minutes later (the hub restarted): it can play one, so the endless stream again.
    await reg.command(ID, { on: true, media: 'Rain' }, { kind: 'user', label: 'Kauser' });
    assert.match(String((loads().at(-1)!.data.media as { contentId: string }).contentId), /endless=1$/);
    const t0 = realNow();
    Date.now = () => t0 + 240_000;
    spk.idle('ERROR');
    await wait(500);
    assert.equal(loads().at(-1)!.type, 'LOAD');
    assert.match(String((loads().at(-1)!.data.media as { contentId: string }).contentId), /endless=1$/);

    // Loaded but never playing, and given up on 4 minutes later: the repeating queue from now on.
    Date.now = realNow;
    spk.st.loading = true;
    await reg.command(ID, { on: true, media: 'Rain' }, { kind: 'user', label: 'Kauser' });
    const t1 = realNow();
    Date.now = () => t1 + 240_000;
    spk.idle('ERROR');
    await wait(500);
    assert.equal(loads().at(-1)!.type, 'QUEUE_LOAD');
    assert.equal(loads().at(-1)!.data.repeatMode, 'REPEAT_ALL');
  } finally {
    Date.now = realNow;
    await cast.stop();
    spk.server.close();
  }
});

test('Cast: a speaker slow to answer a load (it fetches the start first) has longer than other requests', async () => {
  const spk = fakeCast('Bedroom Speaker');
  const reg = new Registry(new Store(':memory:'), n => (n === 'Radio' ? 'https://stream.example/radio.mp3' : undefined));
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, timeoutMs: 300, endpoints: [{ id: 'ffff0000000000000000000000000006', name: spk.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(spk) }] });
  await reg.addAdapter(cast);
  try {
    spk.st.loadDelayMs = 600; // twice the request timeout, within a load's
    await reg.command('cast_ffff0000000000000000000000000006', { on: true, media: 'Radio' }, { kind: 'user', label: 'Kauser' });
    assert.equal(spk.st.url, 'https://stream.example/radio.mp3');
    assert.equal(reg.get('cast_ffff0000000000000000000000000006')!.state.media, 'Radio');
  } finally {
    await cast.stop();
    spk.server.close();
  }
});
