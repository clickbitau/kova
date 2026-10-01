import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { HelixMusic, shuffled } from '../src/services/helix-music.ts';
import { CastAdapter, CAST_WINDOW } from '../src/adapters/cast/index.ts';
import { SonosAdapter } from '../src/adapters/sonos.ts';
import { encodeMessage, decodeMessage, NS } from '../src/adapters/cast/channel.ts';

const TOKEN = 'hxd_' + 'm'.repeat(64);
const you = { kind: 'user' as const, label: 'You' };
const until = async (what: string, ok: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms && !ok(); i += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};
/** A random that walks a fixed sequence, so shuffles are repeatable. */
const seq = () => { let i = 0; return () => ((i++ * 7919) % 1000) / 1000; };

const track = (n: number, o: Record<string, unknown> = {}) => ({
  id: `helix:t${n}`, title: `Song ${n}`, artist: n % 2 ? 'Arnob' : 'Coke Studio', album: `Album ${n % 3}`, posterUrl: `/v1/images/p${n}?kind=poster`,
  durationMs: 200_000 + n, hasFile: true, codec: n === 3 ? 'mp3' : 'flac', loved: n <= 3, ...o,
});

/** Helix Server's music routes, as far as Kova uses them. */
async function fakeHelix(n = 60, o: { modern?: boolean } = {}) {
  const lib = Array.from({ length: n }, (_, i) => track(i + 1));
  const seen: string[] = [];
  const played: { id: string; body: any }[] = [];
  const signed: { id: string; body: any }[] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    const p = u.pathname;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        // An older Helix has neither route: Go's mux answers a plain-text 404.
        if (!o.modern) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404 page not found'); return; }
        const pu = /^\/v1\/items\/([^/]+)\/play-url$/.exec(p);
        if (pu) { signed.push({ id: pu[1], body }); return send(200, { url: `${base}/v1/play/${pu[1]}?sig=abc${pu[1]}`, path: `/v1/play/${pu[1]}?sig=abc${pu[1]}`, expiresAt: '2026-10-01T09:00:00Z', format: body.format, maxRate: body.maxRate }); }
        const pl = /^\/v1\/music\/tracks\/([^/]+)\/played$/.exec(p);
        if (pl) { played.push({ id: pl[1], body }); return send(200, { ok: true, counted: true, duplicate: false }); }
        send(404, { error: 'not found' });
      });
      return;
    }
    assert.equal(u.searchParams.get('profile'), 'default');
    if (p === '/v1/playlists') return send(200, { playlists: [{ id: 'pl1', title: 'Bangla Collection', kind: 'music', tracks: 4 }, { id: 'pl2', title: 'Movies to watch', kind: 'video' }] });
    if (p === '/v1/playlists/pl1') return send(200, { playlist: { id: 'pl1', title: 'Bangla Collection' }, tracks: [lib[4], lib[5], { ...track(99), hasFile: false, streamable: false }, lib[6], lib[4]] });
    if (p === '/v1/music/tracks') {
      const q = u.searchParams;
      if (q.get('loved') === '1') return send(200, { tracks: lib.filter(t => t.loved) });
      if (q.get('ids')) return send(200, { tracks: lib.filter(t => t.id === q.get('ids')) });
      if (q.get('artist')) return send(200, { tracks: lib.filter(t => t.artist === 'Coke Studio') });
      const off = Number(q.get('offset') ?? 0), lim = Number(q.get('limit') ?? 200);
      // A current Helix shuffles the whole library itself.
      if (q.get('shuffle') === '1' && o.modern) return send(200, { tracks: [...lib].reverse().slice(off, off + lim), total: lib.length, offset: off, limit: lim, nextOffset: null, seed: 'S1' });
      return send(200, { tracks: lib.slice(off, off + lim) });
    }
    if (p === '/v1/music/siri') {
      const name = (u.searchParams.get('name') ?? '').toLowerCase();
      if (name.includes('bangla')) return send(200, { kind: 'playlist', id: 'pl1', title: 'Bangla Collection' });
      if (name.includes('loved')) return send(200, { kind: 'loved' });
      if (name.includes('coke studio')) return send(200, { kind: 'artist', id: 'helix:a1', title: 'Coke Studio' });
      if (name === 'music') return send(200, { kind: 'default' });
      return send(200, { kind: 'none' });
    }
    if (p === '/v1/music/mix') return send(200, { title: 'Coke Studio mix', tracks: lib.filter(t => t.artist === 'Arnob').slice(0, 9) });
    send(404, { error: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = url;
  return { url, seen, lib, played, signed, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('Helix music: Shuffle all, Loved and playlists, as songs a speaker can fetch by itself', async () => {
  const h = await fakeHelix(2500);
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  try {
    assert.deepEqual((await music.catalog()).map(i => i.name), ['Shuffle all', 'Loved', 'Bangla Collection']);
    assert.ok(music.isMusic('Bangla Collection') && music.isMusic('loved') && music.isMusic('Station: Coke Studio'));
    assert.equal(music.isMusic('Radio Foorti'), false);

    // A playlist in order: songs it can't play and repeats are left out; each song is the AAC stream with Kova's token.
    const pl = (await music.queueFor('Bangla Collection'))!;
    assert.equal(pl.shuffle, false);
    assert.deepEqual(pl.tracks.map(t => t.title), ['Song 5', 'Song 6', 'Song 7']);
    assert.deepEqual(pl.tracks[0], {
      id: 'helix:t5', url: `${h.url}/v1/music/tracks/t5/stream?max=aac&token=${TOKEN}`, contentType: 'audio/mp4',
      title: 'Song 5', artist: 'Arnob', album: 'Album 2', art: `${h.url}/v1/images/p5?kind=poster&w=600&token=${TOKEN}`, durationMs: 200_005,
    });
    // An MP3 passes through as MP3.
    assert.equal((await music.queueFor('Loved'))!.tracks.find(t => t.id === 'helix:t3')!.contentType, 'audio/mpeg');

    // Shuffle all: every page of the library, shuffled; the same request again a moment later gets the same order (a group's speakers).
    const all = (await music.queueFor('Shuffle all'))!;
    assert.equal(all.tracks.length, 2500);
    assert.equal(all.shuffle, true);
    assert.notDeepEqual(all.tracks.slice(0, 5).map(t => t.id), h.lib.slice(0, 5).map(t => t.id));
    assert.ok(h.seen.some(s => s.startsWith('GET /v1/music/tracks?limit=2000&offset=2000')));
    assert.equal(await music.queueFor('Shuffle all'), all);
    // A playlist on shuffle: the same songs, another order.
    const shuf = (await music.queueFor('Bangla Collection', { shuffle: true }))!;
    assert.deepEqual(shuf.tracks.map(t => t.title).sort(), ['Song 5', 'Song 6', 'Song 7']);
    assert.equal(shuf.shuffle, true);

    // What someone says → the name to play, by Helix's own rule.
    assert.deepEqual(await music.find('bangla collection'), { media: 'Bangla Collection', kind: 'playlist' });
    assert.deepEqual(await music.find('my loved songs'), { media: 'Loved', kind: 'loved' });
    assert.deepEqual(await music.find('music'), { media: 'Shuffle all', kind: 'all' });
    assert.deepEqual(await music.find('coke studio'), { media: 'Artist: Coke Studio', kind: 'artist' });
    assert.deepEqual(await music.find('coke studio', { station: true }), { media: 'Station: Coke Studio', kind: 'station' });
    assert.equal(await music.find('nothing at all'), null);
    // A station: Helix's mix (other artists) with some of the artist's own songs, shuffled.
    const st = (await music.queueFor('Station: Coke Studio'))!;
    assert.ok(st.tracks.some(t => t.artist === 'Arnob') && st.tracks.some(t => t.artist === 'Coke Studio'));
    assert.equal(st.shuffle, true);
    // Not paired with Helix: no music.
    assert.deepEqual(await new HelixMusic(() => undefined).catalog(), []);
  } finally {
    await h.close();
  }
});

test('shuffled is a permutation', () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  const b = shuffled(a, seq());
  assert.deepEqual([...b].sort((x, y) => x - y), a);
  assert.notDeepEqual(b, a);
});

/** A Cast receiver whose default media receiver plays a queue: QUEUE_LOAD, QUEUE_INSERT, QUEUE_UPDATE jumps, MEDIA_STATUS. */
function fakeCast(members: string[] = []) {
  const st = {
    app: null as null | { appId: string; sessionId: string; transportId: string }, level: 0.3,
    items: [] as { itemId: number; customData: { kova: number }; media: { contentId: string; contentType: string; metadata: { title: string; artist?: string; images?: { url: string }[] }; customData: { kova: number } } }[],
    current: 0, log: [] as string[], socks: new Set<net.Socket>(),
  };
  let nextId = 1;
  const server = net.createServer(sock => {
    st.socks.add(sock);
    let buf = Buffer.alloc(0);
    const send = (namespace: string, source: string, data: Record<string, unknown>) => sock.write(encodeMessage({ source, destination: 'sender-0', namespace, data }));
    const mediaStatus = (requestId?: unknown) => {
      const cur = st.items.find(i => i.itemId === st.current);
      return { type: 'MEDIA_STATUS', ...(requestId != null ? { requestId } : {}), status: cur ? [{ mediaSessionId: 7, playerState: 'PLAYING', currentItemId: cur.itemId, currentTime: 12, media: cur.media, items: st.items.map(i => ({ itemId: i.itemId, customData: i.customData })) }] : [] };
    };
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const m = decodeMessage(buf.subarray(4, 4 + buf.readUInt32BE(0)));
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        const type = String(m.data.type);
        const rid = m.data.requestId;
        if (type !== 'PING' && type !== 'GET_STATUS') st.log.push(type);
        if (m.namespace === NS.receiver) {
          if (type === 'LAUNCH') st.app = { appId: String(m.data.appId), sessionId: 'sess-1', transportId: 'web-1' };
          if (type === 'STOP') { st.app = null; st.items = []; }
          if (type === 'SET_VOLUME') { const v = m.data.volume as { level?: number }; if (v.level != null) st.level = v.level; }
          send(NS.receiver, 'receiver-0', { type: 'RECEIVER_STATUS', requestId: rid, status: { volume: { level: st.level, muted: false }, applications: st.app ? [st.app] : [] } });
        } else if (m.namespace === NS.media) {
          if (type === 'QUEUE_LOAD') {
            st.items = (m.data.items as typeof st.items).map(i => ({ ...i, itemId: nextId++ }));
            st.current = st.items[Number(m.data.startIndex ?? 0)].itemId;
          }
          if (type === 'QUEUE_INSERT') st.items.push(...(m.data.items as typeof st.items).map(i => ({ ...i, itemId: nextId++ })));
          if (type === 'QUEUE_UPDATE' && m.data.jump) {
            const at = st.items.findIndex(i => i.itemId === st.current) + Number(m.data.jump);
            st.current = st.items[Math.max(0, Math.min(st.items.length - 1, at))].itemId;
          }
          send(NS.media, 'web-1', mediaStatus(rid));
        } else if (m.namespace === NS.multizone) {
          send(NS.multizone, 'receiver-0', { type: 'MULTIZONE_STATUS', requestId: rid, status: { devices: members.map(id => ({ deviceId: id, name: id })) } });
        }
      }
    });
    sock.on('close', () => st.socks.delete(sock));
  });
  /** The speaker moves to the next song by itself and says so (unsolicited MEDIA_STATUS). */
  const advance = () => {
    const at = st.items.findIndex(i => i.itemId === st.current) + 1;
    st.current = st.items[at].itemId;
    const cur = st.items[at];
    for (const s of st.socks) s.write(encodeMessage({ source: 'web-1', destination: '*', namespace: NS.media, data: { type: 'MEDIA_STATUS', status: [{ mediaSessionId: 7, playerState: 'PLAYING', currentItemId: cur.itemId, media: cur.media }] } }));
  };
  return { server, st, advance, titles: () => st.items.map(i => i.media.metadata.title), now: () => st.items.find(i => i.itemId === st.current)?.media.metadata.title };
}

