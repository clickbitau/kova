import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { SmartThingsAdapter, exchangeSmartThingsCode, fromStInput, isSoundbar, smartThingsAuthUrl, toStInput } from '../src/adapters/smartthings.ts';
import { HelixAutoSwitch, autoSwitchOn } from '../src/services/helix-autoswitch.ts';
import type { HelixScreen } from '../src/services/helix-link.ts';
import type { Adapter, AdapterContext } from '../src/adapters/sdk.ts';
import type { Command, Device } from '../src/model/types.ts';

const you = { kind: 'user' as const, label: 'You' };

/** SmartThings: a Q930B soundbar and a fridge, its status, commands, and OAuth that replaces the refresh token on every use. */
async function fakeSmartThings() {
  const bar = { switch: 'off', volume: 12, mute: 'unmuted', input: 'digital' };
  const commands: any[] = [];
  const tokens: { grant: string; refresh?: string; code?: string; auth?: string }[] = [];
  let refresh = 'r1', access = 'a0', n = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/oauth/token') {
        const f = new URLSearchParams(body);
        tokens.push({ grant: f.get('grant_type')!, refresh: f.get('refresh_token') ?? undefined, code: f.get('code') ?? undefined, auth: req.headers.authorization });
        if (f.get('grant_type') === 'authorization_code') return send(200, { access_token: 'a-code', refresh_token: 'r1', expires_in: 86399 });
        if (f.get('refresh_token') !== refresh) return send(400, { error: 'invalid_grant' });
        refresh = `r${++n}`; access = `a${n}`;
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 86399 });
      }
      if (req.headers.authorization !== `Bearer ${access}`) return send(401, { error: { message: 'token expired' } });
      if (u.pathname === '/v1/devices') {
        return send(200, { items: [
          { deviceId: '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab', label: 'Soundbar Q930B', name: 'Samsung Soundbar', ocf: { deviceType: 'oic.d.networkaudio', modelNumber: 'HW-Q930B|0000' }, components: [{ id: 'main', capabilities: [{ id: 'switch' }, { id: 'audioVolume' }, { id: 'audioMute' }, { id: 'mediaInputSource' }, { id: 'execute' }] }] },
          { deviceId: 'fridge-1', label: 'Fridge', components: [{ id: 'main', capabilities: [{ id: 'switch' }] }] },
        ] });
      }
      if (/\/status$/.test(u.pathname)) {
        return send(200, { components: { main: { switch: { switch: { value: bar.switch } }, audioVolume: { volume: { value: bar.volume } }, audioMute: { mute: { value: bar.mute } }, mediaInputSource: { inputSource: { value: bar.input } } } } });
      }
      if (/\/commands$/.test(u.pathname) && req.method === 'POST') {
        const j = JSON.parse(body);
        for (const c of j.commands) {
          commands.push(c);
          if (c.capability === 'switch') bar.switch = c.command;
          if (c.command === 'setVolume') bar.volume = c.arguments[0];
          if (c.command === 'volumeUp') bar.volume += 1;
          if (c.command === 'volumeDown') bar.volume -= 1;
          if (c.capability === 'audioMute') bar.mute = c.command === 'mute' ? 'muted' : 'unmuted';
          if (c.command === 'setInputSource') bar.input = c.arguments[0];
        }
        return send(200, { results: j.commands.map(() => ({ status: 'ACCEPTED' })) });
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, bar, commands, tokens, expire: () => { access = 'gone'; }, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

test('Samsung soundbar through SmartThings: found on the account, read, and power, input, volume, steps, mute, sound and night mode', async () => {
  const st = await fakeSmartThings();
  const dir = mkdtempSync(join(tmpdir(), 'kova-st-'));
  const reg = new Registry(new Store(':memory:'));
  const adapter = new SmartThingsAdapter({ clientId: 'cid', clientSecret: 'secret', refreshToken: 'r1', storageDir: dir, apiUrl: `${st.url}/v1`, tokenUrl: `${st.url}/oauth/token`, pollSec: 0, rooms: { 'Soundbar Q930B': 'lounge' } });
  try {
    await reg.addAdapter(adapter);
    // Only the soundbar, in its room, with what it can do; its state read back (eARC/optical is "tv").
    const ids = reg.list().map(d => d.id);
    assert.deepEqual(ids, ['soundbar_6f1c2d3eaaaa']);
    const id = ids[0];
    const d = reg.get(id)!;
    assert.equal(d.room, 'lounge');
    assert.equal(d.integration, 'Samsung soundbar · HW-Q930B');
    assert.deepEqual(d.capabilities, ['onoff', 'volume', 'mute', 'input', 'sound']);
    assert.deepEqual({ on: d.state.on, vol: d.state.vol, muted: d.state.muted, input: d.state.input }, { on: false, vol: 12, muted: false, input: 'tv' });
    // The refresh token SmartThings replaced is kept, owner-only, and used next time.
    assert.equal(st.tokens[0].auth, `Basic ${Buffer.from('cid:secret').toString('base64')}`);
    const kept = join(dir, 'token.json');
    assert.equal(JSON.parse(readFileSync(kept, 'utf8')).refreshToken, 'r2');
    assert.equal(statSync(kept).mode & 0o777, 0o600);

    // On and to its HDMI in, in one call, on first.
    await reg.command(id, { on: true, input: 'hdmi1' }, you);
    assert.deepEqual(st.commands.splice(0).map(c => [c.capability, c.command, ...(c.arguments ?? [])]), [['switch', 'on'], ['mediaInputSource', 'setInputSource', 'HDMI1']]);
    // Volume, a step up (read back), mute.
    await reg.command(id, { vol: 20 }, you);
    await reg.command(id, { volStep: 1 }, you);
    assert.equal(reg.get(id)!.state.vol, 21);
    await reg.command(id, { muted: true }, you);
    // Sound mode and night mode through the soundbar's execute capability.
    await reg.command(id, { sound: 'surround', night: true }, you);
    assert.deepEqual(st.commands.splice(0).map(c => [c.capability, c.command, ...(c.arguments ?? [])]), [
      ['audioVolume', 'setVolume', 20], ['audioVolume', 'volumeUp'], ['audioMute', 'mute'],
      ['execute', 'execute', '/sec/networkaudio/soundmode', { 'x.com.samsung.networkaudio.soundmode': 'surround' }],
      ['execute', 'execute', '/sec/networkaudio/advancedaudio', { 'x.com.samsung.networkaudio.nightmode': 1 }],
    ]);
    // A step is momentary: never kept as state.
    assert.equal('volStep' in reg.get(id)!.state, false);
    // The access token ran out: a fresh one, with the kept refresh token, and the command goes through.
    st.expire();
    await reg.command(id, { input: 'tv' }, you);
    assert.equal(st.bar.input, 'digital');
    assert.equal(st.tokens.at(-1)!.refresh, 'r2');
    // Polling keeps the sound mode Kova set (SmartThings can't say it).
    await adapter['poll']();
    assert.deepEqual({ sound: reg.get(id)!.state.sound, night: reg.get(id)!.state.night, input: reg.get(id)!.state.input, muted: reg.get(id)!.state.muted }, { sound: 'surround', night: true, input: 'tv', muted: true });
  } finally {
    await reg.stop();
    await st.close();
  }
});

test('SmartThings linking, inputs and what counts as a soundbar', async () => {
  const st = await fakeSmartThings();
  try {
    const url = new URL(smartThingsAuthUrl({ clientId: 'cid' }));
    assert.equal(url.origin + url.pathname, 'https://api.smartthings.com/oauth/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: 'cid', response_type: 'code', redirect_uri: 'https://httpbin.org/get', scope: 'r:devices:* x:devices:*' });
    assert.deepEqual(await exchangeSmartThingsCode({ code: 'abc', clientId: 'cid', clientSecret: 'secret', tokenUrl: `${st.url}/oauth/token` }), { refreshToken: 'r1' });
    assert.equal(st.tokens[0].code, 'abc');
  } finally { await st.close(); }
  assert.deepEqual(['tv', 'hdmi1', 'hdmi2', 'bluetooth', 'wifi'].map(toStInput), ['digital', 'HDMI1', 'HDMI2', 'bluetooth', 'wifi']);
  assert.deepEqual(['digital', 'HDMI1', 'arc', 'BLUETOOTH', 'usb'].map(fromStInput), ['tv', 'hdmi1', 'tv', 'bluetooth', 'usb']);
  assert.equal(isSoundbar({ deviceId: 'x', label: 'Lounge speaker', components: [{ id: 'main', capabilities: [{ id: 'switch' }] }] }), false);
  assert.equal(isSoundbar({ deviceId: 'x', label: 'Samsung HW-Q930B', components: [{ id: 'main', capabilities: [{ id: 'audioVolume' }] }] }), true);
  assert.equal(autoSwitchOn(undefined), true);
  assert.equal(autoSwitchOn('off'), false);
  assert.equal(autoSwitchOn(false), false);
});

/** A TV, a soundbar and a Helix box in the lounge, recording what they were asked. */
class Lounge implements Adapter {
  id = 'lounge'; name = 'Lounge'; icon = 'tv'; kind = 'Local' as const;
  got: { id: string; cmd: Command; by?: string }[] = [];
  ctx!: AdapterContext;
  tvReady = true;
  async start(ctx: AdapterContext) {
    this.ctx = ctx;
    ctx.announce([
      { id: 'lounge_tv', name: 'S90D', room: 'lounge', type: 'tv', capabilities: ['onoff', 'input'], integration: 'Samsung', address: '10.0.0.20', state: { on: false, online: true } },
      { id: 'lounge_bar', name: 'Soundbar', room: 'lounge', type: 'media', capabilities: ['onoff', 'volume', 'mute', 'input', 'sound'], integration: 'Samsung soundbar', address: 'st-1', state: { on: false, online: true, input: 'bluetooth' } },
    ]);
  }
  async stop() {}
  status() { return { ok: true }; }
  async command(d: Device, cmd: Command) {
    this.got.push({ id: d.id, cmd });
    if (d.id === 'lounge_tv' && cmd.input && !this.tvReady) { this.tvReady = true; throw new Error('S90D is off'); }
    if (d.id === 'lounge_tv' && cmd.input) return { input: null };
  }
}
/** Helix boxes come from the helix adapter; this one stands in for it. */
class Boxes implements Adapter {
  id = 'helix'; name = 'Helix'; icon = 'movie'; kind = 'Local' as const;
  ctx!: AdapterContext;
  async start(ctx: AdapterContext) { this.ctx = ctx; ctx.announce([{ id: 'helix_kam', name: 'kam-lx', room: 'lounge', type: 'tv', capabilities: ['onoff', 'pause'], integration: 'Helix', address: 'kam-lx', state: { online: true } }]); }
  async stop() {}
  status() { return { ok: true }; }
  async command() {}
}

test('Auto-switch when Helix plays: TV on and to the box, soundbar on and to where the sound goes; an input chosen by hand is left alone', async () => {
  const reg = new Registry(new Store(':memory:'));
  const lounge = new Lounge(), boxes = new Boxes();
  await reg.addAdapter(lounge);
  await reg.addAdapter(boxes);
  const screens: HelixScreen[] = [{ playerId: 'kam-lx', tvDeviceId: 'lounge_tv', tvName: 'S90D', helixInput: 'hdmi2', inputs: [], soundbarDeviceId: 'lounge_bar', soundbarHelixInput: 'hdmi1' }];
  let enabled = true;
  const sw = new HelixAutoSwitch({ reg } as never, { screens: () => screens, enabled: () => enabled, tvWakeMs: 5 });
  sw.start();
  const settle = () => new Promise(r => setTimeout(r, 60));
  const cmds = () => lounge.got.splice(0).map(g => [g.id, g.cmd]);
  try {
    // A film starts with the TV off and its sound on eARC: TV on, then to HDMI 2 (it takes a moment to wake); soundbar on and to the TV.
    lounge.tvReady = false;
    boxes.ctx.event('helix_kam', 'video-started', { title: 'Dune', route: 'earc' });
    await settle();
    assert.deepEqual(cmds(), [['lounge_tv', { on: true }], ['lounge_bar', { on: true, input: 'tv' }], ['lounge_tv', { input: 'hdmi2' }], ['lounge_tv', { input: 'hdmi2' }]]);
    // Mid-film the box moves the sound to the soundbar's HDMI in (DTS): only the soundbar moves.
    boxes.ctx.event('helix_kam', 'audio-route', { route: 'soundbar' });
    await settle();
    assert.deepEqual(cmds(), [['lounge_bar', { input: 'hdmi1' }]]);
    // Someone puts the TV on the console during playback: on resume, the TV is left on their input; nothing else needs doing.
    await reg.command('lounge_tv', { input: 'hdmi3' }, you);
    cmds();
    boxes.ctx.event('helix_kam', 'resumed', { title: 'Dune' });
    await settle();
    assert.deepEqual(cmds(), []);
    // Playback stopped: the next film switches again.
    boxes.ctx.event('helix_kam', 'stopped', {});
    boxes.ctx.event('helix_kam', 'video-started', { title: 'Arrival', route: 'earc' });
    await settle();
    // (The TV and the soundbar are switched at the same time, so in either order.)
    assert.deepEqual(cmds().sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [['lounge_bar', { input: 'tv' }], ['lounge_tv', { input: 'hdmi2' }]]);
    // Switched off in settings: nothing.
    enabled = false;
    boxes.ctx.event('helix_kam', 'stopped', {});
    boxes.ctx.event('helix_kam', 'video-started', { title: 'Heat', route: 'soundbar' });
    await settle();
    assert.deepEqual(cmds(), []);
    // Its own changes are logged as Auto-switch, quietly (no device feed entries).
    const store = (reg as unknown as { store: Store }).store;
    assert.equal(store.lastStateChange('lounge_bar')?.cause.id, 'helix-autoswitch');
    assert.deepEqual(store.feed(100).filter(e => e.cause.id === 'helix-autoswitch'), []);
  } finally {
    sw.stop();
    await reg.stop();
  }
});
