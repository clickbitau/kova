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
import { useQuickActionCallback } from 'expo-quick-actions/hooks';
import { shareHub, syncExtensions } from './src/native/extensions';
import { CrashBoundary, crumb, initCrashReporting } from './src/native/crash';
import { C, SP } from './src/theme';
import { HubProvider, useHub } from './src/state/hub';
import { SheetProvider } from './src/state/sheet';
import type { Stack as StackParams } from './src/navigation';
import { NATIVE_PAGES, routeFor } from './src/logic/links';
import { Tabs } from './src/Tabs';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { SignInAgainScreen } from './src/screens/SignInAgainScreen';
import { JoinScreen, useJoinLink } from './src/screens/JoinScreen';
import { display } from './src/logic/addresses';
import { ModesScreen } from './src/screens/ModesScreen';
import { ModeEditor, OverlayEditor, MomentEditor } from './src/screens/BehaviourEditors';
import { ActivityScreen } from './src/screens/ActivityScreen';
import { ThisPhoneScreen } from './src/screens/ThisPhoneScreen';
import { WebScreen } from './src/screens/WebScreen';
import { CameraScreen } from './src/screens/CameraScreen';
import { SensorsScreen } from './src/screens/SensorsScreen';
import { IntegrationAddScreen, IntegrationsScreen } from './src/screens/IntegrationsScreen';
import { IntegrationScreen } from './src/screens/IntegrationScreen';
import { AutomationsScreen } from './src/screens/AutomationsScreen';
import { BrowsersScreen } from './src/screens/BrowsersScreen';
import { PeopleScreen } from './src/screens/PeopleScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { VoiceScreen } from './src/screens/VoiceScreen';
import { HomeLocationScreen } from './src/screens/HomeLocationScreen';
import { AutomationEditor } from './src/screens/AutomationEditor';
import { CustomiseScreen } from './src/screens/CustomiseScreen';
import { EnergyScreen } from './src/screens/EnergyScreen';
import { MediaScreen } from './src/screens/MediaScreen';
import { SpeakerLoudnessScreen } from './src/screens/SpeakerLoudnessScreen';
import { GroupSyncScreen } from './src/screens/GroupSyncScreen';
import { NotifyPrefsScreen } from './src/screens/NotifyPrefsScreen';
import { PrayerTimesScreen } from './src/screens/PrayerTimesScreen';
import { DeviceSheet } from './src/screens/DeviceSheet';
import { Button, Empty, Mark, ToastHost } from './src/ui/kit';
import { NowSkeleton } from './src/screens/NowScreen';

const Stack = createNativeStackNavigator<StackParams>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.page, card: C.nav, primary: C.amber, text: C.bone, border: C.hairline } };

function Splash() {
  return (
    <View style={{ flex: 1, backgroundColor: C.page, alignItems: 'center', justifyContent: 'center' }}>
      <Mark size={56} />
    </View>
  );
}

/** The hub didn't answer at launch (or answers with errors): say so plainly, keep trying, and offer the ways out. */
function CantReach() {
  const { refresh, forget, addresses, conn, link } = useHub();
  const insets = useSafeAreaInsets();
  const remote = addresses.some(a => a.kind === 'remote');
  const where = addresses.map(a => display(a.url)).join(', ');
  const text = conn === 'hubError'
    ? `${link.message ?? 'Your hub answers, but with an error.'} Kova keeps trying.`
    : `Kova keeps trying ${where || 'your hub'}${remote ? ', at home and remotely' : ''}. ${remote ? 'Check this phone is online.' : 'Check this phone is on the home Wi-Fi.'}`;
  return (
    <View style={{ flex: 1, backgroundColor: C.page, padding: SP[6], paddingTop: insets.top + SP[6], paddingBottom: insets.bottom + SP[6], justifyContent: 'center', gap: SP[3] }}>
      <Empty icon={conn === 'hubError' ? 'warning' : 'cloud_off'} tone={conn === 'hubError' ? C.amber : C.red} title={conn === 'hubError' ? 'Your hub has a problem' : 'Can’t reach your hub'} text={text} action="Try again" onAction={() => void refresh()} />
      <Button kind="ghost" label="Connect to a different hub" onPress={() => forget()} />
    </View>
  );
}