async function listen(server: net.Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

test('Cast: Helix music plays as a queue; next and previous; the song shows; more songs are added as it plays; shuffle on and off', { timeout: 30_000 }, async () => {
  const h = await fakeHelix(60);
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  const kitchen = fakeCast();
  const reg = new Registry(new Store(':memory:'), name => name === 'Radio' ? 'http://radio.example/live.mp3' : undefined);
  reg.queues = (m, o) => music.queueFor(m, o);
  reg.isMusic = m => music.isMusic(m);
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 10, endpoints: [{ id: 'k1', name: 'Kitchen speaker', model: 'Nest Audio', host: '127.0.0.1', port: await listen(kitchen.server) }] });
  try {
    await reg.addAdapter(cast);
    await music.catalog();
    const d = () => reg.get('cast_k1')!;
    assert.ok(d().capabilities.includes('queue'));

    // A playlist, in order: one QUEUE_LOAD with the songs and their titles, artists and covers.
    await reg.command('cast_k1', { on: true, media: 'Bangla Collection' }, you);
    assert.deepEqual(kitchen.titles(), ['Song 5', 'Song 6', 'Song 7']);
    const item = kitchen.st.items[0].media;
    assert.equal(item.contentType, 'audio/mp4');
    assert.match(item.contentId, /\/v1\/music\/tracks\/t5\/stream\?max=aac&token=hxd_/);
    assert.equal(item.metadata.images?.[0].url, `${h.url}/v1/images/p5?kind=poster&w=600&token=${TOKEN}`);
    assert.deepEqual({ media: d().state.media, track: d().state.track?.title, artist: d().state.track?.artist, shuffle: d().state.shuffle }, { media: 'Bangla Collection', track: 'Song 5', artist: 'Arnob', shuffle: false });

    // The speaker moves on by itself: Kova follows. Next and previous: the speaker jumps.
    kitchen.advance();
    await until('Song 6', () => d().state.track?.title === 'Song 6');
    await reg.command('cast_k1', { skip: 1 }, you);
    assert.equal(kitchen.now(), 'Song 7');
    assert.equal(d().state.track?.title, 'Song 7');
    assert.equal((d().state as Record<string, unknown>).skip, undefined, 'a skip is not kept as state');
    await reg.command('cast_k1', { skip: -1 }, you);
    assert.equal(kitchen.now(), 'Song 6');
    await assert.rejects(reg.command('cast_k1', { skip: 1 }, you).then(() => reg.command('cast_k1', { skip: 1 }, you)), /last song/);

    // Shuffle all: the speaker holds CAST_WINDOW songs; nearing the end of them, Kova adds the next ones.
    await reg.command('cast_k1', { media: 'Shuffle all' }, you);
    assert.equal(kitchen.st.items.length, CAST_WINDOW);
    assert.equal(d().state.shuffle, true);
    for (let i = 0; i < CAST_WINDOW - 3; i++) kitchen.advance();
    await until('topped up', () => kitchen.st.items.length === CAST_WINDOW * 2);
    assert.equal(kitchen.st.log.filter(t => t === 'QUEUE_INSERT').length, 1);

    // Shuffle on a playlist that's playing in order: the same song carries on, the rest is reshuffled.
    await reg.command('cast_k1', { media: 'Bangla Collection' }, you);
    kitchen.advance();
    await until('Song 6 again', () => d().state.track?.title === 'Song 6');
    await reg.command('cast_k1', { shuffle: true }, you);
    assert.equal(kitchen.titles()[0], 'Song 6');
    assert.deepEqual(kitchen.titles().slice().sort(), ['Song 5', 'Song 6', 'Song 7']);
    assert.equal(d().state.shuffle, true);
    // A radio source still plays as one stream, and the song goes away.
    await reg.command('cast_k1', { media: 'Radio' }, you);
    assert.equal(kitchen.st.log.at(-1), 'LOAD');
    await cast['poll']();
    assert.equal(d().state.track, null);
  } finally {
    await reg.stop();
    kitchen.server.close();
    await h.close();
  }
});

