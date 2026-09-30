import mdns from 'multicast-dns';
import type { Adapter, AdapterContext, AdapterStatus } from '../sdk.ts';
import type { Command, Device } from '../../model/types.ts';
import { CastChannel, NS, type CastMessage } from './channel.ts';

// Google Cast speakers, displays and TVs (Nest Audio, Nest Hub, Chromecast…).
// Perfect multi-room sync comes from Cast groups: when several speakers are
// told to play the same thing at once, Kova plays it on the Cast group whose
// members are exactly those speakers, and the speakers keep themselves in sync.

const DEFAULT_RECEIVER = 'CC1AD845';

export interface CastEndpoint { id: string; name: string; model: string; host: string; port: number; group: boolean }

export interface CastOptions {
  /** Endpoints to use without mDNS (e.g. on another VLAN), or extra ones. */
  endpoints?: Omit<CastEndpoint, 'group'>[];
  discover?: boolean;
  discoverMs?: number;
  /** Cast device name → Kova room id. Unmatched names become a room id from the name. */
  rooms?: Record<string, string>;
  /** Cast device name → Kova device id to use. */
  ids?: Record<string, string>;
  pollMs?: number;
  /** Window in which commands are collected so simultaneous plays can use a group. */
  batchMs?: number;
  /** Plain TCP instead of TLS (tests only). */
  insecure?: boolean;
  timeoutMs?: number;
}

interface Pending { device: Device; cmd: Command; resolve: () => void; reject: (e: Error) => void }

const isGroupModel = (md: string) => /cast group/i.test(md);
const contentType = (url: string) => /\.m3u8(\?|$)/i.test(url) ? 'application/x-mpegURL' : /\.aac(\?|$)/i.test(url) ? 'audio/aac' : /\.(mp4|m4a)(\?|$)/i.test(url) ? 'audio/mp4' : 'audio/mpeg';

/** One Cast receiver: a speaker, display, TV or group. */
class Receiver {
  readonly ch: CastChannel;
  media: string | null = null;
  constructor(readonly ep: CastEndpoint, o: CastOptions) {
    this.ch = new CastChannel({ host: ep.host, port: ep.port, insecure: o.insecure, timeoutMs: o.timeoutMs });
  }

  async status() {
    await this.ch.connect();
    const m = await this.ch.request(NS.receiver, 'receiver-0', { type: 'GET_STATUS' });
    const st = m.data.status as { volume?: { level?: number; muted?: boolean }; applications?: { appId: string; sessionId: string; transportId: string; isIdleScreen?: boolean }[] } | undefined;
    return { volume: st?.volume ?? {}, app: st?.applications?.[0] };
  }

  async play(url: string, title: string): Promise<void> {
    let { app, volume } = await this.status();
    if (volume.muted) await this.volume(0, false);
    if (!app || app.appId !== DEFAULT_RECEIVER) {
      const m = await this.ch.request(NS.receiver, 'receiver-0', { type: 'LAUNCH', appId: DEFAULT_RECEIVER });
      app = (m.data.status as { applications?: typeof app[] })?.applications?.find(a => a?.appId === DEFAULT_RECEIVER);
      if (!app) throw new Error(`${this.ep.name} didn't start the media player`);
    }
    this.ch.connectTo(app.transportId);
    const r = await this.ch.request(NS.media, app.transportId, {
      type: 'LOAD', autoplay: true,
      media: { contentId: url, contentType: contentType(url), streamType: 'LIVE', metadata: { metadataType: 0, title } },
    });
    if (r.data.type === 'LOAD_FAILED' || r.data.type === 'LOAD_CANCELLED') throw new Error(`${this.ep.name} couldn't play ${title}`);
    this.media = title;
  }

  async stop(): Promise<void> {
    const { app } = await this.status();
    if (app && !app.isIdleScreen) await this.ch.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId: app.sessionId });
    this.media = null;
  }

  async volume(level: number, muted?: boolean): Promise<void> {
    await this.ch.connect();
    await this.ch.request(NS.receiver, 'receiver-0', { type: 'SET_VOLUME', volume: muted === undefined ? { level: Math.max(0, Math.min(1, level)) } : { muted } });
  }

  async members(): Promise<string[]> {
    await this.ch.connect();
    const m = await this.ch.request(NS.multizone, 'receiver-0', { type: 'GET_STATUS' });
    const devs = (m.data.status as { devices?: { deviceId: string }[] })?.devices ?? [];
    return devs.map(d => d.deviceId.replace(/-/g, '').toLowerCase());
  }
}

