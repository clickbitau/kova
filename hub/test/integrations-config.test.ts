import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager, REDACTED, keepSecrets, redact } from '../src/integrations-store.ts';
import { INTEGRATION_SECTIONS } from '../src/integrations.ts';
import { CATALOG, type Field } from '../src/integrations-catalog.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

// A minimal Tapo plug speaking KLAP v2 (the full fake, with checks, is in tapo.test.ts).
function fakePlug(user: string, pass: string) {
  const H = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
  const S1 = (s: string) => createHash('sha1').update(s).digest();
  const auth = H(S1(user), S1(pass));
  const info = { device_id: '80225A7C0E1D2F3A4B5C6D7E8F90ABCD', model: 'P110', nickname: Buffer.from('Lamp plug').toString('base64'), device_on: true };
  let local: Buffer, remote: Buffer, key: Buffer, iv: Buffer, sig: Buffer;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/app/handshake1') {
        local = body; remote = randomBytes(16);
        res.setHeader('set-cookie', 'TP_SESSIONID=S;TIMEOUT=86400');
        res.end(Buffer.concat([remote, H(local, remote, auth)]));
      } else if (url.pathname === '/app/handshake2') {
        if (!body.equals(H(remote, local, auth))) { res.statusCode = 403; res.end(); return; }
        const lh = Buffer.concat([local, remote, auth]);
        key = H(Buffer.from('lsk'), lh).subarray(0, 16); iv = H(Buffer.from('iv'), lh).subarray(0, 12); sig = H(Buffer.from('ldk'), lh).subarray(0, 28);
        res.end();
      } else {
        const sb = Buffer.alloc(4); sb.writeInt32BE(Number(url.searchParams.get('seq')));
        const ivs = Buffer.concat([iv, sb]);
        const d = createDecipheriv('aes-128-cbc', key, ivs);
        const rq = JSON.parse(Buffer.concat([d.update(body.subarray(32)), d.final()]).toString());
        if (rq.method === 'set_device_info') Object.assign(info, rq.params);
        const c = createCipheriv('aes-128-cbc', key, ivs);
        const enc = Buffer.concat([c.update(JSON.stringify({ error_code: 0, result: rq.method === 'get_device_info' ? info : {} })), c.final()]);
        res.end(Buffer.concat([H(sig, sb, enc), enc]));
      }
    });
  });
  return { server, info };
}

const SEED = {
  tuya: { devices: [{ id: 'bf01', host: '127.0.0.1', port: 1, key: 'abcdefghijklmnop', version: '3.3', switches: { 1: { name: 'Kitchen light', room: 'kitchen', id: 'kitchen_ceiling' } } }] },
  tapo: { username: 'me@example.com', password: 'tapo-pass', authHash: 'aGFzaA==', devices: [] },
  vesync: { email: 'v@example.com', password: 'vesync-pass', region: 'us' },
  nest: { projectId: 'p', clientId: 'c', clientSecret: 'nest-secret', refreshToken: 'nest-refresh' },
  presence: { opnsense: { url: 'https://10.10.0.1', key: 'opn-key', secret: 'opn-secret' }, people: { methel: ['aa:bb:cc:dd:ee:ff'] } },
  notify: { ntfy: { topic: 'kova', token: 'ntfy-token' } },
};
const SECRET_VALUES = ['abcdefghijklmnop', 'tapo-pass', 'aGFzaA==', 'vesync-pass', 'nest-secret', 'nest-refresh', 'opn-key', 'opn-secret', 'ntfy-token'];

async function setup(seed: unknown = SEED, token?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kova-int-'));
  const path = join(dir, 'integrations.json');
  if (seed) writeFileSync(path, JSON.stringify(seed), { mode: 0o600 });
  const t = await testHub();
  const manager = new IntegrationsManager(t.hub, { path, dataDir: dir });
  const app = await buildServer(t.hub, { webRoot, integrations: manager, token });
  const done = async () => { await app.close(); await t.hub.stop(); };
  return { ...t, app, path, manager, done, stored: () => JSON.parse(readFileSync(path, 'utf8')) };
}

