import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { getItem, setItem } from './storage';

// Notifications from the hub (doorbell, everyone's out, the internet dropped…) reach the app through Expo's
// push service: the app gives the hub its Expo push token, and the hub sends to it (see hub/src/services/notify.ts).

const KEY = 'kova.pushToken';

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

/** The notification the user last tapped (none in the web build, which has no notifications). */
export const useLastTap: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === 'web' ? () => null : Notifications.useLastNotificationResponse;

export type PushResult = { ok: true; token: string } | { ok: false; why: string };

export async function pushToken(): Promise<PushResult> {
  if (Platform.OS === 'web') return { ok: false, why: 'Notifications need the phone app.' };
  if (!Device.isDevice) return { ok: false, why: 'Notifications need a real phone, not a simulator.' };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Kova', importance: Notifications.AndroidImportance.HIGH, sound: 'default' });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, why: 'Allow notifications for Kova in Settings.' };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) return { ok: false, why: 'This build has no Expo project id, so it can’t get a push token (see mobile/README.md).' };
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId });
    await setItem(KEY, t.data);
    return { ok: true, token: t.data };
  } catch (e) {
    return { ok: false, why: `Couldn’t get a push token: ${(e as Error).message}` };
  }
}

export const savedPushToken = () => getItem(KEY);
export const forgetPushToken = () => setItem(KEY, null);

export { routeFor } from '../logic/links';
