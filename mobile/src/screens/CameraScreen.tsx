// One camera: its latest picture (refreshing every few seconds), its room, and what it (or its room) saw, each
// event with the picture kept from that moment. Tap an event to look at its picture; tune for room and alerts.
// "Watch live" turns the picture into the live video, in place (ui/LivePlayer.tsx, logic/live.ts).
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { hubUrl } from '../logic/connect';
import { stateOf, devs } from '../logic/devices';
import { roomLine, timelineRows } from '../logic/sensors';
import type { TimelineEvent } from '../api/types';
import type { Stack } from '../navigation';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, Group, IconButton, Notice, NoticeAction, Press, PulseDot, Row, Section, Segmented, Spinner } from '../ui/kit';
import { CANT_STREAM, elapsedText, liveSupport } from '../logic/live';
import { LivePlayer, useLive } from '../ui/LivePlayer';
import { Appear } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { CameraStill } from './SecurityScreen';

export function CameraScreen({ route }: NativeStackScreenProps<Stack, 'Camera'>) {
  const { id, live: autoLive } = route.params;
  const s = useSnap();
  const { cfg, api } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const d = devs(s)[id];
  const [scope, setScope] = useState<'camera' | 'room'>('camera');
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [picked, setPicked] = useState<{ uri: string; t: string } | null>(null);
  const { view: lv, session, send } = useLive(id);
  const playing = lv.phase === 'connecting' || lv.phase === 'live';
  // Stills change when the camera sees something: re-ask every few seconds while open (not while it's live).
  const [tick, setTick] = useState(0);
  useEffect(() => { if (playing) return; const t = setInterval(() => setTick(x => x + 1), 5_000); return () => clearInterval(t); }, [playing]);
  // While live: the clock in the LIVE pill.
  const [, setSecond] = useState(0);
  useEffect(() => { if (lv.phase !== 'live') return; const t = setInterval(() => setSecond(x => x + 1), 1_000); return () => clearInterval(t); }, [lv.phase]);
  // Sound is off to start with, every time.
  const [muted, setMuted] = useState(true);
  useEffect(() => { if (lv.phase === 'connecting') setMuted(true); }, [lv.phase, lv.gen]);
  const sup = d ? liveSupport(d) : null;
  // Opened with Watch live (a Security card, a doorbell notification): start once the camera is known.
  const autoDone = useRef(false);
  useEffect(() => { if (autoLive && sup?.can && !autoDone.current) { autoDone.current = true; session.start(); } }, [autoLive, sup?.can, session]);
  // The timeline: again whenever the home's latest event changes.
  const latest = s.security?.recent[0]?.id ?? 0;
  const room = d?.room;
  useEffect(() => {
    let live = true;
    const q = scope === 'camera' ? `device=${encodeURIComponent(id)}` : `room=${encodeURIComponent(room ?? '')}`;
    api<{ events: TimelineEvent[] }>('GET', `/api/timeline?${q}&limit=30`).then(r => { if (live) setEvents(r.events); }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [api, id, room, scope, latest]);
  if (!d) return <Screen title="Camera" onBack={() => nav.goBack()}><Empty icon="videocam" title="Camera gone" text="It isn’t on the hub anymore." /></Screen>;

  const [st, fg] = stateOf(d);
  const off = d.online === false;
  const line = d.why?.now && !/No change/.test(d.why.now) ? d.why.now : st;
  const roomName = s.rooms.find(r => r.id === d.room)?.name ?? 'No room';
  const outdoor = s.security?.devices[id]?.outdoor;
  const snapUri = cfg ? `${hubUrl(cfg, `/api/devices/${encodeURIComponent(id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}` : null;
  const can = !!sup?.can;
  const watch = () => { setPicked(null); session.start(); };
  const toggleSound = () => { const m = !muted; setMuted(m); send.current({ kova: 'mute', muted: m }); };
  const rows = timelineRows(events ?? []);
  const frameUri = (p: string) => cfg ? hubUrl(cfg, p, true) : null;

  const around = roomLine(s.roomStatus?.[d.room]);
  return (
    <Screen title={d.name} over={`${roomName}${outdoor == null ? '' : outdoor ? ' · outside' : ' · inside'}`} onBack={() => nav.goBack()}>
      <View style={{ gap: SP[3] }}>
        <Appear index={0}>
          <Press onPress={picked ? () => setPicked(null) : can && !playing ? watch : undefined} give="soft" disabled={off && !picked}
            label={picked ? `Picture from ${picked.t}. Back to the latest` : playing ? `${d.name}, live video` : can ? `${d.name}, ${line}. Watch live` : `${d.name}, ${line}`}>
            <View style={{ aspectRatio: 16 / 9, borderRadius: R.lg, overflow: 'hidden', backgroundColor: C.inset, borderWidth: 1, borderColor: C.edge, alignItems: 'center', justifyContent: 'center' }}>
              {picked ? <Image source={{ uri: picked.uri }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={200} accessibilityLabel={`${d.name} at ${picked.t}`} />
                : <CameraStill uri={snapUri} off={off} label={`${d.name} latest picture`} />}
              {playing && !picked ? <LivePlayer gen={lv.gen} send={send} onMessage={m => session.fromPage(m)} label={`${d.name} live video`} /> : null}
              {lv.phase === 'connecting' && !picked ? (
                <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(14,15,16,0.35)' }}>
                  <Spinner size={30} color={C.bone} width={2.6} />
                </View>
              ) : null}
              <View pointerEvents="none" style={{ position: 'absolute', left: SP[2] + 2, bottom: SP[2] + 2, right: SP[2] + 2 + 48, flexDirection: 'row' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 26, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.full, backgroundColor: 'rgba(14,15,16,0.78)', flexShrink: 1 }}>
                  {picked ? <Icon name="history" size={14} color={C.bone} />
                    : lv.phase === 'live' ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} />
                    : lv.phase === 'connecting' ? <Spinner size={12} color={C.bone} width={1.8} />
                    : off ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} /> : <PulseDot color={C.green} size={7} />}
                  {lv.phase === 'live' && !picked ? (
                    <><T v="micro" color={C.bone} numberOfLines={1}>LIVE</T><T v="micro" mono color={C.bone2} tabular numberOfLines={1}>{elapsedText(Date.now() - (lv.since ?? Date.now()))}</T></>
                  ) : <T v="micro" color={C.bone} numberOfLines={1} style={{ flexShrink: 1 }}>{picked ? `${picked.t} · tap for the latest` : lv.phase === 'connecting' ? 'Connecting…' : off ? 'Offline' : 'Latest picture'}</T>}
                </View>
              </View>
              {lv.phase === 'live' && !picked ? (
                <Press onPress={toggleSound} label={muted ? 'Sound off. Turn the sound on' : 'Sound on. Turn the sound off'} hitSlop={4}
                  style={{ position: 'absolute', top: SP[2] + 2, right: SP[2] + 2, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(14,15,16,0.78)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={muted ? 'volume_off' : 'volume_up'} size={21} color={C.bone} />
                </Press>
              ) : null}
            </View>
          </Press>
        </Appear>
        {lv.phase === 'error' ? (
          <Notice icon="videocam_off" color={C.amber} eyebrow="Live video" title={CANT_STREAM} text={lv.reason}>
            <NoticeAction main label="Try again" onPress={watch} a11y="Try live video again" />
            <NoticeAction label="Not now" onPress={() => session.stop()} />
          </Notice>
        ) : sup && !sup.can ? (
          <Notice compact icon="videocam_off" color={sup.offline ? C.red : C.blue} title={sup.offline ? 'Offline' : 'No live video'} text={sup.why} />
        ) : null}
        {can && lv.phase !== 'error' ? (
          <View style={{ flexDirection: 'row', gap: SP[2] }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {playing ? <Button full icon="stop" label="Stop" kind="secondary" onPress={() => session.stop()} /> : <Button full icon="videocam" label="Watch live" onPress={watch} />}
            </View>
            <IconButton icon="tune" label="Room and alerts" size={48} onPress={() => sheet.open(id)} />
          </View>
        ) : <Button full kind="secondary" icon="tune" label="Room and alerts" onPress={() => sheet.open(id)} />}
      </View>

      <Group>
        <Row first icon={off ? 'videocam_off' : 'videocam'} iconFg={off ? C.red : fg} title={st} sub={line !== st ? line : undefined} />
        <Row icon="meeting_room" iconFg={C.bone} title={roomName} sub={around || 'Nothing seen in the room yet'} />
      </Group>

      <Section title="What it saw" gap={SP[3]}>
        <Segmented compact label="Show" value={scope} options={[{ id: 'camera', label: 'This camera' }, { id: 'room', label: 'Whole room' }]} onChange={v => setScope(v as 'camera' | 'room')} />
        {rows.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {rows.map((a, i) => (
              <Appear key={a.key} index={i}>
                <Press onPress={a.frame ? () => { session.stop(); setPicked({ uri: frameUri(a.frame!)!, t: a.t }); } : undefined} disabled={!a.frame} give="soft" label={`${a.what}, ${a.where}, ${a.t}`}
                  style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, alignItems: 'center' }}>
                  <View style={{ width: 72, height: 41, borderRadius: R.sm, overflow: 'hidden', backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={a.icon} size={18} color={a.color} />
                    {a.frame && cfg ? <Image source={{ uri: frameUri(a.frame)! }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={150} /> : null}
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T v="callout" weight={600} color={C.bone} numberOfLines={2}>{a.what}</T>
                    <T v="footnote" color={C.stone} numberOfLines={1}>{a.where}</T>
                  </View>
                  <T mono size={11.5} color={C.stone2}>{a.t}</T>
                </Press>
              </Appear>
            ))}
          </Card>
        ) : <Empty compact icon="videocam" title={events ? 'Nothing seen yet' : 'Looking…'} text="People, rings and motion show up here, with the picture from that moment." />}
      </Section>
    </Screen>
  );
}
