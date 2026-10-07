import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventRemove, useRoute, type NavigationAction, type RouteProp } from '@react-navigation/native';
import { C, F, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav, type Stack } from '../navigation';
import type { Device, Room } from '../api/types';
import {
  ACTION_KINDS, CONDITION_KINDS, DAYS, DAY_NAMES, EVENTS, ROOM_EVENTS, FIELDS, PRESENCE_EVENTS, RESULT, RHYTHMS, RUN_MODES, TRIGGER_KINDS,
  automationsOf, bodyOf, canMove, canSet, changeKind, clockOf, commandChoices, commandFromKey, commandKey, ctxOf, dayOn, deviceLabel, deviceSections,
  draftOf, firstCommand, isGroup, labelOf, minToSec, moveAt, newAction, newCondition, newTrigger, parseClock, pushAt, removeAt, retarget,
  rhythmFromKey, rhythmKey, runMessage, runTime, startRun, sameDraft, secToMin, setAt, splitSeconds, stateFromKey, stateKey, stateOptions, toSeconds, toggleDay, toggleIn,
  withCurrent, withOffset, type Action, type AutomationRun, type RunAnswer, type Condition, type Ctx, type Draft, type Opt, type Path, type Rhythm, type Trigger, type Unit,
} from '../logic/automations';
import { Icon } from '../ui/Icon';
import { Button, Pill, Press, Sheet, Switch } from '../ui/kit';
import { Appear, animateLayout, haptic } from '../ui/motion';
import { T } from '../ui/Text';

// The automation editor, full screen: name, description, run mode, then When / Only if / Then as cards that
// nest (groups of conditions, if / otherwise, repeat). Choices open a sheet (a list, devices by room with
// search, or a clock). The History tab shows each run, step by step. The tree logic is in logic/automations.ts.

// --------------------------------------------------------------- pickers --

type Picker =
  | { type: 'list'; title: string; options: Opt[]; value?: string; onPick: (v: string) => void }
  | { type: 'device'; title: string; value?: string; only?: (d: Pick<Device, 'type'>) => boolean; onPick: (v: string) => void }
  | { type: 'time'; title: string; value: string; onPick: (v: string) => void };

interface Home { devices: Device[]; rooms: Room[]; people: { id: string; name: string }[]; modes: { id: string; name: string }[]; overlays: { id: string; name: string }[]; automations: { id: string; name: string }[]; sources: { name: string }[] }

interface Ed {
  draft: Draft;
  set(p: Path, v: unknown): void;
  remove(p: Path): void;
  move(p: Path, d: -1 | 1): void;
  push(p: Path, v: unknown): void;
  pick(p: Picker): void;
  home: Home;
  ctx: Ctx;
  self?: string;
}
const EdCtx = createContext<Ed | null>(null);
const useEd = () => useContext(EdCtx)!;

// ----------------------------------------------------------------- bits ---

/** A small label over a control. */
function Label({ children }: { children: string }) {
  return <T size={11.5} weight={700} color={C.stone2} upper tracking={0.05}>{children}</T>;
}

function Field({ label, children, grow }: { label?: string; children: ReactNode; grow?: boolean }) {
  return (
    <View style={{ gap: 6, flexGrow: grow ? 1 : 0, flexShrink: 1, minWidth: grow ? '100%' : undefined }}>
      {label ? <Label>{label}</Label> : null}
      {children}
    </View>
  );
}

/** A choice that opens a sheet: shows what's chosen, with a chevron. */
function Choice({ text, onPress, label, muted }: { text: string; onPress: () => void; label: string; muted?: boolean }) {
  return (
    <Press onPress={onPress} label={`${label}: ${text}`} haptic="select" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingLeft: 12, paddingRight: 8, borderRadius: 12, backgroundColor: C.control }}>
      <T size={14} weight={600} color={muted ? C.stone : C.bone} style={{ flexShrink: 1 }} numberOfLines={2}>{text}</T>
      <Icon name="chevron_right" size={18} color={C.stone2} style={{ transform: [{ rotate: '90deg' }] }} />
    </Press>
  );
}

/** Pick one from a list, through the sheet. */
function Select({ label, value, options, onChange, empty }: { label: string; value?: string; options: Opt[]; onChange: (v: string) => void; empty?: string }) {
  const { pick } = useEd();
  const cur = options.find(o => o.v === (value ?? ''));
  return <Choice label={label} text={cur?.label ?? value ?? empty ?? 'Choose'} muted={!cur} onPress={() => pick({ type: 'list', title: label, options, value, onPick: onChange })} />;
}

function DeviceChoice({ value, onChange, only, label = 'Device' }: { value: string; onChange: (v: string) => void; only?: (d: Pick<Device, 'type'>) => boolean; label?: string }) {
  const { pick, home } = useEd();
  const missing = !home.devices.some(d => d.id === value);
  return <Choice label={label} text={deviceLabel(value, home.devices, home.rooms)} muted={missing} onPress={() => pick({ type: 'device', title: label, value, only, onPick: onChange })} />;
}

/** A row of mutually exclusive pills. */
function Segs<V extends string>({ value, options, onChange }: { value: V; options: Opt<V>[]; onChange: (v: V) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map(o => <Pill key={o.v} label={o.label} on={o.v === value} onPress={() => onChange(o.v)} />)}
    </View>
  );
}

/**
 * A number with − and + either side. Typing works too; an empty box means "not set" when `optional`.
 * Steps clamp at `min` / `max`.
 */
