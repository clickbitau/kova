import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Tuya local protocol for firmware versions 3.3, 3.4 and 3.5.
// 3.3: "55AA" frames, AES-128-ECB with the device's local key, CRC32 frame check.
// 3.4: "55AA" frames; a session key is negotiated first; frames are checked with HMAC-SHA256.
// 3.5: "6699" frames, each one sealed with AES-128-GCM (the header is the associated data);
//      the same nonce exchange as 3.4, but the session key comes out of GCM instead of ECB.

export const CMD = {
  SESS_KEY_NEG_START: 0x03,
  SESS_KEY_NEG_RESP: 0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  CONTROL: 0x07,
  STATUS: 0x08,
  HEART_BEAT: 0x09,
  DP_QUERY: 0x0a,
  CONTROL_NEW: 0x0d,
  DP_QUERY_NEW: 0x10,
  UPDATEDPS: 0x12,
} as const;

const PREFIX = 0x000055aa;
const SUFFIX = 0x0000aa55;

export type Version = '3.3' | '3.4' | '3.5';
export const VERSIONS: readonly Version[] = ['3.3', '3.4', '3.5'];

const PREFIX_6699 = 0x00006699;
const SUFFIX_6699 = 0x00009966;

export function ecbEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const c = createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

export function ecbDecrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const d = createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(pad);
  return Buffer.concat([d.update(data), d.final()]);
}

export const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export interface Frame { seq: number; cmd: number; payload: Buffer }

/** Build a frame. `hmacKey` selects the 3.4 trailer; otherwise CRC32. */
export function pack(f: Frame, hmacKey?: Buffer): Buffer {
  const trailerLen = hmacKey ? 32 : 4;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(PREFIX, 0);
  head.writeUInt32BE(f.seq >>> 0, 4);
  head.writeUInt32BE(f.cmd, 8);
  head.writeUInt32BE(f.payload.length + trailerLen + 4, 12);
  const body = Buffer.concat([head, f.payload]);
  const check = hmacKey ? hmac(hmacKey, body) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(body) >>> 0); return b; })();
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(SUFFIX);
  return Buffer.concat([body, check, tail]);
}

/**
 * Pull complete frames out of a TCP stream buffer. Returns the frames and
 * whatever bytes are left over. Frames failing the integrity check are dropped.
 */
export function unpack(buf: Buffer, hmacKey?: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 24) {
    if (buf.readUInt32BE(off) !== PREFIX) {
      const next = buf.indexOf(Buffer.from([0, 0, 0x55, 0xaa]), off + 1);
      if (next < 0) { off = buf.length; break; }
      off = next;
      continue;
    }
    const len = buf.readUInt32BE(off + 12);
    const total = 16 + len;
    if (buf.length - off < total) break;
    const frame = buf.subarray(off, off + total);
    const trailerLen = hmacKey ? 32 : 4;
    const body = frame.subarray(0, total - trailerLen - 4);
    const check = frame.subarray(total - trailerLen - 4, total - 4);
    const ok = hmacKey ? hmac(hmacKey, body).equals(check) : (crc32(body) >>> 0) === check.readUInt32BE(0);
    if (ok) frames.push({ seq: frame.readUInt32BE(4), cmd: frame.readUInt32BE(8), payload: Buffer.from(body.subarray(16)) });
    off += total;
  }
  return { frames, rest: Buffer.from(buf.subarray(off)) };
}

/**
 * Build a 3.5 ("6699") frame: 18-byte header (prefix, 2 zero bytes, seq, cmd, length),
 * then IV(12) + AES-GCM ciphertext + tag(16), then the suffix. Header bytes 4–18 are the
 * GCM associated data. `retcode` is only set on frames a device sends.
 */
export function pack6699(f: Frame & { retcode?: number }, key: Buffer, iv: Buffer = randomBytes(12)): Buffer {
  const plain = f.retcode != null ? Buffer.concat([u32(f.retcode), f.payload]) : f.payload;
  const head = Buffer.alloc(18);
  head.writeUInt32BE(PREFIX_6699, 0);
  head.writeUInt16BE(0, 4);
  head.writeUInt32BE(f.seq >>> 0, 6);
  head.writeUInt32BE(f.cmd, 10);
  head.writeUInt32BE(12 + plain.length + 16, 14);
  const c = createCipheriv('aes-128-gcm', key, iv);
  c.setAAD(head.subarray(4));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, iv, ct, c.getAuthTag(), u32(SUFFIX_6699)]);
}

