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
import { Button, Card, Empty } from '../ui/kit';
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
  const seen = s.activity.filter(a => a.device === id).slice(0, 10);
  const snapUri = cfg ? `${hubUrl(cfg, `/api/devices/${encodeURIComponent(id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}` : null;

  return (
    <Screen title={d.name} over={d.integration ?? 'Camera'}>
      <View style={{ borderRadius: R.lg, overflow: 'hidden', aspectRatio: 16 / 9, backgroundColor: C.inset }}>
        <CameraStill uri={snapUri} off={d.online === false} label={`${d.name} latest picture`} />
      </View>
      <Card style={{ padding: SP[4], gap: SP[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
          <Icon name={d.online === false ? 'videocam_off' : 'videocam'} size={22} color={fg} />
          <View style={{ flex: 1 }}>
            <T v="headline">{st}</T>
            {d.why?.now ? <T v="footnote" color={C.stone}>{d.why.now}</T> : null}
          </View>
        </View>
        <Button full icon="play_circle" label="Watch live" onPress={() => nav.navigate('Web', { title: d.name, path: `/phone.html?embed=1&cam=${encodeURIComponent(id)}` })} />
      </Card>
      <Card style={{ overflow: 'hidden' }}>
        <View style={{ padding: SP[4], paddingBottom: SP[2] }}><T v="headline">Lately</T></View>
        {seen.length ? seen.map((a, i) => (
          <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
            <Icon name={a.icon || 'history'} size={18} color={C.stone} />
            <View style={{ flex: 1, gap: 1 }}>
              <T v="body">{a.what}</T>
              <T v="footnote" color={C.stone}>{[a.t, a.why].filter(Boolean).join(' · ')}</T>
            </View>
          </View>
        )) : <View style={{ padding: SP[4], paddingTop: 0 }}><T v="footnote" color={C.stone}>Nothing from this camera yet today.</T></View>}
      </Card>
    </Screen>
  );
}