function Num({ value, onChange, step = 1, min, max, unit, label, optional }: { value: number | undefined; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number; unit?: string; label: string; optional?: boolean }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value == null ? '' : String(value)); } }, [value]);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const emit = (n: number | undefined) => { last.current = n; setText(n == null ? '' : String(n)); onChange(n); };
  const bump = (d: number) => { haptic.select(); emit(clamp(value == null ? (d > 0 ? Math.max(min ?? 0, 0) + step : (min ?? 0)) : Math.round((value + d) * 100) / 100)); };
  const btn = (d: number, icon: string, a11y: string) => (
    <Press onPress={() => bump(d)} label={`${a11y} ${label}`} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.control, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={20} />
    </Press>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {btn(-step, 'remove', 'Less')}
      <TextInput value={text} accessibilityLabel={label} keyboardType={min != null && min >= 0 ? 'decimal-pad' : 'numbers-and-punctuation'} placeholder={optional ? '–' : ''} placeholderTextColor={C.stone3}
        onChangeText={t => {
          setText(t);
          if (t.trim() === '') { if (optional) { last.current = undefined; onChange(undefined); } return; }
          const n = Number(t.replace(',', '.'));
          if (Number.isFinite(n)) { last.current = n; onChange(n); }
        }}
        onBlur={() => { if (text.trim() === '' && !optional) emit(min ?? 0); else if (value != null && clamp(value) !== value) emit(clamp(value)); }}
        style={{ width: 64, height: 40, borderRadius: 12, backgroundColor: C.inset, color: C.bone, fontFamily: F[700], fontSize: 15, textAlign: 'center', borderWidth: 1, borderColor: C.line }} />
      {btn(step, 'add', 'More')}
      {unit ? <T size={13} color={C.stone}>{unit}</T> : null}
    </View>
  );
}

function TextBox({ value, onChange, placeholder, label, multiline }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; multiline?: boolean }) {
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone3} accessibilityLabel={label} multiline={multiline}
      style={{ minHeight: 44, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.inset, color: C.bone, fontFamily: F[500], fontSize: 15, borderWidth: 1, borderColor: C.line, textAlignVertical: multiline ? 'top' : 'center' }} />
  );
}

function TimeChoice({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { pick } = useEd();
  return (
    <Press onPress={() => pick({ type: 'time', title: label, value, onPick: onChange })} label={`${label}: ${value}`} haptic="select"
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.control, alignSelf: 'flex-start' }}>
      <Icon name="schedule" size={18} color={C.amber} />
      <T mono size={16} color={C.bone}>{value}</T>
    </Press>
  );
}

/** A clock time, a sun time or a prayer time, with minutes before or after for the moving ones. */
function RhythmField({ value, onChange, label }: { value: Rhythm | undefined; onChange: (r: Rhythm) => void; label: string }) {
  const r = value ?? { kind: 'time', at: '21:00' };
  return (
    <View style={{ gap: 8 }}>
      <Select label={label} value={rhythmKey(r)} options={RHYTHMS} onChange={k => onChange(rhythmFromKey(k, r))} />
      {r.kind === 'time'
        ? <TimeChoice label={label} value={r.at} onChange={at => onChange({ kind: 'time', at })} />
        : (
          <View style={{ gap: 4 }}>
            <Num label="Minutes after (minus for before)" value={r.offsetMin ?? 0} step={5} min={-240} max={240} unit={(r.offsetMin ?? 0) < 0 ? 'min before' : 'min after'} onChange={v => onChange(withOffset(r, v ?? 0))} />
          </View>
        )}
    </View>
  );
}

function DayChips({ days, onChange }: { days?: number[]; onChange: (d: number[] | undefined) => void }) {
  const picked = !!days && days.length > 0;
  return (
    <Field label="Days">
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {DAYS.map((l, i) => {
          const on = dayOn(days, i);
          return (
            <Press key={i} haptic="select" label={`${DAY_NAMES[i]}${on ? ', on' : ', off'}`} onPress={() => onChange(toggleDay(days, i))}
              style={{ flex: 1, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on && picked ? C.amber : on ? C.selected : 'transparent', borderWidth: 1, borderColor: on ? 'transparent' : C.line }}>
              <T size={13} weight={700} color={on && picked ? C.onAmber : on ? C.bone : C.stone3}>{l}</T>
            </Press>
          );
        })}
      </View>
      <T size={11.5} color={C.stone3}>{picked ? 'Only on the days lit' : 'Every day: tap a day to leave it out'}</T>
    </Field>
  );
}

/** Pick any number of things (modes, people). */
function Chips({ items, on, onToggle }: { items: { id: string; name: string }[]; on: (id: string) => boolean; onToggle: (id: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map(x => <Pill key={x.id} label={x.name} on={on(x.id)} onPress={() => onToggle(x.id)} />)}
    </View>
  );
}

// ------------------------------------------------------------- the tree ---

const SUB: Record<string, string> = { trigger: 'trigger', condition: 'condition', action: 'step' };