test('Cast group: two speakers play one queue through their Cast group, and both show the song', { timeout: 20_000 }, async () => {
  const h = await fakeHelix(20);
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  const a = fakeCast(), b = fakeCast(), g = fakeCast(['a1', 'b1']);
  const reg = new Registry(new Store(':memory:'));
  reg.queues = (m, o) => music.queueFor(m, o);
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 20, endpoints: [
      { id: 'a1', name: 'Kitchen', model: 'Nest Audio', host: '127.0.0.1', port: await listen(a.server) },
      { id: 'b1', name: 'Lounge', model: 'Nest Audio', host: '127.0.0.1', port: await listen(b.server) },
      { id: 'g1', name: 'Downstairs', model: 'Google Cast Group', host: '127.0.0.1', port: await listen(g.server) },
    ],
  });
  try {
    await reg.addAdapter(cast);
    await Promise.all(['cast_a1', 'cast_b1'].map(id => reg.command(id, { on: true, media: 'Loved', shuffle: true }, you)));
    assert.equal(g.st.log.filter(t => t === 'QUEUE_LOAD').length, 1);
    assert.equal(a.st.log.filter(t => t === 'QUEUE_LOAD').length + b.st.log.filter(t => t === 'QUEUE_LOAD').length, 0);
    const first = g.now();
    assert.equal(reg.get('cast_a1')!.state.track?.title, first);
    assert.equal(reg.get('cast_b1')!.state.track?.title, first);
    // Next from both speakers at once (a Kova group does that): the group skips once.
    await Promise.all(['cast_a1', 'cast_b1'].map(id => reg.command(id, { skip: 1 }, you)));
    assert.equal(g.st.log.filter(t => t === 'QUEUE_UPDATE').length, 1);
    assert.notEqual(g.now(), first);
    assert.equal(reg.get('cast_b1')!.state.track?.title, g.now());
  } finally {
    await reg.stop();
    for (const f of [a, b, g]) f.server.close();
    await h.close();
  }
});

