import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { C } from '../theme';
import { ICON, stateOf, tint, type Dev } from '../logic/devices';
import { AnimatedIcon, Icon } from './Icon';
import { Press } from './kit';
import { Appear, reducedMotion, spring, useStateValue } from './motion';
import { T } from './Text';

/**
 * A device tile: tap to switch it, ⋯ for its panel. Two to a row, like the phone design.
 * Switching it on or off isn't a cut: the tile's colours cross over in the 200 ms state change, its icon fills
 * in (outlined when off), the icon well pops, and a lit light gives off a faint glow of its colour.
 */
export function Tile({ d, onToggle, onOpen }: { d: Dev; onToggle: () => void; onOpen: () => void }) {
  const [st, fg] = stateOf(d);
  const lit = useStateValue(!!d.on);
  const off = tint({ ...d, on: false }), on = tint({ ...d, on: true });
  const mix = (a: string, b: string) => a === b ? a : lit.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const changes = off.bg !== on.bg || off.iconBg !== on.iconBg;
  const pop = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!d.on || reducedMotion()) return;
    pop.setValue(0.84);
    spring(pop, 1, 'pop').start();
  }, [d.on, pop]);
  const icon = ICON[d.type] ?? 'devices';
  return (
    <Press onPress={onToggle} label={`${d.name}, ${st}`} style={{ flex: 1, minHeight: 112, borderRadius: 18, padding: 14, gap: 16, opacity: d.hidden ? 0.55 : 1 }}>
      {changes ? <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 18, boxShadow: `0px 6px 22px ${on.border}`, opacity: lit }} /> : null}
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 18, borderWidth: 1, backgroundColor: mix(off.bg, on.bg), borderColor: mix(off.border, on.border) }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Animated.View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: mix(off.iconBg, on.iconBg), alignItems: 'center', justifyContent: 'center', transform: [{ scale: pop }] }}>
          {changes ? (
            <>
              <AnimatedIcon name={icon} size={21} color={off.iconFg} style={{ position: 'absolute', opacity: lit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
              <AnimatedIcon name={icon} size={21} color={on.iconFg} fill style={{ opacity: lit }} />
            </>
          ) : <Icon name={icon} size={21} color={on.iconFg} fill />}
        </Animated.View>
        <Press onPress={onOpen} label={`${d.name} settings`} style={{ width: 34, height: 34, marginTop: -4, marginRight: -6, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="more_horiz" size={20} color={C.stone} />
        </Press>
      </View>
      <View style={{ gap: 2 }}>
        <T size={14.5} weight={700} numberOfLines={1}>{d.name}</T>
        <T size={12} weight={500} color={fg} numberOfLines={1}>{st}</T>
      </View>
    </Press>
  );
}

/** Tiles two to a row (an odd last tile keeps half the width). Rows fade up one after another when they appear. */
export function TileGrid({ items, onToggle, onOpen }: { items: Dev[]; onToggle: (d: Dev) => void; onOpen: (d: Dev) => void }) {
  const rows: Dev[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <Appear key={r[0].id} index={i} style={{ flexDirection: 'row', gap: 10 }}>
          {r.map(d => <Tile key={d.id} d={d} onToggle={() => onToggle(d)} onOpen={() => onOpen(d)} />)}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </Appear>
      ))}
    </View>
  );
}
