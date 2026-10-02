import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP } from '../theme';
import { useHub } from '../state/hub';
import { useNav } from '../navigation';
import { ago, codeComplete, formatCode, sessionIcon } from '../logic/browsers';
import { Button, Card, Empty, Group, Row, Section } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

interface Session { id: string; name: string; created: number; lastSeen: number; current?: boolean }

/**
 * More → Sign in a browser: type the code a browser shows on the Kova sign-in page, and it signs itself in with a key
 * of its own (never the hub's master key). Below, every browser signed in this way, each with Sign out.
 */
export function BrowsersScreen() {
  const nav = useNav();
  const { api, say } = useHub();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [list, setList] = useState<Session[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const load = useCallback(() => {
    setLoadErr(false);
    return api<{ sessions: Session[] }>('GET', '/api/sessions').then(r => setList(r.sessions ?? [])).catch(() => setLoadErr(true));
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const approve = async () => {
    if (!codeComplete(code)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ name: string }>('POST', '/api/login/approve', { code });
      setMsg({ text: `${r.name} is signed in.`, ok: true });
      setCode('');
      void load();
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally { setBusy(false); }
  };

  const signOut = async (s: Session) => {
    try { await api('DELETE', `/api/sessions/${encodeURIComponent(s.id)}`); say(`${s.name} signed out`); void load(); }
    catch (e) { say((e as Error).message, { error: true }); }
  };

  return (
    <Screen title="Sign in a browser" over="Your home on a computer, without its master key" onBack={() => nav.goBack()} onRefresh={() => void load()}>
      <Card style={{ gap: SP[3] }}>
        <T v="footnote" color={C.stone}>Open your Kova address in the browser. It shows a code: type it here.</T>
        <TextInput value={code} onChangeText={t => { setCode(formatCode(t)); setMsg(null); }} placeholder="ABCD-1234" placeholderTextColor={C.stone3}
          autoCapitalize="characters" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => void approve()} accessibilityLabel="Code from the browser"
          style={{ fontFamily: F.mono, fontSize: 26, letterSpacing: 3, textAlign: 'center', color: C.bone, paddingVertical: SP[3], borderRadius: R.md, backgroundColor: C.inset }} />
        {msg ? <T v="footnote" color={msg.ok ? C.green : C.red}>{msg.text}</T> : null}
        <Button full label="Sign it in" icon="login" busy={busy} onPress={approve} />
      </Card>
      <Section title="Signed in">
        {loadErr ? <Empty icon="cloud_off" title="Couldn’t load them" text="The hub didn’t answer." action="Try again" onAction={() => void load()} />
          : list && !list.length ? <T v="footnote" color={C.stone}>No browsers signed in with a code yet. Ones opened with the hub’s access key don’t show here.</T>
          : (
            <Group>
              {(list ?? []).map((s, i) => (
                <Row key={s.id} first={i === 0} icon={sessionIcon(s.name)} title={s.name} sub={`Signed in ${new Date(s.created).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · last used ${ago(s.lastSeen)}`}
                  right={<View><Button size="sm" kind="danger" label="Sign out" onPress={() => signOut(s)} /></View>} />
              ))}
            </Group>
          )}
      </Section>
    </Screen>
  );
}
