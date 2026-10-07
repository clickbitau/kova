import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import webpush, { type PushSubscription } from 'web-push';
import type { Hub } from '../hub.ts';
import type { DeviceEvent } from '../devices/registry.ts';
import { isLight } from '../util/describe.ts';

/** Push notifications. Lives under `notify` in integrations.json; Web Push to the Kova phone app works with no config. */
export interface NotifyOptions {
  /** ntfy.sh (or a self-hosted ntfy): the zero-setup channel. Subscribe to the topic in the ntfy app. */
  ntfy?: { url: string; topic: string; token?: string };
  /** VAPID "subject" Apple/Google may use to contact you: a mailto: or https: URL. */
  push?: { subject?: string };
  /** The Kova phone app's notifications go through Expo's push service (a cloud relay to Apple and Google). `url` is for tests. */
  expo?: { url?: string; accessToken?: string };
  /** Kova's address as your phone reaches it (e.g. https://kova.example.com), for links in ntfy notifications. */
  publicUrl?: string;
  /** Built-in rules, all on by default. */
  rules?: { doorbell?: boolean; everyoneOut?: boolean; offline?: boolean; network?: boolean; links?: boolean; home?: boolean };
  /** A link that worked (Helix, SmartThings, OwnTone, Warden…) must be failing this long before "Kova lost Helix". Default 5. */
  linkAfterMin?: number;
  /** A device must be offline this long before "X isn't responding". Default 10. */
  offlineAfterMin?: number;
  /** Wait this long after the last person leaves before "Everyone's out" (lets an Away overlay turn lights off first). Default 60 s. */
  everyoneOutGraceSec?: number;
  /** How long to collect what Light the way switched on after a ring. Default 500 ms. */
  ringSettleMs?: number;
  /** How often to look for offline devices. Default 60 s; 0 turns the timer off (tests call checkDevices()). */
  checkSec?: number;
}

export interface Notification {
  title: string;
  body: string;
  /** Path or URL in the app to open on tap. */
  url?: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
  /** Only these people's phones (subscriptions without a person get everything). */
  people?: string[];
  /** Buttons: each opens its URL in the app. */
  actions?: { action: string; title: string; url: string }[];
}

export interface StoredSubscription { subscription: PushSubscription; personId?: string; added: number }

/** A Kova phone app on someone's phone: its Expo push token. */
export interface AppPhone { token: string; personId?: string; name?: string; platform?: string; added: number }

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

interface Vapid { publicKey: string; privateKey: string }

export const LIGHTS_OFF_URL = '/phone.html?do=lights-off';

/**
 * Sends notifications to the Kova phone app (Web Push) and/or ntfy, and runs
 * the built-in rules: doorbell, everyone out with lights on, device offline.
 * Every notification is written to Activity.
 */
export class Notifier {
  readonly vapid: Vapid;
  private subject: string;
  private offlineSince = new Map<string, number>();
  private offlineNotified = new Set<string>();
  /** Integrations and services: whether each has worked since the hub started, since when it's failing, and whether that was said. */
  private links = new Map<string, { worked: boolean; failingSince: number | null; told: boolean }>();
  /** Pending delayed rules, with how to cancel each. */
  private timers = new Map<NodeJS.Timeout, () => void>();
  private interval: NodeJS.Timeout | null = null;
  private anyoneHome: boolean;
  private off: (() => void)[] = [];
  /** Sends in flight, so tests (and stop) can wait for them. */
  private pending = new Set<Promise<unknown>>();

  constructor(private hub: Hub, private opts: NotifyOptions = {}, private env: { dataDir: string; pushAgent?: https.Agent }) {
    this.vapid = loadVapid(join(env.dataDir, 'push'));
    this.subject = opts.push?.subject ?? 'https://github.com/clickbitau/kova';
    this.anyoneHome = hub.engine.anyoneHome();
  }

  private get now(): number { return this.hub.engine.now(); }
  /** On unless switched off (false, or "off" from the settings form). */
  private rule(name: keyof NonNullable<NotifyOptions['rules']>): boolean { const v = this.opts.rules?.[name] as unknown; return v !== false && v !== 'off'; }

