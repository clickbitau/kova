import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  allowGoogle, decodePlusCode, encodePlusCode, isGoogleHost, parseCoordinates, parseLocationText, parseMapsUrl, recoverPlusCode, resolveShortLink,
} from '../src/services/location-parse.ts';

// Public landmarks only.
const OPERA = { latitude: -33.856784, longitude: 151.215297 };
const near = (p: { latitude: number; longitude: number } | null | undefined, q: { latitude: number; longitude: number }, eps = 1e-4) =>
  assert.ok(p && Math.abs(p.latitude - q.latitude) < eps && Math.abs(p.longitude - q.longitude) < eps, `${JSON.stringify(p)} ≉ ${JSON.stringify(q)}`);
const pointOf = (text: string) => { const r = parseLocationText(text); assert.equal(r?.kind, 'point', `${text} → ${JSON.stringify(r)}`); return r as Extract<typeof r, { kind: 'point' }>; };

test('coordinates: decimal, with hemispheres, degrees-minutes-seconds and degrees-decimal-minutes', () => {
  const cases: [string, number, number][] = [
    ['-33.856784, 151.215297', -33.856784, 151.215297],
    ['-33.856784,151.215297', -33.856784, 151.215297],
    ['-33.856784 151.215297', -33.856784, 151.215297],
    ['  -33.856784 ,  151.215297  ', -33.856784, 151.215297],
    ['−33.856784, 151.215297', -33.856784, 151.215297],
    ['33.856784° S, 151.215297° E', -33.856784, 151.215297],
    ['33.856784 S 151.215297 E', -33.856784, 151.215297],
    ['33.856784S, 151.215297E', -33.856784, 151.215297],
    ['S 33.856784, E 151.215297', -33.856784, 151.215297],
    ['S33.856784 E151.215297', -33.856784, 151.215297],
    ['151.215297 E, 33.856784 S', -33.856784, 151.215297],
    [`33°51'24.4"S 151°12'55.1"E`, -33.856778, 151.215306],
    [`33° 51' 24.4" S, 151° 12' 55.1" E`, -33.856778, 151.215306],
    ['33°51′24.4″S 151°12′55.1″E', -33.856778, 151.215306],
    [`48°51'29.6"N 2°17'40.2"E`, 48.858222, 2.2945],
    [`40°41'21.4"N 74°02'40.2"W`, 40.689278, -74.044500],
    ['33° 51.407\' S 151° 12.918\' E', -33.856783, 151.2153],
    ['51.5007, -0.1246', 51.5007, -0.1246],
    ['0, 0', 0, 0],
    ['-33,856784 151,215297', -33.856784, 151.215297],
  ];
  for (const [t, la, lo] of cases) near(parseCoordinates(t), { latitude: la, longitude: lo });
  for (const t of ['91, 0', '0, 181', 'hello', '33 S 151 S', '33 E, 151 W', `33°61'0"S 151°0'0"E`, '-33 S, 151 E', '12', '1 2 3', 'Sydney NSW 2000']) assert.equal(parseCoordinates(t), null, t);
});

test('Google Maps addresses: the place’s own pin wins over the map’s centre', () => {
  // Place page: !3d/!4d is the marker; @ is where the screen looked (deliberately different here).
  const place = 'https://www.google.com/maps/place/Sydney+Opera+House/@-33.8500000,151.2000000,15z/data=!3m1!4b1!4m6!3m5!1s0x6b12ae665e892fdd:0x3133f8d75a1ac251!8m2!3d-33.8567844!4d151.2152967!16zL20vMDZfbmQ?entry=ttu&g_ep=EgoyMDI1MDEwMS4wIKXMDSoASAFQAw%3D%3D';
  const p = pointOf(place);
  near(p, OPERA);
  assert.equal(p.label, 'Sydney Opera House');
  assert.equal(p.via, 'place-pin');
  // Other country domains and maps.google.*.
  near(pointOf('https://www.google.com.au/maps/place/Sydney+Opera+House/@-33.85,151.2,17z/data=!4m5!3m4!1s0x0:0x0!8m2!3d-33.8567844!4d151.2152967'), OPERA);
  near(pointOf('https://www.google.co.uk/maps/place/Big+Ben/@51.5007292,-0.1268194,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d51.5007292!4d-0.1246254'), { latitude: 51.500729, longitude: -0.124625 });
  near(pointOf('https://maps.google.de/maps/place/Brandenburger+Tor/@52.5162746,13.3777041,17z/data=!8m2!3d52.5162746!4d13.3777041'), { latitude: 52.516275, longitude: 13.377704 });
});

