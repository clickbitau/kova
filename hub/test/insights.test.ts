import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub, at } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { glance, insights, rainText, type InsightInputs } from '../src/services/insights.ts';
import { summarise } from '../src/services/weather.ts';
import type { Device } from '../src/model/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const TZ = 'Australia/Perth';
const dev = (id: string, type: string, state: Record<string, unknown>, extra: Partial<Device> = {}) => ({ id, name: id, room: 'lounge', type, adapter: 'x', capabilities: [], integration: 'x', address: id, state, ...extra } as unknown as Device);
const base = (devices: Device[], extra: Partial<InsightInputs> = {}): InsightInputs => ({
  devices, cfg: { rooms: [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }], timezone: TZ, devices: {} }, now: at(12), weather: null, failing: [], offlineSince: new Map(), ...extra,
});

test('met.no forecast: now, and the rest of today: high, low, UV, and when rain starts', () => {
  const h = (hour: number) => new Date(at(hour)).toISOString();
  const step = (hour: number, temp: number, mm = 0, sym = 'clearsky_day', uv = 3) => ({ time: h(hour), data: { instant: { details: { air_temperature: temp, relative_humidity: 40, wind_speed: 5, ultraviolet_index_clear_sky: uv, apparent_air_temperature: temp - 1 } }, next_1_hours: { summary: { symbol_code: sym }, details: { precipitation_amount: mm } } } });
  const s = summarise([step(11, 19), step(12, 21, 0, 'clearsky_day', 9), step(13, 24), step(15, 22, 1.4, 'rain'), step(16, 20, 0.6, 'lightrain'), step(30, 10)], at(12.2), TZ)!;
  assert.deepEqual(s.current, { temp: 21, text: 'Sunny', icon: 'sunny', feels: 20, humidity: 40, wind: 18, uv: 9 });
  assert.deepEqual([s.today.high, s.today.low, s.today.uvMax], [24, 19, 9], 'today only, not tomorrow');
  assert.deepEqual(s.today.rain, { from: at(15), mm: 2, chance: null });
  assert.equal(rainText(s.today.rain, at(12.2), TZ), 'Might rain from about 15:00 (2 mm)');
  assert.equal(rainText({ from: at(12.5), mm: 1, chance: 70 }, at(12.2), TZ), 'Might rain soon (70% chance)');
});

test('alerts and warnings: filter, air, inside temperature, battery, offline, integrations, internet, weather', () => {
  const list = insights(base([
    dev('purifier', 'fan', { on: true, filterLife: 18, airQuality: 3, pm25: 40, online: true }),
    dev('ac', 'climate', { on: false, temp: 31, online: true }),
    dev('vac', 'vacuum', { battery: 8, activity: 'cleaning', online: true }),
    dev('docked', 'vacuum', { battery: 8, activity: 'docked', online: true }),
    dev('plug', 'plug', { online: false }),
    dev('hidden', 'plug', { online: false }),
    dev('warden_internet', 'internet', { on: false, online: true }),
  ], {
    cfg: { rooms: [{ id: 'lounge', name: 'Lounge', icon: 'weekend' }], timezone: TZ, devices: { hidden: { hidden: true } } },
    offlineSince: new Map([['plug', at(11)], ['hidden', at(10)]]),
    failing: [{ id: 'tapo', name: 'TP-Link Tapo', note: '1 of 1 not responding' }],
    weather: { current: { temp: 30, text: 'Sunny', icon: 'sunny' }, today: { high: 37, low: 18, uvMax: 11, rain: null } },
  }));
  const by = Object.fromEntries(list.map(i => [i.id, i]));
  assert.equal(list[0].level, 'alert', 'alerts first');
  assert.deepEqual([by['filter:purifier'].level, by['filter:purifier'].title, by['filter:purifier'].detail], ['warning', 'purifier (Lounge): replace the filter soon', '18% left']);
  assert.equal(by['air:purifier'].title, 'The air is poor near purifier (Lounge)');
  assert.equal(by['indoor-hot:ac'].detail, 'The air conditioner is off.');
  assert.equal(by['battery:vac'].level, 'alert');
  assert.equal(by['battery:docked'], undefined, 'charging on its dock');
  assert.equal(by['offline:plug'].title, 'plug isn’t responding', 'hidden devices left out');
  assert.equal(by['integration:tapo'].detail, '1 of 1 not responding');
  assert.equal(by.internet.level, 'alert');
  assert.ok(by['heat:2026-09-30'] && by['uv:2026-09-30']);
  assert.equal(by['offline:plug'].push, undefined, 'the notifier pushes offline itself');

  // Offline under half an hour: not yet.
  assert.equal(insights(base([dev('plug', 'plug', { online: false })], { offlineSince: new Map([['plug', at(11.8)]]) })).length, 0);
});

test('the home at a glance: outside with rain, inside temperatures, the air worst first', () => {
  const g = glance(base([
    dev('ac', 'climate', { temp: 20.8, online: true }, { room: 'lounge', name: 'AC' }),
    dev('p1', 'fan', { airQuality: 1, online: true }, { name: 'Bedroom purifier' }),
    dev('p2', 'fan', { airQuality: 2, online: true }, { name: 'Lounge purifier' }),
  ], { weather: { current: { temp: 21, text: 'Sunny', icon: 'sunny' }, today: { high: 24, low: 15, uvMax: 6, rain: { from: at(15), mm: 2, chance: null } } } }));
  assert.deepEqual(g.inside, [{ name: 'Lounge', temp: 20.8, device: 'ac' }]);
  assert.deepEqual(g.air.map(a => [a.name, a.label]), [['Lounge purifier', 'Moderate'], ['Bedroom purifier', 'Good']]);
  assert.equal(g.outside!.rain, 'Might rain from about 15:00 (2 mm)');
  assert.deepEqual([g.outside!.high, g.outside!.low], [24, 15]);
});

test('insights on a hub: in the snapshot, snoozed, and told once when they first appear', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  const told: string[] = [];
  t.hub.insights.on('new', i => told.push(i.id));
  try {
    t.hub.insights.current(); // the first look only remembers
    t.virtual.physical('office_plug', { battery: 9 } as never);
    let s = (await app.inject({ url: '/api/state' })).json();
    assert.ok(Array.isArray(s.insights) && s.glance && Array.isArray(s.glance.inside));
    t.hub.reg.get('lamp')!.state.filterLife = 15;
    s = (await app.inject({ url: '/api/state' })).json();
    assert.ok(s.insights.some((i: { id: string }) => i.id === 'filter:lamp'));
    (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual(told.filter(x => x === 'filter:lamp'), ['filter:lamp'], 'once');
    const r = await app.inject({ method: 'POST', url: '/api/insights/filter:lamp/snooze', payload: { hours: 4 } });
    assert.equal(r.statusCode, 200);
    s = (await app.inject({ url: '/api/state' })).json();
    assert.ok(!s.insights.some((i: { id: string }) => i.id === 'filter:lamp'), 'snoozed');
    assert.equal((await app.inject({ method: 'POST', url: '/api/insights/x/snooze', payload: { hours: 0 } })).statusCode, 400);
  } finally { await app.close(); await t.hub.stop(); }
});
