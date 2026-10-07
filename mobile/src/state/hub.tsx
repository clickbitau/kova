import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { call, hello, HubError } from '../api/client';
import type { Command, Snapshot } from '../api/types';
import { addressesOf, chooseAddress, learn, type HubAddress, type Route } from '../logic/addresses';
import { wsUrl, type HubConfig } from '../logic/connect';
import { followHub } from '../native/arrive-leave';
import { getJson, setJson } from '../native/storage';
import { applyAppUpdate, checkForAppUpdate, pointUpdatesAtHub } from '../native/updates';
import { haptic } from '../ui/motion';

export type Conn = 'connecting' | 'live' | 'offline';

export interface Toast { id: number; text: string; undo?: string; error?: boolean; action?: { label: string; run: () => void } }

/** A device command on its way: `busy` until the hub answers, `failed` for a moment when it refused. */
export type Pending = Record<string, 'busy' | 'failed'>;

export interface HubCtx {
  cfg: HubConfig | null;
  /** Still reading the saved hub from the keychain. */
  loading: boolean;
  snap: Snapshot | null;
  conn: Conn;
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
  /** Pull to refresh: the hub's state read again now, and the live link reopened if it had dropped. */
  refresh(): Promise<void>;
}

export const Ctx = createContext<HubCtx | null>(null);
const KEY = 'kova.hub';
/** While on the remote address with a home-network one to go back to, look again this often. */
const AWAY_CHECK_MS = 60_000;

