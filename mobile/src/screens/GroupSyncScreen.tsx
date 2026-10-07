import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import type { GroupPart, SpeakerGroup } from '../api/types';
import { meOf } from '../logic/roles';
import { delayWords, driftWords, EXPECT, msWords, NUDGES, offsetWords, partSub, partTitle, snapOffset, testLeft, testSteps } from '../logic/group-sync';
import { Button, Card, Empty, ExpandRow, IconWell, Row, Section, Slider, Tag } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { SpeakerGroupSheet } from './SpeakerGroupSheet';

interface SyncView { parts: GroupPart[]; log: { at: number; text: string }[]; test: { until: number } | null }

/** One part of the group: how it plays; for one played alongside, its timing (slider and nudges) and start delay. */
function PartRow({ g, p, first, canTune, live }: { g: SpeakerGroup; p: GroupPart; first: boolean; canTune: boolean; live?: GroupPart }) {
  const { act } = useHub();
  const snap = useSnap();
  const names = p.members.map(m => snap.devices.find(d => d.id === m)?.name ?? m).join(', ');
  const [draft, setDraft] = useState<number | null>(null);
  const off = draft ?? p.offset;
  const save = (v: number) => {
    const n = snapOffset(v);
    setDraft(n);
    return act('PUT', `/api/speaker-groups/${encodeURIComponent(g.id)}/offsets`, { offsets: { [p.key]: n } }, `${p.name}: ${n ? `${msWords(n)}, ${n > 0 ? 'earlier' : 'later'}` : 'in step'}`).finally(() => setDraft(null));
  };
  const drift = driftWords(live?.driftMs);
  const tone = p.reference ? C.green : C.blue;
  return (
    <View style={{ gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SP[3] }}>
        <IconWell icon={p.kind === 'native' ? 'graphic_eq' : p.reference ? 'speaker' : 'sync'} color={tone} size={36} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="headline">{partTitle(p)}</T>
          <T v="footnote" color={C.stone}>{partSub(p)}</T>
          {p.kind === 'native' ? <T v="footnote" color={C.stone2}>{names}</T> : null}
          <View style={{ flexDirection: 'row', paddingTop: 2 }}><Tag text={p.reference ? 'Main' : 'Alongside'} color={tone} /></View>
        </View>
      </View>
      {!p.reference && canTune ? (
        <View style={{ gap: SP[2] }}>
          <Slider value={off} min={-1000} max={1000} suffix=" ms" color={C.blue} onColor={C.onBlue} icon="schedule" label={`${p.name} timing`}
            onChange={v => setDraft(snapOffset(v))} onRelease={v => void save(v)} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SP[2] }}>
            <T v="footnote" color={C.stone2}>← Later</T>
            <T v="footnote" color={C.stone2}>Earlier →</T>
          </View>
          <T v="label" color={C.bone2} tabular>{offsetWords(off)}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            {NUDGES.map(n => (
              <View key={n} style={{ flexGrow: 1, flexBasis: '40%' }}>
                <Button size="sm" kind="secondary" full label={`${n > 0 ? '+' : '−'}${Math.abs(n)}`} onPress={() => save(off + n)} />
              </View>
            ))}
          </View>
        </View>
      ) : null}
      <T v="footnote" color={C.stone2}>{delayWords(p)}</T>
      {drift && !p.reference ? <T v="footnote" color={C.blue}>{drift}</T> : null}
    </View>
  );
}

/**
 * A speaker group's timing: its native groups (in perfect sync) and the speakers played alongside, each with a timing
 * slider and its measured start delay; the sync test (a tick every second on every speaker, quietly); and what Kova
 * did to keep it in time. An adult or the owner can tune it.
 */