export class CastAdapter implements Adapter {
  id = 'cast';
  name = 'Google Cast';
  icon = 'cast';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private receivers = new Map<string, Receiver>();
  private groups = new Map<string, Set<string>>();
  /** Speaker id → group id currently playing through it. */
  private viaGroup = new Map<string, string>();
  private queue: Pending[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private browser: ReturnType<typeof mdns> | null = null;
  private failing = new Set<string>();
  /** Kova device id ↔ Cast id. */
  private kova = new Map<string, string>();
  private castOf = new Map<string, string>();

  constructor(private o: CastOptions = {}) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    for (const e of this.o.endpoints ?? []) this.add({ ...e, group: isGroupModel(e.model) });
    if (this.o.discover !== false) await this.discover(this.o.discoverMs ?? 3000);
    await this.refreshGroups();
    const every = this.o.pollMs ?? 10_000;
    if (every > 0) this.poller = setInterval(() => void this.poll(), every);
    await this.poll();
  }

  private add(ep: CastEndpoint): void {
    const existing = this.receivers.get(ep.id);
    if (existing && existing.ep.host === ep.host && existing.ep.port === ep.port) return;
    existing?.ch.close();
    this.receivers.set(ep.id, new Receiver(ep, this.o));
    if (ep.group) { this.groups.set(ep.id, new Set()); return; }
    const tv = /tv|oled|qled|s90|bravia/i.test(`${ep.name} ${ep.model}`) && !/nest|audio|hub/i.test(ep.model);
    const room = this.o.rooms?.[ep.name] ?? ep.name.toLowerCase().replace(/\s*(speaker|display)\s*/g, ' ').trim().replace(/[^a-z0-9]+/g, '_');
    const kid = this.o.ids?.[ep.name] ?? `cast_${ep.id}`;
    this.kova.set(ep.id, kid);
    this.castOf.set(kid, ep.id);
    this.ctx!.announce([{ id: kid, name: ep.name, room, type: tv ? 'tv' : 'media', integration: `Google Cast · ${ep.model}`, address: `${ep.host}:${ep.port}`, capabilities: ['onoff', 'media', 'volume'] }]);
  }