/** One part (a trigger, condition or step): its kind, move and remove, then its fields and anything nested. */
function Part({ path, tag, kind, kinds, onKind, what, canRemove = true, children, index = 0 }: { path: Path; tag?: string; kind: string; kinds: Opt[]; onKind: (k: string) => void; what: 'trigger' | 'condition' | 'action'; canRemove?: boolean; children?: ReactNode; index?: number }) {
  const { draft, move, remove, pick } = useEd();
  const kindLabel = labelOf(kinds, kind);
  const up = canRemove && canMove(draft, path, -1), down = canRemove && canMove(draft, path, 1);
  const small = (icon: string, label: string, fn: () => void, enabled = true, color: string = C.bone2) => (
    <Press onPress={fn} disabled={!enabled} label={label} style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2, opacity: enabled ? 1 : 0.35 }}>
      <Icon name={icon} size={18} color={color} />
    </Press>
  );
  return (
    <Appear index={index} style={{ borderRadius: 16, backgroundColor: C.inset, padding: 12, gap: 12, borderWidth: 1, borderColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {tag ? <View style={{ paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, backgroundColor: C.amberTint }}><T size={11} weight={800} color={C.amber} upper>{tag}</T></View> : null}
        <Press onPress={() => pick({ type: 'list', title: `What kind of ${SUB[what]}`, options: kinds, value: kind, onPick: onKind })} label={`Kind of ${SUB[what]}: ${kindLabel}`} haptic="select"
          style={{ flex: 1, minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <T size={14.5} weight={700} style={{ flexShrink: 1 }} numberOfLines={2}>{kindLabel}</T>
          <Icon name="chevron_right" size={17} color={C.stone2} style={{ transform: [{ rotate: '90deg' }] }} />
        </Press>
        {canRemove ? (
          <>
            {up || down ? small('arrow_upward', 'Move up', () => { animateLayout(); move(path, -1); }, up) : null}
            {up || down ? small('arrow_downward', 'Move down', () => { animateLayout(); move(path, 1); }, down) : null}
            {small('delete', `Remove this ${SUB[what]}`, () => { animateLayout(); haptic.select(); remove(path); }, true, C.red)}
          </>
        ) : null}
      </View>
      {children}
    </Appear>
  );
}

/** Indented, for what sits inside a group, an if or a repeat. */
function Nest({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: C.line }}>
      {title ? <Label>{title}</Label> : null}
      {children}
    </View>
  );
}

function AddButton({ text, onPress }: { text: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} label={text} haptic="select" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.amberLine }}>
      <Icon name="add" size={18} color={C.amber} />
      <T size={13.5} weight={700} color={C.amber}>{text}</T>
    </Press>
  );
}

function TriggerPart({ t, path, index }: { t: Trigger; path: Path; index: number }) {
  const { set, ctx, home } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  let body: ReactNode = null;
  switch (t.kind) {
    case 'device': body = (<>
      <DeviceChoice value={t.device} onChange={v => f('device', v)} />
      <Field label="Changes to"><Select label="Changes to" value={stateKey(t.to)} options={stateOptions(t.to)} onChange={v => f('to', stateFromKey(v))} /></Field>
      <Field label="From"><Select label="From" value={stateKey(t.from)} options={[{ v: '', label: 'any state' }, ...stateOptions(t.from)]} onChange={v => f('from', stateFromKey(v))} /></Field>
      <Field label="And stays so for"><Num label="Minutes it stays so" optional min={0} value={secToMin(t.forSec)} onChange={v => f('forSec', minToSec(v))} unit="min" /></Field>
    </>); break;
    case 'numeric': body = (<>
      <DeviceChoice value={t.device} onChange={v => f('device', v)} />
      <Field label="Reading"><Select label="Reading" value={t.field} options={withCurrent(FIELDS, t.field)} onChange={v => f('field', v)} /></Field>
      <Field label="Goes above"><Num label="Above" optional value={t.above} onChange={v => f('above', v)} /></Field>
      <Field label="Or below"><Num label="Below" optional value={t.below} onChange={v => f('below', v)} /></Field>
      <Field label="For"><Num label="Minutes" optional min={0} value={secToMin(t.forSec)} onChange={v => f('forSec', minToSec(v))} unit="min" /></Field>
    </>); break;
    case 'event': body = (<>
      <DeviceChoice value={t.device} onChange={v => f('device', v)} />
      <Field label="When it"><Select label="Event" value={t.event} options={withCurrent(EVENTS, t.event)} onChange={v => f('event', v)} /></Field>
    </>); break;
    case 'room': body = (<>
      <Field label="In"><Select label="Room" value={t.room} options={withCurrent(home.rooms.map(r => ({ v: r.id, label: r.name })), t.room)} onChange={v => f('room', v)} /></Field>
      <Field label="When there’s"><Select label="What happens" value={t.event} options={withCurrent(ROOM_EVENTS, t.event)} onChange={v => f('event', v)} /></Field>
    </>); break;
    case 'time': body = (<>
      <RhythmField label="At" value={t.at} onChange={r => f('at', r)} />
      <DayChips days={t.days} onChange={d => f('days', d)} />
    </>); break;
    case 'every': body = <Field label="Every"><Num label="Minutes" min={1} max={1440} value={t.minutes} onChange={v => f('minutes', v ?? 1)} unit="min" /></Field>; break;
    case 'presence': {
      const group = t.event === 'first-arrives' || t.event === 'last-leaves';
      body = (<>
        <Field label="What"><Select label="What" value={t.event} options={PRESENCE_EVENTS} onChange={v => { set(path, { ...t, event: v, ...(v === 'first-arrives' || v === 'last-leaves' ? { person: undefined } : {}) }); }} /></Field>
        {group ? null : <Field label="Who"><Select label="Who" value={t.person ?? ''} options={[{ v: '', label: 'Anyone' }, ...home.people.map(p => ({ v: p.id, label: p.name }))]} onChange={v => f('person', v || undefined)} /></Field>}
      </>); break;
    }
    case 'mode': body = <Field label="Mode"><Select label="Mode" value={t.mode} options={withCurrent(home.modes.map(m => ({ v: m.id, label: m.name })), t.mode)} onChange={v => f('mode', v)} /></Field>; break;
    case 'overlay': body = (<>
      <Field label="Overlay"><Select label="Overlay" value={t.overlay} options={withCurrent(home.overlays.map(o => ({ v: o.id, label: o.name })), t.overlay)} onChange={v => f('overlay', v)} /></Field>
      <Segs value={t.event} options={[{ v: 'starts', label: 'Starts' }, { v: 'ends', label: 'Ends' }]} onChange={v => f('event', v)} />
    </>); break;
    case 'hub': body = <T size={12.5} color={C.stone}>When Kova starts: after an update or a power cut.</T>; break;
  }
  return (
    <Part path={path} index={index} tag={index ? 'or' : undefined} what="trigger" kind={t.kind} kinds={TRIGGER_KINDS} onKind={k => set(path, changeKind(t, newTrigger(k as Trigger['kind'], ctx)))}>
      {body}
    </Part>
  );
}

