// The phone's link to its hub: which address to use, the live socket on it, and what to tell the person when it
// isn't working. Kept free of React Native (the socket, timers and requests come in as `LinkDeps`) so every way it
// can go wrong is tested under Node: test/link.test.ts, with fakes, and against a real hub.
//
// The rules it keeps:
//  - "Can't reach your hub" only once nothing answers as this hub, twice running (the second time with longer
//    timeouts). A socket that drops, a phone waking up, a slow moment: those reconnect quietly first.
//  - It tries again by itself, sooner at first (1 s, 2 s, 4 s … up to 20 s), and at once when the app comes back
//    to the front, the network changes, or the person asks.
//  - The socket is checked, not trusted: the hub sends something at least every 30 s, so one that's been quiet
//    for longer is dead (a phone that slept, a Wi-Fi that went away) and is replaced.
//  - A hub that answers but refuses this phone's key is "signed out", not "offline": trying again won't help,
//    signing in again will. A hub that answers with errors, or a different hub at the address, is a "hub
//    problem". Each says what to do.
//  - When requests work but the socket doesn't (a proxy that won't pass it), the app is still connected and
//    fetches the state every so often until the socket is back. Every reconnect starts with a full snapshot.

import { addressesOf, chooseAddress, display, type Hello, type Route } from './addresses.ts';
import { wsUrl, type HubConfig } from './connect.ts';

export type LinkState = 'connecting' | 'live' | 'offline' | 'signedOut' | 'hubError';

export interface LinkStatus {
  state: LinkState;
  /** The live socket is open and talking. While `live` without it, the state is fetched every so often instead. */
  socket: boolean;
  /** offline: when it tries again by itself (epoch ms). */
  retryAt?: number;
  /** signedOut, hubError: what happened, in words. */
  message?: string;
}

/** The few parts of a WebSocket this uses (React Native's, the browser's and Node's all fit). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

/** A failed request: `status` 0 when nothing answered, else the hub's HTTP status (api/client.ts HubError fits). */
export interface RequestError { status: number; message?: string; problem?: 'unreachable' | 'signedOut' | 'hub' }

export interface LinkTuning {
  /** Waits between tries while nothing answers (the last one repeats). */
  backoffMs: number[];
  /** A socket this quiet is dead (the hub sends at least every 30 s). */
  staleMs: number;
  /** How often the socket's quiet is checked. */
  watchMs: number;
  /** A socket that hasn't opened and spoken by now isn't going to. */
  openTimeoutMs: number;
  /** While requests work but the socket doesn't: fetch the state this often. */
  pollMs: number;
  /** Timeouts for checking an address: [first try, the try that decides "can't reach"]. */
  localTimeoutMs: [number, number];
  remoteTimeoutMs: [number, number];
}

export const TUNING: LinkTuning = {
  backoffMs: [1000, 2000, 4000, 8000, 15_000, 20_000],
  staleMs: 70_000,
  watchMs: 10_000,
  openTimeoutMs: 15_000,
  pollMs: 15_000,
  localTimeoutMs: [2000, 4000],
  remoteTimeoutMs: [5000, 8000],
};

export interface LinkDeps {
  /** The saved hub (address list, ID, token), read fresh each time. */
  config(): HubConfig | null;
  /** GET <url>/api/hello, no token (api/client.ts hello). */
  hello(url: string, timeoutMs: number): Promise<Hello | null>;
  /** A GET with the token (api/client.ts call); rejects with a RequestError. */
  get<T>(cfg: HubConfig, path: string, timeoutMs?: number): Promise<T>;
  /** Open a socket to this URL. */
  socket(url: string): SocketLike;
  /** A state snapshot from the hub (socket or fetch). */
  onSnapshot(snap: unknown): void;
  onStatus(s: LinkStatus): void;
  /** The address in use changed (null: none answers right now). */
  onRoute(r: Route | null): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  random?: () => number;
  tuning?: Partial<LinkTuning>;
}

