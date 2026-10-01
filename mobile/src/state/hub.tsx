import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { call } from '../api/client';
import type { Command, Snapshot } from '../api/types';
import { wsUrl, type HubConfig } from '../logic/connect';
import { getJson, setJson } from '../native/storage';
import { checkForAppUpdate, pointUpdatesAtHub } from '../native/updates';

export type Conn = 'connecting' | 'live' | 'offline';

export interface Toast { id: number; text: string; undo?: string; error?: boolean }

interface HubCtx {
  cfg: HubConfig | null;
  /** Still reading the saved hub from the keychain. */
  loading: boolean;
  snap: Snapshot | null;
  conn: Conn;
  toast: Toast | null;
  connect(cfg: HubConfig): Promise<void>;
  forget(): Promise<void>;
  setPerson(personId: string | undefined): Promise<void>;
  api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  /** Change a device, showing the change at once; the hub's next snapshot has the final word. */
  /** Resolves true when the hub took it (errors are shown here). */
  send(id: string, cmd: Command, done?: string): Promise<boolean>;
  /** A call that returns { undo }: toast with an Undo button. */
  act(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, done: string): Promise<void>;
  say(text: string, opts?: { undo?: string; error?: boolean }): void;
  undo(id: string): Promise<void>;
  /** Pull to refresh: the hub's state read again now, and the live link reopened if it had dropped. */
  refresh(): Promise<void>;
}

const Ctx = createContext<HubCtx | null>(null);
const KEY = 'kova.hub';

export function HubProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<HubConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [toast, setToast] = useState<Toast | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped to reopen the live link at once (pull to refresh while offline). */
  const [kick, setKick] = useState(0);

  // Whatever the keychain says (or fails to), the app moves on from the splash.
  useEffect(() => { void getJson<HubConfig>(KEY).catch(() => null).then(c => { setCfg(c); setLoading(false); }); }, []);

  // Live state over the hub's socket, reconnecting with backoff and whenever the app comes back to the front.
  useEffect(() => {
    if (!cfg) return;
    let closed = false, attempt = 0;
    const open = () => {
      if (closed) return;
      setConn(c => (c === 'live' ? c : 'connecting'));
      const sock = new WebSocket(wsUrl(cfg));
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
        const wait = Math.min(15_000, 1000 * 2 ** attempt++);
        retry.current = setTimeout(open, wait);
      };
      sock.onerror = () => sock.close();
    };
    // A first snapshot over HTTP, so the screens fill in even before the socket opens.
    void call<Snapshot>(cfg, 'GET', '/api/state').then(s => { if (!closed) setSnap(s); }).catch(() => {});
    open();
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && !ws.current) { if (retry.current) clearTimeout(retry.current); attempt = 0; open(); }
    });
    return () => {
      closed = true;
      sub.remove();
      if (retry.current) clearTimeout(retry.current);
      ws.current?.close();
      ws.current = null;
    };
  }, [cfg, kick]);

  const say = useCallback((text: string, opts: { undo?: string; error?: boolean } = {}) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, ...opts });
    toastTimer.current = setTimeout(() => setToast(null), opts.undo ? 6000 : 3500);
  }, []);

  // App updates come from this hub (native/updates.ts): point the updater at it, check now and
  // whenever the app comes back to the front (at most every 30 minutes). A new one runs next launch.
  const hubUrl = cfg?.url;
  useEffect(() => {
    if (!hubUrl) return;
    const check = (force: boolean) => void checkForAppUpdate(force).then(ready => {
      if (ready) say('A new version of Kova is ready. It starts next time you open the app.');
    });
    void pointUpdatesAtHub(hubUrl).then(() => check(true));
    const sub = AppState.addEventListener('change', st => { if (st === 'active') check(false); });
    return () => sub.remove();
  }, [hubUrl, say]);

  const api = useCallback(<T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    if (!cfg) return Promise.reject(new Error('Not connected to a hub'));
    return call<T>(cfg, method, path, body);
  }, [cfg]);

  const send = useCallback(async (id: string, cmd: Command, done?: string) => {
    void Haptics.selectionAsync().catch(() => {});
    // Show it now; the hub's snapshot replaces this a moment later.
    setSnap(s => s && { ...s, devices: s.devices.map(d => d.id === id ? { ...d, state: { ...d.state, ...cmd } } : d) });
    try {
      const r = await api<{ undo?: string }>('POST', `/api/devices/${encodeURIComponent(id)}`, cmd);
      if (done) say(done, { undo: r?.undo });
      return true;
    } catch (e) {
      say((e as Error).message, { error: true });
      void api<Snapshot>('GET', '/api/state').then(setSnap).catch(() => {});
      return false;
    }
  }, [api, say]);

  const act = useCallback(async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, done: string) => {
    try {
      const r = await api<{ undo?: string }>(method, path, body);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      say(done, { undo: r?.undo });
    } catch (e) {
      say((e as Error).message, { error: true });
    }
  }, [api, say]);

  const undo = useCallback(async (id: string) => {
    try { await api('POST', `/api/undo/${encodeURIComponent(id)}`); say('Undone'); } catch (e) { say((e as Error).message, { error: true }); }
  }, [api, say]);

  const refresh = useCallback(async () => {
    if (!cfg) return;
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) setKick(k => k + 1);
    try { setSnap(await call<Snapshot>(cfg, 'GET', '/api/state')); } catch (e) { say((e as Error).message, { error: true }); }
  }, [cfg, say]);

  const connect = useCallback(async (c: HubConfig) => { await setJson(KEY, c); setSnap(null); setCfg(c); }, []);
  const forget = useCallback(async () => { await setJson(KEY, null); setSnap(null); setCfg(null); }, []);
  const setPerson = useCallback(async (personId: string | undefined) => {
    if (!cfg) return;
    const next = { ...cfg, personId };
    await setJson(KEY, next);
    setCfg(next);
  }, [cfg]);

  const value = useMemo<HubCtx>(() => ({ cfg, loading, snap, conn, toast, connect, forget, setPerson, api, send, act, say, undo, refresh }),
    [cfg, loading, snap, conn, toast, connect, forget, setPerson, api, send, act, say, undo, refresh]);
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