export function GroupSyncScreen() {
  const s = useSnap();
  const nav = useNav();
  const { api } = useHub();
  const { id } = (useRoute().params ?? {}) as { id?: string };
  const g = s.speakerGroups.find(x => x.id === id);
  const canTune = meOf(s).can.home;
  const [view, setView] = useState<SyncView | null>(null);
  const [log, setLog] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(() => { if (id && canTune) void api<SyncView>('GET', `/api/speaker-groups/${encodeURIComponent(id)}/sync`).then(setView).catch(() => {}); }, [api, id, canTune]);
  // While the screen shows: how the speakers are doing, every few seconds.
  useFocusEffect(useCallback(() => {
    load();
    timer.current = setInterval(load, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]));
  if (!g) return <Screen title="Timing" onBack={() => nav.goBack()}><Empty icon="speaker_group" title="That group is gone" text="It was deleted, or its id changed." /></Screen>;
  const parts = g.parts ?? [];
  const along = parts.filter(p => !p.reference);
  const left = testLeft(view?.test?.until ?? g.testUntil);
  const steps = testSteps(view?.parts ?? parts);
  const test = async (on: boolean) => {
    setNote(null);
    try {
      await api(on ? 'POST' : 'DELETE', `/api/speaker-groups/${encodeURIComponent(g.id)}/sync-test`, on ? {} : undefined, 30_000);
      setNote({ text: on ? 'Playing for 3 minutes. Stop it any time: every speaker goes back to what it was doing.' : 'Stopped. The speakers are back as they were.', error: false });
      load();
      return true;
    } catch (e) { setNote({ text: (e as Error).message, error: true }); return false; }
  };
  return (
    <Screen title={g.name} over="Speaker group · timing" onBack={() => nav.goBack()} gap={SP[6]}>
      <T v="callout" color={C.stone}>{parts.length < 2 ? 'One stream, kept in sync by the speakers themselves: nothing to tune.' : `Plays as ${parts.length} streams: ${parts.some(p => p.kind === 'native') ? 'a native group in perfect sync, and the rest alongside it' : 'each speaker its own'}, started at one moment and kept in time.`}</T>
      <Section title="How it plays" caption gap={SP[2]}>
        <Card style={{ overflow: 'hidden' }}>
          {parts.map((p, i) => <PartRow key={p.key} g={g} p={p} first={!i} canTune={canTune} live={view?.parts.find(x => x.key === p.key)} />)}
        </Card>
        {along.length && !canTune ? <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>An adult in the home can tune the timing.</T> : null}
      </Section>
      {along.length && canTune && steps ? (
        <Section title="Sync test" caption gap={SP[2]}>
          <Card pad={SP[4]} tint={C.amber} style={{ gap: SP[3] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
              <IconWell icon="surround_sound" color={C.amber} size={38} />
              <T v="headline" style={{ flex: 1, minWidth: 0 }}>{left ? `Playing · ${left}` : 'Line them up by ear'}</T>
            </View>
            <T v="callout" color={C.bone2}>{steps}</T>
            <Button full kind={left ? 'secondary' : 'primary'} icon={left ? 'stop' : 'play_arrow'} label={left ? 'Stop the test' : 'Start the sync test'} onPress={() => test(!left)} />
            {note ? <T v="footnote" color={note.error ? C.redText : C.green}>{note.text}</T> : null}
          </Card>
        </Section>
      ) : null}
      {along.length ? <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{`What to expect: ${EXPECT}`}</T> : null}
      {canTune ? (
        <Card style={{ overflow: 'hidden' }}>
          <Row first icon="edit" title="Speakers in this group" sub="Add or take out speakers, any brand" onPress={() => setEdit(g.id)} />
          <ExpandRow icon="history" title="Sync log" sub="What Kova did: starts, drift, corrections" open={log} onToggle={() => setLog(x => !x)}>
            <View style={{ gap: SP[2], paddingBottom: SP[2] }}>
              {(view?.log ?? []).slice(0, 14).map((l, i) => (
                <View key={`${l.at}-${i}`} style={{ flexDirection: 'row', gap: SP[2] }}>
                  <T v="footnote" color={C.stone2} tabular>{new Date(l.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</T>
                  <T v="footnote" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{l.text}</T>
                </View>
              ))}
              {!view?.log.length ? <T v="footnote" color={C.stone}>Nothing yet. When the group plays music, Kova notes each speaker’s start, its drift and every correction here.</T> : null}
            </View>
          </ExpandRow>
        </Card>
      ) : null}
      <SpeakerGroupSheet id={edit} onClose={() => setEdit(null)} />
    </Screen>
  );
}
