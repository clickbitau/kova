import { useCallback, useEffect, useState } from 'react';
import { TextInput, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { HubError } from '../api/client';
import {
  EXAMPLES, automationsOf, draftOf, filterAutomations, haState, haText, ideasOf, lastRunLine, localNowOf, runMessage, scheduleAgain, scheduleLine, sectionsOf, startRun, summary, withPending,
  type AutomationView, type RunAnswer, type HaAutomation, type Idea,
} from '../logic/automations';
import { Icon } from '../ui/Icon';
import { Card, Empty, IconWell, Press, Section, Sheet, Switch, Tag } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, animateLayout, haptic } from '../ui/motion';
import { Confirm } from './AutomationEditor';

// Automations: the home's own rules, each in words (When / Only if / Then) with an on/off switch and how its last
// run went; Kova's suggestions above, Home Assistant ones to convert below. One-time schedules have their own
// sections: Scheduled (still to come, soonest first) above, and Done (folded away, to schedule again or clear)
// below. Live from the hub's snapshot.

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Line({ k, text, colour = C.bone2 }: { k: string; text: string; colour?: string }) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <T v="eyebrow" color={C.stone2} style={{ width: 62 * Math.min(fontScale, 1.6), paddingTop: 3 }}>{k}</T>
      <T v="callout" color={colour} style={{ flex: 1, minWidth: 0 }}>{text}</T>
    </View>
  );
}

function SmallButton({ icon, label, onPress, tone = 'plain', grow }: { icon?: string; label: string; onPress: () => void; tone?: 'plain' | 'amber'; grow?: boolean }) {
  const bg = tone === 'amber' ? C.amber : C.control2, fg = tone === 'amber' ? C.onAmber : C.bone;
  return (
    <Press onPress={onPress} label={label} hitSlop={{ top: 4, bottom: 4 }} style={{ flexGrow: grow ? 1 : 0, justifyContent: 'center', minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 12, borderRadius: R.sm + 1, backgroundColor: bg, borderWidth: tone === 'amber' ? 0 : 1, borderColor: C.edge }}>
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <T v="labelSm" color={fg} numberOfLines={1}>{label}</T>
    </Press>
  );
}

