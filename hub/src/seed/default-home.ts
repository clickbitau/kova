import type { HomeConfig } from '../model/types.ts';

/**
 * A new home's starting point: the five time-of-day modes and six overlays,
 * with no device targets yet. Rooms, people and location come from setup or import.
 */
export function defaultHome(base: Pick<HomeConfig, 'name' | 'timezone' | 'latitude' | 'longitude' | 'rooms' | 'people'>): HomeConfig {
  return {
    ...base,
    prayerMethod: 'MuslimWorldLeague',
    modes: [
      { id: 'day', name: 'Day', color: '#dcd27e', icon: 'light_mode', start: { kind: 'sun', event: 'sunrise' }, targets: {} },
      { id: 'evening', name: 'Evening', color: '#f2b14c', icon: 'wb_twilight', start: { kind: 'sun', event: 'sunset', offsetMin: -10 }, targets: {}, lightTheWay: true },
      { id: 'wind', name: 'Wind down', color: '#ef8f6e', icon: 'nights_stay', start: { kind: 'time', at: '20:00' }, targets: {}, lightTheWay: true },
      { id: 'night', name: 'Night', color: '#8aaef0', icon: 'bedtime', start: { kind: 'time', at: '23:30' }, targets: {}, lightTheWay: true },
      { id: 'dawn', name: 'Dawn', color: '#d8a6e0', icon: 'wb_sunny', start: { kind: 'prayer', prayer: 'fajr' }, targets: {}, lightTheWay: true },
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
