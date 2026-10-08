import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import type { GroupPart, SpeakerGroup } from '../api/types';
import { meOf } from '../logic/roles';
import { delayWords, driftWords, EXPECT, msWords, musicSteps, NUDGES, nudgeLabel, offsetWords, partSub, partTitle, snapOffset, testLeft, testSteps, tuneState } from '../logic/group-sync';
import { Button, Card, Empty, ExpandRow, IconWell, Pill, Row, Section, Slider, Tag } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { SpeakerGroupSheet } from './SpeakerGroupSheet';

interface SyncView { parts: GroupPart[]; log: { at: number; text: string }[]; test: { until: number } | null; playing: { media: string; live: boolean; startAt: number } | null }

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
              <View key={n} style={{ flexGrow: 1, flexBasis: '30%' }}>
                <Button size="sm" kind="secondary" full label={nudgeLabel(n)} onPress={() => save(off + n)} />
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
 * The group's volume, and each speaker's level against the others: set them where they sound alike, and the group's
 * volume moves them all together, keeping it (the hub's adapters/groups.ts).
 */
function VolumeCard({ g, canTune }: { g: SpeakerGroup; canTune: boolean }) {
  const { api, send, say } = useHub();
  const s = useSnap();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const dev = (id: string) => s.devices.find(d => d.id === id);
  const G = dev(`group_${g.id}`);
  const members = g.members.map(dev).filter((d): d is NonNullable<typeof d> => !!d);
  const level = (id: string) => draft[id] ?? dev(id)?.state.vol ?? 0;
  const setOne = async (id: string, v: number) => {
    setDraft(x => ({ ...x, [id]: v }));
    try { await api('PUT', `/api/speaker-groups/${encodeURIComponent(g.id)}/balance`, { levels: { [id]: v } }); return true; }
    catch (e) { say((e as Error).message); return false; }
    finally { setTimeout(() => setDraft(x => { const n = { ...x }; delete n[id]; return n; }), 1500); }
  };
  return (
    <Section title="Volume" caption gap={SP[2]}>
      <Card style={{ overflow: 'hidden' }}>
        <View style={{ padding: SP[4], gap: SP[3] }}>
          <Slider value={draft[G?.id ?? ''] ?? G?.state.vol ?? 0} min={0} max={100} suffix="%" color={C.amber} onColor={C.onAmber} icon="volume_up" label={`${g.name} volume`}
            onChange={v => setDraft(x => ({ ...x, [G?.id ?? '']: v }))}
            onRelease={v => void send(G?.id ?? `group_${g.id}`, { vol: v }).finally(() => setTimeout(() => setDraft(x => { const n = { ...x }; delete n[G?.id ?? '']; return n; }), 1500))} />
          <T v="footnote" color={C.stone}>{g.balance ? 'Moves every speaker together, keeping the balance below.' : 'Moves every speaker together, keeping how loud each is now against the others.'}</T>
        </View>
        {canTune ? (
          <ExpandRow icon="tune" iconFg={C.amber} title="Balance" sub={g.balance ? 'Set: the group keeps it' : 'Make the speakers sound alike'} open={open} onToggle={() => setOpen(x => !x)}>
            <View style={{ gap: SP[3], paddingBottom: SP[3] }}>
              <T v="callout" color={C.bone2}>While something plays, set each speaker so they all sound about as loud where you listen. Kova keeps that balance: the group’s volume then moves them all together.</T>
              {members.map(d => (
                <View key={d.id} style={{ gap: SP[1] }}>
                  <T v="label" color={C.bone2} numberOfLines={2}>{d.name}</T>
                  <Slider value={level(d.id)} min={0} max={100} suffix="%" color={C.blue} onColor={C.onBlue} icon="speaker" label={d.name}
                    onChange={v => setDraft(x => ({ ...x, [d.id]: v }))} onRelease={v => void setOne(d.id, v)} />
                </View>
              ))}
              {g.balance ? <Button size="sm" kind="ghost" icon="restart_alt" label="Forget the balance" onPress={() => api('PUT', `/api/speaker-groups/${encodeURIComponent(g.id)}/balance`, { reset: true }).then(() => { say('Balance forgotten: the group keeps the speakers’ levels as they are'); return true; }).catch(e => { say((e as Error).message); return false; })} /> : null}
            </View>
          </ExpandRow>
        ) : null}
      </Card>
    </Section>
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
  const { api, send } = useHub();
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
  const how = musicSteps(g.name, view?.parts ?? parts);
  const now = tuneState(view?.playing);
  const [ticks, setTicks] = useState(false);
  const gid = `group_${g.id}`;
  const play = (media: string) => send(gid, { on: true, media }, `Playing ${media} on ${g.name}`).then(ok => { setTimeout(load, 1500); return ok; });
  const stop = () => send(gid, { on: false, media: null }, `${g.name} stopped`).then(ok => { setTimeout(load, 800); return ok; });
  const test = async (on: boolean) => {
    setNote(null);
    try {
      await api(on ? 'POST' : 'DELETE', `/api/speaker-groups/${encodeURIComponent(g.id)}/sync-test`, on ? {} : undefined, 30_000);
      setNote({ text: on ? 'Ticking for up to 3 minutes. Stop any time: every speaker goes back to what it was doing.' : 'Stopped. The speakers are back as they were.', error: false });
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
      <VolumeCard g={g} canTune={canTune} />
      {along.length && canTune && how ? (
        <Section title="Tune by ear" caption gap={SP[2]}>
          <Card pad={SP[4]} tint={C.blue} style={{ gap: SP[3] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
              <IconWell icon="music_note" color={C.blue} size={38} />
              <T v="headline" style={{ flex: 1, minWidth: 0 }}>{now.kind === 'music' ? `Playing ${view!.playing!.media}` : 'Tune with music'}</T>
            </View>
            <T v="callout" color={C.bone2}>{now.kind === 'music' ? now.text : how}</T>
            {now.kind === 'radio' ? <T v="footnote" color={C.amber}>{now.text}</T> : null}
            {now.kind === 'music' ? (
              <Button full kind="secondary" icon="stop" label={`Stop ${g.name}`} onPress={stop} />
            ) : s.music?.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
                {s.music.slice(0, 4).map(m => <Pill key={m.name} icon={m.icon} label={m.name} onPress={() => void play(m.name)} />)}
              </View>
            ) : <T v="footnote" color={C.stone}>{`Play a song or playlist on ${g.name} from Media (not the radio: a live stream can’t be lined up exactly), then come back here.`}</T>}
          </Card>
          <Card style={{ overflow: 'hidden' }}>
            <ExpandRow first icon="surround_sound" iconFg={C.amber} title={left ? `Tick test · ${left}` : 'Tick test'} sub="Optional: easier to hear small gaps" open={ticks || !!left} onToggle={() => setTicks(x => !x)}>
              <View style={{ gap: SP[3], paddingBottom: SP[3] }}>
                <T v="callout" color={C.bone2}>{steps}</T>
                <Button full kind={left ? 'secondary' : 'primary'} icon={left ? 'stop' : 'play_arrow'} label={left ? 'Stop the ticks' : 'Play ticks'} onPress={() => test(!left)} />
                {note ? <T v="footnote" color={note.error ? C.redText : C.green}>{note.text}</T> : null}
              </View>
            </ExpandRow>
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
