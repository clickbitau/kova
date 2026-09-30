import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Adapter, AdapterContext, AdapterStatus, DeviceInfo } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';

// TP-Link Tapo plugs and bulbs over their local "KLAP" HTTP protocol (newer
// firmware). Needs the TP-Link account email and password the devices were set
// up with: the handshake proves both sides know them.

const sha256 = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const sha1 = (s: string) => createHash('sha1').update(s).digest();

export function authHash(username: string, password: string): Buffer {
  return sha256(sha1(username), sha1(password));
}

/** One authenticated KLAP session with a device. */
export class KlapSession {
  private key!: Buffer;
  private iv!: Buffer;
  private sig!: Buffer;
  private seq = 0;
  private cookie = '';
  private expires = 0;

  constructor(private base: string, private auth: Buffer[], private timeoutMs = 5000) {}

  private async post(path: string, body: Buffer): Promise<{ status: number; body: Buffer; cookie?: string }> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST', body: new Uint8Array(body), signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/octet-stream', ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), cookie: res.headers.get('set-cookie') ?? undefined };
  }

  async handshake(): Promise<void> {
    this.cookie = '';
    const local = randomBytes(16);
    const h1 = await this.post('/app/handshake1', local);
    if (h1.status !== 200 || h1.body.length < 48) throw new Error(`Tapo handshake failed (HTTP ${h1.status})`);
    const remote = h1.body.subarray(0, 16), serverHash = h1.body.subarray(16, 48);
    // Try the account credentials first, then any fallbacks (e.g. blank for unclaimed devices).
    const auth = this.auth.find(a => sha256(local, remote, a).equals(serverHash));
    if (!auth) throw new Error('Tapo rejected the TP-Link email/password');
    const m = h1.cookie?.match(/TP_SESSIONID=([^;]+)/);
    this.cookie = m ? `TP_SESSIONID=${m[1]}` : '';
    const t = h1.cookie?.match(/TIMEOUT=(\d+)/);
    const h2 = await this.post('/app/handshake2', sha256(remote, local, auth));
    if (h2.status !== 200) throw new Error(`Tapo handshake2 failed (HTTP ${h2.status})`);
    const lh = Buffer.concat([local, remote, auth]);
    this.key = sha256(Buffer.from('lsk'), lh).subarray(0, 16);
    const ivseq = sha256(Buffer.from('iv'), lh);
    this.iv = ivseq.subarray(0, 12);
    this.seq = ivseq.readInt32BE(28);
    this.sig = sha256(Buffer.from('ldk'), lh).subarray(0, 28);
    this.expires = Date.now() + (Number(t?.[1] ?? 86400) - 1200) * 1000;
  }

  private ivFor(seq: number): Buffer {
    const s = Buffer.alloc(4);
    s.writeInt32BE(seq);
    return Buffer.concat([this.iv, s]);
  }

  async request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.key || Date.now() > this.expires) await this.handshake();
      this.seq = (this.seq + 1) | 0;
      const seq = this.seq;
      const c = createCipheriv('aes-128-cbc', this.key, this.ivFor(seq));
      const cipher = Buffer.concat([c.update(JSON.stringify({ method, ...(params ? { params } : {}), request_time_milis: Date.now() })), c.final()]);
      const s = Buffer.alloc(4); s.writeInt32BE(seq);
      const res = await this.post(`/app/request?seq=${seq}`, Buffer.concat([sha256(this.sig, s, cipher), cipher]));
      if (res.status === 403 || res.status === 401) { this.key = undefined as unknown as Buffer; continue; }
      if (res.status !== 200) throw new Error(`Tapo request failed (HTTP ${res.status})`);
      const d = createDecipheriv('aes-128-cbc', this.key, this.ivFor(seq));
      const j = JSON.parse(Buffer.concat([d.update(res.body.subarray(32)), d.final()]).toString()) as { error_code: number; result?: T };
      if (j.error_code !== 0) throw new Error(`Tapo error ${j.error_code}`);
      return (j.result ?? {}) as T;
    }
    throw new Error('Tapo session expired');
  }
}

export interface TapoDeviceConfig { host: string; room: string; name?: string; /** Kova device id to use instead of one derived from the device. */ id?: string }
export interface TapoOptions {
  username?: string;
  password?: string;
  /** Base64 of the KLAP auth hash, as stored by Home Assistant's tplink integration (credentials_hash). */
  authHash?: string;
  devices: TapoDeviceConfig[];
  pollMs?: number;
  timeoutMs?: number;
}

