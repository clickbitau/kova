import { FlexWidget, TextWidget } from 'react-native-android-widget';
import type { widgetModel } from '../logic/extensions';

type Model = ReturnType<typeof widgetModel>;

// The Android home-screen widget: the mode and lights on, then up to four favourites to tap.
// Drawn with react-native-android-widget's primitives (it becomes Android RemoteViews), in the app's
// language: raised tiles with a hairline edge, lit tiles in amber with an amber edge, a dot for state.

const C = { page: '#0e0f10', card: '#18191c', edge: '#232428', bone: '#f1efea', stone: '#a3a09a', stone2: '#8a8781', amber: '#f2b14c', amberTint: '#2b2112', amberEdge: '#5a4420' } as const;

export function HomeWidget({ model }: { model: Model | null }) {
  if (!model) {
    return (
      <FlexWidget clickAction="OPEN_APP" style={{ height: 'match_parent', width: 'match_parent', backgroundColor: C.page, borderRadius: 24, padding: 18, justifyContent: 'center' }}>
        <TextWidget text="Kova" style={{ fontSize: 18, fontWeight: '800', color: C.bone }} />
        <TextWidget text="Open Kova to connect it to your home." style={{ fontSize: 12, color: C.stone, marginTop: 4 }} />
      </FlexWidget>
    );
  }
  return (
    <FlexWidget style={{ height: 'match_parent', width: 'match_parent', backgroundColor: C.page, borderRadius: 24, padding: 12, flexDirection: 'column' }}>
      <FlexWidget clickAction="OPEN_APP" style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', paddingHorizontal: 4, paddingBottom: 10 }}>
        <FlexWidget style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: model.modeColor }} />
        <TextWidget text={`  ${model.mode}`} style={{ fontSize: 16, fontWeight: '800', color: C.bone }} />
        <FlexWidget style={{ flex: 1 }} />
        <TextWidget text={model.lightsOn ? `${model.lightsOn} light${model.lightsOn === 1 ? '' : 's'} on` : 'All lights off'} style={{ fontSize: 12, fontWeight: '600', color: model.lightsOn ? C.amber : C.stone2 }} />
      </FlexWidget>
      {model.favourites.length ? [0, 2].filter(r => r < model.favourites.length).map(row => (
        <FlexWidget key={row} style={{ flexDirection: 'row', width: 'match_parent', marginTop: row ? 8 : 0 }}>
          {model.favourites.slice(row, row + 2).map((d, i) => (
            <FlexWidget key={d.id} clickAction="toggle" clickActionData={{ id: d.id }} accessibilityLabel={`${d.name}, ${d.label}`}
              style={{ flex: 1, marginLeft: i ? 8 : 0, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 16, backgroundColor: d.on ? C.amberTint : C.card, borderWidth: 1, borderColor: d.on ? C.amberEdge : C.edge }}>
              <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
                <FlexWidget style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: d.on ? C.amber : C.edge }} />
                <TextWidget text={`  ${d.name}`} maxLines={1} truncate="END" style={{ fontSize: 13, fontWeight: '700', color: C.bone }} />
              </FlexWidget>
              <TextWidget text={d.label} maxLines={1} truncate="END" style={{ fontSize: 11, fontWeight: '600', color: d.color, marginTop: 3 }} />
            </FlexWidget>
          ))}
          {model.favourites.slice(row, row + 2).length === 1 ? <FlexWidget style={{ flex: 1, marginLeft: 8 }} /> : null}
        </FlexWidget>
      )) : (
        <FlexWidget clickAction="OPEN_APP" style={{ width: 'match_parent', padding: 12, borderRadius: 16, backgroundColor: C.card }}>
          <TextWidget text="No favourites yet" style={{ fontSize: 13, fontWeight: '700', color: C.bone }} />
          <TextWidget text="Star devices in Kova to tap them here." style={{ fontSize: 11, color: C.stone, marginTop: 2 }} />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}
