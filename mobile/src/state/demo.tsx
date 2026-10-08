// "Try the demo": the whole app against the demo home, on the phone, with no hub and no network (demo/hub.ts).
//
// The seam is the hub context itself: every screen talks to the hub through useHub() (state/hub.tsx), so the demo
// provides that same context with the demo hub behind `api` instead of HTTP and the socket. Nothing about finding,
// choosing or reaching a real hub runs in the demo (no addresses, no socket, no app updates from a hub, no
// arrive-and-leave addresses), and `cfg` stays null: there is no real hub, so nothing that needs one (push, the
// widget, camera pictures, crash reports, web pages from the hub) has anywhere to go.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HubError } from '../api/client';
import type { Command, Snapshot } from '../api/types';
import { createDemoHub, type DemoHub } from '../demo/hub';
import { getItem, setItem } from '../native/storage';
import { haptic } from '../ui/motion';
import { Ctx, HubProvider, type HubCtx, type Pending, type Toast } from './hub';

const KEY = 'kova.demo';

interface DemoCtx {
  /** The app is showing the demo home. */
  demo: boolean;
  startDemo(): Promise<void>;
  /** Back to the first-run screen, to connect a real hub. */
  leaveDemo(): Promise<void>;
}

const DemoContext = createContext<DemoCtx>({ demo: false, startDemo: async () => {}, leaveDemo: async () => {} });
export const useDemo = () => useContext(DemoContext);

/** Above everything that uses the hub: the real hub, or the demo one. The choice is kept, so the demo reopens as it was left. */
export function HubRoot({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => { void getItem(KEY).catch(() => null).then(v => setDemo(v === '1')); }, []);
  const startDemo = useCallback(async () => { setDemo(true); await setItem(KEY, '1').catch(() => {}); }, []);
  const leaveDemo = useCallback(async () => { setDemo(false); await setItem(KEY, null).catch(() => {}); }, []);
  const value = useMemo(() => ({ demo: !!demo, startDemo, leaveDemo }), [demo, startDemo, leaveDemo]);
  if (demo === null) return null;
  return (
    <DemoContext.Provider value={value}>
      {demo ? <DemoHubProvider onLeave={leaveDemo}>{children}</DemoHubProvider> : <HubProvider>{children}</HubProvider>}
    </DemoContext.Provider>
  );
}

/** A moment's wait, so taps feel like a hub answered rather than nothing happening at all. */
const LATENCY_MS = 140;
const later = (ms: number) => new Promise(r => setTimeout(r, ms));

function DemoHubProvider({ children, onLeave }: { children: ReactNode; onLeave: () => Promise<void> }) {
  const hub = useRef<DemoHub | null>(null);
  if (!hub.current) hub.current = createDemoHub();
  const [snap, setSnap] = useState<Snapshot>(() => hub.current!.snapshot());
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The demo hub's changes, like the hub's socket; and time passing (the clock, solar, the day's modes).
  useEffect(() => {
    const h = hub.current!;
    const off = h.subscribe(setSnap);
    const t = setInterval(() => h.tick(), 15_000);
    return () => { off(); clearInterval(t); };
  }, []);

  const api = useCallback(async <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> => {
    await later(LATENCY_MS);
    return hub.current!.request<T>(method, path, body);
  }, []);

  const say = useCallback((text: string, opts: { undo?: string; error?: boolean; action?: Toast['action'] } = {}) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, ...opts });
    toastTimer.current = setTimeout(() => setToast(null), opts.action ? 9000 : opts.undo ? 6000 : 3500);
  }, []);

  const send = useCallback(async (id: string, cmd: Command, done?: string) => {
    haptic.select();
    setSnap(s => ({ ...s, devices: s.devices.map(d => d.id === id ? { ...d, state: { ...d.state, ...cmd } } : d) }));
    setPending(p => ({ ...p, [id]: 'busy' }));
    try {
      const r = await api<{ undo?: string }>('POST', `/api/devices/${encodeURIComponent(id)}`, cmd);
      if (done) say(done, { undo: r?.undo });
      return true;
    } catch (e) {
      say((e as Error).message, { error: true });
      setSnap(hub.current!.snapshot());
      return false;
    } finally {
      setPending(p => { const n = { ...p }; delete n[id]; return n; });
    }
  }, [api, say]);

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

  const refresh = useCallback(async () => { setSnap(hub.current!.snapshot()); }, []);
  const notHere = useCallback(async () => { throw new HubError('This is the demo home. Leave the demo to connect your own hub.', 0); }, []);

  const value = useMemo<HubCtx>(() => ({
    cfg: null, loading: false, snap, conn: 'live', link: { state: 'live', socket: true }, route: null, addresses: [], toast, pending,
    connect: async () => { await onLeave(); },
    forget: onLeave,
    signIn: notHere,
    setPerson: async () => { say('In the demo home this phone isn’t anyone’s. Connect your own hub to choose.'); },
    setAddresses: notHere,
    api, send, act, say, undo, refresh,
  }), [snap, toast, pending, onLeave, say, notHere, api, send, act, undo, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
