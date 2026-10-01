import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { CHECK_EVERY_MS, manifestUrl, overrideNeeded } from '../logic/ota';
import { getItem, setItem } from './storage';
import version from '../version.json';

/**
 * Updating the app from the Kova hub it's connected to (the same model as Helix: the bundle
 * comes off the box on the LAN, so it works with the internet down and never touches a cloud).
 *
 * The address isn't known when the app is built, so app.json carries a placeholder and the
 * real one is set here once the phone knows its hub (`disableAntiBrickingMeasures` allows it).
 * A downloaded update is used from the next cold start. In development, Expo Go and the web
 * build there's nothing to update (`Updates.isEnabled` is false) and every call is a no-op.
 */
const KEY = 'kova.ota.updateUrl';
let lastCheck = 0;
let checking: Promise<void> | null = null;

/** What's running: this bundle's version, and the native train it needs. */
export const running = { version: version.version, train: version.train, store: version.store };

export async function pointUpdatesAtHub(hubUrl: string): Promise<void> {
  if (Platform.OS === 'web' || !Updates.isEnabled || !hubUrl) return;
  const url = manifestUrl(hubUrl);
  const written = await getItem(KEY).catch(() => null);
  if (!overrideNeeded(url, written)) return;
  try {
    Updates.setUpdateURLAndRequestHeadersOverride({ updateUrl: url, requestHeaders: {} });
    await setItem(KEY, url);
  } catch {
    // A build without the override compiled in: keep running what we have.
  }
}

/** Ask the hub for a newer bundle and download it; it runs from the next launch. Resolves true when one is ready. */
export function checkForAppUpdate(force = false): Promise<boolean> {
  if (Platform.OS === 'web' || !Updates.isEnabled) return Promise.resolve(false);
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve(false);
  let ready = false;
  checking ??= (async () => {
    lastCheck = Date.now();
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) return;
      const got = await Updates.fetchUpdateAsync();
      ready = got.isNew;
    } catch {
      // The hub has nothing for this train, or isn't reachable: carry on with this bundle.
    }
  })().finally(() => { checking = null; });
  return checking.then(() => ready);
}

/** Restart into the downloaded update now. */
export function applyAppUpdate(): Promise<void> {
  return Updates.isEnabled ? Updates.reloadAsync() : Promise.resolve();
}
