import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { Hub } from '../hub.ts';
import type { Accounts, Member } from '../services/accounts.ts';
import { AccountError } from '../services/accounts.ts';
import type { Sessions } from '../services/sessions.ts';
import type { Presence } from '../services/presence.ts';
import { ROLE_LABEL, currentActor } from '../services/actor.ts';
import { slug } from '../tools/import-ha.ts';
import { connectAddresses, helloId, lanBase } from './app-link.ts';
import { meOf } from './views.ts';

// Household accounts over the API (services/accounts.ts): who I am, the owner's list of members with their devices,
// inviting someone (a link and a QR with a one-time code), and accepting an invite on the new device. Who may call
// each route is in api/access.ts.

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };
const fail = (reply: Reply, e: unknown) => reply.code(e instanceof AccountError ? e.statusCode : 400).send({ error: e instanceof Error ? e.message : String(e) });

export interface AccountRouteOptions {
  accounts: Accounts;
  sessions: Sessions;
  presence?: Presence;
  port: () => number;
  remoteUrl: () => string | null | undefined;
  hubId: () => string | null | undefined;
}

/** The invite link: the join page at the address the owner is using, with the code after # (never sent to a server log). */
export function inviteLinks(base: string, code: string, more: { hub?: string | null; alt?: string[] } = {}): { link: string; appLink: string } {
  const q = new URLSearchParams({ code });
  if (more.hub) q.set('hub', more.hub);
  for (const a of more.alt ?? []) if (a !== base) q.append('alt', a);
  const app = new URLSearchParams({ url: base, code });
  if (more.hub) app.set('hub', more.hub);
  for (const a of more.alt ?? []) if (a !== base) app.append('alt', a);
  return { link: `${base.replace(/\/+$/, '')}/join.html#${q}`, appLink: `kova://join?${app}` };
}