test('Setup: GET config redacts every secret and flags that it is set', async () => {
  const s = await setup();
  try {
    const r = await s.app.inject({ method: 'GET', url: '/api/integrations/config' });
    assert.equal(r.statusCode, 200);
    for (const v of SECRET_VALUES) assert.ok(!r.body.includes(v), `leaked ${v}`);
    const c = r.json();
    assert.equal(c.tuya.devices[0].key, REDACTED);
    assert.equal(c.tuya.devices[0].hasKey, true);
    assert.equal(c.tapo.password, REDACTED);
    assert.equal(c.tapo.hasAuthHash, true);
    assert.equal(c.vesync.hasPassword, true);
    assert.equal(c.nest.clientSecret, REDACTED);
    assert.equal(c.nest.hasRefreshToken, true);
    assert.equal(c.presence.opnsense.secret, REDACTED);
    assert.equal(c.notify.ntfy.hasToken, true);
    // Not secrets: left alone.
    assert.equal(c.tapo.username, 'me@example.com');
    assert.equal(c.tuya.devices[0].host, '127.0.0.1');
  } finally { await s.done(); }
});

test('Setup: PUT with "••••" keeps the stored secret, a new value replaces it', async () => {
  const s = await setup();
  try {
    const cur = (await s.app.inject({ method: 'GET', url: '/api/integrations/config' })).json();
    // Nest applies on restart; the redacted config goes straight back with one change.
    let r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/nest', payload: { ...cur.nest, projectId: 'p2' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ applied: r.json().applied, restartRequired: r.json().restartRequired }, { applied: false, restartRequired: true });
    assert.equal(s.stored().nest.clientSecret, 'nest-secret');
    assert.equal(s.stored().nest.refreshToken, 'nest-refresh');
    assert.equal(s.stored().nest.projectId, 'p2');
    assert.ok(!('hasClientSecret' in s.stored().nest));

    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/nest', payload: { ...cur.nest, clientSecret: 'new-secret' } });
    assert.equal(r.statusCode, 200);
    assert.equal(s.stored().nest.clientSecret, 'new-secret');

    // Nested rows: a Tuya device keeps its key when the list is reordered and one is added.
    const dev2 = { id: 'bf02', host: '127.0.0.1', port: 1, key: 'qrstuvwxyz123456', switches: {} };
    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/tuya', payload: { devices: [dev2, cur.tuya.devices[0]] } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().applied, true);
    assert.deepEqual(s.stored().tuya.devices.map((d: { key: string }) => d.key), ['qrstuvwxyz123456', 'abcdefghijklmnop']);

    // Other sections are untouched.
    assert.equal(s.stored().vesync.password, 'vesync-pass');
  } finally { await s.done(); }
});

test('Setup: invalid settings are refused with a readable reason and nothing is saved', async () => {
  const s = await setup();
  try {
    let r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/tuya', payload: { devices: [{ id: 'x', host: '10.0.0.9', key: 'short', switches: { 1: { name: 'A', room: 'nowhere' } } }] } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Local key must be 16 characters/);
    assert.match(r.json().error, /isn’t one of your rooms/);
    assert.equal(s.stored().tuya.devices[0].id, 'bf01');
    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/tapo', payload: { devices: [{ host: '10.0.0.2', room: 'lounge' }] } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /TP-Link email and password/);
    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/nope', payload: {} });
    assert.equal(r.statusCode, 404);
  } finally { await s.done(); }
});

