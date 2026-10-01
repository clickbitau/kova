import dgram from 'node:dgram';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';
import { WsClient } from '../util/ws-client.ts';

// Samsung Tizen TVs (2016+) over their local network APIs. No SmartThings, no cloud.
//
//  * :8001  GET /api/v2/          device info, including PowerState ("on" / "standby") on 2018+ models
//  * :8002  wss …samsung.remote.control   the remote-control WebSocket (self-signed TLS). The first
//           connection makes the TV ask "Allow Kova?"; after that it hands back a token we keep.
//  * :9197  UPnP/DLNA MediaRenderer   RenderingControl GetVolume/SetVolume, for exact volume
//  * Wake-on-LAN   the only way to switch on a TV that is fully off (its network is down in deep standby)
//
// Volume: set with DLNA SetVolume when the TV answers on :9197; otherwise pressed
// KEY_VOLUP / KEY_VOLDOWN from the last volume DLNA reported.

export const DEFAULT_PORTS = { info: 8001, remote: 8002, dlna: 9197 };
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

export interface SamsungTvConfig {
  host: string;
  room: string;
  name?: string;
  /** Kova device id to use instead of one derived from the host. */
  id?: string;
  /** For Wake-on-LAN. Read from the TV's info endpoint when not given. */
  mac?: string;
}

export interface SamsungTvOptions {
  tvs: SamsungTvConfig[];
  /** Where pairing tokens are kept (tokens.json, owner-only). */
  storageDir: string;
  pollMs?: number;
  ports?: Partial<typeof DEFAULT_PORTS>;
  /** Use wss:// on the remote port (default). Only tests turn this off. */
  secure?: boolean;
  /** Where Wake-on-LAN packets go. Default 255.255.255.255:9. */
  wol?: { address?: string; port?: number };
  /** How long to wait for someone to press Allow on the TV. */
  pairTimeoutMs?: number;
  timeoutMs?: number;
  /** Gap between repeated key presses (volume steps). */
  keyDelayMs?: number;
  /** How long an input asked for right after waking the TV waits for it to come on (default 30 s), and how often to look (1 s). */
  wakeWaitMs?: number;
  wakeCheckMs?: number;
  /** Name shown on the TV's Allow prompt. */
  clientName?: string;
}

// ---------------------------------------------------------------- pure helpers --

export function remoteUrl(host: string, port: number, name: string, token?: string, secure = true): string {
  const q = `name=${encodeURIComponent(Buffer.from(name).toString('base64'))}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return `${secure ? 'wss' : 'ws'}://${host}:${port}/api/v2/channels/samsung.remote.control?${q}`;
}

export function keyMessage(key: string): string {
  return JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
}

/** Wake-on-LAN magic packet: 6 × 0xFF then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`Not a MAC address: ${mac}`);
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
}

export interface TvInfo { on: boolean; name?: string; model?: string; mac?: string }

/** Parse GET :8001/api/v2/. Older TVs have no PowerState: answering at all means on. */
export function parseInfo(j: { name?: string; device?: { PowerState?: string; name?: string; modelName?: string; wifiMac?: string } }): TvInfo {
  const d = j.device ?? {};
  return { on: d.PowerState ? d.PowerState.toLowerCase() === 'on' : true, name: d.name ?? j.name, model: d.modelName, mac: d.wifiMac };
}

/** The remote key that switches to an input ("hdmi1".."hdmi4", "tv"). */
export function inputKey(input: string): string {
  const m = /^hdmi([1-4])$/.exec(input);
  if (m) return `KEY_HDMI${m[1]}`;
  if (input === 'tv') return 'KEY_TV';
  throw new Error(`Unknown TV input ${input}: use hdmi1..hdmi4 or tv`);
}

