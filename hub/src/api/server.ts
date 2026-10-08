import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { Sessions, type Session } from '../services/sessions.ts';
import { Accounts } from '../services/accounts.ts';
import { AccessDenied, actors, actorKey, canDevice, currentActor, type Actor } from '../services/actor.ts';
import { HOUSEHOLD, NOTIFY_CHOICES, NOTIFY_KINDS } from '../services/notify-prefs.ts';
import { check, ruleFor } from './access.ts';
import { registerAccountRoutes } from './account-routes.ts';
import { viewFor } from './views.ts';
import type { Hub } from '../hub.ts';
import type { Cause, Command } from '../model/types.ts';
import type { AskAction, AskReply } from '../assistant/assistant.ts';
import { VirtualAdapter } from '../adapters/virtual.ts';
import { MatterAdapter } from '../adapters/matter.ts';
import { HomeKitControllerAdapter } from '../adapters/homekit-controller.ts';
import { snapshot } from './snapshot.ts';
import { registerEditRoutes } from './edit-routes.ts';
import { AiAssistant, loadSettings, publicSettings, saveSettings, requestLog, learnedPhrases, forgetPhrase, memoryList, forgetMemory, convoAdd, convoRecent, engineInfo, type AiOptions, type SettingsPatch } from '../assistant/ai.ts';
import { AskJobs, type AskJob } from '../assistant/ask-jobs.ts';
import { isLight, isPlayer } from '../util/describe.ts';
import type { HomeKitBridge } from '../bridges/homekit.ts';
import type { MatterBridge } from '../bridges/matter-bridge.ts';
import { LiveViewUnavailable, NEST_DEFAULT_REDIRECT, exchangeNestCode, nestAuthUrl, type NestOptions } from '../adapters/nest.ts';
import { connectLifeAuthUrl, exchangeConnectLifeCode } from '../adapters/connectlife.ts';
import { SMARTTHINGS_DEFAULT_REDIRECT, createSmartThingsApp, exchangeSmartThingsCode, smartThingsAuthUrl } from '../adapters/smartthings.ts';
import type { Presence } from '../services/presence.ts';
import type { HelixLink } from '../services/helix-link.ts';
import type { SnapLinks } from '../services/screen-notices.ts';
import type { Notifier } from '../services/notify.ts';
import type { PushSubscription } from 'web-push';
import { importFromCloud, isPrivateIp, mergeCloudDevices, type CloudImportOptions } from '../adapters/tuya/cloud.ts';
import { importFromSession, qrPoll, qrStart, type ConsumerSession } from '../adapters/tuya/consumer.ts';
import { discover } from '../adapters/tuya/discover.ts';
import QRCode from 'qrcode';
import { loadIntegrations, saveIntegrations } from '../integrations.ts';

import { CATALOG } from '../integrations-catalog.ts';
import { SetupError, type IntegrationsManager } from '../integrations-store.ts';
import type { HaImport } from '../import/ha-scan.ts';
import { registerImportRoutes } from './import-routes.ts';
import { registerHomeRoutes } from './home-routes.ts';
import { registerHelixCastRoutes } from './helix-cast-routes.ts';
import { registerAnnounceRoutes } from './announce-routes.ts';
import { registerPhotoRoutes } from './photo-routes.ts';
import { registerSecurityRoutes } from './security-routes.ts';
import { registerLanAppRoutes } from './lan-apps-routes.ts';
import { registerAppLinkRoutes } from './app-link.ts';
import { AppUpdates, registerAppUpdateRoutes } from './app-updates.ts';
import { registerJevRoutes } from './jev-routes.ts';
import type { Backups } from '../services/backup.ts';
import { JevAdvisor } from '../services/jev.ts';
import { KOVA_VERSION } from '../version.ts';
import { createReadStream } from 'node:fs';

export interface ServerOptions {
  webRoot: string;
  /** When set, every /api call needs `Authorization: Bearer <token>` (or ?token= for the WebSocket and boot script). */
  token?: string;
  /** The Apple Home bridge, when KOVA_HOMEKIT=1. */
  homekit?: HomeKitBridge;
  /** The Matter bridge (Google Home, Alexa, SmartThings, Apple Home), when KOVA_MATTER_BRIDGE=1. */
  matterBridge?: MatterBridge;
  /** Optional AI engine options, e.g. the Anthropic base URL (tests point it at a fake server). */
  ai?: AiOptions;
  /** TypeSafe/JEV structured decisions. Configured server-side; absent means the routes report unavailable. */
  jev?: JevAdvisor;
  /** Nest settings from integrations.json, for the one-time account linking routes (no refresh token needed yet). */
  nest?: Partial<Pick<NestOptions, 'projectId' | 'clientId' | 'clientSecret' | 'tokenUrl'>>;
  /** Presence sources and per-person keys for phone automations. */
  presence?: Presence;
  /** Helix's own token: it may switch the TVs its boxes sit on, and nothing else. */
  helixLink?: HelixLink;
  /** One-picture links for Helix's on-screen doorbell card. */
  snapLinks?: SnapLinks;
  /** Where the phone app's over-the-air bundles are (ota/<train>/<update>/). Absent: no app updates. */
  otaDir?: string;
  /** Web Push / ntfy notifications. */
  notifier?: Notifier;
  /** Where integrations.json lives, for imports that write to it (e.g. Tuya cloud keys). */
  integrationsPath?: string;
  /** Tuya cloud import overrides (tests point baseUrl at a fake server and turn discovery off). */
  tuyaCloud?: Pick<CloudImportOptions, 'baseUrl' | 'discoverMs' | 'discoverPorts' | 'now'>;
  /** The Smart Life QR-link service; defaults to Tuya's. Tests point it at a fake. */
  tuyaLink?: { base?: string; clientId?: string };

  /** In-app setup of integrations.json. Without it the setup routes answer 503. */
  integrations?: IntegrationsManager;
  /** Tests: where to look for Helix Server. */
  lanApps?: { helixFindHosts?: string[]; helixFindPort?: number; wardenPollMs?: number };
  /** Import from Home Assistant (backup upload or config folder). */
  haImport?: HaImport;
  /** Nightly backups; when absent the backup endpoints answer 404. */
  backups?: Backups;
  /** The hub's remote address for the phone app away from home (Tailscale or a reverse proxy). */
  remoteUrl?: () => string | null | undefined;
  /** The hub's stable ID; by default the one the updater keeps (hub-id). */
  hubId?: () => string | null | undefined;
}

const USER = { kind: 'user' as const, label: 'You' };

const asBool = (v: unknown): boolean => typeof v === 'string' ? /^(1|true|yes|on|home|arrived?)$/i.test(v.trim()) : !!v;

/** The key a request carries: `Authorization: Bearer …`, or ?token= (the WebSocket and the boot script). */
const keyOf = (req: FastifyRequest): string => req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.query as Record<string, string>)?.token ?? '';

