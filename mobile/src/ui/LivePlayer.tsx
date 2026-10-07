// A camera's live video, played in place of its picture: the player page (logic/live.ts) in the WebView the store
// build already has, or an iframe in the web build. The page only plays; signalling goes through the app (useLive).
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useFocusEffect } from '@react-navigation/native';
import { injectFor, livePlayerHtml, LiveSession, type LiveView, type ToPlayer } from '../logic/live';
import { useHub } from '../state/hub';

/** Where the player page lives: an https origin of its own (a secure context, for WebRTC), never the hub. */
const PLAYER_ORIGIN = 'https://live.kova.invalid/';

type Frame = { contentWindow?: { postMessage: (m: string, o: string) => void } | null };

/**
 * One camera's live session for a screen: start, stop, and what it's doing. It stops (and tells the hub) when the
 * screen loses focus or unmounts, and when the app goes to the background.
 */
export function useLive(cam: string) {
  const { api } = useHub();
  const send = useRef<(m: ToPlayer) => void>(() => {});
  const [view, setView] = useState<LiveView>({ phase: 'idle', gen: 0 });
  const apiRef = useRef(api);
  apiRef.current = api;
  const session = useMemo(() => new LiveSession(cam, {
    api: (method, path, body, timeoutMs) => apiRef.current(method, path, body, timeoutMs),
    toPage: m => send.current(m),
    onChange: setView,
  }), [cam]);
  useEffect(() => () => session.stop(), [session]);
  useFocusEffect(useCallback(() => () => session.stop(), [session]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => { if (st === 'background') session.stop(); });
    return () => sub.remove();
  }, [session]);
  return { view, session, send };
}

/** The player page, filling its parent. `send` is given the way to message the page. */
export function LivePlayer({ gen, onMessage, send, label }: { gen: number; onMessage: (data: unknown) => void; send: { current: (m: ToPlayer) => void }; label: string }) {
  const html = useMemo(() => livePlayerHtml(), []);
  const web = useRef<WebView>(null);
  const frame = useRef<Frame | null>(null);
  const cb = useRef(onMessage);
  cb.current = onMessage;
  useEffect(() => {
    send.current = m => {
      if (Platform.OS === 'web') frame.current?.contentWindow?.postMessage(JSON.stringify(m), '*');
      else web.current?.injectJavaScript(injectFor(m));
    };
  }, [send, gen]);
  // The web build's iframe answers with postMessage.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const on = (e: MessageEvent) => { if (frame.current && e.source === frame.current.contentWindow) cb.current(e.data); };
    globalThis.addEventListener?.('message', on);
    return () => globalThis.removeEventListener?.('message', on);
  }, []);
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} accessibilityLabel={label}>
      {Platform.OS === 'web'
        ? createElement('iframe', { key: gen, ref: frame, srcDoc: html, title: label, allow: 'autoplay; fullscreen', allowFullScreen: true, style: { border: 0, width: '100%', height: '100%', background: 'transparent', colorScheme: 'normal' } })
        : <WebView key={gen} ref={web} originWhitelist={['*']} source={{ html, baseUrl: PLAYER_ORIGIN }} onMessage={e => cb.current(e.nativeEvent.data)}
            // Inline, muted autoplay with no tap first (iOS WKWebView and Android); full screen from the page's button.
            allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false} allowsFullscreenVideo allowsAirPlayForMediaPlayback={false}
            javaScriptEnabled scrollEnabled={false} bounces={false} overScrollMode="never" setSupportMultipleWindows={false}
            showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} androidLayerType="hardware"
            style={{ flex: 1, backgroundColor: 'transparent' }} containerStyle={{ backgroundColor: 'transparent' }}
            onShouldStartLoadWithRequest={r => r.url === 'about:blank' || r.url.startsWith(PLAYER_ORIGIN)} />}
    </View>
  );
}
