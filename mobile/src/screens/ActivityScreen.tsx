import { useState } from 'react';
import { View } from 'react-native';
import { C } from '../theme';
import { useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { HScroll, PageHead, Pill } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

const AS: Record<string, [string, string]> = { auto: ['rgba(242,177,76,0.13)', C.amber], people: ['rgba(127,212,160,0.14)', C.green], device: ['rgba(124,184,240,0.13)', C.blue], system: [C.control, C.stone] };
const FILTERS: [string, string][] = [['all', 'All'], ['auto', 'Modes'], ['people', 'People'], ['device', 'Devices']];

export function ActivityScreen() {
  const s = useSnap();
  const nav = useNav();
  const [f, setF] = useState('all');
  const rows = s.activity.filter(a => f === 'all' || a.type === f);
  return (
    <Screen gap={16}>
      <PageHead over="Everything that happened, and why" title="Activity" onBack={() => nav.goBack()} />
      <HScroll>{FILTERS.map(([id, label]) => <Pill key={id} label={label} on={f === id} onPress={() => setF(id)} />)}</HScroll>
      <View>
        {rows.map(a => {
          const [bg, fg] = AS[a.type] ?? AS.system;
          return (
            <View key={a.id} style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.hairline }}>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={a.icon} size={18} color={fg} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={13.5} weight={600}>{a.what}</T>
                {a.why ? <T size={12} color={C.stone}>{a.why}</T> : null}
              </View>
              <T mono size={11.5} color={C.stone}>{a.t}</T>
            </View>
          );
        })}
        {!rows.length ? <T size={13} color={C.stone}>Nothing here yet.</T> : null}
      </View>
    </Screen>
  );
}
