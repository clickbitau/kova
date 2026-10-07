import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import type { ModeView } from '../api/types';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, Group, IconWell, Press, Row, Section, Tag } from '../ui/kit';
import { automationsOf } from '../logic/automations';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, animateLayout, spring } from '../ui/motion';

const DAY = { ok: '', problem: C.red, skipped: '#26272b', none: C.inset } as const;

/** The 14 days a mode was replayed on, as squares, with what the colours mean. */
function Days({ m }: { m: ModeView }) {
  const n = { ok: 0, problem: 0, skipped: 0, none: 0 };
  m.test.days.forEach(d => { n[d]++; });
  return (
    <View style={{ gap: SP[2] }} accessible accessibilityLabel={`Last 14 days: ${n.ok} ran fine, ${n.problem} with a problem, ${n.skipped} skipped. ${m.test.text}`}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {m.test.days.map((d, i) => <View key={i} style={{ flex: 1, aspectRatio: 1, borderRadius: 4, backgroundColor: d === 'ok' ? alpha(m.color, 0.85) : DAY[d] }} />)}
      </View>
      <View style={{ flexDirection: 'row', gap: SP[3], flexWrap: 'wrap' }}>
        {([['ok', alpha(m.color, 0.85), 'Ran fine'], ['problem', C.red, 'A problem'], ['skipped', '#3a3b40', 'Skipped']] as const).map(([k, c, l]) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: c }} />
            <T v="micro" color={C.stone}>{l}</T>
          </View>
        ))}
      </View>
      <T v="footnote" color={C.stone}>{m.test.text}</T>
    </View>
  );
}

/** A mode: icon, name and hours; tap to open what it does and how it did. The chevron turns as it opens. */
function ModeCard({ m, now, open, onToggle, onEdit, index }: { m: ModeView; now: boolean; open: boolean; onToggle: () => void; onEdit: () => void; index: number }) {
  const rot = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => { spring(rot, open ? 1 : 0, 'toggle').start(); }, [open, rot]);
  const chips = m.groups.flatMap(g => g.chips.map(c => ({ room: g.room, c })));
  return (
    <Appear index={index}>
      <Card tint={open ? m.color : undefined} style={{ overflow: 'hidden', backgroundColor: open ? alpha(m.color, 0.06) : C.card }}>
        <Press onPress={onToggle} give="soft" label={`${m.name}, ${m.startLabel} to ${m.endLabel}${now ? ', now' : ''}`} hint={open ? 'Collapse' : 'Show what it does'}
          style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3] + 2, paddingHorizontal: SP[4] }}>
          <IconWell icon={m.icon} color={m.color} fill size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
              <T v="headline" size={16}>{m.name}</T>
              {now ? <Tag text="NOW" color={m.color} solid /> : null}
            </View>
            <T v="footnote" color={C.stone}>{`${m.startLabel} → ${m.endLabel}`}</T>
          </View>
          <Animated.View style={{ transform: [{ rotate: rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}>
            <Icon name="expand_more" size={22} color={C.stone} />
          </Animated.View>
        </Press>
        {open ? (
          <View style={{ paddingHorizontal: SP[4], paddingBottom: SP[4], gap: SP[4] }}>
            <View style={{ gap: SP[2] }}>
              <T v="eyebrow" color={C.stone2}>How the home should be</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {chips.length ? chips.map(({ room, c }) => (
                  <View key={`${room}${c}`} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: R.sm, backgroundColor: C.inset, borderWidth: 1, borderColor: C.edge }}>
                    <T v="footnote" weight={600} color={C.bone}><T v="footnote" weight={600} color={C.stone}>{`${room} · `}</T>{c}</T>
                  </View>
                )) : <T v="footnote" color={C.stone}>Nothing changes</T>}
              </View>
            </View>
            <View style={{ gap: SP[2] }}>
              <T v="eyebrow" color={C.stone2}>Tested on the last 14 days</T>
              <Days m={m} />
            </View>
            <Button size="sm" kind="secondary" icon="edit" label="Edit mode" onPress={onEdit} />
          </View>
        ) : null}
      </Card>
    </Appear>
  );
}