function ConditionList({ list, path }: { list: Condition[]; path: Path }) {
  return <>{list.map((c, i) => <ConditionPart key={i} c={c} path={[...path, i]} index={i} tag={i ? 'and' : undefined} />)}</>;
}

function AddCondition({ path, text = 'Add a condition' }: { path: Path; text?: string }) {
  const { pick, push, ctx } = useEd();
  return <AddButton text={text} onPress={() => pick({ type: 'list', title: 'Add a condition', options: CONDITION_KINDS, onPick: k => { animateLayout(); push(path, newCondition(k as Condition['kind'], ctx)); } })} />;
}

function ConditionPart({ c, path, index, tag, fixed }: { c: Condition; path: Path; index: number; tag?: string; fixed?: boolean }) {
  const { set, ctx, home } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  let body: ReactNode = null;
  if (isGroup(c)) {
    body = (
      <Nest title={c.kind === 'not' ? 'None of these may hold' : undefined}>
        {c.conditions.map((x, i) => <ConditionPart key={i} c={x} path={[...path, 'conditions', i]} index={i} tag={i ? (c.kind === 'any' ? 'or' : c.kind === 'not' ? 'nor' : 'and') : undefined} />)}
        <AddCondition path={[...path, 'conditions']} text="Add to this group" />
      </Nest>
    );
  } else switch (c.kind) {
    case 'device': body = (<>
      <DeviceChoice value={c.device} onChange={v => f('device', v)} />
      <Field label="Is"><Select label="Is" value={stateKey(c.is)} options={stateOptions(c.is)} onChange={v => f('is', stateFromKey(v) ?? { on: true })} /></Field>
    </>); break;
    case 'numeric': body = (<>
      <DeviceChoice value={c.device} onChange={v => f('device', v)} />
      <Field label="Reading"><Select label="Reading" value={c.field} options={withCurrent(FIELDS, c.field)} onChange={v => f('field', v)} /></Field>
      <Field label="Above"><Num label="Above" optional value={c.above} onChange={v => f('above', v)} /></Field>
      <Field label="Below"><Num label="Below" optional value={c.below} onChange={v => f('below', v)} /></Field>
    </>); break;
    case 'time': body = (<>
      <Field label="From">
        <Segs value={c.after ? 'on' : ''} options={[{ v: '', label: 'Any time' }, { v: 'on', label: 'A time' }]} onChange={v => f('after', v ? { kind: 'time', at: '18:00' } : undefined)} />
        {c.after ? <RhythmField label="From" value={c.after} onChange={r => f('after', r)} /> : null}
      </Field>
      <Field label="Until">
        <Segs value={c.before ? 'on' : ''} options={[{ v: '', label: 'Any time' }, { v: 'on', label: 'A time' }]} onChange={v => f('before', v ? { kind: 'time', at: '23:00' } : undefined)} />
        {c.before ? <RhythmField label="Until" value={c.before} onChange={r => f('before', r)} /> : null}
      </Field>
      <DayChips days={c.days} onChange={d => f('days', d)} />
    </>); break;
    case 'presence': body = (<>
      <Field label="Who"><Select label="Who" value={c.who} options={withCurrent([{ v: 'anyone', label: 'Anyone' }, { v: 'no-one', label: 'No one' }, ...home.people.map(p => ({ v: p.id, label: p.name }))], c.who)} onChange={v => f('who', v)} /></Field>
      <Segs value={c.home === false ? 'out' : 'home'} options={[{ v: 'home', label: 'Is home' }, { v: 'out', label: 'Is out' }]} onChange={v => f('home', v === 'home')} />
    </>); break;
    case 'mode': body = (
      <Field label="In any of these modes">
        <Chips items={home.modes} on={id => c.modes.includes(id)} onToggle={id => f('modes', toggleIn(c.modes, id))} />
      </Field>
    ); break;
    case 'room': body = (<>
      <Field label="In"><Select label="Room" value={c.room} options={withCurrent(home.rooms.map(r => ({ v: r.id, label: r.name })), c.room)} onChange={v => f('room', v)} /></Field>
      <Segs value={c.active === false ? 'still' : 'active'} options={[{ v: 'active', label: 'Some activity' }, { v: 'still', label: 'All still' }]} onChange={v => f('active', v === 'active')} />
      <Field label="In the last"><Num label="Minutes" min={1} max={1440} value={c.withinMin ?? 10} onChange={v => f('withinMin', v ?? 10)} unit="min" /></Field>
    </>); break;
    case 'overlay': body = (<>
      <Field label="Overlay"><Select label="Overlay" value={c.overlay ?? ''} options={withCurrent([{ v: '', label: 'Any overlay' }, ...home.overlays.map(o => ({ v: o.id, label: o.name }))], c.overlay)} onChange={v => f('overlay', v || undefined)} /></Field>
      <Segs value={c.active === false ? 'off' : 'on'} options={[{ v: 'on', label: 'Is on' }, { v: 'off', label: 'Is off' }]} onChange={v => f('active', v === 'on')} />
    </>); break;
  }
  return (
    <Part path={path} index={index} tag={tag} what="condition" kind={c.kind} kinds={CONDITION_KINDS} canRemove={!fixed} onKind={k => set(path, changeKind(c, newCondition(k as Condition['kind'], ctx)))}>
      {body}
    </Part>
  );
}

function ActionList({ list, path }: { list: Action[]; path: Path }) {
  return <>{list.map((a, i) => <ActionPart key={i} a={a} path={[...path, i]} index={i} />)}</>;
}

function AddAction({ path }: { path: Path }) {
  const { pick, push, ctx } = useEd();
  return <AddButton text="Add a step" onPress={() => pick({ type: 'list', title: 'Add a step', options: ACTION_KINDS, onPick: k => { animateLayout(); push(path, newAction(k as Action['kind'], ctx)); } })} />;
}

