// Settings → Software update: the hub's own updates (hub/src/services/updates.ts) and this app's, in words.
// Free of React Native so the tests run it under plain Node.
import type { HubUpdate } from './integrations.ts';
import type { UpdateCheck } from './ota.ts';

export const ago = (t: number | null | undefined, now: number): string => {
  if (!t) return 'never';
  const m = Math.round((now - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** While the hub is busy with its own update: what's happening, in words. Null when it's idle. */
export function hubProgress(u: Pick<HubUpdate, 'state' | 'available'>): string | null {
  switch (u.state) {
    case 'requested': return 'Asked the hub. It starts in a moment.';
    case 'checking': return 'Looking for a newer Kova…';
    case 'updating': return `Installing Kova ${u.available?.version ?? 'the new version'}. It backs up first, restarts in a minute or two, and this app reconnects by itself.`;
    default: return null;
  }
}

export interface HistoryRow { key: string; icon: string; tone: 'ok' | 'warn' | 'error'; title: string; sub: string }

/** The hub's update history, newest first: what happened, when. Falls back to the last result on older hubs. */
export function historyRows(u: Pick<HubUpdate, 'history' | 'last'>, now: number, max = 6): HistoryRow[] {
  const list = u.history?.length ? u.history : u.last ? [u.last] : [];
  return [...list].sort((a, b) => b.at - a.at).slice(0, max).map(h => {
    const when = new Date(h.at);
    const date = `${when.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\bSept\b/, 'Sep')} · ${ago(h.at, now)}`;
    if (h.result === 'updated') return { key: `${h.at}`, icon: 'check_circle', tone: 'ok', title: `Updated ${h.from} → ${h.to}`, sub: date };
    if (h.result === 'rolled-back') return { key: `${h.at}`, icon: 'sync_problem', tone: 'warn', title: `Went back to ${h.from}`, sub: `The new version didn’t start properly. ${date}` };
    return { key: `${h.at}`, icon: 'error', tone: 'error', title: `Update to ${h.to} failed`, sub: `${h.from} kept running. ${date}` };
  });
}

/** The line under Settings in More when something is waiting: the hub's update first, then the app's. Null when nothing is. */
export function updateNotice(hub: Pick<HubUpdate, 'available' | 'state'> | null | undefined, app: Pick<UpdateCheck, 'state' | 'version'>): string | null {
  if (hub && hub.state === 'updating') return 'Kova is updating on your hub';
  if (hub?.available) return `Kova ${hub.available.version} is ready to install on your hub`;
  if (app.state === 'ready') return app.version ? `App update ${app.version} ready: restart to use it` : 'App update ready: restart to use it';
  return null;
}
