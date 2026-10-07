import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import type { Finding } from '../api/types';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { automationsOf } from '../logic/automations';
import { evidenceLabel, findingCall, findingTag, findingToast, whyQuestion } from '../logic/learning';
import { Icon } from '../ui/Icon';
import { Button, Card, Press, Tag } from '../ui/kit';
import { T } from '../ui/Text';
import { animateLayout } from '../ui/motion';

/**
 * One finding: a mode's check, or something Kova learned from what people do. Learned ones show the days they're
 * based on, other ways to apply them, "Not now" (back in a week), "Don't suggest again", and "Why?" (Ask Kova).
 * Worth a look on Modes, and an automation's own screen (`tag` off there: it's that automation).
 */
export function FindingCard({ f, tag = true, onApplied }: { f: Finding; tag?: boolean; onApplied?: () => void }) {
  const s = useSnap();
  const { act } = useHub();
  const nav = useNav();
  const { fontScale } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const t = findingTag(f, { modes: s.modes, automations: automationsOf(s) });
  const fg = f.tone === 'alert' ? C.red : C.amber;
  const mode = s.modes.find(m => m.id === f.modeId);
  const call = async (what: 'fix' | 'alt' | 'never', id?: string, done?: string) => {
    const ok = await act('POST', findingCall(f, what, id), {}, done ?? findingToast(f, what, mode?.name));
    if (ok && what === 'fix') onApplied?.();
    return ok;
  };
  const ev = f.evidence ?? [];
  return (
    <Card style={{ padding: SP[4], gap: SP[2] + 2, borderLeftWidth: 3, borderLeftColor: fg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Icon name={f.icon} size={17} color={fg} />
        <T v="eyebrow" color={fg} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 }}>{f.kind}</T>
        {tag && t ? <Tag text={t.text} color={t.color ?? C.amber} /> : null}
      </View>
      <T v="headline">{f.title}</T>
      <T v="footnote" color={C.stone}>{f.body}</T>
      {ev.length ? (
        <Press onPress={() => { animateLayout(); setOpen(!open); }} label={evidenceLabel(ev.length, open)} selected={open}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 36 }}>
          <Icon name={open ? 'expand_less' : 'expand_more'} size={18} color={C.amber} />
          <T v="labelSm" color={C.amber}>{evidenceLabel(ev.length, open)}</T>
        </Press>
      ) : null}
      {open ? (
        <View style={{ gap: 6, padding: SP[3], borderRadius: R.sm, backgroundColor: C.inset }}>
          {ev.map((e, i) => (
            <View key={`${e.day}${i}`} style={{ flexDirection: 'row', gap: SP[2] }}>
              <T v="footnote" weight={600} color={C.stone2} style={{ width: 74 * Math.min(fontScale, 1.6) }}>{e.day}</T>
              <T v="footnote" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{e.text}</T>
            </View>
          ))}
        </View>
      ) : null}
      {(f.more ?? []).map(o => (
        <View key={o.id} style={{ gap: SP[2], padding: SP[3], borderRadius: R.sm, borderWidth: 1, borderColor: C.edge }}>
          <T v="footnote" color={C.stone}>{`Or: ${o.body}`}</T>
          <Button size="sm" kind="secondary" label={o.fix} onPress={() => call('fix', o.id, o.done)} />
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: SP[2], marginTop: SP[1], flexWrap: 'wrap' }}>
        <Button size="sm" label={f.fix} onPress={() => call('fix')} />
        <Button size="sm" kind="secondary" label={f.learned ? f.alt : 'Keep as is'} onPress={() => call('alt')} />
        {f.never ? <Button size="sm" kind="ghost" label={f.never} onPress={() => call('never')} /> : null}
        {f.learned ? <Button size="sm" kind="ghost" icon="help" label="Why?" onPress={() => nav.navigate('Tabs', { screen: 'Ask', params: { ask: whyQuestion(f), at: Date.now() } } as never)} /> : null}
      </View>
    </Card>
  );
}