function Targets({ a, path }: { a: Extract<Action, { kind: 'set' }>; path: Path }) {
  const { set, remove, home } = useEd();
  const dev = (id: string) => home.devices.find(d => d.id === id);
  const entries = Object.entries(a.targets);
  return (
    <View style={{ gap: 8 }}>
      {entries.map(([id, cmd]) => (
        <View key={id} style={{ gap: 6, padding: 10, borderRadius: 12, backgroundColor: C.card }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ flex: 1 }}>
              <DeviceChoice value={id} only={canSet} onChange={v => set([...path, 'targets'], retarget(a.targets, id, v, firstCommand(dev(v), home.sources)))} />
            </View>
            <Press onPress={() => { animateLayout(); remove([...path, 'targets', id]); }} label={`Remove ${deviceLabel(id, home.devices, home.rooms)}`} style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
              <Icon name="close" size={18} color={C.stone} />
            </Press>
          </View>
          <Select label="Set to" value={commandKey(cmd)} options={commandChoices(dev(id), home.sources, cmd)} onChange={v => set([...path, 'targets', id], commandFromKey(v))} />
        </View>
      ))}
      {!entries.length ? <T size={12.5} color={C.stone}>No devices yet.</T> : null}
      <AddButton text="Add a device" onPress={() => {
        const free = home.devices.find(d => canSet(d) && !(d.id in a.targets));
        if (free) { animateLayout(); set([...path, 'targets', free.id], firstCommand(free, home.sources)); }
      }} />
    </View>
  );
}

function Delay({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const [unit, setUnit] = useState<Unit>(splitSeconds(seconds).unit);
  const n = unit === 'h' ? seconds / 3600 : unit === 'min' ? seconds / 60 : seconds;
  return (
    <View style={{ gap: 8 }}>
      <Num label="How long" min={0} value={Math.round(n * 100) / 100} onChange={v => onChange(toSeconds(v ?? 0, unit))} />
      <Segs value={unit} options={[{ v: 's', label: 'Seconds' }, { v: 'min', label: 'Minutes' }, { v: 'h', label: 'Hours' }]} onChange={u => { setUnit(u); onChange(toSeconds(n, u)); }} />
    </View>
  );
}

function ActionPart({ a, path, index }: { a: Action; path: Path; index: number }) {
  const { set, ctx, home, self } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  let body: ReactNode = null;
  switch (a.kind) {
    case 'set': body = <Targets a={a} path={path} />; break;
    case 'delay': body = <Delay seconds={a.seconds} onChange={s => f('seconds', s)} />; break;
    case 'wait': body = (<>
      <Nest title="Until">
        <ConditionPart c={a.until} path={[...path, 'until']} index={0} fixed />
      </Nest>
      <Field label="At most"><Num label="Minutes at most" optional min={0} value={secToMin(a.timeoutSec)} onChange={v => f('timeoutSec', minToSec(v))} unit="min" /></Field>
      <Field label="If it never happens">
        <Segs value={a.stopOnTimeout ? 'stop' : 'carry'} options={[{ v: 'carry', label: 'Carry on anyway' }, { v: 'stop', label: 'Stop' }]} onChange={v => f('stopOnTimeout', v === 'stop' ? true : undefined)} />
      </Field>
    </>); break;
    case 'notify': body = (<>
      <Field label="Title"><TextBox label="Title" value={a.title ?? ''} placeholder="Optional" onChange={v => f('title', v || undefined)} /></Field>
      <Field label="Message"><TextBox label="Message" value={a.message} placeholder="What it says" multiline onChange={v => f('message', v)} /></Field>
      <Field label="To">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Pill label="Everyone" on={!(a.people ?? []).length} onPress={() => f('people', undefined)} />
          {home.people.map(p => <Pill key={p.id} label={p.name} on={(a.people ?? []).includes(p.id)} onPress={() => { const l = toggleIn(a.people, p.id); f('people', l.length ? l : undefined); }} />)}
        </View>
      </Field>
    </>); break;
    case 'overlay': body = (<>
      <Segs value={a.op} options={[{ v: 'start', label: 'Start' }, { v: 'end', label: 'End' }]} onChange={v => f('op', v)} />
      <Field label="Overlay"><Select label="Overlay" value={a.overlay} options={withCurrent(home.overlays.map(o => ({ v: o.id, label: o.name })), a.overlay)} onChange={v => f('overlay', v)} /></Field>
    </>); break;
    case 'if': body = (<>
      <Nest title="If">
        <ConditionList list={a.conditions} path={[...path, 'conditions']} />
        <AddCondition path={[...path, 'conditions']} />
      </Nest>
      <Nest title="Then">
        <ActionList list={a.then} path={[...path, 'then']} />
        <AddAction path={[...path, 'then']} />
      </Nest>
      <Nest title="Otherwise">
        <ActionList list={a.else ?? []} path={[...path, 'else']} />
        <AddAction path={[...path, 'else']} />
      </Nest>
    </>); break;
    case 'repeat': body = (<>
      <Field label="Times"><Num label="Times" min={1} max={100} value={a.times} onChange={v => f('times', v ?? 1)} /></Field>
      <Nest title="Do">
        <ActionList list={a.actions} path={[...path, 'actions']} />
        <AddAction path={[...path, 'actions']} />
      </Nest>
    </>); break;
    case 'run': body = <Field label="Automation"><Select label="Automation" value={a.automation} options={withCurrent(home.automations.filter(x => x.id !== self).map(x => ({ v: x.id, label: x.name })), a.automation)} onChange={v => f('automation', v)} /></Field>; break;
    case 'stop': body = <T size={12.5} color={C.stone}>Nothing after this runs.</T>; break;
  }
  return (
    <Part path={path} index={index} what="action" kind={a.kind} kinds={ACTION_KINDS} onKind={k => { if (k !== a.kind) set(path, newAction(k as Action['kind'], ctx)); }}>
      {body}
    </Part>
  );
}

// ------------------------------------------------------------- sheets -----

function ListSheet({ p, close }: { p: Extract<Picker, { type: 'list' }>; close: () => void }) {
  return (
    <View style={{ gap: 4 }}>
      <T size={18} weight={700} style={{ marginBottom: 6 }}>{p.title}</T>
      {p.options.map(o => {
        const on = o.v === (p.value ?? '');
        return (
          <Press key={o.v} haptic="select" label={o.label} onPress={() => { p.onPick(o.v); close(); }}
            style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: on ? C.amberTint : 'transparent' }}>
            <T size={15} weight={on ? 700 : 500} color={on ? C.amber : C.bone} style={{ flex: 1 }}>{o.label}</T>
            {on ? <Icon name="check" size={20} color={C.amber} /> : null}
          </Press>
        );
      })}
    </View>
  );
}

