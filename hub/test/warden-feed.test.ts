import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { INTERNET_ID, WARDEN_SCOPES, WardenAdapter, internetId } from '../src/adapters/warden.ts';
import { fakeWarden } from './fake-warden.ts';
import { Presence } from '../src/services/presence.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

const until = async (what: string, ok: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !ok(); t += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test('Warden: pair with a code approved at /apps, then follow the live feed, device records and people', { timeout: 30_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(20);
  const dir = mkdtempSync(join(tmpdir(), 'kova-warden-feed-'));
  const manager = new IntegrationsManager(t.hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, lanApps: { wardenPollMs: 50 } });
  try {
    // Pair: Kova asks for its scopes and shows the code Warden shows at /apps.
    const pr = await app.inject({ method: 'POST', url: '/api/integrations/warden/pair', payload: { url: w.url } });
    assert.equal(pr.statusCode, 200, pr.body);
    assert.equal(pr.json().code, 'BM5632');
    assert.match(pr.json().next, /\/apps .*BM5632/);
    assert.deepEqual(w.s.pair.scopes, WARDEN_SCOPES);
    assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/warden/pair' })).json().status, 'pending');
    // An admin approves it; Kova collects its token once and pins Warden's certificate.
    w.s.pair.status = 'approved';
    await until('token saved', () => manager.raw('warden')?.token === w.TOKEN);
    assert.deepEqual(manager.raw('warden')?.scopes, WARDEN_SCOPES, 'what Warden granted is kept, so the status can say when to pair again');
    assert.match(String(manager.raw('warden')?.fingerprint), /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/warden/pair' })).json().status, 'approved');

    // Devices on the network come from Warden's device records, with their ids.
    const list = (await app.inject({ method: 'GET', url: '/api/integrations/warden/clients' })).json();
    assert.deepEqual(list.devices[0], { name: 'Aisha’s iPad · tablet · Apple · Home · aa:bb:cc:00:00:01 · 10.10.0.40', deviceId: 'dev_tablet', mac: 'aa:bb:cc:00:00:01', ip: '10.10.0.40', online: true });
    assert.match(list.devices[1].name, /^Methel’s iPhone · Methel’s · phone/);

    // An internet switch set up by MAC (as before) finds its device record, and keeps it when the MAC changes.
    await manager.update('warden', { ...manager.raw('warden'), pollSec: 0, devices: [{ mac: 'aa:bb:cc:00:00:01', name: 'Aisha’s iPad', room: 'lounge' }] });
    const id = internetId('aa:bb:cc:00:00:01');
    const adapter = t.hub.reg.adapters.get('warden') as WardenAdapter;
    await until('feed connected', () => w.s.streams.length === 1 && t.dev(id)?.online === true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(w.s.streams.length, 1, 'the first adapter’s stream closed when the settings changed');
    assert.equal(w.s.streams[0].lastId, undefined, 'starts from now');
    assert.deepEqual(t.dev(id), { on: true, online: true });
    w.tablet.macs = ['f2:00:00:00:00:99', 'aa:bb:cc:00:00:01'];
    await t.hub.engine.command(id, { on: false });
    assert.ok(w.s.seen.includes('POST /api/v1/devices/dev_tablet/pause'), w.s.seen.join('\n'));
    assert.equal(w.tablet.paused, true);

    // Live: the internet drops and comes back.
    w.publish('wan.down', { wan: 'wan1', wanName: 'NBN' });
    await until('internet down', () => t.dev(INTERNET_ID).on === false);
    assert.ok(adapter.status().note?.endsWith('· live'));
    w.publish('wan.up', { wan: 'wan1', wanName: 'NBN', downSeconds: 40 });
    await until('internet up', () => t.dev(INTERNET_ID).on === true);
    const feed = () => t.hub.store.feed(50).map(e => e.what);
    assert.ok(feed().includes('Internet is down') && feed().includes('Internet is back'), feed().join('\n'));

    // Someone unpauses the iPad in the Warden app; it goes offline; a new device joins; an attack is blocked.
    w.publish('pause.changed', { mac: 'f2:00:00:00:00:99', paused: false, deviceId: 'dev_tablet' });
    await until('unpaused', () => t.dev(id).on === true);
    w.publish('device.left', { type: 'device.left', device: { ...w.tablet, online: false } });
    await until('offline', () => t.dev(id).online === false);
    const events: { type: string; data: Record<string, unknown> }[] = [];
    t.hub.reg.on('event', e => events.push({ type: e.type, data: e.data }));
    w.publish('device.new', { type: 'device.new', device: { id: 'dev_new', macs: ['00:14:78:3a:41:0c'], ips: ['10.10.30.41'], vendor: 'TP-Link', class: 'plug', online: true, paused: false, network: { id: 'iot', name: 'IoT', vlan: 30 } } });
    w.publish('threat.blocked', { incidentId: 'i1', title: 'Blocked a login attack on SSH', body: '40 attempts from 203.0.113.9.', level: 'act', count: 40, device: {}, port: 22, mitigated: true });
    w.publish('wan.failover', { wan: 'wan2', wanName: '5G backup', from: 'wan1', fromName: 'NBN' });
    await until('three events', () => events.length === 3);
    assert.deepEqual(events.map(e => [e.type, e.data.title]), [
      ['new-device', 'TP-Link device joined IoT'],
      ['threat', 'Blocked a login attack on SSH'],
      ['internet-failover', 'Switched to 5G backup'],
    ]);
    assert.equal(events[0].data.body, 'A TP-Link plug. Open Warden to name it or block it.');

    // The stream drops: Kova reconnects and carries on from the last event it saw.
    w.drop();
    await until('reconnected', () => w.s.streams.length === 1, 8000);
    assert.equal(w.s.streams[0].lastId, `evt_${w.s.seq}`);
    w.publish('wan.down', {});
    await until('down again', () => t.dev(INTERNET_ID).on === false);

    // Who's home: Methel by Warden's own presence (same name), even with no phone MAC set in Kova.
    const people = t.hub.config.get().people;
    assert.ok(people.some(p => p.name === 'Methel'), people.map(p => p.name).join());
    const methel = people.find(p => p.name === 'Methel')!;
    await t.hub.engine.setPresence(methel.id, false, 'test');
    const presence = new Presence(t.hub, { pollSec: 0 }, { warden: () => manager.raw('warden') });
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people[methel.id]?.home, true);
    presence.stop();
  } finally {
    await app.close();
    await t.hub.stop();
    await w.close();
  }
});

test('Warden presence: a phone is found by any MAC its device record has used', { timeout: 15_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(20);
  try {
    const cfg = { url: w.url, token: w.TOKEN };
    const person = t.hub.config.get().people[0];
    // The phone was set up with the MAC it had then; it has rotated to a new private one since.
    w.phone.macs = ['f2:7c:3b:10:9e:44', 'da:a1:19:6e:02:5f'];
    w.s.people = [];
    await t.hub.engine.setPresence(person.id, false, 'test');
    const presence = new Presence(t.hub, { pollSec: 0, people: { [person.id]: { phones: ['DA-A1-19-6E-02-5F'] } } }, { warden: () => cfg });
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people[person.id]?.home, true);
    assert.match(presence.status().note ?? '', /Router: 1 phone seen/);
    presence.stop();
  } finally {
    await t.hub.stop();
    await w.close();
  }
});

