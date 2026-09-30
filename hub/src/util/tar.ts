// A small ustar writer and reader (with PAX long names), enough for Kova's backups.
// Only regular files and directories; no links, no devices. Kept in-house so the
// hub has no native or shell dependency for backup and restore.

import { createReadStream } from 'node:fs';

export interface TarSource {
  /** Path inside the archive, with forward slashes. Directories end without a slash. */
  name: string;
  type: 'file' | 'dir';
  mode: number;
  mtimeMs: number;
  /** For files: either a path to read from, or the bytes. */
  path?: string;
  data?: Buffer;
  size?: number;
}

export interface TarEntry { name: string; type: 'file' | 'dir'; mode: number; mtimeMs: number; data: Buffer }

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, type: string, size: number, mode: number, mtimeMs: number, prefix = ''): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtimeMs / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('kova', 265, 'ascii');
  h.write('kova', 297, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

const pad = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** One PAX record: "<len> path=<value>\n", where len counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len++;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function headersFor(name: string, type: string, size: number, mode: number, mtimeMs: number): Buffer[] {
  if (Buffer.byteLength(name) <= 100) return [header(name, type, size, mode, mtimeMs)];
  const pax = paxRecord('path', name);
  const short = `PaxHeaders/${name.slice(-80)}`.slice(0, 100);
  return [header(short, 'x', pax.length, 0o644, mtimeMs), pax, pad(pax.length), header(name.slice(-100), type, size, mode, mtimeMs)];
}

/** The archive as a stream of chunks; pipe it through gzip into a file. */
export async function* tarStream(entries: Iterable<TarSource>): AsyncGenerator<Buffer> {
  for (const e of entries) {
    if (e.type === 'dir') {
      yield* headersFor(`${e.name}/`, '5', 0, e.mode, e.mtimeMs);
      continue;
    }
    const size = e.data ? e.data.length : e.size ?? 0;
    yield* headersFor(e.name, '0', size, e.mode, e.mtimeMs);
    if (e.data) yield e.data;
    else if (e.path) {
      let n = 0;
      for await (const chunk of createReadStream(e.path)) {
        const c = chunk as Buffer;
        // A file that grew while we read it: stop at the size we promised in the header.
        const take = Math.min(c.length, size - n);
        if (take > 0) yield take === c.length ? c : c.subarray(0, take);
        n += take;
      }
      if (n < size) yield Buffer.alloc(size - n); // shrank: pad so the archive stays valid
    }
    yield pad(size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

class ByteReader {
  private bufs: Buffer[] = [];
  private len = 0;
  constructor(private it: AsyncIterator<Buffer>) {}
  async need(n: number): Promise<boolean> {
    while (this.len < n) {
      const r = await this.it.next();
      if (r.done) return false;
      this.bufs.push(r.value);
      this.len += r.value.length;
    }
    return true;
  }
  take(n: number): Buffer {
    const all = this.bufs.length === 1 ? this.bufs[0] : Buffer.concat(this.bufs);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.bufs = rest.length ? [rest] : [];
    this.len = rest.length;
    return out;
  }
}

const str = (b: Buffer, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString('utf8');
};
const num = (b: Buffer, off: number, len: number) => parseInt(str(b, off, len).trim() || '0', 8);

/** Reads an (uncompressed) tar stream. Entries other than files and directories are skipped. */
export async function* untar(src: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const r = new ByteReader(src[Symbol.asyncIterator]());
  let longName: string | undefined;
  for (;;) {
    if (!(await r.need(BLOCK))) throw new Error('Truncated archive');
    const h = r.take(BLOCK);
    if (h.every(b => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== num(h, 148, 8)) throw new Error('Not a valid tar archive (bad header checksum)');
    const size = num(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (!(await r.need(padded))) throw new Error('Truncated archive');
    const data = Buffer.from(r.take(padded).subarray(0, size));
    if (type === 'x' || type === 'L') {
      if (type === 'L') longName = str(data, 0, data.length);
      else for (const m of data.toString('utf8').matchAll(/^\d+ path=(.*)$/gm)) longName = m[1];
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = undefined;
    const common = { name: name.replace(/\/+$/, ''), mode: num(h, 100, 8), mtimeMs: num(h, 136, 12) * 1000 };
    if (type === '5') yield { ...common, type: 'dir', data: Buffer.alloc(0) };
    else if (type === '0') yield { ...common, type: 'file', data };
  }
}
