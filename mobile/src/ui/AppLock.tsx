import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, SP } from '../theme';
import { lockKind, lockOn, RELOCK_MS, unlock } from '../native/applock';
import { Button, Mark } from './kit';
import { T } from './Text';

/**
 * With the app lock on (This phone → Lock with Face ID), the app is covered until the phone checks it's you: when
 * it opens, and when it comes back after a minute or more in the background. The app keeps running underneath, so
 * nothing reloads.
 */
export function AppLock({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [locked, setLocked] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const away = useRef<number | null>(null);
  const asking = useRef(false);

  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try { if (await unlock()) setLocked(false); } finally { asking.current = false; }
  }, []);

  useEffect(() => {
    void (async () => {
      const on = await lockOn();
      setKind(await lockKind());
      setChecking(false);
      if (on) { setLocked(true); void ask(); }
    })();
    const sub = AppState.addEventListener('change', st => {
      if (st === 'background') { away.current = Date.now(); return; }
      if (st !== 'active' || away.current == null) return;
      const gone = Date.now() - away.current;
      away.current = null;
      if (gone < RELOCK_MS) return;
      void lockOn().then(on => { if (on) { setLocked(true); void ask(); } });
    });
    return () => sub.remove();
  }, [ask]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {locked || checking ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.page, alignItems: 'center', justifyContent: 'center', padding: SP[6], paddingBottom: insets.bottom + SP[6], gap: SP[4] }}>
          <Mark size={56} />
          {locked ? (
            <>
              <T v="title" center>Kova is locked</T>
              <Button size="lg" icon="lock" label={`Unlock with ${kind ?? 'your passcode'}`} onPress={() => ask()} />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
