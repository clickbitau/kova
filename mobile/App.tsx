import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';
import { NavigationContainer, DarkTheme, type NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useLastTap } from './src/native/push';
import { C } from './src/theme';
import { HubProvider, useHub } from './src/state/hub';
import { SheetProvider } from './src/state/sheet';
import type { Stack as StackParams } from './src/navigation';
import { routeFor } from './src/logic/links';
import { Tabs } from './src/Tabs';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ModesScreen } from './src/screens/ModesScreen';
import { ActivityScreen } from './src/screens/ActivityScreen';
import { ThisPhoneScreen } from './src/screens/ThisPhoneScreen';
import { WebScreen } from './src/screens/WebScreen';
import { DeviceSheet } from './src/screens/DeviceSheet';
import { Mark, ToastView } from './src/ui/kit';
import { T } from './src/ui/Text';

const Stack = createNativeStackNavigator<StackParams>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.page, card: C.nav, primary: C.amber, text: C.bone, border: C.hairline } };

function Splash({ text }: { text?: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.page, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <Mark size={56} />
      {text ? <T size={13.5} color={C.stone}>{text}</T> : null}
    </View>
  );
}

function Home() {
  const { cfg, loading, snap, conn, toast, undo, api, say } = useHub();
  const insets = useSafeAreaInsets();
  const nav = useRef<NavigationContainerRef<StackParams>>(null);

  // A tapped notification: the doorbell opens its camera, "Turn them off" turns the lights off.
  const last = useLastTap();
  useEffect(() => {
    if (!last || !snap) return;
    const data = last.notification.request.content.data as { url?: string } | undefined;
    const r = routeFor(last.actionIdentifier === 'lights-off' ? '/phone.html?do=lights-off' : data?.url);
    if (r.cam) nav.current?.navigate('Web', { title: snap.devices.find(d => d.id === r.cam)?.name ?? 'Camera', path: `/phone.html?embed=1&cam=${encodeURIComponent(r.cam)}` });
    else if (r.lightsOff) void api<{ changed: string[]; undo: string }>('POST', '/api/lights/off').then(x => say(`${x.changed.length} lights off`, { undo: x.undo })).catch(() => {});
    else if (r.page === 'modes') nav.current?.navigate('Modes');
    else if (r.page === 'activity') nav.current?.navigate('Activity');
    else if (r.page) nav.current?.navigate('Web', { title: r.page[0].toUpperCase() + r.page.slice(1), path: `/phone.html?embed=1&page=${r.page}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, !!snap]);

  if (loading) return <Splash />;
  if (!cfg) return <ConnectScreen />;
  if (!snap) return <Splash text={conn === 'offline' ? 'Can’t reach your hub. Trying again…' : 'Connecting to your home…'} />;
  return (
    <SheetProvider>
      <NavigationContainer ref={nav} theme={theme}>
        <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.page }, animation: 'slide_from_right' }}>
          <Stack.Screen name="Tabs" component={Tabs} />
          <Stack.Screen name="Modes" component={ModesScreen} />
          <Stack.Screen name="Activity" component={ActivityScreen} />
          <Stack.Screen name="ThisPhone" component={ThisPhoneScreen} />
          <Stack.Screen name="Web" component={WebScreen} />
        </Stack.Navigator>
        <DeviceSheet />
      </NavigationContainer>
      {conn === 'offline' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 4, alignSelf: 'center', paddingVertical: 5, paddingHorizontal: 12, borderRadius: 999, backgroundColor: 'rgba(255,107,94,0.16)' }}>
          <T size={12} weight={700} color={C.red}>Reconnecting to your hub…</T>
        </View>
      ) : null}
      {toast ? <ToastView key={toast.id} text={toast.text} undo={!!toast.undo} error={toast.error} onUndo={() => toast.undo && void undo(toast.undo)} bottom={insets.bottom + 92} /> : null}
    </SheetProvider>
  );
}

export default function App() {
  const [fonts] = useFonts({
    Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold, JetBrainsMono_400Regular,
    KovaSymbols: require('./assets/fonts/KovaSymbols.ttf'),
    KovaSymbolsFilled: require('./assets/fonts/KovaSymbolsFilled.ttf'),
  });
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.page }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {fonts ? <HubProvider><Home /></HubProvider> : <View style={{ flex: 1, backgroundColor: C.page }} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
