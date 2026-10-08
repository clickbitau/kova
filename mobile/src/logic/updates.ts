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

export interface StepRow { label: string; state: 'done' | 'now' | 'next' }

/**
 * The update's steps for the progress bar: each done, now or next, the share done (0–1), and the line under it. While
 * the hub restarts it can't answer, so `away` (the app lost it mid-update) keeps the restart step showing, with words
 * for it. Null when nothing is being installed.
 */
export function updateSteps(u: Pick<HubUpdate, 'state' | 'progress' | 'available'>, o: { away?: boolean; now?: number } = {}): { rows: StepRow[]; share: number; line: string; bad: boolean } | null {
  if (u.state !== 'updating' && u.state !== 'requested') return null;
  const p = u.progress;
  const steps = p?.steps?.length ? p.steps : ['Downloading', 'Unpacking and checking', 'Backing up your home', 'Restarting Kova', 'Making sure it started properly'];
  // Asked, not started: nothing done yet. Away mid-update: at least at the restart.
  let step = u.state === 'requested' ? -1 : Math.min(p?.step ?? 0, steps.length - 1);
  if (o.away && u.state === 'updating') step = Math.max(step, steps.length - 2);
  const rows = steps.map((label, i): StepRow => ({ label, state: i < step ? 'done' : i === step ? 'now' : 'next' }));
  const share = Math.max(0.04, (step + 0.5) / steps.length);
  const mins = p?.startedAt && o.now ? Math.max(0, Math.round((o.now - p.startedAt) / 60_000)) : null;
  const took = mins != null && mins >= 1 ? ` · ${mins} min so far` : '';
  const line = u.state === 'requested' ? 'Asked the hub. It starts in a moment.'
    : p?.rollingBack ? `${p.label}. Your home keeps working.`
    : o.away ? `Kova is restarting, so this app can’t reach it for a minute or so. It reconnects by itself${took}.`
    : `${p?.label ?? steps[Math.max(0, step)]}…${took}`;
  return { rows, share, line, bad: !!p?.rollingBack };
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
