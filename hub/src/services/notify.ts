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
  /** Kova's address as your phone reaches it (e.g. https://kova.example.com), for links in ntfy notifications. */
  publicUrl?: string;
  /** Built-in rules, all on by default. */
  rules?: { doorbell?: boolean; everyoneOut?: boolean; offline?: boolean };
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
  private rule(name: keyof NonNullable<NotifyOptions['rules']>): boolean { return this.opts.rules?.[name] !== false; }

  start(): void {
    const onEvent = (e: DeviceEvent) => { if (e.type === 'ring' && this.rule('doorbell')) this.track(this.onRing(e)); };
    this.hub.reg.on('event', onEvent);
    const onChanged = () => this.onPresence();
    this.hub.engine.on('changed', onChanged);
    const onMeasure = () => this.checkDevices();
    this.hub.reg.on('measure', onMeasure);
    this.off.push(() => this.hub.reg.off('event', onEvent), () => this.hub.engine.off('changed', onChanged), () => this.hub.reg.off('measure', onMeasure));
    this.anyoneHome = this.hub.engine.anyoneHome();
    const every = (this.opts.checkSec ?? 60) * 1000;
    if (every > 0) { this.interval = setInterval(() => this.checkDevices(), every); this.interval.unref?.(); }
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
    const lit = new Set<string>();
    const onChange = (c: { device: { id: string }; patch: { on?: boolean }; cause: { id?: string } }) => {
      if (c.cause.id === 'light_the_way' && c.patch.on === true) lit.add(c.device.id);
    };
    this.hub.reg.on('change', onChange);
    await new Promise<void>(resolve => { const t = setTimeout(resolve, this.opts.ringSettleMs ?? 500); t.unref?.(); });
    this.hub.reg.off('change', onChange);
    const room = this.hub.config.get().rooms.find(r => r.id === e.device.room)?.name;
    const where = room && /door/i.test(room) ? room.toLowerCase() : room ? `${room.toLowerCase()} door` : 'door';
    const names = [...lit].map(id => this.hub.reg.get(id)?.name).filter((n): n is string => !!n);
    const body = names.length
      ? `${e.device.name} rang. Light the way turned on ${list(names)}.`
      : `${e.device.name} rang.`;
    // Tapping it (or "View camera") opens the phone app on the doorbell's live view.
    const cam = `/phone.html?cam=${encodeURIComponent(e.device.id)}`;
    await this.notify({ title: `Someone’s at the ${where}`, body, tag: `ring-${e.device.id}`, url: cam, actions: [{ action: 'view-camera', title: 'View camera', url: cam }] });
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
      if (d.state.online !== false) {
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

  /** Whether any channel could deliver right now. */
  hasChannels(): boolean { return !!this.opts.ntfy || this.subscriptions().length > 0; }

  /** Send to every channel. Returns how many deliveries succeeded. */
  async notify(n: Notification): Promise<{ push: number; ntfy: boolean; removed: number }> {
    const out = { push: 0, ntfy: false, removed: 0 };
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
    if (this.opts.ntfy) {
      try { await this.sendNtfy(n); out.ntfy = true; } catch (err) { errors.push(`ntfy: ${String((err as Error).message ?? err)}`); }
    }
    const channels = [out.push ? `${out.push} phone${out.push === 1 ? '' : 's'}` : null, out.ntfy ? 'ntfy' : null].filter(Boolean);
    this.hub.store.append({
      kind: 'system', device: null, feed: 'system',
      what: `Notified: ${n.title}`,
      data: { title: n.title, body: n.body, url: n.url, tag: n.tag, push: out.push, ntfy: out.ntfy, removed: out.removed, errors },
      cause: { kind: 'system', label: 'Notifications', detail: channels.length ? `sent to ${channels.join(' and ')}` : 'not delivered' },
    });
    this.hub.emit('changed');
    return out;
  }

  private sendNtfy(n: Notification): Promise<void> {
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
    return new Promise((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'POST', timeout: 10_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      }, res => {
        res.resume();
        res.on('end', () => (res.statusCode ?? 0) < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Row on the Integrations screen. */
  status(): { ok: boolean; note?: string } {
    const n = this.subscriptions().length;
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
