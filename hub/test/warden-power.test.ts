import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { fakeWarden } from './fake-warden.ts';
import { buildServer } from '../src/api/server.ts';
import { ROUTER_ID, WardenAdapter, bmcState, type WardenBmc } from '../src/adapters/warden.ts';
import { Notifier } from '../src/services/notify.ts';
import { AiAssistant } from '../src/assistant/ai.ts';
import { snapshot } from '../src/api/snapshot.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

const until = async (what: string, ok: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !ok(); t += 20) await new Promise(r => setTimeout(r, 20));
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const settle = () => new Promise(r => setTimeout(r, 30));

/** A server with a BMC, as Warden 1.041 returns it: both supplies fine. */
const healthy = (): WardenBmc => ({
  available: true, powerWatts: 268,
  powerSupplies: [{ name: 'Power supply 1', present: true, ok: true }, { name: 'Power supply 2', present: true, ok: true }],
  powerRedundancy: 'full',
  sensors: [
    { name: 'Inlet Temp', kind: 'temp', value: 24.04, unit: 'C' }, { name: 'CPU1 Temp', kind: 'temp', value: 51, unit: 'C' },
    { name: 'Fan1', kind: 'fan', value: 5400.4, unit: 'RPM' }, { name: 'Bogus', kind: 'temp', value: 900, unit: 'C' },
    { name: '12V', kind: 'voltage', value: 12.1, unit: 'V' },
  ],
  fanMode: 'auto',
});

