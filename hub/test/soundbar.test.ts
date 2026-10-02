import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { SmartThingsAdapter, createSmartThingsApp, exchangeSmartThingsCode, fromStInput, fromTvSource, isSoundbar, smartThingsAuthUrl, toStInput, toTvSource } from '../src/adapters/smartthings.ts';

const you = { kind: 'user' as const, label: 'You' };

/** SmartThings: a Q930B soundbar and a fridge, its status, commands, and OAuth that replaces the refresh token on every use. */
async function fakeSmartThings() {
  const bar = { switch: 'off', volume: 12, mute: 'unmuted', input: 'digital' };
  const tv = { input: 'dtv' };
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
          { deviceId: 'tv-s90d', label: '65" S90D', ocf: { deviceType: 'oic.d.tv', modelNumber: 'QA65S90DAWXXY|20240101' }, components: [{ id: 'main', capabilities: [{ id: 'switch' }, { id: 'samsungvd.mediaInputSource' }, { id: 'tvChannel' }] }] },
        ] });
      }
      if (u.pathname === '/v1/devices/tv-s90d/status') {
        return send(200, { components: { main: { 'samsungvd.mediaInputSource': { inputSource: { value: tv.input }, supportedInputSourcesMap: { value: [{ id: 'dtv', name: 'TV' }, { id: 'HDMI1', name: 'HDMI 1' }, { id: 'HDMI2', name: 'Helix' }, { id: 'HDMI3', name: 'HDMI 3' }] } } } } });
      }
      if (u.pathname === '/v1/devices/tv-s90d/commands' && req.method === 'POST') {
        const j = JSON.parse(body);
        for (const c of j.commands) { commands.push({ tv: true, ...c }); if (c.command === 'setInputSource') tv.input = c.arguments[0]; }
        return send(200, { results: [] });
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
  return { url, bar, tv, commands, tokens, expire: () => { access = 'gone'; }, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
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
    assert.deepEqual(ids, ['soundbar_6f1c2d3eaaaa', 'smarttv_tvs90d']);
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
    const link = smartThingsAuthUrl({ clientId: 'cid' });
    assert.ok(!link.includes('*') && link.endsWith('x%3Adevices%3A%2A'), 'no bare "*" at the end to lose when copied');
    const url = new URL(link);
    assert.equal(url.origin + url.pathname, 'https://api.smartthings.com/oauth/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: 'cid', response_type: 'code', redirect_uri: 'https://httpbin.org/get', scope: 'r:devices:* x:devices:*' });
    assert.deepEqual(await exchangeSmartThingsCode({ code: 'abc', clientId: 'cid', clientSecret: 'secret', tokenUrl: `${st.url}/oauth/token` }), { refreshToken: 'r1' });
    assert.equal(st.tokens[0].code, 'abc');
  } finally { await st.close(); }
  assert.deepEqual(['tv', 'hdmi1', 'hdmi2', 'bluetooth', 'wifi'].map(toStInput), ['digital', 'HDMI1', 'HDMI2', 'bluetooth', 'wifi']);
  assert.deepEqual(['digital', 'HDMI1', 'arc', 'BLUETOOTH', 'usb'].map(fromStInput), ['tv', 'hdmi1', 'tv', 'bluetooth', 'usb']);
  assert.equal(isSoundbar({ deviceId: 'x', label: 'Lounge speaker', components: [{ id: 'main', capabilities: [{ id: 'switch' }] }] }), false);
  assert.equal(isSoundbar({ deviceId: 'x', label: 'Samsung HW-Q930B', components: [{ id: 'main', capabilities: [{ id: 'audioVolume' }] }] }), true);
});

test('SmartThings sets and reads a Samsung TV’s source, for the Samsung TV adapter', async () => {
  const st = await fakeSmartThings();
  const reg = new Registry(new Store(':memory:'));
  const adapter = new SmartThingsAdapter({ token: 'a0', storageDir: mkdtempSync(join(tmpdir(), 'kova-st-')), apiUrl: `${st.url}/v1`, pollSec: 0 });
  try {
    await reg.addAdapter(adapter);
    // The TV isn't a Kova device of its own (the Samsung TV adapter has it): only the soundbar is.
    assert.deepEqual(reg.list().map(d => d.id), ['soundbar_6f1c2d3eaaaa', 'smarttv_tvs90d']);
    assert.match(adapter.status().note!, /1 soundbar, 1 TV/);
    // Found by its model (the Samsung network API says QA65S90DAWXXY), else by name, else the only TV.
    const s90d = { name: 'Samsung S90D', model: 'QA65S90DAWXXY' };
    assert.equal(adapter.hasTv(s90d), true);
    assert.equal(await adapter.tvInput(s90d), 'tv');
    assert.equal(await adapter.setTvInput(s90d, 'hdmi2'), true);
    assert.deepEqual(st.commands.at(-1), { tv: true, component: 'main', capability: 'samsungvd.mediaInputSource', command: 'setInputSource', arguments: ['HDMI2'] });
    assert.equal(await adapter.tvInput(s90d), 'hdmi2');
    await adapter.setTvInput(s90d, 'tv');
    assert.equal(st.tv.input, 'dtv', 'the TV’s own id for TV');
  } finally {
    await reg.stop();
    await st.close();
  }
  assert.equal(toTvSource('hdmi3', ['dtv', 'HDMI3']), 'HDMI3');
  assert.equal(toTvSource('tv', ['digitalTv', 'HDMI1']), 'digitalTv');
  assert.deepEqual(['HDMI1', 'dtv', 'digitalTv', 'USB'].map(fromTvSource), ['hdmi1', 'tv', 'tv', 'usb']);
});

test('SmartThings: Kova makes its own OAuth-In app from a one-time token, as the CLI would', async () => {
  const got: { auth?: string; body?: Record<string, any> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      got.push({ auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer good-token') { res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'Forbidden' } })); return; }
      res.end(JSON.stringify({ app: { appId: 'app-1', appName: body.appName }, oauthClientId: 'client-1', oauthClientSecret: 'secret-1' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const made = await createSmartThingsApp({ token: ' good-token ', apiUrl });
    assert.deepEqual(made, { clientId: 'client-1', clientSecret: 'secret-1', appId: 'app-1' });
    const b = got[0].body!;
    assert.equal(b.appType, 'API_ONLY');
    assert.deepEqual(b.classifications, ['CONNECTED_SERVICE']);
    assert.equal(b.principalType, 'LOCATION');
    assert.match(b.appName, /^kova-[0-9a-f]{8}$/);
    assert.deepEqual(b.oauth.scope, ['r:devices:*', 'x:devices:*']);
    assert.deepEqual(b.oauth.redirectUris, ['https://httpbin.org/get']);
    await assert.rejects(createSmartThingsApp({ token: 'no-apps-permission', apiUrl }), /Apps permissions/);
  } finally { server.close(); }
});
