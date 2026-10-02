import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';
import type { Command, Device, DeviceState } from '../src/model/types.ts';
import { combineIdeas, mergeState, routeCommand } from '../src/adapters/combined.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

/** One device through one integration, recording what it's asked to do. */
class One implements Adapter {
  kind = 'Cloud' as const; icon = 'speaker'; ctx!: AdapterContext; got: Command[] = [];
  constructor(public id: string, public name: string, private dev: { id: string; name: string; capabilities: string[]; state: DeviceState }) {}
  async start(ctx: AdapterContext) { this.ctx = ctx; ctx.announce([{ ...this.dev, room: 'lounge', type: 'media', integration: this.name, address: this.dev.id, capabilities: this.dev.capabilities as never }]); }
  async stop() {}
  status() { return { ok: true }; }
  async command(_d: Device, cmd: Command) { this.got.push(cmd); this.ctx.report(this.dev.id, cmd as DeviceState); }
}

test('a soundbar reached through two integrations becomes one device: each part of a command goes to the one that can do it', async () => {
  const t = await testHub(12);
  const bar = new One('smartthings', 'Samsung SmartThings', { id: 'st_bar', name: 'Samsung Soundbar Q930B', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'], state: { on: false, vol: 12, input: 'tv' } });
  const cast = new One('cast', 'Google Cast', { id: 'cast_bar', name: 'Soundbar', capabilities: ['onoff', 'media', 'volume', 'pause'], state: { on: false, media: null } });
  await t.hub.reg.addAdapter(bar);
  await t.hub.reg.addAdapter(cast);
  const app = await buildServer(t.hub, { webRoot });
  try {
    // Suggested, with the integration that switches and picks inputs first.
    let s = (await app.inject({ url: '/api/state' })).json();
    const idea = s.combineIdeas.find((i: { members: string[] }) => i.members.includes('st_bar'));
    assert.deepEqual([idea.name, idea.members], ['Samsung Soundbar Q930B', ['st_bar', 'cast_bar']]);
    assert.match(idea.why, /through Samsung SmartThings .* through Google Cast/);

    let r = await app.inject({ method: 'POST', url: '/api/combined', payload: { name: idea.name, members: idea.members } });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().deviceId as string;
    const d = t.hub.reg.get(id)!;
    assert.deepEqual(d.capabilities.sort(), ['input', 'media', 'mute', 'onoff', 'pause', 'sound', 'volume']);
    // The two originals are hidden; the combined one shows; no longer suggested.
    s = (await app.inject({ url: '/api/state' })).json();
    assert.deepEqual(['st_bar', 'cast_bar'].map(m => t.hub.config.get().devices?.[m]?.hidden), [true, true]);
    assert.equal(s.combineIdeas.filter((i: { members: string[] }) => i.members.includes('st_bar')).length, 0);

    // On and to HDMI 1: SmartThings. Music: Cast. Pause: Cast. Volume and sound mode: SmartThings.
    await t.hub.reg.command(id, { on: true, input: 'hdmi1' }, { kind: 'user', label: 'You' });
    await t.hub.reg.command(id, { on: true, media: 'Radio' }, { kind: 'user', label: 'You' });
    await t.hub.reg.command(id, { paused: true }, { kind: 'user', label: 'You' });
    await t.hub.reg.command(id, { vol: 25, sound: 'surround' }, { kind: 'user', label: 'You' });
    assert.deepEqual(bar.got, [{ on: true, input: 'hdmi1' }, { vol: 25, sound: 'surround' }]);
    assert.deepEqual(cast.got, [{ on: true, media: 'Radio' }, { paused: true }]);
    // Its state: each field from the one that owns it.
    const st = t.hub.reg.get(id)!.state;
    assert.deepEqual({ on: st.on, input: st.input, media: st.media, paused: st.paused, vol: st.vol, sound: st.sound }, { on: true, input: 'hdmi1', media: 'Radio', paused: true, vol: 25, sound: 'surround' });
    // Off: the soundbar is switched off (SmartThings).
    await t.hub.reg.command(id, { on: false }, { kind: 'user', label: 'You' });
    assert.deepEqual(bar.got.at(-1), { on: false });

    // Checked: one device can't be in two combined devices.
    r = await app.inject({ method: 'POST', url: '/api/combined', payload: { members: ['st_bar', 'lamp'] } });
    assert.match(r.json().error, /already part of another/);
    // Separated: the originals show again; undo brings it back.
    r = await app.inject({ method: 'DELETE', url: `/api/combined/${id.replace(/^combined_/, '')}` });
    assert.equal(t.hub.config.get().devices?.st_bar?.hidden, undefined);
    assert.equal(t.hub.reg.get(id), undefined);
    await app.inject({ method: 'POST', url: `/api/undo/${r.json().undo}` });
    assert.ok(t.hub.reg.get(id));
  } finally { await app.close(); await t.hub.stop(); }
});

test('combined devices: routing, merged state, and which devices look like one', () => {
  const dev = (id: string, adapter: string, caps: string[], state: DeviceState, name = id, room = 'lounge', type = 'media'): Device => ({ id, name, room, type, adapter, capabilities: caps, state, integration: adapter, address: id } as Device);
  const tv = dev('tv', 'samsungtv', ['onoff', 'volume', 'input'], { on: true, input: 'hdmi4', vol: 10 }, 'Bedroom Oled (QA55S90DAWXXY)', 'bedroom', 'tv');
  const cast = dev('c', 'cast', ['onoff', 'media', 'volume', 'pause'], { on: false, media: null }, 'Bedroom Oled', 'bedroom', 'tv');
  assert.deepEqual([...routeCommand({ on: false }, [tv, cast])], [['tv', { on: false }]]);
  assert.deepEqual([...routeCommand({ on: true, media: 'Radio', vol: 30 }, [tv, cast])], [['c', { media: 'Radio', on: true }], ['tv', { vol: 30 }]]);
  assert.deepEqual(mergeState([tv, cast]), { input: 'hdmi4', vol: 10, media: null, on: true, online: true });

  const ideas = combineIdeas([tv, cast, dev('k', 'cast', ['onoff', 'media'], {}, 'Kitchen speaker'), dev('s', 'sonos', ['onoff', 'media'], {}, 'Kitchen', 'kitchen')], [], [], () => false);
  assert.deepEqual(ideas.map(i => [i.name, i.members]), [['Bedroom Oled', ['tv', 'c']]], 'a speaker and a Sonos called "Kitchen…" share only a generic word');
  assert.deepEqual(combineIdeas([tv, cast], [], ['idea:combine:c+tv'], () => false), [], 'dismissed');
});