test('Setup: adding Tapo starts it live; restarting or removing keeps device ids and marks them offline', async () => {
  const fake = fakePlug('me@example.com', 'secret');
  await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const s = await setup(null);
  try {
    // Try before saving.
    const cfg = { username: 'me@example.com', password: 'secret', pollMs: 0, devices: [{ host, room: 'lounge', id: 'lamp_plug' }] };
    let r = await s.app.inject({ method: 'POST', url: '/api/integrations/tapo/test', payload: { config: cfg } });
    assert.deepEqual(r.json(), { ok: true, message: `Reached Lamp plug (P110) at ${host}. It’s on.` });
    r = await s.app.inject({ method: 'POST', url: '/api/integrations/tapo/test', payload: { config: { ...cfg, password: 'wrong' } } });
    assert.equal(r.json().ok, false);
    assert.match(r.json().message, /Couldn’t sign in/);

    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/tapo', payload: cfg });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true, applied: true, restartRequired: false, status: { ok: true, note: '1 device' } });
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
    const d = s.hub.reg.get('lamp_plug')!;
    assert.equal(d.adapter, 'tapo');
    assert.equal(d.state.on, true);
    const snap = (await s.app.inject({ method: 'GET', url: '/api/state' })).json();
    assert.ok(snap.integrations.some((i: { id: string; devices: number }) => i.id === 'tapo' && i.devices === 1));

    // Commands go to the new adapter.
    await s.hub.engine.command('lamp_plug', { on: false }, { kind: 'user', label: 'You' });
    assert.equal(fake.info.device_on, false);

    // Taking the adapter away keeps the device (and its id) but shows it offline.
    await s.hub.reg.removeAdapter('tapo');
    assert.equal(s.hub.reg.get('lamp_plug')?.state.online, false);
    assert.ok(!s.hub.reg.adapters.has('tapo'));

    // Saving again (the redacted password comes back as "••••") brings the same device back online.
    const pub = (await s.app.inject({ method: 'GET', url: '/api/integrations/config' })).json();
    assert.equal(pub.tapo.password, REDACTED);
    r = await s.app.inject({ method: 'PUT', url: '/api/integrations/config/tapo', payload: pub.tapo });
    assert.equal(r.json().status.ok, true);
    assert.equal(s.hub.reg.get('lamp_plug')?.state.online, true);
    assert.equal(s.hub.reg.list().filter(x => x.adapter === 'tapo').length, 1);
    assert.equal(s.stored().tapo.password, 'secret');

    // Removing the integration stops it and drops its devices from the list.
    r = await s.app.inject({ method: 'DELETE', url: '/api/integrations/config/tapo' });
    assert.equal(r.statusCode, 200);
    assert.equal(s.hub.reg.get('lamp_plug'), undefined);
    assert.ok(!('tapo' in s.stored()));
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
  } finally { await s.done(); fake.server.close(); }
});

test('Setup: the catalog covers every section of integrations.json, with complete fields', async () => {
  const s = await setup(null);
  try {
    const items = (await s.app.inject({ method: 'GET', url: '/api/integrations/catalog' })).json() as typeof CATALOG;
    const ids = items.map(i => i.id);
    for (const sec of INTEGRATION_SECTIONS) assert.ok(ids.includes(sec), `catalog is missing ${sec}`);
    for (const extra of ['nest', 'ecovacs', 'homekit', 'homekitBridge', 'matterBridge', 'presence', 'notify']) assert.ok(ids.includes(extra), extra);
    assert.equal(new Set(ids).size, ids.length);
    const check = (f: Field) => {
      assert.ok(f.key && f.label && ['text', 'password', 'number', 'select', 'list'].includes(f.type), JSON.stringify(f));
      if (f.type === 'list') { assert.ok(f.item?.length, f.key); f.item!.forEach(check); if (f.shape === 'map') assert.ok(f.item!.some(i => i.key === f.mapKey)); }
      if (f.type === 'select') assert.ok(f.options);
    };
    for (const it of items) {
      assert.ok(it.name && it.icon && it.description && ['Local', 'Cloud'].includes(it.kind), it.id);
      it.fields.forEach(check);
      it.actions?.forEach(a => a.fields?.forEach(check));
    }
    // Every secret the redactor knows about is typed as a password field somewhere it appears.
    assert.equal(items.find(i => i.id === 'tuya')!.fields[0].item!.find(f => f.key === 'key')!.type, 'password');
  } finally { await s.done(); }
});

test('Setup: needs the token when one is set; no quick test for Cast', async () => {
  const s = await setup(SEED, 'tok');
  try {
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/integrations/config' })).statusCode, 401);
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/integrations/config/nest', payload: {} })).statusCode, 401);
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/integrations/catalog' })).statusCode, 401);
    const r = await s.app.inject({ method: 'POST', url: '/api/integrations/cast/test', headers: { authorization: 'Bearer tok' }, payload: {} });
    assert.equal(r.json().ok, false);
    assert.match(r.json().message, /no quick test/);
  } finally { await s.done(); }
});

test('Setup: redact and keepSecrets round-trip', () => {
  const red = redact(SEED);
  assert.deepEqual(keepSecrets(red, SEED), SEED);
  // "••••" with nothing stored is dropped rather than saved.
  assert.deepEqual(keepSecrets({ password: REDACTED, email: 'a' }, undefined), { email: 'a' });
});
