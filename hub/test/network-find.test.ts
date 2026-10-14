import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';

// A device that moved (the router gave it a new IP) is found again through Warden, by the MAC noted while it worked.

const fakeWarden = () => ({
  id: 'warden', name: 'Warden', icon: 'router', kind: 'Local' as const,
  byIp: new Map([['10.0.30.128', { mac: '00:33:7a:aa:b1:55' }]]),
  byMac: new Map([['00:33:7a:aa:b1:55', { ips: ['10.0.30.128'], online: true }]]),
  start: async () => {}, stop: async () => {}, command: async () => {}, status: () => ({ ok: true }),
});

test('Network: the MAC behind an address is noted while it works, and its new address found when it moves', async () => {
  const store = new Store(':memory:');
  const reg = new Registry(store);
  const w = fakeWarden();
  await reg.addAdapter(w as unknown as Adapter);
  let ctx!: AdapterContext;
  await reg.addAdapter({ id: 'tuya', name: 'Tuya', icon: 'x', kind: 'Local', start: async c => { ctx = c; }, stop: async () => {}, command: async () => {}, status: () => ({ ok: true }) });
  ctx.network!.seen('gw', '10.0.30.128');
  assert.equal(ctx.network!.where('gw', '10.0.30.128'), null, 'still where it was');
  // The router moves it, and Warden's table says so.
  w.byIp = new Map([['10.0.30.145', { mac: '00:33:7a:aa:b1:55' }]]);
  w.byMac.set('00:33:7a:aa:b1:55', { ips: ['10.0.30.145'], online: true });
  assert.equal(ctx.network!.where('gw', '10.0.30.128'), '10.0.30.145');
  assert.deepEqual(store.get('netMacs'), { 'tuya:gw': '00:33:7a:aa:b1:55' }, 'kept across restarts');
  // Offline in Warden: no guess.
  w.byMac.set('00:33:7a:aa:b1:55', { ips: ['10.0.30.145'], online: false });
  assert.equal(ctx.network!.where('gw', '10.0.30.128'), null);
  // A device never seen working: none.
  assert.equal(ctx.network!.where('other', '10.0.30.9'), null);
  await reg.stop();
});
