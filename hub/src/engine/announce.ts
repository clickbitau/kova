import { balancedVols } from '../adapters/groups.ts';
import type { AnnounceAction, Cause, Device, HomeConfig, PrayerName, Trigger } from '../model/types.ts';
import type { Clip as PlayClip } from '../adapters/sdk.ts';
import type { PlaybackSnap, Registry } from '../devices/registry.ts';
import type { ConfigStore } from './config.ts';
import type { Clips } from '../services/clips.ts';
import { Clips as ClipStore, CHIME_FILE, CHIME_MS } from '../services/clips.ts';
import { Adhans, builtinAdhan } from '../services/adhans.ts';

// Announcements: play something over the speakers (a call to prayer, a chime), then put each speaker back as it was.
//
// One run, in order: work out the speakers (a Kova speaker group stands for its members, each at its own loudness;
// a speaker switched off in the step, or skipped while an overlay is on, sits it out), note what each one is doing
// (registry.snapshotPlayback: volume, on or off, what plays, and where the speaker's integration can say, the place in
// it), pause the players asked for (a Helix box's film), set every speaker's volume and start them all in the same
// moment, wait until it's over (the clip's length; the speakers saying they've stopped; or at most maxSec), then
// put each back (registry.restorePlayback) and let the paused players carry on. One speaker failing never stops the
// rest; the run's history says which did what.

export const DEFAULT_ANNOUNCE_LEVEL = 20;
export const DEFAULT_MAX_SEC = 420;
/** The media id of the generated chime the Play test uses (not offered as an announcement). */
export const CHIME_MEDIA = 'kova:chime';

/** A speaker an announcement can play on: a media player with a volume (not a TV, not a Kova speaker group). */
export const canAnnounce = (d: Device) => !d.archived && d.type === 'media' && d.adapter !== 'groups' && d.capabilities.includes('volume') && (d.capabilities.includes('media') || d.capabilities.includes('queue'));
export const isSpeakerGroup = (d: Device) => d.adapter === 'groups';
/** What an announce step's targets may be. */
export const announceTarget = (d: Device) => canAnnounce(d) || (isSpeakerGroup(d) && !d.archived);

/** The level a speaker plays at: the level the owner asked for × the speaker's announcement loudness (in %). */
export function announceVol(level: number, trim = 100): number {
  if (!(level > 0)) return 0;
  return Math.max(1, Math.min(100, Math.round(level * (trim > 0 ? trim : 100) / 100)));
}

/** The speaker's loudness setting (100 when unset). */
export const trimOf = (cfg: Pick<HomeConfig, 'devices'>, id: string) => cfg.devices?.[id]?.announceTrim ?? 100;

/** Announce media in words: the source's name, a clip's, a recording's title, "<song> (Helix)", or the URL's file. */
export function mediaWords(media: string | undefined, clipName?: (id: string) => string | undefined): string {
  if (!media) return 'audio still to choose';
  if (media === CHIME_MEDIA) return 'a chime';
  if (media.startsWith('clip:')) return clipName?.(media.slice(5)) ?? 'a clip';
  if (media.startsWith('adhan:')) return builtinAdhan(media)?.title ?? 'a call to prayer';
  const song = /^song: (.+)$/i.exec(media);
  if (song) return `${song[1]} (Helix)`;
  if (/^https?:\/\//i.test(media)) {
    try { const u = new URL(media); return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || u.host; } catch { return 'a link'; }
  }
  return media;
}

/** What an announce step does, in one line. */
export function announceWords(a: AnnounceAction, name: (id: string) => string, clipName?: (id: string) => string | undefined): string {
  const all = Object.keys(a.targets), on = all.filter(id => !a.targets[id]!.off);
  const who = on.length === 1 && all.length === 1 ? name(on[0]!) : `${on.length}${on.length === all.length ? '' : ` of ${all.length}`} speaker${all.length === 1 ? '' : 's'}`;
  const fajr = a.mediaFor?.fajr && a.mediaFor.fajr !== a.media ? ` (Fajr: ${mediaWords(a.mediaFor.fajr, clipName)})` : '';
  const pause = a.pause?.length ? `, pausing ${a.pause.map(name).join(' and ')}` : '';
  return `Announce ${mediaWords(a.media, clipName)}${fajr} on ${who} at ${a.vol}%${pause}, then ${a.restore === false ? 'leave them idle' : 'back to what they played'}`;
}

