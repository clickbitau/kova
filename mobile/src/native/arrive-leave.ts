import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { hello } from '../api/client';
import { chooseAddress, type HubAddress } from '../logic/addresses';
import { GEOFENCE_TASK, HOME_RADIUS_M, homeMoved, presenceFor, type LatLon } from '../logic/geo';
import { getJson, setJson } from './storage';

// Arriving and leaving from this phone's location. The OS watches a circle around the home and wakes the app
// on crossing it, even when the app isn't running. The report goes straight to the hub with this person's own
// key (from /api/presence/setup), which can only say whether this one person is home.

const KEY = 'kova.arriveLeave';

export interface ArriveLeave {
  /** The hub's address when this was turned on (the one used when there's no list). */
  hubUrl: string;
  /** Every address of the hub, and its ID: crossing the circle, the phone is often between home Wi-Fi and not. */
  addresses?: HubAddress[];
  hubId?: string | null;
  personId: string;
  key: string;
  home: LatLon;
}

export async function report(c: ArriveLeave, home: boolean): Promise<void> {
  // Whichever address answers as this hub (home network first), before the person's key goes to it.
  const list = c.addresses?.length ? c.addresses : [{ url: c.hubUrl, kind: 'local' as const }];
  const to = await chooseAddress(list, { hello, hubId: c.hubId, lastGood: c.hubUrl });
  if (!to) throw new Error('The hub didn’t answer');
  const url = `${to.url}/api/people/${encodeURIComponent(c.personId)}/presence?key=${encodeURIComponent(c.key)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ home, source: 'Kova app (location)' }) });
  if (!res.ok) throw new Error(`Hub said HTTP ${res.status}`);
}

// Must be defined when the JS bundle loads (index.ts imports this file), so a background wake finds it.
if (Platform.OS !== 'web') {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error) return;
    const c = await getJson<ArriveLeave>(KEY);
    if (!c) return;
    const { eventType } = data as { eventType: Location.GeofencingEventType };
    const event = eventType === Location.GeofencingEventType.Enter ? 'enter' : 'exit';
    const where = event === 'exit' ? await Location.getLastKnownPositionAsync().then(p => p?.coords ?? null).catch(() => null) : null;
    const home = presenceFor(event, where, c.home);
    if (home === null) return;
    try { await report(c, home); } catch { /* the hub's own sources (router, Warden) still cover it */ }
  });
}

export type StartResult = { ok: true } | { ok: false; why: string };

export async function startArriveLeave(c: ArriveLeave): Promise<StartResult> {
  if (Platform.OS === 'web') return { ok: false, why: 'Arriving and leaving needs the phone app.' };
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, why: 'Kova needs your location to know when you arrive and leave.' };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return { ok: false, why: 'Choose “Always” for Location in Settings, so Kova notices when the app is closed.' };
  await setJson(KEY, c);
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  await Location.startGeofencingAsync(GEOFENCE_TASK, [{ identifier: 'home', latitude: c.home.latitude, longitude: c.home.longitude, radius: c.home.radiusM ?? HOME_RADIUS_M, notifyOnEnter: true, notifyOnExit: true }]);
  return { ok: true };
}

export async function stopArriveLeave(): Promise<void> {
  await setJson(KEY, null);
  if (Platform.OS !== 'web' && await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
}

/** Keep the background reports' addresses in step with the app's (only when it's on, and only when they changed). */
export async function followHub(addresses: HubAddress[], hubId: string | null, current: string): Promise<void> {
  const c = await getJson<ArriveLeave>(KEY);
  if (!c || !addresses.length) return;
  const next: ArriveLeave = { ...c, hubUrl: current || c.hubUrl, addresses, hubId: hubId ?? c.hubId ?? null };
  if (JSON.stringify(next) !== JSON.stringify(c)) await setJson(KEY, next);
}

/**
 * The home moved, or its circle changed (Settings, on any phone or the web): watch the new circle. Only when
 * arriving and leaving is on and the permission is still there; it never asks for anything. Runs whenever the
 * app sees the hub's state, so every phone picks the change up the next time Kova opens.
 */
export async function followHome(home: LatLon | null | undefined): Promise<boolean> {
  if (Platform.OS === 'web' || !home) return false;
  const c = await getJson<ArriveLeave>(KEY);
  if (!c || !homeMoved(c.home, home)) return false;
  const next: ArriveLeave = { ...c, home: { latitude: home.latitude, longitude: home.longitude, ...(home.radiusM ? { radiusM: home.radiusM } : {}) } };
  await setJson(KEY, next);
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (!bg?.granted || !(await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false))) return false;
  await Location.startGeofencingAsync(GEOFENCE_TASK, [{ identifier: 'home', latitude: next.home.latitude, longitude: next.home.longitude, radius: next.home.radiusM ?? HOME_RADIUS_M, notifyOnEnter: true, notifyOnExit: true }]);
  return true;
}

export async function arriveLeaveOn(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return !!(await getJson<ArriveLeave>(KEY)) && await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
}
