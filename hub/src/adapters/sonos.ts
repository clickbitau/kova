import dgram from 'node:dgram';
import type { Adapter, AdapterContext, AdapterStatus, Queue, QueueTrack } from './sdk.ts';
import type { Command, Device, DeviceState, Track } from '../model/types.ts';

// Sonos speakers over their local UPnP/SOAP API on port 1400. No cloud, no account.

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const PATHS: Record<string, string> = { [AVT]: '/MediaRenderer/AVTransport/Control', [RC]: '/MediaRenderer/RenderingControl/Control' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1];

interface Speaker {
  id: string; host: string; name: string; room: string; media: string | null; udn: string;
  /** A play queue (Helix music): the songs in order, which one plays, and which of them the speaker's queue holds (from..to). */
  queue: { q: Queue; index: number; from: number; to: number } | null;
}

/** How many songs the speaker's own queue holds ahead; more are added as it plays. */
export const SONOS_WINDOW = 50;

/** DIDL-Lite for a queued song, so the Sonos app and Kova show its title, artist and cover. */
export function didl(t: QueueTrack): string {
  const e = (x: string) => esc(x);
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + `<item id="-1" parentID="-1" restricted="true"><res protocolInfo="http-get:*:${e(t.contentType)}:*">${e(t.url)}</res>`
    + `<dc:title>${e(t.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>`
    + (t.artist ? `<dc:creator>${e(t.artist)}</dc:creator>` : '') + (t.album ? `<upnp:album>${e(t.album)}</upnp:album>` : '')
    + (t.art ? `<upnp:albumArtURI>${e(t.art)}</upnp:albumArtURI>` : '') + '</item></DIDL-Lite>';
}