/** Which key to press, and how often, to go from one volume to another. */
export function volumeSteps(from: number, to: number): { key: 'KEY_VOLUP' | 'KEY_VOLDOWN'; n: number } {
  return to >= from ? { key: 'KEY_VOLUP', n: Math.round(to - from) } : { key: 'KEY_VOLDOWN', n: Math.round(from - to) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1];

/** The RenderingControl controlURL from a UPnP device description. */
export function renderingControlUrl(xml: string): string | undefined {
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    if (tag(m[1], 'serviceType')?.trim() === RC) return tag(m[1], 'controlURL')?.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------- adapter --

interface Tv {
  cfg: SamsungTvConfig;
  id: string;
  on: boolean;
  online: boolean;
  vol: number | null;
  mac?: string;
  ws?: WsClient;
  connecting?: Promise<WsClient>;
  /** Absolute RenderingControl URL, null once we know DLNA isn't there. */
  dlna?: string | null;
  /** Woken until then: an input asked for meanwhile waits for the TV to answer. */
  wakingUntil?: number;
}

export class SamsungTvAdapter implements Adapter {
  id = 'samsungtv';
  name = 'Samsung TV';
  icon = 'tv';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private tvs = new Map<string, Tv>();
  private tokens: Record<string, string> = {};
  private pairing = new Set<string>();
  private refused = new Set<string>();
  private poller: NodeJS.Timeout | null = null;
  private ports: typeof DEFAULT_PORTS;
  private tokenFile: string;

  constructor(private opts: SamsungTvOptions) {
    this.ports = { ...DEFAULT_PORTS, ...opts.ports };
    this.tokenFile = join(opts.storageDir, 'tokens.json');
  }

  private get timeout() { return this.opts.timeoutMs ?? 4000; }

  private loadTokens(): void {
    try { if (existsSync(this.tokenFile)) this.tokens = JSON.parse(readFileSync(this.tokenFile, 'utf8')); }
    catch (err) { this.ctx?.log(`can't read ${this.tokenFile}`, err); }
  }

  private saveToken(host: string, token: string): void {
    if (this.tokens[host] === token) return;
    this.tokens[host] = token;
    mkdirSync(this.opts.storageDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600);
  }

  /** The token stored for a TV, if it has been paired. */
  token(host: string): string | undefined { return this.tokens[host]; }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.loadTokens();
    await Promise.all(this.opts.tvs.map(async cfg => {
      const id = cfg.id ?? `samsungtv_${cfg.host.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
      const tv: Tv = { cfg, id, on: false, online: false, vol: null, mac: cfg.mac };
      this.tvs.set(cfg.host, tv);
      const info = await this.info(tv).catch(() => null);
      ctx.announce([{
        id, name: cfg.name ?? info?.name ?? 'Samsung TV', room: cfg.room, type: 'tv',
        integration: `Samsung ${info?.model ?? 'TV'}`, address: cfg.host, capabilities: ['onoff', 'volume', 'input'],
      }]);
      await this.refresh(tv, info);
      // Ask for permission while the TV is on, so the Allow prompt appears now rather than on the first command.
      if (tv.on && !this.tokens[cfg.host]) void this.connect(tv).catch(err => ctx.log(`${cfg.host}: ${(err as Error).message}`));
    }));
    const every = this.opts.pollMs ?? 10_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    for (const tv of this.tvs.values()) tv.ws?.close();
  }

  async poll(): Promise<void> {
    await Promise.all([...this.tvs.values()].map(tv => this.refresh(tv)));
  }

  private async info(tv: Tv): Promise<TvInfo> {
    const res = await fetch(`http://${tv.cfg.host}:${this.ports.info}/api/v2/`, { signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const i = parseInfo(await res.json() as Parameters<typeof parseInfo>[0]);
    if (!tv.mac && i.mac) tv.mac = i.mac;
    return i;
  }

  /** Read power (and volume, when on) and report it. */
  private async refresh(tv: Tv, known?: TvInfo | null): Promise<void> {
    let info: TvInfo | null = known ?? null;
    if (!info) { try { info = await this.info(tv); } catch { info = null; } }
    if (!info) {
      tv.on = false; tv.online = false;
      tv.ws?.close();
      this.ctx?.report(tv.id, { on: false, online: false });
      return;
    }
    tv.on = info.on; tv.online = true;
    const st: DeviceState = { on: info.on, online: true };
    if (info.on) {
      const v = await this.getVolume(tv).catch(() => null);
      if (v != null) { tv.vol = v; st.vol = v; }
    } else tv.ws?.close();
    this.ctx?.report(tv.id, st);
  }

  // ------------------------------------------------------------ remote --

  /** An open, authorised remote-control connection. Pairs (and saves the token) on first use. */
  private connect(tv: Tv): Promise<WsClient> {
    if (tv.ws && !tv.ws.closed) return Promise.resolve(tv.ws);
    if (tv.connecting) return tv.connecting;
    const host = tv.cfg.host;
    const url = remoteUrl(host, this.ports.remote, this.opts.clientName ?? 'Kova', this.tokens[host], this.opts.secure ?? true);
    const p = new Promise<WsClient>((resolve, reject) => {
      let sock: WsClient | undefined;
      const fail = (err: Error) => { clearTimeout(timer); this.pairing.delete(host); sock?.close(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`${tv.cfg.name ?? host} didn't allow Kova in time: accept the prompt on the TV`)), this.opts.pairTimeoutMs ?? 30_000);
      if (!this.tokens[host]) this.pairing.add(host);
      WsClient.connect(url, {
        insecure: true, timeoutMs: this.timeout,
        onMessage: (msg, ws) => {
          sock = ws;
          let m: { event?: string; data?: { token?: string } };
          try { m = JSON.parse(msg); } catch { return; }
          if (m.event === 'ms.channel.connect') {
            clearTimeout(timer);
            this.pairing.delete(host);
            this.refused.delete(host);
            if (m.data?.token) this.saveToken(host, String(m.data.token));
            tv.ws = ws;
            ws.on('close', () => { if (tv.ws === ws) tv.ws = undefined; });
            resolve(ws);
          } else if (m.event === 'ms.channel.unauthorized' || m.event === 'ms.channel.timeOut') {
            this.refused.add(host);
            fail(new Error(`${tv.cfg.name ?? host} refused the connection: allow Kova under the TV's Device connection manager`));
          }
        },
      }).then(ws => {
        sock = ws;
        ws.on('close', () => fail(new Error(`${host} closed the remote connection`)));
      }, err => fail(err as Error));
    });
    tv.connecting = p;
    const clear = () => { if (tv.connecting === p) tv.connecting = undefined; };
    p.then(clear, clear);
    return p;
  }

  private async key(tv: Tv, key: string, times = 1): Promise<void> {
    const ws = await this.connect(tv);
    for (let i = 0; i < times; i++) {
      if (i && this.opts.keyDelayMs !== 0) await new Promise(r => setTimeout(r, this.opts.keyDelayMs ?? 150));
      ws.send(keyMessage(key));
    }
  }

  private wake(tv: Tv): Promise<void> {
    if (!tv.mac) throw new Error(`${tv.cfg.name ?? tv.cfg.host} is off and has no MAC address for Wake-on-LAN: add "mac" to its config`);
    const pkt = magicPacket(tv.mac);
    const address = this.opts.wol?.address ?? '255.255.255.255', port = this.opts.wol?.port ?? 9;
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      s.once('error', err => { s.close(); reject(err); });
      s.bind(() => {
        s.setBroadcast(true);
        s.send(pkt, port, address, err => { s.close(); err ? reject(err) : resolve(); });
      });
    });
  }

  // ------------------------------------------------------------ DLNA --

  private async dlnaUrl(tv: Tv): Promise<string | null> {
    if (tv.dlna !== undefined) return tv.dlna;
    const base = `http://${tv.cfg.host}:${this.ports.dlna}`;
    try {
      const res = await fetch(`${base}/dmr`, { signal: AbortSignal.timeout(this.timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const path = renderingControlUrl(await res.text()) ?? '/upnp/control/RenderingControl1';
      tv.dlna = new URL(path, base).toString();
    } catch {
      tv.dlna = null;
    }
    return tv.dlna;
  }

  private async soap(url: string, action: string, args: Record<string, string | number>): Promise<string> {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${RC}">${
      Object.entries(args).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(url, {
      method: 'POST', body, signal: AbortSignal.timeout(this.timeout),
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${RC}#${action}"` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DLNA ${action} failed (HTTP ${res.status})`);
    return text;
  }

  private async getVolume(tv: Tv): Promise<number | null> {
    const url = await this.dlnaUrl(tv);
    if (!url) return null;
    const v = Number(tag(await this.soap(url, 'GetVolume', { InstanceID: 0, Channel: 'Master' }), 'CurrentVolume'));
    return Number.isFinite(v) ? v : null;
  }

  private async setVolume(tv: Tv, vol: number): Promise<void> {
    const to = Math.max(0, Math.min(100, Math.round(vol)));
    const url = await this.dlnaUrl(tv);
    if (url) {
      try { await this.soap(url, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: to }); tv.vol = to; return; }
      catch (err) { this.ctx?.log(`${tv.cfg.host}: DLNA volume failed (${(err as Error).message}), using volume keys`); }
    }
    if (tv.vol == null) throw new Error(`${tv.cfg.name ?? tv.cfg.host}: current volume unknown, can't step to ${to}`);
    const { key, n } = volumeSteps(tv.vol, to);
    if (n) await this.key(tv, key, Math.min(n, 100));
    tv.vol = to;
  }

  // ------------------------------------------------------------ commands --

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    const tv = this.tvs.get(d.address);
    if (!tv) throw new Error(`Unknown Samsung TV ${d.id}`);
    if (cmd.on === false) {
      if (tv.on) { await this.key(tv, 'KEY_POWER'); tv.on = false; }
      return;
    }
    if (cmd.on === true && !tv.on) {
      // Fully-off and standby TVs both wake on the magic packet. It takes a few seconds to boot,
      // so a volume in the same command is left for the TV's own remembered level.
      await this.wake(tv);
      tv.wakingUntil = Date.now() + (this.opts.wakeWaitMs ?? 30_000);
      if (!cmd.input) return;
    } else if (cmd.vol != null) await this.setVolume(tv, cmd.vol);
    if (cmd.input) {
      // The remote API has no way to read the current source, so the input is not
      // kept as state: the next request for the same input still presses the key.
      // Asked for right after "on" (Helix sends them back to back): wait for the TV to answer.
      while (!tv.on && (tv.wakingUntil ?? 0) > Date.now()) {
        await new Promise(r => setTimeout(r, this.opts.wakeCheckMs ?? 1000));
        await this.refresh(tv);
      }
      if (!tv.on) throw new Error(`${tv.cfg.name ?? tv.cfg.host} is off: switch it on before changing input`);
      tv.wakingUntil = 0;
      await this.key(tv, inputKey(cmd.input));
      return { input: null };
    }
    // media: not supported yet (would need app launch by id); ignored.
  }

  status(): AdapterStatus {
    const n = this.tvs.size;
    if (this.pairing.size) return { ok: false, note: `Press Allow on the TV to let Kova control it` };
    if (this.refused.size) return { ok: false, note: `TV refused Kova: allow it in the TV's Device connection manager` };
    return { ok: n > 0, note: `${n} TV${n === 1 ? '' : 's'}` };
  }
}