  /** mDNS browse for _googlecast._tcp. Keeps listening so new devices and IP changes are picked up. */
  private discover(ms: number): Promise<void> {
    return new Promise(resolve => {
      let m: ReturnType<typeof mdns>;
      try { m = mdns(); } catch { resolve(); return; }
      this.browser = m;
      const srv = new Map<string, { port: number; target: string }>();
      const txt = new Map<string, Record<string, string>>();
      const addr = new Map<string, string>();
      m.on('response', res => {
        for (const a of [...res.answers, ...res.additionals]) {
          if (a.type === 'SRV' && a.name.includes('_googlecast')) srv.set(a.name, { port: (a.data as { port: number }).port, target: (a.data as { target: string }).target });
          if (a.type === 'TXT' && a.name.includes('_googlecast')) {
            const kv: Record<string, string> = {};
            for (const b of a.data as Buffer[]) { const s = b.toString(); const i = s.indexOf('='); if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1); }
            txt.set(a.name, kv);
          }
          if (a.type === 'A') addr.set(a.name, a.data as string);
        }
        for (const [name, s] of srv) {
          const t = txt.get(name), host = addr.get(s.target);
          if (t?.id && host) this.add({ id: t.id.toLowerCase(), name: t.fn ?? name, model: t.md ?? 'Cast', host, port: s.port, group: isGroupModel(t.md ?? '') });
        }
      });
      m.on('error', () => resolve());
      m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
      setTimeout(resolve, ms);
    });
  }

  /** Learn which speakers are in each Cast group. */
  private async refreshGroups(): Promise<void> {
    await Promise.all([...this.groups.keys()].map(async gid => {
      try { this.groups.set(gid, new Set(await this.receivers.get(gid)!.members())); } catch { /* group offline */ }
    }));
  }

  private speakerId(d: Device) { return this.castOf.get(d.id) ?? d.id.replace(/^cast_/, ''); }
  private kovaId(castId: string) { return this.kova.get(castId) ?? `cast_${castId}`; }

  /** The group whose members are exactly these speakers. */
  groupFor(speakers: string[]): string | undefined {
    const want = new Set(speakers);
    for (const [gid, members] of this.groups) {
      if (members.size === want.size && [...want].every(s => members.has(s))) return gid;
    }
    return undefined;
  }

  command(device: Device, cmd: Command): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ device, cmd, resolve, reject });
      this.flushTimer ??= setTimeout(() => void this.flush(), this.o.batchMs ?? 60);
    });
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const batch = this.queue.splice(0);
    const run = async (p: Pending[], fn: () => Promise<void>) => {
      try { await fn(); p.forEach(x => x.resolve()); } catch (e) { p.forEach(x => x.reject(e as Error)); }
    };
    // Plays of the same source in the same instant: try to use one Cast group.
    const plays = new Map<string, Pending[]>();
    const rest: Pending[] = [];
    for (const p of batch) {
      if (p.cmd.media) plays.set(p.cmd.media, [...(plays.get(p.cmd.media) ?? []), p]);
      else rest.push(p);
    }
    const jobs: Promise<void>[] = [];
    for (const [media, ps] of plays) {
      const url = this.ctx!.sourceUrl(media);
      if (!url) { ps.forEach(p => p.reject(new Error(`No stream URL set for “${media}”`))); continue; }
      const ids = ps.map(p => this.speakerId(p.device));
      const gid = ps.length > 1 ? this.groupFor(ids) : undefined;
      if (gid) {
        jobs.push(run(ps, async () => {
          await Promise.all(ps.filter(p => p.cmd.vol != null).map(p => this.receivers.get(this.speakerId(p.device))!.volume(p.cmd.vol! / 100)));
          await this.receivers.get(gid)!.play(url, media);
          for (const id of ids) { this.viaGroup.set(id, gid); this.receivers.get(id)!.media = media; }
        }));
      } else {
        for (const p of ps) jobs.push(run([p], async () => {
          const r = this.receivers.get(this.speakerId(p.device))!;
          if (p.cmd.vol != null) await r.volume(p.cmd.vol / 100);
          await r.play(url, media);
          this.viaGroup.delete(this.speakerId(p.device));
        }));
      }
    }
    // Stops: stop a group session only when all its speakers are stopped together.
    const stops = rest.filter(p => p.cmd.on === false || p.cmd.media === null);
    const stoppedIds = new Set(stops.map(p => this.speakerId(p.device)));
    const groupsDone = new Set<string>();
    for (const p of stops) {
      const id = this.speakerId(p.device);
      const gid = this.viaGroup.get(id);
      if (gid) {
        const members = [...this.viaGroup].filter(([, g]) => g === gid).map(([s]) => s);
        if (members.every(s => stoppedIds.has(s))) {
          if (!groupsDone.has(gid)) {
            groupsDone.add(gid);
            const ps = stops.filter(x => members.includes(this.speakerId(x.device)));
            jobs.push(run(ps, async () => { await this.receivers.get(gid)!.stop(); for (const s of members) { this.viaGroup.delete(s); this.receivers.get(s)!.media = null; } }));
          }
          continue;
        }
        // Only some speakers of a group: silence this one, the rest keep playing in sync.
        jobs.push(run([p], async () => { await this.receivers.get(id)!.volume(0, true); this.viaGroup.delete(id); this.receivers.get(id)!.media = null; }));
        continue;
      }
      jobs.push(run([p], () => this.receivers.get(id)!.stop()));
    }
    for (const p of rest.filter(x => !stops.includes(x))) {
      const r = this.receivers.get(this.speakerId(p.device))!;
      jobs.push(run([p], async () => {
        if (p.cmd.vol != null) await r.volume(p.cmd.vol / 100);
        if (p.cmd.on === true && !r.media) {
          const src = this.ctx!.sourceUrl('Radio');
          if (src) await r.play(src, 'Radio');
        }
      }));
    }
    await Promise.all(jobs);
  }

  private async poll(): Promise<void> {
    await Promise.all([...this.receivers.values()].filter(r => !r.ep.group).map(async r => {
      const id = r.ep.id;
      try {
        const { volume, app } = await r.status();
        const gid = this.viaGroup.get(id);
        let playing = !!app && !app.isIdleScreen;
        if (gid && !playing) {
          const g = await this.receivers.get(gid)!.status().catch(() => ({ app: undefined }));
          playing = !!g.app && !g.app.isIdleScreen;
          if (!playing) this.viaGroup.delete(id);
        }
        if (!playing) r.media = null;
        this.ctx!.report(this.kovaId(id), { online: true, on: playing, media: playing ? r.media ?? 'Casting' : null, vol: volume.level != null ? Math.round(volume.level * 100) : undefined });
        this.failing.delete(id);
      } catch {
        this.failing.add(id);
        this.ctx!.report(this.kovaId(id), { online: false });
      }
    }));
  }

  /** Cast groups Kova can use for synced playback, with their member device ids. */
  groupList(): { id: string; name: string; members: string[] }[] {
    return [...this.groups].map(([id, m]) => ({ id, name: this.receivers.get(id)!.ep.name, members: [...m].map(s => this.kovaId(s)) }));
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.browser?.destroy();
    for (const r of this.receivers.values()) r.ch.close();
  }

  status(): AdapterStatus {
    const speakers = [...this.receivers.values()].filter(r => !r.ep.group).length;
    if (this.failing.size) return { ok: false, note: `${this.failing.size} of ${speakers} not responding` };
    return { ok: speakers > 0, note: speakers ? `${speakers} speakers and displays · ${this.groups.size} group${this.groups.size === 1 ? '' : 's'} for synced audio` : 'No Cast devices found yet' };
  }
}

export type { CastMessage };
