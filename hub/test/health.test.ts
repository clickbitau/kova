import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const hubDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(hubDir, '../web');
const version = JSON.parse(readFileSync(join(hubDir, 'package.json'), 'utf8')).version;

test('/api/health: open even with a token, and says nothing about the home', async () => {
  const { hub } = await testHub(12);
  const app = await buildServer(hub, { webRoot, token: 'secret' });
  const r = await app.inject({ url: '/api/health' });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'uptimeS', 'version']);
  assert.equal(body.ok, true);
  assert.equal(body.version, version);
  assert.equal(typeof body.uptimeS, 'number');
  assert.equal((await app.inject({ url: '/api/health?token=wrong' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/state' })).statusCode, 401, 'everything else still needs the token');
  await app.close();
  await hub.stop();
});

test('hub process: holds the lock, serves /api/health, and on SIGTERM flushes state, closes the DB and exits 0', { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-main-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: hubDir,
    env: { ...process.env, KOVA_DATA: dataDir, KOVA_PORT: '0', KOVA_HOST: '127.0.0.1', KOVA_WEATHER: '0', KOVA_DEMO: '1', KOVA_BACKUP_TIME: 'off', KOVA_HOMEKIT: '0', KOVA_MATTER: '0', KOVA_SONOS: '0', KOVA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = setTimeout(() => child.kill('SIGKILL'), 80_000);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  try {
    const port = await new Promise<number>((res, rej) => {
      const check = () => { const m = /listening on http:\/\/localhost:(\d+)/.exec(out); if (m) res(Number(m[1])); };
      child.stdout.on('data', check);
      exited.then(code => rej(new Error(`hub exited early (${code}): ${out}`)));
    });
    assert.ok(existsSync(join(dataDir, 'kova.lock')), 'lock file while running');

    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { ok: boolean; version: string };
    assert.equal(h.ok, true);
    assert.equal(h.version, version);

    // A second hub on the same folder refuses to start.
    const second = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: hubDir, env: { ...process.env, KOVA_DATA: dataDir, KOVA_PORT: '0', KOVA_WEATHER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err2 = '';
    second.stderr.on('data', d => { err2 += d; });
    const code2 = await new Promise<number | null>(r => second.on('exit', c => r(c)));
    assert.equal(code2, 1);
    assert.match(err2, /in use by a running hub/);

    // Change a device so there's state to flush.
    await fetch(`http://127.0.0.1:${port}/api/devices/dining`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });

    child.kill('SIGTERM');
    assert.equal(await exited, 0, out);
    assert.match(out, /Kova stopped/);
    assert.ok(!existsSync(join(dataDir, 'kova.lock')), 'lock released');
    assert.ok(!existsSync(join(dataDir, 'kova.db-wal')) || readFileSync(join(dataDir, 'kova.db-wal')).length === 0, 'WAL checkpointed on close');
    const db = new DatabaseSync(join(dataDir, 'kova.db'));
    const saved = JSON.parse((db.prepare("SELECT value FROM kv WHERE key = 'deviceState'").get() as { value: string }).value);
    db.close();
    assert.equal(saved.dining.on, true, 'device state flushed on SIGTERM');
  } finally {
    clearTimeout(kill);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }
});
