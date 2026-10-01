import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { HelixAdapter } from '../src/adapters/helix.ts';
import { ScreenNotices, SnapLinks } from '../src/services/screen-notices.ts';
import type { Adapter, AdapterContext, Snapshot } from '../src/adapters/sdk.ts';
import type { Device } from '../src/model/types.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

/** Helix with two boxes; it records the cards it was asked to show instead of calling the server. */
class Boxes extends HelixAdapter {
  shown: { box: string; n: { title: string; body?: string; imageUrl?: string; seconds?: number } }[] = [];
  constructor() { super({ url: 'http://helix.invalid:8090', token: 'hxd_x' }); }
  async start(ctx: AdapterContext) {
    ctx.announce([
      { id: 'lounge_helix', name: 'kam-lx', room: 'lounge', type: 'tv', capabilities: ['onoff', 'pause'], integration: 'Helix', address: 'kam-lx', state: { on: true, online: true, media: 'Dune' } },
      { id: 'bed_helix', name: 'Bedroom Helix', room: 'bedroom', type: 'tv', capabilities: ['onoff'], integration: 'Helix', address: 'bed', state: { on: false, online: true } },
    ]);
    ctx.report('lounge_helix', { on: true, online: true, media: 'Dune' });
  }
  async stop() {}
  async notice(d: Device, n: { title: string; body?: string; imageUrl?: string; seconds?: number }) { this.shown.push({ box: d.id, n }); }
}

/** A doorbell with a snapshot. */
class Bell implements Adapter {
  id = 'bell'; name = 'Bell'; icon = 'doorbell'; kind = 'Local' as const;
  async start(ctx: AdapterContext) { ctx.announce([{ id: 'front_bell', name: 'Front doorbell', room: 'entry', type: 'camera', capabilities: ['events'], integration: 'Nest', address: 'nest-1' }]); }
  async stop() {}
  status() { return { ok: true }; }
  async command() {}
  async snapshot(): Promise<Snapshot> { return { contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }; }
}

test('The doorbell on the TV: a card with its snapshot on every Helix screen that’s on, through a one-picture link', async () => {
  const t = await testHub(19);
  const boxes = new Boxes(), bell = new Bell();
  await t.hub.reg.addAdapter(boxes);
  await t.hub.reg.addAdapter(bell);
  let now = 1_000_000;
  const links = new SnapLinks(120_000, () => now);
  const notices = new ScreenNotices(t.hub, { links, kovaUrl: () => 'http://10.0.0.5:8140' });
  notices.start();
  const app = await buildServer(t.hub, { webRoot, token: 'master', snapLinks: links });
  try {
    t.hub.reg.deviceEvent('front_bell', 'ring');
    for (let i = 0; i < 50 && !boxes.shown.length; i++) await new Promise(r => setTimeout(r, 10));
    // Only the screen that's on, with who rang and a picture link.
    assert.equal(boxes.shown.length, 1);
    const { box, n } = boxes.shown[0];
    assert.equal(box, 'lounge_helix');
    assert.equal(n.body, 'Front doorbell rang.');
    assert.equal(n.seconds, 15);
    assert.match(n.imageUrl!, /^http:\/\/10\.0\.0\.5:8140\/api\/snap\/[0-9a-f]{32}$/);
    // Helix fetches it with no token: that picture only.
    const path = new URL(n.imageUrl!).pathname;
    const pic = await app.inject({ method: 'GET', url: path });
    assert.equal(pic.statusCode, 200);
    assert.equal(pic.headers['content-type'], 'image/jpeg');
    assert.deepEqual(pic.rawPayload, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    // A made-up key, or the link two minutes on, opens nothing; the rest of the API still needs the token.
    assert.equal((await app.inject({ method: 'GET', url: `/api/snap/${'0'.repeat(32)}` })).statusCode, 404);
    now += 121_000;
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/state' })).statusCode, 401);
    // Nothing on: no card.
    t.hub.reg.devices.get('lounge_helix')!.state.on = false;
    t.hub.reg.deviceEvent('front_bell', 'ring');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(boxes.shown.length, 1);
  } finally {
    notices.stop();
    await app.close();
    await t.hub.stop();
  }
});
