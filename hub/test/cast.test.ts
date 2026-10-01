import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { CastAdapter } from '../src/adapters/cast/index.ts';
import { encodeMessage, decodeMessage, NS } from '../src/adapters/cast/channel.ts';

/** A fake Cast receiver: enough of receiver, media and multizone to drive the adapter. */
function fakeCast(name: string, members: string[] = []) {
  const log: { ns: string; type: string; data: Record<string, unknown> }[] = [];
  const st = { app: null as null | { appId: string; sessionId: string; transportId: string }, level: 0.3, muted: false, url: '', paused: false };
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
        } else if (m.namespace === NS.media && type === 'LOAD') {
          st.url = String((m.data.media as { contentId: string }).contentId);
          st.paused = false;
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: [{ mediaSessionId: 7, playerState: 'PLAYING' }] } });
        } else if (m.namespace === NS.media && (type === 'GET_STATUS' || type === 'PAUSE' || type === 'PLAY')) {
          if (type !== 'GET_STATUS') { assert.equal(m.data.mediaSessionId, 7); st.paused = type === 'PAUSE'; }
          reply({ source: 'web-1', namespace: NS.media, data: { type: 'MEDIA_STATUS', requestId: rid, status: st.app ? [{ mediaSessionId: 7, playerState: st.paused ? 'PAUSED' : 'PLAYING' }] : [] } });
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
