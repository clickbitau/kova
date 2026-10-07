import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Audio clips kept on the hub for announcements (a call to prayer, a doorbell chime the owner recorded): uploaded once,
// then served to the speakers on the home network at a stable URL they fetch by themselves.
//
// Only audio is taken (checked by its first bytes, not by what the upload says it is), up to MAX_CLIP_BYTES. Each clip
// is a file `<id>.<ext>` in `<KOVA_DATA>/clips/`, listed in `clips.json` beside them, so a backup carries both. The id
// is 24 random hex digits: the speakers can't send a token, so the id is the clip's credential, as the doorbell
// picture's key is (services/screen-notices.ts). Kova ships no recordings of its own: only a short chime it makes
// itself, for trying a speaker's loudness (chimeWav).

export const MAX_CLIP_BYTES = 15 * 1024 * 1024;
export const MAX_CLIPS = 40;

export interface Clip {
  id: string;
  /** What the owner calls it ("Call to prayer", "Fajr"). */
  name: string;
  contentType: string;
  ext: string;
  bytes: number;
  /** How long it plays, when Kova could read it from the file (WAV, MP3, FLAC). */
  durationMs?: number;
  added: number;
}

/** What audio a file is, from its first bytes. Null: not audio Kova serves. */
export function sniffAudio(b: Buffer): { contentType: string; ext: string } | null {
  if (b.length < 12) return null;
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { contentType: 'audio/wav', ext: 'wav' };
  if (ascii(0, 4) === 'fLaC') return { contentType: 'audio/flac', ext: 'flac' };
  if (ascii(0, 4) === 'OggS') return { contentType: 'audio/ogg', ext: 'ogg' };
  if (ascii(4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom|mp41|dash)/.test(ascii(8, 12))) return { contentType: 'audio/mp4', ext: 'm4a' };
  if (ascii(0, 3) === 'ID3') return { contentType: 'audio/mpeg', ext: 'mp3' };
  // An MPEG frame sync: 11 bits set. Layer bits 01 (III) is MP3; 00 with the ADTS pattern is AAC.
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    const layer = (b[1]! >> 1) & 3;
    if (layer === 0 && (b[1]! & 0xf6) === 0xf0) return { contentType: 'audio/aac', ext: 'aac' };
    if (layer !== 0) return { contentType: 'audio/mpeg', ext: 'mp3' };
  }
  return null;
}

