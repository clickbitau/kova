import http from 'node:http';
import https from 'node:https';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { Hub } from '../hub.ts';
import { ClipError, Clips, MAX_CLIP_BYTES } from '../services/clips.ts';
import { BUILTIN_ADHANS, builtinAdhan } from '../services/adhans.ts';
import { applyPrayer, prayerView, type PrayerPatch } from '../services/prayer.ts';
import { DEFAULT_ANNOUNCE_LEVEL } from '../engine/announce.ts';
import { kovaAddress } from '../services/helix-link.ts';
import type { Automation } from '../model/types.ts';

// Announcements' routes: clips (upload, list, rename, remove), the files speakers fetch, "Play test", and prayer times.

const bad = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof ClipError ? e.status : code).send({ error: e instanceof Error ? e.message : String(e) });

/** The whole upload, refused as soon as it passes the limit. */
async function readBody(body: unknown, limit: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body && typeof (body as Readable).on === 'function') {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of body as Readable) {
      n += (c as Buffer).length;
      if (n > limit) { (body as Readable).resume(); throw new ClipError(`Clips can be up to ${limit / 1024 / 1024} MB`, 413); }
      parts.push(c as Buffer);
    }
    return Buffer.concat(parts);
  }
  throw new ClipError('Send the audio file itself as the request body');
}

/** Where clips and recordings are used (automations' announce steps and the prayer settings), by name. */
export function mediaUsers(hub: Hub, media: string): string[] {
  const out: string[] = [];
  const walk = (a: Automation, list: Automation['actions']): void => {
    for (const x of list) {
      if (x.kind === 'announce' && (x.media === media || Object.values(x.mediaFor ?? {}).includes(media))) out.push(a.name);
      if (x.kind === 'if') { walk(a, x.then); walk(a, x.else ?? []); }
      if (x.kind === 'repeat') walk(a, x.actions);
    }
  };
  for (const a of hub.config.get().automations ?? []) walk(a, a.actions);
  const p = hub.config.get().prayer?.adhan;
  if (p && (p.media === media || p.fajr === media)) out.push('Prayer times');
  return [...new Set(out)];
}

export function clipView(c: ReturnType<Clips['all']>[number]) { return { ...c, url: Clips.path(c) }; }

