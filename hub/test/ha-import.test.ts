import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { buildServer } from '../src/api/server.ts';
import { IntegrationsManager } from '../src/integrations-store.ts';
import { HaImport } from '../src/import/ha-scan.ts';
import { secureTarKey } from '../src/import/ha-source.ts';
import { tarStream, type TarSource } from '../src/util/tar.ts';
import { at } from './helpers.ts';
import { createHash } from 'node:crypto';

const webRoot = resolve(import.meta.dirname, '../../web');

// ------------------------------------------------ a small Home Assistant --

const st = (data: unknown) => Buffer.from(JSON.stringify({ version: 1, data }));
const AUTOMATIONS = `
- id: '1001'
  alias: Porch lights at sunset
  triggers:
    - trigger: sun
      event: sunset
      offset: '-00:10:00'
  actions:
    - action: light.turn_on
      target: { entity_id: [light.porch, light.path] }
      data: { brightness_pct: 60 }
- id: '1002'
  alias: Goodnight
  trigger:
    - platform: time
      at: '22:30:00'
  condition:
    - condition: state
      entity_id: person.methel
      state: home
  action:
    - service: light.turn_off
      target: { area_id: kitchen }
    - delay: '00:05:00'
    - service: media_player.play_media
      target: { entity_id: media_player.bedroom_speaker }
      data: { media_content_id: 'http://x/rain.mp3', media_content_type: music }
- id: '1003'
  alias: Welcome home
  triggers:
    - trigger: state
      entity_id: person.methel
      to: home
  actions:
    - action: notify.mobile_app_iphone
      data: { message: Welcome home }
    - action: light.turn_on
      target: { entity_id: light.hall }
- id: '1004'
  alias: Old motion rule
  initial_state: false
  triggers:
    - trigger: state
      entity_id: binary_sensor.garage_motion
      to: 'on'
  actions:
    - action: light.turn_on
      target: { entity_id: light.garage }
`;

function haFiles(): Record<string, Buffer> {
  return {
    '.storage/core.config': st({ location_name: 'The Ahmeds', latitude: -31.95, longitude: 115.86, time_zone: 'Australia/Perth' }),
    '.storage/core.area_registry': st({ areas: [{ id: 'kitchen', name: 'Kitchen' }, { id: 'living_room', name: 'Living Room' }, { id: 'garage', name: 'Garage' }] }),
    '.storage/person': st({ items: [{ id: 'p1', name: 'Methel', device_trackers: ['device_tracker.iphone'] }, { id: 'p2', name: 'Brishti' }] }),
    '.storage/core.config_entries': st({ entries: [
      { entry_id: 'lt', domain: 'localtuya', title: 'localtuya', data: { devices: { bf00: { friendly_name: 'Kitchen Switch', host: '192.168.1.230', local_key: 'aaaaaaaaaaaaaaaa', protocol_version: '3.3', entities: [{ id: 1, platform: 'switch', friendly_name: 'Kitchen Light' }] } } } },
      { entry_id: 'vs', domain: 'vesync', title: 'VeSync', data: { username: 'me@example.com', password: 'secret-not-imported' } },
      { entry_id: 'tv', domain: 'samsungtv', title: 'Living Room TV', data: { host: '10.0.0.20', mac: 'aa:bb:cc:dd:ee:ff' } },
      { entry_id: 's', domain: 'sonos', title: 'Sonos', data: {} },
      { entry_id: 'sun', domain: 'sun', title: 'Sun', data: {} },
      { entry_id: 'met', domain: 'met', title: 'Home', data: {} },
      { entry_id: 'opn', domain: 'opnsense', title: 'OPNsense', data: {} },
      { entry_id: 'plex', domain: 'plex', title: 'Plex', data: {} },
      { entry_id: 'x', domain: 'shelly', title: 'Shelly', data: {} },
      { entry_id: 'old', domain: 'hue', title: 'Hue', data: {}, disabled_by: 'user' },
    ] }),
    '.storage/core.device_registry': st({ devices: [{ id: 'd1', name: 'Bedroom Purifier', area_id: 'living_room', config_entries: ['vs'] }] }),
    '.storage/core.entity_registry': st({ entities: [
      { entity_id: 'light.porch', name: null, original_name: 'Porch light' },
      { entity_id: 'light.path', name: 'Path lights', original_name: 'x' },
      { entity_id: 'person.methel', original_name: 'Methel' },
      { entity_id: 'automation.goodnight', platform: 'automation', unique_id: '1002' },
      { entity_id: 'automation.porch_lights_at_sunset', platform: 'automation', unique_id: '1001' },
    ] }),
    '.storage/core.restore_state': st([
      { state: { entity_id: 'automation.goodnight', state: 'on', attributes: { last_triggered: '2026-09-29T14:30:00+00:00' } } },
      { state: { entity_id: 'automation.porch_lights_at_sunset', state: 'on', attributes: {} } },
    ]),
    'automations.yaml': Buffer.from(AUTOMATIONS),
    'scripts.yaml': Buffer.from('movie_mode:\n  alias: Movie\n  sequence: []\ndate_mode:\n  alias: Date\n  sequence: []\n'),
    '.HA_VERSION': Buffer.from('2026.2.2\n'),
  };
}

