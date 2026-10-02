import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { C, F } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { HubError } from '../api/client';
import {
  EXAMPLES, automationsOf, draftOf, filterAutomations, haState, haText, ideasOf, lastRunLine, runMessage, startRun, summary, withPending,
  type AutomationView, type RunAnswer, type HaAutomation, type Idea,
} from '../logic/automations';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, PageHead, Press, Sheet, Switch } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, animateLayout, haptic } from '../ui/motion';
import { Confirm } from './AutomationEditor';

// Automations: the home's own rules, each in words (When / Only if / Then) with an on/off switch and how its last
// run went; Kova's suggestions above, Home Assistant ones to convert below. Live from the hub's snapshot.

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Line({ k, text, colour = C.bone2 }: { k: string; text: string; colour?: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <T size={11} weight={800} color={C.stone2} upper tracking={0.05} style={{ width: 52, paddingTop: 2 }}>{k}</T>
      <T size={13} color={colour} lineHeight={1.4} style={{ flex: 1 }}>{text}</T>
    </View>
  );
}

function SmallButton({ icon, label, onPress, tone = 'plain' }: { icon?: string; label: string; onPress: () => void; tone?: 'plain' | 'amber' }) {
  const bg = tone === 'amber' ? C.amber : C.control2, fg = tone === 'amber' ? C.onAmber : C.bone;
  return (
    <Press onPress={onPress} label={label} style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: bg }}>
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <T size={12.5} weight={700} color={fg}>{label}</T>
    </Press>
  );
}

