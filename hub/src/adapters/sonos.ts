import dgram from 'node:dgram';
import type { Adapter, AdapterContext, AdapterStatus, AudioFormat, Clip, NativeGroup, PlaybackPosition, Queue, QueueTrack } from './sdk.ts';
import { mmss } from '../devices/registry.ts';
import type { Command, Device, DeviceState, Track } from '../model/types.ts';

// Sonos speakers over their local UPnP/SOAP API on port 1400. No cloud, no account.
// Speakers told to play the same thing at once are grouped on the fly (Sonos can group any of its speakers): the
// first plays, the others join it (x-rincon:), and Sonos keeps them sample-locked.

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const PATHS: Record<string, string> = { [AVT]: '/MediaRenderer/AVTransport/Control', [RC]: '/MediaRenderer/RenderingControl/Control' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1];

interface Speaker {
  id: string; host: string; name: string; room: string; media: string | null; udn: string;
  /** The Sonos software generation its description says (swGen): 2 is S2, which plays 24-bit FLAC; 1 (S1) only 16-bit. */
  swGen?: number;
  /** A play queue (Helix music): the songs in order, which one plays, and which of them the speaker's queue holds (from..to). */
  queue: { q: Queue; index: number; from: number; to: number } | null;
  /** Paused (on hold, keeping its place), as the speaker last said. */
  paused?: boolean;
}

/**
 * The songs' format for a Sonos speaker. S2 plays FLAC up to 24-bit / 48 kHz, which is what Helix sends for "flac" at
 * maxRate 48000 (the file as it is, no transcoding). S1, or a speaker that doesn't say, gets AAC: it plays only 16-bit
 * FLAC, and Helix may hand over a 24-bit file.
 */
export const sonosFormat = (s: { swGen?: number }): AudioFormat => (s.swGen ?? 0) >= 2 ? 'flac' : 'aac';

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
  /** Window in which plays are collected so speakers asked together are grouped (ms; 0: never grouped). */
  batchMs?: number;
}

