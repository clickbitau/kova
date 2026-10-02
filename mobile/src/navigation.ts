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
  /** A page of the hub's phone web app, for setup screens (Integrations, Customise, Energy, Media, Add, a camera). */
  Web: { title: string; path: string };
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Stack>>();
