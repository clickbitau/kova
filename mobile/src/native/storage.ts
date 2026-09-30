import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// The hub address and token live in the Keychain / Keystore; on the web build, in localStorage.
const web = Platform.OS === 'web';

export async function getItem(key: string): Promise<string | null> {
  if (web) { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } }
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string | null): Promise<void> {
  if (web) { try { if (value == null) globalThis.localStorage?.removeItem(key); else globalThis.localStorage?.setItem(key, value); } catch { /* private mode */ } return; }
  if (value == null) await SecureStore.deleteItemAsync(key); else await SecureStore.setItemAsync(key, value);
}

export async function getJson<T>(key: string): Promise<T | null> {
  const s = await getItem(key);
  try { return s ? JSON.parse(s) as T : null; } catch { return null; }
}

export const setJson = (key: string, v: unknown) => setItem(key, v == null ? null : JSON.stringify(v));
