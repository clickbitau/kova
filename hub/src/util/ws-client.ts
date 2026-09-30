import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';

// A small WebSocket client (RFC 6455, text frames only). Node's built-in
// WebSocket can't be told to accept a self-signed certificate per connection,
// which is what Samsung TVs present on port 8002, so we speak the protocol here.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encode one client→server frame (always masked). Exported for tests. */
export function encodeFrame(opcode: number, payload: Buffer, mask = true): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
  else { head.push(m | 127, 0, 0, 0, 0); const b = Buffer.alloc(4); b.writeUInt32BE(len); head.push(...b); }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, body]);
}

/** Pull complete frames off the front of `buf`. Returns the frames and what's left over. */
export function decodeFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 127, p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    const key = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    let payload = buf.subarray(p, p + len);
    if (key) { payload = Buffer.from(payload); for (let i = 0; i < len; i++) payload[i] ^= key[i & 3]; }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 15, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export class WsClient extends EventEmitter<{ message: [string]; close: [] }> {
  private buf: Buffer = Buffer.alloc(0);
  private partial: Buffer[] = [];
  closed = false;

  private constructor(private socket: Duplex, onMessage?: (msg: string, ws: WsClient) => void) {
    super();
    if (onMessage) this.on('message', m => onMessage(m, this));
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  /**
   * Connect to a ws:// or wss:// URL. `insecure` accepts self-signed certificates.
   * `onMessage` is attached before any data is read, so nothing sent right after the upgrade is missed.
   */
  static connect(url: string, opts: { insecure?: boolean; timeoutMs?: number; onMessage?: (msg: string, ws: WsClient) => void } = {}): Promise<WsClient> {
    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request({
        host: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
        ...(secure ? { rejectUnauthorized: !opts.insecure } : {}),
        timeout: opts.timeoutMs ?? 5000,
      });
      req.on('upgrade', (res, socket, head) => {
        const want = createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) { socket.destroy(); reject(new Error('Bad WebSocket handshake')); return; }
        socket.setTimeout(0);
        const ws = new WsClient(socket, opts.onMessage);
        if (head.length) ws.onData(head);
        resolve(ws);
      });
      req.on('response', res => { res.resume(); reject(new Error(`WebSocket upgrade refused (HTTP ${res.statusCode})`)); });
      req.on('timeout', () => req.destroy(new Error('WebSocket connect timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  private onData(d: Buffer): void {
    const { frames, rest } = decodeFrames(Buffer.concat([this.buf, d]));
    this.buf = rest;
    for (const f of frames) {
      if (f.opcode === 8) { this.close(); return; }
      if (f.opcode === 9) { this.write(10, f.payload); continue; }
      if (f.opcode === 10) continue;
      this.partial.push(f.payload);
      if (f.fin) { const msg = Buffer.concat(this.partial).toString('utf8'); this.partial = []; this.emit('message', msg); }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  private write(opcode: number, payload: Buffer): void {
    if (!this.closed) this.socket.write(encodeFrame(opcode, payload));
  }

  send(text: string): void { this.write(1, Buffer.from(text, 'utf8')); }

  close(): void {
    if (this.closed) return;
    this.write(8, Buffer.alloc(0));
    this.onClose();
  }
}
