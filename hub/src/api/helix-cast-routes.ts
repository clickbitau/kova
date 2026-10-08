import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub.ts';
import type { Cause, Device } from '../model/types.ts';
import type { CastSong } from '../services/helix-music.ts';
import { playerOf } from '../engine/group-sync.ts';

// Casting from Helix's apps to Kova's speakers and speaker groups (Helix D98.16). Helix calls these with the token
// Kova gave it (services/helix-link.ts allows exactly these four paths for it); the owner's key works too.
//
//   GET  /api/helix/speakers   every player that plays a queue (speakers, Sonos, Cast, speaker groups), and what each
//                              plays: Helix's own casts by their session, Kova's own Helix music with session null
//   POST /api/helix/play       a queue of Helix's signed song URLs on the chosen speakers, together (a speaker group
//                              plays it in time as it does Kova's own music)
//   POST /api/helix/control    pause, resume, stop, next, previous, seek, jump (every speaker of the session), and
//                              volume, mute (the named one only; a group's volume keeps its balance)
//   POST /api/helix/queue      songs added next or at the end
//
// A cast plays under its own name ("Helix · a7c3"), so Kova's screens show it like any music, and the songs count as
// played in Helix at 85% (the Helix profile they were sent for) as Kova's own do.

interface Session { media: string; targets: string[] }

const QUEUE_MAX = 500;
const CAUSE: Cause = { kind: 'device', label: 'Helix', detail: 'from a Helix app' };