function AutomationCard({ a, index, onToggle, onRun, onMore, onOpen }: { a: AutomationView; index: number; onToggle: (v: boolean) => void; onRun: () => void; onMore: () => void; onOpen: () => void }) {
  const w = summary(a);
  const [last, colour] = lastRunLine(a.lastRun);
  return (
    <Appear index={index}>
      <Press onPress={onOpen} label={`Edit ${a.name}`} style={{ borderRadius: 18, backgroundColor: C.card, padding: 14, gap: 10, borderWidth: 1, borderColor: a.enabled ? 'rgba(255,255,255,0.04)' : 'transparent' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: a.enabled ? 1 : 0.6 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <T size={15.5} weight={700} numberOfLines={2}>{a.name}</T>
            {a.description ? <T size={12} color={C.stone} numberOfLines={2}>{a.description}</T> : null}
          </View>
          {a.running > 0 && a.lastRun?.result !== 'running' ? <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: C.amberTint }}><T size={11} weight={800} color={C.amber}>Running</T></View> : null}
          {a.origin ? <View style={{ paddingVertical: 2, paddingHorizontal: 7, borderRadius: 999, backgroundColor: C.control }}><T size={10.5} weight={700} color={C.stone}>From HA</T></View> : null}
        </View>
        <View style={{ gap: 5, opacity: a.enabled ? 1 : 0.6 }}>
          <Line k="When" text={w.when} />
          {w.onlyIf ? <Line k="Only if" text={w.onlyIf} /> : null}
          <Line k="Then" text={w.then} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
          <T size={12} weight={600} color={colour} style={{ flex: 1 }} numberOfLines={2}>{last}</T>
          <Switch on={a.enabled} onChange={onToggle} label={`${a.name} on`} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SmallButton icon="play_arrow" label="Run now" onPress={onRun} />
          <SmallButton icon="edit" label="Edit" onPress={onOpen} />
          <View style={{ flex: 1 }} />
          <Press onPress={onMore} label={`More for ${a.name}`} style={{ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
            <Icon name="more_horiz" size={20} />
          </Press>
        </View>
      </Press>
    </Appear>
  );
}

function IdeaCard({ i, onAdd, onChange, onDismiss }: { i: Idea; onAdd: () => void; onChange: () => void; onDismiss: () => void }) {
  const w = summary(i);
  return (
    <Appear style={{ borderRadius: 18, padding: 14, gap: 10, backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="auto_awesome" size={16} color={C.amber} />
        <T size={11} weight={800} color={C.amber} upper tracking={0.06}>Suggested</T>
      </View>
      <T size={15} weight={700}>{i.name}</T>
      <View style={{ gap: 5 }}>
        <Line k="When" text={w.when} />
        {w.onlyIf ? <Line k="Only if" text={w.onlyIf} /> : null}
        <Line k="Then" text={w.then} />
      </View>
      {i.why ? <T size={12.5} color={C.stone} lineHeight={1.4}>{i.why}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <SmallButton tone="amber" icon="add" label="Add" onPress={onAdd} />
        <SmallButton icon="edit" label="Change first" onPress={onChange} />
        <SmallButton label="Not now" onPress={onDismiss} />
      </View>
    </Appear>
  );
}

function HaSection({ list, onConvert }: { list: HaAutomation[]; onConvert: (ids: string[] | null) => void }) {
  const [all, setAll] = useState(false);
  const left = list.filter(a => haState(a).canConvert).length;
  const shown = all ? list : list.slice(0, 5);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={17} weight={700} accessibilityRole="header">From Home Assistant</T>
          <T size={12} color={C.stone}>{`${plural(list.length, 'automation')}${left ? ` · ${left} can convert` : ''}. Converted ones start switched off.`}</T>
        </View>
        {left ? <SmallButton tone="amber" label={`Convert ${left}`} onPress={() => onConvert(null)} /> : null}
      </View>
      <Card style={{ overflow: 'hidden' }}>
        {shown.map((a, i) => {
          const st = haState(a);
          return (
            <View key={a.id} style={{ padding: 14, gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={14} weight={700}>{a.name}</T>
                  <T size={12} color={C.stone} numberOfLines={2}>{haText(a)}</T>
                </View>
                {st.canConvert ? <SmallButton label="Convert" onPress={() => onConvert([a.id])} /> : null}
              </View>
              <T size={12} weight={600} color={st.colour}>{st.text}</T>
              {a.notes.length && !a.converted ? <T size={11.5} color={C.stone2} lineHeight={1.4}>{`Left out: ${a.notes.join(' · ')}`}</T> : null}
            </View>
          );
        })}
      </Card>
      {list.length > 5 ? (
        <Press onPress={() => { animateLayout(); setAll(v => !v); }} style={{ alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: C.control2 }}>
          <T size={12.5} weight={600} color={C.stone}>{all ? 'Show fewer' : `Show all ${list.length}`}</T>
        </Press>
      ) : null}
    </View>
  );
}

export function AutomationsScreen() {
  const s = useSnap();
  const { api, act, say } = useHub();
  const nav = useNav();
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<AutomationView | null>(null);
  const [del, setDel] = useState<AutomationView | null>(null);
  const [ha, setHa] = useState<HaAutomation[] | null>(null);

  // On/off taps show at once; the snapshot confirms them (or the tap is put back if the hub refused).
  const { list: autos, settled } = withPending(automationsOf(s), pending);
  useEffect(() => {
    if (settled.length) setPending(p => { const n = { ...p }; for (const id of settled) delete n[id]; return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled.join()]);
  const shown = filterAutomations(autos, q);
  const ideas = ideasOf(s);
  const on = autos.filter(a => a.enabled).length;

  // Home Assistant automations, when the hub has an import (503 when it can't import at all).
  const loadHa = useCallback(() => {
    void api<{ automations: HaAutomation[] }>('GET', '/api/import/ha/automations')
      .then(r => setHa(r.automations ?? []))
      .catch(e => { if (!(e instanceof HubError) || e.status !== 0) setHa(null); });
  }, [api]);
  useFocusEffect(loadHa);

  const toggle = async (a: AutomationView, v: boolean) => {
    setPending(p => ({ ...p, [a.id]: v }));
    try {
      const r = await api<{ undo?: string }>('PATCH', `/api/automations/${encodeURIComponent(a.id)}`, { enabled: v });
      say(`${a.name} ${v ? 'on' : 'off'}`, { undo: r?.undo });
    } catch (e) {
      setPending(p => { const n = { ...p }; delete n[a.id]; return n; });
      say((e as Error).message, { error: true });
    }
  };
  const run = async (a: AutomationView, check = false) => {
    try {
      const m = runMessage(a.name, await startRun(api<RunAnswer>('POST', `/api/automations/${encodeURIComponent(a.id)}/run${check ? '?check=1' : ''}`)));
      if (m.ok) haptic.success();
      say(m.text, { error: m.error });
    } catch (e) { say((e as Error).message, { error: true }); }
  };
  const convert = async (ids: string[] | null) => {
    try {
      const r = await api<{ made: unknown[]; skipped: { why: string }[]; undo?: string | null }>('POST', '/api/import/ha/automations/convert', ids ? { ids } : {});
      const n = r.made.length;
      if (n) haptic.success();
      say(n ? `${n} converted · switched off until you check them` : r.skipped[0]?.why ?? 'Nothing to convert', { undo: r.undo ?? undefined, error: !n });
      loadHa();
    } catch (e) { say((e as Error).message, { error: true }); }
  };
  const open = (a: AutomationView) => nav.navigate('AutomationEditor', { id: a.id });

  return (
    <Screen gap={16}>
      <PageHead over={autos.length ? `${plural(autos.length, 'automation')} · ${on} on` : 'When something happens, do something'} title="Automations" onBack={() => nav.goBack()}
        right={
          <Press onPress={() => nav.navigate('AutomationEditor', {})} label="New automation" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingLeft: 9, paddingRight: 12, borderRadius: 12, backgroundColor: C.amber }}>
            <Icon name="add" size={19} color={C.onAmber} />
            <T size={13} weight={700} color={C.onAmber}>New</T>
          </Press>
        } />

      {autos.length > 3 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
          <Icon name="search" size={20} color={C.stone2} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search automations" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search automations"
            style={{ flex: 1, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
          {q ? <Press onPress={() => setQ('')} label="Clear search" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
        </View>
      ) : null}

      {ideas.map(i => (
        <IdeaCard key={i.key} i={i}
          onAdd={() => void act('POST', '/api/automations', { ...draftOf(i), enabled: true }, `${i.name} added`)}
          onChange={() => nav.navigate('AutomationEditor', { draft: { ...draftOf(i), enabled: true } })}
          onDismiss={() => void act('POST', `/api/findings/${encodeURIComponent(`idea:${i.key}`)}/dismiss`, {}, 'Not suggested again')} />
      ))}

      {shown.map((a, i) => (
        <AutomationCard key={a.id} a={a} index={i} onToggle={v => void toggle(a, v)} onRun={() => void run(a)} onMore={() => setMore(a)} onOpen={() => open(a)} />
      ))}

      {autos.length && !shown.length ? <Empty icon="search_off" title="Nothing matches" text={`No automation mentions “${q.trim()}”.`} /> : null}

      {!autos.length ? (
        <View style={{ gap: 12 }}>
          <Empty icon="account_tree" title="No automations yet" text="An automation does something by itself: when something happens, and only if the time or who’s home is right." action="New automation" onAction={() => nav.navigate('AutomationEditor', {})} />
          <Card style={{ padding: 14, gap: 10 }}>
            <T size={12} weight={800} color={C.stone2} upper tracking={0.05}>For example</T>
            {EXAMPLES.map(([icon, text]) => (
              <View key={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: C.amberTint, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={17} color={C.amber} /></View>
                <T size={13} color={C.bone2} style={{ flex: 1 }} lineHeight={1.4}>{text}</T>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {ha && ha.length ? <HaSection list={ha} onConvert={ids => void convert(ids)} /> : null}

      <Sheet open={!!more} onClose={() => setMore(null)}>
        {more ? (
          <View style={{ gap: 6 }}>
            <T size={18} weight={700} style={{ marginBottom: 6 }}>{more.name}</T>
            {([
              ['play_arrow', 'Run now', 'Skips its conditions', () => void run(more)],
              ['fact_check', 'Check, then run', 'Only if its conditions hold now', () => void run(more, true)],
              ['edit', 'Edit', '', () => open(more)],
              ['history', 'History', 'Each run, step by step', () => nav.navigate('AutomationEditor', { id: more.id, tab: 'history' })],
              ['layers', 'Duplicate', 'The copy starts switched off', () => void act('POST', `/api/automations/${encodeURIComponent(more.id)}/duplicate`, {}, `Copied ${more.name} (off until you turn it on)`)],
              ['delete', 'Delete', '', () => setTimeout(() => setDel(more), 320)],
            ] as [string, string, string, () => void][]).map(([icon, label, sub, fn]) => (
              <Press key={label} label={label} haptic="select" onPress={() => { setMore(null); fn(); }}
                style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.card }}>
                <Icon name={icon} size={20} color={icon === 'delete' ? C.red : C.bone} />
                <View style={{ flex: 1, gap: 1 }}>
                  <T size={14.5} weight={700} color={icon === 'delete' ? C.red : C.bone}>{label}</T>
                  {sub ? <T size={12} color={C.stone}>{sub}</T> : null}
                </View>
              </Press>
            ))}
          </View>
        ) : null}
      </Sheet>
      <Confirm open={!!del} title={`Delete ${del?.name ?? ''}?`} text="You can undo this for a few seconds afterwards." yes="Delete" danger
        onClose={() => setDel(null)}
        onYes={() => { const a = del; setDel(null); if (a) void act('DELETE', `/api/automations/${encodeURIComponent(a.id)}`, undefined, `${a.name} deleted`); }} />
      {autos.length ? <View style={{ alignItems: 'center' }}><Button kind="secondary" icon="add" label="New automation" onPress={() => nav.navigate('AutomationEditor', {})} /></View> : null}
      <View style={{ height: 40 }} />
    </Screen>
  );
}
