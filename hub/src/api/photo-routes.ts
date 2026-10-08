import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.ts';
import { currentActor } from '../services/actor.ts';

// People's photos, shown instead of their initial. A photo is set by the person themselves or an owner, sent as a
// small image (the apps shrink it first: at most PHOTO_MAX), and kept in <data>/photos. Its address carries a random
// part, so it works in an <img> without a key yet can't be guessed; a new photo gets a new address.
export const PHOTO_MAX = 600 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function registerPhotoRoutes(app: FastifyInstance, hub: Hub): void {
  const where = () => (hub.dataDir ? join(hub.dataDir, 'photos') : null);
  app.addContentTypeParser(/^image\/(jpeg|png|webp)$/, { parseAs: 'buffer', bodyLimit: PHOTO_MAX }, (_req, body, done) => done(null, body));
  const mayEdit = (id: string) => { const a = currentActor(); return !a || a.role === 'owner' || a.personId === id; };
  const drop = (id: string) => { const dir = where(); if (dir && existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(`${id}-`)) rmSync(join(dir, f), { force: true }); };

  app.put<{ Params: { id: string } }>('/api/people/:id/photo', { bodyLimit: PHOTO_MAX }, async (req, reply) => {
    const id = req.params.id;
    if (!hub.config.get().people.some(p => p.id === id)) return reply.code(404).send({ error: 'Unknown person' });
    if (!mayEdit(id)) return reply.code(403).send({ error: 'Only they, or an owner, can change their photo' });
    const ext = TYPES[String(req.headers['content-type']).split(';')[0]!.trim()];
    const body = req.body;
    if (!ext || !Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'Send a JPEG, PNG or WebP photo' });
    const dir = where();
    if (!dir) return reply.code(500).send({ error: 'This hub has nowhere to keep photos' });
    mkdirSync(dir, { recursive: true });
    drop(id);
    const file = `${id}-${randomBytes(8).toString('hex')}.${ext}`;
    writeFileSync(join(dir, file), body, { mode: 0o600 });
    hub.config.update(c => { const p = c.people.find(x => x.id === id); if (p) p.photo = `/api/photo/${file}`; });
    hub.emit('changed');
    return { ok: true, photo: `/api/photo/${file}` };
  });

  app.delete<{ Params: { id: string } }>('/api/people/:id/photo', async (req, reply) => {
    const id = req.params.id;
    if (!mayEdit(id)) return reply.code(403).send({ error: 'Only they, or an owner, can change their photo' });
    drop(id);
    hub.config.update(c => { const p = c.people.find(x => x.id === id); if (p) delete p.photo; });
    hub.emit('changed');
    return { ok: true };
  });

  app.get<{ Params: { file: string } }>('/api/photo/:file', async (req, reply) => {
    const m = /^([a-z0-9_-]+)-[0-9a-f]{16}\.(jpg|png|webp)$/.exec(req.params.file);
    const dir = where();
    const f = m && dir ? join(dir, req.params.file) : null;
    if (!f || !existsSync(f)) return reply.code(404).send({ error: 'No such photo' });
    return reply.type(m![2] === 'jpg' ? 'image/jpeg' : `image/${m![2]}`).header('cache-control', 'private, max-age=31536000, immutable').send(createReadStream(f));
  });
}