test('Google Maps addresses: @ viewport, ?q=, ?ll=, api=1, /search/, /place/<coordinates>, street view, directions', () => {
  const cases: [string, string?][] = [
    ['https://www.google.com/maps/@-33.8567844,151.2152967,17z', 'viewport'],
    ['https://www.google.com/maps/@-33.8567844,151.2152967,17z?entry=ttu', 'viewport'],
    ['https://www.google.com/maps/@-33.8567844,151.2152967,3a,75y,90t/data=!3m6!1e1!3m4!1sAF1QipN!2e10!7i10000!8i5000', 'viewport'],
    ['https://www.google.com/maps/@-33.8567844,151.2152967,500m/data=!3m1!1e3', 'viewport'],
    ['https://maps.google.com/?q=-33.8567844,151.2152967', 'param:q'],
    ['https://maps.google.com/maps?q=-33.8567844,151.2152967&z=17', 'param:q'],
    ['https://www.google.com/maps?q=-33.8567844,+151.2152967', 'param:q'],
    ['https://www.google.com/maps?q=loc:-33.8567844,151.2152967', 'param:q'],
    ['https://maps.google.com/?ll=-33.8567844,151.2152967&z=16', 'param:ll'],
    ['https://www.google.com/maps/search/?api=1&query=-33.8567844%2C151.2152967', 'param:query'],
    ['https://www.google.com/maps/@?api=1&map_action=map&center=-33.8567844%2C151.2152967&zoom=17', 'param:center'],
    ['https://www.google.com/maps/dir/?api=1&destination=-33.8567844%2C151.2152967', 'param:destination'],
    ['https://www.google.com/maps/search/-33.8567844,+151.2152967?entry=tts', 'search'],
    ['https://www.google.com/maps/search/-33.8567844,151.2152967', 'search'],
    ['https://www.google.com/maps/place/-33.8567844,151.2152967', 'place'],
    ['https://www.google.com/maps/place/-33.8567844,151.2152967/@-33.8567844,151.2152967,17z', 'place'],
    ['https://www.google.com/maps/dir/Central+Station,+Sydney/-33.8567844,151.2152967/@-33.87,151.21,14z/data=!3m1!4b1', 'directions'],
    ['http://maps.google.com/maps?daddr=-33.8567844,151.2152967', 'param:daddr'],
  ];
  for (const [u, via] of cases) { const p = pointOf(u); near(p, OPERA); if (via) assert.equal(p.via, via, u); }
  // Coordinates written as DMS in the place path (what "copy coordinates" puts there).
  near(pointOf("https://www.google.com/maps/place/33%C2%B051'24.4%22S+151%C2%B012'55.1%22E/@-33.856778,151.215306,17z/data=!3m1!1e3"), { latitude: -33.856778, longitude: 151.215306 });
  // Directions with only names: the last leg's !1d<lng>!2d<lat>.
  near(pointOf('https://www.google.com/maps/dir/Central+Station/Sydney+Opera+House/@-33.87,151.21,14z/data=!4m14!4m13!1m5!1m1!1s0x0:0x1!2m2!1d151.2062!2d-33.8832!1m5!1m1!1s0x0:0x2!2m2!1d151.2152967!2d-33.8567844'), OPERA);
});

test('a link with only a place’s name asks for it to be looked up; a cid alone has nothing', () => {
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/place/Sydney+Opera+House/data=!4m2!3m1!1s0x6b12ae665e892fdd:0x3133f8d75a1ac251'), { kind: 'name', query: 'Sydney Opera House', via: 'place-name' });
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/search/?api=1&query=Eiffel%20Tower'), { kind: 'name', query: 'Eiffel Tower', via: 'param:query' });
  assert.deepEqual(parseMapsUrl('https://maps.google.com/?q=Sydney+Opera+House,+Bennelong+Point'), { kind: 'name', query: 'Sydney Opera House, Bennelong Point', via: 'param:q' });
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/search/Eiffel+Tower'), { kind: 'name', query: 'Eiffel Tower', via: 'place-name' });
  assert.equal(parseMapsUrl('https://maps.google.com/?cid=3527425342434455121'), null);
  // ?q=<name>&ll=<point>: the point, named.
  const p = parseMapsUrl('https://maps.google.com/maps?q=Sydney+Opera+House&ll=-33.8567844,151.2152967');
  assert.equal(p?.kind, 'point'); assert.equal((p as { label?: string }).label, 'Sydney Opera House');
});

