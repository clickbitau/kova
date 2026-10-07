import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { CastAdapter } from '../src/adapters/cast/index.ts';
import { encodeMessage, decodeMessage, NS } from '../src/adapters/cast/channel.ts';

/** A fake Cast receiver: enough of receiver, media and multizone to drive the adapter. */
function fakeCast(name: string, members: string[] = []) {
  const log: { ns: string; type: string; data: Record<string, unknown> }[] = [];
  const st = { app: null as null | { appId: string; sessionId: string; transportId: string }, level: 0.3, muted: false, url: '', paused: false, time: 0 };
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    const reply = (m: { source: string; namespace: string; data: Record<string, unknown> }) =>
      sock.write(encodeMessage({ source: m.source, destination: 'sender-0', namespace: m.namespace, data: m.data }));
    const status = (requestId: unknown) => ({ type: 'RECEIVER_STATUS', requestId, status: { volume: { level: st.level, muted: st.muted }, applications: st.app ? [st.app] : [] } });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const m = decodeMessage(buf.subarray(4, 4 + buf.readUInt32BE(0)));
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        const type = String(m.data.type);
        log.push({ ns: m.namespace, type, data: m.data });
        const rid = m.data.requestId;
        if (m.namespace === NS.receiver) {
          if (type === 'LAUNCH') st.app = { appId: String(m.data.appId), sessionId: 'sess-1', transportId: 'web-1' };
          if (type === 'STOP') { st.app = null; st.url = ''; }
          if (type === 'SET_VOLUME') { const v = m.data.volume as { level?: number; muted?: boolean }; if (v.level != null) st.level = v.level; if (v.muted != null) st.muted = v.muted; }
          reply({ source: 'receiver-0', namespace: NS.receiver, data: status(rid) });
        } else if (m.namespace === NS.media && (type === 'LOAD' || type === 'QUEUE_LOAD')) {
          st.url = String((type === 'LOAD' ? m.data.media as { contentId: string } : (m.data.items as { media: { contentId: string } }[])[0].media).contentId);
          st.paused = false;
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: [{ mediaSessionId: 7, playerState: 'PLAYING' }] } });
        } else if (m.namespace === NS.media && (type === 'GET_STATUS' || type === 'PAUSE' || type === 'PLAY' || type === 'SEEK' || type === 'QUEUE_UPDATE')) {
          if (type === 'PAUSE' || type === 'PLAY') { assert.equal(m.data.mediaSessionId, 7); st.paused = type === 'PAUSE'; }
          if (type === 'SEEK') st.time = Number(m.data.currentTime);
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: st.app ? [{ mediaSessionId: 7, playerState: st.paused ? 'PAUSED' : 'PLAYING', currentTime: st.time }] : [] } });
        } else if (m.namespace === NS.multizone) {
          reply({ source: 'receiver-0', namespace: NS.multizone, data: { type: 'MULTIZONE_STATUS', requestId: rid, status: { devices: members.map(id => ({ deviceId: id, name: id })) } } });
        }
      }
    });
  });
  return { server, log, st, name, loads: () => log.filter(l => l.type === 'LOAD').length };
}

async function listen(f: ReturnType<typeof fakeCast>) {
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  return (f.server.address() as AddressInfo).port;
}

test('Cast: several speakers playing the same thing use their Cast group (perfect sync)', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker'), c = fakeCast('Guest Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Tarateel' ? 'https://stream.example/tarateel.mp3' : undefined));
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
      cast_aaaa0000000000000000000000000001: { on: true, media: 'Tarateel', vol: 15 },
      cast_bbbb0000000000000000000000000002: { on: true, media: 'Tarateel', vol: 20 },
    }, { kind: 'mode', label: 'Night started' });
    assert.equal(changed.length, 2);
    assert.equal(g.loads(), 1);
    assert.equal(a.loads() + b.loads(), 0);
    assert.equal(g.st.url, 'https://stream.example/tarateel.mp3');
    assert.equal(a.st.level, 0.15);
    assert.equal(b.st.level, 0.2);

    // A speaker with no exact group plays on its own.
    await reg.command('cast_cccc0000000000000000000000000003', { on: true, media: 'Tarateel' }, { kind: 'user', label: 'You' });
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

