import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { GOOGLE_KEEP_MS, nearestZone, sameClock } from '../src/services/maps.ts';

const webRoot = resolve(import.meta.dirname, '../../web');
// Not a real key: the shape of one. No real key is ever used in tests.
const FAKE_KEY = 'AIzaTESTxTESTxTESTxTESTxTESTxTEST1234';
const OPERA = { latitude: -33.856784, longitude: 151.215297 };
const BIG_BEN = { latitude: 51.500729, longitude: -0.124625 };
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** Google, Nominatim and a short link, as the hub would see them. */
function fakeNet(o: { places?: boolean; geocoding?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method: init.method ?? 'GET', headers, body: init.body as string | undefined });
    const keyOk = headers['x-goog-api-key'] === FAKE_KEY || u.searchParams.get('key') === FAKE_KEY;
    if (u.hostname === 'places.googleapis.com') {
      if (!keyOk) return json({ error: { message: 'API key not valid' } }, 400);
      if (o.places === false) return json({ error: { message: 'Places API (New) has not been used in project 1 before or it is disabled', status: 'PERMISSION_DENIED' } }, 403);
      if (u.pathname === '/v1/places:autocomplete') return json({ suggestions: [{ placePrediction: { placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', text: { text: 'Sydney Opera House, Bennelong Point, Sydney NSW, Australia' } } }] });
      if (u.pathname.startsWith('/v1/places/')) return json({ id: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', formattedAddress: 'Bennelong Point, Sydney NSW 2000, Australia', location: OPERA, displayName: { text: 'Sydney Opera House' } });
    }
    if (u.hostname === 'maps.googleapis.com') {
      if (!keyOk) return json({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' });
      if (u.pathname === '/maps/api/geocode/json') {
        if (o.geocoding === false) return json({ status: 'REQUEST_DENIED', error_message: 'This API project is not authorized to use this API.' });
        return json({ status: 'OK', results: [{ formatted_address: 'Bennelong Point, Sydney NSW 2000, Australia', place_id: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', geometry: { location: { lat: OPERA.latitude, lng: OPERA.longitude } } }] });
      }
      if (u.pathname === '/maps/api/staticmap') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      if (u.pathname === '/maps/api/timezone/json') return json({ status: 'OK', timeZoneId: 'Europe/London' });
    }
    if (u.hostname === 'nominatim.openstreetmap.org') {
      if (u.pathname === '/search') return json([{ display_name: 'Sydney Opera House, Bennelong Point, Sydney, Australia', lat: String(OPERA.latitude), lon: String(OPERA.longitude) }]);
      if (u.pathname === '/reverse') return json({ display_name: 'Bennelong Point, Sydney, Australia' });
    }
    if (u.hostname === 'maps.app.goo.gl' && u.pathname === '/OperaHouse') return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/place/Sydney+Opera+House/@-33.85,151.2,17z/data=!8m2!3d-33.8567844!4d151.2152967' } });
    if (u.hostname === 'maps.app.goo.gl' && u.pathname === '/NameOnly') return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/place/Sydney+Opera+House/data=!4m2!3m1!1s0x0:0x1' } });
    if (u.hostname === 'maps.app.goo.gl' && u.pathname === '/Away') return new Response(null, { status: 302, headers: { location: 'https://phish.example.com/' } });
    return new Response('not here', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

async function setup(net = fakeNet(), env: Record<string, string> = {}) {
  const t = await testHub(12, undefined, { maps: { fetch: net.f, env, nominatimGapMs: 0 } });
  const app = await buildServer(t.hub, { webRoot });
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  return { ...t, app, call, net, done: async () => { await app.close(); await t.hub.stop(); } };
}

test('without a key: OpenStreetMap search, pasted coordinates and links, no Google map', async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.call('GET', '/api/maps/settings')).json(), { google: false, provider: 'osm', from: null, hint: null, lastError: null, proxy: false });
    assert.equal((await s.call('GET', '/api/state')).json().home.maps.google, false);
    const g = (await s.call('GET', '/api/geocode?q=Sydney%20Opera%20House')).json();
    assert.equal(g.via, 'osm');
    assert.equal(g.results[0].provider, 'osm');
    assert.equal(g.results[0].latitude, OPERA.latitude);
    // Nominatim's policy: an identifying User-Agent.
    assert.match(s.net.calls.find(c => c.url.includes('nominatim'))!.headers['user-agent'], /^Kova .*github\.com\/clickbitau\/kova/);

    // Coordinates: the person's own point, with OpenStreetMap's address for it.
    let r = await s.call('POST', '/api/location/parse', { text: '-33.856784, 151.215297' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ...OPERA, address: 'Bennelong Point, Sydney, Australia', via: 'coordinates' });
    // A short share link, followed by the hub.
    r = await s.call('POST', '/api/location/parse', { text: 'Sydney Opera House\nhttps://maps.app.goo.gl/OperaHouse' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().latitude, OPERA.latitude);
    assert.equal(r.json().label, 'Sydney Opera House');
    assert.equal(r.json().via, 'place-pin');
    assert.equal(r.json().provider, undefined);
    // A link with only the place's name: looked up (OpenStreetMap here).
    r = await s.call('POST', '/api/location/parse', { text: 'https://maps.app.goo.gl/NameOnly' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().provider, 'osm');
    assert.equal(r.json().label, 'Sydney Opera House');
    // A short link that leaves Google isn't followed there.
    r = await s.call('POST', '/api/location/parse', { text: 'https://maps.app.goo.gl/Away' });
    assert.equal(r.statusCode, 502);
    assert.match(r.json().error, /isn’t Google Maps/);
    assert.ok(!s.net.calls.some(c => c.url.includes('phish')));
    // Nothing usable.
    for (const text of ['', 'hello there', 'https://example.com/x']) {
      r = await s.call('POST', '/api/location/parse', { text });
      assert.equal(r.statusCode, 400, text);
      assert.ok(r.json().error);
    }
    // A full Plus Code; a short one made full from the town after it.
    r = await s.call('POST', '/api/location/parse', { text: '4RRH46V8+74' });
    assert.ok(Math.abs(r.json().latitude - OPERA.latitude) < 2e-4);
    r = await s.call('POST', '/api/location/parse', { text: '46V8+74 Sydney' });
    assert.ok(Math.abs(r.json().latitude - OPERA.latitude) < 2e-4 && Math.abs(r.json().longitude - OPERA.longitude) < 2e-4, r.body);
    // No Google map without Google.
    assert.equal((await s.call('GET', '/api/maps/static?lat=-33.85&lon=151.21')).statusCode, 404);
    assert.equal((await s.call('GET', '/api/geocode/place?id=ChIJ3S-JXmauEmsRUcIaWtf4MzE')).statusCode, 404);
  } finally { await s.done(); }
});

test('the Google Maps key: stored on the hub, never sent back, used instead of the environment’s', async () => {
  const s = await setup(fakeNet(), { GOOGLE_MAPS_API_KEY: 'AIzaENVxENVxENVxENVxENVxENVxENVx9999' });
  try {
    assert.deepEqual((await s.call('GET', '/api/maps/settings')).json(), { google: true, provider: 'google-key', from: 'env', hint: '…9999', lastError: null, proxy: false });
    assert.equal((await s.call('PUT', '/api/maps/settings', { googleKey: 'not a key!' })).statusCode, 400);
    assert.equal((await s.call('PUT', '/api/maps/settings', {})).statusCode, 400);
    const r = await s.call('PUT', '/api/maps/settings', { googleKey: ` ${FAKE_KEY} ` });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { google: true, provider: 'google-key', from: 'hub', hint: '…1234', lastError: null, proxy: false });
    // Never in anything the hub answers.
    for (const url of ['/api/maps/settings', '/api/state', '/api/boot.js']) assert.ok(!(await s.call('GET', url)).body.includes(FAKE_KEY.slice(0, -4)), url);
    assert.equal((await s.call('GET', '/api/state')).json().home.maps.google, true);
    // The hub's key wins over the environment's.
    await s.call('GET', '/api/geocode?q=Sydney%20Opera%20House');
    assert.equal(s.net.calls.at(-1)!.headers['x-goog-api-key'], FAKE_KEY);
    // Removed: back to the environment's.
    assert.equal((await s.call('PUT', '/api/maps/settings', { googleKey: null })).json().from, 'env');
  } finally { await s.done(); }
});

test('with a key: Places suggestions as text, Place Details on a pick, Google’s own map for its points', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    const g = (await s.call('GET', '/api/geocode?q=Sydney%20Opera%20House')).json();
    assert.equal(g.via, 'google-places');
    assert.ok(g.session);
    // Text and an id only: no coordinates until one is picked.
    assert.deepEqual(g.results, [{ label: 'Sydney Opera House, Bennelong Point, Sydney NSW, Australia', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', provider: 'google' }]);
    const ac = s.net.calls.find(c => c.url.endsWith('places:autocomplete'))!;
    assert.equal(JSON.parse(ac.body!).sessionToken, g.session);
    assert.ok(JSON.parse(ac.body!).locationBias.circle.center.latitude < -31);
    const d = (await s.call('GET', `/api/geocode/place?id=${g.results[0].placeId}&session=${g.session}`)).json();
    assert.deepEqual(d, { label: 'Bennelong Point, Sydney NSW 2000, Australia', ...OPERA, placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', provider: 'google' });
    assert.match(s.net.calls.at(-1)!.url, new RegExp(`sessionToken=${g.session}`));
    assert.equal((await s.call('GET', '/api/geocode/place?id=bad id')).statusCode, 400);
    // Google's map, through the hub: a picture, the key only ever on the hub's own request.
    const img = await s.call('GET', '/api/maps/static?lat=-33.856784&lon=151.215297&r=120&w=600&h=300');
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.deepEqual(img.rawPayload, PNG);
    const sm = new URL(s.net.calls.at(-1)!.url);
    assert.equal(sm.searchParams.get('size'), '600x300');
    assert.match(sm.searchParams.get('path')!, /^color:.*fillcolor:.*\|-33\.85/);
    // A link with only a name, found by Google: Google's point (to be shown on Google's map).
    const p = (await s.call('POST', '/api/location/parse', { text: 'https://maps.app.goo.gl/NameOnly' })).json();
    assert.equal(p.provider, 'google');
    assert.equal(p.placeId, 'ChIJ3S-JXmauEmsRUcIaWtf4MzE');
    // A pasted link's own coordinates stay the person's: the address is OpenStreetMap's, never Google's.
    const own = (await s.call('POST', '/api/location/parse', { text: '-33.856784, 151.215297' })).json();
    assert.equal(own.provider, undefined);
    assert.ok(!s.net.calls.some(c => c.url.includes('geocode/json?latlng')));
  } finally { await s.done(); }
});

test('with a key but Places not enabled: the Geocoding API, and the reason shown in Settings', async () => {
  const s = await setup(fakeNet({ places: false }));
  try {
    await s.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    const g = (await s.call('GET', '/api/geocode?q=Sydney%20Opera%20House')).json();
    assert.equal(g.via, 'google-geocoding');
    assert.equal(g.results[0].latitude, undefined);
    assert.match((await s.call('GET', '/api/maps/settings')).json().lastError, /Places API: Places API \(New\) has not been used/);
    // The id still looks up, through the Geocoding API.
    const d = (await s.call('GET', `/api/geocode/place?id=${g.results[0].placeId}`)).json();
    assert.equal(d.latitude, OPERA.latitude);
  } finally { await s.done(); }
  // Neither enabled: OpenStreetMap still answers.
  const t = await setup(fakeNet({ places: false, geocoding: false }));
  try {
    await t.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    assert.equal((await t.call('GET', '/api/geocode?q=Sydney%20Opera%20House')).json().via, 'osm');
  } finally { await t.done(); }
});

test('saving: whose point it is; Google’s keep their place id and are refreshed within 30 days', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    assert.match((await s.call('PUT', '/api/home', { location: { ...OPERA, source: 'bogus' } })).json().error, /manual, geocode, phone, import or map/);
    assert.equal((await s.call('PUT', '/api/home', { location: { ...OPERA, source: 'geocode', provider: 'google' } })).statusCode, 400);
    let r = await s.call('PUT', '/api/home', { address: 'Bennelong Point, Sydney NSW 2000, Australia', timezone: 'Australia/Sydney', location: { ...OPERA, radiusM: 120, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' } });
    assert.equal(r.statusCode, 200, r.body);
    let loc = s.hub.config.get().location!;
    assert.deepEqual({ ...loc, updatedAt: 0, fetchedAt: 0 }, { latitude: -33.85678, longitude: 151.2153, radiusM: 120, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', updatedAt: 0, fetchedAt: 0 });
    assert.equal((await s.call('GET', '/api/state')).json().home.location.provider, 'google');
    // Only the circle: the point stays Google's.
    await s.call('PUT', '/api/home', { location: { radiusM: 200 } });
    assert.equal(s.hub.config.get().location!.placeId, 'ChIJ3S-JXmauEmsRUcIaWtf4MzE');
    assert.equal(s.hub.config.get().location!.radiusM, 200);
    // Not due yet.
    assert.equal(await s.hub.refreshPlace(), false);
    // 30 days on: Place Details again, by the id.
    s.clock.t += GOOGLE_KEEP_MS + 1;
    s.net.calls.length = 0;
    assert.equal(await s.hub.refreshPlace(), true);
    assert.match(s.net.calls[0].url, /places\.googleapis\.com\/v1\/places\/ChIJ3S-JXmauEmsRUcIaWtf4MzE/);
    assert.equal(s.hub.config.get().location!.fetchedAt, s.clock.t);
    // Moved on the map: the owner's own, Google's id dropped, never refreshed.
    r = await s.call('PUT', '/api/home', { location: { latitude: -33.8569, longitude: 151.2151, radiusM: 150, source: 'map', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' } });
    loc = s.hub.config.get().location!;
    assert.equal(loc.source, 'map');
    assert.equal(loc.provider, undefined);
    assert.equal(loc.placeId, undefined);
    s.clock.t += GOOGLE_KEEP_MS * 2;
    assert.equal(await s.hub.refreshPlace(), false);
  } finally { await s.done(); }
});

test('refresh with no Google any more: the saved address is found on OpenStreetMap instead', async () => {
  const s = await setup();
  try {
    await s.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    await s.call('PUT', '/api/home', { address: 'Bennelong Point, Sydney NSW 2000, Australia', timezone: 'Australia/Sydney', location: { latitude: -33.8, longitude: 151.2, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' } });
    await s.call('PUT', '/api/maps/settings', { googleKey: null });
    s.clock.t += GOOGLE_KEEP_MS + 1;
    assert.equal(await s.hub.refreshPlace(), true);
    const loc = s.hub.config.get().location!;
    assert.equal(loc.provider, 'osm');
    assert.equal(loc.latitude, -33.85678);
    assert.equal(s.hub.config.get().address, 'Sydney Opera House, Bennelong Point, Sydney, Australia');
  } finally { await s.done(); }
});

test('a new location in another place gets its timezone; fine-tuning never changes it; Undo puts both back', async () => {
  const s = await setup();
  try {
    assert.equal(s.hub.config.get().timezone, 'Australia/Perth');
    // A few hundred metres: same zone, nothing asked.
    let r = await s.call('PUT', '/api/home', { location: { latitude: -31.953, longitude: 115.857, source: 'map' } });
    assert.equal(r.json().timezone, undefined);
    // Another continent (no key: the nearest zone's reference city).
    r = await s.call('PUT', '/api/home', { location: { ...BIG_BEN, source: 'map' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().timezone, 'Europe/London');
    assert.equal(s.hub.config.get().timezone, 'Europe/London');
    await s.call('POST', `/api/undo/${r.json().undo}`);
    assert.equal(s.hub.config.get().timezone, 'Australia/Perth');
    assert.equal(s.hub.config.get().latitude, -31.953);
    // A timezone sent wins.
    r = await s.call('PUT', '/api/home', { timezone: 'Asia/Tokyo', location: { ...BIG_BEN, source: 'map' } });
    assert.equal(s.hub.config.get().timezone, 'Asia/Tokyo');
    assert.equal(r.json().timezone, undefined);
    // The phone's own zone, when it's the phone's location.
    r = await s.call('PUT', '/api/home', { timezoneHint: 'Australia/Sydney', location: { ...OPERA, source: 'phone' } });
    assert.equal(r.json().timezone, 'Australia/Sydney');
  } finally { await s.done(); }
  // With a key: Google's Time Zone API.
  const t = await setup();
  try {
    await t.call('PUT', '/api/maps/settings', { googleKey: FAKE_KEY });
    const r = await t.call('PUT', '/api/home', { location: { ...BIG_BEN, source: 'map' } });
    assert.equal(r.json().timezone, 'Europe/London');
    assert.ok(t.net.calls.some(c => c.url.includes('/maps/api/timezone/json')));
  } finally { await t.done(); }
});

test('timezone helpers', () => {
  assert.equal(nearestZone(OPERA), 'Australia/Sydney');
  assert.equal(nearestZone(BIG_BEN), 'Europe/London');
  assert.equal(nearestZone({ latitude: 40.6892, longitude: -74.0445 }), 'America/New_York');
  assert.ok(sameClock('Australia/Perth', 'Asia/Singapore'));
  assert.ok(sameClock('Europe/London', 'Europe/London'));
  assert.ok(!sameClock('Australia/Sydney', 'Australia/Brisbane', Date.UTC(2026, 0, 1)));
  assert.ok(sameClock('Australia/Brisbane', 'Australia/Lindeman', Date.UTC(2026, 0, 1)));
});
