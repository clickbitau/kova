import { FlexWidget, TextWidget } from 'react-native-android-widget';
import type { widgetModel } from '../logic/extensions';

type Model = ReturnType<typeof widgetModel>;

// The Android home-screen widget: the mode and lights on, then up to four favourites to tap.
// Drawn with react-native-android-widget's primitives (it becomes Android RemoteViews).

const C = { page: '#0e0f10', card: '#16171a', bone: '#f1efea', stone: '#a3a09a', amber: '#f2b14c', amberTint: '#2b2112' } as const;

export function HomeWidget({ model }: { model: Model | null }) {
  if (!model) {
    return (
      <FlexWidget clickAction="OPEN_APP" style={{ height: 'match_parent', width: 'match_parent', backgroundColor: C.page, borderRadius: 22, padding: 16, justifyContent: 'center' }}>
        <TextWidget text="Kova" style={{ fontSize: 18, fontWeight: '800', color: C.bone }} />
        <TextWidget text="Open Kova to connect it to your home." style={{ fontSize: 12, color: C.stone, marginTop: 4 }} />
      </FlexWidget>
    );
  }
  return (
    <FlexWidget style={{ height: 'match_parent', width: 'match_parent', backgroundColor: C.page, borderRadius: 22, padding: 12, flexDirection: 'column' }}>
      <FlexWidget clickAction="OPEN_APP" style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', paddingHorizontal: 4, paddingBottom: 8 }}>
        <TextWidget text={model.mode} style={{ fontSize: 16, fontWeight: '700', color: model.modeColor }} />
        <TextWidget text={`  ·  ${model.lightsOn} light${model.lightsOn === 1 ? '' : 's'} on`} style={{ fontSize: 13, color: C.stone }} />
      </FlexWidget>
      {[0, 2].map(row => (
        <FlexWidget key={row} style={{ flexDirection: 'row', width: 'match_parent', marginTop: row ? 6 : 0 }}>
          {model.favourites.slice(row, row + 2).map((d, i) => (
            <FlexWidget key={d.id} clickAction="toggle" clickActionData={{ id: d.id }} accessibilityLabel={`${d.name}, ${d.label}`}
              style={{ flex: 1, marginLeft: i ? 6 : 0, padding: 10, borderRadius: 14, backgroundColor: d.on ? C.amberTint : C.card }}>
              <TextWidget text={d.name} maxLines={1} truncate="END" style={{ fontSize: 13, fontWeight: '700', color: C.bone }} />
              <TextWidget text={d.label} maxLines={1} truncate="END" style={{ fontSize: 11, color: d.color, marginTop: 2 }} />
            </FlexWidget>
          ))}
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}
