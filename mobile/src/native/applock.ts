import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { getItem, setItem } from './storage';

// Locking the app behind Face ID, Touch ID or the phone's fingerprint (or its passcode when those fail). Off until
// turned on in This phone. A binary without the module (app 0.3.x before the 0.4 store build) hides it.

type LA = typeof import('expo-local-authentication');
const la: LA | null = Platform.OS !== 'web' && requireOptionalNativeModule('ExpoLocalAuthentication') ? require('expo-local-authentication') as LA : null;

const KEY = 'kova.appLock';
/** Back from the background after this long, the app asks again. */
export const RELOCK_MS = 60_000;

/** What this phone can unlock with: "Face ID", "Touch ID", "Fingerprint", "Face unlock"; null when it can't (none set up, or no module). */
export async function lockKind(): Promise<string | null> {
  if (!la) return null;
  try {
    if (!(await la.hasHardwareAsync()) || !(await la.isEnrolledAsync())) return null;
    const types = await la.supportedAuthenticationTypesAsync();
    const face = types.includes(la.AuthenticationType.FACIAL_RECOGNITION), finger = types.includes(la.AuthenticationType.FINGERPRINT);
    if (Platform.OS === 'ios') return face ? 'Face ID' : finger ? 'Touch ID' : 'your passcode';
    return finger ? 'your fingerprint' : face ? 'face unlock' : 'your screen lock';
  } catch { return null; }
}

export async function lockOn(): Promise<boolean> { return la ? (await getItem(KEY).catch(() => null)) === 'on' : false; }
export const setLockOn = (on: boolean) => setItem(KEY, on ? 'on' : null).catch(() => {});

/** Ask the phone to check it's you. True when it did. */
export async function unlock(prompt = 'Unlock Kova'): Promise<boolean> {
  if (!la) return true;
  try {
    const r = await la.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use passcode' });
    return r.success;
  } catch { return false; }
}
