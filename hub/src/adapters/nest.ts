import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterStatus, LiveView, Snapshot } from './sdk.ts';
import type { Command, Device } from '../model/types.ts';

// Google Nest cameras and doorbells through Google's Smart Device Management
// (SDM) API. These devices have no local API: everything goes through Google's
// cloud, so this adapter needs the internet and a linked Google account
// (a Device Access project, an OAuth client, and a refresh token).
//
// * Devices come from GET /v1/enterprises/{project}/devices.
// * Events (person seen, doorbell pressed, motion) arrive on a Cloud Pub/Sub
//   subscription, which this adapter pulls over the Pub/Sub REST API and acks.
//   They become Kova device events, which is what drives Light the way.
// * Live view: SDM's CameraLiveStream.GenerateWebRtcStream turns a browser's
//   WebRTC offer into an answer; the video then flows between Google and the browser.

export const NEST_URLS = {
  token: 'https://oauth2.googleapis.com/token',
  sdm: 'https://smartdevicemanagement.googleapis.com',
  pubsub: 'https://pubsub.googleapis.com',
  auth: 'https://nestservices.google.com',
} as const;

export const NEST_SCOPES = ['https://www.googleapis.com/auth/sdm.service', 'https://www.googleapis.com/auth/pubsub'];
/** The redirect URI Google's Device Access guide uses for the copy-the-code-from-the-address-bar flow. */
export const NEST_DEFAULT_REDIRECT = 'https://www.google.com';

/** SDM event → Kova event type. */
export const NEST_EVENTS: Record<string, string> = {
  'sdm.devices.events.CameraPerson.Person': 'person',
  'sdm.devices.events.CameraMotion.Motion': 'motion',
  'sdm.devices.events.DoorbellChime.Chime': 'ring',
  'sdm.devices.events.CameraSound.Sound': 'sound',
};

const T = {
  info: 'sdm.devices.traits.Info',
  connectivity: 'sdm.devices.traits.Connectivity',
  live: 'sdm.devices.traits.CameraLiveStream',
  image: 'sdm.devices.traits.CameraEventImage',
};
const CAMERA_TYPES: Record<string, string> = {
  'sdm.devices.types.DOORBELL': 'Doorbell',
  'sdm.devices.types.CAMERA': 'Camera',
  'sdm.devices.types.DISPLAY': 'Display',
};

/** Events older than this when they arrive (a backlog after an outage) aren't acted on. */
const MAX_EVENT_AGE_MS = 2 * 60_000;

export interface NestOptions {
  /** Device Access project id (a UUID from console.nest.google.com/device-access). */
  projectId: string;
  /** OAuth client (Google Cloud console, type "Web application"). */
  clientId: string;
  clientSecret: string;
  /** From the one-time linking flow (see docs/architecture.md). */
  refreshToken: string;
  /** Pub/Sub subscription for events: projects/<gcp-project>/subscriptions/<name>. Without it, no events. */
  subscription?: string;
  /** Room per device. Keyed by the SDM device name (enterprises/…/devices/…), its last segment, or its display name. */
  rooms?: Record<string, string>;
  /** Kova id per device, keyed the same way, e.g. to keep "doorbell" so Light the way triggers still match. */
  ids?: Record<string, string>;
  /** How often to refresh the device list. Default 10 min; 0 = only at start. */
  pollMs?: number;
  /** Tests: base URLs, clock and timings. */
  tokenUrl?: string;
  sdmUrl?: string;
  pubsubUrl?: string;
  now?: () => number;
  timeoutMs?: number;
  /** How long one Pub/Sub pull may wait for messages. */
  pullTimeoutMs?: number;
  /** Pause after an empty pull, and the first retry delay after an error (doubles up to 5 min). */
  idleMs?: number;
  retryMs?: number;
  /** Where the last event image per camera is kept (Google deletes them ~30 s after the event, so they're grabbed as events arrive). */
  storageDir?: string;
}

export class NestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Thrown for a camera that can't stream to a browser (e.g. RTSP-only models). */
export class LiveViewUnavailable extends Error {
  constructor() { super('Live view isn’t available for this camera yet'); }
}

// ------------------------------------------------------------------ OAuth --

interface TokenResponse { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string }