test('short share links are recognised for the hub to follow; other sites aren’t Google Maps', () => {
  assert.deepEqual(parseLocationText('https://maps.app.goo.gl/AbCdEf123?g_st=ic'), { kind: 'short-link', url: 'https://maps.app.goo.gl/AbCdEf123?g_st=ic', via: 'short-link' });
  assert.equal(parseLocationText('https://goo.gl/maps/AbCdEf123')?.kind, 'short-link');
  assert.equal(parseLocationText('http://goo.gl/maps/AbCdEf123')?.kind, 'short-link');
  // How phones share: the place's name, then the link.
  assert.deepEqual(parseLocationText('Sydney Opera House\nBennelong Point, Sydney NSW 2000\nhttps://maps.app.goo.gl/AbCdEf123'),
    { kind: 'short-link', url: 'https://maps.app.goo.gl/AbCdEf123', via: 'short-link', label: 'Sydney Opera House, Bennelong Point, Sydney NSW 2000' });
  assert.equal(parseLocationText('Check this out: https://www.google.com/maps/@-33.8567844,151.2152967,17z.')?.kind, 'point');
  for (const t of ['https://goo.gl/abc', 'https://example.com/maps/@-33.85,151.21,17z', 'https://evilgoogle.com/maps/@-33.85,151.21,17z', 'https://google.com.evil.net/maps/@-33.85,151.21,17z', 'Sydney Opera House', '', 'ftp://maps.google.com/?q=1,2'])
    assert.equal(parseLocationText(t), null, t);
  // Google's consent page wraps the real address.
  near(pointOf(`https://consent.google.com/m?continue=${encodeURIComponent('https://www.google.com/maps/@-33.8567844,151.2152967,17z')}&gl=AU`), OPERA);
  // Also Apple Maps and geo: URIs.
  near(pointOf('https://maps.apple.com/?ll=-33.8567844,151.2152967&q=Sydney%20Opera%20House'), OPERA);
  near(pointOf('geo:-33.8567844,151.2152967?q=-33.8567844,151.2152967(Opera%20House)'), OPERA);
});

test('hosts: only Google’s own count', () => {
  for (const h of ['google.com', 'www.google.com', 'maps.google.com', 'google.com.au', 'www.google.co.uk', 'maps.google.de', 'consent.google.com', 'goo.gl', 'maps.app.goo.gl']) assert.ok(isGoogleHost(h), h);
  for (const h of ['google.evil.com', 'evilgoogle.com', 'google.com.evil.net', 'goo.gl.evil.com', 'example.com', '127.0.0.1', 'googleusercontent.com']) assert.ok(!isGoogleHost(h), h);
  assert.ok(allowGoogle(new URL('https://maps.app.goo.gl/x')));
  assert.ok(!allowGoogle(new URL('http://maps.app.goo.gl/x')));
  assert.ok(!allowGoogle(new URL('https://user:pw@www.google.com/maps')));
  assert.ok(!allowGoogle(new URL('https://www.google.com:8443/maps')));
});

test('Plus Codes: full ones anywhere, short ones from a reference point', () => {
  // The Open Location Code reference example (Zurich).
  near(decodePlusCode('8FVC9G8F+6X'), { latitude: 47.3655625, longitude: 8.5249375 }, 1e-6);
  near(recoverPlusCode('9G8F+6X', { latitude: 47.4, longitude: 8.6 }), { latitude: 47.3655625, longitude: 8.5249375 }, 1e-6);
  assert.equal(encodePlusCode(47.3655625, 8.5249375), '8FVC9G8F+6X');
  // Round trips for landmarks, within the code's ~14 m.
  for (const p of [OPERA, { latitude: 51.500729, longitude: -0.124625 }, { latitude: 40.689247, longitude: -74.044502 }, { latitude: -22.951916, longitude: -43.210487 }, { latitude: 35.658581, longitude: 139.745438 }]) {
    const code = encodePlusCode(p.latitude, p.longitude);
    near(decodePlusCode(code), p, 2e-4);
    near(pointOf(code), p, 2e-4);
    near(pointOf(`https://www.google.com/maps/place/${encodeURIComponent(code)}`), p, 2e-4);
    // Short: the last 6 + 2, recovered near a point ~20 km away.
    near(recoverPlusCode(code.slice(4), { latitude: p.latitude + 0.2, longitude: p.longitude - 0.1 }), p, 2e-4);
  }
  // Recovery across a cell edge: the nearest match, not the reference's own cell.
  const edge = encodePlusCode(-33.9999, 151.0001);
  near(recoverPlusCode(edge.slice(4), { latitude: -33.95, longitude: 150.95 }), { latitude: -33.9999, longitude: 151.0001 }, 2e-4);
  // A short code with a town is for the hub to finish.
  const s = encodePlusCode(OPERA.latitude, OPERA.longitude).slice(4);
  assert.deepEqual(parseLocationText(`${s} Sydney NSW`), { kind: 'short-plus-code', code: s, locality: 'Sydney NSW', via: 'plus-code' });
  assert.deepEqual(parseLocationText(s), { kind: 'short-plus-code', code: s, via: 'plus-code' });
  for (const bad of ['8FVC9G8F+', 'AAAA+BB', '8FVC9G8+6X', '8FVC9G8F6X']) assert.equal(decodePlusCode(bad), null, bad);
});

