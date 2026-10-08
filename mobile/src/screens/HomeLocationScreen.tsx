import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { hubUrl } from '../logic/connect';
import { injectFor, mapPageHtml, readMapMessage, RADIUS_MAX, RADIUS_MIN, type ToMap } from '../logic/map-page';
import { coordsText, DEFAULT_RADIUS_M, hasPoint, isGoogle, pinFromFound, pinFromPaste, pinMoved, saveBody, sourceLabel, staticMapPath, type Found, type Located, type Pin } from '../logic/location';
import { canPaste, paste } from '../native/clipboard';
import { Button, Card, Group, Row, Sheet, Slider, Spinner } from '../ui/kit';
import { FieldWithButton } from './DeviceSheet';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { askLocation } from '../logic/location-consent';
import { locationAsk } from '../native/arrive-leave';
import { useDemo } from '../state/demo';
import { useLocationDisclosure } from './LocationDisclosure';

const MAP_H = 300;

/**
 * Settings → Where the home is: find it (the address search, or paste from Google Maps), check it on the map,
 * drag the pin onto the house, size the arriving-and-leaving circle, and save. The map is a Leaflet page in the
 * WebView the app already has (no new native module); a point from Google's search shows on Google's own map
 * (through the hub) until the pin is fine-tuned, which makes it the owner's own.
 */
