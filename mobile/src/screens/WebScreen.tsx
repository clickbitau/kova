import { createElement, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { C } from '../theme';
import { useHub } from '../state/hub';
import { hubUrl } from '../logic/connect';
import type { Stack } from '../navigation';

/**
 * A page of the hub's own phone web app, for the screens that are mostly setup (integrations, customising
 * the home, the mode editor, energy, media) and for live camera video (WebRTC, straight from the camera's cloud).
 * `embed=1` hides the web app's tab bar, and its back button hands back to the app ("back" message);
 * the token goes in the address once and the page keeps it.
 */
export function WebScreen({ route, navigation }: NativeStackScreenProps<Stack, 'Web'>) {
  const { cfg } = useHub();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  // The web build shows the page in an iframe, which says "back" with postMessage.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const on = (e: MessageEvent) => { if (e.data === 'kova:back') navigation.goBack(); };
    globalThis.addEventListener?.('message', on);
    return () => globalThis.removeEventListener?.('message', on);
  }, [navigation]);
  if (!cfg) return null;
  const uri = hubUrl(cfg, route.params.path, true);
  return (
    <View style={{ flex: 1, backgroundColor: C.page, paddingTop: insets.top }}>
      {loading ? <ActivityIndicator color={C.stone} style={{ position: 'absolute', top: insets.top + 24, alignSelf: 'center', zIndex: 1 }} /> : null}
      {Platform.OS === 'web'
        ? createElement('iframe', { src: uri, onLoad: () => setLoading(false), style: { flex: 1, border: 0, width: '100%', height: '100%', background: C.page } })
        : (
          <WebView
            source={{ uri }}
            style={{ flex: 1, backgroundColor: C.page }}
            onLoadEnd={() => setLoading(false)}
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