export function registerHelixCastRoutes(app: FastifyInstance, hub: Hub): void {
  const sessions = new Map<string, Session>();
  /** Volume before Helix muted a speaker (Kova's speakers mute by volume). */
  const mutedAt = new Map<string, number>();
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, status: number, error: string) => reply.code(status).send({ error });

  const isGroup = (d: Device) => d.adapter === 'groups';
  const playable = (d: Device) => d.capabilities.includes('queue') && !d.archived && !d.hidden;
  const speakers = () => hub.reg.list().filter(playable);
  const roomName = (id: string) => hub.config.get().rooms.find(r => r.id === id)?.name ?? null;
  const groupOf = (d: Device) => (hub.config.get().speakerGroups ?? []).find(g => `group_${g.id}` === d.id);
  const sessionOf = (media: string | null | undefined) => media ? [...sessions].find(([, s]) => s.media === media)?.[0] ?? null : null;
  /** The devices a target plays through, for moving its place: a group's speakers, a combined device's speaker. */
  const players = (d: Device): Device[] => {
    const g = isGroup(d) ? groupOf(d) : undefined;
    const ids = g ? hub.groupSync.plan(g).flatMap(p => p.players) : [playerOf(d.id, id => hub.reg.get(id), hub.config.get().combined ?? []) ?? d.id];
    return [...new Set(ids)].map(id => hub.reg.get(id)).filter((x): x is Device => !!x);
  };
  const position = async (d: Device) => {
    const p = players(d)[0];
    const a = p ? hub.reg.adapters.get(p.adapter) : undefined;
    if (!p || !a?.playbackPosition) return null;
    const t = new Promise<null>(r => { const x = setTimeout(() => r(null), 1500); x.unref?.(); });
    return Promise.race([a.playbackPosition(p).catch(() => null), t]);
  };
  const moveTo = async (d: Device, index: number, positionMs: number) => {
    await Promise.allSettled(players(d).map(async p => {
      const a = hub.reg.adapters.get(p.adapter);
      if (a?.syncTo) await a.syncTo(p, { index, positionMs });
    }));
  };
  const song = (t: { id: string; title?: string; artist?: string; album?: string; art?: string; durationMs?: number }, art = true) => ({
    id: t.id, title: t.title ?? '', ...(t.artist ? { artist: t.artist } : {}), ...(t.album ? { album: t.album } : {}),
    ...(art && t.art ? { art: t.art } : {}), ...(t.durationMs ? { durationMs: Math.round(t.durationMs) } : {}),
  });

  // ---------------------------------------------------------------- speakers --
  app.get('/api/helix/speakers', async () => {
    const list = await Promise.all(speakers().map(async d => {
      const s = d.state;
      const songs = s.on && s.media ? hub.music?.songsOf(s.media) ?? null : null;
      let playing: Record<string, unknown> | null = null;
      if (s.on && s.media && (s.track?.id || songs?.length)) {
        const pos = await position(d);
        const idx = Math.max(0, pos?.index ?? (s.track?.id ? songs?.findIndex(t => t.id === s.track!.id) ?? 0 : 0));
        const cur = s.track?.id ? s.track : songs?.[idx];
        const now = Date.now();
        playing = {
          session: sessionOf(s.media),
          state: s.paused ? 'paused' : 'playing',
          track: song(cur as never),
          ...(pos ? { positionMs: Math.max(0, Math.round(pos.positionMs + (pos.playing ? now - pos.at : 0))) } : {}),
          index: idx,
          queue: (songs ?? []).slice(0, QUEUE_MAX).map(t => song(t, false)),
        };
      } else if (s.on && s.media) {
        // Something that isn't a queue of songs: an announcement (the adhan), a radio stream, another app's cast.
        const announcing = players(d).some(p => hub.announcer?.announcing(p.id)) || hub.announcer?.announcing(d.id);
        playing = {
          session: sessionOf(s.media), state: s.paused ? 'paused' : 'playing',
          track: { id: `kova:${s.media}`, title: s.media }, index: 0, queue: [],
          ...(announcing ? { announcement: true } : {}),
        };
      }
      const caps = ['volume', ...(d.capabilities.includes('pause') ? ['pause'] : []), ...(players(d).some(p => !!hub.reg.adapters.get(p.adapter)?.syncTo) ? ['seek'] : []), 'queue'];
      const g = isGroup(d) ? groupOf(d) : undefined;
      return {
        id: d.id, name: d.name, room: roomName(d.room), kind: g ? 'group' : 'speaker', ...(g ? { members: g.members } : {}),
        online: s.online !== false, volume: typeof s.vol === 'number' ? Math.round(s.vol) : null, muted: mutedAt.has(d.id) || !!s.muted,
        capabilities: caps, playing,
      };
    }));
    return { speakers: list };
  });

  /** The named targets, each a speaker or group that plays a queue; the unknown ones named. */
  const targetsOf = (raw: unknown): { ok: Device[] } | { status: number; error: string } => {
    if (!Array.isArray(raw) || !raw.length || raw.some(x => typeof x !== 'string')) return { status: 400, error: 'Say which speakers: targets is a list of speaker ids' };
    const ok: Device[] = [];
    for (const id of raw as string[]) {
      const d = hub.reg.get(id);
      if (!d || !playable(d)) return { status: 404, error: `Kova has no speaker “${id}”` };
      ok.push(d);
    }
    return { ok };
  };
  const songsIn = (raw: unknown): CastSong[] | null => {
    if (!Array.isArray(raw) || !raw.length) return null;
    const out: CastSong[] = [];
    for (const t of raw as Record<string, unknown>[]) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || typeof t.path !== 'string' || !t.path) return null;
      out.push({
        id: t.id, path: t.path, ...(typeof t.expiresAt === 'number' ? { expiresAt: t.expiresAt } : {}), ...(typeof t.contentType === 'string' ? { contentType: t.contentType } : {}),
        ...(typeof t.title === 'string' ? { title: t.title } : {}), ...(typeof t.artist === 'string' ? { artist: t.artist } : {}), ...(typeof t.album === 'string' ? { album: t.album } : {}),
        ...(typeof t.artPath === 'string' && t.artPath ? { artPath: t.artPath } : {}), ...(typeof t.durationMs === 'number' ? { durationMs: t.durationMs } : {}),
      });
    }
    return out;
  };
  /** Speakers that leave a session (something else plays, or they stop): out of it; an empty session is forgotten. */
  const leave = (ids: string[]) => {
    for (const [k, s] of [...sessions]) {
      s.targets = s.targets.filter(t => !ids.includes(t));
      if (!s.targets.length) { sessions.delete(k); hub.music?.forgetCast(s.media); }
    }
  };

  // -------------------------------------------------------------------- play --
  app.post<{ Body: Record<string, unknown> }>('/api/helix/play', async (req, reply) => {
    const b = req.body ?? {};
    const t = targetsOf(b.targets);
    if ('error' in t) return bad(reply, t.status, t.error);
    const songs = songsIn(b.tracks);
    if (!songs) return bad(reply, 400, 'tracks is a list of songs, each with its id and path');
    if (!hub.music) return bad(reply, 409, 'Kova isn’t paired with Helix');
    const session = typeof b.session === 'string' && b.session ? b.session.slice(0, 80) : `hx-${randomBytes(8).toString('hex')}`;
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 40) : 'Helix';
    const profile = typeof b.profile === 'string' && b.profile.trim() ? b.profile.trim() : 'default';
    const index = Number.isInteger(b.index) && (b.index as number) > 0 && (b.index as number) < songs.length ? b.index as number : 0;
    const positionMs = typeof b.positionMs === 'number' && b.positionMs > 0 ? Math.round(b.positionMs) : 0;
    // A session played again (Helix's "play" on the same session): the same name, a new queue.
    const media = sessions.get(session)?.media ?? `${label} · ${session.slice(-4)}`;
    const ids = t.ok.map(d => d.id);
    leave(ids);
    hub.music.castQueue(media, label, songs, profile);
    sessions.set(session, { media, targets: ids });
    const r = await Promise.allSettled(t.ok.map(d => hub.reg.command(d.id, { on: true, media }, CAUSE)));
    const failed = r.map((x, i) => x.status === 'rejected' ? `${t.ok[i]!.name}: ${(x.reason as Error)?.message}` : null).filter(Boolean);
    if (failed.length === r.length) { leave(ids); return bad(reply, 502, `The speakers didn’t play it. ${failed.join('; ')}`); }
    if (index || positionMs) await Promise.allSettled(t.ok.map(d => moveTo(d, index, positionMs)));
    return { ok: true, session, ...(failed.length ? { failed } : {}) };
  });

  // ----------------------------------------------------------------- control --
  const ACTIONS = new Set(['pause', 'resume', 'stop', 'next', 'previous', 'seek', 'volume', 'mute', 'jump']);
  app.post<{ Body: Record<string, unknown> }>('/api/helix/control', async (req, reply) => {
    const b = req.body ?? {};
    const t = targetsOf(b.targets);
    if ('error' in t) return bad(reply, t.status, t.error);
    const action = String(b.action ?? '');
    if (!ACTIONS.has(action)) return bad(reply, 400, `action is one of ${[...ACTIONS].join(', ')}`);
    if (action === 'volume') {
      const v = b.volume;
      if (typeof v !== 'number' || !(v >= 0 && v <= 100)) return bad(reply, 400, 'volume is 0–100');
      for (const d of t.ok) mutedAt.delete(d.id);
      await Promise.all(t.ok.map(d => hub.reg.command(d.id, { vol: Math.round(v) }, CAUSE)));
      return { ok: true };
    }
    if (action === 'mute') {
      await Promise.all(t.ok.map(async d => {
        const now = mutedAt.has(d.id);
        const want = typeof b.muted === 'boolean' ? b.muted : !now;
        if (want && !now) { mutedAt.set(d.id, d.state.vol ?? 30); await hub.reg.command(d.id, { vol: 0 }, CAUSE); }
        if (!want && now) { const v = mutedAt.get(d.id)!; mutedAt.delete(d.id); await hub.reg.command(d.id, { vol: v }, CAUSE); }
      }));
      return { ok: true };
    }
    // Transport: every speaker of the session each target plays in (a speaker not in one: itself).
    const all = new Map<string, Device>();
    for (const d of t.ok) {
      const s = sessions.get(sessionOf(d.state.media) ?? '');
      for (const id of s?.targets ?? [d.id]) { const x = hub.reg.get(id); if (x) all.set(id, x); }
    }
    const ds = [...all.values()];
    if (action === 'stop') { await Promise.allSettled(ds.map(d => hub.reg.command(d.id, { on: false, media: null }, CAUSE))); leave(ds.map(d => d.id)); return { ok: true }; }
    if (action === 'pause' || action === 'resume') { await Promise.allSettled(ds.map(d => hub.reg.command(d.id, { paused: action === 'pause' }, CAUSE))); return { ok: true }; }
    // Next and previous on the speakers that hold the queue; a group's members follow it.
    if (action === 'next' || action === 'previous') { await Promise.allSettled(ds.map(d => hub.reg.command(d.id, { skip: action === 'next' ? 1 : -1 }, CAUSE))); return { ok: true }; }
    if (action === 'seek') {
      const ms = b.positionMs;
      if (typeof ms !== 'number' || ms < 0) return bad(reply, 400, 'positionMs is where to go, in ms');
      const pos = await position(ds[0]!);
      if (!pos) return bad(reply, 409, 'Nothing is playing there');
      await Promise.allSettled(ds.map(d => moveTo(d, pos.index, Math.round(ms))));
      return { ok: true };
    }
    // jump: that song of the queue, from its start.
    const i = b.index;
    const songs = hub.music?.songsOf(ds[0]!.state.media ?? '') ?? [];
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= songs.length) return bad(reply, 400, `index is a song in the queue, 0–${Math.max(0, songs.length - 1)}`);
    await Promise.allSettled(ds.map(d => moveTo(d, i as number, 0)));
    return { ok: true };
  });

  // ------------------------------------------------------------------- queue --
  app.post<{ Body: Record<string, unknown> }>('/api/helix/queue', async (req, reply) => {
    const b = req.body ?? {};
    const t = targetsOf(b.targets);
    if ('error' in t) return bad(reply, t.status, t.error);
    const at = b.at === 'next' ? 'next' : b.at === 'end' ? 'end' : null;
    if (!at) return bad(reply, 400, 'at is "next" or "end"');
    const songs = songsIn(b.tracks);
    if (!songs) return bad(reply, 400, 'tracks is a list of songs, each with its id and path');
    const d = t.ok[0]!;
    const media = d.state.on ? d.state.media : null;
    if (!media || !hub.music) return bad(reply, 409, `Nothing is playing on ${d.name}`);
    if (!hub.music.isCast(media)) return bad(reply, 409, `${d.name} is playing ${media} from Kova, not a Helix queue`);
    if (at === 'end') return { ok: true, length: hub.music.castAdd(media, songs, 'end') };
    // Next: after the song playing now. Speakers hold the next few songs already, so each is started again on this
    // song at its place, with the new ones after it (a moment's pause).
    const pos = await position(d);
    const cur = pos?.index ?? 0;
    const length = hub.music.castAdd(media, songs, { after: cur });
    const s = sessions.get(sessionOf(media) ?? '');
    const ds = (s?.targets ?? [d.id]).map(id => hub.reg.get(id)).filter((x): x is Device => !!x);
    const was = pos ? pos.positionMs + (pos.playing ? Date.now() - pos.at : 0) : 0;
    await Promise.allSettled(ds.map(x => hub.reg.command(x.id, { on: true, media }, CAUSE)));
    await Promise.allSettled(ds.map(x => moveTo(x, cur, Math.round(was))));
    return { ok: true, length };
  });

  // Anything else played on a speaker of a session takes it out of the session.
  hub.reg.on('change', e => {
    const m = e.device.state.media;
    for (const [, s] of sessions) if (s.targets.includes(e.device.id) && m !== s.media && (e.patch.media !== undefined || e.patch.on === false)) leave([e.device.id]);
  });
}
