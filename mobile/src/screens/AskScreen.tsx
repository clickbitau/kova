import { useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScrollToTop } from '@react-navigation/native';
import type { AskReply } from '../api/types';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { isLight, plural } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Button, HScroll, Press } from '../ui/kit';
import { ConnBanner } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, haptic, useLoop, useStateValue } from '../ui/motion';

interface Msg { id: number; from: 'you' | 'kova'; text: string; src?: string; actions?: AskReply['actions']; undo?: string; failed?: boolean }

const SRC_ICON: Record<string, string> = { 'Device control': 'toggle_on', 'From the activity log': 'history', 'From your modes': 'routine', 'Built-in · nothing left your home': 'lock' };
const TRY = ['What’s happening tonight?', 'Who’s home?', 'Turn off the kitchen', 'Lamp to 30%', 'Why is the porch light on?', 'I’m leaving'];

/** Three dots rising in turn: Kova is working on an answer. */
function Typing() {
  const t = useLoop(true, 1100, { essential: true });
  return (
    <Appear style={{ alignSelf: 'flex-start', flexDirection: 'row', gap: 5, paddingVertical: 14, paddingHorizontal: 16, borderRadius: R.lg, borderBottomLeftRadius: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge }}>
      {[0, 1, 2].map(i => (
        <Animated.View key={i} accessibilityLabel={i ? undefined : 'Kova is thinking'} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.stone,
          opacity: t.interpolate({ inputRange: [0, 0.15 + i * 0.2, 0.35 + i * 0.2, 1], outputRange: [0.35, 1, 0.35, 0.35], extrapolate: 'clamp' }),
          transform: [{ translateY: t.interpolate({ inputRange: [0, 0.15 + i * 0.2, 0.35 + i * 0.2, 1], outputRange: [0, -3, 0, 0], extrapolate: 'clamp' }) }] }} />
      ))}
    </Appear>
  );
}

