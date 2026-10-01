import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type Insets, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, MOTION, SHADOW } from '../theme';
import type { Toast } from '../state/hub';
import { Icon } from './Icon';
import { Appear, haptic, spring, tween, useReducedMotion, useStateValue, type HapticKind } from './motion';
import { T } from './Text';

// Motion comes from MOTION in theme.ts (the design's 120 ms press to 0.97, 200 ms state changes, 280 ms sheets),
// through ui/motion.tsx, which also handles reduced motion and haptics.

const OUTER = new Set(['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'width', 'minWidth', 'maxWidth', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'position', 'top', 'left', 'right', 'bottom']);

/** Padding for the hit area of a control drawn smaller than a finger (MOTION.target), from its fixed size. */
function targetSlop(s: ViewStyle): Insets | undefined {
  const pad = (n: unknown) => typeof n === 'number' && n < MOTION.target ? Math.ceil((MOTION.target - n) / 2) : 0;
  const x = pad(s.width), y = pad(s.height);
  return x || y ? { left: x, right: x, top: y, bottom: y } : undefined;
}

/**
 * Anything tappable. It gives under the finger (scale to 0.97 and a slight dim, or only the dim with reduced
 * motion) and springs back when let go. Small controls get a hit area of at least 44 pt. `haptic` adds a tap
 * you can feel, for choices that don't already send a command (which has its own).
 */
export function Press({ onPress, onLongPress, style, children, disabled, hitSlop, label, haptic: feel }: { onPress?: () => void; onLongPress?: () => void; style?: StyleProp<ViewStyle>; children?: ReactNode; disabled?: boolean; hitSlop?: number | Insets; label?: string; haptic?: HapticKind }) {
  const s = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  // How the button sits in its parent (flex, width) belongs on the outer Pressable; how it looks, on the inner view.
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle & Record<string, unknown>;
  const outer: Record<string, unknown> = {}, inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) (OUTER.has(k) ? outer : inner)[k] = v;
  const base = (typeof inner.opacity === 'number' ? inner.opacity : 1) * (disabled ? 0.5 : 1);
  delete inner.opacity;
  // Made once per look, not every render: a press animates natively, and a fresh node each render would be re-sent.
  const opacity = useMemo(() => Animated.multiply(s.interpolate({ inputRange: [MOTION.press.scale, 1], outputRange: [reduced ? MOTION.press.dimReduced : MOTION.press.dim, 1], extrapolate: 'clamp' }), base), [s, reduced, base]);
  return (
    <Pressable
      style={outer as ViewStyle} onPress={onPress && (() => { if (feel) haptic[feel](); onPress(); })} onLongPress={onLongPress} disabled={disabled} hitSlop={hitSlop ?? targetSlop(flat)}
      onPressIn={() => tween(s, MOTION.press.scale, { duration: MOTION.dur.press }).start()} onPressOut={() => spring(s, 1, 'press').start()}
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={disabled ? { disabled } : undefined}
    >
      <Animated.View style={[inner as ViewStyle, 'flex' in outer || 'flexGrow' in outer ? { flexGrow: 1 } : null, { opacity, transform: [{ scale: reduced ? 1 : s }] }]}>{children}</Animated.View>
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      {onBack ? (
        <Press onPress={onBack} label="Back" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrow_back" size={21} />
        </Press>
      ) : null}
      <View style={{ flex: 1, gap: 3 }}>
        {over ? <T size={12.5} weight={500} color={C.stone}>{over}</T> : null}
        <T size={onBack ? 27 : 32} weight={700} tracking={-0.025}>{title}</T>
      </View>
      {right}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <T size={17} weight={700} tracking={-0.01}>{children}</T>
      {right}
    </View>
  );
}

/** A pill chip: room filters, activity filters. Selected is bone on coal, like the design. A choice, so you feel it. */
export function Pill({ label, on, onPress }: { label: string; on?: boolean; onPress?: () => void }) {
  return (
    <Press onPress={onPress} haptic="select" label={label} hitSlop={{ top: 4, bottom: 4 }} style={{ minHeight: 36, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 15, borderRadius: 999, backgroundColor: on ? C.bone : C.card }}>
      <T size={13} weight={on ? 700 : 600} color={on ? C.coal : C.bone2}>{label}</T>
    </Press>
  );
}

/** A horizontal row that scrolls, bleeding to the screen edges like the web app's pill rows. */
export function HScroll({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -18, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 2, gap }}>
      {children}
    </ScrollView>
  );
}

/**
 * An on/off switch. The thumb crosses on a spring and swells a little under the finger; the track's colour
 * follows in the 200 ms state change. It moves the moment it's tapped (and goes back if the change never
 * comes through), so a setting that waits on the hub still answers the finger at once.
 */