/**
 * Pull 3.5 frames out of a stream buffer. Frames that fail GCM authentication are dropped.
 * Devices put a 4-byte return code in front of every payload (`retcode: true`, as tinytuya
 * does); UDP broadcasts may or may not have one (`'auto'`).
 */
export function unpack6699(buf: Buffer, key: Buffer, retcode: boolean | 'auto' = true): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 18) {
    if (buf.readUInt32BE(off) !== PREFIX_6699) {
      const next = buf.indexOf(Buffer.from([0, 0, 0x66, 0x99]), off + 1);
      if (next < 0) { off = buf.length; break; }
      off = next;
      continue;
    }
    const len = buf.readUInt32BE(off + 14);
    const total = 18 + len + 4;
    if (len < 28) { off += 4; continue; }
    if (buf.length - off < total) break;
    const frame = buf.subarray(off, off + total);
    off += total;
    const iv = frame.subarray(18, 30), ct = frame.subarray(30, 18 + len - 16), tag = frame.subarray(18 + len - 16, 18 + len);
    let plain: Buffer;
    try {
      const d = createDecipheriv('aes-128-gcm', key, iv);
      d.setAAD(frame.subarray(4, 18));
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(ct), d.final()]);
    } catch { continue; }
    const strip = retcode === true ? plain.length >= 4 : retcode === 'auto' && plain.length > 4 && plain[0] !== 0x7b && plain[4] === 0x7b;
    frames.push({ seq: frame.readUInt32BE(6), cmd: frame.readUInt32BE(10), payload: Buffer.from(strip ? plain.subarray(4) : plain) });
  }
  return { frames, rest: Buffer.from(buf.subarray(off)) };
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

const versionHeader = (v: Version) => Buffer.concat([Buffer.from(v), Buffer.alloc(12)]);

/** Commands whose payload goes without the "3.x" version header on 3.4/3.5. */
const NO_HEADER = new Set<number>([CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.UPDATEDPS, CMD.HEART_BEAT, CMD.SESS_KEY_NEG_START, CMD.SESS_KEY_NEG_RESP, CMD.SESS_KEY_NEG_FINISH]);

/**
 * Encode a command payload the way a given protocol version expects.
 * For 3.5 this is the plaintext only: `pack6699` does the encryption.
 */
export function encodePayload(v: Version, cmd: number, json: unknown, key: Buffer): Buffer {
  const raw = Buffer.isBuffer(json) ? json : Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
  if (v === '3.4' || v === '3.5') {
    const plain = NO_HEADER.has(cmd) ? raw : Buffer.concat([versionHeader(v), raw]);
    return v === '3.5' ? plain : ecbEncrypt(key, plain);
  }
  const enc = ecbEncrypt(key, raw);
  return cmd === CMD.DP_QUERY || cmd === CMD.HEART_BEAT ? enc : Buffer.concat([versionHeader(v), enc]);
}

/** Decode a device payload to text (usually JSON). Handles return codes and version headers. */
export function decodePayload(v: Version, payload: Buffer, key: Buffer): Buffer {
  let p = payload;
  const hasHeader = (b: Buffer) => b.length >= 15 && b.subarray(0, 3).toString() === v;
  if (v === '3.3') {
    if (!hasHeader(p) && p.length >= 4 && (p.length - 4) % 16 !== 0 && hasHeader(p.subarray(4))) p = p.subarray(4);
    else if (!hasHeader(p) && p.length % 16 === 4) p = p.subarray(4);
    if (hasHeader(p)) p = p.subarray(15);
    if (!p.length || p[0] === 0x7b /* { */) return p;
    return ecbDecrypt(key, p);
  }
  if (v === '3.5') return hasHeader(p) ? p.subarray(15) : p; // already decrypted by unpack6699
  if (p.length % 16 === 4) p = p.subarray(4);
  if (!p.length) return p;
  let d = ecbDecrypt(key, p);
  if (hasHeader(d)) d = d.subarray(15);
  return d;
}

export const newNonce = () => randomBytes(16);

/** 3.4 session key: the XOR of both nonces, encrypted with the local key. */
export function sessionKey(localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
  const x = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) x[i] = localNonce[i] ^ remoteNonce[i];
  return ecbEncrypt(localKey, x, false);
}

/** 3.5 session key: the XOR of both nonces, AES-GCM-encrypted with the local key and the local nonce's first 12 bytes as IV (ciphertext only). */
export function sessionKey35(localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
  const x = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) x[i] = localNonce[i] ^ remoteNonce[i];
  const c = createCipheriv('aes-128-gcm', localKey, localNonce.subarray(0, 12));
  return Buffer.concat([c.update(x), c.final()]).subarray(0, 16);
}