/** Which announcement to play for the trigger that started the run: a prayer's own (Fajr's), else the step's. */
export function mediaFor(a: AnnounceAction, trigger?: Trigger): string | undefined {
  const p = trigger?.kind === 'time' && trigger.at.kind === 'prayer' ? trigger.at.prayer : undefined;
  return (p && a.mediaFor?.[p as PrayerName]) || a.media;
}

/** An IPv4 address in a device's address ("10.0.0.5:8009", "10.0.0.7"), for the hub's address on that network. */
const hostOf = (address: string | undefined) => /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(address ?? '')?.[1];

export interface AnnounceLine { text: string; ok: boolean; detail?: string }
export interface AnnounceResult { lines: AnnounceLine[]; played: string[]; failed: { id: string; error: string }[]; restored: string[] }

export interface AnnounceRun {
  cause: Cause;
  trigger?: Trigger;
  /** The overlay on now (for skipWhile). */
  overlay: string | null;
  /** Wait at most `ms`, or until `done()` (checked whenever a device changes). Rejects when the run is cancelled. */
  wait(ms: number, done: () => boolean): Promise<void>;
}

interface Resolved { title: string; contentType: string; durationMs?: number; url(d: Device): string }

export class Announcer {
  /** Speakers in an announcement now: a second one leaves them be (their snapshot is the first's). */
  private busy = new Set<string>();

  constructor(private reg: Registry, private config: ConfigStore, private o: {
    clips: Clips; adhans: Adhans;
    /** The hub's address as a speaker at this IP reaches it ("http://10.0.0.2:8140"), or null when there's none. */
    base: (host?: string) => string | null;
    /** Helix's song → a URL a speaker can fetch, for "Song: <title>". */
    now?: () => number;
  }) {}

  /** A speaker the media plays on reaches it through: its own address (or a combined device's member that plays). */
  private hostFor(d: Device): string | undefined {
    if (d.adapter === 'combined') {
      for (const id of d.address.split(',').map(s => s.trim())) { const m = this.reg.get(id); const h = m && m.capabilities.includes('media') ? hostOf(m.address) : undefined; if (h) return h; }
    }
    return hostOf(d.address);
  }

  private hubUrl(d: Device, path: string): string {
    const base = this.o.base(this.hostFor(d));
    if (!base) throw new Error('Kova doesn’t know its own address on your network for the speakers to fetch from');
    return `${base}${path}`;
  }

  /** What the media is, and the URL each speaker fetches. Throws with a reason a person can read. */
  async resolve(media: string): Promise<Resolved> {
    const typeOf = (u: string) => /\.ogg(\?|$)/i.test(u) ? 'audio/ogg' : /\.wav(\?|$)/i.test(u) ? 'audio/wav' : /\.flac(\?|$)/i.test(u) ? 'audio/flac' : /\.(m4a|mp4)(\?|$)/i.test(u) ? 'audio/mp4' : /\.aac(\?|$)/i.test(u) ? 'audio/aac' : 'audio/mpeg';
    if (media === CHIME_MEDIA) return { title: 'Kova chime', contentType: 'audio/wav', durationMs: CHIME_MS, url: d => this.hubUrl(d, `/api/clip/${CHIME_FILE}`) };
    if (media.startsWith('clip:')) {
      const c = this.o.clips.get(media.slice(5));
      if (!c) throw new Error('That clip isn’t on the hub any more');
      return { title: c.name, contentType: c.contentType, ...(c.durationMs ? { durationMs: c.durationMs } : {}), url: d => this.hubUrl(d, ClipStore.path(c)) };
    }
    if (media.startsWith('adhan:')) {
      const a = builtinAdhan(media);
      if (!a) throw new Error('Kova doesn’t know that recording');
      await this.o.adhans.ensure(a);
      return { title: a.title, contentType: a.contentType, durationMs: a.durationMs, url: d => this.hubUrl(d, `/api/clip/${Adhans.file(a)}`) };
    }
    if (/^https?:\/\/\S+$/i.test(media)) return { title: 'Announcement', contentType: typeOf(media), url: () => media };
    if (/^song: /i.test(media)) {
      const q = await this.reg.queues?.(media, { format: 'aac' }).catch(() => null);
      const t = q?.tracks[0];
      if (!q || !t) throw new Error(`Helix has no song “${media.slice(6)}”`);
      await q.prepare?.(0, 1);
      return { title: t.title, contentType: q.tracks[0]!.contentType, ...(t.durationMs ? { durationMs: t.durationMs } : {}), url: () => q.tracks[0]!.url };
    }
    const src = this.config.get().sources.find(s => s.name === media);
    if (!src) throw new Error(`There’s no source called “${media}”`);
    if (!src.url) throw new Error(`“${media}” has no stream address yet`);
    return { title: src.name, contentType: typeOf(src.url), url: () => src.url! };
  }