async function fakeNtfy() {
  const got: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(200); res.end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** A test hub with Warden linked (no timers: the test reads when it wants). */
async function setup(o: { feed?: boolean; scopes?: string[] } = {}) {
  const w = await fakeWarden();
  const t = await testHub(12);
  const adapter = new WardenAdapter({ url: w.url, token: w.TOKEN, pollSec: 0, bmcSec: 0, feed: o.feed ?? false, scopes: o.scopes });
  return { w, t, adapter, start: () => t.hub.reg.addAdapter(adapter), close: async () => { await t.hub.stop(); await w.close(); } };
}

test('Warden BMC: what Kova keeps from a reading', () => {
  const s = bmcState({ ...healthy(), powerSupplies: [{ name: 'PSU1', present: false, ok: false }, { name: 'PSU2', ok: false, problem: 'melted' }], powerRedundancy: 'sideways', fanMode: 'manual', fanPercent: 40.4 });
  assert.deepEqual(s.supplies, [{ name: 'PSU1', present: false, ok: false, problem: 'not installed' }, { name: 'PSU2', ok: false, problem: null }]);
  assert.equal(s.redundancy, undefined, 'only full, degraded or lost');
  assert.deepEqual(s.sensors, [
    { name: 'Inlet Temp', kind: 'temp', value: 24, unit: 'C' }, { name: 'CPU1 Temp', kind: 'temp', value: 51, unit: 'C' }, { name: 'Fan1', kind: 'fan', value: 5400, unit: 'RPM' },
  ], 'temperatures to 0.1 °C, fans whole, out of range and other kinds dropped');
  assert.deepEqual([s.fanMode, s.fanPercent], ['manual', 40]);
  // Hardware without power sensors: no power, supplies or redundancy at all (not zero).
  assert.deepEqual(bmcState({ available: true, sensors: [], fanMode: 'auto' }), { sensors: [], fanMode: 'auto', fanPercent: null });
});

test('Warden: the router’s power, read every few minutes, never two reads at once, in state, the snapshot and Energy', { timeout: 20_000 }, async () => {
  const { w, t, adapter, start, close } = await setup();
  try {
    w.s.bmc = healthy();
    await start();
    await adapter.pollPower();
    const r = t.hub.reg.get(ROUTER_ID)!;
    assert.ok(r, 'the Router device appears once Warden shows its BMC');
    assert.deepEqual([r.name, r.type, r.capabilities, r.integration], ['Router', 'sensor', ['power', 'events'], 'Warden']);
    assert.equal(r.state.power, 268);
    assert.deepEqual(r.state.supplies, [{ name: 'Power supply 1', present: true, ok: true }, { name: 'Power supply 2', present: true, ok: true }]);
    assert.equal(r.state.redundancy, 'full');
    assert.deepEqual(r.state.sensors?.map(x => `${x.name}=${x.value}`), ['Inlet Temp=24', 'CPU1 Temp=51', 'Fan1=5400']);
    assert.equal(r.state.fanMode, 'auto');
    await adapter.poll();
    assert.match(adapter.status().note ?? '', /· router 268 W/);

    // In the snapshot, and on the Energy page as a load it measures.
    const snap = snapshot(t.hub);
    const sd = snap.devices.find(d => d.id === ROUTER_ID)!;
    assert.deepEqual([sd.state.power, sd.state.redundancy, sd.state.supplies?.length], [268, 'full', 2]);
    const en = t.hub.energy.today();
    assert.deepEqual(en.devices.find(d => d.id === ROUTER_ID), { id: ROUTER_ID, name: 'Router', w: 268 });
    assert.equal(sd.watts, undefined, 'it measures its own power: nothing to set on the Energy page');

    // Slow reads (about 4 s on real hardware) never overlap: asked for three times during one, it reads once more after.
    w.s.bmcMs = 250;
    const before = w.s.bmcReads;
    await Promise.all([adapter.pollPower(), adapter.pollPower(), adapter.pollPower()]);
    assert.equal(w.s.bmcMaxOpen, 1);
    assert.equal(w.s.bmcReads - before, 2);

    // Gone (Warden moved to hardware without a BMC): the device goes, quietly.
    w.s.bmc = { available: false, error: 'no BMC found' };
    await adapter.pollPower();
    assert.equal(t.hub.reg.get(ROUTER_ID), undefined);
    assert.equal(adapter.status().ok, true);
    assert.doesNotMatch(adapter.status().note ?? '', /router|pair/i);
  } finally { await close(); }
});

test('Warden: no BMC for this token or this Warden is quiet; a token without network:read is told to pair again', { timeout: 20_000 }, async () => {
  // Before 1.041, Warden refuses paired tokens: nothing to show, nothing to fix.
  {
    const { w, t, adapter, start, close } = await setup();
    try {
      w.s.bmcStatus = 403; w.s.version = '1.040';
      await start(); await adapter.pollPower(); await adapter.poll();
      assert.equal(t.hub.reg.get(ROUTER_ID), undefined);
      assert.equal(adapter.status().ok, true);
      assert.doesNotMatch(adapter.status().note ?? '', /pair/i);
      // An older Warden without the endpoint at all.
      w.s.bmcStatus = 404;
      await adapter.pollPower();
      assert.doesNotMatch(adapter.status().note ?? '', /pair/i);
    } finally { await close(); }
  }
  // 1.041 or later and still 403: the token doesn't have network:read.
  {
    const { w, t, adapter, start, close } = await setup();
    try {
      w.s.bmcStatus = 403; w.s.version = '1.728';
      await start(); await adapter.pollPower(); await adapter.poll();
      assert.equal(t.hub.reg.get(ROUTER_ID), undefined);
      assert.equal(adapter.status().ok, true, 'the rest of Warden still works');
      assert.match(adapter.status().note ?? '', /Pair with Warden again so Kova can show the router’s power/);
      // Paired again with network:read and Warden 1.041: it shows.
      w.s.bmcStatus = 200; w.s.bmc = healthy();
      await adapter.pollPower();
      assert.ok(t.hub.reg.get(ROUTER_ID));
      assert.doesNotMatch(adapter.status().note ?? '', /pair/i);
    } finally { await close(); }
  }
  // Scopes from pairing that include network:read: a 403 is an older Warden, whatever its version says.
  {
    const { w, adapter, start, close } = await setup({ scopes: ['devices:read', 'network:read'] });
    try {
      w.s.bmcStatus = 403; w.s.version = '1.728';
      await start(); await adapter.pollPower(); await adapter.poll();
      assert.doesNotMatch(adapter.status().note ?? '', /pair/i);
    } finally { await close(); }
  }
  // Scopes from pairing without network:read.
  {
    const { w, adapter, start, close } = await setup({ scopes: ['devices:read', 'events'] });
    try {
      w.s.bmcStatus = 403; w.s.version = '1.041';
      await start(); await adapter.pollPower(); await adapter.poll();
      assert.match(adapter.status().note ?? '', /network:read/);
    } finally { await close(); }
  }
});

test('Warden: a power supply fails and recovers: events, Activity, the alert and its push, automations, Ask Kova', { timeout: 30_000 }, async () => {
  const { w, t, adapter, start, close } = await setup({ feed: true });
  const ntfy = await fakeNtfy();
  const dir = mkdtempSync(join(tmpdir(), 'kova-warden-power-'));
  const notifier = new Notifier(t.hub, { ntfy: { url: ntfy.url, topic: 'kova' }, checkSec: 0 }, { dataDir: dir });
  const app = await buildServer(t.hub, { webRoot });
  try {
    w.s.bmc = healthy();
    await start();
    await adapter.pollPower();
    await until('feed connected', () => w.s.streams.length === 1);
    notifier.start();
    assert.ok(!t.hub.insights.current().some(i => i.id.startsWith('power:')), 'healthy: no alert');

    const events: { type: string; data: Record<string, unknown> }[] = [];
    t.hub.reg.on('event', e => { if (e.device.id === ROUTER_ID) events.push({ type: e.type, data: e.data }); });
    // Automations: one on the failure, one on the power drawn.
    const add = async (a: object) => {
      const r = await app.inject({ method: 'POST', url: '/api/automations', payload: { mode: 'single', conditions: [], ...a } });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().id as string;
    };
    const failed = await add({ name: 'Router lost a supply', triggers: [{ kind: 'event', device: ROUTER_ID, event: 'power-supply-failed' }], actions: [{ kind: 'set', targets: { lamp: { on: true } } }] });
    const hungry = await add({ name: 'Router drawing a lot', triggers: [{ kind: 'numeric', device: ROUTER_ID, field: 'power', above: 300 }], actions: [{ kind: 'set', targets: { office_light: { on: true } } }] });
    const words = (await app.inject({ url: '/api/state' })).json().automations.find((a: { id: string }) => a.id === failed);
    assert.match(JSON.stringify(words), /Router power supply failed/);

    // Supply 1 loses its input: the feed says so, and the BMC agrees when Kova reads it again.
    w.s.bmc = { ...healthy(), powerSupplies: [{ name: 'Power supply 1', present: true, ok: false, problem: 'no input power' }, { name: 'Power supply 2', present: true, ok: true }], powerRedundancy: 'lost' };
    const reads = w.s.bmcReads;
    w.publish('power.supply_changed', { name: 'Power supply 1', ok: false, problem: 'no input power', redundancy: 'lost', watts: 268 });
    await until('failed event', () => events.some(e => e.type === 'power-supply-failed'));
    await until('read once more', () => w.s.bmcReads === reads + 1);
    await settle();
    assert.deepEqual(events.map(e => e.type), ['power-supply-changed', 'power-supply-failed'], 'once, though the read after the event saw it too');
    assert.deepEqual(events[0].data, { name: 'Power supply 1', ok: false, problem: 'no input power', redundancy: 'lost', watts: 268, title: 'Power supply 1 has no input power', body: 'Redundancy lost. Drawing 268 W.' });
    const r = t.hub.reg.get(ROUTER_ID)!.state;
    assert.deepEqual([r.supplies?.[0], r.redundancy], [{ name: 'Power supply 1', present: true, ok: false, problem: 'no input power' }, 'lost']);
    assert.equal(t.dev('lamp').on, true, 'the automation on power-supply-failed ran');
    assert.equal(t.hub.engine.automations.history(failed)[0].why, 'Router: power supply failed');
    const activity = t.hub.store.feed(40).map(e => e.what);
    assert.equal(activity.filter(x => /^Router: /.test(x)).length, 1, activity.join('\n'));
    assert.ok(activity.includes('Router: Power supply 1 has no input power'));

    // The alert, on the Now page and pushed to phones once.
    const alert = t.hub.insights.current().find(i => i.id.startsWith('power:'))!;
    assert.deepEqual([alert.level, alert.title, alert.detail, alert.device], ['alert', 'Router power supply 1 has no input power — redundancy lost', 'Power supply 2 is OK, so it’s still running. Drawing 268 W.', ROUTER_ID]);
    await notifier.idle();
    await until('pushed', () => ntfy.got.some(n => n.title === alert.title));
    t.hub.insights.current();
    await notifier.idle();
    assert.equal(ntfy.got.filter(n => n.title === alert.title).length, 1, 'once, not on every look');
    const snapIns = (await app.inject({ url: '/api/state' })).json().insights;
    assert.ok(snapIns.some((i: { title: string }) => i.title === alert.title));

    // Ask Kova, built in and in the AI's context.
    const ok = await t.hub.assistant.ask('Is the router OK?');
    assert.match(ok.text, /^Not quite: Router power supply 1 has no input power — redundancy lost\. It’s drawing 268 W\./);
    assert.match(ok.text, /Inlet Temp 24°C/);
    const watts = await t.hub.assistant.ask('How much power is the router using?');
    assert.match(watts.text, /drawing 268 W/);
    const ctx = new AiAssistant(t.hub.engine, t.hub.reg, t.hub.config, t.hub.store).buildContext({ names: true, rooms: true, history: false, presence: false, cameras: false, security: false });
    const line = ctx.text.split('\n').find(l => l.includes(`"${ROUTER_ID}"`))!;
    assert.match(line, /"watts":268/);
    assert.match(line, /"Power supply 1: no input power"/);
    assert.match(line, /"redundancy":"lost"/);

    // Snoozed: not shown, not pushed again. Then supply 2 is predicted to fail as well: that's news.
    t.hub.insights.snooze(alert.id);
    assert.ok(!t.hub.insights.current().some(i => i.id === alert.id));
    w.s.bmc = { ...w.s.bmc, powerSupplies: [{ name: 'Power supply 1', present: true, ok: false, problem: 'no input power' }, { name: 'Power supply 2', present: true, ok: false, problem: 'predicted to fail' }] };
    events.length = 0;
    await adapter.pollPower();
    assert.deepEqual(events.map(e => e.type), ['power-supply-changed', 'power-supply-failed'], 'seen by a read, without the feed');
    await notifier.idle();
    const worse = 'Router power supply 1 has no input power, power supply 2 is predicted to fail — redundancy lost';
    await until('pushed again', () => ntfy.got.some(n => n.title === worse));

    // The power drawn is a reading automations compare.
    w.s.bmc = { ...w.s.bmc, powerWatts: 320 };
    await adapter.pollPower();
    await settle();
    assert.equal(t.dev('office_light').on, true, 'numeric trigger on the router’s power');
    assert.match(t.hub.engine.automations.history(hungry)[0].why, /Router power went above 300 \(320\)/);

    // Both come back: restored events, the alert goes, and a phone hears it's back to normal.
    w.s.bmc = healthy();
    events.length = 0;
    w.publish('power.supply_changed', { name: 'Power supply 1', ok: true, redundancy: 'full', watts: 270 });
    await until('restored', () => events.some(e => e.type === 'power-supply-restored'));
    await adapter.pollPower();
    await settle();
    assert.deepEqual(events.map(e => [e.type, e.data.name]), [['power-supply-changed', 'Power supply 1'], ['power-supply-restored', 'Power supply 1'], ['power-supply-changed', 'Power supply 2'], ['power-supply-restored', 'Power supply 2']]);
    assert.ok(!t.hub.insights.current().some(i => i.id.startsWith('power:')));
    await notifier.idle();
    assert.equal(ntfy.got.at(-1)!.title, 'Router power is back to normal');
    assert.equal(ntfy.got.filter(n => n.title === 'Router power is back to normal').length, 1, 'once, when nothing is wrong any more');
    assert.match((await t.hub.assistant.ask('is the router ok')).text, /^The router is OK\. It’s drawing 268 W\./);
  } finally {
    await notifier.stop();
    await app.close();
    await ntfy.close();
    await close();
  }
});
