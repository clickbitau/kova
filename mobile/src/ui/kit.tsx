import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { C } from '../theme';
import { Icon } from './Icon';
import { T } from './Text';

// Motion from the design language: 120 ms press (scale 0.97), 200 ms state changes, 280 ms sheets.
const OUT = Easing.bezier(0.2, 0.8, 0.2, 1);

const OUTER = new Set(['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'width', 'minWidth', 'maxWidth', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'position', 'top', 'left', 'right', 'bottom']);

/** Anything tappable: gives a little on press, like the design's buttons. */
export function Press({ onPress, style, children, disabled, hitSlop, label }: { onPress?: () => void; style?: StyleProp<ViewStyle>; children?: ReactNode; disabled?: boolean; hitSlop?: number; label?: string }) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.timing(s, { toValue: v, duration: 120, easing: OUT, useNativeDriver: true }).start();
  // How the button sits in its parent (flex, width) belongs on the outer Pressable; how it looks, on the inner view.
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle & Record<string, unknown>;
  const outer: Record<string, unknown> = {}, inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) (OUTER.has(k) ? outer : inner)[k] = v;
  return (
    <Pressable style={outer as ViewStyle} onPress={onPress} disabled={disabled} hitSlop={hitSlop} onPressIn={() => to(0.97)} onPressOut={() => to(1)} accessibilityRole="button" accessibilityLabel={label}>
      <Animated.View style={[inner as ViewStyle, 'flex' in outer || 'flexGrow' in outer ? { flexGrow: 1 } : null, { transform: [{ scale: s }] }, disabled ? { opacity: 0.5 } : null]}>{children}</Animated.View>
    </Pressable>
  );
}

export function Card({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ borderRadius: 18, backgroundColor: C.card }, style]}>{children}</View>;
}

/** The Kova mark: the roof, the smaller roof, the amber dot. */
export function Mark({ size = 22, ink = C.bone }: { size?: number; ink?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path d="M8 26L24 11L40 26" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M16 32L24 24.5L32 32" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={24} cy={38.5} r={3.5} fill={C.amber} />
    </Svg>
  );
}

/** A page title with an optional back button: "Modes", with a small line above. */
export function PageHead({ over, title, onBack, right }: { over?: string; title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {onBack ? (
        <Press onPress={onBack} label="Back" style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrow_back" size={20} />
        </Press>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        {over ? <T size={12} color={C.stone}>{over}</T> : null}
        <T size={onBack ? 26 : 30} weight={700} tracking={-0.02}>{title}</T>
      </View>
      {right}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <T size={16} weight={700}>{children}</T>
      {right}
    </View>
  );
}

/** A pill chip: room filters, activity filters. Selected is bone on coal, like the design. */
export function Pill({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  return (
    <Press onPress={onPress} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: on ? C.bone : C.card }}>
      <T size={13} weight={600} color={on ? C.coal : C.bone2}>{label}</T>
    </Press>
  );
}

/** A horizontal row that scrolls, bleeding to the screen edges like the web app's pill rows. */
export function HScroll({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -18, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 18, gap }}>
      {children}
    </ScrollView>
  );
}

export function Switch({ on, onChange, big }: { on: boolean; onChange?: (v: boolean) => void; big?: boolean }) {
  const x = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => { Animated.timing(x, { toValue: on ? 1 : 0, duration: 200, easing: OUT, useNativeDriver: false }).start(); }, [on, x]);
  const w = big ? 52 : 38, h = big ? 32 : 22, k = h - 6;
  return (
    <Pressable onPress={() => onChange?.(!on)} accessibilityRole="switch" accessibilityState={{ checked: on }} hitSlop={8}>
      <Animated.View style={{ width: w, height: h, borderRadius: h / 2, padding: 3, backgroundColor: x.interpolate({ inputRange: [0, 1], outputRange: [C.switchOff, C.amber] }) }}>
        <Animated.View style={{ width: k, height: k, borderRadius: k / 2, backgroundColor: '#fff', transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, w - k - 6] }) }] }} />
      </Animated.View>
    </Pressable>
  );
}

