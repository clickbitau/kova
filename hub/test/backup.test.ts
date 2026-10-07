import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { Backups, nextRun, restoreBackup, formatSize, parseBackupTime } from '../src/services/backup.ts';
import { tarStream, untar } from '../src/util/tar.ts';
import { LOCK_FILE } from '../src/util/lock.ts';
import { buildServer } from '../src/api/server.ts';
import { at, TZ } from './helpers.ts';

const hubDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(hubDir, '../web');

const tmp = () => mkdtempSync(join(tmpdir(), 'kova-backup-test-'));

/** A hub on a real data folder with some pairing files next to it. */
async function homeOnDisk() {
  const dataDir = tmp();
  writeFileSync(join(dataDir, 'integrations.json'), JSON.stringify({ tuya: { devices: [] } }), { mode: 0o600 });
  writeFileSync(join(dataDir, 'home.json'), JSON.stringify({ name: 'Test home' }));
  mkdirSync(join(dataDir, 'homekit'));
  writeFileSync(join(dataDir, 'homekit', 'kova-bridge.json'), '{"pincode":"123-45-678"}');
  mkdirSync(join(dataDir, 'matter', 'node-1'), { recursive: true });
  writeFileSync(join(dataDir, 'matter', 'node-1', 'fabric'), 'fabric-bytes');
  mkdirSync(join(dataDir, 'aircast'));
  writeFileSync(join(dataDir, 'aircast', 'aircast.xml'), '<aircast/>');
  writeFileSync(join(dataDir, 'aircast', 'aircast.log'), 'noise');
  symlinkSync('/etc/passwd', join(dataDir, 'homekit', 'link'));
  const clock = { t: at(12) };
  const hub = new Hub({ dbPath: join(dataDir, 'kova.db'), initialConfig: demoConfig, adapters: [new VirtualAdapter(demoDevices())], now: () => clock.t, tickMs: 0 });
  await hub.start();
  for (let i = 0; i < 50; i++) hub.store.append({ kind: 'system', device: null, feed: null, what: `row ${i}`, data: { i }, cause: { kind: 'system', label: 'test' } });
  return { dataDir, hub, clock };
}

async function entriesOf(file: string) {
  const out = new Map<string, Buffer>();
  for await (const e of untar(createReadStream(file).pipe(createGunzip()) as AsyncIterable<Buffer>)) out.set(e.type === 'dir' ? `${e.name}/` : e.name, e.data);
  return out;
}

const count = (dbFile: string) => {
  const db = new DatabaseSync(dbFile);
  try { return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n; } finally { db.close(); }
};

