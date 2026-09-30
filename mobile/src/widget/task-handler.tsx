import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { call } from '../api/client';
import type { Snapshot } from '../api/types';
import type { HubConfig } from '../logic/connect';
import { devs, toggleCommand } from '../logic/devices';
import { widgetModel } from '../logic/extensions';
import { getJson } from '../native/storage';
import { HomeWidget } from './HomeWidget';

// Runs headless when Android asks the widget to draw itself or when a tile is tapped:
// read the hub from the app's storage, switch the device, draw the fresh state.
export async function widgetTaskHandler({ widgetAction, clickAction, clickActionData, renderWidget }: WidgetTaskHandlerProps) {
  if (widgetAction === 'WIDGET_DELETED') return;
  const cfg = await getJson<HubConfig>('kova.hub');
  if (!cfg) { renderWidget(<HomeWidget model={null} />); return; }
  let snap = await call<Snapshot>(cfg, 'GET', '/api/state', undefined, 6000).catch(() => null);
  if (snap && widgetAction === 'WIDGET_CLICK' && clickAction === 'toggle' && typeof clickActionData?.id === 'string') {
    const d = devs(snap)[clickActionData.id];
    const cmd = d && toggleCommand(d, snap.sources);
    if (cmd) {
      await call(cfg, 'POST', `/api/devices/${encodeURIComponent(d.id)}`, cmd, 6000).catch(() => {});
      snap = await call<Snapshot>(cfg, 'GET', '/api/state', undefined, 6000).catch(() => snap);
    }
  }
  renderWidget(<HomeWidget model={snap ? widgetModel(snap) : null} />);
}