  start(): void {
    const onEvent = (e: DeviceEvent) => {
      // The doorbell's own message; whether it goes is the camera's alert choice and cooldown (services/security.ts).
      if (e.type === 'ring' && this.rule('doorbell') && this.hub.security.allowRing(e)) this.track(this.onRing(e));
      if (e.device.adapter === 'warden' && this.rule('network')) this.track(this.onNetwork(e));
    };
    this.hub.reg.on('event', onEvent);
    // The home's alerts and warnings (filter, the air, heat and cold, batteries): told once, when each first appears.
    const onInsight = (i: import('./insights.ts').Insight) => {
      if (!this.rule('home')) return;
      this.track(this.notify({ title: i.title, body: i.detail ?? '', tag: `insight-${i.id}`, url: i.device ? `/phone.html?device=${encodeURIComponent(i.device)}` : '/phone.html' }));
    };
    this.hub.insights.on('new', onInsight);
    // Insights are worked out when someone looks; this looks every minute too, so a push doesn't wait for a screen.
    const look = setInterval(() => { try { this.hub.insights.current(); } catch { /* next minute */ } }, 60_000);
    look.unref?.();
    this.off.push(() => this.hub.insights.off('new', onInsight), () => clearInterval(look));
    const onChanged = () => this.onPresence();
    this.hub.engine.on('changed', onChanged);
    const onMeasure = () => this.checkDevices();
    this.hub.reg.on('measure', onMeasure);
    this.off.push(() => this.hub.reg.off('event', onEvent), () => this.hub.engine.off('changed', onChanged), () => this.hub.reg.off('measure', onMeasure));
    this.anyoneHome = this.hub.engine.anyoneHome();
    const every = (this.opts.checkSec ?? 60) * 1000;
    if (every > 0) { this.interval = setInterval(() => { this.checkDevices(); this.checkLinks(); }, every); this.interval.unref?.(); }
  }

  async stop(): Promise<void> {
    for (const f of this.off) f();
    this.off = [];
    for (const [t, cancel] of this.timers) { clearTimeout(t); cancel(); }
    this.timers.clear();
    if (this.interval) clearInterval(this.interval);
    await this.idle();
  }

