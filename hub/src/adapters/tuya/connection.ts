import net from 'node:net';
import { EventEmitter } from 'node:events';
import { CMD, decodePayload, encodePayload, hmac, newNonce, pack, sessionKey, unpack, ecbDecrypt, type Frame, type Version } from './protocol.ts';

export type Dps = Record<string, string | number | boolean>;

export interface ConnectionOptions {
  id: string;
  host: string;
  key: string;
  version: Version;
  port?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
}

/**
 * One persistent TCP connection to a Tuya device. Reconnects by itself,
 * sends a heartbeat, and emits 'dps' whenever the device reports state.
 */
export class TuyaConnection extends EventEmitter<{ dps: [Dps]; online: [boolean] }> {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private seq = 1;
  private waiting = new Map<number, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private waitingCmd: { cmd: number; resolve: (f: Frame) => void } | null = null;
  private readonly localKey: Buffer;
  private key: Buffer;
  private hmacKey?: Buffer;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private closed = false;
  private connecting: Promise<void> | null = null;
  online = false;

  constructor(private o: ConnectionOptions) {
    super();
    this.localKey = Buffer.from(o.key, 'utf8');
    if (this.localKey.length !== 16) throw new Error(`Tuya local key for ${o.id} must be 16 characters`);
    this.key = this.localKey;
  }

  private get timeout() { return this.o.timeoutMs ?? 5000; }

  /** Connect (or reuse the live connection). */
  connect(): Promise<void> {
    if (this.online && this.sock) return Promise.resolve();
    this.connecting ??= this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    this.key = this.localKey;
    this.hmacKey = this.o.version === '3.4' ? this.localKey : undefined;
    this.buf = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: this.o.host, port: this.o.port ?? 6668 });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`Timed out connecting to ${this.o.host}`)); }, this.timeout);
      s.once('connect', () => { clearTimeout(t); resolve(); });
      s.once('error', e => { clearTimeout(t); reject(e); });
      s.on('data', d => this.onData(d));
      s.on('close', () => this.onClose(s));
      s.on('error', () => { /* handled by close */ });
      this.sock = s;
    });
    if (this.o.version === '3.4') await this.negotiate();
    this.setOnline(true);
    this.backoff = 1000;
    this.heartbeat = setInterval(() => void this.send(CMD.HEART_BEAT, {}).catch(() => this.sock?.destroy()), this.o.heartbeatMs ?? 10_000);
  }

  private async negotiate(): Promise<void> {
    const local = newNonce();
    const resp = this.expectCmd(CMD.SESS_KEY_NEG_RESP);
    this.write(CMD.SESS_KEY_NEG_START, encodePayload('3.4', CMD.SESS_KEY_NEG_START, local, this.localKey));
    const f = await resp;
    let p = f.payload;
    if (p.length % 16 === 4) p = p.subarray(4);
    const dec = ecbDecrypt(this.localKey, p);
    const remote = dec.subarray(0, 16);
    if (!dec.subarray(16, 48).equals(hmac(this.localKey, local))) throw new Error(`Tuya ${this.o.id}: session key check failed (wrong local key?)`);
    this.write(CMD.SESS_KEY_NEG_FINISH, encodePayload('3.4', CMD.SESS_KEY_NEG_FINISH, hmac(this.localKey, remote), this.localKey));
    this.key = sessionKey(this.localKey, local, remote);
    this.hmacKey = this.key;
  }

  private expectCmd(cmd: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waitingCmd = null; reject(new Error(`Tuya ${this.o.id}: no reply to handshake`)); }, this.timeout);
      this.waitingCmd = { cmd, resolve: f => { clearTimeout(t); this.waitingCmd = null; resolve(f); } };
    });
  }

  private write(cmd: number, payload: Buffer): number {
    const seq = this.seq++;
    this.sock?.write(pack({ seq, cmd, payload }, this.hmacKey));
    return seq;
  }

  /** Send a command and wait for the device's reply to it. */
  async send(cmd: number, json: unknown): Promise<Frame> {
    if (!this.sock) throw new Error(`Tuya ${this.o.id} is not connected`);
    const payload = encodePayload(this.o.version, cmd, json, this.key);
    return new Promise((resolve, reject) => {
      const seq = this.write(cmd, payload);
      const timer = setTimeout(() => { this.waiting.delete(seq); reject(new Error(`Tuya ${this.o.id} didn't reply`)); }, this.timeout);
      this.waiting.set(seq, { resolve, reject, timer });
    });
  }

  private ts() { return String(Math.floor(Date.now() / 1000)); }

  /** Set data points, e.g. { '1': true }. */
  async set(dps: Dps): Promise<void> {
    await this.connect();
    if (this.o.version === '3.4') await this.send(CMD.CONTROL_NEW, { protocol: 5, t: Number(this.ts()), data: { dps } });
    else await this.send(CMD.CONTROL, { devId: this.o.id, uid: this.o.id, t: this.ts(), dps });
  }

  /** Ask for all data points. The answer also arrives as a 'dps' event. */
  async query(): Promise<Dps> {
    await this.connect();
    const f = this.o.version === '3.4'
      ? await this.send(CMD.DP_QUERY_NEW, {})
      : await this.send(CMD.DP_QUERY, { gwId: this.o.id, devId: this.o.id, uid: this.o.id, t: this.ts() });
    return this.parse(f) ?? {};
  }

  private parse(f: Frame): Dps | null {
    try {
      const text = decodePayload(this.o.version, f.payload, this.key).toString('utf8').trim();
      if (!text.startsWith('{')) return null;
      const j = JSON.parse(text) as { dps?: Dps; data?: { dps?: Dps } };
      return j.dps ?? j.data?.dps ?? null;
    } catch { return null; }
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    const { frames, rest } = unpack(this.buf, this.hmacKey);
    this.buf = rest;
    for (const f of frames) {
      if (this.waitingCmd?.cmd === f.cmd) { this.waitingCmd.resolve(f); continue; }
      const dps = f.cmd === CMD.HEART_BEAT ? null : this.parse(f);
      const w = this.waiting.get(f.seq);
      if (w) { clearTimeout(w.timer); this.waiting.delete(f.seq); w.resolve(f); }
      if (dps && Object.keys(dps).length) this.emit('dps', dps);
    }
  }

  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    this.emit('online', v);
  }

  private onClose(s: net.Socket): void {
    if (s !== this.sock) return;
    this.sock = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(`Tuya ${this.o.id} disconnected`)); }
    this.waiting.clear();
    this.setOnline(false);
    this.scheduleReconnect();
  }

  scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(() => this.query()).catch(() => this.scheduleReconnect());
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.sock?.destroy();
    this.sock = null;
  }
}