/** A Sonos speaker with a queue: AddURIToQueue, x-rincon-queue, Seek, Next/Previous, GetPositionInfo. */
function fakeSonos() {
  const st = { state: 'STOPPED', vol: 20, queue: [] as { uri: string; title: string }[], track: 1, uri: '', calls: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url === '/xml/device_description.xml') { res.end('<root><device><UDN>uuid:RINCON_ABC123</UDN><roomName>Living Room</roomName><displayName>Era 100</displayName></device></root>'); return; }
      const action = String(req.headers.soapaction).split('#')[1].replace('"', '');
      st.calls.push(action);
      const arg = (n: string) => body.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? '';
      const un = (x: string) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      let inner = '';
      if (action === 'Play') st.state = 'PLAYING';
      if (action === 'Pause' || action === 'Stop') st.state = 'PAUSED_PLAYBACK';
      if (action === 'RemoveAllTracksFromQueue') st.queue = [];
      if (action === 'AddURIToQueue') st.queue.push({ uri: un(arg('EnqueuedURI')), title: un(arg('EnqueuedURIMetaData')).match(/<dc:title>([^<]*)</)?.[1] ?? '' });
      if (action === 'SetAVTransportURI') st.uri = un(arg('CurrentURI'));
      if (action === 'Seek' && arg('Unit') === 'TRACK_NR') st.track = Number(arg('Target'));
      if (action === 'Next') st.track++;
      if (action === 'Previous') st.track--;
      if (action === 'GetTransportInfo') inner = `<CurrentTransportState>${st.state}</CurrentTransportState>`;
      if (action === 'GetVolume') inner = `<CurrentVolume>${st.vol}</CurrentVolume>`;
      if (action === 'GetPositionInfo') inner = `<Track>${st.track}</Track><RelTime>0:01:05</RelTime>`;
      res.setHeader('content-type', 'text/xml');
      res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return { server, st, now: () => st.queue[st.track - 1]?.title };
}

