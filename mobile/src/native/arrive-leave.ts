import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { GEOFENCE_TASK, HOME_RADIUS_M, presenceFor, type LatLon } from '../logic/geo';
import { getJson, setJson } from './storage';

// Arriving and leaving from this phone's location. The OS watches a circle around the home and wakes the app
// on crossing it, even when the app isn't running. The report goes straight to the hub with this person's own
// key (from /api/presence/setup), which can only say whether this one person is home.

const KEY = 'kova.arriveLeave';

export interface ArriveLeave { hubUrl: string; personId: string; key: string; home: LatLon }

export async function report(c: ArriveLeave, home: boolean): Promise<void> {
  const url = `${c.hubUrl}/api/people/${encodeURIComponent(c.personId)}/presence?key=${encodeURIComponent(c.key)}`;
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
  await Location.startGeofencingAsync(GEOFENCE_TASK, [{ identifier: 'home', latitude: c.home.latitude, longitude: c.home.longitude, radius: HOME_RADIUS_M, notifyOnEnter: true, notifyOnExit: true }]);
  return { ok: true };
}

export async function stopArriveLeave(): Promise<void> {
  await setJson(KEY, null);
  if (Platform.OS !== 'web' && await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
}

export async function arriveLeaveOn(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return !!(await getJson<ArriveLeave>(KEY)) && await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
}
