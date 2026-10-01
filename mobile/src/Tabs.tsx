import { View } from 'react-native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from './theme';
import { useSnap } from './state/hub';
import { Icon } from './ui/Icon';
import { Press } from './ui/kit';
import { haptic, useReducedMotion } from './ui/motion';
import { T } from './ui/Text';
import { NowScreen } from './screens/NowScreen';
import { DevicesScreen } from './screens/DevicesScreen';
import { AskScreen } from './screens/AskScreen';
import { SecurityScreen } from './screens/SecurityScreen';
import { MoreScreen } from './screens/MoreScreen';

const TABS: [string, string, string][] = [['Now', 'Now', 'home'], ['Devices', 'Devices', 'lightbulb'], ['Ask', 'Ask', 'graphic_eq'], ['Security', 'Security', 'shield'], ['More', 'More', 'apps']];
const Tab = createBottomTabNavigator();

/** The design's tab bar: Ask is a raised amber circle in the middle; the active tab's icon fills in amber. */
function Bar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const s = useSnap();
  const moreDot = s.findings.length > 0 || s.integrations.some(i => !i.ok);
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: 10, paddingHorizontal: 14, paddingBottom: Math.max(insets.bottom, 10) + 4, backgroundColor: 'rgba(17,18,20,0.96)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' }}>
      {TABS.map(([name, label, icon], i) => {
        const active = state.index === i, centre = name === 'Ask';
        return (
          <Press key={name} label={label} onPress={() => { if (!active) haptic.select(); navigation.navigate(name); }} style={{ width: 60, minHeight: 44, alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
            <View style={{ width: centre ? 46 : 28, height: centre ? 46 : 28, borderRadius: 23, marginTop: centre ? -20 : 0, backgroundColor: centre ? C.amber : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={centre ? 24 : 23} fill={active || centre} color={centre ? C.onAmber : active ? C.amber : C.stone2} />
              {name === 'More' && moreDot ? <View style={{ position: 'absolute', top: 0, right: -2, width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber, borderWidth: 2, borderColor: C.nav }} /> : null}
            </View>
            <T size={10.5} weight={700} color={active ? C.bone : C.stone2}>{label}</T>
          </Press>
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
