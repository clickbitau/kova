import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { SonosAdapter } from '../src/adapters/sonos.ts';

/** A fake Sonos speaker that speaks enough UPnP for the adapter. */
function fakeSonos(udn = 'RINCON_ABC123', room = 'Living Room') {
  const calls: { action: string; body: string }[] = [];
  const st = { state: 'STOPPED', vol: 20, t0: 0, track: 1 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/xml/device_description.xml') {
        res.end(`<root><device><UDN>uuid:${udn}</UDN><roomName>${room}</roomName><displayName>Era 100</displayName></device></root>`);
        return;
      }
      const action = String(req.headers.soapaction).split('#')[1].replace('"', '');
      calls.push({ action, body });
      let inner = '';
      if (action === 'Play') st.state = 'PLAYING';
      if (action === 'Pause' || action === 'Stop') st.state = 'PAUSED_PLAYBACK';
      if (action === 'SetVolume') st.vol = Number(body.match(/<DesiredVolume>(\d+)</)![1]);
      if (action === 'GetTransportInfo') inner = `<CurrentTransportState>${st.state}</CurrentTransportState>`;
      if (action === 'GetVolume') inner = `<CurrentVolume>${st.vol}</CurrentVolume>`;
      // Whole seconds only, as Sonos says them: from when it started (st.t0).
      if (action === 'GetPositionInfo') { const s = st.t0 ? Math.floor((Date.now() - st.t0) / 1000) : 0; inner = `<Track>${st.track}</Track><TrackDuration>0:03:00</TrackDuration><RelTime>0:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}</RelTime>`; }
      res.setHeader('content-type', 'text/xml');
      res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return { server, calls, st };
}

test('Sonos: finds a speaker, plays a source, sets volume, stops', async () => {
  const fake = fakeSonos();
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const store = new Store(':memory:');
  const reg = new Registry(store, name => (name === 'Jazz stream' ? 'http://radio.example/jazz.mp3' : undefined));
  const sonos = new SonosAdapter({ hosts: [host], discover: false, pollMs: 0 });
  await reg.addAdapter(sonos);

  const d = reg.get('sonos_abc123');
  assert.ok(d, 'speaker announced');
  assert.equal(d.room, 'living_room');
  assert.equal(d.state.vol, 20);
  assert.equal(d.state.on, false);

  await reg.command(d.id, { on: true, media: 'Jazz stream', vol: 25 }, { kind: 'user', label: 'You' });
  const actions = fake.calls.map(c => c.action);
  assert.deepEqual(actions.slice(-5), ['SetVolume', 'BecomeCoordinatorOfStandaloneGroup', 'SetAVTransportURI', 'SetPlayMode', 'Play']);
  assert.match(fake.calls.find(c => c.action === 'SetPlayMode')!.body, /NORMAL/, 'a stream plays once');
  assert.match(fake.calls.find(c => c.action === 'SetAVTransportURI')!.body, /x-rincon-mp3radio:\/\/radio\.example\/jazz\.mp3/);
  assert.equal(fake.st.vol, 25);
  assert.equal(reg.get(d.id)!.state.media, 'Jazz stream');

  await reg.command(d.id, { on: false, media: null }, { kind: 'user', label: 'You' });
  assert.equal(fake.st.state, 'PAUSED_PLAYBACK');

  // A recording set to repeat loops on the speaker.
  reg.sourceLoops = n => n === 'Jazz stream';
  await reg.command(d.id, { on: true, media: 'Jazz stream' }, { kind: 'user', label: 'You' });
  assert.match(fake.calls.filter(c => c.action === 'SetPlayMode').at(-1)!.body, /REPEAT_ONE/);
  reg.sourceLoops = () => false;
  await reg.command(d.id, { on: false, media: null }, { kind: 'user', label: 'You' });

  await assert.rejects(reg.command(d.id, { on: true, media: 'Unknown' }, { kind: 'user', label: 'You' }), /No stream URL/);
  await reg.stop();
  fake.server.close();
});

test('Sonos: speakers asked together are grouped (one plays, the others join it); its place to the tick; moves in whole seconds', async () => {
  const a = fakeSonos('RINCON_AAA111', 'Lounge'), b = fakeSonos('RINCON_BBB222', 'Office');
  for (const f of [a, b]) await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  const host = (f: ReturnType<typeof fakeSonos>) => `127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'));
  reg.queues = async () => ({ label: 'Loved', shuffle: false, tracks: [1, 2, 3].map(i => ({ id: `t${i}`, title: `Song ${i}`, url: `http://helix/${i}.flac`, contentType: 'audio/flac', durationMs: 180_000 })) });
  const sonos = new SonosAdapter({ hosts: [host(a), host(b)], discover: false, pollMs: 0 });
  await reg.addAdapter(sonos);
  try {
    assert.deepEqual(sonos.nativeGroups().map(n => [n.dynamic, n.members.sort()]), [[true, ['sonos_aaa111', 'sonos_bbb222']]]);
    const you = { kind: 'user' as const, label: 'You' };
    await reg.applyTargets({ sonos_aaa111: { on: true, media: 'Loved', vol: 20 }, sonos_bbb222: { on: true, media: 'Loved', vol: 30 } }, you);
    assert.ok(a.calls.some(c => c.action === 'AddURIToQueue'), 'the first plays the queue');
    assert.ok(!b.calls.some(c => c.action === 'AddURIToQueue'), 'the other doesn’t');
    assert.match(b.calls.find(c => c.action === 'SetAVTransportURI')!.body, /x-rincon:RINCON_AAA111/);
    assert.equal(b.st.vol, 30, 'each keeps its own volume');
    assert.equal(reg.get('sonos_bbb222')!.state.track?.title, 'Song 1');
    // Its place, read as the second ticks over.
    a.st.t0 = Date.now() - 4300;
    const p = await sonos.playbackPosition(reg.get('sonos_bbb222')!);
    assert.equal(p!.positionMs % 1000, 0);
    assert.equal(p!.seekStepMs, 1000);
    assert.ok(Math.abs(p!.at - p!.positionMs - a.st.t0) < 80, `started ${p!.at - p!.positionMs - a.st.t0} ms off`);
    await sonos.syncTo(reg.get('sonos_bbb222')!, { index: 0, positionMs: 7000 });
    assert.match(a.calls.filter(c => c.action === 'Seek').at(-1)!.body, /REL_TIME.*0:00:07/);
    await sonos.syncTo(reg.get('sonos_aaa111')!, { index: 2, positionMs: 0 });
    assert.match(a.calls.filter(c => c.action === 'Seek').at(-1)!.body, /TRACK_NR.*<Target>3</);
    // The follower stops: it leaves the group; the other plays on.
    await reg.command('sonos_bbb222', { on: false, media: null }, you);
    assert.equal(b.calls.at(-1)!.action, 'BecomeCoordinatorOfStandaloneGroup');
    assert.equal(a.st.state, 'PLAYING');
  } finally {
    await reg.stop();
    for (const f of [a, b]) f.server.close();
  }
});
