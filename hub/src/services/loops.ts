import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seamless loops of a sound (Thunderstorm, rain): a recording made into a long file that plays round without a seam.
 * Each pass crossfades into the next (equal power), and the file's end is mixed into its start, so a speaker that
 * repeats the file doesn't restart audibly either. The same as Helix's play-url `loop` (Helix makes it from a song's
 * original file when it can; Kova makes it from anything it can fetch, for homes without Helix).
 *
 * With ffmpeg on the hub (the installer adds it). Without, `available()` is false and sounds repeat as they are.
 * Made files are kept in <data>/loops by what they're made from, and dropped when no sound uses them.
 */
export interface LoopSpec { crossfadeMs: number; minutes: number }
export const LOOP_DEFAULT: LoopSpec = { crossfadeMs: 8000, minutes: 60 };
/** A pass longer than this isn't repeated inside the file: it's long enough by itself. */
const MAX_UNIT_S = 600;
const SAMPLE_RATE = 48000;
/** How a loop is encoded: AAC at 256 kb/s (a sound played for hours, often from a lossless original). In the key, so
 *  loops made before a change are made again. */
const ENCODING = 'aac256';

export class Loops {
  private ffmpeg: string | null | undefined;
  private making = new Map<string, Promise<string>>();
  private failed = new Map<string, { at: number; error: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string | null, private o: { ffmpeg?: string; ffprobe?: string } = {}) {}

  /** Whether this hub can make loops (ffmpeg is there). */
  available(): boolean {
    if (this.ffmpeg === undefined) {
      const bin = this.o.ffmpeg ?? 'ffmpeg';
      this.ffmpeg = spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0 ? bin : null;
    }
    return !!this.ffmpeg && !!this.dir;
  }

  key(input: string, spec: LoopSpec = LOOP_DEFAULT): string {
    return createHash('sha256').update(JSON.stringify([input, spec.crossfadeMs, spec.minutes, ENCODING])).digest('hex').slice(0, 20);
  }

  /** The made file for this input, if it's ready. */
  ready(key: string): string | null {
    const f = this.dir ? join(this.dir, `${key}.m4a`) : null;
    return f && existsSync(f) && statSync(f).size > 0 ? f : null;
  }

  /** Why the last try for this one failed, within the last 10 minutes (not tried again until then). */
  problem(key: string): string | null {
    const f = this.failed.get(key);
    return f && Date.now() - f.at < 600_000 ? f.error : null;
  }

  /**
   * Make the loop (once; asking again while it's being made waits for the same one). `input` is a URL or a file;
   * `stable` is what it's kept by (a Helix song's id, not its signed URL, which changes).
   */
  make(input: string, stable = input, spec: LoopSpec = LOOP_DEFAULT): Promise<string> {
    const key = this.key(stable, spec);
    const done = this.ready(key);
    if (done) return Promise.resolve(done);
    const had = this.making.get(key);
    if (had) return had;
    if (!this.available()) return Promise.reject(new Error('This hub can’t make seamless loops (ffmpeg isn’t installed)'));
    // One at a time: each needs a minute or two of the hub and room on its disk.
    const turn: Promise<string> = this.queue.catch(() => {}).then(() => this.render(input, key, spec));
    this.queue = turn;
    const p = turn
      .catch(e => { this.failed.set(key, { at: Date.now(), error: (e as Error).message }); throw e; })
      .finally(() => this.making.delete(key));
    this.making.set(key, p);
    return p;
  }