function tokenOk(req: FastifyRequest, token: string): boolean {
  const h = keyOf(req);
  const a = Buffer.from(h), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

const apiRoutes = new WeakMap<FastifyInstance, string[]>();
/** The API routes a server registered ("POST /api/devices/:id"). */
export const routesOf = (app: FastifyInstance): string[] => apiRoutes.get(app) ?? [];

export async function buildServer(hub: Hub, opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Every API route as registered, so a test can hold each one to the access allow-list (api/access.ts).
  const routes: string[] = [];
  app.addHook('onRoute', r => { for (const m of [r.method].flat()) if (m !== 'HEAD' && r.url.startsWith('/api/')) routes.push(`${m} ${r.url}`); });
  apiRoutes.set(app, routes);
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: opts.webRoot, index: ['index.html'] });

  // For Docker / systemd health checks. Unauthenticated on purpose, so it says nothing about the home.
  const startedAt = Date.now();
  app.get('/api/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ok: true, version: KOVA_VERSION, uptimeS: Math.floor((Date.now() - startedAt) / 1000) };
  });

  // A phone automation may report its own person's presence with that person's key instead of the master token.
  const personKeyOk = (req: FastifyRequest): boolean => {
    const m = req.method === 'POST' && /^\/api\/people\/([^/?]+)\/presence(?:\?|$)/.exec(req.url);
    const key = (req.query as Record<string, string> | undefined)?.key;
    return !!m && !!opts.presence && opts.presence.checkKey(decodeURIComponent(m[1]), key);
  };

  // Helix Server calls back with the token Kova gave it (services/helix-link.ts): only its linked TVs (on and input) and soundbars.
  const fromHelix = new WeakSet<FastifyRequest>();
  const helixTokenOk = (req: FastifyRequest, path: string): boolean => {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    return !!opts.helixLink && !!given && opts.helixLink.isToken(given) && opts.helixLink.allows(req.method, path);
  };

  // Signed-in devices (services/sessions.ts) and the household's accounts (services/accounts.ts).
  const sessions = new Sessions(hub.store);
  const accounts = new Accounts(hub.store, hub.config, sessions, () => hub.engine.now());
  // Losing access takes everything: their phones' notifications and their presence key go too.
  accounts.onRevoke = personId => { opts.notifier?.forgetPerson(personId); opts.presence?.rotateKey(personId); hub.emit('changed'); };
  if (opts.notifier) {
    // A guest's phone hears only what's sent to them by name (never the doorbell's camera, or the network's news).
    opts.notifier.audience = (personId, n) => {
      if (personId && !hub.config.get().people.some(p => p.id === personId)) return false;
      const m = accounts.member(personId);
      if (!m) return true;
      if (accounts.expired(m)) return false;
      return m.role !== 'guest' || !!n.people?.includes(m.personId);
    };
  }
  const MASTER: Actor = { role: 'owner', name: 'Owner', via: 'master' };

  /**
   * Who a request is from: the master key (the owner), a signed-in device's key (its person and role), or, on a hub
   * with no master key set, the owner. `null`: no key, or one that no longer works.
   */
  const identify = (req: FastifyRequest): Actor | null | 'gone' => {
    const key = keyOf(req);
    if (opts.token && key && tokenOk(req, opts.token)) return MASTER;
    const s = key ? sessions.check(key) : null;
    if (s) return accounts.actorFor(s) ?? 'gone';
    return opts.token ? null : { role: 'owner', name: 'Owner', via: 'open' };
  };

  // The one place access is decided (api/access.ts has the allow-list): who it is, whether their role may call this
  // route, and whether the device, room or person it's about is theirs. Everything the request does after runs as
  // them (services/actor.ts), so the engine and Ask Kova check the same person.
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return done();
    const rule = ruleFor(req);
    if (rule.perm === 'public') return done();
    const who = identify(req);
    if (who === null || who === 'gone') {
      // Helix's own token, and a phone automation's presence key, are each good for their one thing.
      if (helixTokenOk(req, path)) { fromHelix.add(req); return done(); }
      if (personKeyOk(req)) return done();
      reply.code(401).send(who === 'gone' ? { error: 'This device was signed out of the home.', code: 'signed-out' } : { error: 'unauthorised' });
      return;
    }
    const params = (req.params ?? {}) as Record<string, string>;
    const no = check(rule, who, params, id => hub.reg.get(id));
    if (no) { reply.code(no.status).send({ error: no.error, code: 'forbidden' }); return; }
    actors.run(who, done);
  });
  if (opts.helixLink) {
    app.addHook('preHandler', async (req, reply) => {
      if (!fromHelix.has(req)) return;
      reply.header('cache-control', 'no-store');
      // Casting from Helix's apps has routes of its own (api/helix-cast-routes.ts).
      if (req.url.startsWith('/api/helix/')) return;
      if (req.method === 'GET') return reply.send(opts.helixLink!.state());
      // Helix's command (D98.11: one key, by its names) as Kova's, from its remote or, with X-Helix-Origin: auto, its own
      // switching. Answered within Helix's timeout; a slow one (a TV waking up) is accepted and finished in the background.
      const id = decodeURIComponent(/^\/api\/devices\/([^/]+)$/.exec(req.url.split('?')[0])?.[1] ?? '');
      const auto = String(req.headers['x-helix-origin'] ?? '').toLowerCase() === 'auto';
      const r = await opts.helixLink!.command(id, (req.body ?? {}) as Record<string, unknown>, auto);
      return reply.code(r.status).send(r.body);
    });
  }
  // A refusal from deeper in (the engine, Ask Kova's tools): 403 with its words.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AccessDenied) return reply.code(403).send({ error: err.message, code: 'forbidden' });
    return reply.send(err);
  });

  app.post<{ Body: { name?: string } | undefined }>('/api/login/start', async (req, reply) => { reply.header('cache-control', 'no-store'); return sessions.start(req.headers['user-agent'], req.body?.name); });
  app.get<{ Params: { id: string } }>('/api/login/poll/:id', async (req, reply) => { reply.header('cache-control', 'no-store'); return sessions.poll(req.params.id); });
  // Signing in another device of your own: the new key is yours (your person and role; the owner's for the master key).
  app.post<{ Body: { code?: string } }>('/api/login/approve', async (req, reply) => {
    const a = currentActor();
    const ok = sessions.approve(String(req.body?.code ?? ''), sessions.check(keyOf(req))?.name ?? 'Kova app', { personId: a?.personId });
    return ok ? { ok: true, name: ok.name } : reply.code(400).send({ error: 'That code isn’t right, or it has expired. Codes last 5 minutes.' });
  });
  // Signed-in devices: the owner sees every one (and whose it is); anyone else, their own.
  const mine = (a: Actor | undefined) => (x: Session) => (a?.personId ? x.personId === a.personId : !x.personId);
  app.get('/api/sessions', async req => {
    const a = currentActor();
    const people = hub.config.get().people;
    const all = a?.role === 'owner';
    return { sessions: sessions.list(keyOf(req), all ? undefined : mine(a)).map(x => ({ ...x, ...(all ? { personName: people.find(p => p.id === x.personId)?.name ?? null } : {}) })) };
  });
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const a = currentActor(), x = sessions.get(req.params.id);
    if (!x || (a?.role !== 'owner' && !mine(a)(x))) return reply.code(404).send({ error: 'No such session' });
    sessions.remove(x.id);
    return { ok: true };
  });
  // Sign this browser out (its own key stops working).
  app.post('/api/logout', async req => { const s = sessions.check(keyOf(req)); if (s) sessions.remove(s.id); return { ok: true, signedOut: !!s }; });

  registerAccountRoutes(app, hub, { accounts, sessions, presence: opts.presence, remoteUrl: () => (opts.remoteUrl ?? (() => opts.integrations?.raw('notify')?.publicUrl))(), port: () => { const a = app.server.address(); return typeof a === 'object' && a ? a.port : Number(process.env.KOVA_PORT ?? 8140); }, hubId: () => (opts.hubId ?? (() => hub.updates?.catalog.hubId()))() });

  // A phone app reporting its own crash: logged to the event store so a pattern can be found in Activity.
  app.post<{ Body: { message?: string; stack?: string; kind?: string; screen?: string; crumbs?: string[]; app?: string; platform?: string; at?: number } }>('/api/app/crash', async req => {
    const b = req.body ?? {};
    if (typeof b.message !== 'string' || !b.message) return { ok: false };
    hub.store.append({
      kind: 'system', device: null, feed: 'system',
      what: `App crashed${b.screen ? ` on ${b.screen}` : ''}${b.kind === 'fatal' ? ' (fatal)' : ''}`,
      data: { message: b.message.slice(0, 500), stack: typeof b.stack === 'string' ? b.stack.slice(0, 6000) : undefined, kind: b.kind, screen: b.screen, crumbs: Array.isArray(b.crumbs) ? b.crumbs.slice(-12) : undefined, app: b.app, platform: b.platform, at: b.at },
      cause: { kind: 'system', label: 'Kova app' },
    });
    return { ok: true };
  });

  // iOS Shortcuts' "Form" request body.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => reply.code(err instanceof AccessDenied ? 403 : 400).send({ error: err instanceof Error ? err.message : String(err) });

  const jev = opts.jev ?? new JevAdvisor({ store: hub.store });
  registerJevRoutes(app, hub, jev);

  // ---------------------------------------------------------------- read --
  // What each person sees is the home as their role allows (api/views.ts): a child or a guest only their rooms.
  const stateFor = (a: Actor | undefined) => viewFor(snapshot(hub), a, accounts);
  app.get('/api/state', async () => stateFor(currentActor()));

  // Loaded by the web app before it renders so the first paint has real data.
  app.get('/api/boot.js', async (_req, reply) => {
    reply.type('application/javascript').header('cache-control', 'no-store');
    return `window.KOVA_BOOT=${JSON.stringify(stateFor(currentActor())).replace(/</g, '\\u003c')};`;
  });

  // Pairing info for the Apple Home bridge (setup code + X-HM:// payload for a QR code).
  app.get('/api/integrations/homekit', async () => {
    const hk = opts.homekit;
    if (!hk) return { enabled: false };
    return { enabled: true, ...hk.setupInfo(), paired: hk.paired };
  });

  // HomeKit accessories Kova controls (the reverse of the bridge above): find them, then pair with the code on the label.
  const hkc = () => {
    const a = hub.reg.adapters.get('homekit');
    if (!(a instanceof HomeKitControllerAdapter)) throw new Error('HomeKit devices aren’t set up: add "homekit": {} to integrations.json');
    return a;
  };
  app.get('/api/integrations/homekit-devices/discover', async (_req, reply) => {
    try { return { accessories: await hkc().discover() }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { id?: string; code?: string; room?: string; name?: string } }>('/api/integrations/homekit-devices/pair', async (req, reply) => {
    try {
      const { id, code, room, name } = req.body ?? {};
      if (!id || !code) throw new Error('id and code are required');
      return { ok: true, devices: await hkc().pair(id, code, { room, name }) };
    } catch (e) { return fail(reply, e); }
  });

  // Pairing info for the Matter bridge (manual code, MT: payload for a QR code, and who it's paired with).
  app.get('/api/integrations/matter-bridge', async () => {
    const mb = opts.matterBridge;
    if (!mb) return { enabled: false };
    return { enabled: true, ...mb.pairingInfo() };
  });

  // Room ACs in voice assistants and other apps: which bridges publish them, their pairing codes (with a QR code to
  // scan), whether they're paired, and the room ACs each one shows.
  const qrOf = (text: string) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141517', light: '#f1efea' } });
  app.get('/api/room-climate/pairing', async () => {
    const mb = opts.matterBridge, hk = opts.homekit;
    const p = mb?.pairingInfo();
    return {
      matter: mb && p ? { enabled: true, running: mb.isRunning, manualCode: p.manualCode, qrSvg: p.qrCode ? await qrOf(p.qrCode) : null, commissioned: p.commissioned, fabrics: p.fabrics, roomAcs: mb.roomAcList() } : { enabled: false },
      homekit: hk ? { enabled: true, pincode: hk.setupInfo().pincode, qrSvg: await qrOf(hk.setupInfo().setupURI), paired: hk.paired, roomAcs: hk.roomAcList() } : { enabled: false },
    };
  });

  app.get<{ Querystring: { at?: string; hour?: string } }>('/api/preview', async req => {
    const s = snapshot(hub);
    let at = Number(req.query.at);
    if (!Number.isFinite(at)) {
      const hour = Number(req.query.hour);
      // A preview hour earlier than now means tonight's later part, e.g. 02:00 after midnight.
      at = s.home.now + (((hour - s.home.nowHour) + 24) % 24) * 3600_000;
    }
    return { at, modeId: hub.engine.planner.modeAt(at).mode.id, devices: hub.engine.preview(at) };
  });

  // --------------------------------------------------------------- write --
  app.post<{ Params: { id: string }; Body: Command }>('/api/devices/:id', async (req, reply) => {
    try { return { undo: await hub.engine.command(req.params.id, req.body ?? {}, USER) }; } catch (e) { return fail(reply, e); }
  });

  // Momentary events (camera saw a person, doorbell rang). Adapters use this path internally; webhooks can too.
  app.post<{ Params: { id: string }; Body: { type: string; data?: Record<string, unknown> } }>('/api/devices/:id/event', async (req, reply) => {
    if (!hub.reg.get(req.params.id)) return reply.code(404).send({ error: 'unknown device' });
    hub.reg.deviceEvent(req.params.id, req.body.type, req.body.data ?? {});
    return { ok: true };
  });

  // Demo only: simulate someone using a wall switch or another app.
  app.post<{ Params: { id: string }; Body: Command }>('/api/devices/:id/physical', async (req, reply) => {
    const v = hub.reg.adapters.get('virtual');
    if (!(v instanceof VirtualAdapter) || hub.reg.get(req.params.id)?.adapter !== 'virtual') return reply.code(400).send({ error: 'not a virtual device' });
    v.physical(req.params.id, req.body);
    return { ok: true };
  });

  // Camera live view over WebRTC: the browser's offer goes to the camera's adapter (e.g. Nest's cloud), its answer comes back.
  const NO_LIVE = 'Live view isn’t available for this camera yet';
  const liveFor = (id: string) => {
    const d = hub.reg.get(id);
    return { d, lv: d ? hub.reg.adapters.get(d.adapter)?.liveView : undefined };
  };
  const liveFail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) =>
    e instanceof LiveViewUnavailable ? reply.code(400).send({ error: NO_LIVE }) : reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
  app.post<{ Params: { id: string }; Body: { offerSdp?: string } }>('/api/devices/:id/webrtc', async (req, reply) => {
    const { d, lv } = liveFor(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    if (!lv) return reply.code(400).send({ error: NO_LIVE });
    if (!req.body?.offerSdp) return reply.code(400).send({ error: 'offerSdp is required' });
    try { return await lv.offer(d, req.body.offerSdp); } catch (e) { return liveFail(reply, e); }
  });
  // Live streams expire after a few minutes unless extended; stop ends one early.
  app.post<{ Params: { id: string; op: string }; Body: { mediaSessionId?: string } }>('/api/devices/:id/webrtc/:op', async (req, reply) => {
    const { d, lv } = liveFor(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown device' });
    if (!lv) return reply.code(400).send({ error: NO_LIVE });
    const sid = String(req.body?.mediaSessionId ?? '');
    if (!sid) return reply.code(400).send({ error: 'mediaSessionId is required' });
    try {
      if (req.params.op === 'extend') return await lv.extend(d, sid);
      if (req.params.op === 'stop') { await lv.stop(d, sid); return { ok: true }; }
      return reply.code(404).send({ error: 'unknown operation' });
    } catch (e) { return liveFail(reply, e); }
  });
  app.get<{ Params: { key: string } }>('/api/snap/:key', async (req, reply) => {
    const s = opts.snapLinks?.get(req.params.key);
    if (!s) return reply.code(404).send({ error: 'No such picture' });
    return reply.type(s.contentType).header('cache-control', 'no-store').send(s.body);
  });
  app.get<{ Params: { id: string } }>('/api/devices/:id/snapshot', async (req, reply) => {
    const d = hub.reg.get(req.params.id);
    const a = d && hub.reg.adapters.get(d.adapter);
    if (!d || !a?.snapshot) return reply.code(404).send({ error: 'no snapshot for this device' });
    try {
      const s = await a.snapshot(d);
      return reply.type(s.contentType).header('cache-control', 'no-store').send(s.body);
    } catch (e) { return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) }); }
  });

  // Linking a Google account for Nest, once: open auth-url, approve, copy the code from the address bar, post it to auth-code.
  // Settings saved in the app win over the ones the hub started with.
  const nestCfg = () => opts.integrations?.raw('nest') ?? opts.nest;
  app.get<{ Querystring: { redirectUri?: string; projectId?: string; clientId?: string } }>('/api/integrations/nest/auth-url', async (req, reply) => {
    const n = nestCfg();
    const projectId = req.query.projectId || n?.projectId, clientId = req.query.clientId || n?.clientId;
    if (!projectId || !clientId) return reply.code(400).send({ error: 'Set nest.projectId and nest.clientId in integrations.json first (or pass ?projectId=&clientId=)' });
    const redirectUri = req.query.redirectUri || NEST_DEFAULT_REDIRECT;
    return { url: nestAuthUrl({ projectId, clientId, redirectUri }), redirectUri };
  });
  app.post<{ Body: { code?: string; redirectUri?: string; clientId?: string; clientSecret?: string } }>('/api/integrations/nest/auth-code', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    const n = nestCfg();
    const clientId = req.body?.clientId || n?.clientId, clientSecret = req.body?.clientSecret || n?.clientSecret;
    if (!code) return reply.code(400).send({ error: 'code is required' });
    if (!clientId || !clientSecret) return reply.code(400).send({ error: 'Set nest.clientId and nest.clientSecret in integrations.json first' });
    try {
      const r = await exchangeNestCode({ code, clientId, clientSecret, redirectUri: req.body?.redirectUri, tokenUrl: n?.tokenUrl });
      reply.header('cache-control', 'no-store');
      // Set up in the app: save the token straight away (it never goes back to the browser) and start Nest.
      const saved = opts.integrations?.raw('nest');
      if (opts.integrations && saved) {
        const applied = await opts.integrations.update('nest', { ...saved, refreshToken: r.refreshToken });
        return { ok: true, linked: true, status: applied.status };
      }
      return { refreshToken: r.refreshToken, scope: r.scope, next: 'Save this as nest.refreshToken in integrations.json and restart Kova' };
    } catch (e) { return fail(reply, e); }
  });

  // Linking SmartThings (Samsung soundbars), once: open auth-url, allow Kova, copy the code from the address bar, post it to auth-code.
  const stCfg = () => opts.integrations?.raw('smartthings');
  // Or, before that, without the SmartThings CLI: a one-time personal access token makes Kova's own app on the
  // owner's account. The token isn't kept; the app's client id and secret are, and the answer is the Allow page.
  app.post<{ Body: { token?: string; redirectUri?: string } }>('/api/integrations/smartthings/create-app', async (req, reply) => {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: 'Paste a SmartThings token (account.smartthings.com/tokens)' });
    if (!opts.integrations) return reply.code(503).send({ error: 'Integration settings aren’t available' });
    const redirectUri = req.body?.redirectUri || SMARTTHINGS_DEFAULT_REDIRECT;
    try {
      const made = await createSmartThingsApp({ token, redirectUri, apiUrl: stCfg()?.apiUrl });
      const { token: _old, refreshToken: _gone, ...rest } = stCfg() ?? {};
      await opts.integrations.update('smartthings', { ...rest, clientId: made.clientId, clientSecret: made.clientSecret });
      reply.header('cache-control', 'no-store');
      return { ok: true, url: smartThingsAuthUrl({ clientId: made.clientId, redirectUri }), redirectUri, next: 'Allow Kova on that page, then copy the code from the address bar (?code=…) into Finish linking.' };
    } catch (e) { return fail(reply, e); }
  });
  app.get<{ Querystring: { redirectUri?: string } }>('/api/integrations/smartthings/auth-url', async (req, reply) => {
    const c = stCfg();
    if (!c?.clientId) return reply.code(400).send({ error: 'Save the SmartThings app’s client id and secret first' });
    const redirectUri = req.query.redirectUri || SMARTTHINGS_DEFAULT_REDIRECT;
    return { url: smartThingsAuthUrl({ clientId: c.clientId, redirectUri }), redirectUri };
  });
  app.post<{ Body: { code?: string; redirectUri?: string } }>('/api/integrations/smartthings/auth-code', async (req, reply) => {
    // The whole redirect address pasted is fine too: take its code.
    const raw = String(req.body?.code ?? '').trim();
    const code = /[?&]code=([^&#\s]+)/.exec(raw)?.[1] ?? raw;
    const c = stCfg();
    if (!code) return reply.code(400).send({ error: 'code is required' });
    if (!c?.clientId || !c.clientSecret) return reply.code(400).send({ error: 'Save the SmartThings app’s client id and secret first' });
    try {
      const r = await exchangeSmartThingsCode({ code: decodeURIComponent(code), clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: req.body?.redirectUri, tokenUrl: c.tokenUrl });
      reply.header('cache-control', 'no-store');
      const applied = await opts.integrations!.update('smartthings', { ...c, refreshToken: r.refreshToken });
      return { ok: true, linked: true, status: applied.status };
    } catch (e) { return fail(reply, e); }
  });

  // Linking ConnectLife (Hisense air conditioners), once: sign in at auth-url; the page after won't load, and its address
  // (…?code=…) is posted to auth-code.
  app.get('/api/integrations/connectlife/auth-url', async () => ({ url: connectLifeAuthUrl(opts.integrations?.raw('connectlife')?.urls) }));
  app.post<{ Body: { code?: string } }>('/api/integrations/connectlife/auth-code', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    if (!code) return reply.code(400).send({ error: 'Paste the address the sign-in ended on (it has ?code=…)' });
    if (!opts.integrations) return reply.code(400).send({ error: 'Integrations can’t be changed here' });
    const c = opts.integrations.raw('connectlife') ?? {};
    try {
      const r = await exchangeConnectLifeCode(code, c.urls);
      reply.header('cache-control', 'no-store');
      const applied = await opts.integrations.update('connectlife', { ...c, refreshToken: r.refreshToken });
      return { ok: true, linked: true, status: applied.status };
    } catch (e) { return fail(reply, e); }
  });

  // Samsung TVs: ask again for Kova to be allowed (the TV shows its Allow prompt when it's set to ask).
  app.post('/api/integrations/samsungtv/pair', async (_req, reply) => {
    const tv = hub.reg.adapters.get('samsungtv') as { pairAgain?: () => Promise<{ name: string; ok: boolean; message: string }[]> } | undefined;
    if (!tv?.pairAgain) return reply.code(400).send({ error: 'Set up a Samsung TV first' });
    const tvs = await tv.pairAgain();
    hub.emit('changed');
    return { tvs, ok: tvs.every(t => t.ok), next: tvs.map(t => t.message).join(' ') };
  });

  // Add a Matter device with its pairing code (for one already in Google Home / Apple Home, open a pairing window there first).
  app.post<{ Body: { code?: string; room?: string; name?: string } }>('/api/integrations/matter/commission', async (req, reply) => {
    const m = hub.reg.adapters.get('matter');
    if (!(m instanceof MatterAdapter)) return reply.code(400).send({ error: 'Matter is off: add Matter devices in Integrations (or set KOVA_MATTER=1)' });
    const code = String(req.body?.code ?? '').trim();
    if (!code) return reply.code(400).send({ error: 'code is required' });
    try {
      const devices = await m.commission(code, { room: req.body?.room || undefined, name: req.body?.name || undefined });
      return { ok: true, devices: devices.map(d => hub.reg.get(d.id) ?? d) };
    } catch (e) { return fail(reply, e); }
  });

  // Fetch Tuya local keys (and names, categories, data points) from the Tuya IoT cloud once, and merge them
  // into integrations.json. Keys are written to the file but never returned. With in-app setup, Tuya restarts right away.
  app.post<{ Body: { clientId?: string; secret?: string; region?: string; uid?: string } }>('/api/integrations/tuya/cloud-import', async (req, reply) => {
    const b = req.body ?? {};
    const clientId = String(b.clientId ?? '').trim(), secret = String(b.secret ?? '').trim();
    if (!clientId || !secret) return reply.code(400).send({ error: 'clientId and secret are required' });
    if (!opts.integrationsPath) return reply.code(400).send({ error: 'This hub has no integrations file configured' });
    try {
      const current = loadIntegrations(opts.integrationsPath) ?? {};
      const r = await importFromCloud({ clientId, secret, region: b.region || 'eu', uid: b.uid || undefined, existing: current.tuya, rooms: hub.config.get().rooms, ...opts.tuyaCloud });
      // Through in-app setup when it's running, so its copy of the file stays current and Tuya restarts live.
      if (opts.integrations) {
        const applied = await opts.integrations.update('tuya', r.tuya);
        return { ok: true, devices: r.devices, restartNeeded: applied.restartRequired };
      }
      saveIntegrations(opts.integrationsPath, { ...current, tuya: r.tuya });
      return { ok: true, devices: r.devices, restartNeeded: true };
    } catch (e) { return fail(reply, e); }
  });

  // Linking Smart Life with a QR, the way the Home Assistant integration does: the hub shows a code, the app
  // scans it, Tuya hands the hub a session, and the session lists every device with its local key. One pairing
  // at a time; the POST shows the code and the hub itself polls Tuya every few seconds until scanned or lapsed
  // (~4.5 min) — the import must not depend on a page staying open. The GET just reports where it got to.
  type TuyaPair = { qr: string; userCode: string; at: number; status: 'pending' | 'working' | 'approved' | 'expired' | 'failed'; devices?: unknown; restartNeeded?: boolean; error?: string; timer?: NodeJS.Timeout };
  let tuyaPair: TuyaPair | null = null;

  const finishTuyaPair = async (pair: TuyaPair): Promise<void> => {
    if (tuyaPair !== pair || pair.status !== 'pending') return;
    if (Date.now() - pair.at > 270_000) { pair.status = 'expired'; pair.error = 'The code lapsed. Show a new one.'; if (pair.timer) clearInterval(pair.timer); return; }
    const hit = await qrPoll(pair.qr, pair.userCode, opts.tuyaLink?.clientId, opts.tuyaLink?.base).catch(() => null);
    if (!hit) return;
    pair.status = 'working';
    if (pair.timer) clearInterval(pair.timer);
    if (!opts.integrationsPath) { pair.status = 'failed'; pair.error = 'This hub has no integrations file configured'; return; }
    try {
      const current = loadIntegrations(opts.integrationsPath) ?? {};
      const { session, devices } = await importFromSession(hit.session, {
        existing: current.tuya, rooms: hub.config.get().rooms,
        log: line => console.log('[tuya]', line),
      });
      // LAN addresses for the devices that need one, like the cloud import does.
      const known = new Map((current.tuya?.devices ?? []).map(d => [d.id, d.host]));
      const needIp = devices.filter(d => !d.sub && !known.get(d.id) && !isPrivateIp(d.ip)).map(d => d.id);
      let found = new Map<string, import('../adapters/tuya/discover.ts').Discovered>();
      if (needIp.length || devices.length) found = await discover({ durationMs: opts.tuyaCloud?.discoverMs ?? 6000, ports: opts.tuyaCloud?.discoverPorts, want: needIp.length ? devices.filter(d => !d.sub).map(d => d.id) : undefined });
      const merged = mergeCloudDevices(current.tuya, devices, { rooms: hub.config.get().rooms, found });
      const section = { ...merged.tuya, session };
      if (opts.integrations) {
        const applied = await opts.integrations.update('tuya', section);
        pair.restartNeeded = applied.restartRequired;
      } else {
        saveIntegrations(opts.integrationsPath, { ...current, tuya: section });
        pair.restartNeeded = true;
      }
      pair.status = 'approved';
      pair.devices = merged.devices;
      hub.store.append({ kind: 'system', device: null, feed: 'system', what: `Smart Life linked: ${merged.devices.length} device${merged.devices.length === 1 ? '' : 's'} joined Kova`, data: { devices: merged.devices.map((d: { id: string }) => d.id) }, cause: { kind: 'system', label: 'Tuya' } });
    } catch (e) {
      pair.status = 'failed';
      pair.error = e instanceof Error ? e.message : String(e);
    }
  };

  app.post<{ Body: { userCode?: string } }>('/api/integrations/tuya/qr-pair', async (req, reply) => {
    const userCode = String(req.body?.userCode ?? '').trim();
    if (!userCode) return reply.code(400).send({ error: 'Your Smart Life user code is needed (Me → Settings → Account and Security → User Code)' });
    if (tuyaPair?.timer) clearInterval(tuyaPair.timer);
    try {
      const qr = await qrStart(userCode, opts.tuyaLink?.clientId, opts.tuyaLink?.base);
      const pair: TuyaPair = { qr, userCode, at: Date.now(), status: 'pending' };
      tuyaPair = pair;
      pair.timer = setInterval(() => void finishTuyaPair(pair), 3000);
      pair.timer.unref?.();
      const qrSvg = await QRCode.toString(`tuyaSmart--qrLogin?token=${qr}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141517', light: '#f1efea' } });
      return { code: qr, qrSvg, next: 'Scan this in the Smart Life app (Profile → + → Scan). It lapses in about five minutes.' };
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/integrations/tuya/qr-pair', async () => {
    const pair = tuyaPair;
    if (!pair) return { status: 'expired', error: 'No link is under way — show a code first.' };
    if (pair.status === 'pending') await finishTuyaPair(pair); // a watching client still gets an immediate answer
    if (pair.status === 'approved') return { status: 'approved', ok: true, devices: pair.devices, restartNeeded: pair.restartNeeded };
    return { status: pair.status === 'working' ? 'pending' : pair.status, ...(pair.error ? { error: pair.error } : {}) };
  });

  // In-app setup. Secrets never leave the hub: GET shows "••••", and sending "••••" back keeps the stored value.
  app.get('/api/integrations/catalog', async () => CATALOG);
  const setup = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: (m: IntegrationsManager) => Promise<T>) => {
    if (!opts.integrations) return reply.code(503).send({ error: 'In-app setup isn’t available on this hub' });
    try { return await fn(opts.integrations); } catch (e) { return reply.code(e instanceof SetupError ? e.statusCode : 400).send({ error: e instanceof Error ? e.message : String(e) }); }
  };
  app.get('/api/integrations/config', async (_req, reply) => setup(reply, async m => m.publicConfig()));
  app.put<{ Params: { section: string }; Body: unknown }>('/api/integrations/config/:section', async (req, reply) => setup(reply, m => m.update(req.params.section, req.body ?? {})));
  app.delete<{ Params: { section: string } }>('/api/integrations/config/:section', async (req, reply) => setup(reply, m => m.update(req.params.section, null)));
  // Try settings before saving them: `config` is the unsaved section (with "••••" for unchanged secrets), or omit it to test what's stored.
  app.post<{ Params: { id: string }; Body: { config?: unknown } }>('/api/integrations/:id/test', async (req, reply) => setup(reply, m => m.test(req.params.id, req.body?.config)));

  app.post<{ Params: { id: string }; Body: { what?: 'lights' | 'all' } }>('/api/rooms/:id/off', async req => {
    const room = hub.config.get().rooms.find(r => r.id === req.params.id);
    const ds = hub.reg.list().filter(d => d.room === req.params.id && (isLight(d) || (req.body?.what === 'all' && isPlayer(d))));
    return hub.engine.applyMany(Object.fromEntries(ds.map(d => [d.id, isPlayer(d) ? { on: false, media: null } : { on: false }])), { ...USER, label: `${room?.name ?? 'Room'} lights off` });
  });

  app.post<{ Params: { id: string } }>('/api/overlays/:id/start', async (req, reply) => {
    try { return { undo: await hub.engine.startOverlay(req.params.id, USER) }; } catch (e) { return fail(reply, e); }
  });
  app.post('/api/overlays/end', async () => { await hub.engine.endOverlay('user'); return { ok: true }; });

  app.post<{ Body: { id: string; skip: boolean } }>('/api/plan/skip', async req => {
    hub.engine.setSkip(req.body.id, req.body.skip);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/findings/:id/fix', async (req, reply) => {
    try { return { undo: hub.engine.registerUndo(hub.checker.fix(req.params.id)) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/findings/:id/dismiss', async req => ({ undo: hub.engine.registerUndo(hub.checker.dismiss(req.params.id)) }));
  // Learned suggestions: "Not now" (back in a week), and "Suggest again" from What Kova has learned.
  app.post<{ Params: { id: string } }>('/api/findings/:id/snooze', async req => ({ undo: hub.engine.registerUndo(hub.checker.snooze(req.params.id)) }));
  app.post<{ Params: { id: string } }>('/api/findings/:id/restore', async req => ({ undo: hub.engine.registerUndo(hub.checker.restore(req.params.id)) }));
  // "Why do you suggest this?": the suggestion and the days it's based on, in words.
  app.get<{ Params: { id: string } }>('/api/findings/:id/why', async (req, reply) => {
    const text = hub.checker.learner.explain(req.params.id);
    return text ? { text } : reply.code(404).send({ error: 'That suggestion no longer applies' });
  });

  app.patch<{ Params: { id: string }; Body: { lightTheWay?: boolean; onlyWhenSomeoneHome?: boolean } }>('/api/modes/:id', async (req, reply) => {
    if (!hub.config.get().modes.some(m => m.id === req.params.id)) return reply.code(404).send({ error: 'unknown mode' });
    const undo = hub.config.update(c => {
      const m = c.modes.find(x => x.id === req.params.id)!;
      if (req.body.lightTheWay !== undefined) m.lightTheWay = req.body.lightTheWay;
      if (req.body.onlyWhenSomeoneHome !== undefined) m.onlyWhenSomeoneHome = req.body.onlyWhenSomeoneHome;
    });
    return { undo: hub.engine.registerUndo(undo) };
  });

  registerEditRoutes(app, hub);
  registerImportRoutes(app, opts.haImport, hub);
  registerHomeRoutes(app, hub);
  registerHelixCastRoutes(app, hub);
  registerPhotoRoutes(app, hub);
  registerAnnounceRoutes(app, hub, () => { const a = app.server.address(); return typeof a === 'object' && a ? a.port : Number(process.env.KOVA_PORT ?? 8140); });
  registerSecurityRoutes(app, hub);
  registerLanAppRoutes(app, { integrations: opts.integrations, helixLink: opts.helixLink, ...opts.lanApps });
  if (opts.otaDir) registerAppUpdateRoutes(app, new AppUpdates(opts.otaDir));
  registerAppLinkRoutes(app, {
    token: opts.token,
    port: () => { const a = app.server.address(); return typeof a === 'object' && a ? a.port : Number(process.env.KOVA_PORT ?? 8140); },
    remoteUrl: opts.remoteUrl ?? (() => opts.integrations?.raw('notify')?.publicUrl),
    hubId: opts.hubId ?? (() => hub.updates?.catalog.hubId()),
  });

  // Presence from a phone: the Kova app, or an iOS Shortcut / Android automation ("When I arrive home → Get contents of URL").
  // `home` can be in the body or the query (?home=1), so a Shortcut needs no request body. `?key=` is the person's own key.
  app.post<{ Params: { id: string }; Body: { home?: boolean | string; source?: string } | undefined; Querystring: { key?: string; home?: string; source?: string } }>('/api/people/:id/presence', async (req, reply) => {
    const { id } = req.params;
    if (req.query.key !== undefined && !opts.presence?.checkKey(id, req.query.key)) return reply.code(401).send({ error: 'wrong key for this person' });
    const home = asBool(req.body?.home ?? req.query.home);
    const source = req.body?.source ?? req.query.source;
    try {
      if (opts.presence) await opts.presence.report(id, home, source || undefined);
      else await hub.engine.setPresence(id, home, source);
      return { ok: true, home };
    } catch (e) { return fail(reply, e); }
  });

  // Per-person URLs (with keys) for iOS Shortcuts / Android automations. Needs the master token when KOVA_TOKEN is set.
  app.get('/api/presence/setup', async (req, reply) => {
    if (!opts.presence) return reply.code(404).send({ error: 'presence is not running' });
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    return opts.presence.setup(`${proto}://${host}`);
  });

  // ------------------------------------------------------ notifications --
  app.get('/api/push/vapid', async (_req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return { publicKey: opts.notifier.vapid.publicKey };
  });
  // Whose phone this is: a member's own key says who they are, and only the owner may register a phone for someone else.
  const pushPerson = (asked: string | undefined): string | undefined | Error => {
    const a = currentActor();
    if (a?.personId && asked && asked !== a.personId && a.role !== 'owner') return new AccessDenied('You can only get notifications on your own phone.');
    return asked || a?.personId;
  };
  app.post<{ Body: { subscription?: PushSubscription; personId?: string } }>('/api/push/subscribe', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    const personId = pushPerson(req.body?.personId);
    if (personId instanceof Error) return fail(reply, personId);
    if (personId && !hub.config.get().people.some(p => p.id === personId)) return reply.code(400).send({ error: 'unknown person' });
    try { opts.notifier.subscribe(req.body?.subscription as PushSubscription, personId); hub.emit('changed'); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return { ok: opts.notifier.unsubscribe(String(req.body?.endpoint ?? '')) };
  });
  // The Kova phone app: its Expo push token, and who the phone belongs to.
  app.post<{ Body: { token?: string; personId?: string; name?: string; platform?: string } }>('/api/push/app', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    const personId = pushPerson(req.body?.personId);
    if (personId instanceof Error) return fail(reply, personId);
    if (personId && !hub.config.get().people.some(p => p.id === personId)) return reply.code(400).send({ error: 'unknown person' });
    try { opts.notifier.registerApp(String(req.body?.token ?? ''), { personId, name: req.body?.name, platform: req.body?.platform }); hub.emit('changed'); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Body: { token?: string } }>('/api/push/app', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return { ok: opts.notifier.unregisterApp(String(req.body?.token ?? '')) };
  });
  // What I hear about, and how often (services/notify-prefs.ts); the owner also sets the household's (phones of no one
  // in particular, ntfy, and anyone who hasn't chosen).
  const prefsView = () => {
    const a = currentActor(), n = opts.notifier!;
    const owner = !a || a.role === 'owner';
    const who = a?.personId;
    return {
      who: who ?? null, name: who ? hub.config.get().people.find(p => p.id === who)?.name ?? who : 'This home',
      kinds: NOTIFY_KINDS, choices: NOTIFY_CHOICES, prefs: n.prefs.of(who), offForAll: n.householdOff(),
      ...(owner && who ? { household: n.prefs.of(HOUSEHOLD) } : {}), canHousehold: owner,
    };
  };
  app.get('/api/notify/prefs', async (_req, reply) => opts.notifier ? prefsView() : reply.code(404).send({ error: 'notifications are not running' }));
  app.put<{ Body: { kind?: string; value?: unknown; household?: boolean } }>('/api/notify/prefs', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    const a = currentActor();
    const house = !!req.body?.household || !a?.personId;
    if (house && a && a.role !== 'owner') return fail(reply, new AccessDenied('Only the owner chooses for the whole home'));
    try { opts.notifier.prefs.set(house ? HOUSEHOLD : a!.personId, String(req.body?.kind ?? ''), req.body?.value); } catch (e) { return fail(reply, e); }
    return prefsView();
  });
  app.post('/api/push/test', async (_req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return opts.notifier.notify({ title: 'Kova notifications work', body: 'This is how Kova will tell you about the doorbell and things left on.', tag: 'test' });
  });

  // Every light off (the "Turn them off" action on "Everyone's out").
  app.post('/api/lights/off', async () => {
    // Every light the person asking may use (a child: the lights in their rooms).
    const a = currentActor();
    const ds = hub.reg.list().filter(d => isLight(d) && d.state.on && canDevice(a, d));
    return hub.engine.applyMany(Object.fromEntries(ds.map(d => [d.id, { on: false }])), { ...USER, label: 'All lights off' });
  });

  app.post<{ Params: { id: string } }>('/api/undo/:id', async (req, reply) => {
    return (await hub.engine.undo(req.params.id)) ? { ok: true } : reply.code(410).send({ error: 'Too late to undo' });
  });

  // Assistant engine settings. Built-in is the default; AI engines only ever see requests the built-in parser can't handle.
  // API keys are write-only: GET reports hasKey, never the key. Cameras are never shared, whatever is sent.
  const ai = new AiAssistant(hub.engine, hub.reg, hub.config, hub.store, { ...opts.ai, jev });
  ai.music = () => hub.music?.cached() ?? [];
  ai.findMusic = words => hub.music ? hub.music.find(words) : Promise.resolve(null);
  ai.clips = () => hub.clips.all();
  ai.clipName = id => hub.clips.get(id)?.name;
  ai.mediaProblem = m => hub.mediaProblem(m);
  app.get('/api/assistant/settings', async () => publicSettings(loadSettings(hub.store)));
  app.put<{ Body: SettingsPatch }>('/api/assistant/settings', async (req, reply) => {
    try { const out = publicSettings(saveSettings(hub.store, req.body ?? {})); hub.emit('changed'); return out; } catch (e) { return fail(reply, e); }
  });

  // What the AI has been asked (full text + tools it ran), and the phrases it learned — the raw material for new built-in intents.
  app.get('/api/assistant/requests', async () => requestLog(hub.store));
  app.get('/api/assistant/learned', async () => learnedPhrases(hub.store));
  app.delete<{ Params: { key: string } }>('/api/assistant/learned/:key', async (req, reply) =>
    forgetPhrase(hub.store, decodeURIComponent(req.params.key)) ? { ok: true } : reply.code(404).send({ error: 'No such phrase' }));
  // Facts the user asked the AI to remember.
  app.get('/api/assistant/memory', async () => ({ memory: memoryList(hub.store) }));
  app.delete<{ Params: { i: string } }>('/api/assistant/memory/:i', async (req, reply) =>
    forgetMemory(hub.store, Number(req.params.i)) ? { ok: true } : reply.code(404).send({ error: 'No such memory' }));

  // POST /api/ask { text }: the built-in parser answers at once. What goes on to an AI engine can take a minute or
  // more, so a client that sends `job: true` gets { job } straight away and follows it (GET /api/ask/jobs/:id, see
  // assistant/ask-jobs.ts); without it the request waits for the answer, as older apps expect.
  const jobs = new AskJobs();
  app.addHook('onClose', async () => jobs.close());
  const jobView = (j: AskJob) => ({ id: j.id, text: j.text, status: j.status, engine: j.engine, steps: j.steps, started: j.started, rev: j.rev, ...(j.finished ? { finished: j.finished } : {}), ...(j.reply ? { reply: j.reply } : {}) });
  const remember = (text: string, out: AskReply, asked: number, job?: string) => {
    // Keep the exchange so follow-ups — "yes", "the second one", "do it" — still land, and a phone that was away
    // finds the answer (GET /api/ask/history).
    const who = actorKey(currentActor());
    convoAdd(hub.store, 'user', text, { ts: asked, job, who });
    convoAdd(hub.store, 'assistant', out.text, { job, source: out.source, engine: out.engine, undo: out.undo, failed: out.understood === false && out.engine !== 'builtin' ? true : undefined, who });
  };
  app.post<{ Body: { text: string; job?: boolean } }>('/api/ask', async req => {
    const text = String(req.body?.text ?? '');
    const asked = Date.now();
    const r = await hub.assistant.ask(text);
    const settings = loadSettings(hub.store);
    if (!r.understood && settings.engine === 'builtin' && text.trim()) ai.logRequest('builtin', text, r.text, [], false); // parser gap: remember it
    // Only what the built-in parser couldn't handle goes to an AI engine.
    if (r.understood || settings.engine === 'builtin' || !text.trim()) {
      const out: AskReply = { ...r, engine: r.engine ?? 'builtin' };
      if (text.trim()) remember(text, out, asked);
      return out;
    }
    if (req.body?.job === true) {
      const info = engineInfo(settings);
      const job = jobs.start(text, { kind: info.kind, label: info.label }, progress => ai.ask(text, settings, undefined, { onSteps: progress }), j => { if (j.reply) remember(text, j.reply, asked, j.id); }, actorKey(currentActor()));
      return { job: jobView(job) };
    }
    const out = await ai.ask(text, settings);
    remember(text, out, asked);
    return out;
  });
  // Follow a job: comes back as soon as it changes past `rev` (a step, the answer), or after `wait` seconds (≤ 25).
  app.get<{ Params: { id: string }; Querystring: { rev?: string; wait?: string } }>('/api/ask/jobs/:id', async (req, reply) => {
    const rev = Number(req.query.rev ?? 0) || 0;
    const wait = Math.max(0, Math.min(25, Number(req.query.wait ?? 0) || 0)) * 1000;
    const j = await jobs.wait(req.params.id, rev, wait);
    if (j && (j.who ?? 'owner') !== actorKey(currentActor())) return reply.code(404).send({ error: 'No such request', code: 'job-gone' });
    if (!j) return reply.code(404).send({ error: 'The hub restarted before it finished that request. Some of it may have been done — check, then ask again.', code: 'job-gone' });
    return jobView(j);
  });
  // The conversation so far (8 hours), with each reply's source and undo, and anything still being worked on.
  app.get('/api/ask/history', async () => { const who = actorKey(currentActor()); return { turns: convoRecent(hub.store, who), jobs: jobs.running(who).map(jobView), engine: engineInfo(loadSettings(hub.store)) }; });
  // What Kova understood, as chips, without running anything (for the live preview while typing).
  app.post<{ Body: { text: string } }>('/api/ask/parse', async req => {
    const i = hub.assistant.parse(String(req.body?.text ?? ''));
    return { understood: !!i, kind: i?.kind ?? null, chips: hub.assistant.chips(i) };
  });
  app.post<{ Body: { action: AskAction } }>('/api/ask/act', async (req, reply) => { try { return await hub.assistant.act(req.body.action); } catch (e) { return fail(reply, e); } });

  // ------------------------------------------------------------- backups --
  const noBackups = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(404).send({ error: 'Backups are not enabled' });
  // Updating the hub itself (services/updates.ts): what's available, check now, update now, overnight updates.
  const noUpdater = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(404).send({ error: 'Updates aren’t set up on this hub' });
  app.get('/api/update', async (_req, reply) => hub.updates ? hub.updates.status() : noUpdater(reply));
  app.post('/api/update/check', async (_req, reply) => { if (!hub.updates) return noUpdater(reply); try { return hub.updates.request('check'); } catch (e) { return fail(reply, e); } });
  app.post('/api/update/apply', async (_req, reply) => { if (!hub.updates) return noUpdater(reply); try { return hub.updates.request('apply'); } catch (e) { return fail(reply, e); } });
  // The licence key ClickBit's release catalog wants (the key itself never comes back out).
  app.put<{ Body: { key?: string } }>('/api/update/licence', async (req, reply) => {
    if (!hub.updates) return noUpdater(reply);
    try { return await hub.updates.setLicence(String(req.body?.key ?? '')); } catch (e) { return fail(reply, e); }
  });
  app.delete('/api/update/licence', async (_req, reply) => hub.updates ? hub.updates.forgetLicence() : noUpdater(reply));
  app.put<{ Body: { on?: boolean; hour?: number } }>('/api/update/settings', async (req, reply) => {
    if (!hub.updates) return noUpdater(reply);
    try { return { auto: hub.updates.setAuto(req.body ?? {}) }; } catch (e) { return fail(reply, e); }
  });

  app.get('/api/backups', async (_req, reply) => {
    const b = opts.backups;
    if (!b) return noBackups(reply);
    return { keep: b.keep, nextAt: b.nextAt, ...b.status(), backups: b.list() };
  });
  app.post('/api/backups', async (_req, reply) => {
    const b = opts.backups;
    if (!b) return noBackups(reply);
    try { return { ok: true, backup: await b.run('manual') }; } catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) }); }
  });
  // A backup holds device keys and account passwords: downloading one always needs the API token,
  // or, when no token is set, a request from this machine.
  app.get<{ Params: { name: string } }>('/api/backups/:name', async (req, reply) => {
    const b = opts.backups;
    if (!b) return noBackups(reply);
    if (!opts.token && !isLoopback(req.ip)) return reply.code(403).send({ error: 'Set KOVA_TOKEN to download backups over the network' });
    const file = b.file(req.params.name);
    if (!file) return reply.code(404).send({ error: 'No such backup' });
    reply.header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${req.params.name}"`)
      .header('cache-control', 'no-store');
    return reply.send(createReadStream(file));
  });

  // ------------------------------------------------------------ realtime --
  const clients = new Set<WebSocket>();
  let pending: NodeJS.Timeout | null = null;
  // Who each socket is: each one hears the home as its person may see it.
  const socketActor = new WeakMap<WebSocket, Actor | undefined>();
  hub.on('changed', () => {
    if (pending || !clients.size) return;
    pending = setTimeout(() => {
      pending = null;
      const snap = snapshot(hub);
      const msgs = new Map<string, string>();
      for (const c of clients) {
        const a = socketActor.get(c);
        // A device signed out (or a member removed) since it connected: its socket closes.
        if (a?.sessionId && !stillIn(a)) { clients.delete(c); try { c.close(4001, 'signed out'); } catch { /* gone */ } continue; }
        const k = viewKey(a);
        if (!msgs.has(k)) msgs.set(k, JSON.stringify({ type: 'state', data: viewFor(snap, a, accounts) }));
        c.send(msgs.get(k)!);
      }
    }, 80);
  });
  const stillIn = (a: Actor) => { const s = sessions.get(a.sessionId!); const now = s && accounts.actorFor(s); return !!now && now.role === a.role && JSON.stringify(now.rooms) === JSON.stringify(a.rooms) && JSON.stringify(now.devices) === JSON.stringify(a.devices); };
  const viewKey = (a: Actor | undefined) => a ? `${a.role}|${a.personId ?? ''}` : '';
  // Keep the UI's clock and "now" line moving even when nothing changes. This is also the socket's heartbeat: a
  // client hears from the hub at least every 30 s, so one that hasn't for longer knows its socket is dead (the
  // phone app reconnects then, see mobile/src/logic/link.ts).
  const heartbeat = setInterval(() => { if (clients.size) hub.emit('changed'); }, 30_000);
  // And the other way: a phone that went to sleep or off the network never says goodbye. A client that hasn't
  // answered the last ping is dropped, so the hub stops building snapshots for it.
  const alive = new WeakMap<WebSocket, boolean>();
  const pinger = setInterval(() => {
    for (const c of clients) {
      if (alive.get(c) === false) { clients.delete(c); c.terminate(); continue; }
      alive.set(c, false);
      try { c.ping(); } catch { /* closing anyway */ }
    }
  }, 30_000);
  app.addHook('onClose', async () => { clearInterval(heartbeat); clearInterval(pinger); });

  app.get('/api/ws', { websocket: true }, socket => {
    const a = currentActor();
    clients.add(socket);
    socketActor.set(socket, a);
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.send(JSON.stringify({ type: 'state', data: stateFor(a) }));
    socket.on('close', () => clients.delete(socket));
  });

  return app;
}
