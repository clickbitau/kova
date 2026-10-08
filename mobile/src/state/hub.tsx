import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { call, hello, HubError } from '../api/client';
import type { Command, Snapshot } from '../api/types';
import { addressesOf, learn, type HubAddress, type Route } from '../logic/addresses';
import { HubLink, type LinkState, type LinkStatus, type SocketLike } from '../logic/link';
import type { HubConfig } from '../logic/connect';
import { followHome, followHub } from '../native/arrive-leave';
import { getJson, setJson } from '../native/storage';
import { applyAppUpdate, checkForAppUpdate, pointUpdatesAtHub } from '../native/updates';
import { haptic } from '../ui/motion';

/**
 * How the link to the hub is (logic/link.ts): connecting; live (the hub answers); offline (nothing answers as this
 * hub, at home or remotely); signedOut (the hub answers but refuses this phone's key); hubError (it answers with
 * errors, or a different hub is at the address).
 */
export type Conn = LinkState;

export interface Toast { id: number; text: string; undo?: string; error?: boolean; action?: { label: string; run: () => void } }

/** A device command on its way: `busy` until the hub answers, `failed` for a moment when it refused. */
export type Pending = Record<string, 'busy' | 'failed'>;

export interface HubCtx {
  cfg: HubConfig | null;
  /** Still reading the saved hub from the keychain. */
  loading: boolean;
  snap: Snapshot | null;
  conn: Conn;
  /** More about `conn`: whether the live socket is up, when it tries again, and what went wrong. */
  link: LinkStatus;
  /** The address in use and which way it goes (home network or remote); null while none has answered. */
  route: Route | null;
  /** Every address this hub may be reached at, home network first. */
  addresses: HubAddress[];
  toast: Toast | null;
  /** Devices with a command in flight, or one that just failed (tiles show a ring, or shake). */
  pending: Pending;
  connect(cfg: HubConfig): Promise<void>;
  forget(): Promise<void>;
  setPerson(personId: string | undefined): Promise<void>;
  /** Replace the address list (server settings), and pick again from it. */
  setAddresses(list: HubAddress[]): Promise<void>;
  api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  /** Change a device, showing the change at once; the hub's next snapshot has the final word. */
  /** Resolves true when the hub took it (errors are shown here). */
  send(id: string, cmd: Command, done?: string): Promise<boolean>;
  /** A call that returns { undo }: toast with an Undo button. Resolves true when the hub took it. */
  act(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, done: string): Promise<boolean>;
  say(text: string, opts?: { undo?: string; error?: boolean; action?: Toast['action'] }): void;
  undo(id: string): Promise<void>;
  /** Pull to refresh, "Try now": the link tried again at once, and the hub's state read again. */
  refresh(): Promise<void>;
  /** Signed out: sign in again with a new key, keeping the hub, its addresses and this phone's settings. */
  signIn(token: string): Promise<void>;
}

export const Ctx = createContext<HubCtx | null>(null);
const KEY = 'kova.hub';
/** While on the remote address with a home-network one to go back to, look again this often. */
const AWAY_CHECK_MS = 60_000;

