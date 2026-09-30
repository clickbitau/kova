import dgram from 'node:dgram';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';

// Sonos speakers over their local UPnP/SOAP API on port 1400. No cloud, no account.

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const PATHS: Record<string, string> = { [AVT]: '/MediaRenderer/AVTransport/Control', [RC]: '/MediaRenderer/RenderingControl/Control' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1];

interface Speaker { id: string; host: string; name: string; room: string; media: string | null }

export interface SonosOptions {
  /** Speaker IPs to use instead of (or as well as) SSDP discovery; needed when speakers are on another VLAN. */
  hosts?: string[];
  port?: number;
  pollMs?: number;
  discover?: boolean;
  /** Maps a Sonos room name to a Kova room id. Defaults to a lower-cased, underscored name. */
  roomFor?: (sonosRoom: string) => string;
}

export class SonosAdapter implements Adapter {
  id = 'sonos';
  name = 'Sonos';
  icon = 'speaker';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private speakers = new Map<string, Speaker>();
  private poller: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private opts: Required<Omit<SonosOptions, 'roomFor'>> & Pick<SonosOptions, 'roomFor'>;

  constructor(opts: SonosOptions = {}) {
    const envHosts = process.env.KOVA_SONOS_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    this.opts = { hosts: opts.hosts ?? envHosts, port: opts.port ?? 1400, pollMs: opts.pollMs ?? 5000, discover: opts.discover ?? true, roomFor: opts.roomFor };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const hosts = new Set(this.opts.hosts);
    if (this.opts.discover) for (const h of await ssdp()) hosts.add(h);
    await Promise.all([...hosts].map(h => this.add(h)));
    if (this.opts.pollMs > 0) this.poller = setInterval(() => void this.poll(), this.opts.pollMs);
    await this.poll();
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); }

  private base(host: string) { return host.includes(':') ? `http://${host}` : `http://${host}:${this.opts.port}`; }

  private async add(host: string): Promise<void> {
    try {
      const res = await fetch(`${this.base(host)}/xml/device_description.xml`, { signal: AbortSignal.timeout(4000) });
      const xml = await res.text();
      const udn = tag(xml, 'UDN')?.replace(/^uuid:/, '') ?? host;
      const room = tag(xml, 'roomName') ?? tag(xml, 'friendlyName') ?? host;
      const model = tag(xml, 'displayName') ?? tag(xml, 'modelName') ?? 'Speaker';
      const id = `sonos_${udn.replace(/^RINCON_/, '').toLowerCase()}`;
      this.speakers.set(id, { id, host, name: room, room, media: null });
      const kovaRoom = this.opts.roomFor?.(room) ?? room.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      this.ctx!.announce([{ id, name: `${model}`, room: kovaRoom, type: 'media', integration: 'Sonos', address: host, capabilities: ['onoff', 'media', 'volume'] }]);
    } catch (err) {
      this.lastError = `Couldn’t reach ${host}`;
      this.ctx?.log(`add ${host} failed`, err);
    }
  }

  private async soap(host: string, service: string, action: string, args: Record<string, string | number>): Promise<string> {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${
      Object.entries(args).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(`${this.base(host)}${PATHS[service]}`, {
      method: 'POST', body, signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sonos ${action} failed (${res.status}${tag(text, 'errorCode') ? ` code ${tag(text, 'errorCode')}` : ''})`);
    return text;
  }

  /** Stream URLs need Sonos's radio scheme to play as live streams. */
  private static uri(url: string): string {
    return url.startsWith('http://') ? `x-rincon-mp3radio://${url.slice(7)}` : url;
  }

  async command(d: Device, cmd: Command): Promise<void> {
    const s = this.speakers.get(d.id);
    if (!s) throw new Error(`Unknown Sonos speaker ${d.id}`);
    if (cmd.vol != null) await this.soap(s.host, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(cmd.vol) });
    if (cmd.media) {
      const url = this.ctx!.sourceUrl(cmd.media);
      if (!url) throw new Error(`No stream URL set for “${cmd.media}”`);
      // A grouped speaker can't take its own source; make it stand alone first.
      await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
      await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: SonosAdapter.uri(url), CurrentURIMetaData: '' });
      await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
      s.media = cmd.media;
    } else if (cmd.on === true) {
      await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    }
    if (cmd.on === false || cmd.media === null) {
      await this.soap(s.host, AVT, 'Pause', { InstanceID: 0 }).catch(() => this.soap(s.host, AVT, 'Stop', { InstanceID: 0 }));
      s.media = null;
    }
  }

  private async poll(): Promise<void> {
    let failed = 0;
    await Promise.all([...this.speakers.values()].map(async s => {
      try {
        const [ti, vo] = await Promise.all([
          this.soap(s.host, AVT, 'GetTransportInfo', { InstanceID: 0 }),
          this.soap(s.host, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
        ]);
        const playing = /PLAYING|TRANSITIONING/.test(tag(ti, 'CurrentTransportState') ?? '');
        this.ctx!.report(s.id, { online: true, on: playing, media: playing ? s.media ?? 'Sonos' : null, vol: Number(tag(vo, 'CurrentVolume') ?? 0) });
      } catch {
        failed++;
        this.ctx!.report(s.id, { online: false });
      }
    }));
    this.lastError = failed ? `${failed} speaker${failed === 1 ? '' : 's'} not responding` : null;
  }

  status(): AdapterStatus {
    const n = this.speakers.size;
    return this.lastError ? { ok: false, note: this.lastError } : { ok: n > 0, note: n ? `${n} speaker${n === 1 ? '' : 's'}` : 'No speakers found yet' };
  }
}

/** SSDP search for Sonos ZonePlayers on the local network. Returns host IPs. */
function ssdp(timeoutMs = 2500): Promise<string[]> {
  return new Promise(resolve => {
    const found = new Set<string>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
    sock.on('message', (buf, rinfo) => { if (/Sonos/i.test(buf.toString())) found.add(rinfo.address); });
    sock.on('error', () => { try { sock.close(); } catch { /* closed */ } resolve([...found]); });
    sock.bind(() => {
      sock.send(msg, 1900, '239.255.255.250');
      setTimeout(() => sock.send(msg, 1900, '239.255.255.250'), 500);
    });
    setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found]); }, timeoutMs);
  });
}