  /** The speakers a step plays on, each at its level: groups expanded, switched-off and skipped ones left out (and said). */
  private speakers(a: AnnounceAction, run: AnnounceRun): { list: { d: Device; level: number }[]; out: AnnounceLine[]; failed: { id: string; error: string }[] } {
    const cfg = this.config.get();
    const list = new Map<string, { d: Device; level: number }>();
    const out: AnnounceLine[] = [], failed: { id: string; error: string }[] = [];
    const skipped: string[] = [];
    const named = new Set(Object.keys(a.targets));
    for (const [id, t] of Object.entries(a.targets)) {
      const d = this.reg.get(id);
      if (t.off) continue;
      if (run.overlay && t.skipWhile?.includes(run.overlay)) { skipped.push(d?.name ?? id); continue; }
      if (!d) { failed.push({ id, error: 'isn’t there any more' }); continue; }
      const level = t.vol ?? a.vol;
      if (isSpeakerGroup(d)) {
        const g = (cfg.speakerGroups ?? []).find(x => `group_${x.id}` === d.id);
        // The group's balance between its speakers holds here too: the loudest at the level, the others at their
        // share of it. A member listed on its own keeps its own setting (its level, switched off, skipped).
        const share = g?.balance ? balancedVols(level, (g.members).map(m => ({ id: m, vol: this.reg.get(m)?.state.vol ?? undefined })), g.balance) : null;
        for (const m of g?.members ?? []) { const md = this.reg.get(m); if (md && canAnnounce(md) && !named.has(m) && !list.has(m)) list.set(m, { d: md, level: share?.[m] ?? level }); }
        continue;
      }
      if (!canAnnounce(d)) { failed.push({ id, error: 'isn’t a speaker' }); continue; }
      list.set(id, { d, level });
    }
    if (skipped.length) {
      const ov = cfg.overlays.find(o => o.id === run.overlay)?.name ?? run.overlay;
      out.push({ text: `Left out ${skipped.join(', ')} while ${ov} is on`, ok: true });
    }
    for (const [id, x] of [...list]) {
      if (x.d.state.online === false) { list.delete(id); failed.push({ id, error: 'is offline' }); }
      else if (this.busy.has(id)) { list.delete(id); failed.push({ id, error: 'is already announcing something' }); }
    }
    return { list: [...list.values()], out, failed };
  }

