import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { C, R, SP } from '../theme';
import { useHub } from '../state/hub';
import { iconOf, isLight, stateOf, tint, type Dev } from '../logic/devices';
import { AnimatedIcon, Icon } from './Icon';
import { Press, Skeleton, Spinner } from './kit';
import { Appear, reducedMotion, shake, spring, useStateValue } from './motion';
import { T } from './Text';

/** A device's level, for the bar along the bottom of its tile: a dimmer's brightness, while it's on. */
export const levelOf = (d: Dev): number | null => d.on && isLight(d) && d.type === 'dimmer' && d.bri != null ? Math.max(0.04, Math.min(1, d.bri / 100)) : null;

/**
 * A device tile: tap to switch it, ⋯ or a long press for its panel. Two to a row.
 * Switching isn't a cut: the colours cross over in the 200 ms state change, the icon fills in, its well pops,
 * and a lit light glows faintly in its colour. While the command is on its way (past a beat) a ring turns
 * round the icon; if the hub refuses, the tile shakes and goes back. A dimmer shows its level along the
 * bottom; a device that isn't answering is dimmed and says so.
 */
export function Tile({ d, onToggle, onOpen }: { d: Dev; onToggle: () => void; onOpen: () => void }) {
  const { pending } = useHub();
  const p = pending[d.id];
  const [st, fg] = stateOf(d);
  const lit = useStateValue(!!d.on);
  const off = tint({ ...d, on: false }), on = tint({ ...d, on: true });
  const mix = (a: string, b: string) => a === b ? a : lit.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const changes = off.bg !== on.bg || off.iconBg !== on.iconBg;
  const pop = useRef(new Animated.Value(1)).current;
  const x = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!d.on || reducedMotion()) return;
    pop.setValue(0.84);
    spring(pop, 1, 'pop', { native: false }).start();
  }, [d.on, pop]);
  // The ring only after a beat: most commands land before it would show.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (p !== 'busy') { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 280);
    return () => clearTimeout(t);
  }, [p]);
  useEffect(() => { if (p === 'failed') shake(x); }, [p, x]);
  const dead = d.online === false && d.type !== 'camera' && d.type !== 'sensor';
  const icon = dead ? 'wifi_off' : iconOf(d);
  const level = levelOf(d);
  return (
    <Animated.View style={{ flex: 1, transform: [{ translateX: x }] }}>
      <Press onPress={onToggle} onLongPress={onOpen} give="soft" label={`${d.name}, ${st}`} hint="Long press for its controls" actions={[{ name: 'controls', label: 'Controls', run: onOpen }]}
        style={{ flex: 1, minHeight: 118, borderRadius: R.lg + 2, padding: SP[3] + 2, paddingBottom: SP[4] + 2, gap: SP[4], opacity: d.hidden ? 0.55 : dead ? 0.7 : 1, overflow: 'hidden' }}>
        {changes ? <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: R.lg + 2, boxShadow: `0px 8px 26px ${on.border}`, opacity: lit }} /> : null}
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: R.lg + 2, borderWidth: 1, backgroundColor: mix(off.bg, on.bg), borderColor: mix(off.border, on.border), borderTopColor: mix(C.edgeTop, on.border) }} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View style={{ width: 42, height: 42, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: dead ? C.redTint : mix(off.iconBg, on.iconBg), alignItems: 'center', justifyContent: 'center', transform: [{ scale: pop }] }}>
              {dead ? <Icon name={icon} size={20} color={C.red} /> : changes ? (
                <>
                  <AnimatedIcon name={icon} size={21} color={off.iconFg} style={{ position: 'absolute', opacity: lit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
                  <AnimatedIcon name={icon} size={21} color={on.iconFg} fill style={{ opacity: lit }} />
                </>
              ) : <Icon name={icon} size={21} color={on.iconFg} fill />}
            </Animated.View>
            {slow ? <View pointerEvents="none" style={{ position: 'absolute' }}><Spinner size={48} width={2} color={d.on ? on.border : C.stone} /></View> : null}
          </View>
          <Press onPress={onOpen} label={`${d.name} settings`} style={{ width: 34, height: 34, marginTop: -4, marginRight: -6, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="more_horiz" size={20} color={C.stone} />
          </Press>
        </View>
        <View style={{ gap: 2 }}>
          <T v="headline" numberOfLines={1}>{d.name}</T>
          <T v="footnote" weight={600} color={dead ? C.red : fg} numberOfLines={1}>{st}</T>
        </View>
        {level != null ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: SP[3] + 2, right: SP[3] + 2, bottom: 8, height: 3, borderRadius: 2, backgroundColor: 'rgba(242,177,76,0.16)' }}>
            <View style={{ width: `${level * 100}%`, height: 3, borderRadius: 2, backgroundColor: C.amber }} />
          </View>
        ) : null}
      </Press>
    </Animated.View>
  );
}

/** Tiles two to a row (an odd last tile keeps half the width). Rows fade up one after another when they appear. */
export function TileGrid({ items, onToggle, onOpen }: { items: Dev[]; onToggle: (d: Dev) => void; onOpen: (d: Dev) => void }) {
  const rows: Dev[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View style={{ gap: SP[2] + 2 }}>
      {rows.map((r, i) => (
        <Appear key={r[0].id} index={i} style={{ flexDirection: 'row', gap: SP[2] + 2 }}>
          {r.map(d => <Tile key={d.id} d={d} onToggle={() => onToggle(d)} onOpen={() => onOpen(d)} />)}
          {r.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </Appear>
      ))}
    </View>
  );
}

/** The tiles' shape while the home loads. */
export function TileSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <View style={{ gap: SP[2] + 2 }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: SP[2] + 2 }}>
          <Skeleton h={118} r={R.lg + 2} style={{ flex: 1 }} />
          <Skeleton h={118} r={R.lg + 2} style={{ flex: 1 }} />
        </View>
      ))}
    </View>
  );
}
