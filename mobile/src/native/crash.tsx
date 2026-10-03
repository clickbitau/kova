// Where crashes go: the hub, so they can be found later — and kept on the phone when the hub can't be reached.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Platform, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import { call } from '../api/client';
import { getJson, setJson } from './storage';
import type { HubConfig } from '../logic/connect';
import { C, SP } from '../theme';

const QUEUE = 'crash:pending';
const crumbs: string[] = [];

/** Breadcrumb: the last few screens/where things happened, sent with each report. */
export function crumb(name: string): void {
  if (!name || crumbs[crumbs.length - 1] === name) return;
  crumbs.push(name);
  if (crumbs.length > 12) crumbs.shift();
}

interface Report {
  message: string; stack?: string; kind: 'js' | 'fatal' | 'render';
  screen?: string; crumbs: string[]; app?: string; platform: string; at: number;
}

let cfgNow: (() => HubConfig | null) | null = null;

/** Wire the reporter to the current hub config (call once, from the app root). */
export function initCrashReporting(getCfg: () => HubConfig | null): void {
  cfgNow = getCfg;
  // ErrorUtils is a runtime global, not a typed RN export.
  type Handler = (error: unknown, isFatal?: boolean) => void;
  const eu = (globalThis as { ErrorUtils?: { getGlobalHandler: () => Handler; setGlobalHandler: (cb: Handler) => void } }).ErrorUtils;
  const prev = eu?.getGlobalHandler();
  eu?.setGlobalHandler((err, fatal) => {
    void reportCrash(err, fatal ? 'fatal' : 'js');
    prev?.(err, fatal);
  });
  void flushCrashes();
}

async function sendReport(r: Report): Promise<void> {
  const cfg = cfgNow?.();
  if (!cfg) throw new Error('no hub');
  await call(cfg, 'POST', '/api/app/crash', r, 5_000);
}

/** Report a crash now; queue it when the hub can't be reached (sent on next launch). */
export async function reportCrash(err: unknown, kind: Report['kind'] = 'js'): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  const r: Report = {
    message: e.message.slice(0, 500), stack: e.stack?.slice(0, 6000), kind,
    screen: crumbs[crumbs.length - 1], crumbs: [...crumbs],
    app: Constants.expoConfig?.version, platform: Platform.OS, at: Date.now(),
  };
  try { await sendReport(r); }
  catch {
    try {
      const q = (await getJson<Report[]>(QUEUE)) ?? [];
      q.push(r);
      await setJson(QUEUE, q.slice(-20));
    } catch { /* storage failing isn't a reason to crash */ }
  }
}

/** Send anything queued earlier. */
export async function flushCrashes(): Promise<void> {
  const q = await getJson<Report[]>(QUEUE);
  if (!q?.length) return;
  try {
    for (const r of q) await sendReport(r);
    await setJson(QUEUE, null);
  } catch { /* still offline: keep them */ }
}

/** Catches render crashes anywhere below it: reports, then offers a way back instead of a dead screen. */
export class CrashBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  override componentDidCatch(err: Error, _info: ErrorInfo) { void reportCrash(err, 'render'); }
  override render() {
    if (!this.state.err) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: C.page, alignItems: 'center', justifyContent: 'center', padding: SP[6], gap: SP[4] }}>
        <Text style={{ color: C.bone, fontSize: 17, fontWeight: '700' }}>Something crashed</Text>
        <Text style={{ color: C.stone, fontSize: 13, textAlign: 'center' }}>{this.state.err.message.slice(0, 200)}</Text>
        <TouchableOpacity onPress={() => this.setState({ err: null })} style={{ backgroundColor: C.amber, borderRadius: 12, paddingHorizontal: SP[4], paddingVertical: SP[2] }}>
          <Text style={{ color: '#1a1408', fontWeight: '700' }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}
