import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { AirPlayAdapter } from '../src/adapters/airplay.ts';
import { AirCastBridge, aircastConfig } from '../src/bridges/aircast.ts';

/** A fake OwnTone JSON API with two AirPlay outputs and one Chromecast output. */
function fakeOwnTone() {
  const outputs = [
    { id: '100', name: 'Apple TV', type: 'AirPlay 2', selected: false, volume: 40 },
    { id: '200', name: 'Kitchen HomePod', type: 'AirPlay 2', selected: false, volume: 30 },
    { id: '300', name: 'Nest Audio', type: 'Chromecast', selected: false, volume: 20 },
  ];
  const st = { state: 'stop', queue: [] as string[] };
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      calls.push(`${req.method} ${u.pathname}`);
      const j = body ? JSON.parse(body) : {};
      const send = (x: unknown = {}) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(x)); };
      if (req.method === 'GET' && u.pathname === '/api/outputs') return send({ outputs });
      if (req.method === 'GET' && u.pathname === '/api/player') return send({ state: st.state });
      if (req.method === 'PUT' && u.pathname === '/api/outputs/set') { outputs.forEach(o => (o.selected = j.outputs.includes(o.id))); return send(); }
      const m = u.pathname.match(/^\/api\/outputs\/(\d+)$/);
      if (req.method === 'PUT' && m) { Object.assign(outputs.find(o => o.id === m[1])!, j); return send(); }
      if (req.method === 'POST' && u.pathname === '/api/queue/items/add') { if (u.searchParams.get('clear') === 'true') st.queue = []; st.queue.push(u.searchParams.get('uris')!); if (u.searchParams.get('playback') === 'start') st.state = 'play'; return send({ count: 1 }); }
      if (req.method === 'PUT' && u.pathname === '/api/player/stop') { st.state = 'stop'; return send(); }
      res.statusCode = 404; res.end();
    });
  });
  return { server, outputs, st, calls };
}

test('AirPlay: announces AirPlay outputs, plays in sync, joins, stops', async () => {
  const f = fakeOwnTone();
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  const reg = new Registry(new Store(':memory:'), n => ({ 'Rain sounds': 'http://s/rain.mp3', Radio: 'http://s/radio.mp3' } as Record<string, string>)[n]);
  await reg.addAdapter(new AirPlayAdapter({ url, pollMs: 0, batchMs: 20, rooms: { 'Apple TV': 'lounge' }, ids: { 'Kitchen HomePod': 'kitchen_homepod' } }));
  try {
    assert.deepEqual(reg.list().map(d => d.id).sort(), ['airplay_100', 'kitchen_homepod'], 'only AirPlay outputs, with configured ids');
    assert.equal(reg.get('airplay_100')!.type, 'tv');
    assert.equal(reg.get('airplay_100')!.room, 'lounge');

    await reg.applyTargets({ airplay_100: { on: true, media: 'Rain sounds', vol: 25 }, kitchen_homepod: { on: true, media: 'Rain sounds' } }, { kind: 'moment', label: 'Rain' });
    assert.equal(f.st.state, 'play');
    assert.deepEqual(f.st.queue, ['http://s/rain.mp3']);
    assert.deepEqual(f.outputs.filter(o => o.selected).map(o => o.id), ['100', '200']);
    assert.equal(f.outputs[0].volume, 25);

    // A different source while both play elsewhere: refused with a clear message.
    await reg.command('kitchen_homepod', { on: false, media: null }, { kind: 'user', label: 'You' });
    await assert.rejects(reg.command('kitchen_homepod', { on: true, media: 'Radio' }, { kind: 'user', label: 'You' }), /one source at a time/);
    // The same source joins the running stream.
    await reg.command('kitchen_homepod', { on: true, media: 'Rain sounds' }, { kind: 'user', label: 'You' });
    assert.equal(f.outputs[1].selected, true);
    assert.equal(f.st.queue.length, 1, 'no restart when joining');

    await reg.applyTargets({ airplay_100: { on: false, media: null }, kitchen_homepod: { on: false, media: null } }, { kind: 'user', label: 'You' });
    assert.equal(f.st.state, 'stop');
  } finally { await reg.stop(); f.server.close(); }
});

test('AirCast: writes its config, runs aircast, restarts it when it dies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aircast-'));
  // A stand-in for the aircast binary: records its arguments, exits the first time.
  const bin = join(dir, 'fake-aircast');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${dir}/args"\nif [ ! -f "${dir}/ran" ]; then touch "${dir}/ran"; echo "boom" >&2; exit 3; fi\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  const b = new AirCastBridge({ binary: bin, workDir: join(dir, 'work'), bind: 'eth0', exclude: ['Bedroom Oled'], restartMs: 50 });
  b.start();
  try {
    const cfg = readFileSync(join(dir, 'work', 'aircast.xml'), 'utf8');
    assert.match(cfg, /<codec>flac<\/codec>/);
    assert.match(cfg, /<name>Bedroom Oled<\/name><enabled>0<\/enabled>/);
    for (let i = 0; i < 100 && !(b.running && b.restarts > 0); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(b.restarts, 1);
    assert.equal(b.running, true);
    const lines = () => readFileSync(join(dir, 'args'), 'utf8').trim().split('\n');
    for (let i = 0; i < 100 && lines().length < 2; i++) await new Promise(r => setTimeout(r, 20));
    const args = lines();
    assert.equal(args.length, 2);
    assert.equal(args[0], `-Z -x ${join(dir, 'work', 'aircast.xml')} -b eth0`);
  } finally { await b.stop(); }
  assert.equal(b.running, false);
  assert.ok(existsSync(join(dir, 'ran')));
});

test('AirCast config escapes names', () => {
  assert.match(aircastConfig({ binary: 'x', workDir: '/tmp', exclude: ['A & B <1>'] }), /A &amp; B &lt;1&gt;/);
});