/** Ask Kova: the built-in assistant on the hub (optional AI on top). What it understood shows as chips while you type. */
export function AskScreen() {
  const s = useSnap();
  const { api, undo, say } = useHub();
  const insets = useSafeAreaInsets();
  const mode = s.modes.find(m => m.id === s.current.modeId);
  const lights = s.devices.filter(d => isLight(d) && d.state.on).length;
  const [chat, setChat] = useState<Msg[]>(() => [{ id: 0, from: 'kova', text: `Hi. It’s ${mode?.name ?? 'Day'} mode, with ${plural(lights, 'light')} on. Ask me anything about your home, or tell me what to do.`, src: 'Built-in · nothing left your home' }]);
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  const ready = !!text.trim() && !busy;
  const can = useStateValue(ready);

  // The "Understood" preview, a moment after typing stops.
  useEffect(() => {
    if (!text.trim()) { setChips([]); return; }
    const t = setTimeout(() => { void api<{ chips: string[] }>('POST', '/api/ask/parse', { text }).then(r => setChips(r.chips ?? [])).catch(() => setChips([])); }, 250);
    return () => clearTimeout(t);
  }, [text, api]);

  const ask = async (q: string) => {
    const t = q.trim();
    if (!t || busy) return;
    haptic.select();
    setText(''); setChips([]); setBusy(true);
    setChat(c => [...c, { id: Date.now(), from: 'you', text: t }]);
    try {
      const r = await api<AskReply>('POST', '/api/ask', { text: t });
      setChat(c => [...c, { id: Date.now() + 1, from: 'kova', text: r.text, src: r.source, actions: r.actions, undo: r.undo }]);
      if (r.undo) haptic.success();
    } catch (e) {
      haptic.error();
      setChat(c => [...c, { id: Date.now() + 1, from: 'kova', text: (e as Error).message, failed: true }]);
    } finally {
      setBusy(false);
    }
  };

  const run = async (m: Msg, a: AskReply['actions'][number]) => {
    try {
      const r = await api<{ text: string; undo?: string }>('POST', '/api/ask/act', { action: a.action });
      setChat(c => [...c.map(x => x.id === m.id ? { ...x, actions: [] } : x), { id: Date.now(), from: 'kova', text: r.text || 'Done.', src: 'Device control', undo: r.undo }]);
      return true;
    } catch (e) { say((e as Error).message, { error: true }); return false; }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingTop: insets.top + SP[3], paddingHorizontal: SP.gutter, paddingBottom: SP[3], gap: SP[2], borderBottomWidth: 1, borderBottomColor: C.hairline }}>
        <ConnBanner />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="graphic_eq" size={22} color={C.onAmber} />
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <T v="heading" size={19}>Ask Kova</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="lock" size={13} color={C.green} />
              <T v="footnote" size={12} weight={600} color={C.green}>Built in · works without the internet</T>
            </View>
          </View>
        </View>
      </View>

      <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingTop: SP[4], paddingHorizontal: SP.gutter, paddingBottom: SP[4], gap: SP[3] }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {chat.map(m => {
          const you = m.from === 'you';
          return (
            <Appear key={m.id} style={{ alignItems: you ? 'flex-end' : 'flex-start', gap: 6 }}>
              <View style={{ maxWidth: '86%', paddingVertical: 11, paddingHorizontal: 15, borderRadius: R.lg + 2, borderBottomRightRadius: you ? 6 : R.lg + 2, borderBottomLeftRadius: you ? R.lg + 2 : 6,
                backgroundColor: you ? C.amber : m.failed ? C.redTint : C.card, borderWidth: you ? 0 : 1, borderColor: m.failed ? C.redLine : C.edge }}>
                <T v="body" size={15} color={you ? C.onAmber : m.failed ? C.redText : C.bone}>{m.text}</T>
              </View>
              {m.actions?.length || m.undo ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {m.actions?.map(a => <Button key={a.label} size="sm" label={a.label} onPress={() => run(m, a)} />)}
                  {m.undo ? <Button size="sm" kind="secondary" label="Undo" onPress={() => { void undo(m.undo!); setChat(c => c.map(x => x.id === m.id ? { ...x, undo: undefined } : x)); }} /> : null}
                </View>
              ) : null}
              {m.src ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 }}>
                  <Icon name={SRC_ICON[m.src] ?? (m.src.startsWith('Cloud') ? 'cloud' : m.src.startsWith('Local') ? 'dns' : 'lock')} size={13} color={C.stone2} />
                  <T v="micro" weight={500} color={C.stone2}>{m.src}</T>
                </View>
              ) : null}
            </Appear>
          );
        })}
        {busy ? <Typing /> : null}
      </ScrollView>

      <View style={{ paddingTop: SP[2], paddingBottom: SP[2] + 2, gap: SP[2], borderTopWidth: 1, borderTopColor: C.hairline, backgroundColor: C.page }}>
        {chips.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: SP.gutter }} accessibilityLabel={`Understood: ${chips.join(', ')}`}>
            <Icon name="check_circle" size={15} color={C.green} fill />
            {chips.map(c => (
              <View key={c} style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: R.xs, backgroundColor: C.greenTint }}>
                <T v="micro" size={12} color={C.green}>{c}</T>
              </View>
            ))}
          </View>
        ) : !text ? (
          <View style={{ paddingHorizontal: SP.gutter }}>
            <HScroll>
              {TRY.map(q => (
                <Press key={q} onPress={() => void ask(q)} label={`Ask: ${q}`} style={{ height: 34, justifyContent: 'center', paddingHorizontal: 13, borderRadius: R.full, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
                  <T v="label" size={12.5} weight={600} color={C.bone2}>{q}</T>
                </Press>
              ))}
            </HScroll>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[3] }}>
          <TextInput value={text} onChangeText={setText} placeholder="Ask or tell Kova…" placeholderTextColor={C.stone2} returnKeyType="send" onSubmitEditing={() => void ask(text)}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} accessibilityLabel="Ask or tell Kova"
            style={{ flex: 1, height: 48, paddingHorizontal: SP[4], borderRadius: 24, backgroundColor: C.card, borderWidth: 1, borderColor: focus ? C.amberLine : C.line, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
          <Press onPress={() => void ask(text)} label="Send" disabled={!ready} style={{ width: 48, height: 48, borderRadius: 24 }}>
            <Animated.View style={{ flex: 1, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: can.interpolate({ inputRange: [0, 1], outputRange: [C.control, C.amber] }) }}>
              <Icon name="arrow_upward" size={23} color={ready ? C.onAmber : C.stone2} />
            </Animated.View>
          </Press>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
