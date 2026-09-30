import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Tuya local protocol (the "55AA" frame format) for firmware versions 3.3 and 3.4.
// 3.3: AES-128-ECB with the device's local key, CRC32 frame check.
// 3.4: a session key is negotiated first; frames are checked with HMAC-SHA256.

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

export type Version = '3.3' | '3.4';

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

const versionHeader = (v: Version) => Buffer.concat([Buffer.from(v), Buffer.alloc(12)]);

/** Encode a command payload the way a given protocol version expects. */
export function encodePayload(v: Version, cmd: number, json: unknown, key: Buffer): Buffer {
  const raw = Buffer.isBuffer(json) ? json : Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
  if (v === '3.4') {
    const needsHeader = cmd !== CMD.DP_QUERY_NEW && cmd !== CMD.HEART_BEAT && cmd !== CMD.SESS_KEY_NEG_START && cmd !== CMD.SESS_KEY_NEG_FINISH;
    return ecbEncrypt(key, needsHeader ? Buffer.concat([versionHeader(v), raw]) : raw);
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