export function HubProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<HubConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [route, setRoute] = useState<Route | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const mark = useCallback((id: string, p: 'busy' | 'failed' | null) => setPending(o => {
    const n = { ...o };
    if (p) n[id] = p; else delete n[id];
    return n;
  }), []);
  const ws = useRef<WebSocket | null>(null);
  const connRef = useRef<Conn>(conn);
  useEffect(() => { connRef.current = conn; }, [conn]);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped to reopen the live link at once (pull to refresh while offline). */
  const [kick, setKick] = useState(0);
  // The latest of each, for the address choosing below, which runs outside React's render.
  const cfgRef = useRef<HubConfig | null>(null);
  const routeRef = useRef<Route | null>(null);
  const choosing = useRef<Promise<Route | null> | null>(null);
  const learned = useRef<string | null>(null);
  /** Bumped when the phone connects to a hub or forgets it, so a choice still under way for the old one is dropped. */
  const gen = useRef(0);

  // Whatever the keychain says (or fails to), the app moves on from the splash.
  useEffect(() => { void getJson<HubConfig>(KEY).catch(() => null).then(c => { cfgRef.current = c; setCfg(c); setLoading(false); }); }, []);

  /** Save the hub (keychain) and show it. */
  const save = useCallback(async (next: HubConfig | null) => {
    cfgRef.current = next;
    setCfg(next);
    await setJson(KEY, next);
  }, []);

  /**
   * Pick the address to use now (logic/addresses.ts): home network whenever one answers as this hub, else the
   * remote one. Only an address that passed that check gets the token. One choice at a time; callers share it.
   * `keep`: a look-again while things work; when nothing answers (a slow moment), keep the address in use rather
   * than drop a live connection. A real failure (the socket closing, a request failing) chooses without it.
   */
  const choose = useCallback((opts: { keep?: boolean } = {}): Promise<Route | null> => {
    if (choosing.current) return choosing.current;
    const p: Promise<Route | null> = (async () => {
      const c = cfgRef.current, g = gen.current;
      if (!c) return null;
      const r = await chooseAddress(addressesOf(c), { hello, hubId: c.hubId, lastGood: routeRef.current?.url ?? c.url });
      if (g !== gen.current) return null; // forgotten, or another hub, meanwhile
      if (!r && opts.keep && routeRef.current) return null;
      routeRef.current = r;
      setRoute(prev => (prev?.url === r?.url && prev?.kind === r?.kind ? prev : r));
      const now = cfgRef.current;
      if (r && now && (now.url !== r.url || (!now.hubId && r.hubId))) {
        // Remember the one that worked (it's tried first next time) and, the first time, which hub this is.
        await save({ ...now, url: r.url, ...(r.hubId && !now.hubId ? { hubId: r.hubId } : {}), addresses: addressesOf(now) });
      }
      return r;
    })().finally(() => { if (choosing.current === p) choosing.current = null; });
    choosing.current = p;
    return p;
  }, [save]);

  /** The route to send a request on: the current one, or a fresh choice when there's none. */
  const ready = useCallback(async (): Promise<{ c: HubConfig; r: Route }> => {
    const c = cfgRef.current;
    if (!c) throw new HubError('Not connected to a hub', 0);
    const r = routeRef.current ?? await choose();
    if (!r) throw new HubError('Can’t reach the hub, at home or remotely.', 0);
    return { c: cfgRef.current ?? c, r };
  }, [choose]);

  const hasCfg = !!cfg;
  const token = cfg?.token;
  const routeUrl = route?.url ?? null;

  // A hub chosen (or forgotten): pick an address before anything is sent.
  useEffect(() => {
    routeRef.current = null;
    setRoute(null);
    learned.current = null;
    choosing.current = null;
    if (hasCfg) void choose();
  }, [hasCfg, token, choose]);

  // Live state over the hub's socket on the chosen address. When it drops, the address is chosen again first (the
  // phone may have left home or come back), so the socket reopens on whichever answers; with none, it keeps looking.
  useEffect(() => {
    if (!hasCfg) return;
    let closed = false, attempt = 0;
    const wait = () => Math.min(15_000, 1000 * 2 ** attempt++);
    const again = () => {
      retry.current = setTimeout(async () => {
        const r = await choose();
        if (closed) return;
        if (!r) { setConn('offline'); again(); return; }
        if (r.url === routeUrl) open();
        // Otherwise the route changed and this effect runs again for it.
      }, wait());
    };
    const open = () => {
      const c = cfgRef.current, r = routeRef.current;
      if (closed || !c || !r) return;
      setConn(x => (x === 'live' ? x : 'connecting'));
      const sock = new WebSocket(wsUrl({ ...c, url: r.url }));
      ws.current = sock;
      sock.onmessage = ev => {
        try {
          const m = JSON.parse(String(ev.data)) as { type: string; data: Snapshot };
          if (m.type === 'state') { setSnap(m.data); setConn('live'); attempt = 0; }
        } catch { /* ignore */ }
      };
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null;
        if (closed) return;
        setConn('offline');
        again();
      };
      sock.onerror = () => sock.close();
    };
    if (!routeUrl) {
      // Nothing chosen yet, or nothing answered: keep looking (the first choice is already under way).
      setConn(x => (x === 'live' ? 'connecting' : x));
      void (choosing.current ?? Promise.resolve(null)).then(r => { if (!closed && !r) { setConn('offline'); again(); } });
    } else {
      // A first snapshot over HTTP, so the screens fill in even before the socket opens.
      const c = cfgRef.current;
      if (c) void call<Snapshot>({ ...c, url: routeUrl }, 'GET', '/api/state').then(s => { if (!closed) setSnap(s); }).catch(() => {});
      open();
    }
    return () => {
      closed = true;
      if (retry.current) clearTimeout(retry.current);
      ws.current?.close();
      ws.current = null;
    };
  }, [hasCfg, token, routeUrl, kick, choose]);

  // Look again when the best way to the hub may have changed: back in the foreground (the phone may have moved
  // while the app slept), a change of network (left the home Wi-Fi, or back on it), and every minute while on the
  // remote address with a home-network one to go back to.
  useEffect(() => {
    if (!hasCfg) return;
    let lastNet = '';
    const netKey = (s: Network.NetworkState) => `${s.type}:${s.isConnected}`;
    void Network.getNetworkStateAsync().then(s => { lastNet ||= netKey(s); }).catch(() => {});
    const recheck = () => void choose({ keep: true }).then(r => {
      if (r && r.url === routeRef.current?.url && !ws.current) { if (retry.current) clearTimeout(retry.current); setKick(k => k + 1); }
    });
    const app = AppState.addEventListener('change', st => { if (st === 'active') recheck(); });
    let net: { remove(): void } | null = null;
    try {
      net = Network.addNetworkStateListener(s => {
        const k = netKey(s);
        if (k === lastNet) return;
        lastNet = k;
        // A moment for the new network to hand out an address and routes.
        setTimeout(recheck, 800);
      });
    } catch { /* no listener here (the web build): the foreground and failures still re-check */ }
    const timer = setInterval(() => {
      const c = cfgRef.current, r = routeRef.current;
      if (AppState.currentState === 'active' && c && r?.kind === 'remote' && addressesOf(c).some(a => a.kind === 'local')) recheck();
    }, AWAY_CHECK_MS);
    return () => { app.remove(); net?.remove(); clearInterval(timer); };
  }, [hasCfg, choose]);

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
        const addresses = learn(addressesOf(now), got.addresses, routeRef.current?.url ?? now.url, now.removed);
        const hubId = now.hubId ?? got.hubId ?? undefined;
        if (JSON.stringify(addresses) === JSON.stringify(now.addresses) && hubId === now.hubId) return;
        await save({ ...now, addresses, ...(hubId ? { hubId } : {}) });
      })
      .catch(() => {});
  }, [routeUrl, save]);

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
      if (source !== routeRef.current?.url) return;
      const force = first; first = false;
      void checkForAppUpdate(force).then(u => {
        if (u.state === 'ready' && !told) { told = true; say(u.version ? `Kova ${u.version} is ready` : 'A new version of Kova is ready', { action: { label: 'Restart', run: () => void applyAppUpdate() } }); }
      });
    };
    void pointUpdatesAtHub(addressesOf(c), routeUrl).then(s => { source = s; check(); });
    const sub = AppState.addEventListener('change', st => { if (st === 'active') check(); });
    return () => sub.remove();
  }, [routeUrl, addressKey, say]);

  // Arriving and leaving reports from the background: give it every address too (native/arrive-leave.ts).
  useEffect(() => {
    const c = cfgRef.current;
    if (c) void followHub(addressesOf(c), c.hubId ?? null, routeUrl ?? c.url).catch(() => {});
  }, [addressKey, routeUrl, cfg?.hubId]);

  /**
   * A request on the chosen address. When nothing answers there, the address is chosen again and, if another one
   * answers as this hub, the request goes once more there. A write that timed out isn't re-sent (it may have
   * reached the hub).
   */
  // A request that landed means the hub answers, whatever the live socket is doing — say so, and nudge the
  // socket back open at once rather than waiting out the backoff.
  const noteReachable = useCallback(() => {
    if (connRef.current === 'live') return;
    connRef.current = 'live';
    setConn('live');
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) setKick(k => k + 1);
  }, []);

  const api = useCallback(async <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T> => {
    const { c, r } = await ready();
    try {
      const out = await call<T>({ ...c, url: r.url }, method, path, body, timeoutMs);
      noteReachable();
      return out;
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 0) throw e;
      const next = await choose();
      if (!next || next.url === r.url || (method !== 'GET' && e.timedOut)) throw e;
      const out = await call<T>({ ...(cfgRef.current ?? c), url: next.url }, method, path, body, timeoutMs);
      noteReachable();
      return out;
    }
  }, [ready, choose, noteReachable]);

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
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) setKick(k => k + 1);
    try { setSnap(await api<Snapshot>('GET', '/api/state')); } catch (e) { say((e as Error).message, { error: true }); }
  }, [api, say]);

  const connect = useCallback(async (c: HubConfig) => {
    gen.current++;
    setSnap(null);
    await save({ ...c, addresses: addressesOf(c) });
  }, [save]);
  const forget = useCallback(async () => { gen.current++; setSnap(null); await save(null); }, [save]);
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
    // The one in use may be gone, or a better one added: choose again (and move the socket if that changed).
    if (!list.some(a => a.url === routeRef.current?.url)) { routeRef.current = null; setRoute(null); }
    void choose();
  }, [save, choose]);

  const addresses = useMemo(() => (cfg ? addressesOf(cfg) : []), [cfg]);
  const value = useMemo<HubCtx>(() => ({ cfg, loading, snap, conn, route, addresses, toast, pending, connect, forget, setPerson, setAddresses, api, send, act, say, undo, refresh }),
    [cfg, loading, snap, conn, route, addresses, toast, pending, connect, forget, setPerson, setAddresses, api, send, act, say, undo, refresh]);
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