function Home() {
  const { cfg, loading, snap, conn, toast, undo, api, say } = useHub();
  const insets = useSafeAreaInsets();
  const nav = useRef<NavigationContainerRef<StackParams>>(null);
  // An invite link opened from outside (kova://join, or the join page): joining takes over until done or put off.
  const [join, clearJoin] = useJoinLink();
  useEffect(() => initCrashReporting(() => cfg), [cfg]);

  // Widgets, the Live Activity and the app icon's quick actions follow the hub.
  useEffect(() => { shareHub(cfg); }, [cfg]);
  useEffect(() => { if (snap) syncExtensions(snap); }, [snap]);
  useQuickActionCallback(a => {
    if (a.id === 'lights-off') void api<{ changed: string[]; undo: string }>('POST', '/api/lights/off').then(x => say(`${x.changed.length} lights off`, { undo: x.undo })).catch(e => say((e as Error).message, { error: true }));
    else if (a.id.startsWith('overlay:')) void api<{ undo: string }>('POST', `/api/overlays/${encodeURIComponent(String(a.params?.overlay ?? ''))}/start`).then(x => say(`${a.title} is on`, { undo: x.undo })).catch(e => say((e as Error).message, { error: true }));
    else if (a.id === 'ask') setTimeout(() => nav.current?.navigate('Tabs', { screen: 'Ask' } as never), 300);
  });

  // A tapped notification: the doorbell opens its camera, "Turn them off" turns the lights off.
  const last = useLastTap();
  useEffect(() => {
    if (!last || !snap) return;
    const data = last.notification.request.content.data as { url?: string } | undefined;
    const r = routeFor(last.actionIdentifier === 'lights-off' ? '/phone.html?do=lights-off' : data?.url);
    // A camera alert opens the camera: what it saw (the picture from that moment) and Watch live.
    if (r.cam) nav.current?.navigate('Camera', { id: r.cam });
    else if (r.lightsOff) void api<{ changed: string[]; undo: string }>('POST', '/api/lights/off').then(x => say(`${x.changed.length} lights off`, { undo: x.undo })).catch(() => {});
    else if (r.page && NATIVE_PAGES[r.page]) nav.current?.navigate(NATIVE_PAGES[r.page]);
    else if (r.setup) nav.current?.navigate('Integration', { id: r.setup });
    else if (r.page) nav.current?.navigate('Web', { title: r.page[0].toUpperCase() + r.page.slice(1), path: `/phone.html?embed=1&page=${r.page}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, !!snap]);

  if (loading) return <Splash />;
  if (join && (!cfg || conn === 'signedOut')) return <JoinScreen invite={join} onClose={clearJoin} />;
  if (!cfg) return <ConnectScreen />;
  if (conn === 'signedOut') return <SignInAgainScreen />;
  if (!snap) return conn === 'offline' || conn === 'hubError' ? <CantReach /> : <NowSkeleton />;
  return (
    <SheetProvider>
      <CrashBoundary>
      <NavigationContainer ref={nav} theme={theme} onStateChange={() => crumb(nav.current?.getCurrentRoute()?.name ?? '')}>
        <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.page }, animation: 'slide_from_right', gestureEnabled: true, fullScreenGestureEnabled: true }}>
          <Stack.Screen name="Tabs" component={Tabs} />
          <Stack.Screen name="Modes" component={ModesScreen} />
          <Stack.Screen name="ModeEditor" component={ModeEditor} />
          <Stack.Screen name="OverlayEditor" component={OverlayEditor} />
          <Stack.Screen name="MomentEditor" component={MomentEditor} />
          <Stack.Screen name="Activity" component={ActivityScreen} />
          <Stack.Screen name="ThisPhone" component={ThisPhoneScreen} />
          <Stack.Screen name="Integrations" component={IntegrationsScreen} />
          <Stack.Screen name="IntegrationAdd" component={IntegrationAddScreen} />
          <Stack.Screen name="Integration" component={IntegrationScreen} />
          <Stack.Screen name="Camera" component={CameraScreen} />
          <Stack.Screen name="Sensors" component={SensorsScreen} />
          <Stack.Screen name="Web" component={WebScreen} />
          <Stack.Screen name="Automations" component={AutomationsScreen} />
          <Stack.Screen name="Browsers" component={BrowsersScreen} />
          <Stack.Screen name="People" component={PeopleScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="Voice" component={VoiceScreen} />
          <Stack.Screen name="HomeLocation" component={HomeLocationScreen} />
          <Stack.Screen name="AutomationEditor" component={AutomationEditor} />
          <Stack.Screen name="Customise" component={CustomiseScreen} />
          <Stack.Screen name="Energy" component={EnergyScreen} />
          <Stack.Screen name="Media" component={MediaScreen} />
          <Stack.Screen name="SpeakerLoudness" component={SpeakerLoudnessScreen} />
          <Stack.Screen name="GroupSync" component={GroupSyncScreen} />
          <Stack.Screen name="NotifyPrefs" component={NotifyPrefsScreen} />
          <Stack.Screen name="PrayerTimes" component={PrayerTimesScreen} />
        </Stack.Navigator>
        <DeviceSheet />
      </NavigationContainer>
      </CrashBoundary>
      <ToastHost toast={toast} onUndo={t => t.undo && void undo(t.undo)} bottom={insets.bottom + 96} />
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
