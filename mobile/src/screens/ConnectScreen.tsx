import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';
import { C, F, R, SHADOW, SP } from '../theme';
import { call, findHub, hello, HubError } from '../api/client';
import { addressesOf, chooseAddress, display, kindFor } from '../logic/addresses';
import { normalizeHubUrl, parseConnectLink, subnetCandidates, type HubConfig } from '../logic/connect';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Button, Card, IconWell, Mark, Spinner } from '../ui/kit';
import { Glow } from '../ui/Screen';
import { Appear, haptic } from '../ui/motion';
import { T } from '../ui/Text';

type Step = 'start' | 'scan' | 'type';

/**
 * First run: connect to the home's hub. Scan the code Kova shows on a computer (More → Kova on your phone),
 * let the app look for the hub on this Wi-Fi, or type its address (and token, if the hub has one).
 */
export function ConnectScreen({ again }: { again?: { onCancel(): void } } = {}) {
  const { cfg: had, connect } = useHub();
  const insets = useSafeAreaInsets();
  // Signing in again (SignInAgainScreen): straight to the camera, and Back goes back there.
  const [step, setStep] = useState<Step>(again ? 'scan' : 'start');
  const back = () => { setErr(null); if (again) again.onCancel(); else setStep('start'); };
  const [addr, setAddr] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perm, askPerm] = useCameraPermissions();
  const scanned = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  /**
   * Find the address that answers as this hub (the code may carry several: home network and remote, and the hub's
   * ID), check the token works there, then save it. The token only goes to an address that passed that check.
   */
  const tryHub = async (given: HubConfig) => {
    setErr(null);
    setBusy('Connecting…');
    try {
      const r = await chooseAddress(addressesOf(given), { hello, hubId: given.hubId, localTimeoutMs: 4000, remoteTimeoutMs: 8000 });
      if (!r) throw new Error(`No Kova hub answered at ${display(given.url)}. Is this phone on the home Wi-Fi?`);
      const cfg: HubConfig = { ...given, url: r.url, ...(r.hubId ? { hubId: r.hubId } : {}) };
      await call(cfg, 'GET', '/api/state');
      haptic.success();
      // The same hub again (signing in again): keep whose phone this is and the addresses it already knew.
      const same = had && (!had.hubId || !cfg.hubId || had.hubId === cfg.hubId);
      await connect(same ? { ...had, ...cfg, personId: had.personId, addresses: cfg.addresses ?? had.addresses, removed: had.removed } : cfg);
    } catch (e) {
      haptic.error();
      if (e instanceof HubError && e.problem === 'signedOut') {
        setErr(given.token ? 'The hub didn’t accept that token. Scan the code in Kova on your computer, or check the token.' : 'This hub needs its token. Scan the code in Kova on your computer, or enter the token.');
        setAddr(given.url); setStep('type');
      } else setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const find = async () => {
    setErr(null);
    setBusy('Looking on this Wi-Fi…');
    try {
      const ip = await Network.getIpAddressAsync().catch(() => null);
      const guesses = ['http://kova.local:8140', ...(Platform.OS === 'web' ? [`http://${globalThis.location?.hostname}:8140`] : [])];
      const hit = await findHub([...guesses, ...subnetCandidates(ip)], { cancelled: () => cancelled.current });
      if (!hit) { setErr('No Kova hub answered on this Wi-Fi. Scan the code instead, or type its address.'); return; }
      await tryHub({ url: hit });
    } finally {
      setBusy(null);
    }
  };

  const typed = () => {
    const url = normalizeHubUrl(addr);
    if (!url) { setErr('Type the hub’s address, e.g. 192.168.1.20'); return; }
    // Typed by the owner, so it may be plain http even when remote.
    void tryHub({ url, addresses: [{ url, kind: kindFor(url), manual: true }], ...(token.trim() ? { token: token.trim() } : {}) });
  };

  if (step === 'scan') {
    if (!perm?.granted) {
      return (
        <View style={{ flex: 1, backgroundColor: C.page, padding: SP[6], paddingTop: insets.top + SP[6], gap: SP[4], justifyContent: 'center' }}>
          <IconWell icon="qr_code_scanner" color={C.amber} size={56} radius={28} />
          <T v="title">The camera, to scan the code</T>
          <T v="body" color={C.stone}>Kova only uses it here, to read the code on your computer’s screen.</T>
          <Button size="lg" label="Allow the camera" onPress={() => void askPerm()} />
          <Button kind="ghost" label="Back" onPress={back} />
        </View>
      );
    }
    const corner = (s: object) => <View style={[{ position: 'absolute', width: 34, height: 34, borderColor: C.amber }, s]} />;
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (scanned.current) return;
            const cfg = parseConnectLink(data);
            if (!cfg) return;
            scanned.current = true;
            haptic.success();
            setStep('start');
            void tryHub(cfg).finally(() => { scanned.current = false; });
          }} />
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 240, height: 240 }}>
            {corner({ top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 })}
            {corner({ top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 })}
            {corner({ bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 })}
            {corner({ bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 })}
          </View>
        </View>
        <View style={{ position: 'absolute', left: SP[5], right: SP[5], top: insets.top + SP[4], alignItems: 'center', gap: 6, padding: SP[3], borderRadius: R.lg, backgroundColor: 'rgba(14,15,16,0.7)' }}>
          <T v="headline" size={17}>Point at the code</T>
          <T v="footnote" color={C.bone2} center>On a computer: Kova → Kova on your phone</T>
        </View>
        <View style={{ position: 'absolute', left: SP[6], right: SP[6], bottom: insets.bottom + SP[6] }}>
          <Button kind="secondary" label="Cancel" onPress={back} />
        </View>
      </View>
    );
  }

  const field = (value: string, set: (v: string) => void, o: { label: string; placeholder: string; secure?: boolean; url?: boolean; hint?: string }) => (
    <View style={{ gap: SP[2] }}>
      <T v="footnote" weight={700} color={C.bone2}>{o.label}</T>
      <TextInput value={value} onChangeText={set} placeholder={o.placeholder} placeholderTextColor={C.stone2} autoCapitalize="none" autoCorrect={false} keyboardType={o.url ? 'url' : 'default'} secureTextEntry={o.secure}
        accessibilityLabel={o.label} onSubmitEditing={typed}
        style={{ height: 50, paddingHorizontal: SP[4], borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
      {o.hint ? <T v="footnote" color={C.stone2}>{o.hint}</T> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Glow color={C.amber} opacity={0.16} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: SP[6], paddingTop: insets.top + SP[10], paddingBottom: insets.bottom + SP[6], gap: SP[7] }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', gap: SP[3] }}>
          <View style={{ width: 88, height: 88, borderRadius: 26, backgroundColor: C.card, borderWidth: 1, borderColor: C.edgeTop, alignItems: 'center', justifyContent: 'center', boxShadow: SHADOW.card }}>
            <Mark size={56} />
          </View>
          <T v="largeTitle" size={34} style={{ marginTop: SP[2] }}>Welcome to Kova</T>
          <T v="body" color={C.stone} center>Connect this phone to your home’s hub. Everything stays on your own network.</T>
        </View>

        {step === 'start' ? (
          <View style={{ gap: SP[3] }}>
            <Button size="lg" label="Scan the code" icon="qr_code_scanner" onPress={() => { setErr(null); setStep('scan'); }} />
            <Button size="lg" kind="secondary" label={busy === 'Looking on this Wi-Fi…' ? 'Looking on this Wi-Fi…' : 'Find my hub on this Wi-Fi'} icon="search" busy={busy === 'Looking on this Wi-Fi…'} onPress={() => void find()} />
            <Button kind="ghost" label="Type the address instead" onPress={() => { setErr(null); setStep('type'); }} />
            <Card style={{ padding: SP[4], gap: SP[2], marginTop: SP[2] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                <Icon name="qr_code_2" size={18} color={C.green} />
                <T v="headline" size={14}>Where’s the code?</T>
              </View>
              <T v="footnote" color={C.stone}>Open Kova on a computer and choose “Kova on your phone” in the sidebar.</T>
            </Card>
          </View>
        ) : (
          <View style={{ gap: SP[4] }}>
            {field(addr, setAddr, { label: 'Hub address', placeholder: '192.168.1.20', url: true })}
            {field(token, setToken, { label: 'Token', placeholder: 'Only if your hub has one', secure: true, hint: 'Kova on your computer shows it next to the code.' })}
            <Button size="lg" label="Connect" busy={busy === 'Connecting…'} onPress={typed} />
            <Button kind="ghost" label="Back" onPress={back} />
          </View>
        )}

        {busy === 'Connecting…' && step === 'start' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SP[2] }}><Spinner /><T v="callout" color={C.stone}>Connecting…</T></View>
        ) : null}
        {err ? (
          <Appear style={{ flexDirection: 'row', gap: SP[2] + 2, padding: SP[3] + 2, borderRadius: R.md, backgroundColor: C.redTint, borderWidth: 1, borderColor: C.redLine }}>
            <Icon name="error" size={19} color={C.red} fill />
            <T v="callout" color={C.redText} style={{ flex: 1 }}>{err}</T>
          </Appear>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