export function Switch({ on, onChange, big, label }: { on: boolean; onChange?: (v: boolean) => void; big?: boolean; label?: string }) {
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
  const w = big ? 52 : 40, h = big ? 32 : 24, k = h - 6;
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
    <Pressable onPress={flip} onPressIn={() => spring(held, 1, 'grow').start()} onPressOut={() => spring(held, 0, 'grow').start()}
      accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: shown }} hitSlop={{ top: vPad, bottom: vPad, left: hPad, right: hPad }}>
      <Animated.View style={{ width: w, height: h, borderRadius: h / 2, padding: 3, backgroundColor: c.interpolate({ inputRange: [0, 1], outputRange: [C.switchOff, C.amber] }) }}>
        <Animated.View style={{ width: k, height: k, borderRadius: k / 2, backgroundColor: '#fff', boxShadow: '0px 1px 3px rgba(0,0,0,0.35)', transform: [
          { translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, w - k - 6] }) },
          { scale: held.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) },
        ] }} />
      </Animated.View>
    </Pressable>
  );
}

const QUARTERS = [0, 0.25, 0.5, 0.75, 1];
const THUMB = 24;

/**
 * A slider that reports on release (so a drag isn't a flood of commands). While dragging, the thumb grows,
 * a bubble above it shows the value, and you feel a tick passing 0, 25, 50, 75 and 100 per cent.
 */
export function Slider({ value, min = 0, max = 100, color = C.amber, suffix = '', label, onChange, onRelease }: { value: number; min?: number; max?: number; color?: string; suffix?: string; label?: string; onChange?: (v: number) => void; onRelease: (v: number) => void }) {
  const [w, setW] = useState(1);
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? value;
  const held = useRef(new Animated.Value(0)).current;
  // The responder is made once, so it reads the width and range through a ref: from the first render's
  // state it would keep a width of 1 and snap every touch to the ends. A drag is where the finger first
  // touched plus how far it has moved (locationX alone jumps about once the finger leaves the track).
  const ref = useRef({ w, min, max, onChange, onRelease, x0: 0, last: 0 });
  Object.assign(ref.current, { w, min, max, onChange, onRelease });
  const at = (x: number) => { const r = ref.current; return Math.round(r.min + Math.max(0, Math.min(1, x / r.w)) * (r.max - r.min)); };
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
      r.x0 = e.nativeEvent.locationX;
      r.last = at(r.x0);
      haptic.tick();
      spring(held, 1, 'grow').start();
      setLive(r.last);
      r.onChange?.(r.last);
    },
    onPanResponderMove: (_e, g) => move(at(ref.current.x0 + g.dx)),
    onPanResponderRelease: (_e, g) => { const n = at(ref.current.x0 + g.dx); spring(held, 0, 'grow').start(); setLive(null); ref.current.onRelease(n); },
    onPanResponderTerminate: () => { spring(held, 0, 'grow').start(); setLive(null); },
  })).current;
  const pct = max > min ? (v - min) / (max - min) : 0;
  const thumbX = pct * Math.max(0, w - THUMB);
  const BUBBLE = 54;
  const bubbleX = Math.max(-6, Math.min(w - BUBBLE + 6, thumbX + THUMB / 2 - BUBBLE / 2));
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} {...pan.panHandlers}
      accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: v }}
      style={{ height: 44, justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ height: 8, borderRadius: 4, backgroundColor: C.control, overflow: 'hidden' }}>
        <View style={{ width: `${pct * 100}%`, height: 8, backgroundColor: color }} />
      </View>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', left: thumbX, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: '#fff', borderWidth: 3, borderColor: color, boxShadow: SHADOW.raised,
        transform: [{ scale: held.interpolate({ inputRange: [0, 1], outputRange: [1, 1.3] }) }] }} />
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: -30, left: bubbleX, width: BUBBLE, height: 28, borderRadius: 10, backgroundColor: C.bone, alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.raised,
        opacity: held, transform: [{ translateY: held.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }, { scale: held.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] }}>
        <T size={13} weight={800} color={C.coal}>{`${v}${suffix}`}</T>
      </Animated.View>
    </View>
  );
}

/** How far past its resting place a sheet stretches when pulled up: it gives, less and less, up to `limit`. */
const rubber = (d: number, limit = 56) => limit * (1 - 1 / (d * 0.55 / limit + 1));