  async run(a: AnnounceAction, run: AnnounceRun): Promise<AnnounceResult> {
    const media = mediaFor(a, run.trigger);
    const name = (id: string) => this.reg.get(id)?.name ?? id;
    const lines: AnnounceLine[] = [];
    const result: AnnounceResult = { lines, played: [], failed: [], restored: [] };
    if (!media) { lines.push({ text: 'Announce', ok: false, detail: 'no audio chosen yet' }); return result; }
    let what: Resolved;
    try { what = await this.resolve(media); } catch (e) { lines.push({ text: `Announce ${mediaWords(media, id => this.o.clips.get(id)?.name)}`, ok: false, detail: (e as Error).message }); return result; }
    const { list, out, failed } = this.speakers(a, run);
    lines.push(...out);
    result.failed.push(...failed);
    if (!list.length) {
      lines.push({ text: `Announce ${what.title}`, ok: !failed.length, detail: failed.length ? failed.map(f => `${name(f.id)} ${f.error}`).join('; ') : 'no speaker to play on' });
      return result;
    }
    for (const x of list) this.busy.add(x.d.id);
    const cfg = this.config.get();
    const snaps = new Map<string, PlaybackSnap>();
    const paused: string[] = [];
    try {
      // What each speaker is doing now: what to put back.
      await Promise.all(list.map(async x => { snaps.set(x.d.id, await this.reg.snapshotPlayback(x.d.id)); }));
      // Players to pause (only what's playing; one already paused stays the owner's).
      for (const id of a.pause ?? []) {
        const d = this.reg.get(id);
        if (!d || !d.state.on || d.state.paused) continue;
        try { await this.reg.command(id, { paused: true }, run.cause, { quiet: true }); paused.push(id); } catch (e) { lines.push({ text: `Pause ${d.name}`, ok: false, detail: (e as Error).message }); }
      }
      // Every speaker at its own volume, then all of them start in the same moment.
      const vols = new Map(list.map(x => [x.d.id, announceVol(x.level, trimOf(cfg, x.d.id))]));
      const started = this.o.now?.() ?? Date.now();
      // Together: speakers a Cast group covers play through it, in step; the rest start as it's heard.
      const plays = await this.reg.playClips(list.map(x => ({
        id: x.d.id, vol: vols.get(x.d.id)!,
        clip: { url: what.url(x.d), title: what.title, contentType: what.contentType, ...(what.durationMs ? { durationMs: what.durationMs } : {}) } as PlayClip,
      })), run.cause);
      plays.forEach((p, i) => {
        const id = list[i]!.d.id;
        if (p.status === 'fulfilled') result.played.push(id);
        else result.failed.push({ id, error: p.reason instanceof Error ? p.reason.message : String(p.reason) });
      });
      const playedW = result.played.map(id => `${name(id)} ${vols.get(id)}%`);
      lines.push({
        text: `Announced ${what.title}${playedW.length ? ` on ${playedW.join(', ')}` : ''}`, ok: !result.failed.length && result.played.length > 0,
        ...(result.failed.length ? { detail: result.failed.map(f => `${name(f.id)} ${f.error.startsWith('is ') ? f.error : `didn’t play: ${f.error}`}`).join('; ') } : {}),
        ...(paused.length ? {} : {}),
      });
      if (paused.length) lines.push({ text: `Paused ${paused.map(name).join(', ')}`, ok: true });
      // Until it's over: its length (a little grace), all speakers stopped, or the most it may take.
      if (result.played.length) {
        const maxMs = (a.maxSec ?? DEFAULT_MAX_SEC) * 1000;
        const ms = what.durationMs ? Math.min(maxMs, what.durationMs + 2500) : maxMs;
        const now = () => this.o.now?.() ?? Date.now();
        const idle = () => now() - started >= 3000 && result.played.every(id => { const s = this.reg.get(id)?.state; return !s || !s.on || s.media !== what.title; });
        await run.wait(ms, idle);
      }
    } finally {
      // Put everything back, whatever happened (a cancelled run too).
      const back = await Promise.allSettled(list.map(async x => this.reg.restorePlayback(x.d.id, snaps.get(x.d.id) ?? { state: x.d.state }, run.cause, a.restore !== false)));
      const said: string[] = [], bad: string[] = [];
      back.forEach((b, i) => {
        const id = list[i]!.d.id;
        if (b.status === 'fulfilled') { said.push(`${name(id)}: ${b.value}`); result.restored.push(id); } else bad.push(`${name(id)}: ${b.reason instanceof Error ? b.reason.message : String(b.reason)}`);
      });
      lines.push({ text: a.restore === false ? 'Volumes back; speakers left idle' : 'Put the speakers back', ok: !bad.length, detail: [...said, ...bad].join('; ') });
      for (const id of paused) {
        const d = this.reg.get(id);
        if (!d?.state.on || !d.state.paused) continue;
        try { await this.reg.command(id, { paused: false }, run.cause, { quiet: true }); lines.push({ text: `${d.name} carried on`, ok: true }); } catch (e) { lines.push({ text: `${d.name} carried on`, ok: false, detail: (e as Error).message }); }
      }
      for (const x of list) this.busy.delete(x.d.id);
      this.reg.clipDone(what.title);
    }
    return result;
  }

  /** "Play test": the chime on one speaker at a level × its loudness, then back as it was. Real time, not the engine's. */
  async test(id: string, level: number, cause: Cause): Promise<{ vol: number; result: AnnounceResult }> {
    const d = this.reg.get(id);
    if (!d || !canAnnounce(d)) throw new Error(d ? `${d.name} isn’t a speaker Kova can announce on` : 'Unknown device');
    const step: AnnounceAction = { kind: 'announce', media: CHIME_MEDIA, vol: level, targets: { [id]: {} }, restore: true, maxSec: 15 };
    const result = await this.run(step, { cause, overlay: null, wait: (ms, done) => waitReal(this.reg, ms, done) });
    if (result.failed.length) throw new Error(`${d.name} didn’t play it: ${result.failed[0]!.error}`);
    return { vol: announceVol(level, trimOf(this.config.get(), id)), result };
  }
}

/** Wait in real time: at most `ms`, or until `done()` holds after a device changes. */
export function waitReal(reg: Registry, ms: number, done: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(t); clearInterval(poll); reg.off('change', check); resolve(); };
    const check = () => { if (done()) finish(); };
    const t = setTimeout(finish, ms);
    const poll = setInterval(check, 1000);
    reg.on('change', check);
  });
}