async function tarOf(files: Record<string, Buffer>, prefix = ''): Promise<Buffer> {
  const entries: TarSource[] = Object.entries(files).map(([name, data]) => ({ name: prefix + name, type: 'file', mode: 0o644, mtimeMs: Date.now(), data, size: data.length }));
  const out: Buffer[] = [];
  for await (const c of tarStream(entries)) out.push(c);
  return Buffer.concat(out);
}

/** Home Assistant's backup layout: backup.json plus homeassistant.tar.gz (with data/…), here with a big history DB to stream past. */
async function haBackup(opts: { key?: string; v2?: boolean } = {}): Promise<Buffer> {
  const inner = gzipSync(await tarOf({ ...haFiles(), 'home-assistant_v2.db': randomBytes(6 * 1024 * 1024) }, 'data/'));
  let payload = inner;
  if (opts.key) {
    // SecureTar: AES-128-CBC; key = sha256×100(password)[:16]; iv = sha256×100(key + salt)[:16].
    const key = secureTarKey(opts.key), salt = randomBytes(16);
    let iv = Buffer.concat([key, salt]); for (let i = 0; i < 100; i++) iv = createHash('sha256').update(iv).digest();
    const c = createCipheriv('aes-128-cbc', key, iv.subarray(0, 16));
    const ct = Buffer.concat([c.update(inner), c.final()]);
    const header = opts.v2 ? Buffer.concat([Buffer.from('SecureTar\x02\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(8), Buffer.alloc(8)]) : Buffer.alloc(0);
    payload = Buffer.concat([header, salt, ct]);
  }
  const manifest = Buffer.from(JSON.stringify({ slug: 'abc', name: 'Automatic backup 2026.2.2', date: '2026-09-29T03:00:00Z', protected: !!opts.key, homeassistant: { version: '2026.2.2' } }));
  return tarOf({ 'backup.json': manifest, 'homeassistant.tar.gz': payload });
}

async function setup(demo = false) {
  const dir = mkdtempSync(join(tmpdir(), 'kova-haimp-'));
  const clock = { t: at(12) };
  const hub = new Hub({ dbPath: ':memory:', initialConfig: demoConfig, adapters: demo ? [new VirtualAdapter(demoDevices())] : [], now: () => clock.t, tickMs: 0, demo });
  await hub.start();
  const manager = new IntegrationsManager(hub, { path: join(dir, 'integrations.json'), dataDir: dir });
  const ha = new HaImport(hub, { dataDir: dir, manager });
  const app = await buildServer(hub, { webRoot, integrations: manager, haImport: ha });
  const done = async () => { await app.close(); await hub.stop(); };
  return { hub, dir, app, ha, done };
}

const upload = (app: Awaited<ReturnType<typeof setup>>['app'], body: Buffer, key?: string) =>
  app.inject({ method: 'POST', url: '/api/import/ha/backup', headers: { 'content-type': 'application/octet-stream', ...(key ? { 'x-backup-key': key } : {}) }, payload: body });

test('HA import: a config folder → what moves, what needs you, and the automations in plain words', async () => {
  const s = await setup();
  try {
    const cfg = join(s.dir, 'ha-config'); mkdirSync(join(cfg, '.storage'), { recursive: true });
    for (const [n, b] of Object.entries(haFiles())) writeFileSync(join(cfg, n), b);
    const r = await s.app.inject({ method: 'POST', url: '/api/import/ha/folder', payload: { path: cfg } });
    assert.equal(r.statusCode, 200, r.body);
    const x = r.json();
    assert.equal(x.source.haVersion, '2026.2.2');
    assert.equal(x.location.name, 'The Ahmeds');
    const fate = Object.fromEntries(x.integrations.map((i: { domain: string; fate: string }) => [i.domain, i.fate]));
    assert.deepEqual(fate, { localtuya: 'moves', vesync: 'moves', samsungtv: 'moves', sonos: 'set-up', sun: 'built-in', met: 'built-in', opnsense: 'handoff', plex: 'handoff', shelly: 'unsupported' }, 'the disabled Hue entry is left out');
    assert.deepEqual(x.stats.map((t: { n: string }) => t.n), ['3', '1', '4', '4', '3']);
    const ids = x.review.map((i: { id: string }) => i.id);
    assert.deepEqual(ids, ['vesync', 'samsungtv', 'setup:sonos', 'unsupported', 'automations']);
    assert.match(x.review[0].detail, /me@example\.com/);
    assert.deepEqual(x.handoffs.map((h: { app: string; what: string }) => [h.app, h.what]), [['Warden', 'OPNsense'], ['Helix', 'Plex']]);
    assert.ok(!r.body.includes('aaaaaaaaaaaaaaaa'), 'no device keys in the summary');
    assert.ok(!r.body.includes('secret-not-imported'));
    // Kept files are private.
    assert.equal(statSync(join(s.dir, 'import', 'ha', '.storage', 'core.config_entries')).mode & 0o777, 0o600);

    const autos = (await s.app.inject({ method: 'GET', url: '/api/import/ha/automations' })).json().automations;
    const by = Object.fromEntries(autos.map((a: { id: string }) => [a.id, a]));
    assert.deepEqual(by['1001'].when, ['10 min before sunset']);
    assert.deepEqual(by['1001'].then, ['Turn on Porch light and Path lights at 60%']);
    assert.equal(by['1001'].kind, 'time');
    assert.ok(by['1001'].at > 16 && by['1001'].at < 20, `sunset in Perth, got ${by['1001'].at}`);
    assert.equal(by['1001'].kova, 'A mode or a moment');
    assert.deepEqual(by['1002'].when, ['Every day at 22:30']);
    assert.deepEqual(by['1002'].cond, ['Methel is home']);
    assert.deepEqual(by['1002'].then, ['Turn off Kitchen', 'Wait 5 min', 'Play rain.mp3 on Bedroom speaker']);
    assert.equal(by['1002'].lastRun, 'Last ran 29 Sep, 22:30');
    assert.equal(by['1003'].kova, 'Presence and the Away overlay');
    assert.deepEqual(by['1003'].when, ['Methel comes home']);
    assert.equal(by['1004'].enabled, false);
    assert.equal(by['1004'].kova, 'Light the way');
    assert.match(by['1002'].yaml, /alias: Goodnight/);

    // Marking an item done sticks.
    const m = await s.app.inject({ method: 'POST', url: '/api/import/ha/review/samsungtv', payload: {} });
    assert.equal(m.json().review.find((i: { id: string }) => i.id === 'samsungtv').done, true);
  } finally { await s.done(); }
});

test('HA import: a Home Assistant backup streams past the history database', async () => {
  const s = await setup();
  try {
    const r = await upload(s.app, await haBackup());
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().source.backupName, 'Automatic backup 2026.2.2');
    assert.equal(r.json().automations.total, 4);
    assert.ok(!statSync(join(s.dir, 'import', 'ha')).isFile());
    assert.throws(() => statSync(join(s.dir, 'import', 'ha', 'home-assistant_v2.db')), 'the history database is not kept');
    // A tar.gz of the config folder works too.
    const r2 = await upload(s.app, gzipSync(await tarOf(haFiles(), 'config/')));
    assert.equal(r2.statusCode, 200, r2.body);
    // Something else entirely is refused clearly.
    const r3 = await upload(s.app, Buffer.from('hello, not a backup'.repeat(100)));
    assert.equal(r3.statusCode, 400);
    assert.equal(r3.json().code, 'not-ha');
  } finally { await s.done(); }
});

test('HA import: encrypted backups need their key (both SecureTar layouts)', async () => {
  const s = await setup();
  try {
    const key = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ12';
    for (const v2 of [false, true]) {
      const b = await haBackup({ key, v2 });
      const none = await upload(s.app, b);
      assert.equal(none.statusCode, 400); assert.equal(none.json().code, 'needs-key');
      const wrong = await upload(s.app, b, 'nope-nope');
      assert.equal(wrong.statusCode, 400); assert.equal(wrong.json().code, 'wrong-key');
      const ok = await upload(s.app, b, key);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().location.name, 'The Ahmeds');
    }
  } finally { await s.done(); }
});

test('HA import: switching over from the demo home', async () => {
  const s = await setup(true);
  try {
    assert.equal(s.hub.demo, true);
    await upload(s.app, await haBackup());
    const r = await s.app.inject({ method: 'POST', url: '/api/import/ha/apply', payload: {} });
    assert.equal(r.statusCode, 200, r.body);
    const x = r.json();
    assert.equal(x.leftDemo, true);
    assert.deepEqual(x.written.sort(), ['samsungtv', 'tuya', 'vesync']);
    assert.ok(x.started.includes('tuya'), 'Tuya starts right away (it has its keys)');
    assert.ok(!x.started.includes('vesync'), 'VeSync waits for its password');
    assert.equal(s.hub.demo, false);
    assert.ok(!s.hub.reg.adapters.has('virtual'), 'the virtual devices are gone');
    assert.equal(s.hub.config.get().name, 'The Ahmeds');
    assert.deepEqual(s.hub.config.get().people.map(p => p.name), ['Methel', 'Brishti']);
    const saved = JSON.parse(readFileSync(join(s.dir, 'integrations.json'), 'utf8'));
    assert.equal(saved.tuya.devices[0].key, 'aaaaaaaaaaaaaaaa');
    assert.equal(statSync(join(s.dir, 'integrations.json')).mode & 0o777, 0o600);
    assert.ok(x.summary.applied);
    // A second switch-over keeps what's there.
    const again = (await s.app.inject({ method: 'POST', url: '/api/import/ha/apply', payload: {} })).json();
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.kept.sort(), ['samsungtv', 'tuya', 'vesync']);
  } finally { await s.done(); }
});
