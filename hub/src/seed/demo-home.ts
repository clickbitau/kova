import type { HomeConfig, Targets } from '../model/types.ts';
import type { DeviceInfo } from '../adapters/sdk.ts';

// A demo home modelled on a real one (the owner's former Home Assistant setup):
// 28 devices, 10 rooms, the routines rebuilt as 5 modes, 2 moments,
// 6 overlays and 1 behaviour. Used by the virtual adapter and first-run config.

type Row = [id: string, name: string, room: string, type: DeviceInfo['type'], integration: string];
const T = 'Tuya (local)';
const ROWS: Row[] = [
  ['lounge_main', 'Ceiling', 'lounge', 'light', T],
  ['lounge_down', 'Downlights', 'lounge', 'light', T],
  ['lamp', 'Lamp', 'lounge', 'dimmer', 'TP-Link L535'],
  ['tv_backlight', 'TV backlight', 'lounge', 'dimmer', 'Tuya'],
  ['lounge_purifier', 'Purifier', 'lounge', 'fan', 'VeSync Levoit'],
  ['living_display', 'Living room display', 'lounge', 'media', 'Google Cast'],
  ['kitchen_ceiling', 'Ceiling', 'kitchen', 'light', T],
  ['kitchen_island', 'Island', 'kitchen', 'light', T],
  ['dining', 'Dining light', 'kitchen', 'light', T],
  ['office_light', 'Ceiling', 'office', 'light', T],
  ['office_strip', 'LED strip', 'office', 'dimmer', 'Tuya'],
  ['office_plug', 'Desk plug', 'office', 'plug', 'TP-Link P100'],
  ['office_cam', 'Camera', 'office', 'camera', 'Google Nest'],
  ['master_purifier', 'Purifier', 'master', 'fan', 'VeSync Levoit'],
  ['master_speaker', 'Speaker', 'master', 'media', 'Google Cast'],
  ['bedroom_tv', 'Bedroom OLED', 'master', 'tv', 'Samsung TV'],
  ['music_light', 'Ceiling', 'music', 'light', T],
  ['music_speaker', 'Speaker', 'music', 'media', 'Google Cast'],
  ['baby_light', 'Ceiling', 'baby', 'light', T],
  ['baby_speaker', 'Speaker', 'baby', 'media', 'Google Cast'],
  ['guest_speaker', 'Speaker', 'guest', 'media', 'Google Cast'],
  ['laundry_1', 'Ceiling', 'laundry', 'light', T],
  ['laundry_2', 'Bench light', 'laundry', 'light', T],
  ['garage_light', 'Light', 'garage', 'light', T],
  ['garage_cam', 'Camera', 'garage', 'camera', 'Google Nest'],
  ['front_1', 'Porch light', 'front', 'light', T],
  ['front_2', 'Path lights', 'front', 'light', T],
  ['doorbell', 'Doorbell', 'front', 'camera', 'Google Nest'],
  ['solar_inverter', 'Solar inverter', 'garage', 'sensor', 'GoodWe (simulated)'],
];

/** The demo home's simulated solar array (about 3 kW, like the real one). */
export const DEMO_SOLAR = { id: 'solar_inverter', lat: -31.95, lon: 115.86, peakW: 2900, tz: 'Australia/Perth' };

export function demoDevices(): DeviceInfo[] {
  return ROWS.map(([id, name, room, type, integration]) => ({
    id, name, room, type, integration, address: `demo.${id}`,
    capabilities: id === 'solar_inverter' ? ['power', 'energy'] : type === 'dimmer' ? (id === 'lamp' ? ['onoff', 'brightness', 'colorTemp', 'color'] : ['onoff', 'brightness']) : [],
    state: type === 'fan' ? { on: true, mode: 'Auto' }
      : type === 'media' || type === 'tv' ? { on: false, media: null, vol: 30 }
      : type === 'dimmer' ? { on: false, bri: 100, k: id === 'lamp' ? 3000 : null, color: null }
      : type === 'plug' ? { on: true, power: 14 }
      : type === 'camera' || type === 'sensor' ? { online: true }
      : { on: false },
  }));
}

