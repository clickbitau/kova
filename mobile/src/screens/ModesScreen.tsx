import { useState } from 'react';
import { View } from 'react-native';
import { C, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { Icon } from '../ui/Icon';
import { PageHead, Press } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { animateLayout } from '../ui/motion';

const DAY = { ok: '', problem: '#ff6b5e', skipped: '#26272b', none: '#1c1d20' } as const;

/** Findings with one-tap fixes, then the day's modes; open one to see what it does and how it did on the last 14 days. */
export function ModesScreen() {
  const s = useSnap();
  const { act } = useHub();
  const nav = useNav();
  const [open, setOpen] = useState(s.current.modeId);
  const modeById = (id: string) => s.modes.find(m => m.id === id);
  return (
    <Screen gap={16}>
      <PageHead over="How your home behaves through the day" title="Modes" onBack={() => nav.goBack()} />
      {s.findings.map(f => {
        const m = modeById(f.modeId);
        const fg = f.tone === 'alert' ? C.red : C.amber;
        return (
          <View key={f.id} style={{ borderRadius: 16, padding: 14, backgroundColor: C.card, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name={f.icon} size={17} color={fg} />
              <T size={11} weight={700} color={fg} upper tracking={0.06} style={{ flex: 1 }}>{f.kind}</T>
              {m ? <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: alpha(m.color, 0.14) }}><T size={11} weight={700} color={m.color}>{m.name}</T></View> : null}
            </View>
            <T size={14} weight={700} lineHeight={1.35}>{f.title}</T>
            <T size={12.5} color={C.stone} lineHeight={1.45}>{f.body}</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Press onPress={() => void act('POST', `/api/findings/${encodeURIComponent(f.id)}/fix`, {}, f.done ?? `${m?.name ?? 'Mode'} updated`)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 9, backgroundColor: C.amber }}>
                <T size={12} weight={700} color={C.onAmber}>{f.fix}</T>
              </Press>
              <Press onPress={() => void act('POST', `/api/findings/${encodeURIComponent(f.id)}/dismiss`, {}, 'Kept as is')} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.06)' }}>
                <T size={12} weight={600}>Later</T>
              </Press>
            </View>
          </View>
        );
      })}
      <View style={{ gap: 8 }}>
        {s.modes.map(m => {
          const isOpen = open === m.id, now = m.id === s.current.modeId;
          const chips = m.groups.flatMap(g => g.chips.map(c => `${g.room}: ${c}`));
          return (
            <Press key={m.id} onPress={() => { animateLayout(); setOpen(isOpen ? '' : m.id); }} style={{ borderRadius: 18, overflow: 'hidden', backgroundColor: C.card, borderWidth: 1, borderColor: isOpen ? alpha(m.color, 0.4) : 'rgba(255,255,255,0.04)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: alpha(m.color, 0.14), alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={m.icon} size={21} color={m.color} fill />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={15} weight={700}>{m.name}</T>
                  <T size={12} color={C.stone}>{`${m.startLabel} → ${m.endLabel}`}</T>
                </View>
                {now ? <View style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: m.color }}><T size={10.5} weight={800} color={C.coal}>NOW</T></View> : null}
              </View>
              {isOpen ? (
                <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {(chips.length ? chips : ['Nothing changes']).map(c => (
                      <View key={c} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9, backgroundColor: C.inset }}><T size={12.5} weight={600}>{c}</T></View>
                    ))}
                  </View>
                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                      {m.test.days.map((d, i) => <View key={i} style={{ flex: 1, aspectRatio: 1, borderRadius: 4, backgroundColor: d === 'ok' ? alpha(m.color, 0.8) : DAY[d] }} />)}
                    </View>
                    <T size={12} color={C.stone} lineHeight={1.45}>{m.test.text}</T>
                  </View>
                  <Press onPress={() => nav.navigate('Web', { title: `Edit ${m.name}`, path: '/phone.html?embed=1&page=modes' })} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: C.control2, alignSelf: 'flex-start' }}>
                    <Icon name="edit" size={17} />
                    <T size={12.5} weight={700}>Edit mode</T>
                  </Press>
                </View>
              ) : null}
            </Press>
          );
        })}
      </View>
    </Screen>
  );
}
