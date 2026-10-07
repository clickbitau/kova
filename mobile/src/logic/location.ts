// Settings → Where the home is: what's on the map before it's saved, and what Save sends (mirrors the web app).

import { clampRadius } from './map-page.ts';

export type LocationSource = 'manual' | 'geocode' | 'phone' | 'import' | 'map';
export const DEFAULT_RADIUS_M = 150;

/** The pin before it's saved: where it came from decides whose point it is. */
export interface Pin {
  latitude: number;
  longitude: number;
  source: LocationSource;
  /** An address search's match: Google's (with its place id) or OpenStreetMap's. Absent for the owner's own point. */
  provider?: 'google' | 'osm';
  placeId?: string;
  address?: string | null;
  label?: string | null;
}
export interface Saved { latitude: number; longitude: number; radiusM?: number; source?: LocationSource; provider?: 'google' | 'osm' }
/** One address search match (GET /api/geocode). Google's come without coordinates until picked. */
export interface Found { label: string; latitude?: number; longitude?: number; placeId?: string; provider?: 'google' | 'osm' }
/** What the hub made of a paste (POST /api/location/parse). */
export interface Located { latitude: number; longitude: number; label?: string; address?: string; provider?: 'google' | 'osm'; placeId?: string }

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const hasPoint = (p: { latitude: number; longitude: number } | null | undefined): p is { latitude: number; longitude: number } => !!p && (!!p.latitude || !!p.longitude);

/** A match picked from the address search (Google's after Place Details). */
export function pinFromFound(f: Found & { latitude: number; longitude: number }): Pin {
  return { latitude: f.latitude, longitude: f.longitude, source: 'geocode', provider: f.provider ?? 'osm', ...(f.placeId ? { placeId: f.placeId } : {}), address: f.label, label: null };
}

/** A paste: its own coordinates are the owner's ("map"); a name the hub looked up is the search's. */
export function pinFromPaste(r: Located): Pin {
  return { latitude: r.latitude, longitude: r.longitude, source: r.provider ? 'geocode' : 'map', ...(r.provider ? { provider: r.provider } : {}), ...(r.placeId ? { placeId: r.placeId } : {}), address: r.address ?? r.label ?? null, label: r.label ?? null };
}

/** Dragged or tapped on the map: the owner's own point, whatever it was (Google's id is dropped). */
export function pinMoved(prev: Pin | null, to: { latitude: number; longitude: number }): Pin {
  return { latitude: r6(to.latitude), longitude: r6(to.longitude), source: 'map', address: prev?.address ?? null, label: prev?.label ?? null };
}

/** Google's points only go on Google's map (its terms). */
export const isGoogle = (p: { provider?: string } | null | undefined) => p?.provider === 'google';

/**
 * PUT /api/home's body for Save, or null when nothing changed. Only the circle: just the radius. The phone's own
 * timezone goes with the phone's location, as the hub's best guess for it.
 */
export function saveBody(o: { pin: Pin | null; radiusM: number; saved: Saved | null; address?: string; savedAddress?: string | null; timezone?: string }): Record<string, unknown> | null {
  const radiusM = clampRadius(o.radiusM);
  const radiusChanged = radiusM !== (o.saved?.radiusM ?? DEFAULT_RADIUS_M);
  if (!o.pin) return radiusChanged ? { location: { radiusM } } : null;
  const p = o.pin, address = o.address?.trim();
  return {
    location: { latitude: p.latitude, longitude: p.longitude, radiusM, source: p.source, ...(p.provider ? { provider: p.provider } : {}), ...(p.placeId ? { placeId: p.placeId } : {}) },
    ...(address && address !== (o.savedAddress ?? '') ? { address } : {}),
    ...(p.source === 'phone' && o.timezone ? { timezoneHint: o.timezone } : {}),
  };
}

const SOURCE: Record<LocationSource, string> = { map: 'Placed on the map', manual: 'Typed in', geocode: 'From the address search', phone: 'From a phone’s location', import: 'From Home Assistant' };
export const sourceLabel = (s?: LocationSource) => (s && SOURCE[s]) || 'Saved';

export const coordsText = (p: { latitude: number; longitude: number }, radiusM: number) => `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} · ${radiusM} m circle`;

/** Google's map of a point and the circle, through the hub (the key stays there). */
export const staticMapPath = (p: { latitude: number; longitude: number }, radiusM: number, w = 640, h = 320) =>
  `/api/maps/static?lat=${p.latitude}&lon=${p.longitude}&r=${radiusM}&w=${w}&h=${h}`;
