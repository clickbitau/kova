import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type AccessibilityRole, type Insets, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, MOTION, R, SHADOW, SP, alpha } from '../theme';
import { useHub, type Toast } from '../state/hub';
import { Image } from 'expo-image';
import { Icon } from './Icon';
import { Appear, haptic, shake, spring, tween, useLoop, useReducedMotion, useStateValue, type HapticKind } from './motion';
import { T } from './Text';

// The app's shared components. Sizes, colours and motion come from theme.ts (TYPE, SP, R, C, MOTION, SHADOW)
// through ui/motion.tsx, which also handles reduced motion and haptics. Screens compose these; they don't
// hand-build buttons, chips, rows or cards.

const OUTER = new Set(['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'width', 'minWidth', 'maxWidth', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'position', 'top', 'left', 'right', 'bottom', 'zIndex']);

/** Padding for the hit area of a control drawn smaller than a finger (MOTION.target), from its fixed size. */
function targetSlop(s: ViewStyle): Insets | undefined {
  const pad = (n: unknown) => typeof n === 'number' && n < MOTION.target ? Math.ceil((MOTION.target - n) / 2) : 0;
  const x = pad(s.width), y = pad(s.height);
  return x || y ? { left: x, right: x, top: y, bottom: y } : undefined;
}

export interface PressProps {
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  disabled?: boolean;
  hitSlop?: number | Insets;
  label?: string;
  hint?: string;
  role?: AccessibilityRole;
  selected?: boolean;
  haptic?: HapticKind;
  /** How far it gives under the finger: 'soft' for big surfaces (tiles, cards), which shouldn't shrink as much. */
  give?: 'normal' | 'soft';
  /** Extra things a screen reader can do with it (a tile's "Controls", since its own buttons are folded into it). */
  actions?: { name: string; label: string; run: () => void }[];
}

/**
 * Anything tappable. It gives under the finger (scale to 0.97 and a slight dim, or only the dim with reduced
 * motion) and springs back when let go. Small controls get a hit area of at least 44 pt. `haptic` adds a tap
 * you can feel, for choices that don't already send a command (which has its own). A long press buzzes.
 */
export function Press({ onPress, onLongPress, style, children, disabled, hitSlop, label, hint, role = 'button', selected, haptic: feel, give = 'normal', actions }: PressProps) {
  const s = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle & Record<string, unknown>;
  const outer: Record<string, unknown> = {}, inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) (OUTER.has(k) ? outer : inner)[k] = v;
  const base = (typeof inner.opacity === 'number' ? inner.opacity : 1) * (disabled ? 0.45 : 1);
  delete inner.opacity;
  const to = give === 'soft' ? 0.985 : MOTION.press.scale;
  const opacity = useMemo(() => Animated.multiply(s.interpolate({ inputRange: [MOTION.press.scale, 1], outputRange: [reduced ? MOTION.press.dimReduced : MOTION.press.dim, 1], extrapolate: 'clamp' }), base), [s, reduced, base]);
  return (
    <Pressable
      style={outer as ViewStyle} onPress={onPress && (() => { if (feel) haptic[feel](); onPress(); })}
      onLongPress={onLongPress && (() => { haptic.light(); onLongPress(); })} delayLongPress={380}
      disabled={disabled} hitSlop={hitSlop ?? targetSlop(flat)}
      onPressIn={() => tween(s, to, { duration: MOTION.dur.press }).start()} onPressOut={() => spring(s, 1, 'press').start()}
      accessibilityRole={role} accessibilityLabel={label} accessibilityHint={hint}
      accessibilityState={disabled || selected != null ? { disabled: !!disabled, selected } : undefined}
      accessibilityActions={actions?.map(a => ({ name: a.name, label: a.label }))}
      onAccessibilityAction={actions && (e => actions.find(a => a.name === e.nativeEvent.actionName)?.run())}
    >
      <Animated.View style={[inner as ViewStyle, 'flex' in outer || 'flexGrow' in outer ? { flexGrow: 1 } : null, { opacity, transform: [{ scale: reduced ? 1 : s }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

/**
 * A card: a surface a step above the page, with a hairline edge that's a touch lighter along the top,
 * so it reads as raised without a heavy shadow. `tint` gives it a colour wash and edge (an active state).
 */
export function Card({ children, style, tint, pad }: { children?: ReactNode; style?: StyleProp<ViewStyle>; tint?: string; pad?: number }) {
  return (
    <View style={[{ borderRadius: R.lg, backgroundColor: tint ? alpha(tint, 0.1) : C.card, borderWidth: 1, borderColor: tint ? alpha(tint, 0.3) : C.edge, borderTopColor: tint ? alpha(tint, 0.4) : C.edgeTop, padding: pad }, style]}>
      {children}
    </View>
  );
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

/** A round icon button: back, close, a small tool in a header. */
export function IconButton({ icon, label, onPress, size = 40, tone = 'plain', fill, color }: { icon: string; label: string; onPress?: () => void; size?: number; tone?: 'plain' | 'amber' | 'ghost'; fill?: boolean; color?: string }) {
  const bg = tone === 'amber' ? C.amber : tone === 'ghost' ? 'transparent' : C.control2;
  const fg = color ?? (tone === 'amber' ? C.onAmber : C.bone);
  return (
    <Press onPress={onPress} label={label} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={Math.round(size * 0.5)} color={fg} fill={fill} />
    </Press>
  );
}

/** A tinted round well with an icon: rows, cards, headers. */
export function IconWell({ icon, color = C.bone, bg, size = 36, fill, radius }: { icon: string; color?: string; bg?: string; size?: number; fill?: boolean; radius?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.32), backgroundColor: bg ?? alpha(color, 0.14), alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={Math.round(size * 0.55)} color={color} fill={fill} />
    </View>
  );
}

/**
 * A section: a heading (with an optional action on the right, like "See all") and its content, with the
 * same rhythm everywhere. `caption` is the small capitals kind, for sections inside a sheet or a card.
 */
export function Section({ title, action, onAction, caption, children, gap = SP[3], right }: { title?: string; action?: string; onAction?: () => void; caption?: boolean; children?: ReactNode; gap?: number; right?: ReactNode }) {
  return (
    <View style={{ gap }}>
      {title ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: caption ? 18 : 26 }}>
          {caption ? <T v="overline" color={C.stone2}>{title}</T> : <T v="heading">{title}</T>}
          {right ?? (action ? (
            <Press onPress={onAction} hitSlop={12} label={`${action}, ${title}`}>
              <T v="label" size={13.5} color={C.amber}>{action}</T>
            </Press>
          ) : null)}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A pill chip for one of many choices (rooms, people). Selected is bone on coal, like the design. You feel it. */
export function Pill({ label, on, onPress, icon, count }: { label: string; on?: boolean; onPress?: () => void; icon?: string; count?: number }) {
  return (
    <Press onPress={onPress} haptic="select" label={label} selected={!!on} hitSlop={{ top: 4, bottom: 4 }}
      style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingLeft: icon ? 11 : 15, paddingRight: 15, borderRadius: R.full, backgroundColor: on ? C.bone : C.card, borderWidth: 1, borderColor: on ? C.bone : C.edge }}>
      {icon ? <Icon name={icon} size={16} color={on ? C.coal : C.stone} /> : null}
      <T v="labelSm" color={on ? C.coal : C.bone2}>{label}</T>
      {count != null ? <T v="micro" color={on ? alpha('#000000', 0.55) : C.stone2}>{String(count)}</T> : null}
    </Press>
  );
}

/** A horizontal row that scrolls, bleeding to the screen edges, with the page's gutter at each end. */
export function HScroll({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -SP.gutter, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: SP.gutter, paddingVertical: 2, gap }}>
      {children}
    </ScrollView>
  );
}

export interface SegOption { id: string; label: string; icon?: string; color?: string }

/**
 * A segmented control for a few choices: a thumb slides to the chosen one on a spring. The choice shows at
 * once; `onChange` sends it. `value` of null (nothing chosen, e.g. a device that's off) hides the thumb.
 */
export function Segmented({ options, value, onChange, color = C.bone, label, compact }: { options: SegOption[]; value: string | null; onChange: (id: string) => void; color?: string; label?: string; compact?: boolean }) {
  const [w, setW] = useState(0);
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  const idx = options.findIndex(o => o.id === shown);
  const x = useRef(new Animated.Value(Math.max(0, idx))).current;
  const vis = useStateValue(idx >= 0);
  const first = useRef(true);
  useEffect(() => {
    if (idx < 0) return;
    if (first.current || !w) { x.setValue(idx); first.current = false; return; }
    spring(x, idx, 'toggle', { native: false }).start();
  }, [idx, w, x]);
  const segW = w ? (w - 6) / options.length : 0;
  const active = options[idx];
  const thumb = active?.color ?? color;
  const h = compact ? 38 : 46;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', padding: 3, borderRadius: R.md, backgroundColor: C.inset, borderWidth: 1, borderColor: C.edge }}>
      {segW ? (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 3, left: 3, width: segW, height: h, borderRadius: R.md - 3,
          backgroundColor: thumb === C.bone ? C.selected : alpha(thumb, 0.18), borderWidth: 1, borderColor: thumb === C.bone ? C.edgeTop : alpha(thumb, 0.45),
          opacity: vis, transform: [{ translateX: x.interpolate({ inputRange: [0, Math.max(1, options.length - 1)], outputRange: [0, segW * Math.max(1, options.length - 1)] }) }] }} />
      ) : null}
      {options.map(o => {
        const on = o.id === shown;
        const fg = on ? (o.color ?? (color === C.bone ? C.bone : color)) : C.stone;
        return (
          <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
            onPress={() => { if (o.id === shown) return; haptic.select(); setShown(o.id); onChange(o.id); }}
            style={{ flex: 1, height: h, alignItems: 'center', justifyContent: 'center', flexDirection: compact ? 'row' : 'column', gap: compact ? 5 : 1 }}>
            {o.icon && !compact ? <Icon name={o.icon} size={18} color={fg} fill={on} /> : null}
            <T v="micro" size={compact ? 12.5 : 11.5} color={on ? (o.color || color === C.bone ? C.bone : fg) : C.stone} numberOfLines={1}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * An on/off switch. The thumb crosses on a spring and swells a little under the finger; the track's colour
 * follows in the 200 ms state change. It moves the moment it's tapped (and goes back if the change never
 * comes through), so a setting that waits on the hub still answers the finger at once.
 */
export function Switch({ on, onChange, big, label, color = C.amber, disabled }: { on: boolean; onChange?: (v: boolean) => void; big?: boolean; label?: string; color?: string; disabled?: boolean }) {
  const [shown, setShown] = useState(on);
  const onRef = useRef(on);
  onRef.current = on;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setShown(on); if (timer.current) clearTimeout(timer.current); }, [on]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const x = useRef(new Animated.Value(on ? 1 : 0)).current;
  const held = useRef(new Animated.Value(0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    spring(x, shown ? 1 : 0, 'toggle').start();
  }, [shown, x]);
  const c = useStateValue(shown);
  const w = big ? 54 : 44, h = big ? 32 : 26, k = h - 6;
  const vPad = Math.max(8, Math.ceil((MOTION.target - h) / 2)), hPad = Math.max(4, Math.ceil((MOTION.target - w) / 2));
  const flip = () => {
    const v = !shown;
    setShown(v);
    haptic.select();
    onChange?.(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(onRef.current), 4000);
  };
  return (
    <Pressable onPress={flip} disabled={disabled} onPressIn={() => spring(held, 1, 'grow').start()} onPressOut={() => spring(held, 0, 'grow').start()}
      accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: shown, disabled }} hitSlop={{ top: vPad, bottom: vPad, left: hPad, right: hPad }}
      style={{ opacity: disabled ? 0.45 : 1 }}>
      <Animated.View style={{ width: w, height: h, borderRadius: h / 2, padding: 3, backgroundColor: c.interpolate({ inputRange: [0, 1], outputRange: [C.switchOff, color] }) }}>
        <Animated.View style={{ width: k, height: k, borderRadius: k / 2, backgroundColor: '#fff', boxShadow: '0px 1px 3px rgba(0,0,0,0.35)', transform: [
          { translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, w - k - 6] }) },
          { scale: held.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
        ] }} />
      </Animated.View>
    </Pressable>
  );
}

const QUARTERS = [0, 0.25, 0.5, 0.75, 1];

/**
 * A fill slider, the kind you can grab anywhere: 52 pt tall, the fill is the value, the value is written
 * inside. Dragging moves it from where it was (it doesn't jump to the finger); a tap without a drag sets it
 * where you tapped. It reports on release, so a drag isn't a flood of commands; you feel a tick passing
 * 0, 25, 50, 75 and 100 per cent. Screen readers adjust it in tens.
 */
export function Slider({ value, min = 0, max = 100, color = C.amber, onColor = C.onAmber, suffix = '%', label, icon, onChange, onRelease, disabled }: { value: number; min?: number; max?: number; color?: string; onColor?: string; suffix?: string; label?: string; icon?: string; onChange?: (v: number) => void; onRelease: (v: number) => void; disabled?: boolean }) {
  const [w, setW] = useState(1);
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? value;
  const held = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  const ref = useRef({ w, min, max, value, onChange, onRelease, v0: 0, x0: 0, last: 0, moved: false });
  Object.assign(ref.current, { w, min, max, value, onChange, onRelease });
  const clamp = (n: number) => { const r = ref.current; return Math.round(Math.max(r.min, Math.min(r.max, n))); };
  const frac = (n: number) => { const r = ref.current; return r.max > r.min ? (n - r.min) / (r.max - r.min) : 0; };
  const move = (n: number) => {
    const r = ref.current, p0 = frac(r.last), p1 = frac(n);
    if (n !== r.last && QUARTERS.some(m => (p0 < m && m <= p1) || (p1 <= m && m < p0))) haptic.tick();
    r.last = n;
    setLive(n);
    r.onChange?.(n);
  };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: e => {
      const r = ref.current;
      r.v0 = r.value; r.last = r.value; r.moved = false; r.x0 = e.nativeEvent.locationX;
      spring(held, 1, 'grow').start();
    },
    onPanResponderMove: (_e, g) => {
      const r = ref.current;
      if (!r.moved && Math.abs(g.dx) < 4) return;
      r.moved = true;
      move(clamp(r.v0 + (g.dx / r.w) * (r.max - r.min)));
    },
    onPanResponderRelease: (_e, g) => {
      const r = ref.current;
      const n = r.moved ? clamp(r.v0 + (g.dx / r.w) * (r.max - r.min)) : clamp(r.min + (r.x0 / r.w) * (r.max - r.min));
      if (!r.moved) haptic.tick();
      spring(held, 0, 'grow').start();
      setLive(n);
      r.onRelease(n);
      setTimeout(() => setLive(null), 600);
    },
    onPanResponderTerminate: () => { spring(held, 0, 'grow').start(); setLive(null); },
  })).current;
  const pct = max > min ? (v - min) / (max - min) : 0;
  const step = Math.max(1, Math.round((max - min) / 10));
  const inside = pct > 0.16;
  return (
    <Animated.View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} {...(disabled ? {} : pan.panHandlers)}
      accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: v, text: `${v}${suffix}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={e => onRelease(Math.max(min, Math.min(max, value + (e.nativeEvent.actionName === 'increment' ? step : -step))))}
      style={{ height: 52, borderRadius: R.md + 2, backgroundColor: C.control, overflow: 'hidden', justifyContent: 'center', opacity: disabled ? 0.45 : 1,
        transform: reduced ? [] : [{ scaleY: held.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, backgroundColor: color }}>
        <View style={{ position: 'absolute', right: 6, top: 14, bottom: 14, width: 3, borderRadius: 2, backgroundColor: alpha('#000000', 0.18) }} />
      </View>
      <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SP[4], gap: SP[2] }}>
        {icon ? <Icon name={icon} size={20} color={inside ? onColor : C.bone2} fill /> : null}
        <View style={{ flex: 1 }} />
        <T v="label" tabular color={pct > 0.86 ? onColor : C.bone}>{`${v}${suffix}`}</T>
      </View>
    </Animated.View>
  );
}

/** A small spinning arc, for something on its way (a command, a page loading). */
export function Spinner({ size = 18, color = C.stone, width = 2.2 }: { size?: number; color?: string; width?: number }) {
  const t = useLoop(true, MOTION.dur.spin, { essential: true });
  const r = (size - width) / 2, c = 2 * Math.PI * r;
  return (
    <Animated.View accessibilityRole="progressbar" accessibilityLabel="Working" style={{ width: size, height: size, transform: [{ rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={alpha(color === C.stone ? '#a3a09a' : color, 0.22)} strokeWidth={width} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={width} fill="none" strokeDasharray={`${c * 0.28} ${c}`} strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}

/** A dot that breathes: live, reconnecting, recording. Still with reduced motion. */
export function PulseDot({ color, size = 8 }: { color: string; size?: number }) {
  const t = useLoop(true, 1600);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color,
        opacity: t.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.55, 0, 0] }), transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }] }} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

/**
 * A placeholder in the shape of what's coming, with a light sweeping across it. Screens draw their own
 * layout out of these while they wait, instead of a spinner. Still (no sweep) with reduced motion.
 */
export function Skeleton({ w, h, r = R.sm, style }: { w?: number | `${number}%`; h: number; r?: number; style?: StyleProp<ViewStyle> }) {
  const t = useLoop(true, MOTION.dur.shimmer);
  const [width, setWidth] = useState(300);
  return (
    <View onLayout={e => setWidth(e.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[{ width: w, height: h, borderRadius: r, backgroundColor: C.inset, overflow: 'hidden' }, style]}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, width: 160, transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-160, width + 160] }) }] }}>
        <LinearGradient colors={['rgba(255,255,255,0)', C.shimmer, 'rgba(255,255,255,0)']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ flex: 1 }} />
      </Animated.View>
    </View>
  );
}

/** How far past its resting place a sheet stretches when pulled up: it gives, less and less, up to `limit`. */
const rubber = (d: number, limit = 56) => limit * (1 - 1 / (d * 0.55 / limit + 1));

/**
 * A bottom sheet: 28 px top corners over a deep scrim. It rises on a spring, follows the finger when its
 * top is dragged (stretching a little if pulled up), and closes when let go far enough or flicked down,
 * carrying the flick's speed. Tap the grabber or the scrim to close; its content stays while it slides away.
 */
export function Sheet({ open, onClose, children, label = 'Panel' }: { open: boolean; onClose: () => void; children: ReactNode; label?: string }) {
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [h, setH] = useState(screenH);
  const y = useRef(new Animated.Value(screenH)).current;
  const fade = useRef(new Animated.Value(reduced ? 0 : 1)).current;
  const [shown, setShown] = useState(open);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const hRef = useRef(h);
  hRef.current = h;
  const flick = useRef(0);
  const last = useRef(children);
  if (open) last.current = children;
  useEffect(() => {
    if (open) {
      const wasShown = shownRef.current;
      setShown(true);
      haptic.light();
      if (reduced) { y.setValue(0); tween(fade, 1, { duration: MOTION.dur.fade }).start(); return; }
      fade.setValue(1);
      if (!wasShown) y.setValue(hRef.current);
      spring(y, 0, 'sheet').start();
    } else if (shownRef.current) {
      haptic.light();
      const done = ({ finished }: { finished: boolean }) => { if (finished) setShown(false); };
      if (reduced) { tween(fade, 0, { duration: MOTION.dur.fade, leaving: true }).start(done); return; }
      const velocity = flick.current;
      flick.current = 0;
      (velocity > 0 ? spring(y, hRef.current, 'sheet', { velocity, clamp: true }) : tween(y, hRef.current, { duration: MOTION.dur.exit, leaving: true })).start(done);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const start = useRef(0);
  const drag = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { y.stopAnimation(v => { start.current = v; }); },
    onPanResponderMove: (_e, g) => { const d = start.current + g.dy; y.setValue(d >= 0 ? d : -rubber(-d)); },
    onPanResponderRelease: (_e, g) => {
      const d = start.current + g.dy;
      if ((d > Math.min(140, hRef.current * 0.3) && g.vy > -0.1) || g.vy > 0.75) { flick.current = Math.max(0, g.vy * 1000); closeRef.current(); }
      else spring(y, 0, 'sheet', { velocity: g.vy * 1000 }).start();
    },
    onPanResponderTerminate: () => spring(y, 0, 'sheet').start(),
  })).current;
  if (!shown) return null;
  const lift = y.interpolate({ inputRange: [0, Math.max(1, h)], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={{ flex: 1, backgroundColor: C.scrimDeep, opacity: Animated.multiply(fade, lift) }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${label}`} />
      </Animated.View>
      <Animated.View onLayout={e => setH(e.nativeEvent.layout.height)} accessibilityViewIsModal
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '92%', borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, backgroundColor: C.sheet, borderWidth: 1, borderBottomWidth: 0, borderColor: C.edgeTop, boxShadow: SHADOW.sheet, opacity: fade, transform: [{ translateY: y }] }}>
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: 120, backgroundColor: C.sheet }} />
        <View {...drag.panHandlers}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${label}`} accessibilityHint="Or swipe down" style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 14 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: C.switchOff }} />
          </Pressable>
        </View>
        <ScrollView
          onScrollEndDrag={e => { if (e.nativeEvent.contentOffset.y < -70) onClose(); }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: SP[5], paddingBottom: insets.bottom + SP[8], gap: SP[6] }} keyboardShouldPersistTaps="handled">
          {open ? children : last.current}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

/**
 * The confirmation after an action, with Undo when the hub gave one. It springs up from below, settles, and
 * slides away when the hub clears it; a sideways swipe sends it off early. An error buzzes and turns red.
 */
export function ToastHost({ toast, onUndo, bottom }: { toast: Toast | null; onUndo: (t: Toast) => void; bottom: number }) {
  const [cur, setCur] = useState<Toast | null>(toast);
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(0)).current;
  const x = useRef(new Animated.Value(0)).current;
  const hadOne = useRef(false);
  useEffect(() => {
    if (toast) {
      setCur(toast);
      x.setValue(0);
      if (toast.error) haptic.error();
      a.setValue(hadOne.current ? 0.7 : 0);
      hadOne.current = true;
      (reduced ? tween(a, 1, { duration: MOTION.dur.fade }) : spring(a, 1, 'pop')).start();
    } else {
      hadOne.current = false;
      tween(a, 0, { duration: MOTION.dur.exit, leaving: true }).start(({ finished }) => { if (finished) setCur(null); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);
  const swipe = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_e, g) => x.setValue(g.dx),
    onPanResponderRelease: (_e, g) => {
      if (Math.abs(g.dx) > 90 || Math.abs(g.vx) > 0.6) {
        const dir = (g.dx || g.vx) > 0 ? 1 : -1;
        hadOne.current = false;
        tween(x, dir * 500, { duration: MOTION.dur.exit, leaving: true }).start(() => setCur(null));
      } else spring(x, 0, 'press', { velocity: g.vx * 1000 }).start();
    },
    onPanResponderTerminate: () => spring(x, 0, 'press').start(),
  })).current;
  if (!cur) return null;
  const move = reduced ? [] : [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }, { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }];
  return (
    <Animated.View {...swipe.panHandlers} accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ position: 'absolute', left: SP[4], right: SP[4], bottom,
      opacity: Animated.multiply(a.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }), x.interpolate({ inputRange: [-300, 0, 300], outputRange: [0, 1, 0], extrapolate: 'clamp' })),
      transform: [{ translateX: x }, ...move] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 52, paddingVertical: SP[3], paddingLeft: SP[4], paddingRight: cur.undo || cur.action ? 6 : SP[4], borderRadius: R.lg, backgroundColor: cur.error ? '#3a1d1a' : C.bone, borderWidth: 1, borderColor: cur.error ? C.redLine : 'rgba(255,255,255,0.6)', boxShadow: SHADOW.toast }}>
        <Icon name={cur.error ? 'error' : cur.action ? 'cloud_download' : cur.undo ? 'check_circle' : 'info'} size={20} color={cur.error ? C.redText : C.coal} fill />
        <T v="label" weight={600} color={cur.error ? C.redText : C.coal} style={{ flex: 1 }}>{cur.text}</T>
        {cur.undo || cur.action ? (
          <Press onPress={() => cur.action ? cur.action.run() : onUndo(cur)} haptic="select" label={cur.action?.label ?? 'Undo'} style={{ minHeight: 40, justifyContent: 'center', paddingVertical: SP[2], paddingHorizontal: SP[4], borderRadius: R.sm + 2, backgroundColor: cur.action ? C.coal : 'rgba(0,0,0,0.08)' }}>
            <T v="label" weight={800} color={cur.action ? C.bone : C.coal}>{cur.action?.label ?? 'Undo'}</T>
          </Press>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** Nothing to show: an icon, what's missing in a few words, and what to do about it. `compact` sits inside a section. */
export function Empty({ icon, title, text, action, onAction, compact, tone = C.stone }: { icon: string; title: string; text?: string; action?: string; onAction?: () => void; compact?: boolean; tone?: string }) {
  if (compact) {
    return (
      <Appear style={{ flexDirection: 'row', alignItems: action ? 'flex-start' : 'center', gap: SP[3], paddingVertical: SP[4], paddingHorizontal: SP[4], borderRadius: R.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.1)' }}>
        <IconWell icon={icon} color={tone} size={36} />
        {/* The action sits under the words, so they keep the width on a small phone. */}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="headline" size={14}>{title}</T>
          {text ? <T v="footnote" color={C.stone}>{text}</T> : null}
          {action ? <View style={{ marginTop: SP[2] }}><Button size="sm" kind="secondary" label={action} onPress={onAction} /></View> : null}
        </View>
      </Appear>
    );
  }
  return (
    <Appear style={{ paddingVertical: SP[8], paddingHorizontal: SP[5], borderRadius: R.xl, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, alignItems: 'center', gap: SP[2] }}>
      <IconWell icon={icon} color={tone} size={52} radius={26} />
      <T v="headline" size={16} center style={{ marginTop: SP[2] }}>{title}</T>
      {text ? <T v="callout" color={C.stone} center>{text}</T> : null}
      {action ? <View style={{ marginTop: SP[3] }}><Button label={action} onPress={onAction} /></View> : null}
    </Appear>
  );
}

/** A group of rows on one card (an inset grouped list), with an optional caption above and a note below. */
export function Group({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <View style={{ gap: SP[2] }}>
      {title ? <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>{title}</T> : null}
      <Card style={{ overflow: 'hidden' }}>{children}</Card>
      {note ? <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{note}</T> : null}
    </View>
  );
}

/** A row in a grouped list: tinted icon well, title and subtitle, then a chevron, a switch or anything on the right. */
export function Row({ icon, iconBg, iconFg = C.bone, title, sub, subColor = C.stone, onPress, right, first, badge, fill, busy }: { icon?: string; iconBg?: string; iconFg?: string; title: string; sub?: string; subColor?: string; onPress?: () => void; right?: ReactNode; first?: boolean; badge?: boolean; fill?: boolean; busy?: boolean }) {
  const body = (
    <>
      {icon ? (
        <View>
          <IconWell icon={icon} color={iconFg} bg={iconBg ?? (iconFg === C.bone ? C.selected : undefined)} size={36} fill={fill} />
          {badge ? <View accessibilityLabel="Needs attention" style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: 5, backgroundColor: C.amber, borderWidth: 2, borderColor: C.card }} /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <T v="headline">{title}</T>
        {sub ? <T v="footnote" color={subColor} numberOfLines={2}>{sub}</T> : null}
      </View>
      {busy ? <Spinner /> : right ?? (onPress ? <Icon name="chevron_right" size={20} color={C.stone2} /> : null)}
    </>
  );
  const style: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 62, paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline };
  return onPress ? <Press onPress={onPress} give="soft" label={sub ? `${title}, ${sub}` : title} style={style}>{body}</Press> : <View style={style}>{body}</View>;
}

/** A row with a switch: the whole row flips it, and a screen reader hears it as one switch. */
export function SwitchRow({ icon, iconFg, title, sub, on, onChange, first, busy, color }: { icon?: string; iconFg?: string; title: string; sub?: string; on: boolean; onChange: (v: boolean) => void; first?: boolean; busy?: boolean; color?: string }) {
  return (
    <View accessible={false} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 62, paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      {icon ? <IconWell icon={icon} color={on ? (iconFg ?? C.green) : C.bone} bg={on ? undefined : C.selected} fill={on} size={36} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T v="headline">{title}</T>
        {sub ? <T v="footnote" color={C.stone}>{sub}</T> : null}
      </View>
      {busy ? <Spinner /> : <Switch label={title} on={on} onChange={onChange} color={color} />}
    </View>
  );
}

/** A small reading: label in capitals, value large. */
export function Stat({ label, value, color = C.bone, icon }: { label: string; value: string; color?: string; icon?: string }) {
  return (
    <Card style={{ flex: 1, padding: SP[3] + 2, gap: SP[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {icon ? <Icon name={icon} size={15} color={C.stone2} /> : null}
        <T v="eyebrow" color={C.stone2}>{label}</T>
      </View>
      <T v="title" size={20} color={color} tabular maxFontSizeMultiplier={1.2}>{value}</T>
    </Card>
  );
}

/** A person's initial in a circle; a green ring and dot when they're home. */
/** A person: their photo when they have one (`photo`, the hub's address for it), else their initial. */
export function Avatar({ name, home, size = 34, ring = C.page, photo }: { name: string; home?: boolean; size?: number; ring?: string; photo?: string | null }) {
  const { route, cfg } = useHub();
  const base = route?.url ?? cfg?.url;
  const uri = photo ? (/^https?:/.test(photo) ? photo : base ? `${base}${photo}` : null) : null;
  return (
    <View accessibilityLabel={`${name}, ${home ? 'home' : 'out'}`} style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: home ? alpha(C.green, 0.16) : C.control, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: ring, overflow: 'hidden' }}>
        {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessible={false} />
          : <T weight={800} size={Math.round(size * 0.38)} color={home ? C.green : C.stone}>{name[0]?.toUpperCase() ?? '?'}</T>}
      </View>
      {home ? <View style={{ position: 'absolute', right: -1, bottom: -1, width: size * 0.32, height: size * 0.32, borderRadius: size, backgroundColor: C.green, borderWidth: 2, borderColor: ring }} /> : null}
    </View>
  );
}

type BtnState = 'idle' | 'busy' | 'done' | 'failed';

/**
 * A button. If `onPress` returns a promise, it shows a spinner until it settles, then a check (or shakes when
 * it resolves to false or throws), and ignores taps in between, so nothing is sent twice.
 */
export function Button({ label, icon, onPress, kind = 'primary', busy, size = 'md', full, doneLabel }: { label: string; icon?: string; onPress?: () => unknown; kind?: 'primary' | 'secondary' | 'ghost' | 'blue' | 'danger'; busy?: boolean; size?: 'sm' | 'md' | 'lg'; full?: boolean; doneLabel?: string }) {
  const [st, setSt] = useState<BtnState>('idle');
  const x = useRef(new Animated.Value(0)).current;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const state: BtnState = busy ? 'busy' : st;
  const bg = { primary: C.amber, blue: C.blue, secondary: C.control2, ghost: 'transparent', danger: C.redTint }[kind];
  const fg = { primary: C.onAmber, blue: C.onBlue, secondary: C.bone, ghost: C.amber, danger: C.red }[kind];
  const h = size === 'sm' ? 36 : size === 'lg' ? 54 : 48;
  const go = () => {
    if (state === 'busy' || !onPress) return;
    const r = onPress();
    if (!(r instanceof Promise)) return;
    setSt('busy');
    r.then(ok => {
      if (!alive.current) return;
      if (ok === false) { setSt('failed'); shake(x); setTimeout(() => alive.current && setSt('idle'), 900); return; }
      setSt('done');
      setTimeout(() => alive.current && setSt('idle'), MOTION.dur.done);
    }, () => { if (!alive.current) return; setSt('failed'); shake(x); setTimeout(() => alive.current && setSt('idle'), 900); });
  };
  const glyph = state === 'busy' ? <Spinner size={size === 'sm' ? 15 : 18} color={fg} /> : state === 'done' ? <Icon name="check" size={size === 'sm' ? 17 : 19} color={fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 17 : 19} color={fg} /> : null;
  return (
    <Animated.View style={{ transform: [{ translateX: x }], alignSelf: full ? 'stretch' : size === 'sm' ? 'flex-start' : undefined, maxWidth: '100%' }}>
      <Press onPress={go} label={label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SP[2] - 1, minHeight: h, paddingVertical: size === 'sm' ? 7 : 12, paddingHorizontal: size === 'sm' ? 14 : 20, borderRadius: size === 'sm' ? R.sm + 1 : R.md, backgroundColor: bg,
        borderWidth: kind === 'secondary' ? 1 : 0, borderColor: C.edge, opacity: state === 'busy' ? 0.85 : 1 }}>
        {glyph}
        <T v="label" size={size === 'sm' ? 13 : size === 'lg' ? 16 : 15} color={fg} center style={{ flexShrink: 1 }}>{state === 'done' && doneLabel ? doneLabel : label}</T>
      </Press>
    </Animated.View>
  );
}

/** A small rounded tag: a mode's name, NOW, a count. */
export function Tag({ text, color = C.stone, solid }: { text: string; color?: string; solid?: boolean }) {
  return (
    <View style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: R.full, backgroundColor: solid ? color : alpha(color, 0.14), alignSelf: 'flex-start' }}>
      <T v="micro" color={solid ? C.coal : color}>{text}</T>
    </View>
  );
}

/**
 * Something to know or act on (an alert, a warning, a problem with a device): a card washed in its colour, a
 * tinted well with its icon, an optional eyebrow (how urgent), the title, a line or two of detail, and its actions
 * underneath (`NoticeAction`s). The one way the app raises something: Now's alerts, Sensors, a device's panel.
 */
export function Notice({ icon, color, eyebrow, title, text, children, compact }: { icon: string; color: string; eyebrow?: string; title: string; text?: string; children?: ReactNode; compact?: boolean }) {
  return (
    <Card tint={color} pad={compact ? SP[3] : SP[4]} style={{ gap: SP[3], backgroundColor: alpha(color, 0.08) }}>
      <View style={{ flexDirection: 'row', gap: SP[3], alignItems: compact && !text ? 'center' : 'flex-start' }}>
        <IconWell icon={icon} color={color} bg={alpha(color, 0.16)} size={compact ? 32 : 38} fill />
        <View style={{ flex: 1, minWidth: 0, gap: 2, paddingTop: compact && !text ? 0 : 1 }}>
          {eyebrow ? <T v="eyebrow" color={color}>{eyebrow}</T> : null}
          <T v={compact ? 'callout' : 'headline'} weight={compact ? 600 : undefined}>{title}</T>
          {text ? <T v="footnote" color={C.stone} numberOfLines={3}>{text}</T> : null}
        </View>
      </View>
      {children ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>{children}</View> : null}
    </Card>
  );
}

/** One of a Notice's actions: `main` in the notice's colour, the others quieter. They share the row and wrap when narrow. */
export function NoticeAction({ label, onPress, main, color = C.amber, a11y }: { label: string; onPress: () => void; main?: boolean; color?: string; a11y?: string }) {
  return (
    <Press onPress={onPress} label={a11y ?? label} hitSlop={{ top: 4, bottom: 4 }}
      style={{ flexGrow: 1, minHeight: 36, paddingHorizontal: SP[3], alignItems: 'center', justifyContent: 'center', borderRadius: R.sm + 1, borderWidth: 1,
        backgroundColor: main ? alpha(color, 0.18) : C.control2, borderColor: main ? alpha(color, 0.4) : C.edge }}>
      <T v="labelSm" color={main ? color : C.bone2} numberOfLines={1}>{label}</T>
    </Press>
  );
}

/**
 * A row in a grouped list that opens in place to show its choices (a room's alerts, an event kind's alerts): the
 * title, what's chosen now underneath, a chevron; tapped, the choices appear below it. Keeps long settings lists
 * short until you want one.
 */
export function ExpandRow({ icon, iconFg = C.bone, title, sub, open, onToggle, first, children }: { icon?: string; iconFg?: string; title: string; sub?: string; open: boolean; onToggle: () => void; first?: boolean; children: ReactNode }) {
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <Press onPress={onToggle} give="soft" haptic="select" label={sub ? `${title}, ${sub}` : title} selected={open}
        style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 58, paddingVertical: SP[3], paddingHorizontal: SP[4] }}>
        {icon ? <IconWell icon={icon} color={iconFg} bg={iconFg === C.bone ? C.selected : undefined} size={36} /> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="headline" numberOfLines={1}>{title}</T>
          {sub ? <T v="footnote" color={C.stone}>{sub}</T> : null}
        </View>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={20} color={C.stone2} />
      </Press>
      {open ? <View style={{ gap: SP[3], paddingHorizontal: SP[4], paddingBottom: SP[4] }}>{children}</View> : null}
    </View>
  );
}

/**
 * Choices laid out as a grid of chips (`columns` to a row), for more options than a Segmented control can fit on a
 * small phone (an air conditioner's six fan speeds). The chosen one is lit in `color`.
 */
export function Chips({ options, value, onChange, color = C.bone, label, columns = 3 }: { options: SegOption[]; value: string | null; onChange: (id: string) => void; color?: string; label?: string; columns?: number }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
      {options.map(o => {
        const on = o.id === value;
        const c = o.color ?? color;
        return (
          <Press key={o.id} role="radio" selected={on} label={o.label} haptic="select" onPress={() => { if (!on) onChange(o.id); }}
            style={{ flexBasis: `${Math.floor(100 / columns) - 4}%`, flexGrow: 1, minHeight: 42, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SP[2], borderRadius: R.sm + 2, borderWidth: 1,
              backgroundColor: on ? (c === C.bone ? C.selected : alpha(c, 0.18)) : C.inset, borderColor: on ? (c === C.bone ? C.edgeTop : alpha(c, 0.45)) : C.edge }}>
            {o.icon ? <Icon name={o.icon} size={17} color={on ? c : C.stone} fill={on} /> : null}
            <T v="labelSm" color={on ? C.bone : C.stone} numberOfLines={1}>{o.label}</T>
          </Press>
        );
      })}
    </View>
  );
}
