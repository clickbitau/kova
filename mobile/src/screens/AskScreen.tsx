import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useScrollToTop } from '@react-navigation/native';
import type { AskReply } from '../api/types';
import { askKova, Cancelled, engineLine, followJob, mergeHistory, progressLines, sourceIcon, type AskHistory, type AskJob, type ChatMsg } from '../logic/ask';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { isLight, plural } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Button, HScroll, Press } from '../ui/kit';
import { ConnBanner } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, haptic, useLoop, useStateValue } from '../ui/motion';
import { listen, quiet, setVoiceLang, speak, stopListening, useSpeechRecognitionEvent, voiceLang, voiceReady, type VoiceLang } from '../native/voice';

type Msg = ChatMsg;
const TRY = ['What’s happening tonight?', 'Who’s home?', 'Turn off the kitchen', 'Lamp to 30%', 'Why is the porch light on?', 'I’m leaving'];

/** While a long request is worked on: what the hub is doing, step by step (logic/ask.ts progressLines). */
function Working({ job, trouble }: { job: AskJob | null; trouble: string | null }) {
  const p = progressLines(job);
  return (
    <Appear style={{ alignSelf: 'flex-start', maxWidth: '86%', gap: 8 }}>
      <Typing />
      <View style={{ gap: 4, paddingHorizontal: 6 }} accessibilityLiveRegion="polite">
        <T v="micro" weight={600} color={C.stone2}>{p.title}</T>
        {p.steps.map((st, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
            <Icon name={st.status === 'ok' ? 'check_circle' : st.status === 'failed' ? 'error' : 'pending'} size={14} color={st.status === 'ok' ? C.green : st.status === 'failed' ? C.redText : C.stone2} />
            <T v="micro" color={st.status === 'failed' ? C.redText : C.bone2} style={{ flexShrink: 1 }}>{st.note && st.status === 'failed' ? `${st.label}: ${st.note}` : st.label}</T>
          </View>
        ))}
        {trouble ? <T v="micro" color={C.stone2} style={{ flexShrink: 1 }}>{trouble}</T> : null}
      </View>
    </Appear>
  );
}

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
  const [chat, setChat] = useState<Msg[]>(() => [{ id: 'hello', from: 'kova', text: `Hi. It’s ${mode?.name ?? 'Day'} mode, with ${plural(lights, 'light')} on. Ask me anything about your home, or tell me what to do.`, src: 'Built-in · nothing left your home' }]);
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The request being worked on (its steps), and a word when the hub can't be heard for a moment.
  const [job, setJob] = useState<AskJob | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);
  const line = engineLine(s.assistant);
  const [focus, setFocus] = useState(false);
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  const ready = !!text.trim();
  const can = useStateValue(ready);

  // The "Understood" preview, a moment after typing stops.
  useEffect(() => {
    if (!text.trim()) { setChips([]); return; }
    const t = setTimeout(() => { void api<{ chips: string[] }>('POST', '/api/ask/parse', { text }).then(r => setChips(r.chips ?? [])).catch(() => setChips([])); }, 250);
    return () => clearTimeout(t);
  }, [text, api]);

  // A sent message leaves the box and lands in the chat straight away; a slow request before it never eats the next
  // one — each waits its turn. A long one is a job on the hub, followed here until it lands (logic/ask.ts): it is never
  // timed out while the hub works on it, and if the app goes away the answer is in the hub's conversation.
  const queue = useRef<string[]>([]);
  const asking = useRef(false);
  const following = useRef(new Set<string>());
  /** Asked by voice, in that language: its answer is read out. */
  const spoken = useRef<VoiceLang | null>(null);
  const land = (r: AskReply, jobId?: string) => {
    if (spoken.current) { speak(r.text, spoken.current); spoken.current = null; }
    setChat(c => (jobId && c.some(m => m.job === jobId && m.from === 'kova')) ? c
      : [...c, { id: `k${Date.now()}`, from: 'kova', text: r.text, src: r.source || undefined, engine: r.engine, actions: r.actions, undo: r.undo, failed: r.failed, ts: Date.now(), ...(jobId ? { job: jobId } : {}) }]);
    if (r.failed) haptic.error(); else if (r.undo) haptic.success();
  };
  const opts = (id?: { current: string | undefined }) => ({
    api, sleep: (ms: number) => new Promise<void>(ok => setTimeout(ok, ms)), cancelled: () => gone.current,
    onJob: (j: AskJob) => { if (id) id.current = j.id; following.current.add(j.id); setJob(j.status === 'done' ? null : j); },
    onTrouble: setTrouble,
  });
  const drain = async () => {
    if (asking.current) return;
    asking.current = true; setBusy(true);
    try {
      while (queue.current.length) {
        const t = queue.current.shift()!;
        const id = { current: undefined as string | undefined };
        try {
          land(await askKova(t, opts(id)), id.current);
        } catch (e) {
          if (e instanceof Cancelled) return;
          land({ text: (e as Error).message, source: '', actions: [], understood: false, failed: true }, id.current);
        } finally { setJob(null); setTrouble(null); }
      }
    } finally {
      asking.current = false; setBusy(false);
    }
  };

  // What the hub has: answers that landed while the app was closed or away, and requests still being worked on
  // (followed from here on). Read on opening, and each time the app comes back to the front.
  const catchUp = async () => {
    let h: AskHistory;
    try { h = await api<AskHistory>('GET', '/api/ask/history'); } catch { return; }
    if (gone.current) return;
    setChat(c => mergeHistory(c, h.turns ?? []));
    for (const j of h.jobs ?? []) {
      if (following.current.has(j.id)) continue;
      following.current.add(j.id);
      setChat(c => mergeHistory(c, [{ role: 'user', text: j.text, ts: j.started, job: j.id }]));
      setBusy(true);
      void followJob(j, opts()).then(r => land(r, j.id), e => { if (!(e instanceof Cancelled)) land({ text: (e as Error).message, source: '', actions: [], understood: false, failed: true }, j.id); })
        .finally(() => { if (!asking.current) { setBusy(false); setJob(null); setTrouble(null); } });
    }
  };
  useEffect(() => {
    void catchUp();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') void catchUp(); });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Talking: what's heard fills the box as it's said, and is asked when the speaker stops.
  const [listening, setListening] = useState(false);
  const [lang, setLang] = useState<VoiceLang>('en-AU');
  const heard = useRef('');
  useEffect(() => { void voiceLang().then(setLang); }, []);
  useSpeechRecognitionEvent('result', e => { const t = e.results[0]?.transcript ?? ''; heard.current = t; setText(t); });
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    const t = heard.current.trim();
    heard.current = '';
    if (t) { spoken.current = lang; ask(t); }
  });
  useSpeechRecognitionEvent('error', e => {
    setListening(false);
    if (e.error === 'aborted') return;
    say(e.error === 'no-speech' ? 'Didn’t hear anything' : e.error === 'not-allowed' ? 'Allow the microphone for Kova in Settings to talk to it' : `Couldn’t listen: ${e.message || e.error}`, { error: e.error !== 'no-speech' });
  });
  const mic = async () => {
    if (listening) { stopListening(); return; }
    quiet();
    heard.current = ''; setText('');
    try { await listen(lang); setListening(true); haptic.select(); } catch (e) { say((e as Error).message, { error: true }); }
  };
  const switchLang = () => { const l: VoiceLang = lang === 'bn-BD' ? 'en-AU' : 'bn-BD'; setLang(l); void setVoiceLang(l); say(l === 'bn-BD' ? 'Listening in Bangla' : 'Listening in English'); };

  const ask = (q: string) => {
    const t = q.trim();
    if (!t) return;
    haptic.select();
    setText(''); setChips([]);
    queue.current.push(t);
    setChat(c => [...c, { id: `y${Date.now()}`, from: 'you', text: t, ts: Date.now() }]);
    void drain();
  };

  // Asked from elsewhere ("Why?" on a suggestion's card): ask it once it arrives.
  const route = useRoute();
  const sent = route.params as { ask?: string; at?: number } | undefined;
  const askedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!sent?.ask || sent.at === askedAt.current) return;
    askedAt.current = sent.at;
    ask(sent.ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent?.ask, sent?.at]);

  const nav = useNav();
  const run = async (m: Msg, a: AskReply['actions'][number]) => {
    // “Open the timing”: the group's timing screen, here in the app.
    const ac = a.action as { type: string; group?: string };
    if (ac.type === 'tune' && ac.group) { nav.navigate('GroupSync', { id: ac.group }); return true; }
    try {
      const r = await api<{ text: string; undo?: string }>('POST', '/api/ask/act', { action: a.action });
      setChat(c => [...c.map(x => x.id === m.id ? { ...x, actions: [] } : x), { id: `a${Date.now()}`, from: 'kova', text: r.text || 'Done.', src: 'Device control', undo: r.undo, ts: Date.now() }]);
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
              <Icon name={line.icon} size={13} color={line.tone === 'green' ? C.green : line.tone === 'warn' ? C.redText : C.stone2} />
              <T v="footnote" size={12} weight={600} color={line.tone === 'green' ? C.green : line.tone === 'warn' ? C.redText : C.stone2} style={{ flexShrink: 1 }} numberOfLines={2}>{line.text}</T>
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
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, maxWidth: '86%' }}>
                  <Icon name={sourceIcon(m.src, m.engine)} size={13} color={C.stone2} />
                  <T v="micro" weight={500} color={C.stone2} style={{ flexShrink: 1 }}>{m.src}</T>
                </View>
              ) : null}
            </Appear>
          );
        })}
        {busy ? <Working job={job} trouble={trouble} /> : null}
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
              {voiceReady ? (
                <Press onPress={switchLang} label={lang === 'bn-BD' ? 'Talking in Bangla: switch to English' : 'Talking in English: switch to Bangla'} style={{ height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: R.full, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
                  <Icon name="mic" size={15} color={C.stone} />
                  <T v="label" size={12.5} weight={700} color={C.bone2}>{lang === 'bn-BD' ? 'বাংলা' : 'English'}</T>
                </Press>
              ) : null}
              {TRY.map(q => (
                <Press key={q} onPress={() => void ask(q)} label={`Ask: ${q}`} style={{ height: 34, justifyContent: 'center', paddingHorizontal: 13, borderRadius: R.full, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
                  <T v="label" size={12.5} weight={600} color={C.bone2}>{q}</T>
                </Press>
              ))}
            </HScroll>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[3] }}>
          <TextInput value={text} onChangeText={setText} placeholder={listening ? (lang === 'bn-BD' ? 'শুনছি…' : 'Listening…') : 'Ask or tell Kova…'} placeholderTextColor={C.stone2} returnKeyType="send" onSubmitEditing={() => void ask(text)}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} accessibilityLabel="Ask or tell Kova"
            style={{ flex: 1, minWidth: 0, height: 48, paddingHorizontal: SP[4], borderRadius: 24, backgroundColor: C.card, borderWidth: 1, borderColor: focus ? C.amberLine : C.line, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
          {voiceReady && (!text || listening) ? (
            <Press onPress={() => void mic()} label={listening ? 'Stop listening' : 'Talk to Kova'} selected={listening} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? C.red : C.card, borderWidth: listening ? 0 : 1, borderColor: C.line }}>
              <Icon name={listening ? 'stop' : 'mic'} size={23} color={listening ? C.onRed : C.bone} fill={listening} />
            </Press>
          ) : null}
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
