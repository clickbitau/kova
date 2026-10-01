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
