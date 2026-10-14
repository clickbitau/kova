import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const RATE = 48000;

/** One second of a 441 Hz tone that ends where it starts (441 whole cycles): played round, a seam shows as a jump. */
function toneWav(): Buffer {
  const n = RATE, pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 441 * i) / RATE) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

test('A looping sound as one endless stream: it runs past the recording’s end with no gap and no click, and stops when the speaker hangs up', { skip: !hasFfmpeg && 'no ffmpeg here' }, async () => {
  const wav = toneWav();
  const origin = http.createServer((req, res) => {
    // Ranges, as a recording's host gives them (ffmpeg goes back to the start through one).
    const m = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length - from, ...(m ? { 'content-range': `bytes ${from}-${wav.length - 1}/${wav.length}` } : {}) });
    res.end(wav.subarray(from));
  });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'kova-endless-'));
  const t = await testHub(12, c => { c.sources = [{ name: 'Tone', icon: 'music_note', url: `http://127.0.0.1:${(origin.address() as AddressInfo).port}/tone.wav`, loop: true }]; }, { dataDir: dir });
  const app = await buildServer(t.hub, { webRoot });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.hub.lanBase = () => base;
  try {
    const url = t.hub.reg.endlessUrl('Tone');
    assert.equal(url, `${base}/api/sound/Tone.m4a?endless=1`);
    // 3.5 s of it: three and a half passes of a one-second recording.
    const got = await new Promise<Buffer>((done, fail) => {
      const ff = spawn('ffmpeg', ['-v', 'error', '-i', url!, '-t', '3.5', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1']);
      const out: Buffer[] = [];
      let err = '';
      ff.stdout.on('data', d => out.push(d));
      ff.stderr.on('data', d => { err += String(d); });
      ff.on('exit', code => code === 0 ? done(Buffer.concat(out)) : fail(new Error(err || `ffmpeg ${code}`)));
    });
    const s = new Int16Array(got.buffer, got.byteOffset, got.length >> 1);
    assert.ok(s.length >= RATE * 3.4, `${s.length / RATE} s`);
    // A pure tone: the step between samples never goes past what the tone itself does (no gap, no jump at a seam).
    const most = 2 * Math.PI * 441 / RATE * 12000 * 1.05;
    let worst = 0, at = 0;
    for (let i = 1; i < s.length; i++) { const d = Math.abs(s[i]! - s[i - 1]!); if (d > worst) { worst = d; at = i; } }
    assert.ok(worst <= most, `a jump of ${worst} at ${(at / RATE).toFixed(4)} s (the tone moves at most ${Math.round(most)})`);
    let quiet = 0, run = 0;
    for (const v of s) { run = Math.abs(v) < 50 ? run + 1 : 0; quiet = Math.max(quiet, run); }
    assert.ok(quiet < 20, `${quiet} silent samples in a row`);
    // The listener hung up: the hub's ffmpeg for it is gone.
    await new Promise(r => setTimeout(r, 300));
    assert.notEqual(spawnSync('pgrep', ['-f', `stream_loop.*${base}`]).status, 0, 'no ffmpeg left behind');
  } finally {
    await app.close();
    await t.hub.stop();
    origin.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
