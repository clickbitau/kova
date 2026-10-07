// One camera: its latest picture (refreshing every few seconds), its room, and what it (or its room) saw, each
// event with the picture kept from that moment. Tap an event to look at its picture; tune for room and alerts.
// "Watch live" hands off to the hub's WebRTC page until a native build carries WebRTC.
import { useEffect, useState } from 'react';
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
import { Card, Empty, IconButton, Press, PulseDot, Section, Segmented } from '../ui/kit';
import { Appear } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { CameraStill } from './SecurityScreen';

export function CameraScreen({ route }: NativeStackScreenProps<Stack, 'Camera'>) {
  const { id } = route.params;
  const s = useSnap();
  const { cfg, api } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const d = devs(s)[id];
  const [scope, setScope] = useState<'camera' | 'room'>('camera');
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [picked, setPicked] = useState<{ uri: string; t: string } | null>(null);
  // Stills change when the camera sees something: re-ask every few seconds while open.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 5_000); return () => clearInterval(t); }, []);
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
  const watch = () => nav.navigate('Web', { title: d.name, path: `/phone.html?embed=1&cam=${encodeURIComponent(id)}` });
  const rows = timelineRows(events ?? []);
  const frameUri = (p: string) => cfg ? hubUrl(cfg, p, true) : null;

  return (
    <Screen title={d.name} over={`${roomName}${outdoor == null ? '' : outdoor ? ' · outside' : ' · inside'}`} onBack={() => nav.goBack()}
      right={<IconButton icon="tune" label="Room and alerts" onPress={() => sheet.open(id)} />}>
      <Appear index={0}>
        <Press onPress={picked ? () => setPicked(null) : watch} give="soft" label={picked ? `Picture from ${picked.t}. Back to the latest` : `${d.name}, ${line}. Watch live`} disabled={off && !picked}>
          <Card style={{ overflow: 'hidden' }}>
            <View style={{ aspectRatio: 16 / 9, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
              {picked ? <Image source={{ uri: picked.uri }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={200} accessibilityLabel={`${d.name} at ${picked.t}`} />
                : <CameraStill uri={snapUri} off={off} label={`${d.name} latest picture`} />}
              <View style={{ position: 'absolute', left: SP[2] + 2, top: SP[2] + 2, flexDirection: 'row', alignItems: 'center', gap: 6, height: 24, paddingHorizontal: 9, borderRadius: R.full, backgroundColor: 'rgba(14,15,16,0.72)' }}>
                {picked ? <Icon name="history" size={14} color={C.bone} /> : off ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} /> : <PulseDot color={C.green} size={7} />}
                <T v="micro" color={C.bone}>{picked ? `${picked.t} · tap for the latest` : off ? 'Offline' : 'Watch live'}</T>
              </View>
            </View>
            <View style={{ paddingVertical: SP[3], paddingHorizontal: SP[3] + 2, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                <Icon name={off ? 'videocam_off' : 'videocam'} size={17} color={fg} />
                <T v="headline" style={{ flex: 1 }} numberOfLines={1}>{st}</T>
              </View>
              {line !== st ? <T v="footnote" color={C.stone} numberOfLines={1}>{line}</T> : null}
              {roomLine(s.roomStatus?.[d.room]) ? <T v="footnote" color={C.stone2} numberOfLines={1}>{`${roomName}: ${roomLine(s.roomStatus?.[d.room])}`}</T> : null}
            </View>
          </Card>
        </Press>
      </Appear>

      <Section title="What it saw" gap={SP[2]}>
        <Segmented compact label="Show" value={scope} options={[{ id: 'camera', label: 'This camera' }, { id: 'room', label: `All of ${roomName}` }]} onChange={v => setScope(v as 'camera' | 'room')} />
        {rows.length ? rows.map((a, i) => (
          <Appear key={a.key} index={i}>
            <Press onPress={a.frame ? () => setPicked({ uri: frameUri(a.frame!)!, t: a.t }) : undefined} disabled={!a.frame} label={`${a.what}, ${a.where}, ${a.t}`}
              style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[2] + 2, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, alignItems: 'center' }}>
              <View style={{ width: 72, height: 41, borderRadius: R.sm, overflow: 'hidden', backgroundColor: C.greenTint, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={a.icon} size={18} color={a.color} />
                {a.frame && cfg ? <Image source={{ uri: frameUri(a.frame)! }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={150} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T v="callout" weight={600} color={C.bone}>{a.what}</T>
                <T v="footnote" color={C.stone}>{a.where}</T>
              </View>
              <T mono size={11.5} color={C.stone2}>{a.t}</T>
            </Press>
          </Appear>
        )) : <Empty compact icon="videocam" title={events ? 'Nothing seen yet' : 'Looking…'} text="People, rings and motion show up here, with the picture from that moment." />}
      </Section>
    </Screen>
  );
}