export function HomeLocationScreen() {
  const s = useSnap();
  const nav = useNav();
  const { api, say, cfg, route } = useHub();
  const saved = s.home.location ?? null;
  const google = !!s.home.maps?.google;
  const [pin, setPin] = useState<Pin | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [addr, setAddr] = useState<string | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [via, setVia] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasting, setPasting] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  // The Google Maps key: write-only. The hub says whether there is one, where from, and its last 4 only.
  const [mk, setMk] = useState<{ google: boolean; provider: string; from: 'hub' | 'env' | null; hint: string | null; lastError: string | null; proxy: boolean } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  useEffect(() => { void api<NonNullable<typeof mk>>('GET', '/api/maps/settings').then(setMk).catch(() => {}); }, [api]);
  const saveKey = async (k: string | null) => {
    try {
      setMk(await api<NonNullable<typeof mk>>('PUT', '/api/maps/settings', { googleKey: k }));
      setKeyDraft(''); setKeyOpen(false); setFound(null);
      say(k ? 'Google Maps key saved on the hub' : 'Google Maps key removed');
    } catch (e) { say((e as Error).message, { error: true }); }
  };

  const R0 = saved?.radiusM ?? DEFAULT_RADIUS_M;
  const rad = radius ?? R0;
  const shown: Pin | null = pin ?? (hasPoint(saved) ? { latitude: saved.latitude, longitude: saved.longitude, source: saved.source ?? 'manual', ...(saved.provider ? { provider: saved.provider } : {}) } : null);
  const dirty = !!pin || rad !== R0;
  const base = cfg ? { ...cfg, url: route?.url ?? cfg.url } : null;

  // --------------------------------------------------------------- search --
  const search = async (q: string) => {
    setFinding(true);
    try {
      const r = await api<{ results: Found[]; via: string; session?: string }>('GET', `/api/geocode?q=${encodeURIComponent(q)}`);
      setFound(r.results ?? []); setVia(r.via); setSession(r.session ?? null);
    } catch (e) { say((e as Error).message, { error: true }); } finally { setFinding(false); }
  };
  // Google's suggestions come as you type; OpenStreetMap's search is on Search only (its usage policy).
  const typed = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAddr = (v: string) => {
    setAddr(v); setFound(null);
    if (typed.current) clearTimeout(typed.current);
    if (google && v.trim().length >= 4) typed.current = setTimeout(() => void search(v.trim()), 350);
  };
  const findAddress = () => {
    const q = (addr ?? s.home.address ?? '').trim();
    if (q.length < 4) { say('Type more of the address', { error: true }); return; }
    void search(q);
  };
  const pick = async (f: Found) => {
    try {
      const at = f.latitude !== undefined && f.longitude !== undefined ? f as Found & { latitude: number; longitude: number }
        : await api<Found & { latitude: number; longitude: number }>('GET', `/api/geocode/place?id=${encodeURIComponent(f.placeId ?? '')}${session ? `&session=${encodeURIComponent(session)}` : ''}`);
      setPin(pinFromFound({ ...at, provider: f.provider })); setAddr(at.label); setFound(null);
      say('Check the pin, then Save');
    } catch (e) { say((e as Error).message, { error: true }); }
  };

  // ---------------------------------------------------------------- paste --
  const find = async (text: string) => {
    if (!text.trim()) { say('Paste a Google Maps link or coordinates', { error: true }); return; }
    setPasting(true);
    try {
      const r = await api<Located>('POST', '/api/location/parse', { text });
      const p = pinFromPaste(r);
      setPin(p); setPasteText('');
      if (p.address) setAddr(p.address);
      say('Found it: check the pin, then Save');
    } catch (e) { say((e as Error).message, { error: true }); } finally { setPasting(false); }
  };
  const pasteAndFind = async () => { const t = await paste(); if (!t.trim()) { say('Nothing to paste: copy a link in Google Maps first', { error: true }); return; } setPasteText(t); await find(t); };

  // ---------------------------------------------------------- this phone --
  // Kova's own disclosure first, then the system prompt (logic/location-consent.ts). The demo home never asks.
  const { demo } = useDemo();
  const { disclose, view: disclosure } = useLocationDisclosure();
  const here = async () => {
    if (demo) { if (await disclose('once')) say('In the demo home Kova doesn’t use your location.'); return; }
    setLocating(true);
    try {
      const p = await askLocation('once', locationAsk(disclose));
      if (!p.ok) { if (p.reason !== 'declined') say(p.why, { error: true }); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setPin({ latitude: Math.round(pos.coords.latitude * 1e6) / 1e6, longitude: Math.round(pos.coords.longitude * 1e6) / 1e6, source: 'phone', address: null, label: 'This phone’s location' });
      const acc = pos.coords.accuracy ?? 0;
      say(acc > 100 ? `Only accurate to ${Math.round(acc)} m: drag the pin onto the house` : 'Check the pin, then Save');
    } catch (e) { say((e as Error).message, { error: true }); } finally { setLocating(false); }
  };

  // ----------------------------------------------------------------- save --
  const save = async () => {
    const body = saveBody({ pin, radiusM: rad, saved, address: addr ?? undefined, savedAddress: s.home.address, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (!body) { say('Nothing to save: move the pin or the circle first'); return false; }
    setSaving(true);
    try {
      const r = await api<{ undo?: string; timezone?: string }>('PUT', '/api/home', body);
      setPin(null); setRadius(null); setAddr(null);
      say(r.timezone ? `Location saved. Timezone is now ${r.timezone.replace(/_/g, ' ')}` : pin ? 'Location saved: sun, prayer times, the weather and arriving home follow it' : `Circle saved: ${rad} m`, { undo: r.undo });
      return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; } finally { setSaving(false); }
  };
  const discard = () => { setPin(null); setRadius(null); setAddr(null); };

  // ------------------------------------------------------------------ map --
  const google_ = isGoogle(shown);
  const title = shown ? (shown.label || shown.address || (pin ? 'New spot' : s.home.address) || 'The home') : 'No location yet';
  const note = pin ? 'Not saved yet' : dirty ? 'New circle not saved yet' : shown ? `${sourceLabel(saved?.source)}. Sun and prayer times, the weather and arriving home follow it.` : 'Sun and prayer times, the weather and arriving home need it.';

  return (
    <Screen title="Where the home is" over="Settings" onBack={() => nav.goBack()}>
      <View style={{ gap: SP[2] }}>
        <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Address</T>
        <FieldWithButton value={addr ?? s.home.address ?? ''} onChange={onAddr} placeholder="Street, suburb, city" button={finding ? 'Searching…' : 'Search'} label="Address" show onSubmit={findAddress} />
        {finding ? <View style={{ alignItems: 'center', padding: SP[2] }}><Spinner /></View> : null}
        {found && found.length ? (
          <Group note={via && via !== 'osm' ? 'Suggestions from Google' : undefined}>
            {found.map((f, i) => <Row key={`${f.label}${i}`} first={i === 0} icon="location_on" iconFg={C.amber} title={f.label} onPress={() => void pick(f)} />)}
          </Group>
        ) : null}
        {found && !found.length ? <T v="footnote" color={C.amber}>No match. Try the street and suburb, or paste a Google Maps link below.</T> : null}
      </View>

      <View style={{ gap: SP[2] }}>
        <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Paste from Google Maps</T>
        <View style={{ flexDirection: 'row', gap: SP[2], alignItems: 'center' }}>
          <TextInput value={pasteText} onChangeText={setPasteText} placeholder="A Google Maps link or coordinates" placeholderTextColor={C.stone2} autoCorrect={false} autoCapitalize="none" returnKeyType="go"
            onSubmitEditing={() => void find(pasteText)} accessibilityLabel="Paste a Google Maps link or coordinates"
            style={{ flex: 1, minWidth: 0, height: 48, paddingHorizontal: SP[3] + 2, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 15 }} />
          {pasteText.trim()
            ? <Button label={pasting ? 'Finding…' : 'Find'} busy={pasting} onPress={() => find(pasteText)} />
            : canPaste ? <Button kind="secondary" icon="content_paste" label="Paste" busy={pasting} onPress={pasteAndFind} /> : null}
        </View>
        <T v="footnote" color={C.stone}>In Google Maps, tap Share and copy the link, or press and hold the spot and copy its coordinates.</T>
      </View>

      <View style={{ gap: SP[3] }}>
        {google_ && shown && base ? (
          <View style={{ gap: SP[2] }}>
            {google ? (
              <Image source={{ uri: hubUrl(base, staticMapPath(shown, rad), true) }} style={{ height: MAP_H, borderRadius: R.lg, backgroundColor: C.card }} contentFit="cover"
                accessibilityLabel={`Google map of ${shown.address ?? 'the home'} with the arriving and leaving circle`} />
            ) : (
              <View style={{ padding: SP[4], borderRadius: R.lg, backgroundColor: C.card }}>
                <T v="footnote" color={C.stone}>This point came from Google, and Google isn’t set up on the hub any more, so it can’t be shown on a map. Fine-tune it to place it on the map yourself.</T>
              </View>
            )}
            <Button kind="secondary" icon="edit" label="Fine-tune the pin" onPress={() => setPin(pinMoved({ ...shown, address: shown.address ?? s.home.address ?? null }, shown))} />
            {google ? <T v="footnote" color={C.stone}>Google’s map of Google’s match. Fine-tuning moves it to the map you can drag, and the point becomes your own.</T> : null}
          </View>
        ) : <MapView pin={shown} radiusM={rad} onMoved={p => setPin(pinMoved(pin ?? shown, p))} onRadius={setRadius} url={base?.url ?? null} />}

        <View style={{ gap: SP[2] }}>
          <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Arriving and leaving circle</T>
          <Slider value={rad} min={RADIUS_MIN} max={RADIUS_MAX} suffix=" m" label="Arriving and leaving circle" onChange={v => setRadius(Math.round(v / 10) * 10)} onRelease={v => setRadius(Math.round(v / 10) * 10)} />
        </View>

        <Card pad={SP[4]} style={{ gap: 2 }}>
          <T v="headline">{title}</T>
          <T v="footnote" color={C.stone} tabular>{shown ? coordsText(shown, rad) : 'Paste a link, search the address, or tap the map'}</T>
          <T v="footnote" color={dirty ? C.amber : C.stone}>{note}</T>
        </Card>

        <View style={{ flexDirection: 'row', gap: SP[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}><Button full kind="secondary" icon="person_pin_circle" label="Use this phone’s location" busy={locating} onPress={here} /></View>
          {dirty ? <Button kind="ghost" label="Discard" onPress={discard} /> : null}
        </View>
        <Button full label="Save location" busy={saving} kind={dirty ? 'primary' : 'secondary'} onPress={save} />
        <T v="footnote" color={C.stone}>{google ? 'Address search uses Google. ' : ''}Phones that watch for arriving and leaving pick up the new circle the next time they open Kova.</T>
        <Group title="Address search">
          <Row first icon="key" iconFg={mk?.google ? C.green : C.stone} title="Google Maps key (optional)"
            sub={!mk ? 'Loading…' : mk.provider === 'google-key' ? `Set${mk.hint ? ` (${mk.hint})` : ''}${mk.from === 'env' ? ', from the hub’s settings file' : ''}: Google suggests addresses as you type` : mk.proxy ? 'Not set: ClickBIT’s location service finds addresses' : 'Not set: OpenStreetMap finds addresses'}
            subColor={mk?.lastError ? C.amber : C.stone} onPress={() => { setKeyDraft(''); setKeyOpen(true); }} />
        </Group>
        {s.home.address ? <Button kind="ghost" size="sm" icon="close" label="Clear the saved address" onPress={async () => { try { const r = await api<{ undo?: string }>('PUT', '/api/home', { address: null }); say('Address cleared: the location stays', { undo: r.undo }); } catch (e) { say((e as Error).message, { error: true }); } }} /> : null}
      </View>

      <Sheet open={keyOpen} onClose={() => setKeyOpen(false)} label="Google Maps key">
        <T v="title">Google Maps key</T>
        <T v="footnote" color={C.stone}>Optional. Without one, address search uses OpenStreetMap, and pasting from Google Maps and the map work the same. With one, Google suggests addresses as you type. It’s kept on the hub; this phone only ever sees its last 4 characters.</T>
        {mk?.lastError ? <T v="footnote" color={C.amber}>{`Google said: ${mk.lastError}`}</T> : null}
        <TextInput value={keyDraft} onChangeText={setKeyDraft} placeholder={mk?.hint ? `Replace the key (${mk.hint})` : 'Paste a Google Maps API key'} placeholderTextColor={C.stone2}
          secureTextEntry autoCorrect={false} autoCapitalize="none" accessibilityLabel="Google Maps API key"
          style={{ height: 48, paddingHorizontal: SP[3] + 2, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 15 }} />
        <Button full label="Save key" onPress={() => keyDraft.trim() ? saveKey(keyDraft.trim()) : say('Paste the key first', { error: true })} />
        {mk?.from === 'hub' ? <Button kind="ghost" label="Remove the key" onPress={() => saveKey(null)} /> : null}
        <T v="footnote" color={C.stone}>In Google Cloud, enable Places API (New), Geocoding API and Maps Static API for the key, and restrict it to those APIs.</T>
      </Sheet>
      {disclosure}
    </Screen>
  );
}

/** The Leaflet page: a WebView on a phone, an iframe in the web build. */
function MapView({ pin, radiusM, onMoved, onRadius, url }: { pin: Pin | null; radiusM: number; onMoved: (p: { latitude: number; longitude: number }) => void; onRadius: (r: number) => void; url: string | null }) {
  const web = useRef<WebView>(null);
  const frame = useRef<{ contentWindow?: { postMessage: (m: string, o: string) => void } | null } | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // The page is made once, where the pin is when it opens; after that it's moved by messages.
  const html = useMemo(() => mapPageHtml(pin ? { latitude: pin.latitude, longitude: pin.longitude, radiusM } : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const last = useRef('');
  const cb = useRef({ onMoved, onRadius });
  cb.current = { onMoved, onRadius };

  const send = (m: ToMap) => {
    if (Platform.OS === 'web') frame.current?.contentWindow?.postMessage(JSON.stringify(m), '*');
    else web.current?.injectJavaScript(injectFor(m));
  };
  const onMessage = (data: unknown) => {
    const m = readMapMessage(data);
    if (!m) return;
    if (m.kova === 'ready') setReady(true);
    else if (m.kova === 'moved') { last.current = `${m.latitude},${m.longitude},${radiusM}`; cb.current.onMoved(m); }
    else if (m.kova === 'radius') cb.current.onRadius(m.radiusM);
    else if (m.kova === 'error') setFailed(true);
  };
  // The pin or circle changed from outside the map (paste, search, this phone, the slider, Discard).
  useEffect(() => {
    if (!ready || !pin) return;
    const key = `${pin.latitude},${pin.longitude},${radiusM}`;
    if (key === last.current) return;
    const moved = last.current.split(',').slice(0, 2).join() !== `${pin.latitude},${pin.longitude}`;
    last.current = key;
    send({ kova: 'set', latitude: pin.latitude, longitude: pin.longitude, radiusM, fit: moved });
  }, [ready, pin?.latitude, pin?.longitude, radiusM]); // eslint-disable-line react-hooks/exhaustive-deps
  // The web build's iframe answers with postMessage.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const on = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow) onMessage(e.data); };
    globalThis.addEventListener?.('message', on);
    return () => globalThis.removeEventListener?.('message', on);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ height: MAP_H, borderRadius: R.lg, overflow: 'hidden', backgroundColor: C.card }} accessibilityLabel="Map: drag the pin onto the home, drag the handle on the circle to resize it">
      {Platform.OS === 'web'
        ? createElement('iframe', { ref: frame, srcDoc: html, title: 'Map', style: { border: 0, width: '100%', height: '100%' } })
        : <WebView ref={web} originWhitelist={['*']} source={{ html, baseUrl: url ?? 'https://kova.invalid/' }} onMessage={e => onMessage(e.nativeEvent.data)}
            style={{ flex: 1, backgroundColor: C.card }} scrollEnabled={false} nestedScrollEnabled setSupportMultipleWindows={false} javaScriptEnabled
            onShouldStartLoadWithRequest={r => !/^https?:/.test(r.url) || r.url.startsWith(url ?? 'https://kova.invalid')} />}
      {failed ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: SP[3], backgroundColor: C.card, flexDirection: 'row', gap: SP[2], alignItems: 'center' }}>
          <Icon name="cloud_off" size={18} color={C.stone} />
          <T v="footnote" color={C.stone} style={{ flex: 1 }}>The map needs the internet. Paste coordinates or search the address instead.</T>
        </View>
      ) : null}
      {!ready && !failed ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}><Spinner /></View> : null}
    </View>
  );
}