/** The wait before try number `attempt` (0-based), ±20% so a houseful of phones doesn't knock at once. */
export function backoff(attempt: number, steps: number[], random: () => number = Math.random): number {
  const base = steps[Math.min(Math.max(attempt, 0), steps.length - 1)] ?? 1000;
  return Math.round(base * (0.8 + 0.4 * random()));
}

const isStatus = (e: unknown): e is RequestError => !!e && typeof e === 'object' && typeof (e as RequestError).status === 'number';
/** The hub refused the key (and not some route's own 401 with a reason of its own). */
const refused = (e: unknown): boolean => isStatus(e) && e.status === 401 && (e.problem === undefined || e.problem === 'signedOut');

export class HubLink {
  private d: Required<Omit<LinkDeps, 'tuning'>>;
  private t: LinkTuning;
  private status: LinkStatus = { state: 'connecting', socket: false };
  private routeNow: Route | null = null;

  private sock: SocketLike | null = null;
  /** The socket has said something (the hub's first snapshot comes at once). */
  private spoke = false;
  private openedAt = 0;
  private lastHeard = 0;

  private attempt = 0;
  /** Choices in a row where nothing answered. */
  private misses = 0;
  private retryTimer: unknown = null;
  private pollTimer: unknown = null;
  private watchTimer: unknown = null;
  private choosing: Promise<Route | null> | null = null;
  /** A different Kova answered at one of the addresses, in the last choice. */
  private otherHub: string | null = null;

  private running = false;
  private paused = false;
  /** Bumped by stop/pause/reset: work still under way for an older one is dropped. */
  private gen = 0;

  constructor(deps: LinkDeps) {
    this.d = {
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
      random: Math.random,
      ...deps,
    } as Required<Omit<LinkDeps, 'tuning'>>;
    this.t = { ...TUNING, ...deps.tuning };
  }

  get route(): Route | null { return this.routeNow; }
  get current(): LinkStatus { return this.status; }

  // ------------------------------------------------------------------ control --

  /** Start (or, after stop, start again) for the saved hub. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.gen++;
    this.attempt = 0;
    this.misses = 0;
    this.set({ state: 'connecting', socket: false });
    this.watch();
    void this.connect(true);
  }

  /** Forget everything under way (the hub was forgotten, or the app is closing). */
  stop(): void {
    this.running = false;
    this.gen++;
    this.clearAll();
    this.dropSocket();
  }

  /** Another hub, or a new key for this one: start over from nothing. */
  reset(): void {
    this.stop();
    this.setRoute(null);
    this.start();
  }