const LIGHTS = ROWS.filter(r => r[3] === 'light' || r[3] === 'dimmer').map(r => r[0]);
const SPK = ['living_display', 'music_speaker', 'guest_speaker', 'baby_speaker'];
const off = (ids: string[]): Targets => Object.fromEntries(ids.map(i => [i, { on: false }]));
const play = (ids: string[], media: string, vol: number): Targets => Object.fromEntries(ids.map(i => [i, { on: true, media, vol }]));
const stop = (ids: string[]): Targets => Object.fromEntries(ids.map(i => [i, { on: false, media: null }]));

export function demoConfig(): HomeConfig {
  return {
    name: 'The Ahmeds',
    timezone: 'Australia/Perth',
    latitude: -31.95,
    longitude: 115.86,
    prayerMethod: 'MuslimWorldLeague',
    rooms: [
      { id: 'lounge', name: 'Lounge', icon: 'weekend' },
      { id: 'kitchen', name: 'Kitchen', icon: 'kitchen' },
      { id: 'office', name: 'Office', icon: 'desk' },
      { id: 'master', name: 'Master bed', icon: 'bed' },
      { id: 'music', name: 'Music room', icon: 'music_note' },
      { id: 'baby', name: 'Baby room', icon: 'crib' },
      { id: 'guest', name: 'Guest room', icon: 'single_bed' },
      { id: 'laundry', name: 'Laundry', icon: 'local_laundry_service' },
      { id: 'garage', name: 'Garage', icon: 'garage_home' },
      { id: 'front', name: 'Front door', icon: 'door_front' },
    ],
    people: [
      { id: 'methel', name: 'Methel', detail: 'iPhone Air' },
      { id: 'brishti', name: 'Brishti', detail: 'iPhone' },
    ],
    modes: [
      { id: 'day', name: 'Day', color: '#dcd27e', icon: 'light_mode', start: { kind: 'sun', event: 'sunrise' },
        targets: { ...off(LIGHTS), lounge_purifier: { mode: 'Auto' }, master_purifier: { mode: 'Auto' } } },
      { id: 'evening', name: 'Evening', color: '#f2b14c', icon: 'wb_twilight', start: { kind: 'sun', event: 'sunset', offsetMin: -10 }, lightTheWay: true,
        targets: {
          kitchen_ceiling: { on: true }, front_1: { on: true }, front_2: { on: true }, laundry_2: { on: true },
          lounge_main: { on: true }, garage_light: { on: true },
          lamp: { on: true, bri: 78, k: 3000, color: null }, tv_backlight: { on: true, bri: 31 },
        } },
      { id: 'wind', name: 'Wind down', color: '#ef8f6e', icon: 'nights_stay', start: { kind: 'time', at: '20:00' }, lightTheWay: true,
        targets: {
          ...off(['music_light', 'kitchen_island', 'dining', 'lounge_main', 'front_2', 'laundry_2', 'front_1', 'garage_light']),
          lamp: { on: true, bri: 5, k: 2000, color: null }, tv_backlight: { on: true, bri: 16 },
        } },
      { id: 'night', name: 'Night', color: '#8aaef0', icon: 'bedtime', start: { kind: 'time', at: '23:30' }, lightTheWay: true,
        targets: play(SPK, 'Tarateel', 15) },
      { id: 'dawn', name: 'Dawn', color: '#d8a6e0', icon: 'wb_sunny', start: { kind: 'prayer', prayer: 'fajr' }, lightTheWay: true,
        targets: stop(SPK) },
    ],
    moments: [
      { id: 'rain', label: 'Rain sounds', what: 'Master bed speaker at 60%', at: { kind: 'time', at: '21:00' }, targets: play(['master_speaker'], 'Rain sounds', 60) },
      { id: 'rainstop', label: 'Rain sounds stop', what: 'Master bed speaker stops', at: { kind: 'time', at: '07:00' }, targets: stop(['master_speaker']) },
    ],
    overlays: [
      { id: 'movie', name: 'Movie', icon: 'movie', endsLabel: 'Ends when the TV turns off', ends: { kind: 'device_off', device: 'living_display' },
        targets: { ...off(['lounge_down', 'kitchen_island', 'dining', 'office_light', 'office_strip', 'kitchen_ceiling', 'front_1', 'music_light']),
          lamp: { on: true, bri: 8, k: 2500, color: null }, tv_backlight: { on: true, bri: 12 }, lounge_purifier: { mode: 'Sleep' }, master_purifier: { mode: 'Sleep' } } },
      { id: 'date', name: 'Date', icon: 'favorite', endsLabel: 'Ends at midnight', ends: { kind: 'time', at: { kind: 'time', at: '00:00' } },
        targets: { ...off(['lounge_down', 'kitchen_island', 'office_light', 'office_strip', 'kitchen_ceiling', 'front_1', 'music_light']),
          lamp: { on: true, bri: 30, k: null, color: '#ff8c64' }, tv_backlight: { on: true, bri: 20 }, dining: { on: true },
          living_display: { on: true, media: 'Jazz stream', vol: 25 }, lounge_purifier: { mode: 'Sleep' }, master_purifier: { mode: 'Sleep' } } },
      { id: 'party', name: 'Party', icon: 'celebration', endsLabel: 'Ends when you end it', ends: { kind: 'manual' },
        targets: { lounge_down: { on: true }, kitchen_island: { on: true }, dining: { on: true }, music_light: { on: true },
          lamp: { on: true, bri: 100, k: null, color: '#0096ff' }, tv_backlight: { on: true, bri: 100 }, office_strip: { on: true, bri: 100 },
          ...play([...SPK, 'master_speaker'], 'Party stream', 50), lounge_purifier: { mode: 'Auto' }, master_purifier: { mode: 'Auto' } } },
      { id: 'good_night', name: 'Good night', icon: 'bedtime', endsLabel: 'Ends at sunrise', ends: { kind: 'time', at: { kind: 'sun', event: 'sunrise' } },
        targets: { ...off(LIGHTS.filter(i => i !== 'lamp')), lamp: { on: true, bri: 10, k: 2700, color: null }, ...stop([...SPK, 'master_speaker']),
          lounge_purifier: { mode: 'Sleep' }, master_purifier: { mode: 'Sleep' } } },
      { id: 'away', name: 'Away', icon: 'flight_takeoff', endsLabel: 'Ends when someone comes home', ends: { kind: 'arrival' }, allOff: true, targets: {} },
      { id: 'guests', name: 'Guests', icon: 'luggage', endsLabel: 'Ends when you end it', ends: { kind: 'manual' }, targets: {} },
    ],
    lightTheWay: {
      triggers: [
        { id: 'front_person', on: { device: 'doorbell', event: 'person' }, label: 'doorbell camera saw someone', lights: ['front_1', 'front_2'], minutes: 5 },
        { id: 'doorbell_ring', on: { device: 'doorbell', event: 'ring' }, label: 'doorbell rang', lights: ['front_1', 'front_2'], minutes: 5 },
        { id: 'garage_person', on: { device: 'garage_cam', event: 'person' }, label: 'garage camera saw someone', lights: ['garage_light'], minutes: 10 },
        { id: 'office_person', on: { device: 'office_cam', event: 'person' }, label: 'office camera saw someone', lights: ['office_light', 'office_strip'], minutes: 10 },
        { id: 'arrival', on: { arrival: true }, label: 'someone came home', lights: ['garage_light', 'front_1', 'front_2'], minutes: 10 },
      ],
    },
    sources: [
      { name: 'Tarateel', icon: 'menu_book' },
      { name: 'Rain sounds', icon: 'thunderstorm' },
      { name: 'Jazz stream', icon: 'piano' },
      { name: 'Party stream', icon: 'celebration' },
      { name: 'Radio', icon: 'radio' },
    ],
    groups: {},
    dismissedFindings: [],
  };
}
