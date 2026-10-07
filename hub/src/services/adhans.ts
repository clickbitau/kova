import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sniffAudio } from './clips.ts';

// Openly licensed recordings of the call to prayer from Wikimedia Commons, offered as announcement audio so nobody has
// to find and upload one. None ships with Kova: the hub downloads the one chosen on first use, keeps it in its data
// folder (clips/builtin/), and serves it to the speakers itself, so it plays with the internet down and no speaker
// ever reaches out to Wikimedia. Each shows its title, author and licence wherever it's picked (CC BY-SA asks for
// attribution).
//
// Formats: two are Ogg Vorbis, one MP3. Google Cast and Sonos both list Ogg Vorbis among the formats they play; the
// MP3 one plays everywhere. Kova doesn't transcode (no ffmpeg is assumed on the hub).

export interface BuiltinAdhan {
  /** Announce media id: "adhan:<key>". */
  id: string;
  key: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string;
  /** The recording's page on Wikimedia Commons. */
  page: string;
  /** Where the hub downloads it from (once). */
  source: string;
  durationMs: number;
  ext: 'ogg' | 'mp3';
  contentType: string;
  format: 'Ogg Vorbis' | 'MP3';
}

const CC0 = { licence: 'CC0 (public domain)', licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };

export const BUILTIN_ADHANS: BuiltinAdhan[] = [
  {
    id: 'adhan:beautiful', key: 'beautiful', title: 'Beautiful adhan', author: 'Adam-synagda', ...CC0,
    page: 'https://commons.wikimedia.org/wiki/File:Beautiful_adhan.ogg', source: 'https://upload.wikimedia.org/wikipedia/commons/b/b0/Beautiful_adhan.ogg',
    durationMs: 154_000, ext: 'ogg', contentType: 'audio/ogg', format: 'Ogg Vorbis',
  },
  {
    id: 'adhan:short', key: 'short', title: 'Adhan (short)', author: 'Aishatu98', ...CC0,
    page: 'https://commons.wikimedia.org/wiki/File:Adhan.ogg', source: 'https://upload.wikimedia.org/wikipedia/commons/e/e7/Adhan.ogg',
    durationMs: 42_000, ext: 'ogg', contentType: 'audio/ogg', format: 'Ogg Vorbis',
  },
  {
    id: 'adhan:azeez', key: 'azeez', title: 'The Adhan – Aaqib Azeez', author: 'Atcovi', licence: 'CC BY-SA 4.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    page: 'https://commons.wikimedia.org/wiki/File:The_Adhan_-_Muslim_Call_to_Prayer_-_Aaqib_Azeez.mp3', source: 'https://upload.wikimedia.org/wikipedia/commons/7/7d/The_Adhan_-_Muslim_Call_to_Prayer_-_Aaqib_Azeez.mp3',
    durationMs: 87_000, ext: 'mp3', contentType: 'audio/mpeg', format: 'MP3',
  },
];

export const builtinAdhan = (id: string) => BUILTIN_ADHANS.find(a => a.id === id || `adhan:${a.key}` === id);
/** Its attribution in one line: "Beautiful adhan · Adam-synagda · CC0 (public domain)". */
export const adhanCredit = (a: BuiltinAdhan) => `${a.title} · ${a.author} · ${a.licence}`;

/** The most a download may be (the three are 0.3–1.5 MB). */
const MAX_BYTES = 20 * 1024 * 1024;

export class Adhans {
  private loading = new Map<string, Promise<void>>();

  /** `fetch` for tests. Commons asks for a descriptive User-Agent. */
  constructor(private dir: string | null, private o: { fetch?: typeof fetch; userAgent?: string } = {}) {}

  private path(a: BuiltinAdhan) { return this.dir ? join(this.dir, 'builtin', `${a.key}.${a.ext}`) : null; }
  /** Downloaded and ready to serve. */
  ready(a: BuiltinAdhan): boolean { const p = this.path(a); return !!p && existsSync(p); }

  /** The file name speakers fetch it by, under /api/clip/. */
  static file(a: BuiltinAdhan) { return `adhan-${a.key}.${a.ext}`; }

  /** Download it if it isn't here yet (once, however many ask at the same time). Throws with a reason a person can read. */
  ensure(a: BuiltinAdhan): Promise<void> {
    if (this.ready(a)) return Promise.resolve();
    const p = this.path(a);
    if (!p) return Promise.reject(new Error('This hub has nowhere to keep recordings'));
    let job = this.loading.get(a.key);
    if (!job) {
      job = (async () => {
        let res: Response;
        try {
          res = await (this.o.fetch ?? fetch)(a.source, { headers: { 'user-agent': this.o.userAgent ?? 'KovaHub (smart home hub; announcement audio)' }, signal: AbortSignal.timeout(60_000) });
        } catch { throw new Error(`Couldn’t download “${a.title}” from Wikimedia Commons: is the hub online?`); }
        if (!res.ok) throw new Error(`Wikimedia Commons didn’t give “${a.title}” (${res.status})`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_BYTES || !sniffAudio(body)) throw new Error(`“${a.title}” didn’t download as audio`);
        mkdirSync(join(this.dir!, 'builtin'), { recursive: true });
        writeFileSync(`${p}.part`, body);
        renameSync(`${p}.part`, p);
      })().finally(() => this.loading.delete(a.key));
      this.loading.set(a.key, job);
    }
    return job;
  }

  /** The file for /api/clip/adhan-<key>.<ext>, once downloaded. */
  serve(name: string): { contentType: string; body: Buffer } | null {
    const a = BUILTIN_ADHANS.find(x => Adhans.file(x) === name);
    const p = a && this.path(a);
    return a && p && existsSync(p) ? { contentType: a.contentType, body: readFileSync(p) } : null;
  }
}
