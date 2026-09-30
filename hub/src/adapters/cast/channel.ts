import tls from 'node:tls';
import net from 'node:net';
import { EventEmitter } from 'node:events';

// Google Cast v2 protocol: length-prefixed protobuf CastMessage frames over TLS
// on port 8009. The message is small enough to encode by hand.

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
  multizone: 'urn:x-cast:com.google.cast.multizone',
} as const;

export interface CastMessage { source: string; destination: string; namespace: string; data: Record<string, unknown> }

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

const str = (field: number, s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(b.length), b]); };

export function encodeMessage(m: CastMessage): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]),            // protocol_version = CASTV2_1_0
    str(2, m.source), str(3, m.destination), str(4, m.namespace),
    Buffer.from([0x28, 0x00]),            // payload_type = STRING
    str(6, JSON.stringify(m.data)),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

export function decodeMessage(b: Buffer): CastMessage {
  const f: Record<number, string> = {};
  let i = 0;
  while (i < b.length) {
    const key = b[i++];
    const field = key >> 3, wire = key & 7;
    if (wire === 0) { while (b[i++] & 0x80); continue; }
    if (wire !== 2) throw new Error('Unexpected Cast wire type');
    let len = 0, shift = 0, byte: number;
    do { byte = b[i++]; len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    f[field] = b.subarray(i, i + len).toString('utf8');
    i += len;
  }
  return { source: f[2] ?? '', destination: f[3] ?? '', namespace: f[4] ?? '', data: f[6] ? JSON.parse(f[6]) : {} };
}

export interface ChannelOptions { host: string; port?: number; /** Plain TCP, for tests. */ insecure?: boolean; timeoutMs?: number }

/**
 * A connection to one Cast device (or Cast group). Answers heartbeats,
 * matches replies to requests by requestId, and emits every message.
 */
export class CastChannel extends EventEmitter<{ message: [CastMessage]; close: [] }> {
  private sock: net.Socket | tls.TLSSocket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private reqId = 1;
  private pending = new Map<number, { resolve: (m: CastMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ping: NodeJS.Timeout | null = null;
  private connected = new Set<string>();

  constructor(private o: ChannelOptions) { super(); }

  get open() { return !!this.sock; }

  async connect(): Promise<void> {
    if (this.sock) return;
    const port = this.o.port ?? 8009;
    await new Promise<void>((resolve, reject) => {
      const s = this.o.insecure
        ? net.connect({ host: this.o.host, port }, () => resolve())
        : tls.connect({ host: this.o.host, port, rejectUnauthorized: false }, () => resolve());
      const t = setTimeout(() => { s.destroy(); reject(new Error(`Timed out connecting to ${this.o.host}`)); }, this.o.timeoutMs ?? 5000);
      s.once('connect', () => clearTimeout(t));
      s.once('secureConnect', () => clearTimeout(t));
      s.once('error', e => { clearTimeout(t); reject(e); });
      s.on('data', d => this.onData(d));
      s.on('close', () => this.onClose(s));
      s.on('error', () => { /* close follows */ });
      this.sock = s;
    });
    this.connectTo('receiver-0');
    this.ping = setInterval(() => this.send(NS.heartbeat, 'receiver-0', { type: 'PING' }), 5000);
  }

  /** Open a virtual connection to a receiver or a running app's transport. */
  connectTo(dest: string): void {
    if (this.connected.has(dest)) return;
    this.connected.add(dest);
    this.send(NS.connection, dest, { type: 'CONNECT' });
  }

  send(namespace: string, destination: string, data: Record<string, unknown>): void {
    this.sock?.write(encodeMessage({ source: 'sender-0', destination, namespace, data }));
  }

  /** Send and wait for the reply carrying the same requestId. */
  request(namespace: string, destination: string, data: Record<string, unknown>): Promise<CastMessage> {
    const requestId = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${this.o.host}: no reply to ${String(data.type)}`)); }, this.o.timeoutMs ?? 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(namespace, destination, { ...data, requestId });
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const raw = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let m: CastMessage;
      try { m = decodeMessage(raw); } catch { continue; }
      if (m.namespace === NS.heartbeat && m.data.type === 'PING') { this.send(NS.heartbeat, m.source, { type: 'PONG' }); continue; }
      const id = m.data.requestId as number | undefined;
      const p = id ? this.pending.get(id) : undefined;
      if (p) { clearTimeout(p.timer); this.pending.delete(id!); p.resolve(m); }
      this.emit('message', m);
    }
  }

  private onClose(s: net.Socket): void {
    if (s !== this.sock) return;
    this.sock = null;
    this.connected.clear();
    if (this.ping) clearInterval(this.ping);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${this.o.host} disconnected`)); }
    this.pending.clear();
    this.emit('close');
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    this.sock?.destroy();
    this.sock = null;
  }
}