  /** Resolves when every notification started so far has been sent. */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.catch(err => console.warn('[notify]', err)).finally(() => this.pending.delete(p));
    return p;
  }

  private later(ms: number, fn: () => void | Promise<void>): void {
    void this.track(new Promise<boolean>(resolve => {
      const t = setTimeout(() => { this.timers.delete(t); resolve(true); }, ms);
      t.unref?.();
      this.timers.set(t, () => resolve(false));
    }).then(run => run ? fn() : undefined));
  }

  // ---------------------------------------------------------------- rules --

  private async onRing(e: DeviceEvent): Promise<void> {
    // Light the way reacts to the same ring; note what it switches on.
    const lit = new Set<string>(), paused = new Set<string>();
    const onChange = (c: { device: { id: string }; patch: { on?: boolean; paused?: boolean }; cause: { id?: string } }) => {
      if (c.cause.id === 'light_the_way' && c.patch.on === true) lit.add(c.device.id);
      if (c.cause.id === 'doorbell-pause' && c.patch.paused === true) paused.add(c.device.id);
    };
    this.hub.reg.on('change', onChange);
    await new Promise<void>(resolve => { const t = setTimeout(resolve, this.opts.ringSettleMs ?? 500); t.unref?.(); });
    this.hub.reg.off('change', onChange);
    // The door to name: its room when it has a real one, else the device's own name minus the "doorbell".
    const room = this.hub.config.get().rooms.find(r => r.id === e.device.room)?.name;
    const named = e.device.name.replace(/\s+(doorbell|camera|cam)$/i, '');
    const place = room && !/unsorted/i.test(room) ? room : named;
    const where = place && /door/i.test(place) ? place.toLowerCase() : place ? `${place.toLowerCase()} door` : 'door';
    const names = [...lit].map(id => this.hub.reg.get(id)?.name).filter((n): n is string => !!n);
    const held = [...paused].map(id => this.hub.reg.get(id)?.name).filter((n): n is string => !!n);
    const body = [`${e.device.name} rang.`, names.length ? `Light the way turned on ${list(names)}.` : '', held.length ? `Paused ${list(held)}.` : ''].filter(Boolean).join(' ');
    // Tapping it (or "View camera") opens the phone app on the doorbell's live view.
    const cam = `/phone.html?cam=${encodeURIComponent(e.device.id)}`;
    await this.notify({ title: `Someone’s at the ${where}`, body, tag: `ring-${e.device.id}`, url: cam, actions: [{ action: 'view-camera', title: 'View camera', url: cam }] });
  }

  /** Warden: the internet went down, came back or moved to the backup connection, a new device joined, or an attack was blocked. */
  private async onNetwork(e: DeviceEvent): Promise<void> {
    const d = e.data ?? {};
    const text = (k: string) => typeof d[k] === 'string' ? d[k] as string : '';
    const url = '/phone.html?page=integrations';
    if (e.type === 'internet-down') await this.notify({ title: 'The internet is down', body: 'Warden lost the connection. Kova and your devices at home keep working.', tag: 'internet', url });
    else if (e.type === 'internet-up') await this.notify({ title: 'The internet is back', body: 'Warden is connected again.', tag: 'internet', url });
    // On the backup connection: still online, but it may be slower or metered. Same tag, so "back" replaces it.
    else if (e.type === 'internet-failover') await this.notify({ title: text('title') || 'Switched to the backup connection', body: [text('body'), 'Everything stays online; it may be slower until the main connection is back.'].filter(Boolean).join(' '), tag: 'internet', url });
    else if (e.type === 'new-device') await this.notify({ title: text('title') || 'A new device joined your network', body: text('body') || 'Open Warden to name it or block it.', tag: 'warden-new-device', url });
    else if (e.type === 'threat') await this.notify({ title: text('title') || 'Warden blocked an attack', body: text('body'), tag: 'warden-threat', url });
  }

  private onPresence(): void {
    const now = this.hub.engine.anyoneHome();
    if (now === this.anyoneHome) return;
    this.anyoneHome = now;
    if (now || !this.rule('everyoneOut')) return;
    this.later((this.opts.everyoneOutGraceSec ?? 60) * 1000, async () => {
      if (this.hub.engine.anyoneHome()) return;
      // Lights Light the way switched on turn themselves off; don't count them.
      const on = this.hub.reg.list().filter(d => isLight(d) && d.state.on && d.state.online !== false
        && this.hub.store.lastStateChange(d.id)?.cause.id !== 'light_the_way');
      if (!on.length) return;
      await this.notify({
        title: `Everyone’s out, ${on.length} light${on.length === 1 ? ' is' : 's are'} on`,
        body: on.length <= 4 ? `${list(on.map(d => d.name))}.` : `${list(on.slice(0, 3).map(d => d.name))} and ${on.length - 3} more.`,
        tag: 'everyone-out', url: LIGHTS_OFF_URL,
        actions: [{ action: 'lights-off', title: 'Turn them off', url: LIGHTS_OFF_URL }],
      });
    });
  }

  /** Flag devices that have been offline longer than `offlineAfterMin`. */
  checkDevices(): void {
    if (!this.rule('offline')) return;
    const t = this.now;
    const limit = (this.opts.offlineAfterMin ?? 10) * 60_000;
    for (const d of this.hub.reg.list()) {
      if (d.state.online !== false || d.archived) {
        this.offlineSince.delete(d.id);
        this.offlineNotified.delete(d.id);
        continue;
      }
      const since = this.offlineSince.get(d.id) ?? t;
      this.offlineSince.set(d.id, since);
      if (t - since >= limit && !this.offlineNotified.has(d.id)) {
        this.offlineNotified.add(d.id);
        const room = this.hub.config.get().rooms.find(r => r.id === d.room)?.name;
        this.track(this.notify({
          title: `${d.name} isn’t responding`,
          body: `${room ? room + ' · ' : ''}${d.integration}, offline for ${Math.round((t - since) / 60_000)} min.`,
          tag: `offline-${d.id}`, url: '/phone.html',
        }));
      }
    }
  }

  /**
   * A link that worked and broke: Helix, SmartThings, OwnTone, Warden, the Helix TV link… Once it has been failing
   * for `linkAfterMin`, say so (with its own words), and say again when it's back. Something never set up, or
   * failing since the hub started, isn't news: Integrations shows it.
   */
  checkLinks(): void {
    if (!this.rule('links')) return;
    const t = this.now;
    const limit = (this.opts.linkAfterMin ?? 5) * 60_000;
    const all: { id: string; name: string; status: () => { ok: boolean; note?: string } }[] = [
      ...[...this.hub.reg.adapters.values()].filter(a => a.id !== 'virtual').map(a => ({ id: `adapter:${a.id}`, name: a.name, status: () => a.status() })),
      ...this.hub.services.map(sv => ({ id: `service:${sv.id}`, name: sv.name, status: () => sv.status() })),
    ];
    for (const l of all) {
      let st: { ok: boolean; note?: string };
      try { st = l.status(); } catch (e) { st = { ok: false, note: (e as Error).message }; }
      const k = this.links.get(l.id) ?? { worked: false, failingSince: null, told: false };
      this.links.set(l.id, k);
      if (st.ok) {
        if (k.told) this.track(this.notify({ title: `${l.name} is back`, body: st.note ? `${st.note}.` : 'Working again.', tag: `link-${l.id}`, url: '/phone.html' }));
        Object.assign(k, { worked: true, failingSince: null, told: false });
        continue;
      }
      if (!k.worked) continue;
      k.failingSince ??= t;
      if (!k.told && t - k.failingSince >= limit) {
        k.told = true;
        this.track(this.notify({
          title: `Kova lost ${l.name}`,
          body: `${st.note ?? 'It stopped answering'}. Things that need it won’t work until it’s back.`,
          tag: `link-${l.id}`, url: '/phone.html',
        }));
      }
    }
  }

  // ------------------------------------------------------------ channels --

  subscriptions(): StoredSubscription[] { return this.hub.store.get<StoredSubscription[]>('pushSubscriptions') ?? []; }
  private saveSubs(s: StoredSubscription[]): void { this.hub.store.set('pushSubscriptions', s); }

  subscribe(subscription: PushSubscription, personId?: string): void {
    if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint)) throw new Error('subscription.endpoint must be an https URL');
    if (!subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('subscription.keys.p256dh and auth are required');
    const rest = this.subscriptions().filter(s => s.subscription.endpoint !== subscription.endpoint);
    this.saveSubs([...rest, { subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, personId: personId || undefined, added: this.now }]);
  }

  unsubscribe(endpoint: string): boolean {
    const all = this.subscriptions();
    const rest = all.filter(s => s.subscription.endpoint !== endpoint);
    this.saveSubs(rest);
    return rest.length !== all.length;
  }

  /** Phones with the Kova app that asked for notifications. */
  appPhones(): AppPhone[] { return this.hub.store.get<AppPhone[]>('appPhones') ?? []; }
  private saveApps(a: AppPhone[]): void { this.hub.store.set('appPhones', a); }

  registerApp(token: string, o: { personId?: string; name?: string; platform?: string } = {}): void {
    if (!EXPO_TOKEN.test(token)) throw new Error('token must be an Expo push token (ExponentPushToken[…])');
    const rest = this.appPhones().filter(a => a.token !== token);
    this.saveApps([...rest, { token, personId: o.personId || undefined, name: o.name?.slice(0, 60) || undefined, platform: o.platform?.slice(0, 20) || undefined, added: this.now }]);
  }

  unregisterApp(token: string): boolean {
    const all = this.appPhones();
    const rest = all.filter(a => a.token !== token);
    this.saveApps(rest);
    return rest.length !== all.length;
  }

  /** Whether any channel could deliver right now. */
  hasChannels(): boolean { return !!this.opts.ntfy || this.subscriptions().length > 0 || this.appPhones().length > 0; }

  /** Send to every channel. Returns how many deliveries succeeded. */
  async notify(n: Notification): Promise<{ push: number; ntfy: boolean; removed: number; app: number }> {
    const out = { push: 0, ntfy: false, removed: 0, app: 0 };
    if (!this.hasChannels()) return out;
    const subs = this.subscriptions().filter(s => !n.people?.length || !s.personId || n.people.includes(s.personId));
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url ?? '/phone.html', tag: n.tag, actions: n.actions ?? [] });
    const dead: string[] = [];
    const errors: string[] = [];
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification(s.subscription, payload, {
          vapidDetails: { subject: this.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
          TTL: 3600, urgency: 'high', topic: n.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
          ...(this.env.pushAgent ? { agent: this.env.pushAgent } : {}),
        });
        out.push++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        // Gone: the phone unsubscribed or the app was removed.
        if (code === 404 || code === 410) dead.push(s.subscription.endpoint);
        else errors.push(String((err as Error).message ?? err));
      }
    }));
    if (dead.length) {
      this.saveSubs(this.subscriptions().filter(s => !dead.includes(s.subscription.endpoint)));
      out.removed = dead.length;
    }
    const apps = this.appPhones().filter(a => !n.people?.length || !a.personId || n.people.includes(a.personId));
    if (apps.length) {
      try {
        const r = await this.sendExpo(n, apps);
        out.app = r.sent;
        if (r.gone.length) { this.saveApps(this.appPhones().filter(a => !r.gone.includes(a.token))); out.removed += r.gone.length; }
        errors.push(...r.errors);
      } catch (err) { errors.push(`app: ${String((err as Error).message ?? err)}`); }
    }
    if (this.opts.ntfy) {
      try { await this.sendNtfy(n); out.ntfy = true; } catch (err) { errors.push(`ntfy: ${(err as Error).constructor?.name} ${String((err as Error).message ?? err)} ${(err as {code?:string}).code ?? ''}`); }
    }
    const phones = out.push + out.app;
    const channels = [phones ? `${phones} phone${phones === 1 ? '' : 's'}` : null, out.ntfy ? 'ntfy' : null].filter(Boolean);
    this.hub.store.append({
      kind: 'system', device: null, feed: 'system',
      what: `Notified: ${n.title}`,
      data: { title: n.title, body: n.body, url: n.url, tag: n.tag, push: out.push, app: out.app, ntfy: out.ntfy, removed: out.removed, errors },
      cause: { kind: 'system', label: 'Notifications', detail: channels.length ? `sent to ${channels.join(' and ')}` : 'not delivered' },
    });
    this.hub.emit('changed');
    return out;
  }

  /**
   * To the Kova app through Expo's push service: one request for every phone. The app opens `url` on a tap
   * (a camera, lights off). Tokens Apple or Google say are gone are dropped.
   */
  private async sendExpo(n: Notification, apps: AppPhone[]): Promise<{ sent: number; gone: string[]; errors: string[] }> {
    const messages = apps.map(a => ({
      to: a.token, title: n.title, body: n.body, sound: 'default', priority: 'high', channelId: 'default',
      data: { url: n.url ?? '/phone.html', tag: n.tag, actions: n.actions ?? [] },
      ...(n.actions?.length ? { categoryId: n.tag?.startsWith('ring') ? 'doorbell' : undefined } : {}),
    }));
    const res = await fetch(this.opts.expo?.url ?? EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.opts.expo?.accessToken ? { authorization: `Bearer ${this.opts.expo.accessToken}` } : {}) },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    const j = await res.json() as { data?: { status: string; message?: string; details?: { error?: string } }[] };
    const gone: string[] = [], errors: string[] = [];
    let sent = 0;
    (j.data ?? []).forEach((t, i) => {
      if (t.status === 'ok') sent++;
      else if (t.details?.error === 'DeviceNotRegistered') gone.push(apps[i].token);
      else errors.push(`app: ${t.message ?? t.details?.error ?? 'failed'}`);
    });
    return { sent, gone, errors };
  }

  private async sendNtfy(n: Notification): Promise<void> {
    const o = this.opts.ntfy!;
    const abs = (u: string) => this.opts.publicUrl ? new URL(u, this.opts.publicUrl).href : /^https?:/.test(u) ? u : null;
    const click = n.url ? abs(n.url) : null;
    const body = JSON.stringify({
      topic: o.topic, title: n.title, message: n.body, priority: 4,
      ...(n.tag ? { tags: [n.tag.split('-')[0] === 'ring' ? 'bell' : n.tag.startsWith('offline') ? 'warning' : 'house'] } : {}),
      ...(click ? { click } : {}),
      actions: (n.actions ?? []).map(a => ({ action: 'view', label: a.title, url: abs(a.url) })).filter(a => a.url),
    });
    // ntfy's JSON publishing goes to the server root with the topic in the body (keeps titles UTF-8 safe).
    const u = new URL(o.url.replace(/\/+$/, '') + '/');
    const post = (family?: number) => new Promise<void>((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'POST', timeout: 10_000, ...(family ? { family } : {}),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      }, res => {
        res.resume();
        res.on('end', () => (res.statusCode ?? 0) < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(body);
    });
    // Some LANs have a broken IPv6 route: a dual-stack lookup stalls on it. Retry IPv4-only when the send
    // couldn't reach a server at all (an HTTP error means it did).
    try { await post(); }
    catch (err) {
      if (err instanceof Error && /^HTTP /.test(err.message)) throw err;
      await post(4);
    }
  }

  /** Row on the Integrations screen. */
  status(): { ok: boolean; note?: string } {
    const n = this.subscriptions().length + this.appPhones().length;
    const parts = [`${n} phone${n === 1 ? '' : 's'} subscribed`];
    if (this.opts.ntfy) parts.push(`ntfy topic ${this.opts.ntfy.topic}`);
    return { ok: true, note: parts.join(' · ') };
  }
}

/** VAPID keys are made once and kept, since every phone's subscription is tied to them. */
function loadVapid(dir: string): Vapid {
  const file = join(dir, 'vapid.json');
  if (existsSync(file)) {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Vapid;
    if (v.publicKey && v.privateKey) return v;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const v = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return v;
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
