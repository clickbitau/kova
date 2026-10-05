// Arriving and leaving by location: a circle around the home the phone watches.

export interface LatLon { latitude: number; longitude: number; radiusM?: number }

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const R = 6371_000, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Big enough that GPS drift at home never says "left" (iOS won't reliably watch anything under 100 m). */
export const HOME_RADIUS_M = 150;

export const GEOFENCE_TASK = 'kova-home-geofence';

/** A region event → what to tell the hub. Leaving only counts once well outside, so the edge doesn't flap. */
export function presenceFor(event: 'enter' | 'exit', where?: LatLon | null, home?: LatLon | null): boolean | null {
  if (event === 'enter') return true;
  if (where && home && distanceM(where, home) < (home.radiusM ?? HOME_RADIUS_M)) return null;
  return false;
}
