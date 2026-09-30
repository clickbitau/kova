import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AskReply } from '../api/types';
import { C, F } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { isLight, plural } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Press } from '../ui/kit';
import { T } from '../ui/Text';

interface Msg { id: number; from: 'you' | 'kova'; text: string; src?: string; actions?: AskReply['actions']; undo?: string }

const SRC_ICON: Record<string, string> = { 'Device control': 'toggle_on', 'From the activity log': 'history', 'From your modes': 'routine', 'Built-in · nothing left your home': 'lock' };
const TRY = ['Turn off the kitchen', 'Lamp to 30%', 'Why is the garage light on?', 'What’s happening tonight?', 'Who’s home?', 'I’m leaving'];

/** Ask Kova: the built-in assistant on the hub (optional AI on top). What it understood shows as chips while you type. */
export function AskScreen() {
  const s = useSnap();
  const { api, undo, say } = useHub();
  const insets = useSafeAreaInsets();
  const mode = s.modes.find(m => m.id === s.current.modeId);
  const [chat, setChat] = useState<Msg[]>(() => [{ id: 0, from: 'kova', text: `Hi. ${mode?.name ?? 'Day'} mode, ${plural(s.devices.filter(d => isLight(d) && d.state.on).length, 'light')} on.`, src: 'Built-in · nothing left your home' }]);
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);

  // The "Understood" preview, a moment after typing stops.
  useEffect(() => {
    if (!text.trim()) { setChips([]); return; }
    const t = setTimeout(() => { void api<{ chips: string[] }>('POST', '/api/ask/parse', { text }).then(r => setChips(r.chips ?? [])).catch(() => setChips([])); }, 250);
    return () => clearTimeout(t);
  }, [text, api]);

  const ask = async (q: string) => {
    const t = q.trim();
    if (!t || busy) return;
    setText(''); setChips([]); setBusy(true);
    setChat(c => [...c, { id: Date.now(), from: 'you', text: t }]);
    try {
      const r = await api<AskReply>('POST', '/api/ask', { text: t });
      setChat(c => [...c, { id: Date.now() + 1, from: 'kova', text: r.text, src: r.source, actions: r.actions, undo: r.undo }]);
    } catch (e) {
      setChat(c => [...c, { id: Date.now() + 1, from: 'kova', text: (e as Error).message }]);
    } finally {
      setBusy(false);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  const run = async (m: Msg, a: AskReply['actions'][number]) => {
    try {
      const r = await api<{ text: string; undo?: string }>('POST', '/api/ask/act', { action: a.action });
      setChat(c => [...c.map(x => x.id === m.id ? { ...x, actions: [] } : x), { id: Date.now(), from: 'kova', text: r.text || 'Done.', src: 'Device control', undo: r.undo }]);
    } catch (e) { say((e as Error).message, { error: true }); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scroll} contentContainerStyle={{ paddingTop: insets.top + 18, paddingHorizontal: 18, paddingBottom: 16, gap: 14 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={{ gap: 6 }}>
          <T size={30} weight={700} tracking={-0.02}>Ask Kova</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(127,212,160,0.14)', alignSelf: 'flex-start' }}>
            <Icon name="lock" size={15} color={C.green} />
            <T size={12} weight={700} color={C.green}>Built-in · works offline</T>
          </View>
        </View>
        {chat.map(m => (
          <View key={m.id} style={{ alignItems: m.from === 'you' ? 'flex-end' : 'flex-start', gap: 6 }}>
            <View style={{ maxWidth: '86%', paddingVertical: 11, paddingHorizontal: 14, borderRadius: 16, backgroundColor: m.from === 'you' ? C.bone : C.card }}>
              <T size={14} lineHeight={1.5} color={m.from === 'you' ? C.coal : C.bone}>{m.text}</T>
            </View>
            {m.actions?.length || m.undo ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {m.actions?.map(a => (
                  <Press key={a.label} onPress={() => void run(m, a)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: C.amber }}>
                    <T size={12.5} weight={700} color={C.onAmber}>{a.label}</T>
                  </Press>
                ))}
                {m.undo ? (
                  <Press onPress={() => { void undo(m.undo!); setChat(c => c.map(x => x.id === m.id ? { ...x, undo: undefined } : x)); }} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)' }}>
                    <T size={12.5} weight={700}>Undo</T>
                  </Press>
                ) : null}
              </View>
            ) : null}
            {m.src ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4 }}>
                <Icon name={SRC_ICON[m.src] ?? (m.src.startsWith('Cloud') ? 'cloud' : m.src.startsWith('Local') ? 'dns' : 'lock')} size={13} color={C.stone2} />
                <T size={11} color={C.stone2}>{m.src}</T>
              </View>
            ) : null}
          </View>
        ))}
        {chat.length < 3 ? (
          <View style={{ gap: 8 }}>
            <T size={11} weight={700} color={C.stone2} upper tracking={0.06}>Try</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {TRY.map(q => (
                <Press key={q} onPress={() => void ask(q)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
                  <T size={12.5} weight={600}>{q}</T>
                </Press>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10, gap: 8, borderTopWidth: 1, borderTopColor: C.hairline, backgroundColor: C.page }}>
        {chips.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <T size={11} weight={700} color={C.green} upper tracking={0.06}>Understood</T>
            {chips.map(c => (
              <View key={c} style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 8, backgroundColor: C.inset }}>
                <T size={12} weight={600}>{c}</T>
              </View>
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput value={text} onChangeText={setText} placeholder="Ask or tell Kova…" placeholderTextColor={C.stone3} returnKeyType="send" onSubmitEditing={() => void ask(text)}
            style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
          <Press onPress={() => void ask(text)} label="Send" disabled={!text.trim() || busy} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="send" size={21} color={C.onAmber} fill />
          </Press>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
