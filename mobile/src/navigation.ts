import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';

export type Tab = 'Now' | 'Devices' | 'Ask' | 'Security' | 'More';

export type Stack = {
  Tabs: { tab?: Tab } | undefined;
  Modes: undefined;
  Activity: undefined;
  ThisPhone: undefined;
  /** A page of the hub's phone web app, for setup screens (Integrations, Customise, Energy, Media, Add, a camera). */
  Web: { title: string; path: string };
};

export const useNav = () => useNavigation<NativeStackNavigationProp<Stack>>();