test('backup: one tar.gz with a consistent database, the config and pairing folders, owner-only', async () => {
  const { dataDir, hub, clock } = await homeOnDisk();
  const b = new Backups({ db: hub.store.db, dataDir, timezone: () => TZ, now: () => clock.t, log: e => hub.store.append(e), beforeBackup: () => hub.reg.flush(), version: '9.9.9' });
  const info = await b.run('manual');
  assert.match(info.name, /^kova-backup-20260930-120000\.tar\.gz$/, 'named in the home\'s local time');
  const file = join(dataDir, 'backups', info.name);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, 'backups')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(dataDir, 'backups')), [info.name], 'no staging leftovers');

  const entries = await entriesOf(file);
  assert.ok(entries.has('manifest.json') && entries.has('kova.db') && entries.has('integrations.json') && entries.has('home.json'));
  assert.equal(entries.get('homekit/kova-bridge.json')!.toString(), '{"pincode":"123-45-678"}');
  assert.equal(entries.get('matter/node-1/fabric')!.toString(), 'fabric-bytes');
  assert.ok(entries.has('aircast/aircast.xml'));
  assert.ok(!entries.has('aircast/aircast.log'), 'only aircast config');
  assert.ok(!entries.has('homekit/link'), 'symlinks are skipped');
  assert.equal(JSON.parse(entries.get('manifest.json')!.toString()).version, '9.9.9');

  // The database copy opens on its own and has the same rows as the live one.
  const out = tmp();
  writeFileSync(join(out, 'kova.db'), entries.get('kova.db')!);
  const live = (hub.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  assert.equal(count(join(out, 'kova.db')), live - 1, 'everything before the "finished" row');
  const copy = new DatabaseSync(join(out, 'kova.db'));
  assert.equal((copy.prepare("SELECT what FROM events WHERE what = 'row 49'").get() as { what: string }).what, 'row 49');
  assert.ok(copy.prepare("SELECT value FROM kv WHERE key = 'deviceState'").get(), 'device state was flushed into it');
  copy.close();

  // System tar agrees it's a valid archive.
  const t = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', timeout: 20_000 });
  if (!t.error) { assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /^kova\.db$/m); assert.match(t.stdout, /^matter\/node-1\/fabric$/m); }

  // It shows in Activity and on the Integrations screen.
  const feed = hub.store.feed(5);
  assert.match(feed[0].what, /^Backup finished · \d+ KB$/);
  assert.equal(feed[0].data.backup, info.name);
  const st = b.status();
  assert.equal(st.ok, true);
  assert.match(st.note, /^Last backup .+ · \d+ KB · keeping 14 · nightly backups off$/);

  await hub.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test('backup: keeps only the newest N', async () => {
  const { dataDir, hub, clock } = await homeOnDisk();
  const b = new Backups({ db: hub.store.db, dataDir, keep: 3, timezone: () => TZ, now: () => clock.t });
  const names: string[] = [];
  for (let d = 1; d <= 5; d++) {
    clock.t = at(3, `2026-09-0${d}`); // in the past, so real mtimes of new files sort after them
    const info = await b.run('nightly');
    utimesSync(join(b.dir, info.name), new Date(clock.t), new Date(clock.t));
    names.push(info.name);
  }
  assert.deepEqual(b.list().map(x => x.name), names.slice(-3).reverse());
  await hub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('backup: nightly at the configured time in the home\'s timezone', async () => {
  assert.equal(parseBackupTime(undefined), 3 + 10 / 60);
  assert.equal(parseBackupTime('off'), null);
  assert.throws(() => parseBackupTime('25:00'));
  assert.equal(nextRun(at(12), 3.5, TZ), at(3.5, '2026-10-01'));
  assert.equal(nextRun(at(2), 3.5, TZ), at(3.5));
  assert.equal(formatSize(61 * 1024 * 1024), '61 MB');
  assert.equal(formatSize(1.44 * 1024 * 1024), '1.4 MB');

  const { dataDir, hub, clock } = await homeOnDisk();
  clock.t = at(3.1);
  let changed = 0;
  const b = new Backups({ db: hub.store.db, dataDir, hour: 3.25, timezone: () => TZ, now: () => clock.t, log: e => hub.store.append(e), checkMs: 5, onChange: () => changed++ });
  b.start();
  assert.equal(b.nextAt, at(3.25));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(b.list().length, 0, 'not yet');
  clock.t = at(3.26);
  for (let i = 0; i < 200 && !changed; i++) await new Promise(r => setTimeout(r, 10));
  await b.stop();
  assert.equal(b.list().length, 1);
  assert.ok(hub.store.feed(20).some(e => /^Nightly backup finished · /.test(e.what)), 'in Activity');
  assert.equal(b.nextAt, at(3.25, '2026-10-01'));
  await hub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('backup API: list, make one, download needs auth', async () => {
  const { dataDir, hub, clock } = await homeOnDisk();
  const backups = new Backups({ db: hub.store.db, dataDir, timezone: () => TZ, now: () => clock.t, log: e => hub.store.append(e) });
  const app = await buildServer(hub, { webRoot, token: 'secret', backups });
  const auth = { authorization: 'Bearer secret' };
  assert.equal((await app.inject({ url: '/api/backups' })).statusCode, 401);
  const made = (await app.inject({ method: 'POST', url: '/api/backups', headers: auth })).json();
  assert.equal(made.ok, true);
  const list = (await app.inject({ url: '/api/backups', headers: auth })).json();
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].name, made.backup.name);
  assert.equal((await app.inject({ url: `/api/backups/${made.backup.name}` })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/backups/..%2Fkova.db', headers: auth })).statusCode, 404);
  const dl = await app.inject({ url: `/api/backups/${made.backup.name}`, headers: auth });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers['content-type'], 'application/gzip');
  assert.deepEqual([...dl.rawPayload.subarray(0, 2)], [0x1f, 0x8b]);
  const s = (await app.inject({ url: '/api/state', headers: auth })).json();
  assert.equal(s.activity[0].icon, 'backup');
  await app.close();

  // Without a token, downloads only work from this machine.
  const open = await buildServer(hub, { webRoot, backups });
  assert.equal((await open.inject({ url: `/api/backups/${made.backup.name}` })).statusCode, 200);
  assert.equal((await open.inject({ url: `/api/backups/${made.backup.name}`, remoteAddress: '10.10.10.20' })).statusCode, 403);
  await open.close();
  await hub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const restoreCli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/restore.ts', ...args], { cwd: hubDir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, KOVA_DATA: '' } });

test('restore CLI: refuses while the hub holds the lock, then restores into a fresh data folder', async () => {
  const { dataDir, hub, clock } = await homeOnDisk();
  const b = new Backups({ db: hub.store.db, dataDir, timezone: () => TZ, now: () => clock.t });
  const info = await b.run('manual');
  const rows = (hub.store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  await hub.stop();
  const archive = join(b.dir, info.name);

  const target = tmp();
  writeFileSync(join(target, 'integrations.json'), '{"old":true}');
  mkdirSync(join(target, 'samsungtv'));
  writeFileSync(join(target, 'samsungtv', 'tokens.json'), '{}');

  // A running hub (this process, heartbeat fresh) holds the folder.
  writeFileSync(join(target, LOCK_FILE), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now(), what: 'hub' }));
  const locked = restoreCli([archive, '--data', target]);
  assert.equal(locked.status, 2, locked.stderr);
  assert.match(locked.stderr, /in use by a running hub/);
  assert.equal(readFileSync(join(target, 'integrations.json'), 'utf8'), '{"old":true}', 'nothing touched');

  rmSync(join(target, LOCK_FILE));
  const ok = restoreCli([archive, '--data', target]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Restored /);
  assert.equal(count(join(target, 'kova.db')), rows);
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'integrations.json'), 'utf8')), { tuya: { devices: [] } });
  assert.equal(readFileSync(join(target, 'homekit', 'kova-bridge.json'), 'utf8'), '{"pincode":"123-45-678"}');
  assert.equal(readFileSync(join(target, 'matter', 'node-1', 'fabric'), 'utf8'), 'fabric-bytes');
  assert.ok(!existsSync(join(target, 'samsungtv')), 'folders not in the backup are moved aside too');
  assert.ok(!existsSync(join(target, LOCK_FILE)), 'restore released its lock');
  const aside = readdirSync(target).find(n => n.startsWith('.pre-restore-'))!;
  assert.equal(readFileSync(join(target, aside, 'integrations.json'), 'utf8'), '{"old":true}');
  assert.ok(existsSync(join(target, aside, 'samsungtv', 'tokens.json')));
  assert.ok(!readdirSync(target).some(n => n.startsWith('.restore-')), 'no staging leftovers');

  // The restored folder runs a hub.
  const again = new Hub({ dbPath: join(target, 'kova.db'), initialConfig: demoConfig, adapters: [], tickMs: 0 });
  await again.start();
  assert.ok(again.store.feed(1));
  await again.stop();

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

test('restore: refuses archives that aren\'t Kova backups or reach outside the data folder', async () => {
  const target = tmp();
  writeFileSync(join(target, 'home.json'), '{"keep":1}');
  const make = async (name: string) => {
    const chunks: Buffer[] = [];
    for await (const c of tarStream([{ name: 'manifest.json', type: 'file', mode: 0o600, mtimeMs: 0, data: Buffer.from('{"format":1}') }, { name, type: 'file', mode: 0o600, mtimeMs: 0, data: Buffer.from('x') }])) chunks.push(c);
    const f = join(target, `${name.replace(/\W/g, '_')}.tar.gz`);
    writeFileSync(f, gzipSync(Buffer.concat(chunks)));
    return f;
  };
  await assert.rejects(restoreBackup(await make('../evil'), target), /unsafe path/);
  await assert.rejects(restoreBackup(await make('etc/passwd'), target), /Unexpected item/);
  await assert.rejects(restoreBackup(await make('home.json'), target), /no kova\.db/);
  assert.equal(readFileSync(join(target, 'home.json'), 'utf8'), '{"keep":1}');
  assert.ok(!existsSync(join(target, '..', 'evil')));
  assert.ok(!readdirSync(target).some(n => n.startsWith('.')), 'no staging or aside folders left');

  // Long paths survive the round trip (PAX headers).
  const long = `matter/${'deep/'.repeat(40)}file`;
  const chunks: Buffer[] = [];
  for await (const c of tarStream([{ name: long, type: 'file', mode: 0o600, mtimeMs: 0, data: Buffer.from('ok') }])) chunks.push(c);
  const got = [];
  for await (const e of untar(Readable.from([Buffer.concat(chunks)]))) got.push(e);
  assert.equal(got[0].name, long);
  assert.equal(got[0].data.toString(), 'ok');
  rmSync(target, { recursive: true, force: true });
});
