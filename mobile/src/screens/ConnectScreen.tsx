import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';
import { C, F } from '../theme';
import { call, findHub, probe } from '../api/client';
import { normalizeHubUrl, parseConnectLink, subnetCandidates, type HubConfig } from '../logic/connect';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Button, Card, Mark, Press } from '../ui/kit';
import { T } from '../ui/Text';

type Step = 'start' | 'scan' | 'type';

/**
 * First run: connect to the home's hub. Scan the code Kova shows on a computer (More → Kova on your phone),
 * let the app look for the hub on this Wi-Fi, or type its address (and token, if the hub has one).
 */
export function ConnectScreen() {
  const { connect } = useHub();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('start');
  const [addr, setAddr] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [perm, askPerm] = useCameraPermissions();
  const scanned = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  /** Check the hub answers and the token works, then save it. */
  const tryHub = async (cfg: HubConfig) => {
    setErr(null);
    setBusy('Connecting…');
    try {
      if (!(await probe(cfg.url, 5000))) throw new Error(`Nothing answered at ${cfg.url}. Is this phone on the home Wi-Fi?`);
      await call(cfg, 'GET', '/api/state');
      await connect(cfg);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      if (/token/i.test(m)) { setAddr(cfg.url); setStep('type'); }
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
    void tryHub({ url, ...(token.trim() ? { token: token.trim() } : {}) });
  };

  if (step === 'scan') {
    if (!perm?.granted) {
      return (
        <View style={{ flex: 1, backgroundColor: C.page, padding: 24, paddingTop: insets.top + 24, gap: 16, justifyContent: 'center' }}>
          <T size={22} weight={700}>Camera, to scan the code</T>
          <T size={14} color={C.stone} lineHeight={1.5}>Kova only uses it here, to read the code on your computer’s screen.</T>
          <Button label="Allow camera" onPress={() => void askPerm()} />
          <Button kind="secondary" label="Back" onPress={() => setStep('start')} />
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (scanned.current) return;
            const cfg = parseConnectLink(data);
            if (!cfg) return;
            scanned.current = true;
            setStep('start');
            void tryHub(cfg).finally(() => { scanned.current = false; });
          }} />
        <View style={{ position: 'absolute', left: 0, right: 0, top: insets.top + 16, alignItems: 'center', gap: 6 }}>
          <T size={17} weight={700}>Point at the code</T>
          <T size={13} color={C.bone2}>Kova on your computer → Kova on your phone</T>
        </View>
        <View style={{ position: 'absolute', left: 24, right: 24, bottom: insets.bottom + 24 }}>
          <Button kind="secondary" label="Cancel" onPress={() => setStep('start')} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24, gap: 22 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', gap: 14 }}>
          <Mark size={64} />
          <T size={34} weight={800} tracking={-0.04}>Kova</T>
          <T size={14.5} color={C.stone} center lineHeight={1.5}>Connect to your home’s Kova hub. Everything stays on your network.</T>
        </View>

        {step === 'start' ? (
          <View style={{ gap: 10 }}>
            <Button label="Scan the code" icon="qr_code_scanner" onPress={() => { setErr(null); setStep('scan'); }} />
            <Button kind="secondary" label="Find my hub on this Wi-Fi" icon="search" busy={busy === 'Looking on this Wi-Fi…'} onPress={() => void find()} />
            <Press onPress={() => { setErr(null); setStep('type'); }} style={{ alignSelf: 'center', padding: 8 }}>
              <T size={13.5} weight={600} color={C.amber}>Type the address instead</T>
            </Press>
            <Card style={{ padding: 14, gap: 6, marginTop: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="qr_code_2" size={18} color={C.green} />
                <T size={13} weight={700}>Where’s the code?</T>
              </View>
              <T size={12.5} color={C.stone} lineHeight={1.45}>Open Kova on a computer and choose “Kova on your phone” in the sidebar (or More → Kova app on your phone).</T>
            </Card>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <View style={{ gap: 6 }}>
              <T size={13} weight={600}>Hub address</T>
              <TextInput value={addr} onChangeText={setAddr} placeholder="192.168.1.20" placeholderTextColor={C.stone3} autoCapitalize="none" autoCorrect={false} keyboardType="url"
                style={{ paddingVertical: 12, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.card, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
            </View>
            <View style={{ gap: 6 }}>
              <T size={13} weight={600}>Token</T>
              <TextInput value={token} onChangeText={setToken} placeholder="only if your hub has one (KOVA_TOKEN)" placeholderTextColor={C.stone3} autoCapitalize="none" autoCorrect={false} secureTextEntry
                style={{ paddingVertical: 12, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.card, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
            </View>
            <Button label="Connect" busy={busy === 'Connecting…'} onPress={typed} />
            <Press onPress={() => { setErr(null); setStep('start'); }} style={{ alignSelf: 'center', padding: 8 }}>
              <T size={13.5} weight={600} color={C.amber}>Back</T>
            </Press>
          </View>
        )}

        {busy && busy !== 'Connecting…' && busy !== 'Looking on this Wi-Fi…' ? <T size={13} color={C.stone} center>{busy}</T> : null}
        {busy === 'Connecting…' && step === 'start' ? <T size={13} color={C.stone} center>Connecting…</T> : null}
        {err ? (
          <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,107,94,0.12)' }}>
            <Icon name="error" size={18} color={C.red} />
            <T size={13} color="#ffb4ab" lineHeight={1.4} style={{ flex: 1 }}>{err}</T>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