test('Sonos: Helix music plays from the speaker’s own queue, with titles; next and previous; Kova follows it', { timeout: 20_000 }, async () => {
  const h = await fakeHelix(80);
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  const sonos = fakeSonos();
  await new Promise<void>(r => sonos.server.listen(0, '127.0.0.1', r));
  const reg = new Registry(new Store(':memory:'));
  reg.queues = (m, o) => music.queueFor(m, o);
  const adapter = new SonosAdapter({ hosts: [`127.0.0.1:${(sonos.server.address() as AddressInfo).port}`], discover: false, pollMs: 0 });
  try {
    await reg.addAdapter(adapter);
    const id = 'sonos_abc123';
    await reg.command(id, { on: true, media: 'Shuffle all' }, you);
    assert.equal(sonos.st.queue.length, 50);
    assert.equal(sonos.st.uri, 'x-rincon-queue:RINCON_ABC123#0');
    assert.match(sonos.st.queue[0].uri, /\/stream\?max=aac&token=hxd_/);
    assert.equal(reg.get(id)!.state.track?.title, sonos.now());
    await reg.command(id, { skip: 1 }, you);
    assert.equal(reg.get(id)!.state.track?.title, sonos.now());
    assert.equal(sonos.st.track, 2);
    // The speaker moves on by itself: Kova reads where it is, and adds more before it runs out.
    sonos.st.track = 47;
    await adapter['poll']();
    assert.equal(reg.get(id)!.state.track?.title, sonos.now());
    assert.equal(sonos.st.queue.length, 80);
    // Previous from the first song of the speaker's queue reloads from the song before.
    await reg.command(id, { media: 'Bangla Collection' }, you);
    assert.deepEqual(sonos.st.queue.map(q => q.title), ['Song 5', 'Song 6', 'Song 7']);
    await reg.command(id, { skip: -1 }, you);
    assert.equal(sonos.now(), 'Song 5');
    // Stopping ends the queue and the song.
    await reg.command(id, { on: false, media: null }, you);
    sonos.st.state = 'STOPPED';
    await adapter['poll']();
    assert.equal(reg.get(id)!.state.track, null);
  } finally {
    await reg.stop();
    sonos.server.close();
    await h.close();
  }
});