/** A 0–100 slider that reports on release (so a drag isn't a flood of commands), and shows the value while dragging. */
export function Slider({ value, min = 0, max = 100, color = C.amber, onChange, onRelease }: { value: number; min?: number; max?: number; color?: string; onChange?: (v: number) => void; onRelease: (v: number) => void }) {
  const [w, setW] = useState(1);
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? value;
  const at = (x: number) => Math.round(min + Math.max(0, Math.min(1, x / w)) * (max - min));
  const ref = useRef({ w, onChange, onRelease });
  ref.current = { w, onChange, onRelease };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: e => { const n = at(e.nativeEvent.locationX); setLive(n); ref.current.onChange?.(n); },
    onPanResponderMove: e => { const n = at(e.nativeEvent.locationX); setLive(n); ref.current.onChange?.(n); },
    onPanResponderRelease: e => { const n = at(e.nativeEvent.locationX); setLive(null); ref.current.onRelease(n); },
    onPanResponderTerminate: () => setLive(null),
  })).current;
  const pct = (v - min) / (max - min);
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} {...pan.panHandlers} style={{ height: 34, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: C.control }}>
        <View style={{ width: `${pct * 100}%`, height: 6, borderRadius: 3, backgroundColor: color }} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', left: pct * Math.max(0, w - 22), width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', borderWidth: 3, borderColor: color }} />
    </View>
  );
}

/** A bottom sheet: 28 px top corners on #141517 over the scrim, rising in 280 ms. The grabber closes it too. */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(1)).current;
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); Animated.timing(y, { toValue: 0, duration: 280, easing: OUT, useNativeDriver: true }).start(); }
    else Animated.timing(y, { toValue: 1, duration: 220, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => setShown(false));
  }, [open, y]);
  if (!shown) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={{ flex: 1, backgroundColor: C.scrim, opacity: y.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '92%', borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: C.sheet, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [0, 800] }) }] }}>
        <Pressable onPress={onClose} accessibilityLabel="Close" style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 8 }}>
          <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: C.switchOff }} />
        </Pressable>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 34, gap: 18 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

/** The confirmation after an action, with Undo when the hub gave one. Pops in like the design's toast. */
export function ToastView({ text, undo, error, onUndo, bottom }: { text: string; undo?: boolean; error?: boolean; onUndo?: () => void; bottom: number }) {
  const s = useRef(new Animated.Value(0)).current;
  useEffect(() => { s.setValue(0); Animated.timing(s, { toValue: 1, duration: 320, easing: Easing.bezier(0.34, 1.56, 0.64, 1), useNativeDriver: true }).start(); }, [text, s]);
  return (
    <Animated.View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom, opacity: s, transform: [{ translateY: s.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }, { scale: s.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 16, paddingRight: undo ? 8 : 16, borderRadius: 14, backgroundColor: error ? '#3a1d1a' : C.bone }}>
        <T size={13.5} weight={600} color={error ? '#ffb4ab' : C.coal} style={{ flex: 1 }}>{text}</T>
        {undo ? (
          <Press onPress={onUndo} style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.08)' }}>
            <T size={13} weight={700} color={C.coal}>Undo</T>
          </Press>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function Empty({ icon, title, text, action, onAction }: { icon: string; title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ paddingVertical: 28, paddingHorizontal: 16, borderRadius: 18, backgroundColor: C.card, alignItems: 'center', gap: 8 }}>
      <Icon name={icon} size={28} color={C.stone3} />
      <T size={14} weight={700} center>{title}</T>
      <T size={12.5} color={C.stone} center lineHeight={1.45}>{text}</T>
      {action ? (
        <Press onPress={onAction} style={{ marginTop: 6, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.amber }}>
          <T size={13} weight={700} color={C.onAmber}>{action}</T>
        </Press>
      ) : null}
    </View>
  );
}

/** A row in a grouped list: tinted icon well, title and subtitle, chevron. */
export function Row({ icon, iconBg = C.selected, iconFg = C.bone, title, sub, subColor = C.stone, onPress, right, first }: { icon: string; iconBg?: string; iconFg?: string; title: string; sub?: string; subColor?: string; onPress?: () => void; right?: ReactNode; first?: boolean }) {
  return (
    <Press onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 14, borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={iconFg} />
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <T size={14.5} weight={700}>{title}</T>
        {sub ? <T size={12} color={subColor} numberOfLines={2}>{sub}</T> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron_right" size={20} color={C.stone3} /> : null)}
    </Press>
  );
}

export function Button({ label, icon, onPress, kind = 'primary', busy }: { label: string; icon?: string; onPress?: () => void; kind?: 'primary' | 'secondary' | 'blue'; busy?: boolean }) {
  const bg = kind === 'primary' ? C.amber : kind === 'blue' ? C.blue : 'rgba(255,255,255,0.08)';
  const fg = kind === 'primary' ? C.onAmber : kind === 'blue' ? C.onBlue : C.bone;
  return (
    <Press onPress={busy ? undefined : onPress} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, backgroundColor: bg, opacity: busy ? 0.7 : 1 }}>
      {icon ? <Icon name={icon} size={19} color={fg} /> : null}
      <T size={14} weight={700} color={fg}>{busy ? 'Working…' : label}</T>
    </Press>
  );
}