test('Warden presence: a wrong "left" from the phone (a location glitch) is overruled when Warden still sees them home', { timeout: 15_000 }, async () => {
  const w = await fakeWarden();
  const t = await testHub(3);
  try {
    const cfg = { url: w.url, token: w.TOKEN };
    const person = t.hub.config.get().people[0];
    w.s.people = [];
    const presence = new Presence(t.hub, { pollSec: 0, people: { [person.id]: { phones: [w.phone.macs[0]] } } }, { warden: () => cfg });
    presence.start();
    await presence.poll();
    assert.equal(t.hub.engine.people[person.id]?.home, true);
    // 04:00, asleep at home: the phone's location says "left"; Warden still sees the phone online.
    await presence.report(person.id, false, 'Kova app (location)');
    assert.equal(t.hub.engine.people[person.id]?.home, false, '"left" wins at first: they may be driving off');
    t.clock.t += 5 * 60_000; await presence.poll();
    assert.equal(t.hub.engine.people[person.id]?.home, false, 'within 15 minutes');
    t.clock.t += 11 * 60_000; await presence.poll();
    assert.equal(t.hub.engine.people[person.id]?.home, true, 'still on the home network after 15 minutes: home');
    presence.stop();
  } finally {
    await t.hub.stop();
    await w.close();
  }
});
