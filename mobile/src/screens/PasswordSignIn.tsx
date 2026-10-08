import { useState } from 'react';
import { Platform, View } from 'react-native';
import { C, SP } from '../theme';
import { call } from '../api/client';
import { appName } from '../logic/signin';
import { Button } from '../ui/kit';
import { haptic } from '../ui/motion';
import { T } from '../ui/Text';
import { TextField } from './SpeakerGroupSheet';

export interface SignedIn { token: string; personId: string; name: string; hubId?: string | null }

/**
 * Sign in to a hub with a username and password (set in More → People and access): this phone gets that person's
 * own key. `base`: the hub's address, already found; null while it isn't (the button waits).
 */
export function PasswordSignIn({ base, onSignedIn, onError }: { base: string | null; onSignedIn: (r: SignedIn) => Promise<void> | void; onError?: (m: string | null) => void }) {
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const ready = !!base && user.trim().length >= 3 && pw.length > 0;
  const say = (m: string | null) => { setErr(m); onError?.(m); };
  const go = async () => {
    if (!ready) return false;
    say(null);
    try {
      const r = await call<SignedIn>({ url: base! }, 'POST', '/api/login/password', { user: user.trim(), password: pw, device: appName(Platform.OS) });
      haptic.success();
      setPw('');
      await onSignedIn(r);
      return true;
    } catch (e) { haptic.error(); say((e as Error).message); return false; }
  };
  return (
    <View style={{ gap: SP[3] }}>
      <TextField label="Username" placeholder="Username" value={user} onChange={setUser} account="username" />
      <TextField label="Password" placeholder="Password" value={pw} onChange={setPw} account="password" onSubmit={ready ? () => void go() : undefined} />
      <Button size="lg" label="Sign in" icon="login" onPress={ready ? go : undefined} kind={ready ? 'primary' : 'secondary'} />
      {err && !onError ? <T v="callout" color={C.redText}>{err}</T> : null}
    </View>
  );
}