/** Findings with one-tap fixes, then the day's modes; open one to see what it does and how it did on the last 14 days. */
export function ModesScreen() {
  const s = useSnap();
  const autos = automationsOf(s);
  const { act } = useHub();
  const nav = useNav();
  const [open, setOpen] = useState(s.current.modeId);
  const modeById = (id: string) => s.modes.find(m => m.id === id);
  return (
    <Screen title="Modes" over="How your home behaves through the day" onBack={() => nav.goBack()}>
      {s.findings.length ? (
        <Section title="Worth a look" gap={SP[2] + 2}>
          {s.findings.map((f, i) => {
            const m = modeById(f.modeId);
            const fg = f.tone === 'alert' ? C.red : C.amber;
            return (
              <Appear key={f.id} index={i}>
                <Card style={{ padding: SP[4], gap: SP[2] + 2, borderLeftWidth: 3, borderLeftColor: fg }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name={f.icon} size={17} color={fg} />
                    <T v="eyebrow" color={fg} style={{ flex: 1 }}>{f.kind}</T>
                    {m ? <Tag text={m.name} color={m.color} /> : null}
                  </View>
                  <T v="headline">{f.title}</T>
                  <T v="footnote" color={C.stone}>{f.body}</T>
                  <View style={{ flexDirection: 'row', gap: SP[2], marginTop: SP[1], flexWrap: 'wrap' }}>
                    <Button size="sm" label={f.fix} onPress={() => act('POST', `/api/findings/${encodeURIComponent(f.id)}/fix`, {}, f.done ?? `${m?.name ?? 'Mode'} updated`)} />
                    <Button size="sm" kind="secondary" label="Keep as is" onPress={() => act('POST', `/api/findings/${encodeURIComponent(f.id)}/dismiss`, {}, 'Kept as is')} />
                  </View>
                </Card>
              </Appear>
            );
          })}
        </Section>
      ) : null}
      <Section title="Through the day" action="New mode" onAction={() => nav.navigate('ModeEditor')} gap={SP[2] + 2}>
        {s.modes.map((m, i) => (
          <ModeCard key={m.id} m={m} index={i} now={m.id === s.current.modeId} open={open === m.id}
            onToggle={() => { animateLayout(); setOpen(open === m.id ? '' : m.id); }}
            onEdit={() => nav.navigate('ModeEditor', { id: m.id })} />
        ))}
      </Section>
      <Section title="On top" action="New overlay" onAction={() => nav.navigate('OverlayEditor')} gap={SP[2]}>
        <T v="footnote" color={C.stone} style={{ paddingHorizontal: 4 }}>For a while, over whatever mode it is: a film, guests, everyone away.</T>
        {s.overlays.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.overlays.map((o, i) => {
              const on = s.current.overlay?.id === o.id;
              return (
                <Row key={o.id} first={!i} icon={o.icon} iconFg={on ? C.amber : C.bone} fill={on} title={o.name} sub={on ? `On now · ${o.endsLabel}` : o.endsLabel} subColor={on ? C.amber : C.stone}
                  onPress={() => nav.navigate('OverlayEditor', { id: o.id })}
                  right={<Button size="sm" kind={on ? 'secondary' : 'ghost'} icon={on ? 'stop' : 'play_arrow'} label={on ? 'End' : 'Start'}
                    onPress={() => on ? act('POST', '/api/overlays/end', {}, `${o.name} ended`) : act('POST', `/api/overlays/${encodeURIComponent(o.id)}/start`, {}, `${o.name} is on`)} />} />
              );
            })}
          </Card>
        ) : <Empty compact icon="layers" title="No overlays" text="Make one for a film night or for when everyone’s away." action="New overlay" onAction={() => nav.navigate('OverlayEditor')} />}
      </Section>
      <Section title="Moments" action="New moment" onAction={() => nav.navigate('MomentEditor')} gap={SP[2]}>
        {(s.moments ?? []).length ? (
          <Card style={{ overflow: 'hidden' }}>
            {(s.moments ?? []).map((m, i) => (
              <Row key={m.id} first={!i} icon="schedule" iconFg={C.amber} title={m.label} sub={[m.atLabel, m.what].filter(Boolean).join(' · ')} onPress={() => nav.navigate('MomentEditor', { id: m.id })} />
            ))}
          </Card>
        ) : <Empty compact icon="schedule" title="No moments" text="A one-off at a time of day, like rain sounds at 21:00." action="New moment" onAction={() => nav.navigate('MomentEditor')} />}
      </Section>
      <Group title="Alongside your modes">
        <Row first icon="account_tree" iconFg={C.amber} title="Automations" sub={autos.length ? `${autos.length} · ${autos.filter(a => a.enabled).length} on` : 'When something happens, do something'} onPress={() => nav.navigate('Automations')} />
      </Group>
    </Screen>
  );
}
