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