export function registerAccountRoutes(app: FastifyInstance, hub: Hub, o: AccountRouteOptions): void {
  const { accounts, sessions } = o;
  const people = () => hub.config.get().people;
  const baseOf = (req: FastifyRequest) => {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    return `${proto}://${host}`;
  };
  const hello = () => { try { const h = o.hubId(); return h ? helloId(h) : null; } catch { return null; } };

  const memberView = (m: Member) => {
    const p = people().find(x => x.id === m.personId);
    const devices = sessions.list(undefined, s => s.personId === m.personId);
    return {
      ...m, name: p?.name ?? m.personId, roleLabel: ROLE_LABEL[m.role], expired: accounts.expired(m),
      lastSeen: devices.reduce<number | null>((t, s) => (t == null || s.lastSeen > t ? s.lastSeen : t), null),
      sessions: devices,
    };
  };

  // ------------------------------------------------------------------ me --
  app.get('/api/me', async req => {
    const a = currentActor();
    const me = meOf(a, accounts);
    const presence = a?.personId && o.presence ? o.presence.urlsFor(a.personId, baseOf(req)) : null;
    return { me, presence };
  });

  // Their own room ("turn off my room"), for a member.
  app.patch<{ Body: { room?: string | null } }>('/api/me', async (req, reply) => {
    const a = currentActor();
    if (!a?.personId) return reply.code(400).send({ error: 'This device isn’t signed in as one of the home’s people' });
    try { const m = accounts.update(a.personId, { room: req.body?.room ?? null }); hub.emit('changed'); return { ok: true, room: m.room ?? null }; } catch (e) { return fail(reply, e); }
  });

  // The owner, signed in with the master key (or a key from before accounts), says which person they are: the
  // person becomes an owner member, and this device gets (or becomes) a key of theirs.
  app.post<{ Body: { personId?: string; name?: string } }>('/api/me/claim', async (req, reply) => {
    const a = currentActor();
    if (a?.personId) return reply.code(400).send({ error: 'This device is already signed in as one of the home’s people' });
    const personId = String(req.body?.personId ?? '');
    try {
      // A signed-in browser's key becomes the person's; the master key stays as it is, and the device gets a new key.
      const r = accounts.claim(personId, req.body?.name ?? 'Kova app', a?.sessionId);
      hub.emit('changed');
      if (!r.token) return { ok: true, personId, role: r.member.role };
      hub.emit('changed');
      reply.header('cache-control', 'no-store');
      return { ok: true, personId, role: r.member.role, token: r.token };
    } catch (e) { return fail(reply, e); }
  });

  // ------------------------------------------------------------- members --
  app.get('/api/members', async () => {
    const members = accounts.members();
    const ids = new Set(members.map(m => m.personId));
    return {
      members: members.map(memberView),
      // People who live here without an account (presence only), to invite.
      others: people().filter(p => !ids.has(p.id)).map(p => ({ personId: p.id, name: p.name })),
      invites: accounts.invites(),
      // Keys that are the owner's without being a person's: from before accounts.
      ownerKeys: sessions.list(undefined, s => !s.personId),
      roles: Object.entries(ROLE_LABEL).map(([id, label]) => ({ id, label })),
    };
  });

  app.put<{ Params: { id: string }; Body: { role?: string; rooms?: string[]; devices?: string[]; until?: number | null; room?: string | null } }>('/api/members/:id', async (req, reply) => {
    const a = currentActor();
    if (a?.personId === req.params.id && req.body?.role !== undefined && req.body.role !== 'owner') return reply.code(400).send({ error: 'You can’t change your own role. Another owner can.' });
    try { const m = accounts.update(req.params.id, req.body ?? {}); hub.emit('changed'); return { ok: true, member: memberView(m) }; } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { id: string } }>('/api/members/:id', async (req, reply) => {
    if (currentActor()?.personId === req.params.id) return reply.code(400).send({ error: 'You can’t remove yourself. Another owner can, or sign this device out.' });
    try {
      const r = accounts.remove(req.params.id);
      const name = people().find(p => p.id === req.params.id)?.name ?? req.params.id;
      hub.store.append({ kind: 'system', device: null, feed: 'system', what: `${name} was removed from the home’s accounts`, data: { person: req.params.id, signedOut: r.signedOut }, cause: { kind: 'user', label: 'You', by: { id: currentActor()?.personId, name: currentActor()?.name ?? 'Owner' } } });
      return { ok: true, ...r };
    } catch (e) { return fail(reply, e); }
  });

  // ------------------------------------------------------------- invites --
  const made = async (req: FastifyRequest, r: { invite: ReturnType<Accounts['invites']>[number]; code: string }) => {
    const base = lanBase(req, o.port());
    const addresses = connectAddresses(req, o.port(), (() => { try { return o.remoteUrl() ?? null; } catch { return null; } })());
    const { link, appLink } = inviteLinks(base, r.code, { hub: hello(), alt: addresses.map(x => x.url) });
    const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141517', light: '#f1efea' } });
    return { invite: r.invite, code: r.code, link, appLink, qrSvg, addresses };
  };

  app.post<{ Body: { role?: string; personId?: string; name?: string; rooms?: string[]; devices?: string[]; until?: number | null } }>('/api/invites', async (req, reply) => {
    try {
      const r = accounts.invite(req.body ?? {}, currentActor()?.name ?? 'Owner');
      reply.header('cache-control', 'no-store');
      return await made(req, r);
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/invites/:id/resend', async (req, reply) => {
    try { reply.header('cache-control', 'no-store'); return await made(req, accounts.resend(req.params.id)); } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/api/invites/:id', async (req, reply) => (accounts.cancel(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'No such invite' })));

  // ---- on the invited device (no key yet): what the invite is for, then accepting it. Wrong codes are rate-limited.
  app.post<{ Body: { code?: string } }>('/api/invite/peek', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try { return accounts.peek(req.body?.code, req.ip); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { code?: string; personId?: string; name?: string; device?: string } }>('/api/invite/accept', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const r = accounts.accept(req.body?.code, req.body ?? {}, req.ip, name => {
        const list = people();
        let id = slug(name) || 'person', n = 2;
        while (list.some(p => p.id === id)) id = `${slug(name) || 'person'}_${n++}`;
        hub.engine.people[id] ??= { home: true, since: hub.engine.now() };
        hub.config.update(c => { c.people.push({ id, name, detail: 'Phone' }); });
        return id;
      });
      hub.store.append({ kind: 'system', device: null, feed: 'people', what: `${r.name} joined the home as ${ROLE_LABEL[r.role].toLowerCase()}`, data: { person: r.personId, role: r.role, device: r.session.name }, cause: { kind: 'system', label: 'Invite', by: { id: r.personId, name: r.name } } });
      hub.emit('changed');
      return { ok: true, token: r.token, personId: r.personId, name: r.name, role: r.role, roleLabel: ROLE_LABEL[r.role], hubId: hello() };
    } catch (e) { return fail(reply, e); }
  });
}
