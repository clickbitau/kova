// Over-the-air updates come from the Kova hub the phone is connected to, never Expo's cloud
// (hub/src/api/app-updates.ts serves them). Pure helpers, so they can be tested without a phone.

/** Where expo-updates asks for this app's newest bundle on a hub. */
export function manifestUrl(hubUrl: string): string {
  return `${hubUrl.trim().replace(/\/+$/, '')}/api/app/manifest`;
}

/**
 * Whether the updater's address must be (re)written. Only when the hub's address changed:
 * expo-updates keeps each downloaded update with the URL and headers it came from, and launches
 * only one whose URL and headers equal the override's now. Rewriting it, or changing its headers,
 * would strand every update already on the phone (Helix learned this: back on the built-in
 * bundle after every cold start). So the headers are always {} and the address is written once.
 */
export function overrideNeeded(wanted: string, written: string | null): boolean {
  return !!wanted && wanted !== written;
}

/** At most one check every this long while the app stays open (a cold start always checks). */
export const CHECK_EVERY_MS = 30 * 60_000;

/**
 * Which of the hub's addresses the updater follows. Not simply the one in use: expo-updates files each update under
 * the origin it came from and only launches those whose origin matches the updater's address now, so moving it
 * between the home-network and the remote address with every trip out would strand the update already downloaded
 * (back on an older bundle after a cold start). So it stays on one: the one it's on while that's still one of the
 * hub's, else the first home-network address (updates then work with the internet down), else the one in use.
 * `written` is the manifest URL the updater has now.
 */
export function updateBase(addresses: { url: string; kind: 'local' | 'remote' }[], written: string | null, current: string | null | undefined): string | null {
  const kept = written ? addresses.find(a => manifestUrl(a.url) === written) : undefined;
  if (kept) return kept.url;
  return addresses.find(a => a.kind === 'local')?.url ?? current ?? addresses[0]?.url ?? null;
}

/** Where a check for an app update stands. */
export type UpdateState = 'idle' | 'checking' | 'current' | 'ready' | 'unreachable' | 'unsupported';

export interface UpdateCheck {
  state: UpdateState;
  /** The version found on the hub (when it said), ready for the next start. */
  version?: string;
  /** What changed, newest first, when the hub's bundle carries it. */
  notes?: { version: string; title: string }[];
  /** Why a check failed, in words. */
  error?: string;
  /** When it last finished (epoch ms). */
  at?: number;
}

type Manifest = { extra?: { expoClient?: { version?: unknown; extra?: { kovaHistory?: unknown } } } } | null | undefined;

/** The version and release notes a hub's update manifest carries (export-ota puts them in the bundle's config). */
export function manifestInfo(m: Manifest): { version?: string; notes?: { version: string; title: string }[] } {
  const ec = m?.extra?.expoClient;
  const version = typeof ec?.version === 'string' ? ec.version : undefined;
  const raw = ec?.extra?.kovaHistory;
  const notes = Array.isArray(raw)
    ? raw.filter((h): h is { version: string; title: string } => !!h && typeof h.version === 'string' && typeof h.title === 'string')
    : undefined;
  return { version, notes: notes?.length ? notes : undefined };
}

/** Compare X.Y.Z versions: negative when a is older. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The release notes newer than what's running, up to the version found: what an update brings. */
export function notesBetween(history: { version: string; title: string }[], running: string, found?: string): { version: string; title: string }[] {
  return history.filter(h => compareVersions(h.version, running) > 0 && (!found || compareVersions(h.version, found) <= 0));
}

/** The words for an update check, for the More screen: a title, a line under it, and a tone. */
export function describeUpdate(c: UpdateCheck, runningVersion: string): { title: string; sub: string; tone: 'ok' | 'ready' | 'busy' | 'error' | 'muted' } {
  switch (c.state) {
    case 'checking': return { title: 'Checking for updates…', sub: `Kova ${runningVersion}`, tone: 'busy' };
    case 'ready': return { title: c.version ? `Kova ${c.version} is ready` : 'An update is ready', sub: 'Restart Kova to start using it. Nothing in your home changes.', tone: 'ready' };
    case 'current': return { title: 'Up to date', sub: `Kova ${runningVersion} is the newest your hub has.`, tone: 'ok' };
    case 'unreachable': return { title: 'Couldn’t check for updates', sub: c.error || 'Couldn’t reach the hub.', tone: 'error' };
    case 'unsupported': return { title: `Kova ${runningVersion}`, sub: 'This copy of Kova can’t update over the air. Updates come with the app store.', tone: 'muted' };
    default: return { title: `Kova ${runningVersion}`, sub: 'Updates come from your hub, over your own network.', tone: 'muted' };
  }
}

/** Why a check failed, in words: the hub didn't answer, or it had nothing for this build. */
export function updateError(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!m || /network|connect|timed? ?out|fetch|host|offline|socket|unreachable/i.test(m)) return 'Couldn’t reach the hub. Is this phone on the home network?';
  if (/404|no update|not found|runtime/i.test(m)) return 'Your hub has nothing newer for this version of the app.';
  return 'Your hub didn’t answer as expected. Try again in a moment.';
}
