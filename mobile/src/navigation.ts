import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { Draft, Rhythm } from './logic/automations';

export type Tab = 'Now' | 'Devices' | 'Ask' | 'Security' | 'More';

export type Stack = {
  Tabs: { tab?: Tab } | undefined;
  Modes: undefined;
  Activity: undefined;
  ThisPhone: undefined;
  Automations: undefined;
  /** An automation by id, or a new one (optionally starting from a draft, such as a suggestion). */
  AutomationEditor: { id?: string; draft?: Draft; tab?: 'edit' | 'history'; /** Schedule once: the time first, then what to do. */ schedule?: boolean } | undefined;
  Customise: undefined;
  /** A mode's name, icon, colour, start, what it sets and its moments; or a new mode (no id). */
  ModeEditor: { id?: string } | undefined;
  /** An overlay: its name, icon, how it ends, what it sets; or a new overlay (no id). */
  OverlayEditor: { id?: string } | undefined;
  /** A moment in the day; or a new one (no id), starting at `start`. */
  MomentEditor: { id?: string; start?: Rhythm } | undefined;
  /** More → Sign in a browser: approve a browser's sign-in code; signed-in browsers. */
  Browsers: undefined;
  /** More → Settings: where the home is, its timezone and prayer method, behaviours. */
  Settings: undefined;
  /** Settings → Where the home is: the address search, paste from Google Maps, the map and the circle. */
  HomeLocation: undefined;
  Energy: undefined;
  Media: undefined;
  /** Media → Speaker loudness: each speaker's announcement loudness, with a test. */
  SpeakerLoudness: undefined;
  /** Integrations → Prayer times: on or off, how they're worked out, the call to prayer. */
  PrayerTimes: undefined;
  /** More → Integrations: what's connected, and adding one. */
  Integrations: undefined;
  /** Add integration: the catalog, minus what's set up. */
  IntegrationAdd: undefined;
  /** One integration's status and setup (an integrations.json section id). */
  Integration: { id: string };
  /** A camera: its latest picture, its room and alerts, and what it saw (with the picture of each event). */
  Camera: { id: string };
  /** Sensors by room: readings, trends, batteries. */
  Sensors: undefined;
  /** A page of the hub's phone web app, for what has no screen of its own yet (live camera video, editing a mode). */
  Web: { title: string; path: string };
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Stack>>();
