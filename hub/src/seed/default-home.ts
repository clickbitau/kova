import type { HomeConfig } from '../model/types.ts';
import { TZ_PLACES } from '../util/tz-places.ts';

/**
 * A new home's starting point: the five time-of-day modes and six overlays,
 * with no device targets yet. Rooms, people and location come from setup or import.
 * Nothing faith- or region-specific: prayer times are an integration the owner turns on.
 */
export function defaultHome(base: Pick<HomeConfig, 'name' | 'timezone' | 'latitude' | 'longitude' | 'rooms' | 'people'>): HomeConfig {
  return {
    ...base,
    modes: [
      { id: 'day', name: 'Day', color: '#dcd27e', icon: 'light_mode', start: { kind: 'sun', event: 'sunrise' }, targets: {} },
      { id: 'evening', name: 'Evening', color: '#f2b14c', icon: 'wb_twilight', start: { kind: 'sun', event: 'sunset', offsetMin: -10 }, targets: {}, lightTheWay: true },
      { id: 'wind', name: 'Wind down', color: '#ef8f6e', icon: 'nights_stay', start: { kind: 'time', at: '20:00' }, targets: {}, lightTheWay: true },
      { id: 'night', name: 'Night', color: '#8aaef0', icon: 'bedtime', start: { kind: 'time', at: '23:30' }, targets: {}, lightTheWay: true },
      { id: 'dawn', name: 'Dawn', color: '#d8a6e0', icon: 'wb_sunny', start: { kind: 'sun', event: 'sunrise', offsetMin: -45 }, targets: {}, lightTheWay: true },
    ],
    moments: [],
    overlays: [
      { id: 'movie', name: 'Movie', icon: 'movie', endsLabel: 'Ends when you end it', ends: { kind: 'manual' }, targets: {} },
      { id: 'date', name: 'Date', icon: 'favorite', endsLabel: 'Ends at midnight', ends: { kind: 'time', at: { kind: 'time', at: '00:00' } }, targets: {} },
      { id: 'party', name: 'Party', icon: 'celebration', endsLabel: 'Ends when you end it', ends: { kind: 'manual' }, targets: {} },
      { id: 'good_night', name: 'Good night', icon: 'bedtime', endsLabel: 'Ends at sunrise', ends: { kind: 'time', at: { kind: 'sun', event: 'sunrise' } }, targets: {} },
      { id: 'away', name: 'Away', icon: 'flight_takeoff', endsLabel: 'Ends when someone comes home', ends: { kind: 'arrival' }, allOff: true, targets: {} },
      { id: 'guests', name: 'Guests', icon: 'luggage', endsLabel: 'Ends when you end it', ends: { kind: 'manual' }, targets: {} },
    ],
    lightTheWay: { triggers: [] },
    sources: [{ name: 'Radio', icon: 'radio' }],
    groups: {},
    dismissedFindings: [],
  };
}

/** The timezone this hub's clock is set to, when it's a real zone (else UTC). */
export function systemZone(): string {
  const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return z && z !== 'Etc/Unknown' ? z : 'UTC';
}

/**
 * A brand-new hub's home, before its owner has set anything: no rooms, people or devices, its clock's timezone, and
 * that zone's reference city as a first guess at where it is (sun times work from the first minute; setup asks for
 * the real address). `firstRun` until the owner has gone through setup.
 */
export function newHome(timezone = systemZone()): HomeConfig {
  const at = TZ_PLACES.find(p => p.zone === timezone);
  return { ...defaultHome({ name: 'Home', timezone, latitude: at?.latitude ?? 0, longitude: at?.longitude ?? 0, rooms: [], people: [] }), firstRun: true };
}
