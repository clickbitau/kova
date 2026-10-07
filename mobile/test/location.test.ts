import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRadius, injectFor, mapPageHtml, readMapMessage } from '../src/logic/map-page.ts';
import { coordsText, isGoogle, pinFromFound, pinFromPaste, pinMoved, saveBody, staticMapPath, type Pin } from '../src/logic/location.ts';
import { homeMoved } from '../src/logic/geo.ts';

// Public landmarks only.
const OPERA = { latitude: -33.856784, longitude: 151.215297 };

test('map page: Leaflet pinned with its integrity hash, OpenStreetMap credited, talks to the WebView and the web build', () => {
  const h = mapPageHtml({ ...OPERA, radiusM: 180 });
  assert.match(h, /unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.match(h, /integrity="sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY="/);
  assert.match(h, /sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
  assert.match(h, /tile\.openstreetmap\.org/);
  assert.match(h, /OpenStreetMap<\/a> contributors/);
  assert.match(h, /ReactNativeWebView\.postMessage/);
  assert.match(h, /window\.parent\.postMessage/);
  assert.match(h, /"latitude":-33\.856784/);
  assert.match(h, /MIN=50,MAX=500/);
  // Nothing from Google, ever, on this map.
  assert.doesNotMatch(h, /google/i);
  assert.match(mapPageHtml(null), /var start=null/);
});

test('map page messages: only well-formed ones count', () => {
  assert.deepEqual(readMapMessage('{"kova":"ready"}'), { kova: 'ready' });
  assert.deepEqual(readMapMessage(JSON.stringify({ kova: 'moved', latitude: -33.85678412345, longitude: 151.21529712345 })), { kova: 'moved', latitude: -33.856784, longitude: 151.215297 });
  assert.deepEqual(readMapMessage({ kova: 'radius', radiusM: 1234 }), { kova: 'radius', radiusM: 500 });
  assert.deepEqual(readMapMessage({ kova: 'radius', radiusM: 12 }), { kova: 'radius', radiusM: 50 });
  assert.deepEqual(readMapMessage({ kova: 'radius', radiusM: 233 }), { kova: 'radius', radiusM: 230 });
  for (const bad of ['nope', '{"kova":"moved","latitude":95,"longitude":0}', { kova: 'moved', latitude: 'x', longitude: 1 }, null, 5, { kova: 'other' }]) assert.equal(readMapMessage(bad), null);
  assert.equal(injectFor({ kova: 'set', ...OPERA, radiusM: 150 }), 'window.kovaSet && window.kovaSet({"kova":"set","latitude":-33.856784,"longitude":151.215297,"radiusM":150}); true;');
  assert.equal(clampRadius(149), 150);
});

test('whose point it is: pasted coordinates and dragged pins are the owner’s; searches keep their provider', () => {
  assert.deepEqual(pinFromPaste({ ...OPERA, label: 'Sydney Opera House', address: 'Bennelong Point' }), { ...OPERA, source: 'map', address: 'Bennelong Point', label: 'Sydney Opera House' });
  const g = pinFromPaste({ ...OPERA, label: 'Sydney Opera House', address: 'Bennelong Point', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' });
  assert.equal(g.source, 'geocode'); assert.ok(isGoogle(g));
  const f = pinFromFound({ label: 'Bennelong Point', ...OPERA, provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' });
  assert.deepEqual(f, { ...OPERA, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', address: 'Bennelong Point', label: null });
  assert.equal(pinFromFound({ label: 'x', ...OPERA }).provider, 'osm');
  // Moving Google's pin makes it the owner's: no provider, no place id.
  const m = pinMoved(f, { latitude: -33.8569001, longitude: 151.2151 });
  assert.deepEqual(m, { latitude: -33.8569, longitude: 151.2151, source: 'map', address: 'Bennelong Point', label: null });
  assert.ok(!isGoogle(m));
});

test('Save: the pin with whose it is, just the circle, or nothing', () => {
  const saved = { ...OPERA, radiusM: 150, source: 'map' as const };
  assert.equal(saveBody({ pin: null, radiusM: 150, saved }), null);
  assert.equal(saveBody({ pin: null, radiusM: 150, saved: null }), null);
  assert.deepEqual(saveBody({ pin: null, radiusM: 220, saved }), { location: { radiusM: 220 } });
  const g: Pin = { ...OPERA, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE', address: 'Bennelong Point' };
  assert.deepEqual(saveBody({ pin: g, radiusM: 150, saved, address: 'Bennelong Point', savedAddress: null }),
    { location: { ...OPERA, radiusM: 150, source: 'geocode', provider: 'google', placeId: 'ChIJ3S-JXmauEmsRUcIaWtf4MzE' }, address: 'Bennelong Point' });
  // The same address isn't sent again; the phone's zone goes with the phone's location.
  assert.deepEqual(saveBody({ pin: { ...OPERA, source: 'phone' }, radiusM: 1000, saved, address: 'Bennelong Point', savedAddress: 'Bennelong Point', timezone: 'Australia/Sydney' }),
    { location: { ...OPERA, radiusM: 500, source: 'phone' }, timezoneHint: 'Australia/Sydney' });
  assert.equal(coordsText(OPERA, 150), '-33.85678, 151.21530 · 150 m circle');
  assert.equal(staticMapPath(OPERA, 200), '/api/maps/static?lat=-33.856784&lon=151.215297&r=200&w=640&h=320');
});

test('the phone follows the home’s circle when it moves or resizes', () => {
  assert.equal(homeMoved(OPERA, OPERA), false);
  assert.equal(homeMoved(OPERA, { ...OPERA, radiusM: 150 }), false);
  assert.equal(homeMoved(OPERA, { ...OPERA, radiusM: 200 }), true);
  assert.equal(homeMoved(OPERA, { latitude: OPERA.latitude + 0.0001, longitude: OPERA.longitude }), true);
  assert.equal(homeMoved(OPERA, { latitude: OPERA.latitude + 0.000001, longitude: OPERA.longitude }), false);
  assert.equal(homeMoved(null, OPERA), false);
  assert.equal(homeMoved(OPERA, { latitude: 0, longitude: 0 }), false);
});