function DeviceSheet({ p, close }: { p: Extract<Picker, { type: 'device' }>; close: () => void }) {
  const { home } = useEd();
  const [q, setQ] = useState('');
  const sections = deviceSections(home.devices.filter(d => !d.hidden || d.id === p.value), home.rooms, q, p.only);
  return (
    <View style={{ gap: 12 }}>
      <T size={18} weight={700}>{p.title}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
        <Icon name="search" size={20} color={C.stone2} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search devices or rooms" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search devices"
          style={{ flex: 1, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
        {q ? <Press onPress={() => setQ('')} label="Clear search" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
      </View>
      {sections.map(s => (
        <View key={s.room} style={{ gap: 2 }}>
          <Label>{s.room}</Label>
          {s.items.map(o => {
            const on = o.v === p.value;
            return (
              <Press key={o.v} haptic="select" label={`${s.room} ${o.label}`} onPress={() => { p.onPick(o.v); close(); }}
                style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, backgroundColor: on ? C.amberTint : 'transparent' }}>
                <T size={15} weight={on ? 700 : 500} color={on ? C.amber : C.bone} style={{ flex: 1 }}>{o.label}</T>
                {on ? <Icon name="check" size={20} color={C.amber} /> : null}
              </Press>
            );
          })}
        </View>
      ))}
      {!sections.length ? <T size={13} color={C.stone}>{q ? `Nothing called “${q}”.` : 'No devices here yet.'}</T> : null}
    </View>
  );
}

function TimeSheet({ p, close }: { p: Extract<Picker, { type: 'time' }>; close: () => void }) {
  const [[h, m], setHM] = useState(parseClock(p.value));
  const mins = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!mins.includes(m)) mins.push(m), mins.sort((a, b) => a - b);
  const cell = (label: string, on: boolean, fn: () => void, a11y: string) => (
    <Press key={label} haptic="select" label={a11y} onPress={fn} style={{ width: '14.8%', height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.amber : C.control }}>
      <T mono size={14} color={on ? C.onAmber : C.bone}>{label}</T>
    </Press>
  );
  const grid = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6 };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T size={18} weight={700}>{p.title}</T>
        <T mono size={28} color={C.amber} accessibilityLiveRegion="polite">{clockOf(h, m)}</T>
      </View>
      <Label>Hour</Label>
      <View style={grid}>{Array.from({ length: 24 }, (_, i) => cell(String(i).padStart(2, '0'), i === h, () => setHM([i, m]), `${i} hours`))}</View>
      <Label>Minute</Label>
      <View style={grid}>{mins.map(i => cell(String(i).padStart(2, '0'), i === m, () => setHM([h, i]), `${i} minutes`))}</View>
      <Button label={`Set ${clockOf(h, m)}`} onPress={() => { p.onPick(clockOf(h, m)); close(); }} />
    </View>
  );
}

/** A yes-or-no in a sheet: delete, discard changes. */
export function Confirm({ open, title, text, yes, no = 'Cancel', danger, onYes, onClose }: { open: boolean; title: string; text?: string; yes: string; no?: string; danger?: boolean; onYes: () => void; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <View style={{ gap: 6 }}>
        <T size={19} weight={700}>{title}</T>
        {text ? <T size={13.5} color={C.stone} lineHeight={1.45}>{text}</T> : null}
      </View>
      <View style={{ gap: 8 }}>
        <Press onPress={() => { onYes(); }} label={yes} style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: danger ? alpha(C.red, 0.16) : C.amber }}>
          <T size={15} weight={700} color={danger ? C.red : C.onAmber}>{yes}</T>
        </Press>
        <Button kind="secondary" label={no} onPress={onClose} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------- history ----

