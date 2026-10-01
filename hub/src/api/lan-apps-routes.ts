import type { FastifyInstance } from 'fastify';
import type { IntegrationsManager } from '../integrations-store.ts';
import { Warden, deviceLabel, linkWarden, normMac, wardenPairPoll, wardenPairStart, type WardenDevice } from '../adapters/warden.ts';
import { LanHttpError } from '../util/lan-http.ts';
import { findHelixServers, helixPairPoll, helixPairStart } from '../adapters/helix.ts';
import { trimUrl } from '../util/lan-http.ts';
import type { HelixLink } from '../services/helix-link.ts';
import { findCastDevices, findCastGroups, findSonos, searchHosts } from '../services/lan-find.ts';

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
  /** Tests poll Warden pairing faster. */
  wardenPollMs?: number;
  /** Tests: the addresses Find searches instead of the hub's networks and Warden's devices, and the group port range. */
  findHosts?: string[];
  castGroupPorts?: { from: number; to: number };
  castInsecure?: boolean;
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

  // Pair by code: Warden shows the same code at /apps for an admin to approve, and Kova collects a token
  // limited to what it asked for. Kova keeps asking until then, like pairing with Helix.
  let wpair: { url: string; fingerprint?: string; siteName?: string; pairId: string; pollSecret: string; code: string; until: number; status: 'pending' | 'approved' | 'denied' | 'expired'; error?: string } | null = null;

  const watchWarden = async (p: NonNullable<typeof wpair>) => {
    while (wpair === p && p.status === 'pending') {
      await new Promise(r => setTimeout(r, o.wardenPollMs ?? 3000));
      if (wpair !== p) return;
      if (Date.now() > p.until) { p.status = 'expired'; return; }
      try {
        const r = await wardenPairPoll(p);
        if (r.status === 'denied' || r.status === 'expired') { p.status = r.status; return; }
        if (r.status === 'approved' && 'token' in r && r.token) {
          p.status = 'approved';
          const prev = o.integrations?.raw('warden');
          await o.integrations?.update('warden', { ...prev, url: p.url, token: r.token, fingerprint: p.fingerprint });
          return;
        }
        if (r.status === 'approved') { p.status = 'expired'; p.error = 'The token was already collected. Pair again.'; return; }
      } catch (e) { p.error = msg(e); }
    }
  };

  app.post<{ Body: { url?: string } }>('/api/integrations/warden/pair', async (req, reply) => {
    const url = String(req.body?.url || o.integrations?.raw('warden')?.url || '').trim();
    if (!url) return bad(reply, 'Enter Warden’s address');
    if (!o.integrations) return bad(reply, 'In-app setup isn’t available on this hub');
    try {
      const s = await wardenPairStart(url);
      wpair = { ...s, until: Date.parse(s.expiresAt) || Date.now() + 10 * 60_000, status: 'pending' };
      void watchWarden(wpair);
      return {
        code: s.code,
        next: `In Warden open ${s.url}/apps (System → Accounts → Apps), check it shows ${s.code}, and approve Kova. Kova finishes by itself.`,
      };
    } catch (e) { return bad(reply, msg(e)); }
  });

  app.get('/api/integrations/warden/pair', async () => wpair
    ? { status: wpair.status, code: wpair.status === 'pending' ? wpair.code : undefined, error: wpair.error }
    : { status: 'none' });

  // Devices on the network, for choosing internet switches and people's phones.
  app.get('/api/integrations/warden/clients', async (_req, reply) => {
    const c = o.integrations?.raw('warden');
    if (!c?.url || !c.token) return bad(reply, 'Link with Warden first');
    const w = new Warden(c);
    try {
      let list: WardenDevice[];
      try { list = await w.devices(); } catch (e) {
        if (!(e instanceof LanHttpError && e.status === 404)) throw e;
        // Older Warden: clients by MAC.
        const recent = (t?: string) => !!t && Date.now() - Date.parse(t) < 5 * 60_000;
        list = (await w.clients()).map(x => ({ id: '', name: x.name, hostname: x.hostname, macs: [normMac(x.mac)], ips: x.ip ? [x.ip] : [], online: recent(x.lastSeenAt), paused: false }));
      }
      const rows = list
        .sort((a, b) => Number(b.online) - Number(a.online) || deviceLabel(a).localeCompare(deviceLabel(b)))
        .map(x => ({
          name: [deviceLabel(x), x.owner && `${x.owner}’s`, x.class, x.vendor && x.vendor !== deviceLabel(x) ? x.vendor : '', x.network?.name, x.macs[0], x.ips[0], x.online ? '' : 'not here now']
            .filter(Boolean).join(' · '),
          deviceId: x.id || undefined, mac: x.macs[0], ip: x.ips[0], online: x.online,
        }));
      return { devices: rows };
    } catch (e) { return bad(reply, `Couldn’t read Warden: ${msg(e)}`); }
  });

  // ------------------------------------------------- finding speakers --
  // Speakers on another VLAN aren't heard announcing themselves, so Find asks every address: the hub's own
  // networks, one the owner names ("10.10.30.0/24"), and every device Warden sees online when it's linked.
  const findTargets = async (subnet?: string): Promise<string[]> => {
    if (o.findHosts) return o.findHosts;
    let extra: string[] = [];
    const w = o.integrations?.raw('warden');
    if (w?.url && w.token) {
      try { extra = (await new Warden(w).devices()).filter(d => d.online).flatMap(d => d.ips); } catch { /* without Warden's list */ }
    }
    return searchHosts({ subnet, extra });
  };

  app.post<{ Body: { subnet?: string } }>('/api/integrations/cast/find', async (req, reply) => {
    if (!o.integrations) return bad(reply, 'Integration settings aren’t available', 503);
    let hosts: string[];
    try { hosts = await findTargets(req.body?.subnet); } catch (e) { return bad(reply, msg(e)); }
    const speakers = await findCastDevices(hosts);
    const groups = await findCastGroups(speakers.map(s => s.host), { ports: o.castGroupPorts, insecure: o.castInsecure });
    const prev = (o.integrations.raw('cast') ?? {}) as { endpoints?: { id: string; name: string; model: string; host: string; port: number }[]; rooms?: Record<string, string>; ids?: Record<string, string> };
    const endpoints = [...(prev.endpoints ?? [])];
    let added = 0, updated = 0;
    const put = (e: { id: string; name: string; model: string; host: string; port: number }, same: (x: typeof e) => boolean) => {
      const i = endpoints.findIndex(same);
      if (i < 0) { endpoints.push(e); added++; return; }
      if (endpoints[i].host !== e.host || endpoints[i].port !== e.port) { endpoints[i] = { ...endpoints[i], host: e.host, port: e.port }; updated++; }
    };
    for (const s of speakers) put(s, x => x.id === s.id);
    // A group is known by its speakers: the id stays when Google moves it to another speaker or port.
    const byName = new Map(speakers.map(s => [s.id, s.name]));
    for (const g of groups) {
      const id = `group${g.members.join('').slice(0, 24)}`;
      const name = `Google group: ${g.members.map(m => byName.get(m) ?? m.slice(0, 6)).join(', ')}`.slice(0, 120);
      const known = (prev.endpoints ?? []).find(x => /cast group/i.test(x.model) && (x.id === id || (x.host === g.host && x.port === g.port)));
      put({ id: known?.id ?? id, name: known?.name ?? name, model: 'Google Cast Group', host: g.host, port: g.port }, x => x.id === (known?.id ?? id));
    }
    if (added || updated) await o.integrations.update('cast', { ...prev, endpoints });
    return {
      speakers: speakers.map(s => ({ name: s.name, model: s.model, host: s.host })),
      groups: groups.map(g => ({ host: g.host, port: g.port, speakers: g.members.map(m => byName.get(m) ?? m) })),
      added, updated,
      next: speakers.length ? `${speakers.length} Cast device${speakers.length === 1 ? '' : 's'} and ${groups.length} speaker group${groups.length === 1 ? '' : 's'}${added || updated ? ', saved' : ', nothing new'}.` : 'No Cast devices answered. Name the network they’re on (like 10.10.30.0/24) and try again.',
    };
  });

  app.post<{ Body: { subnet?: string } }>('/api/integrations/sonos/find', async (req, reply) => {
    if (!o.integrations) return bad(reply, 'Integration settings aren’t available', 503);
    let hosts: string[];
    try { hosts = await findTargets(req.body?.subnet); } catch (e) { return bad(reply, msg(e)); }
    const found = await findSonos(hosts);
    const prev = (o.integrations.raw('sonos') ?? {}) as { hosts?: string[] };
    const all = [...new Set([...(prev.hosts ?? []), ...found.map(f => f.host)])];
    const added = all.length - (prev.hosts ?? []).length;
    if (added) await o.integrations.update('sonos', { ...prev, hosts: all });
    return { speakers: found, added, next: found.length ? `${found.length} Sonos speaker${found.length === 1 ? '' : 's'}${added ? ', saved' : ', nothing new'}.` : 'No Sonos answered. Name the network they’re on (like 10.10.30.0/24) and try again.' };
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
