import net from 'node:net';
import { EventEmitter } from 'node:events';
import { CMD, VERSIONS, decodePayload, encodePayload, hmac, newNonce, pack, pack6699, sessionKey, sessionKey35, unpack, unpack6699, ecbDecrypt, type Frame, type Version } from './protocol.ts';

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
/** `cid`: which sub-device (Zigbee/BLE node behind this gateway) the data points are from; none for the device itself. */
export class TuyaConnection extends EventEmitter<{ dps: [Dps, string | undefined]; online: [boolean] }> {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private seq = 1;
  private waiting = new Map<number, { cmd: number; resolve: (f: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
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
    if (!VERSIONS.includes(o.version)) throw new Error(`Tuya ${o.id}: protocol ${o.version} is not supported (use 3.3, 3.4 or 3.5)`);
    this.key = this.localKey;
  }

  private get timeout() { return this.o.timeoutMs ?? 5000; }
  /** 3.4 and 3.5 negotiate a session key and use the "new" control/query commands. */
  private get modern() { return this.o.version !== '3.3'; }

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
    if (this.modern) await this.negotiate();
    this.setOnline(true);
    this.backoff = 1000;
    this.heartbeat = setInterval(() => void this.send(CMD.HEART_BEAT, {}).catch(() => this.sock?.destroy()), this.o.heartbeatMs ?? 10_000);
  }

  private async negotiate(): Promise<void> {
    const v35 = this.o.version === '3.5';
    const local = newNonce();
    const resp = this.expectCmd(CMD.SESS_KEY_NEG_RESP);
    // 3.4 ECB-encrypts the handshake payloads; 3.5 sends them as-is inside the GCM frame.
    this.write(CMD.SESS_KEY_NEG_START, v35 ? local : encodePayload('3.4', CMD.SESS_KEY_NEG_START, local, this.localKey));
    const f = await resp;
    let dec = f.payload;
    if (!v35) {
      if (dec.length % 16 === 4) dec = dec.subarray(4);
      try { dec = ecbDecrypt(this.localKey, dec); } catch { throw new Error(`Tuya ${this.o.id}: session key check failed (wrong local key?)`); }
    }
    const remote = dec.subarray(0, 16);
    if (dec.length < 48 || !dec.subarray(16, 48).equals(hmac(this.localKey, local))) throw new Error(`Tuya ${this.o.id}: session key check failed (wrong local key?)`);
    const finish = hmac(this.localKey, remote);
    this.write(CMD.SESS_KEY_NEG_FINISH, v35 ? finish : encodePayload('3.4', CMD.SESS_KEY_NEG_FINISH, finish, this.localKey));
    this.key = v35 ? sessionKey35(this.localKey, local, remote) : sessionKey(this.localKey, local, remote);
    this.hmacKey = v35 ? undefined : this.key;
  }

  private expectCmd(cmd: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waitingCmd = null; reject(new Error(`Tuya ${this.o.id}: no reply to handshake`)); }, this.timeout);
      this.waitingCmd = { cmd, resolve: f => { clearTimeout(t); this.waitingCmd = null; resolve(f); } };
    });
  }

  private write(cmd: number, payload: Buffer): number {
    const seq = this.seq++;
    this.sock?.write(this.o.version === '3.5' ? pack6699({ seq, cmd, payload }, this.key) : pack({ seq, cmd, payload }, this.hmacKey));
    return seq;
  }

  /** Send a command and wait for the device's reply to it. */
  async send(cmd: number, json: unknown): Promise<Frame> {
    if (!this.sock) throw new Error(`Tuya ${this.o.id} is not connected`);
    const payload = encodePayload(this.o.version, cmd, json, this.key);
    return new Promise((resolve, reject) => {
      const seq = this.write(cmd, payload);
      const timer = setTimeout(() => { this.waiting.delete(seq); reject(new Error(`Tuya ${this.o.id} didn't reply`)); }, this.timeout);
      this.waiting.set(seq, { cmd, resolve, reject, timer });
    });
  }

  private ts() { return String(Math.floor(Date.now() / 1000)); }

  /**
   * Set data points, e.g. { '1': true }. With `cid`, on that sub-device behind this gateway
   * (the gateway's own connection, addressed by the node id, as the Tuya app does).
   */
  async set(dps: Dps, cid?: string): Promise<void> {
    await this.connect();
    if (this.modern) await this.send(CMD.CONTROL_NEW, { protocol: 5, t: Number(this.ts()), data: cid ? { cid, dps } : { dps } });
    else if (cid) await this.send(CMD.CONTROL, { cid, t: this.ts(), dps });
    else await this.send(CMD.CONTROL, { devId: this.o.id, uid: this.o.id, t: this.ts(), dps });
  }

  /** Ask for all data points (of sub-device `cid`, through a gateway). The answer also arrives as a 'dps' event. */
  async query(cid?: string): Promise<Dps> {
    await this.connect();
    const f = cid
      ? await this.send(this.modern ? CMD.DP_QUERY_NEW : CMD.DP_QUERY, { cid })
      : this.modern
        ? await this.send(CMD.DP_QUERY_NEW, {})
        : await this.send(CMD.DP_QUERY, { gwId: this.o.id, devId: this.o.id, uid: this.o.id, t: this.ts() });
    const r = this.parse(f);
    return r && (!cid || !r.cid || r.cid === cid) ? r.dps : {};
  }

  private parse(f: Frame): { dps: Dps; cid?: string } | null {
    try {
      const text = decodePayload(this.o.version, f.payload, this.key).toString('utf8').trim();
      if (!text.startsWith('{')) return null;
      const j = JSON.parse(text) as { dps?: Dps; cid?: string; data?: { dps?: Dps; cid?: string } };
      const dps = j.dps ?? j.data?.dps;
      if (!dps) return null;
      const cid = j.cid ?? j.data?.cid;
      return cid ? { dps, cid: String(cid) } : { dps };
    } catch { return null; }
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    const { frames, rest } = this.o.version === '3.5' ? unpack6699(this.buf, this.key) : unpack(this.buf, this.hmacKey);
    this.buf = rest;
    for (const f of frames) {
      if (this.waitingCmd?.cmd === f.cmd) { this.waitingCmd.resolve(f); continue; }
      const got = f.cmd === CMD.HEART_BEAT ? null : this.parse(f);
      // 3.5 devices answer with their own running sequence number, so match those replies by command.
      let seq: number | undefined = this.waiting.has(f.seq) ? f.seq : undefined;
      if (seq === undefined && this.o.version === '3.5') seq = [...this.waiting].find(([, w]) => w.cmd === f.cmd)?.[0];
      const w = seq === undefined ? undefined : this.waiting.get(seq);
      if (w) { clearTimeout(w.timer); this.waiting.delete(seq!); w.resolve(f); }
      if (got && Object.keys(got.dps).length) this.emit('dps', got.dps, got.cid);
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
