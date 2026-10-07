import { createElement, useEffect, useRef, useState } from 'react';
import { Animated, Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { C, R, SP } from '../theme';
import { useHub } from '../state/hub';
import { hubUrl } from '../logic/connect';
import type { Stack } from '../navigation';
import { Button, Empty, IconButton, Skeleton } from '../ui/kit';
import { T } from '../ui/Text';
import { Screen } from '../ui/Screen';
import { tween, useLoop } from '../ui/motion';

/** A thin bar sliding along the top while a page loads. */
function LoadingBar({ on }: { on: boolean }) {
  const t = useLoop(on, 1100, { essential: true });
  const a = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => { tween(a, on ? 1 : 0, { duration: 220, leaving: !on }).start(); }, [on, a]);
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, overflow: 'hidden', opacity: a, zIndex: 3 }}>
      <Animated.View style={{ width: '40%', height: 2, borderRadius: 1, backgroundColor: C.amber, transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-160, 420] }) }] }} />
    </Animated.View>
  );
}

/**
 * A page of the hub’s own phone web app, for the screens that are mostly setup (customising
 * the home, the mode editor, energy, media) and for live camera video (WebRTC, straight from the camera's cloud).
 * `embed=1` hides the web app's tab bar, and its back button hands back to the app ("back" message);
 * the token goes in the address once and the page keeps it. While it loads, a bar runs along the top over
 * the page's shape; if it can't load, it says so with Try again and Back.
 */
export function WebScreen({ route, navigation }: NativeStackScreenProps<Stack, 'Web'>) {
  const { cfg } = useHub();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(0);
  // The web build shows the page in an iframe, which says "back" with postMessage.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const on = (e: MessageEvent) => { if (e.data === 'kova:back') navigation.goBack(); };
    globalThis.addEventListener?.('message', on);
    return () => globalThis.removeEventListener?.('message', on);
  }, [navigation]);
  // No real hub (the demo home): its pages aren't here to show.
  if (!cfg) return (
    <Screen title={route.params.title} onBack={() => navigation.goBack()}>
      <Empty icon="cloud_off" title="This page is on your hub" text="Live camera view and the mode editor open from your own Kova hub. The demo home doesn’t have one." action="Back" onAction={() => navigation.goBack()} />
    </Screen>
  );
  const uri = hubUrl(cfg, route.params.path, true);
  const retry = () => { setFailed(false); setLoading(true); setKey(k => k + 1); };
  return (
    <View style={{ flex: 1, backgroundColor: C.page, paddingTop: insets.top }}>
      <LoadingBar on={loading && !failed} />
      {loading && !failed ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top, left: 0, right: 0, padding: SP.gutter, gap: SP[4], zIndex: 1, backgroundColor: C.page }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <IconButton icon="arrow_back" label="Back" size={38} onPress={() => navigation.goBack()} />
            <T v="heading">{route.params.title}</T>
          </View>
          <Skeleton h={120} r={R.lg} />
          <Skeleton h={64} r={R.lg} />
          <Skeleton h={64} r={R.lg} />
        </View>
      ) : null}
      {failed ? (
        <View style={{ flex: 1, padding: SP.gutter, justifyContent: 'center', gap: SP[3] }}>
          <Empty icon="cloud_off" tone={C.red} title={`Couldn’t open ${route.params.title}`} text="The hub didn’t answer. Check this phone is on the home network." action="Try again" onAction={retry} />
          <Button kind="ghost" label="Back" onPress={() => navigation.goBack()} />
        </View>
      ) : Platform.OS === 'web'
        ? createElement('iframe', { key, src: uri, title: route.params.title, onLoad: () => setLoading(false), style: { flex: 1, border: 0, width: '100%', height: '100%', background: C.page } })
        : (
          <WebView
            key={key}
            source={{ uri }}
            style={{ flex: 1, backgroundColor: C.page }}
            onLoadEnd={() => setLoading(false)}
            onError={() => setFailed(true)}
            onHttpError={e => { if (e.nativeEvent.statusCode >= 500) setFailed(true); }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
            originWhitelist={['*']}
            onMessage={e => { if (e.nativeEvent.data === 'back') navigation.goBack(); }}
          />
        )}
    </View>
  );
}