const MP3_RATES: Record<string, number[]> = {
  // [version-layer]: kbps by index (MPEG-1 layer III, MPEG-2/2.5 layer III)
  '1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_HZ: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

/** How long a clip plays, where its header says (WAV, FLAC) or its first frame lets Kova work it out (MP3). */
export function audioDurationMs(b: Buffer, ext: string): number | undefined {
  try {
    if (ext === 'wav') {
      // Walk the chunks: fmt gives the byte rate, data its length.
      let i = 12, rate = 0;
      while (i + 8 <= b.length) {
        const id = b.subarray(i, i + 4).toString('latin1'), size = b.readUInt32LE(i + 4);
        if (id === 'fmt ') rate = b.readUInt32LE(i + 16);
        if (id === 'data') return rate ? Math.round(Math.min(size, b.length - i - 8) / rate * 1000) : undefined;
        i += 8 + size + (size & 1);
      }
      return undefined;
    }
    if (ext === 'flac') {
      // STREAMINFO: sample rate (20 bits) and total samples (36 bits).
      const o = 8 + 10;
      const rate = (b[o]! << 12) | (b[o + 1]! << 4) | (b[o + 2]! >> 4);
      const total = ((b[o + 3]! & 0x0f) * 2 ** 32) + b.readUInt32BE(o + 4);
      return rate && total ? Math.round(total / rate * 1000) : undefined;
    }
    if (ext === 'mp3') {
      let i = 0;
      if (b.subarray(0, 3).toString('latin1') === 'ID3') i = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
      while (i + 4 < b.length && !(b[i] === 0xff && (b[i + 1]! & 0xe0) === 0xe0)) i++;
      if (i + 4 >= b.length) return undefined;
      const v = (b[i + 1]! >> 3) & 3, ver = v === 3 ? '1' : v === 2 ? '2' : v === 0 ? '2.5' : '';
      if (!ver) return undefined;
      const hz = MP3_HZ[ver]![(b[i + 2]! >> 2) & 3];
      // A Xing/Info header says how many frames there are (VBR files).
      const mono = ((b[i + 3]! >> 6) & 3) === 3;
      const side = ver === '1' ? (mono ? 17 : 32) : (mono ? 9 : 17);
      const xing = i + 4 + side;
      const tagHere = b.subarray(xing, xing + 4).toString('latin1');
      const perFrame = ver === '1' ? 1152 : 576;
      if ((tagHere === 'Xing' || tagHere === 'Info') && hz && (b.readUInt32BE(xing + 4) & 1)) return Math.round(b.readUInt32BE(xing + 8) * perFrame / hz * 1000);
      const kbps = MP3_RATES[ver === '1' ? '1' : '2']![(b[i + 2]! >> 4) & 15];
      return kbps ? Math.round((b.length - i) * 8 / kbps) : undefined;
    }
  } catch { /* a header Kova can't read: no duration */ }
  return undefined;
}

/**
 * A short two-note chime (about 1.3 s, 22 kHz mono WAV), made here: what "Play test" plays so the owner hears a
 * speaker's announcement loudness without any recording. Nothing copyrighted ships with Kova.
 */
export function chimeWav(): Buffer {
  const rate = 22050, secs = 1.3, n = Math.round(rate * secs);
  const pcm = Buffer.alloc(n * 2);
  const notes = [{ f: 880, at: 0 }, { f: 659.25, at: 0.42 }];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const { f, at } of notes) {
      if (t < at) continue;
      const d = t - at;
      const env = Math.min(1, d / 0.01) * Math.exp(-d * 3.2);
      v += env * (Math.sin(2 * Math.PI * f * d) * 0.8 + Math.sin(2 * Math.PI * f * 2 * d) * 0.15);
    }
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 0.45 * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export const CHIME_MS = 1300;
export const CHIME_FILE = 'chime.wav';

export const SYNC_TEST_FILE = 'sync-test.wav';
/** How long the speaker groups' sync test plays (its click track's length). */
export const SYNC_TEST_MS = 180_000;

/**
 * The speaker groups' sync test click track (engine/group-sync.ts), made here like the chime (22 kHz mono WAV): a
 * short sharp tick every second, and a lower, longer tone on each minute (0:00, 1:00, 2:00) so ticks a whole second
 * apart can't be mistaken for each other.
 */
export function syncTestWav(secs = SYNC_TEST_MS / 1000, rate = 22050): Buffer {
  const n = Math.round(secs * rate);
  const pcm = Buffer.alloc(n * 2);
  const add = (i: number, v: number) => { if (i < 0 || i >= n) return; const x = pcm.readInt16LE(i * 2) + Math.round(v * 32767); pcm.writeInt16LE(Math.max(-32767, Math.min(32767, x)), i * 2); };
  for (let s = 0; s < secs; s++) {
    const at = s * rate;
    // The tick: a 3 kHz burst that dies away in a few ms (sharp, easy to place by ear).
    for (let i = 0; i < Math.round(rate * 0.012); i++) add(at + i, 0.85 * Math.exp(-i / (rate * 0.0018)) * Math.sin(2 * Math.PI * 3000 * i / rate));
    if (s % 60 !== 0) continue;
    // The minute: 660 Hz for 250 ms, from the same instant as its tick.
    const len = Math.round(rate * 0.25);
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / (rate * 0.003), (len - i) / (rate * 0.02));
      add(at + i, 0.5 * env * Math.sin(2 * Math.PI * 660 * i / rate));
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}


/** A clip's name as the owner typed it, tidied. */
const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

export class ClipError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export class Clips {
  private list: Clip[] = [];
  private chime: Buffer | null = null;
  private ticks: Buffer | null = null;

  constructor(private dir: string | null) {
    if (!dir) return;
    try { this.list = (JSON.parse(readFileSync(join(dir, 'clips.json'), 'utf8')) as Clip[]).filter(c => c && /^[0-9a-f]{24}$/.test(c.id)); } catch { this.list = []; }
  }

  all(): Clip[] { return [...this.list].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id: string): Clip | undefined { return this.list.find(c => c.id === id); }

  /** The path speakers fetch a clip at (under the hub's own address). */
  static path(c: Pick<Clip, 'id' | 'ext'>): string { return `/api/clip/${c.id}.${c.ext}`; }

  private save(): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, 'clips.json.tmp');
    writeFileSync(tmp, JSON.stringify(this.list, null, 1));
    renameSync(tmp, join(this.dir, 'clips.json'));
  }

  add(name: unknown, body: Buffer, now = Date.now()): Clip {
    if (!this.dir) throw new ClipError('This hub has nowhere to keep clips', 503);
    const n = cleanName(name);
    if (!n) throw new ClipError('Give the clip a name');
    if (!body.length) throw new ClipError('The file is empty');
    if (body.length > MAX_CLIP_BYTES) throw new ClipError(`Clips can be up to ${MAX_CLIP_BYTES / 1024 / 1024} MB`, 413);
    if (this.list.length >= MAX_CLIPS) throw new ClipError(`Up to ${MAX_CLIPS} clips: remove one first`);
    const kind = sniffAudio(body);
    if (!kind) throw new ClipError('That isn’t an audio file Kova can play to speakers (MP3, M4A/AAC, WAV, FLAC or Ogg)', 415);
    const id = randomBytes(12).toString('hex');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${id}.${kind.ext}`), body, { mode: 0o600 });
    const durationMs = audioDurationMs(body, kind.ext);
    const clip: Clip = { id, name: n, ...kind, bytes: body.length, ...(durationMs ? { durationMs } : {}), added: now };
    this.list.push(clip);
    this.save();
    return clip;
  }

  rename(id: string, name: unknown): Clip {
    const c = this.get(id);
    if (!c) throw new ClipError('No such clip', 404);
    const n = cleanName(name);
    if (!n) throw new ClipError('Give the clip a name');
    c.name = n;
    this.save();
    return c;
  }

  remove(id: string): boolean {
    const c = this.get(id);
    if (!c) return false;
    this.list = this.list.filter(x => x !== c);
    if (this.dir) rmSync(join(this.dir, `${c.id}.${c.ext}`), { force: true });
    this.save();
    return true;
  }

  /** The file behind `/api/clip/<file>`: a clip by its id and extension, or the chime. */
  file(name: string): { contentType: string; body: Buffer } | null {
    if (name === CHIME_FILE) return { contentType: 'audio/wav', body: this.chime ??= chimeWav() };
    if (name === SYNC_TEST_FILE) return { contentType: 'audio/wav', body: this.ticks ??= syncTestWav() };
    const m = /^([0-9a-f]{24})\.([a-z0-9]{2,4})$/.exec(name);
    const c = m ? this.get(m[1]!) : undefined;
    if (!c || c.ext !== m![2] || !this.dir) return null;
    const path = join(this.dir, `${c.id}.${c.ext}`);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return { contentType: c.contentType, body: readFileSync(path) };
  }
}