test('Cast: a speaker taken out of a playing group goes quiet and off, and back in rejoins without a restart', async () => {
  const a = fakeCast('Music Room Speaker'), b = fakeCast('Baby Room speaker');
  const g = fakeCast('Home Speaker Group', ['aaaa0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002']);
  const ep = async (f: ReturnType<typeof fakeCast>, id: string, model: string) => ({ id, name: f.name, model, host: '127.0.0.1', port: await listen(f) });
  const reg = new Registry(new Store(':memory:'), n => (n === 'Tarateel' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20,
    endpoints: [await ep(a, 'aaaa0000000000000000000000000001', 'Nest Audio'), await ep(b, 'bbbb0000000000000000000000000002', 'Nest Audio'), await ep(g, 'dddd0000000000000000000000000004', 'Google Cast Group')],
  });
  await reg.addAdapter(cast);
  const A = 'cast_aaaa0000000000000000000000000001', B = 'cast_bbbb0000000000000000000000000002';
  const poll = () => (cast as unknown as { poll(): Promise<void> }).poll();
  try {
    await reg.applyTargets({ [A]: { on: true, media: 'Tarateel' }, [B]: { on: true, media: 'Tarateel' } }, { kind: 'user', label: 'You' });
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
  const reg = new Registry(new Store(':memory:'), n => (n === 'Tarateel' ? 'https://stream.example/tarateel.mp3' : undefined));
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 20, endpoints: [{ id: 'aaaa0000000000000000000000000001', name: a.name, model: 'Nest Audio', host: '127.0.0.1', port: await listen(a) }] });
  await reg.addAdapter(cast);
  const id = 'cast_aaaa0000000000000000000000000001';
  try {
    assert.ok(reg.get(id)!.capabilities.includes('pause'));
    await reg.command(id, { on: true, media: 'Tarateel' }, { kind: 'user', label: 'You' });
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
  const reg = new Registry(new Store(':memory:'), n => (n === 'Tarateel' ? 'https://stream.example/tarateel.mp3' : undefined));
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
    await reg.command('group_kids', { on: true, media: 'Tarateel', vol: 20 }, { kind: 'user', label: 'You' });
    assert.equal(g.loads(), 1, 'one LOAD on the Cast group');
    assert.equal(a.loads() + b.loads(), 0, 'not on each speaker separately');
    assert.equal(reg.get('group_kids')!.state.media, 'Tarateel');
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
    assert.equal(q.data.repeatMode, 'REPEAT_SINGLE', 'plays again from the start, until stopped');
    assert.equal((q.data.items as { media: { streamType: string } }[])[0].media.streamType, 'BUFFERED');
    assert.equal(a.st.url, urls.Rain);
    await reg.command(id, { on: true, media: 'Radio' }, { kind: 'user', label: 'You' });
    assert.equal(a.log.filter(l => l.type === 'LOAD').length, 1, 'a stream is a plain LOAD');
    assert.equal(a.st.url, urls.Radio);
  } finally {
    await reg.stop();
    a.server.close();
  }
});

test('Finding speakers on another network: addresses, Cast devices by their info page, and groups on a high port', async () => {
  const { expandSubnet, findCastDevices, findCastGroups } = await import('../src/services/lan-find.ts');
  assert.equal(expandSubnet('10.10.30.0/24').length, 254);
  assert.deepEqual(expandSubnet('10.10.30.0/24').slice(0, 2), ['10.10.30.1', '10.10.30.2']);
  assert.deepEqual(expandSubnet('10.10.30.5'), ['10.10.30.5']);
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
