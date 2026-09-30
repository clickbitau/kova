import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { SonosAdapter } from '../src/adapters/sonos.ts';

/** A fake Sonos speaker that speaks enough UPnP for the adapter. */
function fakeSonos() {
  const calls: { action: string; body: string }[] = [];
  const st = { state: 'STOPPED', vol: 20 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/xml/device_description.xml') {
        res.end('<root><device><UDN>uuid:RINCON_ABC123</UDN><roomName>Living Room</roomName><displayName>Era 100</displayName></device></root>');
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
  assert.deepEqual(actions.slice(-4), ['SetVolume', 'BecomeCoordinatorOfStandaloneGroup', 'SetAVTransportURI', 'Play']);
  assert.match(fake.calls.find(c => c.action === 'SetAVTransportURI')!.body, /x-rincon-mp3radio:\/\/radio\.example\/jazz\.mp3/);
  assert.equal(fake.st.vol, 25);
  assert.equal(reg.get(d.id)!.state.media, 'Jazz stream');

  await reg.command(d.id, { on: false, media: null }, { kind: 'user', label: 'You' });
  assert.equal(fake.st.state, 'PAUSED_PLAYBACK');

  await assert.rejects(reg.command(d.id, { on: true, media: 'Unknown' }, { kind: 'user', label: 'You' }), /No stream URL/);
  await reg.stop();
  fake.server.close();
});
