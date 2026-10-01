import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, LayoutAnimation, Platform, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { MOTION } from '../theme';

// The app's shared motion: easing curves and springs from theme.ts, reduced motion, haptics, and the
// small animated pieces screens use (list items fading up, values that tween between two states).

export const EASE_OUT = Easing.bezier(...MOTION.ease.out);
export const EASE_IN = Easing.bezier(...MOTION.ease.in);

// Reduced motion: read once, kept current, shared by every component.
let reduced = false;
let watching = false;
const listeners = new Set<(v: boolean) => void>();
const setReduced = (v: boolean) => { reduced = v; listeners.forEach(f => f(v)); };
function watch() {
  if (watching) return;
  watching = true;
  void AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
}
watch();

/** Whether the phone asks for reduced motion (Settings → Accessibility). Animations become fades or instant. */
export const reducedMotion = () => reduced;

export function useReducedMotion() {
  const [v, setV] = useState(reduced);
  useEffect(() => { listeners.add(setV); setV(reduced); return () => { listeners.delete(setV); }; }, []);
  return v;
}

type SpringKind = keyof typeof MOTION.spring;

/** A spring from the theme; with reduced motion, an instant change. `velocity` is in units per second. */
export function spring(v: Animated.Value, toValue: number, kind: SpringKind, o: { velocity?: number; native?: boolean; clamp?: boolean } = {}) {
  const useNativeDriver = o.native ?? true;
  if (reduced) return Animated.timing(v, { toValue, duration: 0, useNativeDriver });
  return Animated.spring(v, { toValue, ...MOTION.spring[kind], velocity: o.velocity ?? 0, overshootClamping: o.clamp, restDisplacementThreshold: 0.5, restSpeedThreshold: 0.5, useNativeDriver });
}

/** A timed change (colours, fades). Kept with reduced motion unless `motion` says it moves something. */
export function tween(v: Animated.Value, toValue: number, o: { duration?: number; native?: boolean; leaving?: boolean; motion?: boolean; delay?: number } = {}) {
  const duration = reduced && o.motion ? 0 : o.duration ?? MOTION.dur.state;
  return Animated.timing(v, { toValue, duration, delay: o.delay, easing: o.leaving ? EASE_IN : EASE_OUT, useNativeDriver: o.native ?? true });
}

/** Animate the next layout change (a section opening, a list growing). Nothing with reduced motion. */
export function animateLayout() {
  if (reduced || Platform.OS === 'web') return;
  LayoutAnimation.configureNext(LayoutAnimation.create(MOTION.dur.state, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
}

/**
 * A 0 → 1 value that follows a boolean (off → on) in the 200 ms state change. JS-driven, so it can drive
 * colours: interpolate it between a thing's off and on look. Starts where the boolean is, without animating.
 */
export function useStateValue(on: boolean, duration: number = MOTION.dur.state) {
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    tween(v, on ? 1 : 0, { duration, native: false }).start();
  }, [on, v, duration]);
  return v;
}

// Haptics: one place, so each kind means the same thing everywhere, and two in a row (a control's own
// tick and the command it sends) land as one. Phones without a haptic engine, and the web, ignore them.
let lastAt = 0;
function fire(f: () => Promise<void>, force = false) {
  const now = Date.now();
  if (!force && now - lastAt < 70) return;
  lastAt = now;
  try { void f().catch(() => {}); } catch { /* no haptics here */ }
}

export const haptic = {
  /** A choice made or a switch flipped. */
  select: () => fire(() => Haptics.selectionAsync()),
  /** A detent: a slider passing 0 / 25 / 50 / 75 / 100. */
  tick: () => fire(() => Haptics.selectionAsync(), true),
  /** Something arriving or leaving: a sheet opening or closing, a pull to refresh. */
  light: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** An action the hub confirmed. */
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), true),
  /** An action that failed. */
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error), true),
};
export type HapticKind = keyof typeof haptic;

/**
 * A list item that fades up into place when it first appears, a beat after the one before it
 * (`index`), so a list arrives as a list rather than all at once. Just there with reduced motion.
 */
export function Appear({ index = 0, children, style }: { index?: number; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const a = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { a.setValue(1); return; }
    const { step, max, dur } = MOTION.stagger;
    const anim = tween(a, 1, { duration: dur, delay: Math.min(index, max) * step });
    anim.start();
    return () => anim.stop();
    // Only on mount: a list re-rendering shouldn't replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View style={[style, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [MOTION.stagger.rise, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** A "no": a quick side-to-side shake (something failed). With reduced motion, nothing moves; the error haptic and colour say it. */
export function shake(v: Animated.Value) {
  if (reduced) return;
  v.setValue(0);
  Animated.sequence([-8, 7, -5, 3, 0].map(x => Animated.timing(v, { toValue: x, duration: 55, easing: EASE_OUT, useNativeDriver: true }))).start();
}

/** A value looping 0 → 1 for as long as `on` (spinners, shimmer, a pulsing dot). Still with reduced motion unless `essential`. */
export function useLoop(on: boolean, duration: number, o: { essential?: boolean; native?: boolean } = {}) {
  const v = useRef(new Animated.Value(0)).current;
  const rm = useReducedMotion();
  useEffect(() => {
    if (!on || (rm && !o.essential)) { v.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: o.native ?? true }));
    loop.start();
    return () => loop.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, rm, duration, v]);
  return v;
}
