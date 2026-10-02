import { useState } from 'react';
import { View } from 'react-native';
import { C, SP, alpha } from '../theme';
import { useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { Empty, Segmented } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear } from '../ui/motion';

const AS: Record<string, string> = { auto: C.amber, people: C.green, device: C.blue, system: C.stone };
const FILTERS = [{ id: 'all', label: 'All' }, { id: 'auto', label: 'Modes' }, { id: 'people', label: 'People' }, { id: 'device', label: 'Devices' }];
const EMPTY: Record<string, string> = { all: 'Nothing has happened yet today.', auto: 'No mode has changed anything yet.', people: 'Nobody has come or gone yet.', device: 'No device has changed yet.' };

/** Everything that happened, newest first, on a line: what, why, when; filter by who did it. */
export function ActivityScreen() {
  const s = useSnap();
  const nav = useNav();
  const [f, setF] = useState('all');
  const rows = s.activity.filter(a => f === 'all' || a.type === f);
  return (
    <Screen title="Activity" over="Everything that happened, and why" onBack={() => nav.goBack()} gap={SP[5]}>
      <Segmented compact label="Show" value={f} options={FILTERS} onChange={setF} />
      <View>
        {rows.map((a, i) => {
          const fg = AS[a.type] ?? AS.system;
          const last = i === rows.length - 1;
          return (
            <Appear key={a.id} index={i} style={{ flexDirection: 'row', gap: SP[3] }}>
              <View style={{ alignItems: 'center', width: 34 }}>
                <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: alpha(fg, 0.14), alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={a.icon} size={18} color={fg} />
                </View>
                {!last ? <View style={{ flex: 1, width: 2, borderRadius: 1, marginVertical: 4, backgroundColor: C.hairline }} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2, paddingTop: 6, paddingBottom: last ? 0 : SP[4] }}>
                <View style={{ flexDirection: 'row', gap: SP[2] }}>
                  <T v="callout" weight={600} color={C.bone} style={{ flex: 1 }}>{a.what}</T>
                  <T mono size={11.5} color={C.stone2} style={{ paddingTop: 2 }}>{a.t}</T>
                </View>
                {a.why ? <T v="footnote" color={C.stone}>{a.why}</T> : null}
              </View>
            </Appear>
          );
        })}
        {!rows.length ? <Empty icon="history" title="Nothing here yet" text={EMPTY[f]} /> : null}
      </View>
    </Screen>
  );
}
