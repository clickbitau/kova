import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { ImportError } from '../import/ha-source.ts';
import type { HaImport } from '../import/ha-scan.ts';
import type { Hub } from '../hub.ts';
import type { Automation } from '../model/types.ts';
import { randomUUID } from 'node:crypto';
import { checkAutomation } from '../engine/automation-check.ts';

// Import from Home Assistant, in the app. Upload a backup (streamed: HA's history database
// goes past without being stored), or point at a config folder on the hub; review; switch over.
export function registerImportRoutes(app: FastifyInstance, ha: HaImport | undefined, hub: Hub): void {
  // Raw uploads arrive as a stream; nothing is buffered here.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    const code = e instanceof ImportError ? e.code : undefined;
    return reply.code(e instanceof ImportError && code === 'not-found' ? 404 : 400).send({ error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) });
  };
  const need = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => { reply.code(503).send({ error: 'Import isn’t available on this hub' }); return null; };

  app.get('/api/import/ha', async (_req, reply) => (ha ? ha.summary() ?? { scanned: false } : need(reply)));
  app.get('/api/import/ha/automations', async (_req, reply) => (ha ? { automations: ha.automations() } : need(reply)));
  // Make Kova automations from them (all that can be, or { ids }). They start switched off: Home Assistant may still run the originals.
  app.post<{ Body: { ids?: string[] } }>('/api/import/ha/automations/convert', async (req, reply) => {
    if (!ha) return need(reply);
    try {
      const ctx = { device: (id: string) => hub.reg.get(id), cfg: hub.config.get() };
      const fresh: Automation[] = [];
      const r = ha.convert(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined, a => {
        const clean = checkAutomation(a, ctx);
        const id = `${clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'automation'}_${randomUUID().slice(0, 4)}`;
        fresh.push({ id, ...clean, enabled: false });
        return id;
      });
      const undo = fresh.length ? hub.engine.registerUndo(hub.config.update(c => { (c.automations ??= []).push(...fresh); })) : null;
      return { ...r, undo };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Body: the backup file as application/octet-stream. Header x-backup-key: the backup's encryption key, if it has one.
  app.post('/api/import/ha/backup', { bodyLimit: 64 * 1024 * 1024 * 1024 }, async (req, reply) => {
    if (!ha) return need(reply);
    const body = req.body as IncomingMessage | undefined;
    if (!body || typeof (body as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator] !== 'function') return reply.code(400).send({ error: 'Send the backup file as the request body (application/octet-stream)' });
    const key = String(req.headers['x-backup-key'] ?? '').trim() || undefined;
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 120) || undefined;
    try { return await ha.fromBackup(body as unknown as AsyncIterable<Buffer>, key, name); }
    catch (e) {
      // Read the rest of the upload before answering, so the browser finishes sending and sees the answer.
      try { for await (const _ of body as unknown as AsyncIterable<Buffer>) { /* discard */ } } catch { /* connection gone */ }
      return fail(reply, e);
    }
  });

  app.post<{ Body: { path?: string } }>('/api/import/ha/folder', async (req, reply) => {
    if (!ha) return need(reply);
    const path = String(req.body?.path ?? '').trim();
    if (!path) return reply.code(400).send({ error: 'path is required' });
    try { return await ha.fromFolder(path); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Params: { id: string }; Body: { done?: boolean } }>('/api/import/ha/review/:id', async (req, reply) => {
    if (!ha) return need(reply);
    return ha.markDone(req.params.id, req.body?.done !== false) ?? reply.code(404).send({ error: 'Nothing imported yet' });
  });

  app.post('/api/import/ha/apply', async (_req, reply) => {
    if (!ha) return need(reply);
    try { const r = await ha.apply(); return { ok: true, ...r, summary: ha.summary() }; } catch (e) { return fail(reply, e); }
  });

  app.delete('/api/import/ha', async (_req, reply) => { if (!ha) return need(reply); ha.forget(); return { ok: true }; });
}
