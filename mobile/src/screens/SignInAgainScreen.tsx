import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, SP } from '../theme';
import { display } from '../logic/addresses';
import { appName, startSignIn, waitForSignIn, type SignInCode } from '../logic/signin';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Button, Card, IconWell, Spinner } from '../ui/kit';
import { Glow } from '../ui/Screen';
import { Appear, haptic } from '../ui/motion';
import { T } from '../ui/Text';
import { ConnectScreen } from './ConnectScreen';
import { PasswordSignIn } from './PasswordSignIn';

/**
 * The hub answers, but no longer takes this phone's key (it was changed, or this phone was signed out). Not
 * "can't reach": trying again won't help, signing in will. Two ways, both keeping the hub, its addresses and this
 * phone's settings: a sign-in code approved from Kova on a computer or another phone (logic/signin.ts), or the
 * computer's QR code again.
 */
export function SignInAgainScreen() {
  const { cfg, route, link, signIn, refresh, forget } = useHub();
  const insets = useSafeAreaInsets();
  const [scan, setScan] = useState(false);
  const [code, setCode] = useState<SignInCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const waiting = useRef(0);
  useEffect(() => () => { waiting.current++; }, []);

  if (scan) return <ConnectScreen again={{ onCancel: () => setScan(false) }} />;

  const base = route?.url ?? cfg?.url ?? '';
  const getCode = async () => {
    if (!base) return;
    const mine = ++waiting.current;
    setErr(null);
    setBusy(true);
    try {
      const c = await startSignIn(base, appName(Platform.OS));
      if (mine !== waiting.current) return;
      setCode(c);
      haptic.light();
      const token = await waitForSignIn(base, c, { cancelled: () => mine !== waiting.current });
      if (mine !== waiting.current) return;
      if (!token) { setCode(null); setErr('The code ran out before it was approved. Get a new one.'); return; }
      haptic.success();
      await signIn(token);
    } catch (e) {
      if (mine === waiting.current) { setCode(null); setErr((e as Error).message); haptic.error(); }
    } finally {
      if (mine === waiting.current) setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      <Glow color={C.amber} opacity={0.14} />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: SP[6], paddingTop: insets.top + SP[8], paddingBottom: insets.bottom + SP[6], gap: SP[6] }}>
        <View style={{ gap: SP[3] }}>
          <IconWell icon="lock" color={C.amber} size={56} radius={28} />
          <T v="title">Sign in to your hub again</T>
          <T v="body" color={C.stone}>{link.message ?? 'Your hub didn’t accept this phone’s key.'} Your home and this phone’s settings stay as they are.</T>
          {base ? <T v="footnote" color={C.stone2}>Your hub is answering at {display(base)}.</T> : null}
        </View>

        {code ? (
          <Appear>
            <Card style={{ padding: SP[5], gap: SP[3], alignItems: 'center' }}>
              <T v="footnote" weight={700} color={C.bone2}>Your sign-in code</T>
              <T v="largeTitle" size={34} style={{ letterSpacing: 3 }} selectable>{code.code}</T>
              <T v="footnote" color={C.stone} center>Approve it in Kova on a computer (Signed-in browsers → Sign in a browser), or on another phone (More → Sign in a browser).</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}><Spinner /><T v="callout" color={C.stone}>Waiting for it to be approved…</T></View>
            </Card>
          </Appear>
        ) : null}

        {!code && base ? (
          <Card style={{ padding: SP[5], gap: SP[3] }}>
            <T v="headline">Your username and password</T>
            <PasswordSignIn base={base} onSignedIn={r => signIn(r.token)} />
          </Card>
        ) : null}

        <View style={{ gap: SP[3] }}>
          {!code ? <Button size="lg" kind="secondary" label="Get a sign-in code instead" icon="password" busy={busy} onPress={() => void getCode()} /> : null}
          <Button size="lg" kind="secondary" label="Scan the code instead" icon="qr_code_scanner" onPress={() => { waiting.current++; setCode(null); setBusy(false); setScan(true); }} />
          <Button kind="ghost" label="Try again" onPress={() => { haptic.light(); void refresh(); }} />
          <Button kind="ghost" label="Connect to a different hub" onPress={() => { waiting.current++; void forget(); }} />
        </View>

        {err ? (
          <Appear style={{ flexDirection: 'row', gap: SP[2] + 2, padding: SP[3] + 2, borderRadius: R.md, backgroundColor: C.redTint, borderWidth: 1, borderColor: C.redLine }}>
            <Icon name="error" size={19} color={C.red} fill />
            <T v="callout" color={C.redText} style={{ flex: 1 }}>{err}</T>
          </Appear>
        ) : null}
      </ScrollView>
    </View>
  );
}
