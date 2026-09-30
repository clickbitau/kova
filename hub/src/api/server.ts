import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import type { Hub } from '../hub.ts';
import type { Command } from '../model/types.ts';
import type { AskAction } from '../assistant/assistant.ts';
import { VirtualAdapter } from '../adapters/virtual.ts';
import { MatterAdapter } from '../adapters/matter.ts';
import { HomeKitControllerAdapter } from '../adapters/homekit-controller.ts';
import { snapshot } from './snapshot.ts';
import { registerEditRoutes } from './edit-routes.ts';
import { AiAssistant, loadSettings, publicSettings, saveSettings, type AiOptions, type SettingsPatch } from '../assistant/ai.ts';
import { isLight, isPlayer } from '../util/describe.ts';
import type { HomeKitBridge } from '../bridges/homekit.ts';
import type { MatterBridge } from '../bridges/matter-bridge.ts';
import { LiveViewUnavailable, NEST_DEFAULT_REDIRECT, exchangeNestCode, nestAuthUrl, type NestOptions } from '../adapters/nest.ts';
import type { Presence } from '../services/presence.ts';
import type { Notifier } from '../services/notify.ts';
import type { PushSubscription } from 'web-push';
import { importFromCloud, type CloudImportOptions } from '../adapters/tuya/cloud.ts';
import { loadIntegrations, saveIntegrations } from '../integrations.ts';

import { CATALOG } from '../integrations-catalog.ts';
import { SetupError, type IntegrationsManager } from '../integrations-store.ts';
import type { HaImport } from '../import/ha-scan.ts';
import { registerImportRoutes } from './import-routes.ts';
import type { Backups } from '../services/backup.ts';
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
  /** Nest settings from integrations.json, for the one-time account linking routes (no refresh token needed yet). */
  nest?: Partial<Pick<NestOptions, 'projectId' | 'clientId' | 'clientSecret' | 'tokenUrl'>>;
  /** Presence sources and per-person keys for phone automations. */
  presence?: Presence;
  /** Web Push / ntfy notifications. */
  notifier?: Notifier;
  /** Where integrations.json lives, for imports that write to it (e.g. Tuya cloud keys). */
  integrationsPath?: string;
  /** Tuya cloud import overrides (tests point baseUrl at a fake server and turn discovery off). */
  tuyaCloud?: Pick<CloudImportOptions, 'baseUrl' | 'discoverMs' | 'discoverPorts' | 'now'>;

  /** In-app setup of integrations.json. Without it the setup routes answer 503. */
  integrations?: IntegrationsManager;
  /** Import from Home Assistant (backup upload or config folder). */
  haImport?: HaImport;
  /** Nightly backups; when absent the backup endpoints answer 404. */
  backups?: Backups;
}

const USER = { kind: 'user' as const, label: 'You' };

const asBool = (v: unknown): boolean => typeof v === 'string' ? /^(1|true|yes|on|home|arrived?)$/i.test(v.trim()) : !!v;

function tokenOk(req: FastifyRequest, token: string): boolean {
  const h = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.query as Record<string, string>)?.token ?? '';
  const a = Buffer.from(h), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export async function buildServer(hub: Hub, opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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

  if (opts.token) {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/') && path !== '/api/health' && !tokenOk(req, opts.token!) && !personKeyOk(req)) return reply.code(401).send({ error: 'unauthorised' });
    });
  }

  // iOS Shortcuts' "Form" request body.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });

  // ---------------------------------------------------------------- read --
  app.get('/api/state', async () => snapshot(hub));

  // Loaded by the web app before it renders so the first paint has real data.
  app.get('/api/boot.js', async (_req, reply) => {
    reply.type('application/javascript').header('cache-control', 'no-store');
    return `window.KOVA_BOOT=${JSON.stringify(snapshot(hub)).replace(/</g, '\\u003c')};`;
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
  registerImportRoutes(app, opts.haImport);

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
  app.post<{ Body: { subscription?: PushSubscription; personId?: string } }>('/api/push/subscribe', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    const personId = req.body?.personId;
    if (personId && !hub.config.get().people.some(p => p.id === personId)) return reply.code(400).send({ error: 'unknown person' });
    try { opts.notifier.subscribe(req.body?.subscription as PushSubscription, personId); hub.emit('changed'); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return { ok: opts.notifier.unsubscribe(String(req.body?.endpoint ?? '')) };
  });
  app.post('/api/push/test', async (_req, reply) => {
    if (!opts.notifier) return reply.code(404).send({ error: 'notifications are not running' });
    return opts.notifier.notify({ title: 'Kova notifications work', body: 'This is how Kova will tell you about the doorbell and things left on.', tag: 'test' });
  });

  // Every light off (the "Turn them off" action on "Everyone's out").
  app.post('/api/lights/off', async () => {
    const ds = hub.reg.list().filter(d => isLight(d) && d.state.on);
    return hub.engine.applyMany(Object.fromEntries(ds.map(d => [d.id, { on: false }])), { ...USER, label: 'All lights off' });
  });

  app.post<{ Params: { id: string } }>('/api/undo/:id', async (req, reply) => {
    return (await hub.engine.undo(req.params.id)) ? { ok: true } : reply.code(410).send({ error: 'Too late to undo' });
  });

  // Assistant engine settings. Built-in is the default; AI engines only ever see requests the built-in parser can't handle.
  // API keys are write-only: GET reports hasKey, never the key. Cameras are never shared, whatever is sent.
  const ai = new AiAssistant(hub.engine, hub.reg, hub.config, hub.store, opts.ai);
  app.get('/api/assistant/settings', async () => publicSettings(loadSettings(hub.store)));
  app.put<{ Body: SettingsPatch }>('/api/assistant/settings', async (req, reply) => {
    try { return publicSettings(saveSettings(hub.store, req.body ?? {})); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Body: { text: string } }>('/api/ask', async req => {
    const text = String(req.body?.text ?? '');
    const r = await hub.assistant.ask(text);
    const settings = loadSettings(hub.store);
    // Only what the built-in parser couldn't handle goes to an AI engine.
    if (!r.understood && settings.engine !== 'builtin' && text.trim()) return ai.ask(text, settings);
    return r;
  });
  // What Kova understood, as chips, without running anything (for the live preview while typing).
  app.post<{ Body: { text: string } }>('/api/ask/parse', async req => {
    const i = hub.assistant.parse(String(req.body?.text ?? ''));
    return { understood: !!i, kind: i?.kind ?? null, chips: hub.assistant.chips(i) };
  });
  app.post<{ Body: { action: AskAction } }>('/api/ask/act', async req => hub.assistant.act(req.body.action));

  // ------------------------------------------------------------- backups --
  const noBackups = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(404).send({ error: 'Backups are not enabled' });
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
  const clients = new Set<{ send: (s: string) => void }>();
  let pending: NodeJS.Timeout | null = null;
  hub.on('changed', () => {
    if (pending || !clients.size) return;
    pending = setTimeout(() => {
      pending = null;
      const msg = JSON.stringify({ type: 'state', data: snapshot(hub) });
      for (const c of clients) c.send(msg);
    }, 80);
  });
  // Keep the UI's clock and "now" line moving even when nothing changes.
  const heartbeat = setInterval(() => { if (clients.size) hub.emit('changed'); }, 30_000);
  app.addHook('onClose', async () => clearInterval(heartbeat));

  app.get('/api/ws', { websocket: true }, socket => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'state', data: snapshot(hub) }));
    socket.on('close', () => clients.delete(socket));
  });

  return app;
}
