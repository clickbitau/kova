import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScrollToTop } from '@react-navigation/native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { C, SP } from '../theme';
import { useHub } from '../state/hub';
import { Icon } from './Icon';
import { IconButton, PulseDot } from './kit';
import { haptic, spring, tween, useReducedMotion } from './motion';
import { T } from './Text';

/** The mode glow: a radial gradient in the mode colour behind the top-left of the screen. */
export function Glow({ color, opacity = 0.22 }: { color: string; opacity?: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: -170, left: -100, width: 560, height: 460 }}>
      <Svg width={560} height={460}>
        <Defs>
          <RadialGradient id="g" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={color} stopOpacity={opacity} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={560} height={460} fill="url(#g)" />
      </Svg>
    </View>
  );
}

/**
 * The link to the hub, when it isn't fine: "Reconnecting…" with a breathing dot while it's down, then
 * "Back online" for a moment. It sits in the page's flow (it never covers the header) and slides open.
 */
export function ConnBanner() {
  const { conn, refresh } = useHub();
  const [show, setShow] = useState<'off' | 'down' | 'back'>(conn === 'offline' ? 'down' : 'off');
  const was = useRef(conn);
  useEffect(() => {
    if (conn === 'offline') setShow('down');
    else if (conn === 'live' && was.current === 'offline') { setShow('back'); haptic.success(); const t = setTimeout(() => setShow('off'), 2200); was.current = conn; return () => clearTimeout(t); }
    was.current = conn;
  }, [conn]);
  const a = useRef(new Animated.Value(show === 'off' ? 0 : 1)).current;
  const rm = useReducedMotion();
  useEffect(() => { (show === 'off' ? tween(a, 0, { native: false, leaving: true }) : (rm ? tween(a, 1, { native: false }) : spring(a, 1, 'sheet', { native: false }))).start(); }, [show, a, rm]);
  const down = show === 'down';
  return (
    <Animated.View accessibilityLiveRegion="polite" style={{ height: a.interpolate({ inputRange: [0, 1], outputRange: [0, 46] }), opacity: a, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 40, paddingLeft: 14, paddingRight: 6, borderRadius: 20, backgroundColor: down ? C.redTint : C.greenTint, borderWidth: 1, borderColor: down ? C.redLine : C.greenLine }}>
        {down ? <PulseDot color={C.red} /> : <Icon name="check_circle" size={17} color={C.green} fill />}
        <T v="labelSm" color={down ? C.redText : C.green} style={{ flex: 1 }}>{down ? 'Can’t reach your hub. Reconnecting…' : 'Back online'}</T>
        {down ? (
          <IconButton icon="refresh" label="Try now" size={30} tone="ghost" color={C.redText} onPress={() => { haptic.light(); void refresh(); }} />
        ) : null}
      </View>
    </Animated.View>
  );
}

export interface ScreenProps {
  children: ReactNode;
  /** The large title, and the line above it. On scroll it hands over to a compact bar with the title in it. */
  title?: string;
  over?: string;
  onBack?: () => void;
  /** Buttons beside the large title. */
  right?: ReactNode;
  glow?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  gap?: number;
  /** Something at the very top instead of a title (Now draws its own header). */
  head?: ReactNode;
}

const BAR = 48;

/**
 * A scrolling page: the page gutter, the section rhythm, a large title that collapses into a compact bar
 * (which keeps the back button and covers the status bar so nothing scrolls under the clock), the
 * connection banner, pull to refresh, and a tap on the current tab scrolls back to the top.
 */
export function Screen({ children, title, over, onBack, right, glow, onRefresh, refreshing, gap = SP.section, head }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const { refresh } = useHub();
  const [pulling, setPulling] = useState(false);
  const pull = () => { haptic.light(); if (onRefresh) onRefresh(); else { setPulling(true); void refresh().finally(() => setPulling(false)); } };
  const y = useRef(new Animated.Value(0)).current;
  const ref = useRef<ScrollView>(null);
  useScrollToTop(ref);
  const top = insets.top + (onBack ? BAR : SP[4]);
  const bar = y.interpolate({ inputRange: title || onBack ? [24, 64] : [0, 16], outputRange: [0, 1], extrapolate: 'clamp' });
  return (
    <View style={{ flex: 1, backgroundColor: C.page, overflow: 'hidden' }}>
      {glow ? <Glow color={glow} /> : null}
      <Animated.ScrollView
        ref={ref}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: top, paddingHorizontal: SP.gutter, paddingBottom: SP[10], gap }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={onRefresh ? !!refreshing : pulling} onRefresh={pull} tintColor={C.stone} progressViewOffset={top} />}
      >
        <View style={{ gap: SP[3], marginBottom: title || head ? -SP[2] : -gap }}>
          <ConnBanner />
          {head}
          {title ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: SP[3] }}>
              <View style={{ flex: 1, gap: 2 }}>
                {over ? <T v="footnote" weight={600} color={C.stone}>{over}</T> : null}
                <T v="largeTitle" size={onBack ? 30 : 32}>{title}</T>
              </View>
              {right}
            </View>
          ) : null}
        </View>
        {children}
      </Animated.ScrollView>
      {/* The compact bar: page-coloured under the status bar always; the title and hairline fade in on scroll. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + (onBack || title ? BAR : 0) }}>
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(14,15,16,0.94)', borderBottomWidth: 1, borderBottomColor: C.hairline, opacity: bar }} />
        {!onBack && !title ? null : (
          <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top, left: 0, right: 0, height: BAR, flexDirection: 'row', alignItems: 'center', paddingHorizontal: SP[3] }}>
            {onBack ? <IconButton icon="arrow_back" label="Back" onPress={onBack} size={38} /> : null}
            <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 64, right: 64, alignItems: 'center', opacity: bar, transform: [{ translateY: bar.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
              <T v="headline" size={16} numberOfLines={1}>{title ?? ''}</T>
            </Animated.View>
          </View>
        )}
      </View>
    </View>
  );
}