  /** Remove made files no sound uses now. */
  prune(keep: Set<string>): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      const k = f.replace(/\.(m4a(\.part)?|(pass|raw)\.(wav|flac))$/, '');
      if (!keep.has(k) && !this.making.has(k)) rmSync(join(this.dir, f), { force: true });
    }
  }

  private run(bin: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)));
        else resolve(stdout);
      });
    });
  }

  private async render(input: string, key: string, spec: LoopSpec): Promise<string> {
    const ff = this.ffmpeg!, probe = this.o.ffprobe ?? ff.replace(/ffmpeg$/, 'ffprobe');
    mkdirSync(this.dir!, { recursive: true });
    // Only as much of the recording as the loop uses: a 10-hour rain file is cut at the length asked for (plus the
    // crossfade), and that much is made seamless. Working files are FLAC, about half of plain samples.
    const cap = spec.minutes * 60 + spec.crossfadeMs / 1000 + 1;
    const need = 2 * cap * SAMPLE_RATE * 4 * 0.6 + 250e6;
    const free = (() => { try { const f = statfsSync(this.dir!); return f.bavail * f.bsize; } catch { return Infinity; } })();
    if (free < need + 500e6) throw new Error(`Not enough room on the hub to make it (${Math.round(free / 1e6)} MB free, ${Math.round((need + 500e6) / 1e6)} MB needed)`);
    const out = join(this.dir!, `${key}.m4a`), part = `${out}.part`, raw = join(this.dir!, `${key}.raw.flac`), pass = join(this.dir!, `${key}.pass.flac`);
    // A live stream never ends: refused before an hour of it is recorded.
    if (!(await this.ends(input))) throw new Error('It isn’t a recording with a length (a live stream can’t be looped)');
    try {
      // Decoded first: a file's stated length can be a little off (an MP3's often is), and the crossfade needs the
      // real one.
      await this.run(ff, ['-v', 'error', '-y', '-i', input, '-t', cap.toFixed(3), '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', 'flac', '-f', 'flac', raw], 15 * 60_000);
      const L = Number((await this.run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw], 60_000)).trim());
      if (!Number.isFinite(L) || L <= 0) throw new Error('It isn’t a recording with a length (a live stream can’t be looped)');
      return await this.loop(raw, L, out, part, pass, spec);
    } finally { rmSync(raw, { force: true }); rmSync(pass, { force: true }); }
  }

  /** Whether a URL is a recording (it says how long it is), not a live stream. */
  private async ends(input: string): Promise<boolean> {
    try { const d = Number((await this.run(this.o.ffprobe ?? this.ffmpeg!.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], 30_000)).trim()); return Number.isFinite(d) && d > 0; } catch { return false; }
  }

  private async loop(raw: string, L: number, out: string, part: string, pass: string, spec: LoopSpec): Promise<string> {
    const ff = this.ffmpeg!;
    const X = Math.min(spec.crossfadeMs / 1000, L / 2 - 0.05);
    if (X < 0.5) throw new Error('It’s too short to loop smoothly');
    const unit = L - X;
    const n = unit > MAX_UNIT_S ? 1 : Math.max(1, Math.ceil((spec.minutes * 60) / unit));
    const f = (x: number) => x.toFixed(3);
    // One pass of the loop: its last X seconds crossfaded (equal power) into its first X, then the rest of it. Played
    // after itself, each pass flows into the next. Made once as plain samples, then repeated n times (to about
    // `minutes`) sample for sample, and encoded once.
    const graph = [
      `[0:a]aresample=${SAMPLE_RATE},asplit=3[a][b][c]`,
      `[a]atrim=start=${f(L - X)},asetpts=PTS-STARTPTS[tail]`,
      `[b]atrim=end=${f(X)},asetpts=PTS-STARTPTS[head]`,
      `[c]atrim=start=${f(X)}:end=${f(L - X)},asetpts=PTS-STARTPTS[mid]`,
      // A hair shorter than the parts it joins, so rounding never leaves the crossfade longer than one of them.
      `[tail][head]acrossfade=d=${f(X - 0.01)}:c1=qsin:c2=qsin[xf]`,
      `[xf][mid]concat=n=2:v=0:a=1[out]`,
    ].join(';');
    rmSync(part, { force: true });
    await this.run(ff, ['-v', 'error', '-y', '-i', raw, '-filter_complex', graph, '-map', '[out]', '-c:a', 'flac', '-f', 'flac', pass], 15 * 60_000);
    await this.run(ff, ['-v', 'error', '-y', '-stream_loop', String(n - 1), '-i', pass, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', part], 15 * 60_000);
    renameSync(part, out);
    return out;
  }
}