function AutomationCard({ a, index, onToggle, onRun, onMore, onOpen }: { a: AutomationView; index: number; onToggle: (v: boolean) => void; onRun: () => void; onMore: () => void; onOpen: () => void }) {
  const w = summary(a);
  const [last, colour] = lastRunLine(a.lastRun);
  return (
    <Appear index={index}>
      <Press onPress={onOpen} give="soft" label={`Edit ${a.name}`} style={{ borderRadius: R.lg, backgroundColor: a.enabled ? C.card : C.inset, padding: SP[4], gap: SP[3], borderWidth: 1, borderColor: C.edge, borderTopColor: a.enabled ? C.edgeTop : C.edge }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: a.enabled ? 1 : 0.6 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T v="headline" numberOfLines={2}>{a.name}</T>
            {a.description ? <T v="footnote" color={C.stone} numberOfLines={2}>{a.description}</T> : null}
          </View>
          {a.running > 0 && a.lastRun?.result !== 'running' ? <Tag text="Running" color={C.amber} /> : null}
          {a.origin ? <Tag text="From HA" color={C.stone} /> : null}
        </View>
        <View style={{ gap: 5, opacity: a.enabled ? 1 : 0.6 }}>
          <Line k="When" text={w.when} />
          {w.onlyIf ? <Line k="Only if" text={w.onlyIf} /> : null}
          <Line k="Then" text={w.then} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
          <T v="footnote" weight={600} color={colour} style={{ flex: 1, minWidth: 0 }} numberOfLines={2}>{last}</T>
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
    <Appear style={{ borderRadius: R.lg, padding: SP[4], gap: SP[3], backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
      <View style={{ gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="auto_awesome" size={15} color={C.amber} />
          <T v="eyebrow" color={C.amber}>Suggested</T>
        </View>
        <T v="headline">{i.name}</T>
      </View>
      <View style={{ gap: 5 }}>
        <Line k="When" text={w.when} />
        {w.onlyIf ? <Line k="Only if" text={w.onlyIf} /> : null}
        <Line k="Then" text={w.then} />
      </View>
      {i.why ? <T v="footnote" color={C.stone}>{i.why}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <SmallButton grow tone="amber" icon="add" label="Add" onPress={onAdd} />
        <SmallButton grow icon="edit" label="Change first" onPress={onChange} />
        <SmallButton grow label="Not now" onPress={onDismiss} />
      </View>
    </Appear>
  );
}

const TONE = { amber: C.amber, stone: C.stone, green: C.green, red: C.red } as const;

/** A one-time schedule still to come: when, in words and how long until; what it does; edit or cancel. */
function ScheduleCard({ a, now, index, onEdit, onCancel, onTurnOn }: { a: AutomationView; now: string; index: number; onEdit: () => void; onCancel: () => void; onTurnOn: () => void }) {
  const line = scheduleLine(a, now);
  const w = summary(a);
  return (
    <Appear index={index}>
      <Press onPress={onEdit} give="soft" label={`Edit ${a.name}, ${line.text}`} style={{ borderRadius: R.lg, backgroundColor: a.enabled ? C.card : C.inset, padding: SP[4], gap: SP[3], borderWidth: 1, borderColor: a.enabled ? C.amberLine : C.edge }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconWell icon="timer" color={a.enabled ? C.amber : C.stone} size={40} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T v="headline" numberOfLines={2}>{a.name}</T>
            <T v="footnote" weight={700} color={TONE[line.tone]}>{line.text}</T>
          </View>
        </View>
        <T v="footnote" color={C.bone2} numberOfLines={3}>{w.onlyIf ? `${w.then} · only if ${w.onlyIf}` : w.then}</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SmallButton icon="edit" label="Edit" onPress={onEdit} />
          {!a.enabled ? <SmallButton tone="amber" icon="schedule" label="Turn on" onPress={onTurnOn} /> : null}
          <View style={{ flex: 1 }} />
          <SmallButton icon="event_busy" label="Cancel" onPress={onCancel} />
        </View>
      </Press>
    </Appear>
  );
}

/** One-time schedules that have run (or were missed), folded away: schedule again, or clear them all. */
function DoneSection({ list, now, onAgain, onDelete, onClear }: { list: AutomationView[]; now: string; onAgain: (a: AutomationView) => void; onDelete: (a: AutomationView) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Press onPress={() => { animateLayout(); setOpen(v => !v); }} haptic="select" label={`${open ? 'Hide' : 'Show'} done schedules, ${list.length}`} style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T v="heading">Done</T>
          <View style={{ paddingVertical: 1, paddingHorizontal: 8, borderRadius: R.full, backgroundColor: C.control }}><T v="micro" color={C.stone}>{String(list.length)}</T></View>
          <Icon name="expand_more" size={22} color={C.stone2} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
        </Press>
        <SmallButton icon="delete" label="Clear done" onPress={onClear} />
      </View>
      {open ? (
        <Card style={{ overflow: 'hidden' }}>
          {list.map((a, i) => {
            const line = scheduleLine(a, now);
            return (
              <View key={a.id} style={{ padding: 14, gap: 8, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Icon name={line.tone === 'red' ? 'error' : 'check_circle'} size={18} color={TONE[line.tone]} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="headline" size={14}>{a.name}</T>
                    <T v="footnote" color={TONE[line.tone]}>{line.text}</T>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <SmallButton icon="restart_alt" label="Schedule again" onPress={() => onAgain(a)} />
                  <View style={{ flex: 1 }} />
                  <Press onPress={() => onDelete(a)} label={`Delete ${a.name}`} style={{ width: 36, height: 36, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
                    <Icon name="delete" size={18} color={C.stone} />
                  </Press>
                </View>
              </View>
            );
          })}
        </Card>
      ) : <T v="footnote" color={C.stone2}>One-time schedules that have gone off. They switch themselves off.</T>}
    </View>
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
          <T v="heading">From Home Assistant</T>
          <T v="footnote" color={C.stone}>{`${plural(list.length, 'automation')}${left ? ` · ${left} can convert` : ''}. Converted ones start switched off.`}</T>
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
                  <T v="headline" size={14}>{a.name}</T>
                  <T v="footnote" color={C.stone} numberOfLines={2}>{haText(a)}</T>
                </View>
                {st.canConvert ? <SmallButton label="Convert" onPress={() => onConvert([a.id])} /> : null}
              </View>
              <T v="footnote" weight={600} color={st.colour}>{st.text}</T>
              {a.notes.length && !a.converted ? <T v="footnote" color={C.stone2}>{`Left out: ${a.notes.join(' · ')}`}</T> : null}
            </View>
          );
        })}
      </Card>
      {list.length > 5 ? (
        <Press onPress={() => { animateLayout(); setAll(v => !v); }} style={{ alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: C.control2 }}>
          <T v="labelSm" color={C.stone}>{all ? 'Show fewer' : `Show all ${list.length}`}</T>
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
  const [cancel, setCancel] = useState<AutomationView | null>(null);
  const now = localNowOf(s);

  // On/off taps show at once; the snapshot confirms them (or the tap is put back if the hub refused).
  const { list: autos, settled } = withPending(automationsOf(s), pending);
  useEffect(() => {
    if (settled.length) setPending(p => { const n = { ...p }; for (const id of settled) delete n[id]; return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled.join()]);
  const shown = filterAutomations(autos, q);
  const { scheduled, regular, done } = sectionsOf(shown);
  const ideas = ideasOf(s);
  const on = autos.filter(a => a.enabled && !a.done).length;

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
  const newOne = () => nav.navigate('AutomationEditor', {});
  const scheduleOnce = () => nav.navigate('AutomationEditor', { schedule: true });
  const again = (a: AutomationView) => nav.navigate('AutomationEditor', { id: a.id, draft: scheduleAgain(draftOf(a), now) });
  const clearDone = async () => {
    try {
      const r = await api<{ cleared: number; undo?: string }>('POST', '/api/automations/clear-done', {});
      haptic.success();
      say(r.cleared ? `Cleared ${plural(r.cleared, 'finished schedule')}` : 'Nothing to clear', { undo: r.undo });
    } catch (e) { say((e as Error).message, { error: true }); }
  };
  const remove = (a: AutomationView, done: string) => void act('DELETE', `/api/automations/${encodeURIComponent(a.id)}`, undefined, done);

  return (
    <Screen gap={16} title="Automations" over={autos.length ? `${plural(autos.length, 'automation')} · ${on} on` : 'When something happens, do something'} onBack={() => nav.goBack()}
      right={
          <Press onPress={newOne} label="New automation" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingLeft: 9, paddingRight: 12, borderRadius: 12, backgroundColor: C.amber }}>
            <Icon name="add" size={19} color={C.onAmber} />
            <T v="labelSm" color={C.onAmber}>New</T>
          </Press>
        }>

      <View style={{ flexDirection: 'row', gap: SP[2] }}>
        <Press onPress={newOne} haptic="select" label="New automation: when something happens, do something" style={{ flex: 1, minHeight: 64, padding: 12, gap: 4, borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge }}>
          <Icon name="account_tree" size={20} color={C.amber} />
          <T v="labelSm">New automation</T>
        </Press>
        <Press onPress={scheduleOnce} haptic="select" label="Schedule once: something at a date and time, one time" style={{ flex: 1, minHeight: 64, padding: 12, gap: 4, borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge }}>
          <Icon name="timer" size={20} color={C.amber} />
          <T v="labelSm">Schedule once</T>
        </Press>
      </View>

      {autos.length > 3 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
          <Icon name="search" size={20} color={C.stone2} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search automations" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search automations"
            style={{ flex: 1, minWidth: 0, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
          {q ? <Press onPress={() => setQ('')} label="Clear search" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
        </View>
      ) : null}

      {ideas.map(i => (
        <IdeaCard key={i.key} i={i}
          onAdd={() => void act('POST', '/api/automations', { ...draftOf(i), enabled: true }, `${i.name} added`)}
          onChange={() => nav.navigate('AutomationEditor', { draft: { ...draftOf(i), enabled: true } })}
          onDismiss={() => void act('POST', `/api/findings/${encodeURIComponent(`idea:${i.key}`)}/dismiss`, {}, 'Not suggested again')} />
      ))}

      {scheduled.length ? (
        <Section title="Scheduled" right={<T v="footnote" color={C.stone}>{`${scheduled.length} to come`}</T>}>
          {scheduled.map((a, i) => (
            <ScheduleCard key={a.id} a={a} now={now} index={i} onEdit={() => open(a)} onCancel={() => setCancel(a)} onTurnOn={() => void toggle(a, true)} />
          ))}
        </Section>
      ) : null}

      {regular.length ? (
        <Section title={scheduled.length || done.length ? 'Automations' : undefined}>
          {regular.map((a, i) => (
            <AutomationCard key={a.id} a={a} index={i} onToggle={v => void toggle(a, v)} onRun={() => void run(a)} onMore={() => setMore(a)} onOpen={() => open(a)} />
          ))}
        </Section>
      ) : null}

      {done.length ? <DoneSection list={done} now={now} onAgain={again} onDelete={a => remove(a, `${a.name} deleted`)} onClear={() => void clearDone()} /> : null}

      {autos.length && !shown.length ? <Empty icon="search_off" title="Nothing matches" text={`No automation mentions “${q.trim()}”.`} /> : null}

      {!autos.length ? (
        <View style={{ gap: 12 }}>
          <Empty icon="account_tree" title="No automations yet" text="An automation does something by itself: when something happens, and only if the time or who’s home is right. Or schedule something once." action="New automation" onAction={newOne} />
          <Card style={{ padding: 14, gap: 10 }}>
            <T v="eyebrow" color={C.stone2}>For example</T>
            {EXAMPLES.map(([icon, text]) => (
              <View key={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: C.amberTint, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={17} color={C.amber} /></View>
                <T v="callout" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{text}</T>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {ha && ha.length ? <HaSection list={ha} onConvert={ids => void convert(ids)} /> : null}

      <Sheet open={!!more} onClose={() => setMore(null)}>
        {more ? (
          <View style={{ gap: 6 }}>
            <T v="heading" style={{ marginBottom: 6 }}>{more.name}</T>
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
                  <T v="headline" color={icon === 'delete' ? C.red : C.bone}>{label}</T>
                  {sub ? <T v="footnote" color={C.stone}>{sub}</T> : null}
                </View>
              </Press>
            ))}
          </View>
        ) : null}
      </Sheet>
      <Confirm open={!!del} title={`Delete ${del?.name ?? ''}?`} text="You can undo this for a few seconds afterwards." yes="Delete" danger
        onClose={() => setDel(null)}
        onYes={() => { const a = del; setDel(null); if (a) remove(a, `${a.name} deleted`); }} />
      <Confirm open={!!cancel} title={`Cancel ${cancel?.name ?? ''}?`} text={cancel ? `${scheduleLine(cancel, now).text}. It won’t go off. You can undo this for a few seconds.` : undefined} yes="Cancel the schedule" no="Keep it" danger
        onClose={() => setCancel(null)}
        onYes={() => { const a = cancel; setCancel(null); if (a) remove(a, `${a.name} cancelled`); }} />

      <View style={{ height: 40 }} />
    </Screen>
  );
}
