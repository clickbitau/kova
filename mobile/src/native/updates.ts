import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { CHECK_EVERY_MS, manifestInfo, manifestUrl, notesBetween, overrideNeeded, updateBase, updateError, type UpdateCheck } from '../logic/ota';
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

/**
 * Point the updater at one of the hub's addresses (logic/ota.ts updateBase says which, and why it doesn't follow
 * every switch between home and away). Resolves to the hub address updates come from, or null when there are none.
 */
export async function pointUpdatesAtHub(addresses: { url: string; kind: 'local' | 'remote' }[], current: string | null): Promise<string | null> {
  if (Platform.OS === 'web' || !Updates.isEnabled) return null;
  const written = await getItem(KEY).catch(() => null);
  const base = updateBase(addresses, written, current);
  if (!base) return null;
  const url = manifestUrl(base);
  if (!overrideNeeded(url, written)) return base;
  try {
    Updates.setUpdateURLAndRequestHeadersOverride({ updateUrl: url, requestHeaders: {} });
    await setItem(KEY, url);
  } catch {
    // A build without the override compiled in: keep running what we have.
  }
  return base;
}

// The latest check, shared with whoever shows it (More → App updates), and kept current.
let status: UpdateCheck = { state: Platform.OS === 'web' || !Updates.isEnabled ? 'unsupported' : 'idle' };
const listeners = new Set<(c: UpdateCheck) => void>();
const set = (c: UpdateCheck) => { status = c; listeners.forEach(f => f(c)); };

/** Follow the update status (More shows it). */
export function useAppUpdate(): UpdateCheck {
  const [c, setC] = useState(status);
  useEffect(() => { listeners.add(setC); setC(status); return () => { listeners.delete(setC); }; }, []);
  return c;
}

/**
 * Ask the hub for a newer bundle and download it; it runs from the next launch, or now with applyAppUpdate().
 * Resolves with what happened: up to date, ready (with its version and notes), or why it couldn't check.
 * Without `force`, at most one check per CHECK_EVERY_MS (it then resolves with the last result).
 */
export function checkForAppUpdate(force = false): Promise<UpdateCheck> {
  if (Platform.OS === 'web' || !Updates.isEnabled) return Promise.resolve(status);
  if (status.state === 'ready') return Promise.resolve(status);
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve(status);
  checking ??= (async () => {
    lastCheck = Date.now();
    set({ ...status, state: 'checking' });
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) { set({ state: 'current', at: Date.now() }); return; }
      const info = manifestInfo(found.manifest as Parameters<typeof manifestInfo>[0]);
      const got = await Updates.fetchUpdateAsync();
      set(got.isNew ? { state: 'ready', ...info, notes: info.notes ? notesBetween(info.notes, running.version, info.version) : undefined, at: Date.now() } : { state: 'current', at: Date.now() });
    } catch (e) {
      // The hub has nothing for this train, or isn't reachable: carry on with this bundle.
      set({ state: 'unreachable', error: updateError(e), at: Date.now() });
    }
  })().finally(() => { checking = null; });
  return checking.then(() => status);
}

/** Restart into the downloaded update now. */
export function applyAppUpdate(): Promise<void> {
  return Updates.isEnabled ? Updates.reloadAsync() : Promise.resolve();
}