interface PendingPlay { s: Speaker; cmd: Command; resolve: (v: void | DeviceState) => void; reject: (e: unknown) => void }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  /** Speakers following another (grouped by Kova to play with it) → the one they follow. */
  private follows = new Map<string, string>();
  private batch: PendingPlay[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(opts: SonosOptions = {}) {
    const envHosts = process.env.KOVA_SONOS_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    this.opts = { hosts: opts.hosts ?? envHosts, port: opts.port ?? 1400, pollMs: opts.pollMs ?? 5000, discover: opts.discover ?? true, roomFor: opts.roomFor, batchMs: opts.batchMs ?? 40 };
  }

  /** Any two or more Sonos speakers can play as one group. */
  nativeGroups(): NativeGroup[] {
    return this.speakers.size >= 2 ? [{ via: 'sonos', id: 'group', name: 'Sonos', members: [...this.speakers.keys()], dynamic: true }] : [];
  }

  /** The speaker whose transport plays for this one: the one it follows, or itself. */
  private lead(s: Speaker): Speaker { const c = this.follows.get(s.id); return (c && this.speakers.get(c)) || s; }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const hosts = new Set(this.opts.hosts);
    if (this.opts.discover) for (const h of await ssdp()) hosts.add(h);
    await Promise.all([...hosts].map(h => this.add(h)));
    if (this.opts.pollMs > 0) this.poller = setInterval(() => void this.poll(), this.opts.pollMs);
    await this.poll();
  }

  async stop(): Promise<void> { if (this.poller) clearInterval(this.poller); if (this.batchTimer) clearTimeout(this.batchTimer); }

  private base(host: string) { return host.includes(':') ? `http://${host}` : `http://${host}:${this.opts.port}`; }

  private async add(host: string): Promise<void> {
    try {
      const res = await fetch(`${this.base(host)}/xml/device_description.xml`, { signal: AbortSignal.timeout(4000) });
      const xml = await res.text();
      const udn = tag(xml, 'UDN')?.replace(/^uuid:/, '') ?? host;
      const room = tag(xml, 'roomName') ?? tag(xml, 'friendlyName') ?? host;
      const model = tag(xml, 'displayName') ?? tag(xml, 'modelName') ?? 'Speaker';
      const id = `sonos_${udn.replace(/^RINCON_/, '').toLowerCase()}`;
      const swGen = Number(tag(xml, 'swGen'));
      this.speakers.set(id, { id, host, name: room, room, media: null, udn, queue: null, ...(Number.isFinite(swGen) && swGen > 0 ? { swGen } : {}) });
      const kovaRoom = this.opts.roomFor?.(room) ?? room.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      this.ctx!.announce([{ id, name: `${model}`, room: kovaRoom, type: 'media', integration: 'Sonos', address: host, capabilities: ['onoff', 'media', 'volume', 'queue', 'pause'] }]);
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
    if (typeof cmd.media === 'string' && cmd.media && this.opts.batchMs > 0) {
      return new Promise((resolve, reject) => {
        this.batch.push({ s, cmd, resolve, reject });
        this.batchTimer ??= setTimeout(() => void this.flush(), this.opts.batchMs);
      });
    }
    return this.run(s, cmd);
  }

  /** Plays asked for together: one speaker plays, the others with the same thing join it as a Sonos group. */
  private async flush(): Promise<void> {
    this.batchTimer = null;
    const plays = new Map<string, PendingPlay[]>();
    for (const p of this.batch.splice(0)) { const k = `${p.cmd.media}\0${p.cmd.shuffle ? 1 : 0}`; plays.set(k, [...(plays.get(k) ?? []), p]); }
    await Promise.all([...plays.values()].map(async ([first, ...rest]) => {
      try { first!.resolve(await this.run(first!.s, first!.cmd)); } catch (e) { first!.reject(e); for (const p of rest) p.reject(e); return; }
      await Promise.all(rest.map(async p => { try { p.resolve(await this.join(p.s, first!.s, p.cmd)); } catch (e) { p.reject(e); } }));
    }));
  }

  /** A speaker joins another's group, playing what it plays in sync. */
  private async join(s: Speaker, lead: Speaker, cmd: Command): Promise<DeviceState> {
    if (cmd.vol != null) await this.soap(s.host, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(cmd.vol) });
    await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon:${lead.udn}`, CurrentURIMetaData: '' });
    this.follows.set(s.id, lead.id);
    s.media = lead.media; s.queue = null; s.paused = false;
    const qu = lead.queue;
    return qu ? { shuffle: qu.q.shuffle, track: shown(qu.q.tracks[qu.index]!), paused: false } : { paused: false };
  }

  private async run(s0: Speaker, cmd: Command): Promise<void | DeviceState> {
    const s = s0;
    // Playing, skipping, pausing: on the transport of the speaker it follows, if it's in a group Kova made.
    const t = cmd.media ? s : this.lead(s);
    if (cmd.vol != null) await this.soap(s.host, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(cmd.vol) });
    if (cmd.media) {
      this.follows.delete(s.id);
      const url = this.ctx!.sourceUrl(cmd.media);
      if (url) {
        // A grouped speaker can't take its own source; make it stand alone first.
        await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
        await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: SonosAdapter.uri(url), CurrentURIMetaData: '' });
        // A recording set to loop plays again from the start each time it ends.
        await this.soap(s.host, AVT, 'SetPlayMode', { InstanceID: 0, NewPlayMode: this.ctx!.sourceLoops?.(cmd.media) ? 'REPEAT_ONE' : 'NORMAL' }).catch(() => {});
        await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
        s.media = cmd.media;
        s.queue = null;
      } else {
        // Not a radio source: maybe music (Helix), which plays as a queue of songs.
        const q = await this.ctx!.queueFor(cmd.media, { shuffle: !!cmd.shuffle, format: sonosFormat(s) });
        if (!q) throw new Error(`No stream URL set for “${cmd.media}”`);
        await this.playQueue(s, q);
      }
    } else if (cmd.shuffle !== undefined && t.queue && cmd.shuffle !== t.queue.q.shuffle) {
      // The same music in a new order (or back in order), carrying on with this song where it is.
      const q = await this.ctx!.queueFor(t.queue.q.label, { shuffle: cmd.shuffle, format: sonosFormat(t) });
      if (q) {
        const cur = t.queue.q.tracks[t.queue.index];
        const pos = secsOf(tag(await this.soap(t.host, AVT, 'GetPositionInfo', { InstanceID: 0 }), 'RelTime'));
        const tracks = q.shuffle ? [cur, ...q.tracks.filter(x => x.id !== cur.id)] : q.tracks;
        await this.playQueue(t, { ...q, tracks }, q.shuffle ? 0 : Math.max(0, q.tracks.findIndex(x => x.id === cur.id)), pos);
      }
    } else if (cmd.on === true) {
      await this.soap(t.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    }
    if (cmd.skip) await this.skip(t, cmd.skip > 0 ? 1 : -1);
    // Pause keeps the place (and the queue); resume carries on from it.
    if (cmd.paused !== undefined && cmd.on !== false && cmd.media !== null) {
      await this.soap(t.host, AVT, cmd.paused ? 'Pause' : 'Play', { InstanceID: 0, ...(cmd.paused ? {} : { Speed: 1 }) });
      t.paused = cmd.paused;
      s.paused = cmd.paused;
    }
    if (cmd.on === false || cmd.media === null) {
      // A speaker following another leaves its group (the rest play on); one on its own pauses.
      if (t !== s) await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
      else await this.soap(s.host, AVT, 'Pause', { InstanceID: 0 }).catch(() => this.soap(s.host, AVT, 'Stop', { InstanceID: 0 }));
      this.follows.delete(s.id);
      s.media = null;
      s.queue = null;
      s.paused = false;
      return;
    }
    // What the speaker now plays: whether it's shuffled, and the song.
    if (t.queue) return { shuffle: t.queue.q.shuffle, track: shown(t.queue.q.tracks[t.queue.index]), paused: !!t.paused };
    if (cmd.paused !== undefined) return { paused: !!s.paused };
  }

  /** One read of where the speaker's transport is: the track (1-based), seconds into it, its length, and when. */
  private async readPos(s: Speaker): Promise<{ track: number; rel: number; dur: number; at: number }> {
    const t0 = Date.now();
    const x = await this.soap(s.host, AVT, 'GetPositionInfo', { InstanceID: 0 });
    return { track: Number(tag(x, 'Track') ?? 0), rel: secsOf(tag(x, 'RelTime')), dur: secsOf(tag(x, 'TrackDuration')), at: Math.round((t0 + Date.now()) / 2) };
  }

  /**
   * Where the queue is. Sonos says whole seconds only, so while it plays Kova reads again every 60 ms or so until
   * the second ticks over: at that moment the place is exactly that second (to within half the gap between reads).
   */
  async playbackPosition(device: Device): Promise<PlaybackPosition | null> {
    const s0 = this.speakers.get(device.id);
    if (!s0) return null;
    const s = this.lead(s0), qu = s.queue;
    if (!qu) return null;
    const state = tag(await this.soap(s.host, AVT, 'GetTransportInfo', { InstanceID: 0 }), 'CurrentTransportState') ?? '';
    const playing = /PLAYING/.test(state);
    const out = (r: { track: number; dur: number }, positionMs: number, at: number): PlaybackPosition => {
      const index = r.track >= 1 ? qu.from + r.track - 1 : qu.index;
      const durationMs = r.dur ? r.dur * 1000 : qu.q.tracks[index]?.durationMs;
      return { index, positionMs, at, playing, ...(durationMs ? { durationMs } : {}), seekStepMs: 1000 };
    };
    let a = await this.readPos(s);
    if (!playing) return out(a, a.rel * 1000, a.at);
    const until = Date.now() + 1300;
    while (Date.now() < until) {
      await sleep(60);
      const b = await this.readPos(s);
      if (b.track === a.track && b.rel === a.rel + 1) return out(b, b.rel * 1000, Math.round((a.at + b.at) / 2));
      if (b.track !== a.track || b.rel !== a.rel) return out(b, b.rel * 1000 + 500, b.at);
      a = b;
    }
    return out(a, a.rel * 1000 + 500, a.at);
  }

  /** To a song in the queue, whole seconds into it (Sonos seeks no finer): within what the speaker holds, else a reload. */
  async syncTo(device: Device, to: { index: number; positionMs: number }): Promise<void> {
    const s0 = this.speakers.get(device.id);
    if (!s0) throw new Error(`Unknown Sonos speaker ${device.id}`);
    const s = this.lead(s0), qu = s.queue;
    if (!qu) throw new Error(`${s.name} isn’t playing a queue`);
    const secs = Math.max(0, Math.round(to.positionMs / 1000));
    if (to.index < qu.from || to.index >= qu.to) { await this.playQueue(s, qu.q, to.index, secs); return; }
    if (to.index !== qu.index) await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: to.index - qu.from + 1 });
    if (secs > 0 || to.index === qu.index) await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(secs) });
    await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    qu.index = to.index;
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
        // Paused counts as on (it keeps its place), as with every player that can pause.
        s.paused = /PAUSED/.test(state) && !!(s.queue || s.media);
        const playing = /PLAYING|TRANSITIONING/.test(state) || s.paused;
        // The queue ran out, or someone played something else from the Sonos app.
        if (!playing && /STOPPED/.test(state)) s.queue = null;
        if (s.queue) await this.followQueue(s).catch(() => {});
        // A speaker following another (a group Kova made) plays its song.
        const lead = this.lead(s), qu = s.queue ?? (lead !== s ? lead.queue : null);
        if (lead !== s && playing) s.media = lead.media;
        this.ctx!.report(s.id, {
          online: true, on: playing, paused: s.paused, media: playing ? s.media ?? 'Sonos' : null, vol: Number(tag(vo, 'CurrentVolume') ?? 0),
          track: playing && qu ? shown(qu.q.tracks[qu.index]) : null, shuffle: playing && qu ? qu.q.shuffle : false,
        });
      } catch {
        failed++;
        this.ctx!.report(s.id, { online: false });
      }
    }));
    this.lastError = failed ? `${failed} speaker${failed === 1 ? '' : 's'} not responding` : null;
  }

  // ---------------------------------------------------------- announcements --

  /**
   * What a speaker is on, to put back after an announcement: its transport's URI and metadata (its own queue, a radio
   * station, the Sonos group it follows), the track and the place in it, its play mode and whether it was playing.
   * Asked of the speaker, so it covers what the Sonos app started too.
   */
  async snapshotPlayback(device: Device): Promise<unknown | null> {
    const s = this.speakers.get(device.id);
    if (!s) return null;
    const [mi, pi, ti, ts] = await Promise.all([
      this.soap(s.host, AVT, 'GetMediaInfo', { InstanceID: 0 }),
      this.soap(s.host, AVT, 'GetPositionInfo', { InstanceID: 0 }),
      this.soap(s.host, AVT, 'GetTransportInfo', { InstanceID: 0 }),
      this.soap(s.host, AVT, 'GetTransportSettings', { InstanceID: 0 }).catch(() => ''),
    ]);
    const uri = unesc(tag(mi, 'CurrentURI') ?? '');
    if (!uri) return null;
    return {
      uri, meta: unesc(tag(mi, 'CurrentURIMetaData') ?? ''), state: tag(ti, 'CurrentTransportState') ?? 'STOPPED',
      track: Number(tag(pi, 'Track') ?? 0), rel: tag(pi, 'RelTime') ?? '', playMode: tag(ts, 'PlayMode') ?? 'NORMAL',
      queue: s.queue, media: s.media,
    };
  }

  /** An announcement on this speaker alone (out of its Sonos group for now), played once as a file, not as radio. */
  async playClip(device: Device, clip: Clip): Promise<DeviceState> {
    const s = this.speakers.get(device.id);
    if (!s) throw new Error(`Unknown Sonos speaker ${device.id}`);
    await this.soap(s.host, AVT, 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 }).catch(() => {});
    this.follows.delete(s.id);
    const meta = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
      + `<item id="-1" parentID="-1" restricted="true"><res protocolInfo="http-get:*:${esc(clip.contentType)}:*">${esc(clip.url)}</res><dc:title>${esc(clip.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class></item></DIDL-Lite>`;
    await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: clip.url, CurrentURIMetaData: meta });
    await this.soap(s.host, AVT, 'SetPlayMode', { InstanceID: 0, NewPlayMode: 'NORMAL' }).catch(() => {});
    await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    s.media = clip.title;
    s.queue = null;
    s.paused = false;
    return { on: true, media: clip.title, paused: false, track: null, shuffle: false };
  }

  /**
   * Back on what snapshotPlayback saw: the same URI (its own queue at the same track and time; a radio station starts
   * live again; a speaker that followed a Sonos group rejoins it), its play mode, and playing or not as it was.
   */
  async restorePlayback(device: Device, snap0: unknown | null): Promise<{ words: string; state?: DeviceState }> {
    const s = this.speakers.get(device.id);
    if (!s) throw new Error(`Unknown Sonos speaker ${device.id}`);
    const snap = snap0 as null | { uri: string; meta: string; state: string; track: number; rel: string; playMode: string; queue: Speaker['queue']; media: string | null };
    if (!snap) {
      await this.soap(s.host, AVT, 'Stop', { InstanceID: 0 }).catch(() => {});
      s.media = null; s.queue = null; s.paused = false;
      return { words: 'idle again', state: { on: false, media: null, paused: false, track: null, shuffle: false } };
    }
    await this.soap(s.host, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: snap.uri, CurrentURIMetaData: snap.meta });
    const queue = snap.uri.startsWith('x-rincon-queue:'), group = snap.uri.startsWith('x-rincon:');
    const lead = group ? [...this.speakers.values()].find(x => x.udn === snap.uri.slice('x-rincon:'.length) && x !== s) : undefined;
    if (lead) this.follows.set(s.id, lead.id); else this.follows.delete(s.id);
    const live = /^(x-rincon-mp3radio|x-sonosapi-stream|x-sonosapi-radio|x-sonosapi-hls|x-rincon-stream|aac|hls-radio):/.test(snap.uri);
    if (queue && snap.track > 0) await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: snap.track }).catch(() => {});
    const at = secsOf(snap.rel);
    if (!group && !live && at > 0) await this.soap(s.host, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: snap.rel }).catch(() => {});
    if (!group) await this.soap(s.host, AVT, 'SetPlayMode', { InstanceID: 0, NewPlayMode: snap.playMode || 'NORMAL' }).catch(() => {});
    const playing = /PLAYING|TRANSITIONING/.test(snap.state), paused = /PAUSED/.test(snap.state);
    if (playing && !group) await this.soap(s.host, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    s.queue = snap.queue;
    s.media = playing || paused ? snap.media : null;
    s.paused = paused;
    const name = snap.media ?? 'what it was playing';
    const words = group ? 'back in its Sonos group'
      : !playing && !paused ? 'idle again (on what it had before)'
      : live ? `back to ${name} (live)`
      : `resumed ${name}${queue && snap.track ? ` at track ${snap.track}` : ''}${at >= 1 ? `, ${mmss(at)}` : ''}${paused ? ', paused' : ''}`;
    const qu = s.queue;
    return { words, state: { on: playing || paused || group, media: group ? 'Sonos' : s.media, paused, track: qu ? shown(qu.q.tracks[qu.index]!) : null, shuffle: qu ? qu.q.shuffle : false } };
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