test('Ask: “play Bangla Collection on shuffle in the kitchen”, next song, what’s playing, stations', { timeout: 30_000 }, async () => {
  const { testHub } = await import('./helpers.ts');
  const h = await fakeHelix(40);
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  const kitchen = fakeCast(), lounge = fakeCast();
  const t = await testHub(19);
  t.hub.useMusic(music);
  const cast = new CastAdapter({
    discover: false, insecure: true, pollMs: 0, batchMs: 10, rooms: { 'Kitchen speaker': 'kitchen', 'Lounge speaker': 'lounge' },
    endpoints: [
      { id: 'k1', name: 'Kitchen speaker', model: 'Nest Audio', host: '127.0.0.1', port: await listen(kitchen.server) },
      { id: 'l1', name: 'Lounge speaker', model: 'Nest Audio', host: '127.0.0.1', port: await listen(lounge.server) },
    ],
  });
  const a = t.hub.assistant;
  try {
    await t.hub.reg.addAdapter(cast);
    await music.catalog();
    // Understood: the playlist, on shuffle, in the kitchen.
    const q = 'play Bangla Collection on shuffle in the kitchen';
    assert.deepEqual(a.chips(a.parse(q)), ['Play', '“bangla collection” on shuffle', 'Kitchen']);
    const r = await a.ask(q);
    assert.equal(r.source, 'Helix');
    assert.match(r.text, /^Playing Bangla Collection on shuffle in Kitchen: Song \d by \w/);
    assert.deepEqual(kitchen.titles().slice().sort(), ['Song 5', 'Song 6', 'Song 7']);
    assert.equal(lounge.st.items.length, 0);
    assert.deepEqual({ media: t.dev('cast_k1').media, shuffle: t.dev('cast_k1').shuffle }, { media: 'Bangla Collection', shuffle: true });
    assert.ok(r.undo);

    // Next song, without saying where (one speaker is playing).
    const before = kitchen.now();
    const n = await a.ask('next song');
    assert.notEqual(kitchen.now(), before);
    assert.equal(n.text, `Next: ${kitchen.now()} by ${t.dev('cast_k1').track!.artist}.`);
    assert.deepEqual(a.chips(a.parse('previous song in the kitchen')), ['Previous song', 'Kitchen']);
    await a.ask('previous song in the kitchen');
    assert.equal(kitchen.now(), before);
    // What's playing.
    assert.match((await a.ask('what’s playing?')).text, new RegExp(`^Kitchen speaker: ${before} by \\w[\\w ]* \\(Bangla Collection\\)\\.$`));

    // A station, everything, loved, and something Helix doesn't have.
    assert.match((await a.ask('play a station from Coke Studio in the lounge')).text, /^Playing a station from Coke Studio in Lounge: /);
    assert.equal(t.dev('cast_l1').media, 'Station: Coke Studio');
    assert.match((await a.ask('play music in the kitchen')).text, /^Playing all your music in Kitchen: /);
    assert.equal(t.dev('cast_k1').media, 'Shuffle all');
    assert.match((await a.ask('play my loved songs in the lounge')).text, /^Playing your loved songs in Lounge: /);
    assert.equal((await a.ask('play zzz qqq in the kitchen')).text, 'Helix has nothing called “zzz qqq”.');
    // Both speakers are playing now: "what's playing" names each; "next song" without a room skips both.
    assert.match((await a.ask('what song is this')).text, /^Kitchen speaker: .*\. Lounge speaker: .*\.$/);
    assert.equal((a.parse('next song') as { devices: string[] }).devices.length, 2);
    // Nothing says where, and nothing is playing: Kova asks.
    await t.hub.engine.command('cast_k1', { on: false, media: null });
    await t.hub.engine.command('cast_l1', { on: false, media: null });
    await cast['poll']();
    assert.match((await a.ask('play Bangla Collection')).text, /^Where should I play “bangla collection”\?/);
    // A film still goes to the TV box, not the speakers ("play the office in the lounge" in helix.test.ts).
    assert.equal(a.parse('watch dune in the lounge')?.kind === 'music', false);
  } finally {
    await t.hub.stop();
    kitchen.server.close();
    lounge.server.close();
    await h.close();
  }
});