// ------------------------------------------------------------ short links --

async function fakeGoogle(routes: Record<string, (host: string) => { status: number; location?: string; body?: string }>) {
  const hits: string[] = [];
  const srv: Server = createServer((req, res) => {
    hits.push(req.url!);
    const r = routes[req.url!.split('?')[0]];
    if (!r) { res.writeHead(404).end(); return; }
    const out = r(`127.0.0.1:${(srv.address() as AddressInfo).port}`);
    if (out.status === 0) return; // hang
    res.writeHead(out.status, { ...(out.location ? { location: out.location } : {}), 'content-type': 'text/html' }).end(out.body ?? '');
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  // Stands in for Google's hosts in these tests: the local server, plus the real ones (never fetched here).
  const allow = (u: URL) => u.host === new URL(base).host;
  return { base, hits, allow, close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

test('short links: followed one redirect at a time, stopping at the first address with the place', async () => {
  const g = await fakeGoogle({
    '/short': h => ({ status: 302, location: `http://${h}/hop` }),
    '/hop': () => ({ status: 301, location: '/maps/place/Sydney+Opera+House/@-33.85,151.2,17z/data=!8m2!3d-33.8567844!4d151.2152967' }),
  });
  try {
    const long = await resolveShortLink(`${g.base}/short`, { allow: g.allow });
    assert.match(long, /\/maps\/place\/Sydney\+Opera\+House\//);
    near(parseMapsUrl(long.replace(g.base, 'https://www.google.com')) as never, OPERA);
    // The long address isn't fetched: it already says where.
    assert.deepEqual(g.hits, ['/short', '/hop']);
  } finally { await g.close(); }
});

test('short links: a redirect away from Google is refused, and never fetched', async () => {
  const g = await fakeGoogle({ '/short': () => ({ status: 302, location: 'https://evil.example.com/steal' }) });
  try {
    await assert.rejects(resolveShortLink(`${g.base}/short`, { allow: g.allow }), /isn’t Google Maps \(evil\.example\.com\)/);
    // With Google's own rule, a local address is refused before anything is fetched.
    await assert.rejects(resolveShortLink(`${g.base}/short`), /isn’t Google Maps/);
    assert.deepEqual(g.hits, ['/short']);
  } finally { await g.close(); }
});

test('short links: too many redirects, a dead end, a page with the address in it, and a timeout', async () => {
  const g = await fakeGoogle({
    '/loop': h => ({ status: 302, location: `http://${h}/loop` }),
    '/gone': () => ({ status: 404 }),
    '/page': () => ({ status: 200, body: '<html><head><meta property="og:url" content="https://www.google.com/maps/place/Sydney+Opera+House/@-33.8567844,151.2152967,17z"></head></html>' }),
    '/nothing': () => ({ status: 200, body: '<html>Hello</html>' }),
    '/slow': () => ({ status: 0 }),
  });
  try {
    await assert.rejects(resolveShortLink(`${g.base}/loop`, { allow: g.allow, maxHops: 3 }), /too many times/);
    await assert.rejects(resolveShortLink(`${g.base}/gone`, { allow: g.allow }), /HTTP 404/);
    near(parseMapsUrl(await resolveShortLink(`${g.base}/page`, { allow: g.allow })) as never, OPERA);
    await assert.rejects(resolveShortLink(`${g.base}/nothing`, { allow: g.allow }), /Couldn’t find the place/);
    const t0 = Date.now();
    await assert.rejects(resolveShortLink(`${g.base}/slow`, { allow: g.allow, timeoutMs: 300 }));
    assert.ok(Date.now() - t0 < 3000);
  } finally { await g.close(); }
});
