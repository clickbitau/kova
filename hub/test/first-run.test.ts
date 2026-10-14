import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/hub.ts';
import { buildServer } from '../src/api/server.ts';
import { newHome } from '../src/seed/default-home.ts';
import { demoAt, demoConfig } from '../src/seed/demo-home.ts';
import { homeOffsetMinutes } from '../src/util/locale.ts';
import { clock } from '../src/util/time.ts';

// A brand-new hub is nobody's home yet: empty, where its clock says it is, nothing faith- or region-specific, and
// setup to do. The home's settings decide how dates, times and temperatures are written.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

async function fresh(tz = 'America/Chicago') {
  const hub = new Hub({ dbPath: ':memory:', initialConfig: () => newHome(tz), adapters: [], tickMs: 0 });
  await hub.start();
  const app = await buildServer(hub, { webRoot });
  return { hub, app, close: async () => { await app.close(); await hub.stop(); } };
}

test('A new hub: an empty home where its clock is, no prayer times, setup to do; finishing setup ends first run', async () => {
  const h = await fresh();
  try {
    const c = h.hub.config.get();
    assert.equal(c.name, 'Home');
    assert.deepEqual([c.rooms, c.people], [[], []]);
    assert.equal(c.timezone, 'America/Chicago');
    assert.ok(Math.abs(c.latitude - 41.85) < 0.1 && Math.abs(c.longitude + 87.65) < 0.1, 'the zone’s reference city as a first guess');
    assert.equal(c.prayer?.on ?? false, false, 'prayer times are off');
    assert.equal(c.prayerMethod, undefined);
    assert.ok(c.modes.every(m => m.start.kind !== 'prayer'), 'no mode starts at a prayer time');
    let s = (await h.app.inject({ url: '/api/state' })).json();
    assert.equal(s.home.firstRun, true);
    assert.equal(s.devices.length, 0);
    assert.equal(s.home.locale, 'en-US', 'an American zone writes dates the American way until the owner chooses');
    assert.equal(s.home.hour12, true);
    const r = await h.app.inject({ method: 'PUT', url: '/api/home', payload: { name: 'Lake House', setupDone: true } });
    assert.equal(r.statusCode, 200, r.body);
    s = (await h.app.inject({ url: '/api/state' })).json();
    assert.equal(s.home.firstRun, false);
    assert.equal(s.home.name, 'Lake House');
  } finally { await h.close(); }
});

test('Dates, clocks and temperatures as the home chooses: locale, 12- or 24-hour, °F', async () => {
  const h = await fresh('Europe/London');
  try {
    let s = (await h.app.inject({ url: '/api/state' })).json();
    assert.deepEqual([s.home.locale, s.home.hour12, s.home.fahrenheit], ['en-GB', false, false]);
    assert.match(s.home.clock, /^\d{2}:\d{2}$/);
    assert.equal((await h.app.inject({ method: 'PUT', url: '/api/home', payload: { locale: 'xx-nope-123456789' } })).statusCode, 400);
    const r = await h.app.inject({ method: 'PUT', url: '/api/home', payload: { locale: 'en-US', hour12: true, fahrenheit: true } });
    assert.equal(r.statusCode, 200, r.body);
    s = (await h.app.inject({ url: '/api/state' })).json();
    assert.deepEqual([s.home.locale, s.home.hour12, s.home.fahrenheit], ['en-US', true, true]);
    assert.match(s.home.clock, /^\d{1,2}:\d{2} (AM|PM)$/, 'as American English writes it');
    assert.match(s.home.dateLabel, /^[A-Z][a-z]+, [A-Z][a-z]{2} \d{1,2}$/, 'month before day');
    assert.equal(clock(Date.UTC(2026, 9, 14, 15, 30), 'UTC'), '3:30 PM');
    await h.app.inject({ method: 'PUT', url: '/api/home', payload: { locale: 'en-GB' } });
    assert.equal(clock(Date.UTC(2026, 9, 14, 15, 30), 'UTC'), '3:30 pm');
    await h.app.inject({ method: 'PUT', url: '/api/home', payload: { hour12: false } });
    assert.equal(clock(Date.UTC(2026, 9, 14, 15, 30), 'UTC'), '15:30');
  } finally { await h.close(); }
});

test('Integrations get the home’s own timezone (an Ecovacs robot’s offset), not one built in', async () => {
  const h = await fresh('America/New_York');
  try {
    const off = homeOffsetMinutes(Date.UTC(2026, 0, 15));
    assert.equal(off, -300, 'New York in winter');
    await h.app.inject({ method: 'PUT', url: '/api/home', payload: { timezone: 'Asia/Kolkata' } });
    assert.equal(homeOffsetMinutes(), 330);
  } finally { await h.close(); }
});

test('The demo home is a made-up family, with no prayer times, run where the hub is', () => {
  const c = demoConfig();
  assert.deepEqual(c.people.map(p => p.name), ['Alex', 'Jordan']);
  assert.equal(c.prayerMethod, undefined);
  assert.ok(c.modes.every(m => m.start.kind !== 'prayer'));
  assert.ok(!c.sources.some(s => /tarateel|quran/i.test(s.name)));
  const there = demoConfig(demoAt('Europe/Berlin').place);
  assert.equal(there.timezone, 'Europe/Berlin');
  assert.ok(Math.abs(there.latitude - 52.5) < 0.2);
});