const shown = (t: QueueTrack): Track => ({ id: t.id, title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}), ...(t.art ? { art: t.art } : {}), ...(t.durationMs ? { durationMs: t.durationMs } : {}) });
const hms = (secs: number) => [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, Math.floor(secs % 60)].map((n, i) => i ? String(n).padStart(2, '0') : String(n)).join(':');
const secsOf = (t?: string) => (t ?? '0:00:00').split(':').map(Number).reduce((a, n) => a * 60 + (n || 0), 0);

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
      this.speakers.set(id, { id, host, name: room, room, media: null, udn, queue: null });
      const kovaRoom = this.opts.roomFor?.(room) ?? room.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      this.ctx!.announce([{ id, name: `${model}`, room: kovaRoom, type: 'media', integration: 'Sonos', address: host, capabilities: ['onoff', 'media', 'volume', 'queue'] }]);
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

  /** Play a queue from `start` (at `position` seconds into that song): the speaker's own queue gets the next SONOS_WINDOW songs. */
  private async playQueue(s: Speaker, q: Queue, start = 0, position = 0): Promise<void> {
    await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
    await this.soap(s.host, AVT, 'RemoveAllTracksFromQueue', { InstanceID: 0 });
    const to = Math.min(q.tracks.length, start + SONOS_WINDOW);
    await q.prepare?.(start, to);
    await this.enqueue(s, q.tracks.slice(start, to));
    await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon-queue:${s.udn}#0`, CurrentURIMetaData: '' });
    await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: 1 });
    if (position > 0) await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(position) }).catch(() => {});
    await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    s.media = q.label;
    s.queue = { q, index: start, from: start, to };
  }

  private async enqueue(s: Speaker, tracks: QueueTrack[]): Promise<void> {
    for (const t of tracks) {
      await this.soap(s.host, AVT, 'AddURIToQueue', { InstanceID: 0, EnqueuedURI: t.url, EnqueuedURIMetaData: didl(t), DesiredFirstTrackNumberEnqueued: 0, EnqueueAsNext: 0 });
    }
  }

  async command(d: Device, cmd: Command): Promise<void | DeviceState> {
    const s = this.speakers.get(d.id);
    if (!s) throw new Error(`Unknown Sonos speaker ${d.id}`);
    if (cmd.vol != null) await this.soap(s.host, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(cmd.vol) });
    if (cmd.media) {
      const url = this.ctx!.sourceUrl(cmd.media);
      if (url) {
        // A grouped speaker can't take its own source; make it stand alone first.
        await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
        await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: SonosAdapter.uri(url), CurrentURIMetaData: '' });
        await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
        s.media = cmd.media;
        s.queue = null;
      } else {
        // Not a radio source: maybe music (Helix), which plays as a queue of songs.
        const q = await this.ctx!.queueFor(cmd.media, { shuffle: !!cmd.shuffle });
        if (!q) throw new Error(`No stream URL set for “${cmd.media}”`);
        await this.playQueue(s, q);
      }
    } else if (cmd.shuffle !== undefined && s.queue && cmd.shuffle !== s.queue.q.shuffle) {
      // The same music in a new order (or back in order), carrying on with this song where it is.
      const q = await this.ctx!.queueFor(s.queue.q.label, { shuffle: cmd.shuffle });
      if (q) {
        const cur = s.queue.q.tracks[s.queue.index];
        const pos = secsOf(tag(await this.soap(s.host, AVT, 'GetPositionInfo', { InstanceID: 0 }), 'RelTime'));
        const tracks = q.shuffle ? [cur, ...q.tracks.filter(t => t.id !== cur.id)] : q.tracks;
        await this.playQueue(s, { ...q, tracks }, q.shuffle ? 0 : Math.max(0, q.tracks.findIndex(t => t.id === cur.id)), pos);
      }
    } else if (cmd.on === true) {
      await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    }
    if (cmd.skip) await this.skip(s, cmd.skip > 0 ? 1 : -1);
    if (cmd.on === false || cmd.media === null) {
      await this.soap(s.host, AVT, 'Pause', { InstanceID: 0 }).catch(() => this.soap(s.host, AVT, 'Stop', { InstanceID: 0 }));
      s.media = null;
      s.queue = null;
    }
    // What the speaker now plays: whether it's shuffled, and the song.
    if (s.queue) return { shuffle: s.queue.q.shuffle, track: shown(s.queue.q.tracks[s.queue.index]) };
  }

  private async skip(s: Speaker, delta: number): Promise<void> {
    const qu = s.queue;
    if (!qu) throw new Error(`${s.name} isn’t playing a queue`);
    const next = qu.index + delta;
    if (next >= qu.q.tracks.length) throw new Error(`That was the last song in ${qu.q.label}`);
    if (next < qu.from) { await this.playQueue(s, qu.q, Math.max(0, next)); return; }
    if (next >= qu.to) { await this.playQueue(s, qu.q, next); return; }
    await this.soap(s.host, AVT, delta > 0 ? 'Next' : 'Previous', { InstanceID: 0 });
    qu.index = next;
  }

  /** Where the speaker's queue is, and more songs before it runs out. */
  private async followQueue(s: Speaker): Promise<void> {
    const qu = s.queue;
    if (!qu) return;
    const n = Number(tag(await this.soap(s.host, AVT, 'GetPositionInfo', { InstanceID: 0 }), 'Track') ?? 0);
    if (n >= 1 && qu.from + n - 1 < qu.q.tracks.length) qu.index = qu.from + n - 1;
    if (qu.to < qu.q.tracks.length && qu.index >= qu.to - 5) {
      const to = Math.min(qu.q.tracks.length, qu.to + SONOS_WINDOW);
      await qu.q.prepare?.(qu.to, to);
      await this.enqueue(s, qu.q.tracks.slice(qu.to, to));
      qu.to = to;
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
        const state = tag(ti, 'CurrentTransportState') ?? '';
        const playing = /PLAYING|TRANSITIONING/.test(state);
        // The queue ran out, or someone played something else from the Sonos app.
        if (!playing && /STOPPED/.test(state)) s.queue = null;
        if (s.queue) await this.followQueue(s).catch(() => {});
        const qu = s.queue;
        this.ctx!.report(s.id, {
          online: true, on: playing, media: playing ? s.media ?? 'Sonos' : null, vol: Number(tag(vo, 'CurrentVolume') ?? 0),
          track: playing && qu ? shown(qu.q.tracks[qu.index]) : null, shuffle: playing && qu ? qu.q.shuffle : false,
        });
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
