import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loops } from '../src/services/loops.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const len = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

test('Seamless loops: passes that crossfade into each other, repeated to about the length asked, kept and pruned', { skip: !hasFfmpeg && 'no ffmpeg here' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kova-loops-'));
  const src = join(dir, 'rain.mp3');
  // 20 s of "rain": a tone and noise, as an MP3 (whose stated length is a little off, as real ones are).
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:a=0.2', '-filter_complex', 'amix=inputs=2', '-c:a', 'libmp3lame', '-b:a', '96k', src]);
  const loops = new Loops(join(dir, 'loops'));
  assert.equal(loops.available(), true);
  const p1 = loops.make(src, 'rain', { crossfadeMs: 4000, minutes: 1 });
  const p2 = loops.make(src, 'rain', { crossfadeMs: 4000, minutes: 1 });
  const [f1, f2] = await Promise.all([p1, p2]);
  assert.equal(f1, f2, 'made once');
  // Each pass is 20 s − 4 s of crossfade; 4 of them make the minute.
  assert.ok(Math.abs(len(f1) - 4 * 16) < 0.3, `length ${len(f1)}`);
  assert.equal(loops.ready(loops.key('rain', { crossfadeMs: 4000, minutes: 1 })), f1);
  // A live stream (no end) and something too short are refused, and said.
  const tiny = join(dir, 'tick.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'libmp3lame', tiny]);
  await assert.rejects(loops.make(tiny, 'tick'), /too short/);
  assert.match(loops.problem(loops.key('tick'))!, /too short/);
  // A recording longer than the loop (a 10-hour rain file): only as much as the loop needs is used.
  const long = join(dir, 'long.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=150:c=brown:a=0.2', '-c:a', 'libmp3lame', '-b:a', '64k', long]);
  const lf = await loops.make(long, 'long', { crossfadeMs: 4000, minutes: 1 });
  assert.ok(len(lf) > 59 && len(lf) < 63, `cut to about a minute: ${len(lf)}`);
  // Pruned when no sound uses it.
  loops.prune(new Set());
  assert.deepEqual(readdirSync(join(dir, 'loops')), []);
});

test('Without ffmpeg there are no loops, and asking says why', async () => {
  const loops = new Loops(mkdtempSync(join(tmpdir(), 'kova-loops-')), { ffmpeg: '/nonexistent/ffmpeg' });
  assert.equal(loops.available(), false);
  await assert.rejects(loops.make('http://x/rain.mp3'), /ffmpeg isn’t installed/);
});
