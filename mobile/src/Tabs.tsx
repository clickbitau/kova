import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, SHADOW, alpha } from './theme';
import { useSnap } from './state/hub';
import { Icon } from './ui/Icon';
import { haptic, spring, useReducedMotion } from './ui/motion';
import { T } from './ui/Text';
import { NowScreen } from './screens/NowScreen';
import { DevicesScreen } from './screens/DevicesScreen';
import { AskScreen } from './screens/AskScreen';
import { SecurityScreen } from './screens/SecurityScreen';
import { MoreScreen } from './screens/MoreScreen';

const TABS: [string, string, string][] = [['Now', 'Now', 'home'], ['Devices', 'Devices', 'lightbulb'], ['Ask', 'Ask', 'graphic_eq'], ['Security', 'Security', 'shield'], ['More', 'More', 'apps']];
const Tab = createBottomTabNavigator();

/** One tab: its icon fills in amber and pops when chosen. Ask is a raised amber button in the middle. */
function TabButton({ name, label, icon, active, badge, onPress }: { name: string; label: string; icon: string; active: boolean; badge?: string; onPress: () => void }) {
  const s = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  const rm = useReducedMotion();
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!active || rm) return;
    s.setValue(0.82);
    spring(s, 1, 'pop').start();
  }, [active, s, rm]);
  const centre = name === 'Ask';
  return (
    <Pressable onPress={onPress} accessibilityRole="tab" accessibilityLabel={badge ? `${label}, ${badge}` : label} accessibilityState={{ selected: active }}
      onPressIn={() => spring(s, 0.9, 'press').start()} onPressOut={() => spring(s, 1, 'press').start()}
      style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
      <Animated.View style={{ width: centre ? 52 : 44, height: centre ? 52 : 30, borderRadius: centre ? 26 : 15, marginTop: centre ? -24 : 0, backgroundColor: centre ? C.amber : 'transparent', alignItems: 'center', justifyContent: 'center', boxShadow: centre ? SHADOW.fab : undefined, borderWidth: centre ? 3 : 0, borderColor: C.nav, transform: [{ scale: s }] }}>
        <Icon name={icon} size={centre ? 25 : 23} fill={active || centre} color={centre ? C.onAmber : active ? C.amber : C.stone2} />
        {badge ? <View style={{ position: 'absolute', top: 1, right: 8, width: 9, height: 9, borderRadius: 5, backgroundColor: C.amber, borderWidth: 2, borderColor: C.nav }} /> : null}
      </Animated.View>
      <T v="micro" size={11} color={active ? C.bone : C.stone2}>{label}</T>
    </Pressable>
  );
}

/**
 * The tab bar: a soft amber lozenge slides under the chosen tab on a spring; the icon fills and pops.
 * Tapping the tab you're on scrolls it back to the top (each Screen listens).
 */
function Bar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const s = useSnap();
  const moreDot = s.findings.length > 0 || s.integrations.some(i => !i.ok);
  const [w, setW] = useState(0);
  const x = useRef(new Animated.Value(state.index)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current || !w) { x.setValue(state.index); first.current = false; return; }
    spring(x, state.index, 'toggle').start();
  }, [state.index, w, x]);
  const seg = w / TABS.length;
  const onAsk = TABS[state.index]?.[0] === 'Ask';
  return (
    <View accessibilityRole="tablist" onLayout={e => setW(e.nativeEvent.layout.width - 16)}
      style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 8, paddingHorizontal: 8, paddingBottom: Math.max(insets.bottom, 10) + 2, backgroundColor: 'rgba(17,18,20,0.97)', borderTopWidth: 1, borderTopColor: C.edge }}>
      {seg ? (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 8, left: 8 + (seg - 56) / 2, width: 56, height: 30, borderRadius: 15, backgroundColor: alpha(C.amber, 0.13), opacity: onAsk ? 0 : 1,
          transform: [{ translateX: x.interpolate({ inputRange: [0, TABS.length - 1], outputRange: [0, seg * (TABS.length - 1)] }) }] }} />
      ) : null}
      {TABS.map(([name, label, icon], i) => {
        const active = state.index === i;
        return (
          <TabButton key={name} name={name} label={label} icon={icon} active={active} badge={name === 'More' && moreDot ? 'needs a look' : undefined}
            onPress={() => {
              const e = navigation.emit({ type: 'tabPress', target: state.routes[i].key, canPreventDefault: true });
              if (!active) haptic.select();
              if (!active && !e.defaultPrevented) navigation.navigate(name);
            }} />
        );
      })}
    </View>
  );
}

export function Tabs() {
  // Tabs cross-fade (nothing slides with reduced motion).
  const reduced = useReducedMotion();
  return (
    <Tab.Navigator tabBar={p => <Bar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.page }, animation: reduced ? 'none' : 'fade' }}>
      <Tab.Screen name="Now" component={NowScreen} />
      <Tab.Screen name="Devices" component={DevicesScreen} />
      <Tab.Screen name="Ask" component={AskScreen} />
      <Tab.Screen name="Security" component={SecurityScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}