async function tokenRequest(url: string, form: Record<string, string>, timeoutMs = 10_000): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST', body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const j = await res.json().catch(() => ({})) as TokenResponse;
  if (!res.ok || j.error) throw new NestError(`Google sign-in failed: ${j.error_description ?? j.error ?? `HTTP ${res.status}`}`, res.status);
  return j;
}

/** Access tokens from a refresh token, cached until a minute before they expire. */
export class GoogleAuth {
  private token = '';
  private expires = 0;
  private inflight: Promise<string> | null = null;
  refreshes = 0;

  constructor(private o: { clientId: string; clientSecret: string; refreshToken: string; tokenUrl?: string; now?: () => number; timeoutMs?: number }) {}

  private now() { return (this.o.now ?? Date.now)(); }

  invalidate(): void { this.token = ''; this.expires = 0; }

  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.expires - 60_000) return this.token;
    this.inflight ??= (async () => {
      try {
        if (!this.o.clientId || !this.o.clientSecret) throw new NestError('Add the OAuth client id and secret (nest.clientId, nest.clientSecret)', 0);
        const j = await tokenRequest(this.o.tokenUrl ?? NEST_URLS.token, {
          grant_type: 'refresh_token', refresh_token: this.o.refreshToken, client_id: this.o.clientId, client_secret: this.o.clientSecret,
        }, this.o.timeoutMs);
        if (!j.access_token) throw new NestError('Google sign-in returned no access token', 0);
        this.refreshes++;
        this.token = j.access_token;
        this.expires = this.now() + (j.expires_in ?? 3600) * 1000;
        return this.token;
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }
}

/** The page where the account owner picks which Nest devices Kova may see. */
export function nestAuthUrl(o: { projectId: string; clientId: string; redirectUri?: string; authBase?: string }): string {
  const q = new URLSearchParams({
    redirect_uri: o.redirectUri || NEST_DEFAULT_REDIRECT, access_type: 'offline', prompt: 'consent',
    client_id: o.clientId, response_type: 'code', scope: NEST_SCOPES.join(' '),
  });
  return `${o.authBase ?? NEST_URLS.auth}/partnerconnections/${encodeURIComponent(o.projectId)}/auth?${q}`;
}

/** Swap the one-time code from the linking page for a refresh token. */
export async function exchangeNestCode(o: { code: string; clientId: string; clientSecret: string; redirectUri?: string; tokenUrl?: string }): Promise<{ refreshToken: string; scope?: string }> {
  const j = await tokenRequest(o.tokenUrl ?? NEST_URLS.token, {
    grant_type: 'authorization_code', code: o.code, client_id: o.clientId, client_secret: o.clientSecret,
    redirect_uri: o.redirectUri || NEST_DEFAULT_REDIRECT,
  });
  if (!j.refresh_token) throw new NestError('Google returned no refresh token. Remove Kova’s access at myaccount.google.com/permissions and link again (the consent screen must be shown).', 0);
  return { refreshToken: j.refresh_token, scope: j.scope };
}

// -------------------------------------------------------------- SDM types --

export interface SdmDevice {
  name: string;
  type: string;
  traits?: Record<string, Record<string, unknown>>;
  parentRelations?: { parent: string; displayName?: string }[];
}

interface SdmMessage {
  eventId?: string;
  timestamp?: string;
  resourceUpdate?: {
    name?: string;
    events?: Record<string, { eventId?: string; eventSessionId?: string }>;
    traits?: Record<string, Record<string, unknown>>;
  };
  eventThreadId?: string;
  eventThreadState?: string;
}

interface Camera {
  id: string;
  dev: SdmDevice;
  label: string;
  lastEvent?: { eventId: string; type: string; at: number };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function isCamera(d: SdmDevice): boolean {
  if (!CAMERA_TYPES[d.type]) return false;
  // A display only counts when it has a camera (Nest Hub Max).
  return d.type !== 'sdm.devices.types.DISPLAY' || !!d.traits?.[T.live] || Object.keys(d.traits ?? {}).some(t => t.startsWith('sdm.devices.traits.Camera'));
}

export function webRtcCapable(d: SdmDevice): boolean {
  const p = d.traits?.[T.live]?.supportedProtocols;
  return Array.isArray(p) && p.includes('WEB_RTC');
}

function onlineOf(traits?: Record<string, Record<string, unknown>>): boolean | undefined {
  const s = traits?.[T.connectivity]?.status;
  return typeof s === 'string' ? s === 'ONLINE' : undefined;
}

// ---------------------------------------------------------------- adapter --

export class NestAdapter implements Adapter {
  id = 'nest';
  name = 'Google Nest';
  icon = 'videocam';
  kind = 'Cloud' as const;
  readonly auth: GoogleAuth;
  private ctx?: AdapterContext;
  private cams = new Map<string, Camera>();
  private byId = new Map<string, Camera>();
  private seen = new Set<string>();
  private error: string | null = null;
  private eventsError: string | null = null;
  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private poller: NodeJS.Timeout | null = null;
  readonly liveView: LiveView;

  constructor(private opts: NestOptions) {
    this.auth = new GoogleAuth(opts);
    this.liveView = {
      supports: d => { const c = this.cams.get(d.address) ?? this.byId.get(d.id); return !!c && webRtcCapable(c.dev); },
      offer: (d, offerSdp) => this.webRtcOffer(d, offerSdp),
      extend: (d, mediaSessionId) => this.webRtcExtend(d, mediaSessionId),
      stop: (d, mediaSessionId) => this.webRtcStop(d, mediaSessionId),
    };
  }

  private now() { return (this.opts.now ?? Date.now)(); }
  private get sdmBase() { return `${this.opts.sdmUrl ?? NEST_URLS.sdm}/v1`; }
  private get pubsubBase() { return `${this.opts.pubsubUrl ?? NEST_URLS.pubsub}/v1`; }

  /** An authenticated Google API call. On a 401, get a fresh token and retry once. */
  /** A Google API call, given up after `timeoutMs` (default opts.timeoutMs); a Pub/Sub pull passes its own, longer wait. */
  private async api<T>(url: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.opts.timeoutMs ?? 15_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken();
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 && attempt === 0) { this.auth.invalidate(); continue; }
      const j = await res.json().catch(() => ({})) as T & { error?: { message?: string; status?: string } };
      if (!res.ok) throw new NestError(`Google API ${res.status}: ${j.error?.message ?? j.error?.status ?? res.statusText}`, res.status);
      return j;
    }
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.running = true;
    await this.refreshDevices();
    const every = this.opts.pollMs ?? 600_000;
    if (every > 0) this.poller = setInterval(() => void this.refreshDevices(), every);
    if (this.opts.subscription) this.loop = this.pullLoop();
    else ctx.log('No Pub/Sub subscription configured: camera and doorbell events won’t reach Kova');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.abort.abort();
    await this.loop?.catch(() => {});
  }

  // --------------------------------------------------------------- devices --

  /** Look a device up in the ids/rooms options by its SDM name, id, or display names. */
  private pick(map: Record<string, string> | undefined, keys: string[]): string | undefined {
    if (!map) return undefined;
    for (const k of keys) if (k && map[k] != null) return map[k];
    const wanted = new Set(keys.filter(Boolean).map(norm));
    for (const [k, v] of Object.entries(map)) if (wanted.has(norm(k))) return v;
    return undefined;
  }

  async refreshDevices(): Promise<void> {
    const ctx = this.ctx!;
    let list: SdmDevice[];
    try {
      list = (await this.api<{ devices?: SdmDevice[] }>(`${this.sdmBase}/enterprises/${encodeURIComponent(this.opts.projectId)}/devices`)).devices ?? [];
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      ctx.log(this.error);
      return;
    }
    for (const dev of list.filter(isCamera)) {
      const known = this.cams.get(dev.name);
      if (known) { known.dev = dev; }
      else {
        const label = CAMERA_TYPES[dev.type];
        const custom = String(dev.traits?.[T.info]?.customName ?? '').trim();
        const where = dev.parentRelations?.[0]?.displayName?.trim() ?? '';
        const devId = dev.name.split('/').pop() ?? dev.name;
        const name = custom || where || label;
        const keys = [dev.name, devId, custom, where, where && `${where} ${label}`];
        const id = this.pick(this.opts.ids, keys) ?? `nest_${devId.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const room = this.pick(this.opts.rooms, keys) ?? (where ? norm(where) : 'unassigned');
        const cam: Camera = { id, dev, label };
        this.cams.set(dev.name, cam);
        this.byId.set(id, cam);
        ctx.announce([{ id, name, room, type: 'camera', integration: `Google Nest ${label}`, address: dev.name, capabilities: ['events'], state: { online: true } }]);
      }
      const online = onlineOf(dev.traits);
      ctx.report(this.cams.get(dev.name)!.id, { online: online ?? true });
    }
  }

  // ---------------------------------------------------------------- events --

  private async pullLoop(): Promise<void> {
    const base = this.opts.retryMs ?? 2000;
    let backoff = 0;
    while (this.running) {
      try {
        // No device list yet (e.g. offline at start): events can't be matched to cameras without it.
        if (this.error) await this.refreshDevices();
        const n = await this.pullOnce();
        backoff = 0;
        this.eventsError = null;
        if (n === 0 && (this.opts.idleMs ?? 250) > 0) await sleep(this.opts.idleMs ?? 250, undefined, { signal: this.abort.signal });
      } catch (err) {
        if (!this.running) break;
        backoff = Math.min(Math.max(base, backoff * 2), 300_000);
        const msg = `Nest events: ${(err as Error).message}`;
        if (msg !== this.eventsError) this.ctx?.log(msg);
        this.eventsError = msg;
        await sleep(backoff, undefined, { signal: this.abort.signal }).catch(() => {});
      }
    }
  }

  /** Pull one batch from the subscription, turn it into Kova events, and ack it. Returns how many messages came. */
  async pullOnce(): Promise<number> {
    const sub = this.opts.subscription!;
    // Pub/Sub holds an empty pull open until a message comes or its own wait ends; the normal 15 s API timeout
    // would cut every quiet pull short and report "aborted due to timeout".
    const r = await this.api<{ receivedMessages?: { ackId: string; message?: { data?: string; messageId?: string; publishTime?: string } }[] }>(
      `${this.pubsubBase}/${sub}:pull`, { maxMessages: 20 }, this.abort.signal, this.opts.pullTimeoutMs ?? 100_000);
    const msgs = r.receivedMessages ?? [];
    if (!msgs.length) return 0;
    for (const m of msgs) {
      try {
        const data = JSON.parse(Buffer.from(m.message?.data ?? '', 'base64').toString('utf8')) as SdmMessage;
        this.handle(data, m.message?.publishTime);
      } catch (err) { this.ctx?.log(`Unreadable Nest message ${m.message?.messageId ?? ''}: ${(err as Error).message}`); }
    }
    // Ack everything, including messages we ignored, so Pub/Sub doesn't send them again.
    await this.api(`${this.pubsubBase}/${sub}:acknowledge`, { ackIds: msgs.map(m => m.ackId) }, this.abort.signal);
    return msgs.length;
  }

  /** Remember an id; false if it was already seen. Keeps the last few thousand. */
  private firstTime(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  /** One SDM message (already base64-decoded). */
  handle(msg: SdmMessage, publishTime?: string): void {
    const ru = msg.resourceUpdate;
    const cam = ru?.name ? this.cams.get(ru.name) : undefined;
    if (!ru || !cam) return;
    const online = onlineOf(ru.traits);
    if (online !== undefined) this.ctx?.report(cam.id, { online });
    if (!ru.events) return;
    const ts = Date.parse(msg.timestamp ?? publishTime ?? '');
    if (Number.isFinite(ts) && this.now() - ts > MAX_EVENT_AGE_MS) return;
    for (const [sdmType, ev] of Object.entries(ru.events)) {
      const type = NEST_EVENTS[sdmType];
      if (!type) continue;
      const eventId = ev.eventId ?? msg.eventId ?? '';
      // Newer cameras send a thread of updates for one event session: act on each event once.
      if (eventId && !this.firstTime(`e:${eventId}`)) continue;
      if (ev.eventSessionId && !this.firstTime(`s:${ev.eventSessionId}:${type}`)) continue;
      if (eventId) {
        cam.lastEvent = { eventId, type, at: Number.isFinite(ts) ? ts : this.now() };
        // The image only exists for ~30 s after the event — grab it now so the card thumbnail outlives it.
        this.cacheEventImage(cam).catch(() => {});
      }
      this.ctx?.event(cam.id, type, { eventId, eventSessionId: ev.eventSessionId ?? null, timestamp: msg.timestamp ?? publishTime ?? null, source: 'nest' });
    }
  }

  // ------------------------------------------------------------- live view --

  private camFor(d: Device): Camera {
    const c = this.cams.get(d.address) ?? this.byId.get(d.id);
    if (!c) throw new Error(`Unknown Nest device ${d.id}`);
    return c;
  }

  private async execute<T>(c: Camera, command: string, params: Record<string, unknown>): Promise<T> {
    const r = await this.api<{ results?: T }>(`${this.sdmBase}/${c.dev.name}:executeCommand`, { command, params });
    return (r.results ?? {}) as T;
  }

  private async webRtcOffer(d: Device, offerSdp: string) {
    const c = this.camFor(d);
    if (!webRtcCapable(c.dev)) throw new LiveViewUnavailable();
    if (!offerSdp) throw new Error('offerSdp is required');
    const r = await this.execute<{ answerSdp?: string; mediaSessionId?: string; expiresAt?: string }>(c, 'sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream', { offerSdp });
    if (!r.answerSdp) throw new Error('Google returned no WebRTC answer');
    return { answerSdp: r.answerSdp, mediaSessionId: r.mediaSessionId ?? '', expiresAt: r.expiresAt ?? '' };
  }

  private async webRtcExtend(d: Device, mediaSessionId: string) {
    const r = await this.execute<{ mediaSessionId?: string; expiresAt?: string }>(this.camFor(d), 'sdm.devices.commands.CameraLiveStream.ExtendWebRtcStream', { mediaSessionId });
    return { mediaSessionId: r.mediaSessionId ?? mediaSessionId, expiresAt: r.expiresAt ?? '' };
  }

  private async webRtcStop(d: Device, mediaSessionId: string): Promise<void> {
    await this.execute(this.camFor(d), 'sdm.devices.commands.CameraLiveStream.StopWebRtcStream', { mediaSessionId });
  }

  private thumbPath(c: Camera): string | null { return this.opts.storageDir ? join(this.opts.storageDir, `${c.id}.jpg`) : null; }

  /** Downloads the current event's image; writes it to storageDir when set. */
  private async fetchEventImage(c: Camera): Promise<Buffer | null> {
    if (!c.dev.traits?.[T.image] || !c.lastEvent) return null;
    const r = await this.execute<{ url?: string; token?: string }>(c, 'sdm.devices.commands.CameraEventImage.GenerateImage', { eventId: c.lastEvent.eventId });
    if (!r.url || !r.token) return null;
    const res = await fetch(`${r.url}${r.url.includes('?') ? '&' : '?'}width=640`, { headers: { authorization: `Basic ${r.token}` }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    const p = this.thumbPath(c);
    if (p) { await mkdir(this.opts.storageDir!, { recursive: true }); await writeFile(p, body); }
    return body;
  }

  /** Caches the newest event image in the background — only the latest event's image is ever kept per camera. */
  private async cacheEventImage(c: Camera): Promise<void> {
    if (!this.opts.storageDir) return;
    try { await this.fetchEventImage(c); } catch { /* best-effort: the thumbnail simply stays older */ }
  }

  /** The latest event's still image. The cached copy from when the event happened wins — Google's own URL dies ~30 s later. */
  async snapshot(d: Device): Promise<Snapshot> {
    const c = this.camFor(d);
    const p = this.thumbPath(c);
    if (p) { try { return { contentType: 'image/jpeg', body: await readFile(p) }; } catch { /* no cached frame yet */ } }
    if (!c.dev.traits?.[T.image]) throw new Error('This camera doesn’t offer event images');
    if (!c.lastEvent) throw new Error('No recent event to show');
    const body = await this.fetchEventImage(c);
    if (!body) throw new Error('Google returned no image');
    return { contentType: 'image/jpeg', body };
  }

  // ------------------------------------------------------------------ misc --

  async command(d: Device, _cmd: Command): Promise<void> {
    throw new Error(`${d.name} is a camera: there's nothing to switch`);
  }

  status(): AdapterStatus {
    if (this.error) return { ok: false, note: this.error };
    if (this.eventsError) return { ok: false, note: this.eventsError };
    const n = this.cams.size;
    return { ok: n > 0, note: `${n} camera${n === 1 ? '' : 's'} · cloud${this.opts.subscription ? '' : ' · no events (add a Pub/Sub subscription)'}` };
  }
}
