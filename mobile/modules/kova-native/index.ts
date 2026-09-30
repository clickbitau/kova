import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

/** The home right now, for the Live Activity. Times are epoch milliseconds. */
export interface HomeState {
  mode: string;
  modeColor: string;
  modeIcon: string;
  lightsOn: number;
  since: number;
  nextAt?: number | null;
  nextLabel?: string | null;
  nextWhat?: string | null;
  nextId?: string | null;
  overlay?: string | null;
}

interface KovaNativeModule {
  setShared(key: string, json: string | null): void;
  reloadWidgets(): void;
  liveActivitiesEnabled(): boolean;
  activityRunning(): boolean;
  startActivity(homeName: string, state: HomeState): Promise<string>;
  updateActivity(state: HomeState): Promise<void>;
  endActivity(): Promise<void>;
}

/** iOS only (widgets, the Live Activity); null on Android, the web and in Expo Go. */
export const KovaNative: KovaNativeModule | null = Platform.OS === 'ios' ? requireOptionalNativeModule<KovaNativeModule>('KovaNative') : null;
