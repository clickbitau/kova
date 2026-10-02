import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { Draft } from './logic/automations';

export type Tab = 'Now' | 'Devices' | 'Ask' | 'Security' | 'More';

export type Stack = {
  Tabs: { tab?: Tab } | undefined;
  Modes: undefined;
  Activity: undefined;
  ThisPhone: undefined;
  Automations: undefined;
  /** An automation by id, or a new one (optionally starting from a draft, such as a suggestion). */
  AutomationEditor: { id?: string; draft?: Draft; tab?: 'edit' | 'history' } | undefined;
  Customise: undefined;
  /** More → Sign in a browser: approve a browser's sign-in code; signed-in browsers. */
  Browsers: undefined;
  Energy: undefined;
  Media: undefined;
  /** More → Integrations: what's connected, and the hub's own updates. */
  Integrations: undefined;
  /** Add integration: the catalog, minus what's set up. */
  IntegrationAdd: undefined;
  /** One integration's status and setup (an integrations.json section id). */
  Integration: { id: string };
  /** A page of the hub's phone web app, for what has no screen of its own yet (Add a device, live camera video, editing a mode). */
  Web: { title: string; path: string };
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Stack>>();
