import type { FastifyInstance } from 'fastify';
import type { IntegrationsManager } from '../integrations-store.ts';
import { Warden, linkWarden, normMac } from '../adapters/warden.ts';
import { findHelixServers, helixPairPoll, helixPairStart } from '../adapters/helix.ts';
import { trimUrl } from '../util/lan-http.ts';
import type { HelixLink } from '../services/helix-link.ts';

// Linking Kova with the home's own apps: Warden (sign in once, Kova makes its own token) and
// Helix (pair with a code, like any Helix app). What they hand back is saved straight into
// integrations.json and never goes back to the browser.

type Reply = { code: (n: number) => { send: (b: { error: string }) => unknown }; header: (k: string, v: string) => unknown };
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface LanAppsOptions {
  integrations?: IntegrationsManager;
  /** Paired with Helix: tell it where Kova is and which TVs its boxes are on. */
  helixLink?: HelixLink;
  /** Tests narrow the Helix search to known hosts. */
  helixFindHosts?: string[];
  helixFindPort?: number;
}

export function registerLanAppRoutes(app: FastifyInstance, o: LanAppsOptions): void {
  const bad = (reply: Reply, m: string, code = 400) => reply.code(code).send({ error: m });

  // ----------------------------------------------------------------- Warden --

  app.post<{ Body: { url?: string; username?: string; password?: string; totp?: string } }>('/api/integrations/warden/link', async (req, reply) => {
    const b = req.body ?? {};
    const url = String(b.url ?? o.integrations?.raw('warden')?.url ?? '').trim();
    if (!url) return bad(reply, 'Enter Warden’s address');
    if (!b.username || !b.password) return bad(reply, 'Enter a Warden admin username and password');
    if (!o.integrations) return bad(reply, 'In-app setup isn’t available on this hub');
    try {
      const l = await linkWarden(url, b.username, b.password, b.totp?.trim() || undefined);
      const prev = o.integrations.raw('warden');
      const applied = await o.integrations.update('warden', { ...prev, url: l.url, token: l.token, fingerprint: l.fingerprint });
      reply.header('cache-control', 'no-store');
      return {
        linked: `Warden${l.siteName ? ` (${l.siteName})` : ''} at ${l.url}`,
        token: 'Kova made its own, named Kova. Remove it in Warden → System → API tokens to unlink.',
        status: applied.status?.note ?? 'Connected',
      };
    } catch (e) { return bad(reply, msg(e)); }
  });

  app.get('/api/integrations/warden/clients', async (_req, reply) => {
    const c = o.integrations?.raw('warden');
    if (!c?.url || !c.token) return bad(reply, 'Link with Warden first');
    try {
      const list = await new Warden(c).clients();
      const recent = (t?: string) => !!t && Date.now() - Date.parse(t) < 5 * 60_000;
      const rows = list
        .sort((a, b) => Number(recent(b.lastSeenAt)) - Number(recent(a.lastSeenAt)) || (a.name ?? a.hostname ?? '~').localeCompare(b.name ?? b.hostname ?? '~'))
        .map(x => ({ name: `${x.name || x.hostname || 'Unnamed'} · ${normMac(x.mac)}${x.ip ? ` · ${x.ip}` : ''}${recent(x.lastSeenAt) ? '' : ' · not seen lately'}`, mac: normMac(x.mac), ip: x.ip, online: recent(x.lastSeenAt) }));
      return { devices: rows };
    } catch (e) { return bad(reply, `Couldn’t read Warden: ${msg(e)}`); }
  });

  // ------------------------------------------------------------------ Helix --

  app.get('/api/integrations/helix/find', async () => {
    const servers = await findHelixServers({ hosts: o.helixFindHosts, port: o.helixFindPort });
    return servers.length ? { servers, next: 'Put the address in Helix Server address, then Pair with Helix.' } : { servers: [], next: 'None answered on this network. Type its address (port 8090).' };
  });

  // One pairing at a time: Kova keeps asking Helix until you type the code there, then saves its token.
  let pairing: { url: string; id: string; code: string; until: number; status: 'pending' | 'approved' | 'expired' | 'failed'; error?: string } | null = null;

  const watch = async (p: NonNullable<typeof pairing>, every: number) => {
    while (pairing === p && p.status === 'pending') {
      await new Promise(r => setTimeout(r, every));
      if (pairing !== p) return;
      if (Date.now() > p.until) { p.status = 'expired'; return; }
      try {
        const r = await helixPairPoll(p.url, p.id);
        if (r.status === 'expired') { p.status = 'expired'; return; }
        if (r.status === 'approved') {
          p.status = 'approved';
          const prev = o.integrations?.raw('helix');
          await o.integrations?.update('helix', { ...prev, url: p.url, token: r.token });
          await o.helixLink?.sync(true);
          return;
        }
      } catch (e) { p.error = msg(e); }
    }
  };

  app.post<{ Body: { url?: string } }>('/api/integrations/helix/pair', async (req, reply) => {
    const raw = String(req.body?.url || o.integrations?.raw('helix')?.url || '').trim();
    if (!raw) return bad(reply, 'Enter Helix Server’s address first (Find Helix Server can look for it)');
    if (!o.integrations) return bad(reply, 'In-app setup isn’t available on this hub');
    const url = trimUrl(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
    try {
      const s = await helixPairStart(url);
      pairing = { url, id: s.pairingId, code: s.code, until: Date.now() + s.expiresIn * 1000, status: 'pending' };
      void watch(pairing, Math.max(1, s.pollInterval ?? 2) * 1000);
      return { code: s.code, next: `In Helix Server open Devices, type ${s.code} and press Pair. Kova finishes by itself within ${Math.round(s.expiresIn / 60)} minutes.` };
    } catch (e) { return bad(reply, `Couldn’t start pairing with ${url}: ${msg(e)}`); }
  });

  app.get('/api/integrations/helix/pair', async () => pairing
    ? { status: pairing.status, code: pairing.status === 'pending' ? pairing.code : undefined, error: pairing.error }
    : { status: 'none' });
}
