import { Platform } from 'react-native';
import * as QuickActions from 'expo-quick-actions';
import { requestWidgetUpdate } from 'react-native-android-widget';
import { createElement } from 'react';
import { KovaNative } from '../../modules/kova-native';
import type { Snapshot } from '../api/types';
import type { HubConfig } from '../logic/connect';
import { homeState, homeStateKey, widgetModel, widgetSnapshot } from '../logic/extensions';
import { HomeWidget } from '../widget/HomeWidget';

// Keeps Kova's widgets (iOS and Android), the lock-screen Live Activity (iOS) and the app icon's
// quick actions in step with the hub while the app runs. Widgets also fetch for themselves.

/** Give the iOS widget extension and Siri the hub's address and token (through the App Group). */
export function shareHub(cfg: HubConfig | null): void {
  KovaNative?.setShared('hub', cfg ? JSON.stringify({ url: cfg.url, token: cfg.token ?? null }) : null);
  if (!cfg) KovaNative?.setShared('snapshot', null);
  KovaNative?.reloadWidgets();
}

let lastWidgetKey = '', lastActivityKey = '', lastQuickKey = '', lastWrite = 0;

/** Call with every snapshot; it only does work when what the widgets show has changed. */
export function syncExtensions(s: Snapshot): void {
  const model = widgetModel(s);
  const key = JSON.stringify(model);
  const now = Date.now();
  if (key !== lastWidgetKey || now - lastWrite > 10 * 60_000) {
    lastWidgetKey = key; lastWrite = now;
    if (KovaNative) {
      KovaNative.setShared('snapshot', JSON.stringify(widgetSnapshot(s)));
      KovaNative.reloadWidgets();
    }
    if (Platform.OS === 'android') {
      void requestWidgetUpdate({ widgetName: 'KovaHome', renderWidget: () => createElement(HomeWidget, { model }) }).catch(() => {});
    }
  }
  if (KovaNative?.activityRunning()) {
    const h = homeState(s);
    const k = homeStateKey(h);
    if (k !== lastActivityKey) { lastActivityKey = k; void KovaNative.updateActivity(h).catch(() => {}); }
  }
  void setQuickActions(s);
}

/** Long-press the app icon: the home's scenes, all lights off, Ask. */
async function setQuickActions(s: Snapshot): Promise<void> {
  if (Platform.OS === 'web') return;
  const items: QuickActions.Action[] = [
    ...s.overlays.slice(0, 2).map(o => ({ id: `overlay:${o.id}`, title: o.name, icon: Platform.OS === 'ios' ? 'symbol:sparkles' : null, params: { overlay: o.id } })),
    { id: 'lights-off', title: 'All lights off', icon: Platform.OS === 'ios' ? 'symbol:lightbulb.slash' : null },
    { id: 'ask', title: 'Ask Kova', icon: Platform.OS === 'ios' ? 'symbol:waveform' : null },
  ];
  const key = JSON.stringify(items);
  if (key === lastQuickKey) return;
  lastQuickKey = key;
  await QuickActions.setItems(items).catch(() => {});
}

export const liveActivitySupported = () => !!KovaNative && KovaNative.liveActivitiesEnabled();
export const liveActivityRunning = () => !!KovaNative?.activityRunning();

export async function startHomeActivity(s: Snapshot): Promise<void> {
  if (!KovaNative) throw new Error('The lock screen needs the iPhone app.');
  const h = homeState(s);
  lastActivityKey = homeStateKey(h);
  await KovaNative.startActivity(s.home.name, h);
}

export async function endHomeActivity(): Promise<void> {
  lastActivityKey = '';
  await KovaNative?.endActivity();
}