export function registerAnnounceRoutes(app: FastifyInstance, hub: Hub, port: () => number): void {
  // The hub's address on the speaker's own network (the interface on its /24), for the URLs speakers fetch.
  hub.lanBase = host => kovaAddress(host ? `http://${host}` : '', port());

  // Uploads: the raw file as the body (any audio type, or octet-stream).
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_CLIP_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/clips', async () => ({ clips: hub.clips.all().map(clipView), maxBytes: MAX_CLIP_BYTES }));
  app.post<{ Querystring: { name?: string } }>('/api/clips', { bodyLimit: MAX_CLIP_BYTES + 1024 }, async (req, reply) => {
    try {
      const body = await readBody(req.body, MAX_CLIP_BYTES);
      const clip = hub.clips.add(req.query.name ?? '', body, hub.engine.now());
      hub.store.append({ kind: 'system', device: null, feed: 'system', what: `Clip “${clip.name}” added`, data: { clip: clip.id }, cause: { kind: 'user', label: 'You' } });
      hub.emit('changed');
      return { clip: clipView(clip) };
    } catch (e) { return bad(reply, e); }
  });
  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/clips/:id', async (req, reply) => {
    try { const c = hub.clips.rename(req.params.id, req.body?.name); hub.emit('changed'); return { clip: clipView(c) }; } catch (e) { return bad(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/clips/:id', async (req, reply) => {
    const c = hub.clips.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'No such clip' });
    const usedBy = mediaUsers(hub, `clip:${c.id}`);
    if (usedBy.length) return reply.code(409).send({ error: `“${c.name}” is used by ${usedBy.join(', ')}: choose other audio there first`, usedBy });
    hub.clips.remove(c.id);
    hub.emit('changed');
    return { ok: true };
  });

  // What speakers fetch: no token (they can't send one). A clip's random id is its key; the recordings and the chime are public.
  // A Helix song as a sound (Media → Sounds), for speakers (no key: they can't send one): Helix's looping version,
  // fetched for them, ranges and all. Only sounds the home has set up this way.
  app.get<{ Params: { file: string } }>('/api/sound/:file', async (req, reply) => {
    const name = decodeURIComponent(req.params.file).replace(/\.aac$/, '');
    const src = hub.config.get().sources.find(x => x.name === name && x.helix);
    if (!src?.helix || !hub.music) return reply.code(404).send({ error: 'No such sound' });
    let url: string;
    try { url = await hub.music.loopUrl(src.helix.id); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
    const u = new URL(url);
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    return new Promise<void>(done => {
      const up = (u.protocol === 'https:' ? https : http).get(u, { headers: range ? { range } : {} }, res => {
        const pass: Record<string, string> = {};
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) { const v = res.headers[h]; if (typeof v === 'string') pass[h] = v; }
        reply.code(res.statusCode ?? 502).headers({ ...pass, 'cache-control': 'no-store' });
        void reply.send(res);
        res.on('end', () => done()).on('error', () => done());
      });
      up.on('error', e => { if (!reply.sent) void reply.code(502).send({ error: e.message }); done(); });
      req.raw.on('close', () => up.destroy());
    });
  });

  app.get<{ Params: { file: string } }>('/api/clip/:file', async (req, reply) => {
    const f = hub.clips.file(req.params.file) ?? hub.adhans.serve(req.params.file);
    if (!f) return reply.code(404).send({ error: 'No such clip' });
    reply.header('cache-control', 'public, max-age=86400').header('accept-ranges', 'bytes');
    // Speakers ask for ranges (Sonos, Cast seeking).
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const size = f.body.length;
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).type(f.contentType).header('content-range', `bytes ${start}-${end}/${size}`).send(f.body.subarray(start, end + 1));
    }
    return reply.type(f.contentType).send(f.body);
  });

  // Play test: the chime on one speaker at a level × its loudness, then back as it was.
  app.post<{ Params: { id: string }; Body: { level?: number } }>('/api/devices/:id/announce-test', async (req, reply) => {
    const level = req.body?.level ?? DEFAULT_ANNOUNCE_LEVEL;
    if (typeof level !== 'number' || !(level >= 1 && level <= 100)) return reply.code(400).send({ error: 'The test level is 1–100' });
    try {
      const r = await hub.announcer.test(req.params.id, Math.round(level), { kind: 'user', label: 'You', detail: 'Play test' });
      return { ok: true, vol: r.vol };
    } catch (e) { return bad(reply, e); }
  });

  // Prayer times (Integrations → Prayer times).
  app.get('/api/prayer', async () => prayerView(hub.config.get(), hub.engine.now()));
  app.put<{ Body: PrayerPatch }>('/api/prayer', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const was = hub.config.get().prayer?.on;
      hub.config.update(c => applyPrayer(c, b, m => hub.mediaProblem(m)));
      const p = hub.config.get().prayer!;
      if (b.on !== undefined && b.on !== was) hub.store.append({ kind: 'system', device: null, feed: 'system', what: `Prayer times ${p.on ? 'on' : 'off'}`, data: {}, cause: { kind: 'user', label: 'You' } });
      // The chosen recordings come down now, so the first call to prayer doesn't wait for them.
      for (const m of [p.adhan?.media, p.adhan?.fajr]) { const a = m ? builtinAdhan(m) : undefined; if (a && p.on) void hub.adhans.ensure(a).catch(() => {}); }
      hub.emit('changed');
      return prayerView(hub.config.get(), hub.engine.now());
    } catch (e) { return bad(reply, e); }
  });
  // The recordings Kova offers, with their credits, whether downloaded yet.
  app.get('/api/adhans', async () => ({ adhans: BUILTIN_ADHANS.map(a => ({ ...a, ready: hub.adhans.ready(a) })) }));
}
