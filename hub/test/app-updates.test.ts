import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { contentUuid } from '../src/api/app-updates.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

/** A small `expo export`: one bundle per platform and a font, as metadata.json lists them. */
function exportDir(root: string, train: string, update: string, js: Record<string, string>, version = '0.1.1') {
  const d = join(root, train, update);
  mkdirSync(join(d, '_expo/static/js/ios'), { recursive: true });
  mkdirSync(join(d, '_expo/static/js/android'), { recursive: true });
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, '_expo/static/js/ios/index-aaa.hbc'), js.ios);
  writeFileSync(join(d, '_expo/static/js/android/index-bbb.hbc'), js.android);
  writeFileSync(join(d, 'assets/f00d'), 'font bytes');
  writeFileSync(join(d, 'metadata.json'), JSON.stringify({
    version: 0, bundler: 'metro',
    fileMetadata: {
      ios: { bundle: '_expo/static/js/ios/index-aaa.hbc', assets: [{ path: 'assets/f00d', ext: 'ttf' }] },
      android: { bundle: '_expo/static/js/android/index-bbb.hbc', assets: [{ path: 'assets/f00d', ext: 'ttf' }] },
    },
  }));
  writeFileSync(join(d, 'expoConfig.json'), JSON.stringify({ name: 'Kova', slug: 'kova', version, runtimeVersion: train }));
}

test('App updates: the hub serves the newest bundle for the phone’s train and platform, without a token', async () => {
  const ota = mkdtempSync(join(tmpdir(), 'kova-ota-'));
  exportDir(ota, 'kova-mobile-0', '20261001000000', { ios: 'old ios', android: 'old android' }, '0.1.1');
  exportDir(ota, 'kova-mobile-0', '20261002000000', { ios: 'new ios', android: 'new android' }, '0.1.2');
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: 'secret', otaDir: ota });
  const ask = (platform: string, extra: Record<string, string> = {}) => app.inject({
    method: 'GET', url: '/api/app/manifest',
    headers: { 'expo-runtime-version': 'kova-mobile-0', 'expo-platform': platform, 'expo-protocol-version': '1', host: '10.0.0.5:8140', ...extra },
  });
  try {
    const r = await ask('ios');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['expo-protocol-version'], '1');
    assert.equal(r.headers['expo-sfv-version'], '0');
    const m = r.json();
    // The newest export, its own version, and URLs back to the address the phone used.
    assert.equal(m.runtimeVersion, 'kova-mobile-0');
    assert.equal(m.extra.expoClient.version, '0.1.2');
    assert.match(m.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual({ ...m.launchAsset, hash: undefined }, { key: 'index-aaa', contentType: 'application/javascript', fileExtension: '.js', url: 'http://10.0.0.5:8140/api/app/assets/kova-mobile-0/20261002000000/index-aaa', hash: undefined });
    assert.equal(m.launchAsset.hash, createHash('sha256').update('new ios').digest('base64url'));
    assert.deepEqual(m.assets.map((a: { key: string; fileExtension: string; contentType: string }) => [a.key, a.fileExtension, a.contentType]), [['f00d', '.ttf', 'font/ttf']]);

    // Assets come without a token too, by key only.
    const js = await app.inject({ method: 'GET', url: '/api/app/assets/kova-mobile-0/20261002000000/index-aaa' });
    assert.equal(js.statusCode, 200);
    assert.equal(js.body, 'new ios');
    assert.match(String(js.headers['cache-control']), /immutable/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/app/assets/kova-mobile-0/20261002000000/..%2Fmetadata' })).statusCode, 404);
    // Everything else still needs the token.
    assert.equal((await app.inject({ method: 'GET', url: '/api/state' })).statusCode, 401);

    // Already on it: nothing to download. Android gets its own bundle and id.
    assert.equal((await ask('ios', { 'expo-current-update-id': m.id })).statusCode, 204);
    const a = (await ask('android')).json();
    assert.notEqual(a.id, m.id);
    assert.equal(a.launchAsset.key, 'index-bbb');
    // The id comes from the content: the same bundle has the same id wherever it is published.
    exportDir(ota, 'kova-mobile-0', '20261003000000', { ios: 'new ios', android: 'new android' }, '0.1.2');
    assert.equal((await ask('ios')).json().id, m.id);

    // A train nothing was published for, a platform the export lacks, a request that doesn't say: no update / 400.
    assert.equal((await ask('ios', { 'expo-runtime-version': 'kova-mobile-1' })).statusCode, 204);
    assert.equal((await ask('web')).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/api/app/manifest' })).statusCode, 400);
    // Rolling back is removing the newest directories.
    rmSync(join(ota, 'kova-mobile-0', '20261003000000'), { recursive: true });
    rmSync(join(ota, 'kova-mobile-0', '20261002000000'), { recursive: true });
    assert.equal((await ask('ios')).json().extra.expoClient.version, '0.1.1');
  } finally {
    await app.close();
    await t.hub.stop();
  }
});

test('App update ids are UUIDs that depend only on content', () => {
  assert.equal(contentUuid(['a', 'b']), contentUuid(['a', 'b']));
  assert.notEqual(contentUuid(['a', 'b']), contentUuid(['a', 'c']));
});