test('Current Helix: speakers get signed song URLs with no token, a window at a time; Shuffle all is Helix’s own shuffle; plays are counted', { timeout: 30_000 }, async () => {
  const { testHub } = await import('./helpers.ts');
  const h = await fakeHelix(60, { modern: true });
  const music = new HelixMusic(() => ({ url: h.url, token: TOKEN }), { random: seq() });
  const kitchen = fakeCast();
  const t = await testHub(19);
  t.hub.useMusic(music);
  const cast = new CastAdapter({ discover: false, insecure: true, pollMs: 0, batchMs: 10, rooms: { 'Kitchen speaker': 'kitchen' },
    endpoints: [{ id: 'k1', name: 'Kitchen speaker', model: 'Nest Audio', host: '127.0.0.1', port: await listen(kitchen.server) }] });
  try {
    await t.hub.reg.addAdapter(cast);
    await t.hub.engine.command('cast_k1', { on: true, media: 'Shuffle all' });
    // Helix shuffled the library itself (one call, no paging).
    assert.ok(h.seen.some(x => x.startsWith('GET /v1/music/tracks?shuffle=1&limit=1000')));
    assert.ok(!h.seen.some(x => x.includes('offset=2000')));
    assert.equal(kitchen.titles()[0], 'Song 60');
    assert.equal(t.dev('cast_k1').shuffle, true);
    // Only the songs the speaker holds were signed, as AAC at 48 kHz; no token reaches the speaker.
    assert.equal(h.signed.length, CAST_WINDOW);
    assert.deepEqual(h.signed[0].body, { format: 'aac', maxRate: 48000, ttl: 21600, profile: 'default' });
    const first = kitchen.st.items[0].media;
    assert.equal(first.contentId, `${h.url}/v1/play/t60?sig=abct60`);
    assert.equal(first.contentType, 'audio/aac');
    assert.ok(kitchen.st.items.every(i => !i.media.contentId.includes('token=')));
    // Nearing the end of the window, the next songs are signed and added.
    for (let i = 0; i < CAST_WINDOW - 3; i++) kitchen.advance();
    await until('topped up', () => kitchen.st.items.length === CAST_WINDOW * 2);
    assert.equal(h.signed.length, CAST_WINDOW * 2);
    assert.ok(kitchen.st.items.every(i => !i.media.contentId.includes('token=')));
    // Each song the speaker started counts as played in Helix, under the speaker's name.
    await until('plays counted', () => h.played.length >= CAST_WINDOW - 2);
    assert.deepEqual({ id: h.played[0].id, player: h.played[0].body.player, profile: h.played[0].body.profileId }, { id: 't60', player: 'Kitchen speaker', profile: 'default' });
    // …and quietly: songs changing aren't Activity entries.
    const songs = t.hub.store.feed(100).filter(e => e.device === 'cast_k1' && e.cause.kind === 'device' && (e.data.patch as { track?: unknown } | undefined)?.track);
    assert.deepEqual(songs.map(e => e.what), []);
  } finally {
    await t.hub.stop();
    kitchen.server.close();
    await h.close();
  }
});