export function HubProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<HubConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<LinkStatus>({ state: 'connecting', socket: false });
  const [route, setRoute] = useState<Route | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const mark = useCallback((id: string, p: 'busy' | 'failed' | null) => setPending(o => {
    const n = { ...o };
    if (p) n[id] = p; else delete n[id];
    return n;
  }), []);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest config, for the link, which runs outside React's render.
  const cfgRef = useRef<HubConfig | null>(null);
  const learned = useRef<string | null>(null);

  /** Save the hub (keychain) and show it. */
  const save = useCallback(async (next: HubConfig | null) => {
    cfgRef.current = next;
    setCfg(next);
    await setJson(KEY, next);
  }, []);

  // The link to the hub (logic/link.ts): the address, the socket, reconnecting, and what to say when it's down.
  const linkRef = useRef<HubLink | null>(null);
  if (!linkRef.current) {
    linkRef.current = new HubLink({
      config: () => cfgRef.current,
      hello,
      get: (c, path, timeoutMs) => call(c, 'GET', path, undefined, timeoutMs),
      socket: url => new WebSocket(url) as unknown as SocketLike,
      onSnapshot: s => setSnap(s as Snapshot),
      onStatus: setLink,
      onRoute: r => {
        setRoute(prev => (prev?.url === r?.url && prev?.kind === r?.kind ? prev : r));
        const now = cfgRef.current;
        if (r && now && (now.url !== r.url || (!now.hubId && r.hubId))) {
          // Remember the one that worked (it's tried first next time) and, the first time, which hub this is.
          void save({ ...now, url: r.url, ...(r.hubId && !now.hubId ? { hubId: r.hubId } : {}), addresses: addressesOf(now) });
        }
      },
    });
  }
  const hub = linkRef.current;

  // Whatever the keychain says (or fails to), the app moves on from the splash.
  useEffect(() => {
    void getJson<HubConfig>(KEY).catch(() => null).then(c => {
      cfgRef.current = c; setCfg(c); setLoading(false);
      if (c) hub.start();
    });
    return () => hub.stop();
  }, [hub]);

  const hasCfg = !!cfg;
  const routeUrl = route?.url ?? null;

  // Try again at once when the best way to the hub may have changed: back in the foreground (the phone may have
  // moved, or slept through a hub restart; the socket was closed in the background and reopens with a fresh
  // snapshot), a change of network (left the home Wi-Fi, or back on it), and every minute while on the remote
  // address with a home-network one to go back to.
  useEffect(() => {
    if (!hasCfg) return;
    let lastNet = '';
    const netKey = (s: Network.NetworkState) => `${s.type}:${s.isConnected}:${s.isInternetReachable}`;
    void Network.getNetworkStateAsync().then(s => { lastNet ||= netKey(s); }).catch(() => {});
    const app = AppState.addEventListener('change', st => {
      if (st === 'active') hub.resume();
      else if (st === 'background') hub.pause();
    });
    let net: { remove(): void } | null = null;
    let netTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      net = Network.addNetworkStateListener(s => {
        const k = netKey(s);
        if (k === lastNet) return;
        lastNet = k;
        // A moment for the new network to hand out an address and routes.
        if (netTimer) clearTimeout(netTimer);
        netTimer = setTimeout(() => hub.networkChanged(), 800);
      });
    } catch { /* no listener here (the web build): the foreground and failures still re-check */ }
    const timer = setInterval(() => {
      const c = cfgRef.current, r = hub.route;
      if (AppState.currentState === 'active' && c && r?.kind === 'remote' && addressesOf(c).some(a => a.kind === 'local')) void hub.recheck();
    }, AWAY_CHECK_MS);
    return () => { app.remove(); net?.remove(); if (netTimer) clearTimeout(netTimer); clearInterval(timer); };
  }, [hasCfg, hub]);

  // Once connected, ask the hub for every address it has (GET /api/connect/addresses) and keep them, so a phone set
  // up at home can reach it away too. Once per hub per run; an older hub without the route just keeps the one it has.
  useEffect(() => {
    const c = cfgRef.current;
    if (!c || !routeUrl || learned.current === routeUrl) return;
    learned.current = routeUrl;
    void call<{ hubId?: string | null; addresses?: { url: string; kind?: string }[] }>({ ...c, url: routeUrl }, 'GET', '/api/connect/addresses')
      .then(async got => {
        const now = cfgRef.current;
        if (!now || now.token !== c.token || !Array.isArray(got?.addresses)) return;
        if (got.hubId && now.hubId && got.hubId !== now.hubId) return; // not the hub this phone knows
        const addresses = learn(addressesOf(now), got.addresses, hub.route?.url ?? now.url, now.removed);
        const hubId = now.hubId ?? got.hubId ?? undefined;
        if (JSON.stringify(addresses) === JSON.stringify(now.addresses) && hubId === now.hubId) return;
        await save({ ...now, addresses, ...(hubId ? { hubId } : {}) });
      })
      .catch(() => {});
  }, [routeUrl, save, hub]);

  const say = useCallback((text: string, opts: { undo?: string; error?: boolean; action?: Toast['action'] } = {}) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, ...opts });
    toastTimer.current = setTimeout(() => setToast(null), opts.action ? 9000 : opts.undo ? 6000 : 3500);
  }, []);

  // App updates come from this hub (native/updates.ts): point the updater at it, check now and whenever the app
  // comes back to the front (at most every 30 minutes). The updater stays on one of the hub's addresses (see
  // logic/ota.ts updateBase), so a check only goes out while that's the one answering. A new one runs next launch.
  const addressKey = JSON.stringify(cfg ? addressesOf(cfg) : []);
  useEffect(() => {
    const c = cfgRef.current;
    if (!c || !routeUrl) return;
    let source: string | null = null, first = true, told = false;
    const check = () => {
      if (source !== hub.route?.url) return;
      const force = first; first = false;
      void checkForAppUpdate(force).then(u => {
        if (u.state === 'ready' && !told) { told = true; say(u.version ? `Kova ${u.version} is ready` : 'A new version of Kova is ready', { action: { label: 'Restart', run: () => void applyAppUpdate() } }); }
      });
    };
    void pointUpdatesAtHub(addressesOf(c), routeUrl).then(s => { source = s; check(); });
    const sub = AppState.addEventListener('change', st => { if (st === 'active') check(); });
    return () => sub.remove();
  }, [routeUrl, addressKey, say, hub]);

  // Signed in as one of the home's people (an invite, or "This is me"): this phone is theirs, for arriving and
  // leaving and for their notifications.
  const mePerson = snap?.me?.via === 'session' ? snap.me.personId : null;
  useEffect(() => {
    const c = cfgRef.current;
    if (mePerson && c && c.personId !== mePerson) void save({ ...c, personId: mePerson });
  }, [mePerson, save]);

  // The home's circle moved (Settings, here or anywhere): the phone watches the new one (native/arrive-leave.ts).
  const homeAt = snap?.home.location;
  const homeKey = homeAt ? `${homeAt.latitude},${homeAt.longitude},${homeAt.radiusM ?? ''}` : '';
  useEffect(() => {
    if (homeAt && (homeAt.latitude || homeAt.longitude)) void followHome(homeAt).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeKey]);

  // Arriving and leaving reports from the background: give it every address too (native/arrive-leave.ts).
  useEffect(() => {
    const c = cfgRef.current;
    if (c) void followHub(addressesOf(c), c.hubId ?? null, routeUrl ?? c.url).catch(() => {});
  }, [addressKey, routeUrl, cfg?.hubId]);

  /**
   * A request on the address in use. When nothing answers there, the address is chosen again and, if another one
   * answers as this hub, the request goes once more there. A write that timed out isn't re-sent (it may have
   * reached the hub). What happened tells the link: a request that landed means the hub answers, whatever the
   * socket is doing; a refused key means signed out (logic/link.ts).
   */
  const api = useCallback(async <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T> => {
    const c = cfgRef.current;
    if (!c) throw new HubError('Not connected to a hub', 0);
    const r = hub.route ?? await hub.choose();
    if (!r) throw new HubError('Can’t reach your hub, at home or remotely.', 0);
    const attempt = async (url: string) => {
      try {
        const out = await call<T>({ ...(cfgRef.current ?? c), url }, method, path, body, timeoutMs);
        hub.reachable(url);
        return out;
      } catch (e) {
        if (e instanceof HubError && e.problem === 'signedOut') hub.signedOut();
        throw e;
      }
    };
    try {
      return await attempt(r.url);
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 0) throw e;
      const next = await hub.lost();
      if (!next || next.url === r.url || (method !== 'GET' && e.timedOut)) throw e;
      return attempt(next.url);
    }
  }, [hub]);

  const send = useCallback(async (id: string, cmd: Command, done?: string) => {
    haptic.select();
    // Show it now; the hub's snapshot replaces this a moment later.
    setSnap(s => s && { ...s, devices: s.devices.map(d => d.id === id ? { ...d, state: { ...d.state, ...cmd } } : d) });
    mark(id, 'busy');
    try {
      const r = await api<{ undo?: string }>('POST', `/api/devices/${encodeURIComponent(id)}`, cmd);
      mark(id, null);
      if (done) say(done, { undo: r?.undo });
      return true;
    } catch (e) {
      mark(id, 'failed');
      setTimeout(() => setPending(o => { if (o[id] !== 'failed') return o; const n = { ...o }; delete n[id]; return n; }), 900);
      say((e as Error).message, { error: true });
      void api<Snapshot>('GET', '/api/state').then(setSnap).catch(() => {});
      return false;
    }
  }, [api, say, mark]);

  const act = useCallback(async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, done: string) => {
    try {
      const r = await api<{ undo?: string }>(method, path, body);
      haptic.success();
      say(done, { undo: r?.undo });
      return true;
    } catch (e) {
      say((e as Error).message, { error: true });
      return false;
    }
  }, [api, say]);

  const undo = useCallback(async (id: string) => {
    try { await api('POST', `/api/undo/${encodeURIComponent(id)}`); haptic.success(); say('Undone'); } catch (e) { say((e as Error).message, { error: true }); }
  }, [api, say]);

  const refresh = useCallback(async () => {
    if (!cfgRef.current) return;
    hub.retryNow();
    if (hub.current.state === 'signedOut') return;
    try { setSnap(await api<Snapshot>('GET', '/api/state')); } catch (e) {
      // Offline already says so on screen; anything else is news.
      if (!(e instanceof HubError) || e.problem !== 'unreachable') say((e as Error).message, { error: true });
    }
  }, [api, say, hub]);

  const connect = useCallback(async (c: HubConfig) => {
    setSnap(null);
    learned.current = null;
    await save({ ...c, addresses: addressesOf(c) });
    hub.reset();
  }, [save, hub]);
  const forget = useCallback(async () => {
    hub.stop();
    setSnap(null);
    setLink({ state: 'connecting', socket: false });
    setRoute(null);
    await save(null);
  }, [save, hub]);
  const signIn = useCallback(async (token: string) => {
    const c = cfgRef.current;
    if (!c) return;
    learned.current = null;
    await save({ ...c, token });
    hub.reset();
  }, [save, hub]);
  const setPerson = useCallback(async (personId: string | undefined) => {
    const c = cfgRef.current;
    if (c) await save({ ...c, personId });
  }, [save]);
  const setAddresses = useCallback(async (list: HubAddress[]) => {
    const c = cfgRef.current;
    if (!c || !list.length) return;
    const gone = addressesOf(c).map(a => a.url).filter(u => !list.some(a => a.url === u));
    const removed = [...new Set([...(c.removed ?? []), ...gone])].filter(u => !list.some(a => a.url === u));
    await save({ ...c, addresses: list, ...(removed.length ? { removed } : { removed: undefined }) });
    // The one in use may be gone (start over on the list), or a better one added (look again, move if it answers).
    if (!list.some(a => a.url === hub.route?.url)) hub.reset();
    else void hub.recheck();
  }, [save, hub]);

  const conn = link.state;
  const addresses = useMemo(() => (cfg ? addressesOf(cfg) : []), [cfg]);
  const value = useMemo<HubCtx>(() => ({ cfg, loading, snap, conn, link, route, addresses, toast, pending, connect, forget, setPerson, setAddresses, api, send, act, say, undo, refresh, signIn }),
    [cfg, loading, snap, conn, link, route, addresses, toast, pending, connect, forget, setPerson, setAddresses, api, send, act, say, undo, refresh, signIn]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHub(): HubCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useHub outside HubProvider');
  return c;
}

/** The snapshot, for screens that only render once connected. */
export function useSnap(): Snapshot {
  const { snap } = useHub();
  if (!snap) throw new Error('No snapshot yet');
  return snap;
}