/**
 * A bottom sheet: 28 px top corners on #141517 over the scrim. It rises on a spring, follows the finger when
 * its top is dragged (stretching a little if pulled up), and closes when let go far enough or flicked down,
 * carrying the flick's speed. Tap the grabber or the scrim to close; its content stays while it slides away.
 */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [h, setH] = useState(screenH);
  const y = useRef(new Animated.Value(screenH)).current; // how far below its resting place, in px
  const fade = useRef(new Animated.Value(reduced ? 0 : 1)).current; // with reduced motion it fades instead
  const [shown, setShown] = useState(open);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const hRef = useRef(h);
  hRef.current = h;
  const flick = useRef(0); // the drag's downward speed when it closed the sheet (px/s), for the slide away
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
      <Animated.View style={{ flex: 1, backgroundColor: C.scrim, opacity: Animated.multiply(fade, lift) }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View onLayout={e => setH(e.nativeEvent.layout.height)}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '92%', borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: C.sheet, boxShadow: SHADOW.sheet, opacity: fade, transform: [{ translateY: y }] }}>
        {/* Below the sheet, so pulling it up shows more sheet rather than the page. */}
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: 120, backgroundColor: C.sheet }} />
        <View {...drag.panHandlers}>
          <Pressable onPress={onClose} accessibilityLabel="Close" style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 16 }}>
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: C.switchOff }} />
          </Pressable>
        </View>
        <ScrollView
          onScrollEndDrag={e => { if (e.nativeEvent.contentOffset.y < -70) onClose(); }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 34, gap: 18 }} keyboardShouldPersistTaps="handled">
          {open ? children : last.current}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

/**
 * The confirmation after an action, with Undo when the hub gave one. It springs up from below, settles, and
 * slides away when the hub clears it; a sideways swipe sends it off early. An error buzzes.
 */
export function ToastHost({ toast, onUndo, bottom }: { toast: Toast | null; onUndo: (t: Toast) => void; bottom: number }) {
  const [cur, setCur] = useState<Toast | null>(toast);
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(0)).current; // 0 away, 1 shown
  const x = useRef(new Animated.Value(0)).current; // the swipe
  const hadOne = useRef(false);
  useEffect(() => {
    if (toast) {
      setCur(toast);
      x.setValue(0);
      if (toast.error) haptic.error();
      // A new message over an old one nudges rather than starting from nothing.
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
    <Animated.View {...swipe.panHandlers} accessibilityLiveRegion="polite" style={{ position: 'absolute', left: 16, right: 16, bottom,
      opacity: Animated.multiply(a.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }), x.interpolate({ inputRange: [-300, 0, 300], outputRange: [0, 1, 0], extrapolate: 'clamp' })),
      transform: [{ translateX: x }, ...move] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 12, paddingLeft: 16, paddingRight: cur.undo ? 6 : 16, borderRadius: 16, backgroundColor: cur.error ? '#3a1d1a' : C.bone, boxShadow: SHADOW.toast }}>
        {cur.error ? <Icon name="error" size={19} color="#ffb4ab" fill /> : null}
        <T size={14} weight={600} color={cur.error ? '#ffb4ab' : C.coal} style={{ flex: 1 }}>{cur.text}</T>
        {cur.undo ? (
          <Press onPress={() => onUndo(cur)} haptic="select" style={{ minHeight: 36, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.08)' }}>
            <T size={13.5} weight={800} color={C.coal}>Undo</T>
          </Press>
        ) : null}
      </View>
    </Animated.View>
  );
}

export function Empty({ icon, title, text, action, onAction }: { icon: string; title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <Appear style={{ paddingVertical: 30, paddingHorizontal: 18, borderRadius: 18, backgroundColor: C.card, alignItems: 'center', gap: 8 }}>
      <Icon name={icon} size={30} color={C.stone3} />
      <T size={15} weight={700} center>{title}</T>
      <T size={13} color={C.stone} center lineHeight={1.45}>{text}</T>
      {action ? (
        <Press onPress={onAction} style={{ marginTop: 8, minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 12, backgroundColor: C.amber }}>
          <T size={14} weight={700} color={C.onAmber}>{action}</T>
        </Press>
      ) : null}
    </Appear>
  );
}

/** A row in a grouped list: tinted icon well, title and subtitle, chevron. */
export function Row({ icon, iconBg = C.selected, iconFg = C.bone, title, sub, subColor = C.stone, onPress, right, first }: { icon: string; iconBg?: string; iconFg?: string; title: string; sub?: string; subColor?: string; onPress?: () => void; right?: ReactNode; first?: boolean }) {
  return (
    <Press onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 13, paddingHorizontal: 14, borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
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
    <Press onPress={busy ? undefined : onPress} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 48, paddingVertical: 12, paddingHorizontal: 18, borderRadius: 14, backgroundColor: bg, opacity: busy ? 0.7 : 1 }}>
      {icon ? <Icon name={icon} size={19} color={fg} /> : null}
      <T size={14.5} weight={700} color={fg}>{busy ? 'Working…' : label}</T>
    </Press>
  );
}