  /**
   * The app went to the background: close the socket (the phone would only keep a dead one) and stop trying.
   * What the person last saw stays as it was until the app is back and has had a chance to reconnect.
   */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.gen++;
    this.clearAll();
    this.dropSocket();
    if (this.status.socket) this.set({ ...this.status, socket: false });
  }

  /** Back in the front: look again now (the phone may have moved, or slept through a hub restart), and resync. */
  resume(): void {
    if (!this.running) return;
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) { this.gen++; this.watch(); }
    if (this.status.state === 'signedOut') return; // waits for the person (retryNow) or a new key (reset)
    if (!wasPaused && this.sock && this.spoke && this.d.now() - this.lastHeard < this.t.staleMs / 2) return;
    this.attempt = 0;
    this.dropSocket();
    void this.connect(true);
  }

  /** The phone's network changed (on or off the home Wi-Fi): choose again at once, and move if that changed. */
  networkChanged(): void {
    if (!this.running || this.paused || this.status.state === 'signedOut') return;
    this.attempt = 0;
    void this.recheck();
  }

  /** "Try now", pull to refresh, or "Try again" on the signed-out screen. */
  retryNow(): void {
    if (!this.running) { this.start(); return; }
    this.paused = false;
    this.attempt = 0;
    this.misses = 0;
    if (this.status.state === 'signedOut' || this.status.state === 'hubError') this.set({ state: 'connecting', socket: false });
    this.clearRetry();
    if (this.sock && this.spoke && this.d.now() - this.lastHeard < this.t.staleMs / 2) return;
    this.dropSocket();
    void this.connect(true);
  }

  /**
   * Look again while things work (every so often while away, in case home is back): move to a better address if
   * one answers, keep this one when nothing does (a slow moment isn't a reason to drop a working socket).
   */
  async recheck(): Promise<void> {
    if (!this.running || this.paused) return;
    const g = this.gen;
    const before = this.routeNow;
    const r = await this.choose({ keep: true });
    if (g !== this.gen || !r) return;
    if (r.url !== before?.url) { this.dropSocket(); this.openSocket(r); return; }
    if (!this.sock) void this.connect(false);
  }

  // ------------------------------------------------------ what requests say --

  /** A request on `url` worked: the hub is reachable, whatever the socket is doing. */
  reachable(url?: string): void {
    if (!this.running || this.paused || this.status.state === 'signedOut') return;
    if (url && this.routeNow && url !== this.routeNow.url) return;
    this.misses = 0;
    const s = this.status.state;
    if (s === 'offline' || s === 'connecting' || s === 'hubError') this.set({ state: 'live', socket: !!this.sock && this.spoke });
    // Nothing open and only waiting out the backoff: the hub's there, so open it now.
    if (!this.sock) { this.clearRetry(); this.attempt = 0; this.poll(); void this.connect(false); }
  }

  /** The hub refused this phone's key (HTTP 401 on any request): signed out until the person signs in again. */
  signedOut(message = 'Your hub didn’t accept this phone’s key. It may have been changed, or this phone signed out.'): void {
    if (!this.running) return;
    this.gen++;
    this.clearAll();
    this.dropSocket();
    this.set({ state: 'signedOut', socket: false, message });
    this.watch();
  }

  /** Nothing answered a request on the address in use: choose again (shared with whoever else is asking). */
  async lost(): Promise<Route | null> {
    const before = this.routeNow, g = this.gen;
    const r = await this.choose();
    if (g === this.gen && r && r.url !== before?.url) { this.dropSocket(); this.openSocket(r); }
    return r;
  }

  // ---------------------------------------------------------------- choosing --

  /**
   * Which address to use now (logic/addresses.ts chooseAddress): home network first, only an address that answers
   * as this hub. One choice at a time; callers share it. `keep`: when nothing answers, keep the one in use.
   * `patient`: the longer timeouts (the try that decides whether to say "can't reach").
   */
  choose(o: { keep?: boolean; patient?: boolean } = {}): Promise<Route | null> {
    if (this.choosing) return this.choosing.then(r => r ?? (o.keep ? this.routeNow : null));
    const c = this.d.config();
    if (!c) return Promise.resolve(null);
    const g = this.gen;
    let other: string | null = null;
    const p = (async () => {
      const i = o.patient ? 1 : 0;
      const r = await chooseAddress(addressesOf(c), {
        hubId: c.hubId,
        lastGood: this.routeNow?.url ?? c.url,
        localTimeoutMs: this.t.localTimeoutMs[i],
        remoteTimeoutMs: this.t.remoteTimeoutMs[i],
        hello: async (url, ms) => {
          const h = await this.d.hello(url, ms);
          if (h && c.hubId && h.hubId && h.hubId !== c.hubId) other ??= url;
          return h;
        },
      });
      if (g !== this.gen) return null;
      this.otherHub = r ? null : other;
      if (r) { this.misses = 0; this.setRoute(r); return r; }
      if (o.keep && this.routeNow) return this.routeNow;
      this.setRoute(null);
      return null;
    })().finally(() => { if (this.choosing === p) this.choosing = null; });
    this.choosing = p;
    return p;
  }

  // ----------------------------------------------------------------- the loop --

  /** Get a socket open: choose an address (always, when `fresh`, else only without one), then open it there. */
  private async connect(fresh: boolean): Promise<void> {
    if (!this.running || this.paused || this.status.state === 'signedOut') return;
    if (this.sock) return;
    const g = this.gen;
    this.clearRetry();
    const r = fresh || !this.routeNow ? await this.choose({ patient: this.misses > 0 }) : this.routeNow;
    if (g !== this.gen || this.sock || !this.running || this.paused) return;
    if (!r) { this.nothingAnswered(); return; }
    this.openSocket(r);
  }

  private nothingAnswered(): void {
    this.misses++;
    const wait = backoff(this.attempt++, this.t.backoffMs, this.d.random);
    if (this.otherHub) {
      this.set({ state: 'hubError', socket: false, message: `A different Kova hub answers at ${display(this.otherHub)}. If your hub was set up again, connect to it again.` });
    } else if (this.misses >= 2) {
      this.set({ state: 'offline', socket: false, retryAt: this.d.now() + wait });
    } else if (this.status.state !== 'live') {
      this.set({ state: 'connecting', socket: false });
    }
    this.later(wait, () => void this.connect(true));
  }

  private openSocket(r: Route): void {
    const c = this.d.config();
    if (!c || !this.running || this.paused) return;
    const g = this.gen;
    const s = this.d.socket(wsUrl({ ...c, url: r.url }));
    this.sock = s;
    this.spoke = false;
    this.openedAt = this.d.now();
    if (this.status.state !== 'live') this.set({ state: 'connecting', socket: false });
    let done = false;
    const gone = () => {
      if (done) return;
      done = true;
      if (this.sock !== s) return;
      const spoke = this.spoke;
      this.sock = null;
      this.spoke = false;
      if (g !== this.gen || !this.running || this.paused) return;
      void this.dropped(spoke);
    };
    s.onmessage = ev => {
      if (this.sock !== s) return;
      let m: { type?: string; data?: unknown };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      this.lastHeard = this.d.now();
      if (m?.type !== 'state') return;
      this.spoke = true;
      this.attempt = 0;
      this.misses = 0;
      this.stopPoll();
      this.d.onSnapshot(m.data);
      if (this.status.state !== 'live' || !this.status.socket) this.set({ state: 'live', socket: true });
    };
    s.onclose = gone;
    s.onerror = () => { gone(); try { s.close(); } catch { /* already closed */ } };
  }

  /**
   * The socket closed (or went quiet, or never opened). Ask at once whether the hub still answers, and on which
   * address. When the socket never got a word in, ask with the token too: a socket can't tell a refused key from
   * a dropped line, a request can.
   */
  private async dropped(spoke: boolean): Promise<void> {
    const g = this.gen;
    if (this.status.socket) this.set({ ...this.status, socket: false });
    const r = await this.choose({ patient: this.misses > 0 });
    if (g !== this.gen || this.sock || !this.running || this.paused) return;
    if (!r) { this.nothingAnswered(); return; }
    if (!spoke) {
      const c = this.d.config();
      if (!c) return;
      try {
        await this.d.get(c.url === r.url ? c : { ...c, url: r.url }, '/api/connect/addresses', 8000);
      } catch (e) {
        if (g !== this.gen) return;
        const status = isStatus(e) ? e.status : 0;
        if (refused(e)) { this.signedOut(); return; }
        if (status >= 500) {
          this.set({ state: 'hubError', socket: false, message: e && (e as RequestError).message ? String((e as RequestError).message) : `Your hub answered with an error (HTTP ${status}).` });
        } else if (status === 0) {
          this.nothingAnswered();
          return;
        }
        // 404 and the like: an older hub without that route; the key is fine.
      }
      if (g !== this.gen || this.sock) return;
      if (this.status.state !== 'hubError') this.set({ state: 'live', socket: false });
      this.poll();
    }
    // Spoke before: straight back (the first time). Never spoke: wait a while, the socket may be what's failing.
    const wait = spoke && this.attempt === 0 ? 250 : backoff(this.attempt, this.t.backoffMs, this.d.random);
    this.attempt++;
    this.later(wait, () => { if (r.url === this.routeNow?.url) { if (!this.sock) this.openSocket(r); } else void this.connect(false); });
  }

  /** Every so often: is the socket still talking (or, still opening, going to)? */
  private watch(): void {
    if (this.watchTimer) this.d.clearTimer(this.watchTimer);
    const g = this.gen;
    const tick = () => {
      this.watchTimer = null;
      if (g !== this.gen || !this.running || this.paused) return;
      const now = this.d.now();
      const s = this.sock;
      if (s && ((this.spoke && now - this.lastHeard > this.t.staleMs) || (!this.spoke && now - this.openedAt > this.t.openTimeoutMs))) {
        const r = this.routeNow, spoke = this.spoke;
        this.dropSocket();
        if (r) void this.dropped(spoke);
      }
      this.watchTimer = this.d.setTimer(tick, this.t.watchMs);
    };
    this.watchTimer = this.d.setTimer(tick, this.t.watchMs);
  }

  /** While the hub answers requests but the socket isn't up: the state now, and again every so often. */
  private poll(): void {
    if (this.pollTimer || this.spoke) return;
    const g = this.gen;
    const once = async () => {
      this.pollTimer = null;
      if (g !== this.gen || !this.running || this.paused || this.spoke) return;
      const c = this.d.config(), r = this.routeNow;
      if (c && r) {
        try {
          this.d.onSnapshot(await this.d.get(c.url === r.url ? c : { ...c, url: r.url }, '/api/state'));
          if (g === this.gen && this.status.state !== 'live') this.set({ state: 'live', socket: false });
        } catch (e) {
          if (g !== this.gen) return;
          if (refused(e)) { this.signedOut(); return; }
        }
      }
      if (g === this.gen && !this.spoke && this.running && !this.paused) this.pollTimer = this.d.setTimer(() => void once(), this.t.pollMs);
    };
    this.pollTimer = this.d.setTimer(() => void once(), 0);
  }

  // ------------------------------------------------------------------ helpers --

  private set(s: LinkStatus): void {
    const a = this.status;
    if (a.state === s.state && a.socket === s.socket && a.message === s.message && a.retryAt === s.retryAt) return;
    this.status = s;
    this.d.onStatus(s);
  }

  private setRoute(r: Route | null): void {
    const a = this.routeNow;
    if (a?.url === r?.url && a?.kind === r?.kind && a?.hubId === r?.hubId) return;
    this.routeNow = r;
    this.d.onRoute(r);
  }

  private later(ms: number, fn: () => void): void {
    this.clearRetry();
    const g = this.gen;
    this.retryTimer = this.d.setTimer(() => { this.retryTimer = null; if (g === this.gen && this.running && !this.paused) fn(); }, ms);
  }

  private clearRetry(): void { if (this.retryTimer) { this.d.clearTimer(this.retryTimer); this.retryTimer = null; } }
  private stopPoll(): void { if (this.pollTimer) { this.d.clearTimer(this.pollTimer); this.pollTimer = null; } }

  private clearAll(): void {
    this.clearRetry();
    this.stopPoll();
    if (this.watchTimer) { this.d.clearTimer(this.watchTimer); this.watchTimer = null; }
    this.choosing = null;
  }

  /** Let go of the socket without hearing about it (its close is ours, not news). */
  private dropSocket(): void {
    const s = this.sock;
    this.sock = null;
    this.spoke = false;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try { s.close(); } catch { /* already gone */ }
  }
}

/** The words and tone for the link, wherever it's shown (More, the hub's addresses, the banner). */
export function linkWords(s: Pick<LinkStatus, 'state'>): { title: string; short: string; tone: 'ok' | 'busy' | 'down' | 'warn' } {
  switch (s.state) {
    case 'live': return { title: 'Connected to your hub', short: 'Connected', tone: 'ok' };
    case 'offline': return { title: 'Can’t reach your hub', short: 'Can’t reach it right now', tone: 'down' };
    case 'signedOut': return { title: 'Signed out of your hub', short: 'Signed out: sign in again', tone: 'warn' };
    case 'hubError': return { title: 'Your hub has a problem', short: 'It answers, with an error', tone: 'warn' };
    default: return { title: 'Connecting…', short: 'Connecting…', tone: 'busy' };
  }
}