function History({ runs, loading }: { runs: AutomationRun[]; loading: boolean }) {
  if (!runs.length) return <T size={13} color={C.stone}>{loading ? 'Reading its history…' : 'It hasn’t run yet. Runs show here, with each step.'}</T>;
  return (
    <View style={{ gap: 10 }}>
      {runs.map((r, i) => {
        const [label, colour] = RESULT[r.result] ?? ['', C.stone];
        return (
          <Appear key={r.id} index={i} style={{ borderRadius: 16, backgroundColor: C.card, padding: 14, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: alpha(colour, 0.15) }}><T size={11.5} weight={800} color={colour}>{label}</T></View>
              <T size={13.5} weight={600} style={{ flex: 1 }} numberOfLines={2}>{r.why}</T>
              <T mono size={11.5} color={C.stone}>{runTime(r.at)}</T>
            </View>
            {r.detail ? <T size={12.5} color={r.result === 'failed' ? C.red : C.stone}>{r.detail}</T> : null}
            {r.steps.length ? (
              <View style={{ gap: 5, paddingTop: 2 }}>
                {r.steps.map((st, j) => (
                  <View key={j} style={{ flexDirection: 'row', gap: 8 }} accessible accessibilityLabel={`${st.ok ? 'Done' : 'Failed'}: ${st.text}${st.detail ? `. ${st.detail}` : ''}`}>
                    <Icon name={st.ok ? 'check' : 'error'} size={16} color={st.ok ? C.green : C.red} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T size={12.5} color={st.ok ? C.bone2 : C.red}>{st.text}</T>
                      {st.detail ? <T size={11.5} color={C.stone}>{st.detail}</T> : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </Appear>
        );
      })}
    </View>
  );
}

// --------------------------------------------------------------- screen ---

export function AutomationEditor() {
  const route = useRoute<RouteProp<Stack, 'AutomationEditor'>>();
  const params = route.params ?? {};
  const s = useSnap();
  const { api, say } = useHub();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const all = automationsOf(s);
  const [id, setId] = useState<string | undefined>(params.id);
  const live = id ? all.find(a => a.id === id) : undefined;
  const [saved, setSaved] = useState<Draft>(() => draftOf(params.draft ?? live ?? null));
  const [draft, setDraft] = useState<Draft>(saved);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(!!id);
  const [tab, setTab] = useState<'edit' | 'history'>(params.tab ?? 'edit');
  const [pick, setPick] = useState<Picker | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'run'>('');
  const [guard, setGuard] = useState<NavigationAction | null>(null);
  /** Leaving on purpose (saved, or changes discarded): the guard stands down, then the screen goes. */
  const [exit, setExit] = useState<NavigationAction | 'back' | null>(null);
  const scroll = useRef<ScrollView>(null);
  const dirty = !sameDraft(draft, saved);
  const fresh = !id;

  // The hub's copy and its history. The draft follows it until the first change.
  const load = useCallback(async (first = false) => {
    if (!id) return;
    try {
      const r = await api<{ automation: Draft & { id: string }; runs: AutomationRun[] }>('GET', `/api/automations/${encodeURIComponent(id)}`);
      setRuns(r.runs ?? []);
      if (first) {
        const d = draftOf(r.automation);
        setSaved(prev => { setDraft(cur => (sameDraft(cur, prev) ? d : cur)); return d; });
      }
    } catch (e) { if (first) say((e as Error).message, { error: true }); }
    finally { setLoadingRuns(false); }
  }, [id, api, say]);
  useEffect(() => { void load(true); }, [load]);
  // A new run (from a trigger, or Run now on another screen) shows up in the history as it happens.
  const runMark = live ? `${live.lastRun?.at ?? 0}:${live.lastRun?.result ?? ''}:${live.running}` : '';
  const firstMark = useRef(true);
  useEffect(() => { if (firstMark.current) { firstMark.current = false; return; } void load(); }, [runMark, load]);

  const home = useMemo<Home>(() => ({ devices: s.devices, rooms: s.rooms, people: s.people, modes: s.modes, overlays: s.overlays, automations: all, sources: s.sources }), [s.devices, s.rooms, s.people, s.modes, s.overlays, all, s.sources]);
  const ctx = useMemo(() => ctxOf({ ...home, self: id }), [home, id]);
  const ed = useMemo<Ed>(() => ({
    draft, home, ctx, self: id,
    set: (p, v) => { setDraft(d => setAt(d, p, v)); setErr(null); },
    remove: p => setDraft(d => removeAt(d, p)),
    move: (p, dir) => setDraft(d => moveAt(d, p, dir)),
    push: (p, v) => setDraft(d => pushAt(d, p, v)),
    pick: p => setPick(p),
  }), [draft, home, ctx, id]);

  // Leaving with changes asks first.
  usePreventRemove(dirty && !exit, ({ data }) => setGuard(data.action));
  useEffect(() => { if (exit === 'back') nav.goBack(); else if (exit) nav.dispatch(exit); }, [exit, nav]);

  const save = async () => {
    if (busy) return;
    const body = bodyOf(draft);
    if (!body.name) { setErr('Give it a name'); haptic.error(); scroll.current?.scrollTo({ y: 0, animated: true }); return; }
    setBusy('save');
    try {
      const r = id
        ? await api<{ id?: string; undo?: string }>('PUT', `/api/automations/${encodeURIComponent(id)}`, body)
        : await api<{ id?: string; undo?: string }>('POST', '/api/automations', body);
      haptic.success();
      say(id ? `${body.name} saved` : `${body.name} added`, { undo: r?.undo });
      setSaved(draft);
      if (!id && r?.id) setId(r.id);
      setExit('back');
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      say(m, { error: true });
      scroll.current?.scrollTo({ y: 0, animated: true });
    } finally { setBusy(''); }
  };

  const run = async (check: boolean) => {
    if (!id || busy) return;
    setBusy('run');
    try {
      const r = await startRun(api<RunAnswer>('POST', `/api/automations/${encodeURIComponent(id)}/run${check ? '?check=1' : ''}`));
      const m = runMessage(draft.name || 'It', r);
      if (m.ok) haptic.success();
      say(m.text, { error: m.error });
      animateLayout();
      setTab('history');
      await load();
    } catch (e) { say((e as Error).message, { error: true }); }
    finally { setBusy(''); }
  };

  const notes = draft.origin?.notes ?? [];
  const sec = (title: string, sub: string) => (
    <View style={{ gap: 2, marginTop: 6 }}>
      <T size={20} weight={700} tracking={-0.01} accessibilityRole="header">{title}</T>
      <T size={12.5} color={C.stone}>{sub}</T>
    </View>
  );

  return (
    <EdCtx.Provider value={ed}>
      <View style={{ flex: 1, backgroundColor: C.page }}>
        <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 18, paddingBottom: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: C.hairline, backgroundColor: C.page }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Press onPress={() => nav.goBack()} label="Back" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.control2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="arrow_back" size={21} />
            </Press>
            <View style={{ flex: 1 }}>
              <T size={12} color={C.stone}>{fresh ? 'New automation' : dirty ? 'Edited · not saved yet' : 'Automation'}</T>
              <T size={19} weight={700} numberOfLines={1}>{draft.name || (fresh ? 'New automation' : 'Untitled')}</T>
            </View>
            <Press onPress={() => void save()} disabled={!fresh && !dirty} label={fresh ? 'Add automation' : 'Save'}
              style={{ minHeight: 40, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 12, backgroundColor: C.amber }}>
              <T size={14} weight={800} color={C.onAmber}>{busy === 'save' ? 'Saving…' : fresh ? 'Add' : 'Save'}</T>
            </Press>
          </View>
          {id ? (
            <View style={{ flexDirection: 'row', gap: 6, padding: 4, borderRadius: 12, backgroundColor: C.card }} accessibilityRole="tablist">
              {(['edit', 'history'] as const).map(k => (
                <Press key={k} haptic="select" label={k === 'edit' ? 'Edit' : 'History'} onPress={() => { animateLayout(); setTab(k); }}
                  style={{ flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: tab === k ? C.selected : 'transparent' }}>
                  <T size={13.5} weight={700} color={tab === k ? C.bone : C.stone}>{k === 'edit' ? 'Edit' : `History${runs.length ? ` · ${runs.length}` : ''}`}</T>
                </Press>
              ))}
            </View>
          ) : null}
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 120, gap: 14 }}>
            {tab === 'history' && id ? (
              <>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}><Button label={busy === 'run' ? 'Running…' : 'Run now'} icon="play_arrow" onPress={() => void run(false)} /></View>
                  <View style={{ flex: 1 }}><Button kind="secondary" label="Check, then run" icon="fact_check" onPress={() => void run(true)} /></View>
                </View>
                <T size={12} color={C.stone}>{dirty ? 'Runs the saved version, not your changes. ' : ''}Run now skips its conditions; Check, then run stops if one doesn’t hold.</T>
                <History runs={runs} loading={loadingRuns} />
              </>
            ) : (
              <>
                {err ? (
                  <View accessibilityLiveRegion="assertive" style={{ flexDirection: 'row', gap: 10, padding: 14, borderRadius: 14, backgroundColor: alpha(C.red, 0.12), borderWidth: 1, borderColor: alpha(C.red, 0.3) }}>
                    <Icon name="error" size={19} color={C.red} fill />
                    <T size={13.5} weight={600} color={C.red} style={{ flex: 1 }} lineHeight={1.4}>{err}</T>
                  </View>
                ) : null}
                {notes.length ? (
                  <View style={{ gap: 6, padding: 14, borderRadius: 14, backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                      <Icon name="info" size={18} color={C.amber} />
                      <T size={13.5} weight={700} color={C.amber}>Converted from Home Assistant: left out</T>
                    </View>
                    {notes.map((n, i) => <T key={i} size={12.5} color={C.bone2} lineHeight={1.4}>{`· ${n}`}</T>)}
                  </View>
                ) : null}

                <Field label="Name"><TextBox label="Name" value={draft.name} placeholder="e.g. Porch light at sunset" onChange={v => ed.set(['name'], v)} /></Field>
                <Field label="Description"><TextBox label="Description" value={draft.description ?? ''} placeholder="Optional: what it’s for" multiline onChange={v => ed.set(['description'], v || undefined)} /></Field>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: C.card }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T size={14.5} weight={700}>{draft.enabled ? 'On' : 'Off'}</T>
                    <T size={12} color={C.stone}>{draft.enabled ? 'Runs when something starts it' : 'Kept, but doesn’t run'}</T>
                  </View>
                  <Switch on={draft.enabled} onChange={v => ed.set(['enabled'], v)} label="Automation on" />
                </View>
                <Field label="If it’s already running">
                  <Segs value={draft.mode} options={RUN_MODES} onChange={v => ed.set(['mode'], v)} />
                </Field>

                {sec('When', 'Any one of these starts it')}
                {draft.triggers.map((t, i) => <TriggerPart key={i} t={t} path={['triggers', i]} index={i} />)}
                <AddButton text="Add a trigger" onPress={() => setPick({ type: 'list', title: 'Add a trigger', options: TRIGGER_KINDS, onPick: k => { animateLayout(); ed.push(['triggers'], newTrigger(k as Trigger['kind'], ctx)); } })} />

                {sec('Only if', draft.conditions.length ? 'All of these have to hold' : 'Always: no conditions')}
                <ConditionList list={draft.conditions} path={['conditions']} />
                <AddCondition path={['conditions']} />

                {sec('Then', 'These steps, in order')}
                <ActionList list={draft.actions} path={['actions']} />
                <AddAction path={['actions']} />

                {id ? (
                  <View style={{ marginTop: 10 }}>
                    <Button kind="secondary" icon="play_arrow" label={busy === 'run' ? 'Running…' : dirty ? 'Run the saved version now' : 'Run now'} onPress={() => void run(false)} />
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>

        <Sheet open={!!pick} onClose={() => setPick(null)}>
          {pick?.type === 'list' ? <ListSheet p={pick} close={() => setPick(null)} />
            : pick?.type === 'device' ? <DeviceSheet key={pick.title + pick.value} p={pick} close={() => setPick(null)} />
              : pick?.type === 'time' ? <TimeSheet key={pick.value} p={pick} close={() => setPick(null)} /> : null}
        </Sheet>
        <Confirm open={!!guard} title="Leave without saving?" text="Your changes to this automation will be lost." yes="Discard changes" no="Keep editing" danger
          onClose={() => setGuard(null)} onYes={() => { const a = guard; setGuard(null); if (a) setExit(a); }} />
      </View>
    </EdCtx.Provider>
  );
}
