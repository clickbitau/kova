// One camera: its latest picture (refreshing every few seconds), state, and what it has seen lately.
// "Watch live" hands off to the hub's WebRTC page until a native build carries WebRTC.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { hubUrl } from '../logic/connect';
import { stateOf, devs } from '../logic/devices';
import type { Stack } from '../navigation';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { Card, Empty, Press, PulseDot, Section } from '../ui/kit';
import { Appear } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { CameraStill } from './SecurityScreen';

export function CameraScreen({ route }: NativeStackScreenProps<Stack, 'Camera'>) {
  const { id } = route.params;
  const s = useSnap();
  const { cfg } = useHub();
  const nav = useNav();
  const d = devs(s)[id];
  // Stills change when the camera sees something: re-ask every few seconds while open.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 5_000); return () => clearInterval(t); }, []);
  if (!d) return <Screen title="Camera"><Empty icon="videocam" title="Camera gone" text="It isn’t on the hub anymore." /></Screen>;

  const [st, fg] = stateOf(d);
  const off = d.online === false;
  const line = d.why?.now && !/No change/.test(d.why.now) ? d.why.now : st;
  const seen = s.activity.filter(a => a.device === id).slice(0, 10);
  const snapUri = cfg ? `${hubUrl(cfg, `/api/devices/${encodeURIComponent(id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}` : null;
  const watch = () => nav.navigate('Web', { title: d.name, path: `/phone.html?embed=1&cam=${encodeURIComponent(id)}` });

  return (
    <Screen title={d.name} over={d.integration ?? 'Camera'}>
      <Appear index={0}>
        <Press onPress={watch} give="soft" label={`${d.name}, ${line}. Watch live`} disabled={off}>
          <Card style={{ overflow: 'hidden' }}>
            <View style={{ aspectRatio: 16 / 9, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
              <CameraStill uri={snapUri} off={off} label={`${d.name} latest picture`} />
              <View style={{ position: 'absolute', left: SP[2] + 2, top: SP[2] + 2, flexDirection: 'row', alignItems: 'center', gap: 6, height: 24, paddingHorizontal: 9, borderRadius: R.full, backgroundColor: 'rgba(14,15,16,0.72)' }}>
                {off ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} /> : <PulseDot color={C.green} size={7} />}
                <T v="micro" color={C.bone}>{off ? 'Offline' : 'Watch live'}</T>
              </View>
            </View>
            <View style={{ paddingVertical: SP[3], paddingHorizontal: SP[3] + 2, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                <Icon name={off ? 'videocam_off' : 'videocam'} size={17} color={fg} />
                <T v="headline" style={{ flex: 1 }} numberOfLines={1}>{st}</T>
              </View>
              {line !== st ? <T v="footnote" color={C.stone} numberOfLines={1}>{line}</T> : null}
            </View>
          </Card>
        </Press>
      </Appear>

      <Section title="Lately" gap={SP[1]}>
        {seen.length ? seen.map((a, i) => (
          <Appear key={a.id} index={i} style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, alignItems: 'center' }}>
            <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: C.greenTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={a.icon || 'videocam'} size={18} color={C.green} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="callout" weight={600} color={C.bone}>{a.what}</T>
              {a.why ? <T v="footnote" color={C.stone}>{a.why}</T> : null}
            </View>
            <T mono size={11.5} color={C.stone2}>{a.t}</T>
          </Appear>
        )) : <Empty compact icon="videocam" title="Nothing seen yet" text="What this camera notices today — people, rings, cars — shows up here." />}
      </Section>
    </Screen>
  );
}
