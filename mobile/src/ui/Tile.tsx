import { View } from 'react-native';
import { C } from '../theme';
import { ICON, stateOf, tint, type Dev } from '../logic/devices';
import { Icon } from './Icon';
import { Press } from './kit';
import { T } from './Text';

/** A device tile: tap to switch it, ⋯ for its panel. Two to a row, like the phone design. */
export function Tile({ d, onToggle, onOpen }: { d: Dev; onToggle: () => void; onOpen: () => void }) {
  const t = tint(d);
  const [st, fg] = stateOf(d);
  return (
    <Press onPress={onToggle} label={`${d.name}, ${st}`} style={{ flex: 1, borderRadius: 18, padding: 14, gap: 16, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border, opacity: d.hidden ? 0.55 : 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={ICON[d.type] ?? 'devices'} size={21} color={t.iconFg} fill />
        </View>
        <Press onPress={onOpen} hitSlop={8} label={`${d.name} settings`} style={{ width: 34, height: 34, marginTop: -4, marginRight: -6, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="more_horiz" size={20} color={C.stone} />
        </Press>
      </View>
      <View style={{ gap: 2 }}>
        <T size={14} weight={700} numberOfLines={1}>{d.name}</T>
        <T size={12} color={fg} numberOfLines={1}>{st}</T>
      </View>
    </Press>
  );
}

/** Tiles two to a row (an odd last tile keeps half the width). */
export function TileGrid({ items, onToggle, onOpen }: { items: Dev[]; onToggle: (d: Dev) => void; onOpen: (d: Dev) => void }) {
  const rows: Dev[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View style={{ gap: 10 }}>
      {rows.map(r => (
        <View key={r[0].id} style={{ flexDirection: 'row', gap: 10 }}>
          {r.map(d => <Tile key={d.id} d={d} onToggle={() => onToggle(d)} onOpen={() => onOpen(d)} />)}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}