interface TapoInfo {
  device_id: string; model: string; nickname?: string; device_on: boolean;
  brightness?: number; color_temp?: number; hue?: number; saturation?: number; color_temp_range?: [number, number];
}

/** '#rrggbb' → Tapo hue (0–360) and saturation (0–100). Exported for tests. */
export function hexToHs(hex: string): { hue: number; saturation: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: Math.round((h * 60 + 360) % 360), saturation: Math.round(max ? (d / max) * 100 : 0) };
}

export function hsToHex(hue: number, sat: number): string {
  const s = sat / 100, c = s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = 1 - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

function toState(i: TapoInfo): DeviceState {
  const s: DeviceState = { on: i.device_on, online: true };
  if (i.brightness != null) s.bri = i.brightness;
  if (i.color_temp) { s.k = i.color_temp; s.color = null; }
  else if (i.hue != null && i.saturation != null && i.brightness != null) s.color = hsToHex(i.hue, i.saturation);
  return s;
}

export class TapoAdapter implements Adapter {
  id = 'tapo';
  name = 'TP-Link Tapo';
  icon = 'outlet';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private sessions = new Map<string, KlapSession>();
  private byHost = new Map<string, string>();
  private failing = new Set<string>();
  private poller: NodeJS.Timeout | null = null;

  constructor(private opts: TapoOptions) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const auth = [
      ...(this.opts.authHash ? [Buffer.from(this.opts.authHash, 'base64')] : []),
      ...(this.opts.username != null ? [authHash(this.opts.username, this.opts.password ?? '')] : []),
      authHash('', ''),
    ];
    await Promise.all(this.opts.devices.map(async d => {
      const s = new KlapSession(`http://${d.host}`, auth, this.opts.timeoutMs);
      this.sessions.set(d.host, s);
      try {
        const i = await s.request<TapoInfo>('get_device_info');
        const bulb = i.brightness != null;
        const caps: DeviceInfo['capabilities'] = bulb ? ['onoff', 'brightness'] : ['onoff'];
        if (bulb && i.color_temp_range) caps.push('colorTemp');
        if (bulb && i.hue != null) caps.push('color');
        const id = d.id ?? `tapo_${i.device_id.slice(-12).toLowerCase()}`;
        this.byHost.set(d.host, id);
        const name = d.name ?? (i.nickname ? Buffer.from(i.nickname, 'base64').toString() : i.model);
        ctx.announce([{ id, name, room: d.room, type: bulb ? 'dimmer' : 'plug', integration: `TP-Link ${i.model}`, address: d.host, capabilities: caps }]);
        ctx.report(id, toState(i));
      } catch (err) {
        this.failing.add(d.host);
        ctx.log(`${d.host}: ${(err as Error).message}`);
      }
    }));
    const every = this.opts.pollMs ?? 10_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  private async poll(): Promise<void> {
    await Promise.all([...this.byHost].map(async ([host, id]) => {
      try {
        this.ctx!.report(id, toState(await this.sessions.get(host)!.request<TapoInfo>('get_device_info')));
        this.failing.delete(host);
      } catch {
        this.failing.add(host);
        this.ctx!.report(id, { online: false });
      }
    }));
  }

  async command(d: Device, cmd: Command): Promise<void> {
    const s = this.sessions.get(d.address);
    if (!s) throw new Error(`Unknown Tapo device ${d.id}`);
    const p: Record<string, unknown> = {};
    if (cmd.on !== undefined) p.device_on = !!cmd.on;
    if (cmd.bri != null) p.brightness = Math.max(1, Math.min(100, Math.round(cmd.bri)));
    if (cmd.k != null) { p.color_temp = cmd.k; }
    if (cmd.color) { Object.assign(p, hexToHs(cmd.color)); p.color_temp = 0; }
    if (Object.keys(p).length) await s.request('set_device_info', p);
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); }

  status(): AdapterStatus {
    const n = this.opts.devices.length;
    if (this.failing.size) return { ok: false, note: `${this.failing.size} of ${n} not responding` };
    return { ok: n > 0, note: `${n} device${n === 1 ? '' : 's'}` };
  }
}
