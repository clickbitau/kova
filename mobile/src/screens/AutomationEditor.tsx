import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventRemove, useRoute, type NavigationAction, type RouteProp } from '@react-navigation/native';
import { C, F, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav, type Stack } from '../navigation';
import type { Adhan, Clip, Command, Device, PrayerView, Room, RoomStatus, SpeakerGroup } from '../api/types';
import {
  ACTION_KINDS, CONDITION_KINDS, DAYS, DAY_NAMES, FIELD_UNIT, KIND_ICON, MONTH_NAMES, PRESENCE_EVENTS, RAMP_FIELDS, RESULT, RUN_MODES, STATION_KEY, TITLE_KEY, TRIGGER_KINDS,
  addMinutes, actionText, automationsOf, bodyOf, canMove, canRamp, canSet, carryCommand, changeActionKind, changeKind, clockOf, conditionText, ctxOf, dateOf, dayOn,
  deviceLabel, deviceSections, draftOf, draftSummary, duplicateAt, EVENTS, eventsFor, extrasOf, fieldDefault, fieldsFor, firstCommand, freeFields, isGroup, isOneTime, labelOf,
  localNowOf, matchFields, mediaChoices, mediaFromKey, mediaKey, minToSec, monthGrid, moveAt, newAction, newCondition, newTrigger, onceAt, onceChips, onceProblem, onceState, onceWords,
  parseClock, parseStamp, presets, pseudoTargets, pushAt, readingsFor, removeAt, retarget, rhythmFromKey, rhythmKey, runMessage, runTime, sameCommand, sameDraft, scheduleDraft,
  scheduleName, secToMin, setAt, shiftMonth, splitSeconds, stampOf, startRun, targetInfo, timeOf, toSeconds, toggleDay, toggleIn, triggerText, untilWords, withCurrent, withField,
  withMatch, withOffset, zonesOf, ACTIVE_MIN, roomEventsFor, roomNote, roomOptions, roomProblem, withinProblem, readingRooms, readingSourceLabel, roomReadingsFor, zoneTargets, ROOM_FIELDS,
  type Action, type AutomationRun, type CmdField, type Condition, type Ctx, type Draft, type MusicItem, type Names, type Opt, type Path, type RampField, type RunAnswer, type Rhythm,
  type StateMatch, type TargetInfo, type Trigger, type Unit,
  SONG_KEY, URL_KEY, announceMediaFromKey, announceMediaKey, announceMediaName, announceProblem, announceSaveProblem, announceSpeakers, calibratedVol,
  isSpeakerGroup, missingPrayers, pauseChoices, rhythmChoices, targetLevel, targetSpeakers, trimOf, withEveryPrayer, type AnnounceAction, type AnnounceTarget,
} from '../logic/automations';
import { prayerOn } from '../logic/prayer';
import { CLIP_TYPES, clipFileProblem, clipName } from '../logic/media';
import { AdhanCredit } from './PrayerTimesScreen';
import { EV_ICON } from '../logic/sensors';
import { Icon } from '../ui/Icon';
import { Button, IconWell, Pill, Press, Segmented, Sheet, Switch } from '../ui/kit';
import { Appear, animateLayout, haptic } from '../ui/motion';
import { T } from '../ui/Text';
import { FindingCard } from './FindingCard';

// The automation editor, full screen. A live summary in plain words up top, then When / Only if / Then as cards
// that nest (groups of conditions, if / otherwise, repeat, wait until), so anything the assistant can build can
// be built here by hand: every field a device can be set to, state matches, readings, events, ramps, one-time
// schedules. Choices open a sheet (a list, devices and groups by room with search, a clock, a calendar). The
// History tab shows each run, step by step. The tree logic is in logic/automations.ts, under test.

// --------------------------------------------------------------- pickers --

type Only = (d: Pick<Device, 'type' | 'capabilities' | 'kind'>) => boolean;
type Picker =
  | { type: 'list'; title: string; options: Opt[]; value?: string; onPick: (v: string) => void; note?: string }
  | { type: 'device'; title: string; value?: string; only?: Only; groups?: boolean; zones?: boolean; readings?: boolean; onPick: (v: string) => void }
  | { type: 'time'; title: string; value: string; onPick: (v: string) => void }
  | { type: 'datetime'; title: string; value: string; onPick: (v: string) => void }
  | { type: 'menu'; title: string; items: { icon: string; label: string; danger?: boolean; disabled?: boolean; run: () => void }[] }
  /** What an announcement plays: sources, clips (and uploading one), the built-in calls to prayer, a song, a web address. */
  | { type: 'media'; title: string; value?: string; onPick: (v: string) => void; same?: string };

interface Home {
  devices: Device[]; rooms: Room[]; roomStatus?: Record<string, RoomStatus>; people: { id: string; name: string }[]; modes: { id: string; name: string }[]; overlays: { id: string; name: string }[];
  automations: { id: string; name: string }[]; sources: { name: string }[]; music: MusicItem[]; now: string;
  speakerGroups: SpeakerGroup[]; clips: Clip[]; adhans: Adhan[]; prayer?: PrayerView; prayerOn: boolean;
}

interface Ed {
  draft: Draft;
  set(p: Path, v: unknown): void;
  remove(p: Path): void;
  move(p: Path, d: -1 | 1): void;
  push(p: Path, v: unknown): void;
  dup(p: Path): void;
  pick(p: Picker): void;
  home: Home;
  names: Names;
  ctx: Ctx;
  self?: string;
}
const EdCtx = createContext<Ed | null>(null);
const useEd = () => useContext(EdCtx)!;

// ----------------------------------------------------------------- bits ---

/** A small label over a control. */
function Label({ children, color = C.stone2 }: { children: string; color?: string }) {
  return <T v="overline" size={11} color={color}>{children}</T>;
}

function Field({ label, children, note }: { label?: string; children: ReactNode; note?: string }) {
  return (
    <View style={{ gap: 6 }}>
      {label ? <Label>{label}</Label> : null}
      {children}
      {note ? <T v="footnote" size={11.5} color={C.stone2}>{note}</T> : null}
    </View>
  );
}

/** A choice that opens a sheet: shows what's chosen, with a chevron. */
function Choice({ text, onPress, label, muted, icon }: { text: string; onPress: () => void; label: string; muted?: boolean; icon?: string }) {
  return (
    <Press onPress={onPress} label={`${label}: ${text}`} haptic="select" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingLeft: 12, paddingRight: 8, borderRadius: R.sm + 2, backgroundColor: C.control }}>
      {icon ? <Icon name={icon} size={18} color={muted ? C.stone2 : C.amber} /> : null}
      <T v="label" weight={600} color={muted ? C.stone : C.bone} style={{ flex: 1 }} numberOfLines={2}>{text}</T>
      <Icon name="expand_more" size={20} color={C.stone2} />
    </Press>
  );
}

/** Pick one from a list, through the sheet. */
function Select({ label, value, options, onChange, empty, icon }: { label: string; value?: string; options: Opt[]; onChange: (v: string) => void; empty?: string; icon?: string }) {
  const { pick } = useEd();
  const cur = options.find(o => o.v === (value ?? ''));
  return <Choice label={label} icon={icon} text={cur?.label ?? (value || empty || 'Choose')} muted={!cur} onPress={() => pick({ type: 'list', title: label, options, value, onPick: onChange })} />;
}

/**
 * A device (or group) to pick. `zones`: rooms' air conditioner zones too ("Lounge zone"). `readings`: what a reading
 * comes from, so rooms with a temperature are offered too ("room:lounge", the room's own reading).
 */
function DeviceChoice({ value, onChange, only, label = 'Device', groups, zones, readings }: { value: string; onChange: (v: string) => void; only?: Only; label?: string; groups?: boolean; zones?: boolean; readings?: boolean }) {
  const { pick, home } = useEd();
  const room = readings && value.startsWith('room:');
  const info = targetInfo(value, home.devices, home.rooms);
  const icon = room ? 'meeting_room' : info.type === 'zone' ? 'ac_unit' : info.pseudo ? 'category' : 'devices';
  const text = room ? readingSourceLabel(value, home.devices, home.rooms) : deviceLabel(value, home.devices, home.rooms);
  const missing = room ? !home.rooms.some(r => `room:${r.id}` === value) : info.missing;
  return <Choice label={label} icon={icon} text={text} muted={missing} onPress={() => pick({ type: 'device', title: label, value, only, groups, zones, readings, onPick: onChange })} />;
}

type Reading = NonNullable<Parameters<typeof readingsFor>[1]>;
/** The reading a numeric trigger or condition compares, from what it reads: a room's readings, or a device's. */
function ReadingSelect({ device, value, onChange }: { device: string; value: Reading; onChange: (v: Reading) => void }) {
  const { home } = useEd();
  const options = device.startsWith('room:') ? roomReadingsFor(home.roomStatus?.[device.slice(5)], value) : readingsFor(home.devices.find(d => d.id === device), value);
  return <Select label="Reading" value={value} options={options} onChange={v => onChange(v as Reading)} />;
}

/** Pills for a few choices that wrap (modes, inputs, fan speeds). */
function Pills<V extends string>({ value, options, onChange, any }: { value: V | undefined; options: Opt<V>[]; onChange: (v: V | undefined) => void; any?: string }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {any ? <Pill label={any} on={value === undefined || value === ''} onPress={() => onChange(undefined)} /> : null}
      {options.map(o => <Pill key={o.v} label={o.label} on={o.v === value} onPress={() => onChange(o.v)} />)}
    </View>
  );
}

/** Two or three choices on the app's sliding segmented control. */
function Segs<V extends string>({ value, options, onChange, label }: { value: V | null; options: Opt<V>[]; onChange: (v: V) => void; label: string }) {
  return <Segmented compact label={label} value={value} options={options.map(o => ({ id: o.v, label: o.label }))} onChange={v => onChange(v as V)} />;
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
    <Press onPress={() => bump(d)} label={`${a11y} ${label}`} style={{ width: 40, height: 40, borderRadius: R.sm + 2, backgroundColor: C.control, alignItems: 'center', justifyContent: 'center' }}>
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
        style={{ width: 76, height: 40, paddingHorizontal: 6, borderRadius: R.sm + 2, backgroundColor: C.inset, color: C.bone, fontFamily: F[700], fontSize: 15, textAlign: 'center', borderWidth: 1, borderColor: C.line }} />
      {btn(step, 'add', 'More')}
      {unit ? <T v="footnote" color={C.stone}>{unit}</T> : null}
    </View>
  );
}

function TextBox({ value, onChange, placeholder, label, multiline, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; multiline?: boolean; autoFocus?: boolean }) {
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone3} accessibilityLabel={label} multiline={multiline} autoFocus={autoFocus}
      style={{ minHeight: multiline ? 72 : 44, paddingVertical: 11, paddingHorizontal: 12, borderRadius: R.sm + 2, backgroundColor: C.inset, color: C.bone, fontFamily: F[500], fontSize: 15, borderWidth: 1, borderColor: C.line, textAlignVertical: multiline ? 'top' : 'center' }} />
  );
}

function TimeChoice({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { pick } = useEd();
  return (
    <Press onPress={() => pick({ type: 'time', title: label, value, onPick: onChange })} label={`${label}: ${value}`} haptic="select"
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.sm + 2, backgroundColor: C.control, alignSelf: 'flex-start' }}>
      <Icon name="schedule" size={18} color={C.amber} />
      <T mono size={16} color={C.bone}>{value}</T>
    </Press>
  );
}

/** A clock time, a sun time or a prayer time, with minutes before or after for the moving ones. */
function RhythmField({ value, onChange, label }: { value: Rhythm | undefined; onChange: (r: Rhythm) => void; label: string }) {
  const { home } = useEd();
  const r = value ?? { kind: 'time', at: '21:00' };
  return (
    <View style={{ gap: 8 }}>
      <Select label={label} value={rhythmKey(r)} options={rhythmChoices(home.prayerOn, r)} onChange={k => onChange(rhythmFromKey(k, r))} icon={r.kind === 'time' ? 'schedule' : r.kind === 'sun' ? 'wb_twilight' : 'mosque'} />
      {r.kind === 'time'
        ? <TimeChoice label={label} value={r.at} onChange={at => onChange({ kind: 'time', at })} />
        : <Num label="Minutes after (minus for before)" value={r.offsetMin ?? 0} step={5} min={-240} max={240} unit={(r.offsetMin ?? 0) < 0 ? 'min before' : 'min after'} onChange={v => onChange(withOffset(r, v ?? 0))} />}
    </View>
  );
}

function DayChips({ days, onChange }: { days?: number[]; onChange: (d: number[] | undefined) => void }) {
  const picked = !!days && days.length > 0;
  return (
    <Field label="Days" note={picked ? 'Only on the days lit' : 'Every day: tap a day to leave it out'}>
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {DAYS.map((l, i) => {
          const on = dayOn(days, i);
          return (
            <Press key={i} haptic="select" label={`${DAY_NAMES[i]}${on ? ', on' : ', off'}`} onPress={() => onChange(toggleDay(days, i))}
              style={{ flex: 1, height: 38, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: on && picked ? C.amber : on ? C.selected : 'transparent', borderWidth: 1, borderColor: on ? 'transparent' : C.line }}>
              <T v="labelSm" color={on && picked ? C.onAmber : on ? C.bone : C.stone3}>{l}</T>
            </Press>
          );
        })}
      </View>
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

/** A length of time: a number and seconds / minutes / hours. `optional`: empty means none. */
function Duration({ seconds, onChange, label, optional, min = 0 }: { seconds: number | undefined; onChange: (s: number | undefined) => void; label: string; optional?: boolean; min?: number }) {
  const [unit, setUnit] = useState<Unit>(seconds ? splitSeconds(seconds).unit : 'min');
  const n = seconds == null ? undefined : unit === 'h' ? seconds / 3600 : unit === 'min' ? seconds / 60 : seconds;
  return (
    <View style={{ gap: 8 }}>
      <Num label={label} optional={optional} min={min} value={n == null ? undefined : Math.round(n * 100) / 100} onChange={v => onChange(v == null ? undefined : toSeconds(v, unit))} />
      <Segs label={`${label} in`} value={unit} options={[{ v: 's', label: 'Seconds' }, { v: 'min', label: 'Minutes' }, { v: 'h', label: 'Hours' }]} onChange={u => { setUnit(u); if (n != null) onChange(toSeconds(n, u)); }} />
    </View>
  );
}

/** A note inside a card: a hint, or a problem to fix (tone red). */
function Hint({ text, tone = 'stone', icon = 'info' }: { text: string; tone?: 'stone' | 'red' | 'amber' | 'green'; icon?: string }) {
  const c = tone === 'red' ? C.red : tone === 'amber' ? C.amber : tone === 'green' ? C.green : C.stone;
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <Icon name={icon} size={16} color={c} />
      <T v="footnote" color={c} style={{ flex: 1 }}>{text}</T>
    </View>
  );
}

/** Under a room choice: the cameras and sensors that report there, or that nothing does yet. */
function RoomNote({ room }: { room: string }) {
  const { home } = useEd();
  const n = roomNote(room, home.devices);
  return n ? <Hint tone={n.warn ? 'amber' : 'stone'} icon={n.warn ? 'warning' : 'sensors'} text={n.text} /> : null;
}

// ------------------------------------------------------------- the tree ---

const SUB: Record<string, string> = { trigger: 'trigger', condition: 'condition', action: 'step' };
/** Rails for what sits inside a part: the colour says what it is. */
const RAIL: Record<string, string> = { if: C.amber, then: C.green, else: C.stone2, repeat: C.blue, any: C.blue, all: C.green, not: C.red, until: C.amber };

/**
 * One part (a trigger, condition or step): an icon and its kind (tap to change it), a chevron that folds it to
 * one line in words, and a menu (move, duplicate, remove). Then its fields and anything nested.
 */
function Part({ path, tag, kind, kinds, onKind, what, canRemove = true, children, index = 0, words, problem }: { path: Path; tag?: string; kind: string; kinds: Opt[]; onKind: (k: string) => void; what: 'trigger' | 'condition' | 'action'; canRemove?: boolean; children?: ReactNode; index?: number; words: string; problem?: string }) {
  const { draft, move, remove, dup, pick } = useEd();
  const [folded, setFolded] = useState(false);
  const kindLabel = labelOf(kinds, kind);
  const menu = () => pick({
    type: 'menu', title: kindLabel, items: [
      { icon: 'arrow_upward', label: 'Move up', disabled: !canMove(draft, path, -1), run: () => { animateLayout(); move(path, -1); } },
      { icon: 'arrow_downward', label: 'Move down', disabled: !canMove(draft, path, 1), run: () => { animateLayout(); move(path, 1); } },
      { icon: 'content_copy', label: 'Duplicate', run: () => { animateLayout(); dup(path); } },
      { icon: 'delete', label: `Remove this ${SUB[what]}`, danger: true, run: () => { animateLayout(); remove(path); } },
    ],
  });
  return (
    <Appear index={index}>
      {tag ? (
        <View style={{ alignItems: 'flex-start', paddingLeft: 14, marginTop: -2, marginBottom: 6 }}>
          <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: R.full, backgroundColor: C.control }}><T v="micro" color={C.stone} upper>{tag}</T></View>
        </View>
      ) : null}
      <View style={{ borderRadius: R.md + 2, backgroundColor: C.inset, padding: 12, gap: 12, borderWidth: 1, borderColor: problem ? alpha(C.red, 0.45) : C.hairline }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconWell icon={KIND_ICON[`${what}:${kind}`] ?? 'tune'} color={what === 'trigger' ? C.amber : what === 'condition' ? C.blue : C.green} size={30} />
          <Press onPress={() => pick({ type: 'list', title: `What kind of ${SUB[what]}`, options: kinds, value: kind, onPick: onKind })} label={`Kind of ${SUB[what]}: ${kindLabel}`} haptic="select"
            style={{ flex: 1, minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <T v="headline" size={14.5} style={{ flexShrink: 1 }} numberOfLines={3}>{kindLabel}</T>
            <Icon name="expand_more" size={18} color={C.stone2} />
          </Press>
          <Press onPress={() => { animateLayout(); setFolded(f => !f); }} haptic="select" label={folded ? 'Show the details' : 'Fold to one line'} style={{ width: 34, height: 34, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
            <Icon name="expand_more" size={20} color={C.bone2} style={{ transform: [{ rotate: folded ? '0deg' : '180deg' }] }} />
          </Press>
          {canRemove ? (
            <Press onPress={menu} haptic="select" label={`More for this ${SUB[what]}`} style={{ width: 34, height: 34, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
              <Icon name="more_horiz" size={20} color={C.bone2} />
            </Press>
          ) : null}
        </View>
        {folded ? <T v="footnote" color={C.bone2} numberOfLines={3}>{words}</T> : children}
        {problem && !folded ? <Hint tone="red" icon="error" text={problem} /> : null}
      </View>
    </Appear>
  );
}

/** What sits inside a group, an if or a repeat: a coloured rail and a caption saying what it is. */
function Nest({ title, rail, children }: { title?: string; rail: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: alpha(rail, 0.55), marginLeft: 2 }}>
      {title ? <Label color={rail}>{title}</Label> : null}
      {children}
    </View>
  );
}

function AddButton({ text, onPress }: { text: string; onPress: () => void }) {
  return (
    <Press onPress={onPress} label={text} haptic="select" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: R.sm + 2, borderWidth: 1, borderStyle: 'dashed', borderColor: C.amberLine }}>
      <Icon name="add" size={18} color={C.amber} />
      <T v="labelSm" color={C.amber}>{text}</T>
    </Press>
  );
}

/** Which parts of a device's state to look for: each one any, or a value. */
function MatchBuilder({ device, value, onChange, required }: { device: string; value: StateMatch | undefined; onChange: (m: StateMatch | undefined) => void; required?: boolean }) {
  const { home } = useEd();
  const d = home.devices.find(x => x.id === device);
  const fields = matchFields(d, value ?? {});
  return (
    <View style={{ gap: 10, padding: 10, borderRadius: R.sm + 2, backgroundColor: C.card }}>
      {fields.map(f => (
        <View key={f.key} style={{ gap: 6 }}>
          <Label>{f.label}</Label>
          {f.kind === 'bool'
            ? <Segs label={f.label} value={value?.[f.key] === undefined ? 'any' : value[f.key] ? 'yes' : 'no'} options={[{ v: 'any', label: 'Any' }, { v: 'yes', label: f.yes! }, { v: 'no', label: f.no! }]}
                onChange={v => onChange(withMatch(value, f.key, v === 'any' ? undefined : v === 'yes'))} />
            : <Pills any="Any" value={value?.[f.key] as string | undefined} options={f.options ?? []} onChange={v => onChange(withMatch(value, f.key, v))} />}
        </View>
      ))}
      {required && !value ? <Hint tone="amber" text="Choose at least one thing to look for." /> : null}
    </View>
  );
}

/** "Changes from": folded away until it's wanted (most triggers only care what a device changes to). */
function FromField({ device, value, onChange }: { device: string; value: StateMatch | undefined; onChange: (m: StateMatch | undefined) => void }) {
  const [open, setOpen] = useState(!!value);
  if (!open && !value) {
    return (
      <Press onPress={() => { animateLayout(); setOpen(true); }} haptic="select" label="Also say what it changes from" style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="add" size={18} color={C.amber} />
        <T v="labelSm" color={C.amber}>Only when it changes from…</T>
      </Press>
    );
  }
  return (
    <Field label="Changes from">
      <MatchBuilder device={device} value={value} onChange={onChange} />
      <Press onPress={() => { animateLayout(); onChange(undefined); setOpen(false); }} haptic="select" label="Any state before" style={{ minHeight: 36, justifyContent: 'center' }}>
        <T v="footnote" color={C.stone}>Clear: from any state</T>
      </Press>
    </Field>
  );
}

function OnceField({ t, path }: { t: Extract<Trigger, { kind: 'once' }>; path: Path }) {
  const { set, pick, home } = useEd();
  const st = onceState(t, home.now);
  const choose = (at: string) => { haptic.select(); set(path, onceAt(at)); };
  const valid = !!parseStamp(t.at);
  return (
    <View style={{ gap: 12 }}>
      <Press onPress={() => pick({ type: 'datetime', title: 'When, once', value: t.at, onPick: choose })} label={`Date and time: ${valid ? onceWords(t.at, home.now) : 'choose'}`} haptic="select"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: R.md, backgroundColor: st === 'upcoming' ? C.amberTint : C.card, borderWidth: 1, borderColor: st === 'upcoming' ? C.amberLine : C.edge }}>
        <IconWell icon="timer" color={st === 'upcoming' ? C.amber : C.stone} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="heading" size={17} color={st === 'upcoming' ? C.bone : C.stone}>{valid ? onceWords(t.at, home.now).replace(/^./, c => c.toUpperCase()) : 'Choose a date and time'}</T>
          <T v="footnote" color={st === 'upcoming' ? C.amber : st === 'done' ? C.green : C.red}>
            {st === 'done' ? 'Done: it went off' : st === 'missed' ? 'Missed: Kova was off then' : st === 'passed' ? 'That time has passed: choose a later one' : untilWords(t.at, home.now)}
          </T>
        </View>
        <Icon name="edit" size={18} color={C.stone2} />
      </Press>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {onceChips(home.now).map(c => <Pill key={c.label} label={c.label} icon="schedule" on={c.at === t.at} onPress={() => choose(c.at)} />)}
      </View>
      <T v="footnote" size={11.5} color={C.stone2}>On the home’s clock. It runs once, then switches itself off.</T>
    </View>
  );
}

function TriggerPart({ t, path, index }: { t: Trigger; path: Path; index: number }) {
  const { set, ctx, home, names } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  const dev = 'device' in t ? home.devices.find(d => d.id === t.device) : undefined;
  let body: ReactNode = null, problem: string | undefined;
  switch (t.kind) {
    case 'device': body = (<>
      <DeviceChoice value={t.device} onChange={v => f('device', v)} />
      <Field label="Changes to"><MatchBuilder device={t.device} value={t.to} onChange={m => f('to', m)} /></Field>
      <FromField device={t.device} value={t.from} onChange={m => f('from', m)} />
      <Field label="And stays so for"><Num label="Minutes it stays so" optional min={0} value={secToMin(t.forSec)} onChange={v => f('forSec', minToSec(v))} unit="min" /></Field>
    </>); if (!t.to && !t.from) problem = 'Say what it changes to (or from).'; break;
    case 'numeric': body = (<>
      <DeviceChoice readings value={t.device} label="Device or room" onChange={v => set(path, { ...t, device: v, ...(v.startsWith('room:') && !ROOM_FIELDS.includes(t.field) ? { field: 'temp' } : {}) })} />
      <Field label="Reading"><ReadingSelect device={t.device} value={t.field} onChange={v => f('field', v)} /></Field>
      <Field label="Goes above"><Num label="Above" optional value={t.above} unit={FIELD_UNIT[t.field]} onChange={v => f('above', v)} /></Field>
      <Field label="Or goes below"><Num label="Below" optional value={t.below} unit={FIELD_UNIT[t.field]} onChange={v => f('below', v)} /></Field>
      <Field label="For"><Num label="Minutes" optional min={0} value={secToMin(t.forSec)} onChange={v => f('forSec', minToSec(v))} unit="min" /></Field>
    </>); if (t.above == null && t.below == null) problem = 'Give a value to go above or below.'; else if (t.above != null && t.below != null && t.above >= t.below) problem = '“Above” has to be less than “below”.'; break;
    case 'event': {
      const known = EVENTS.some(e => e.v === t.event);
      body = (<>
        <DeviceChoice value={t.device} onChange={v => f('device', v)} />
        <Field label="When it"><Select label="Event" value={known ? t.event : '__other'} options={[...eventsFor(dev, known ? t.event : undefined), { v: '__other', label: 'Something else (type its name)…' }]} onChange={v => f('event', v === '__other' ? (known ? '' : t.event) : v)} /></Field>
        {!known ? <Field label="Event name" note="As the device sends it, e.g. “doorbell-pressed”."><TextBox label="Event name" value={t.event} placeholder="event-name" onChange={v => f('event', v)} /></Field> : null}
      </>);
      if (!t.event.trim()) problem = 'Choose the event.';
      break;
    }
    case 'room': {
      const events = roomEventsFor(t.room, home.devices, t.event);
      body = (<>
        <Field label="In"><Select label="Room" icon="meeting_room" value={t.room} options={roomOptions(home.rooms, t.room)}
          onChange={v => { const ev = roomEventsFor(v, home.devices); set(path, { ...t, room: v, event: ev.some(e => e.v === t.event) ? t.event : ev[0]!.v }); }} /></Field>
        <Field label="When there’s"><Select label="What happens" icon={EV_ICON[t.event] ?? 'sensors'} value={t.event} options={events} onChange={v => f('event', v)} /></Field>
        <RoomNote room={t.room} />
      </>);
      problem = roomProblem(t.room, home.rooms);
      break;
    }
    case 'time': body = (<>
      <RhythmField label="At" value={t.at} onChange={r => f('at', r)} />
      <DayChips days={t.days} onChange={d => f('days', d)} />
    </>); break;
    case 'once': body = <OnceField t={t} path={path} />; break;
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
      <Segs label="Starts or ends" value={t.event} options={[{ v: 'starts', label: 'Starts' }, { v: 'ends', label: 'Ends' }]} onChange={v => f('event', v)} />
    </>); break;
    case 'hub': body = <T v="footnote" color={C.stone}>When Kova starts: after an update or a power cut.</T>; break;
  }
  return (
    <Part path={path} index={index} tag={index ? 'or' : undefined} what="trigger" kind={t.kind} kinds={TRIGGER_KINDS} words={triggerText(t, names)} problem={problem}
      onKind={k => set(path, changeKind(t, newTrigger(k as Trigger['kind'], ctx), home))}>
      {body}
    </Part>
  );
}

function ConditionList({ list, path, join = 'and' }: { list: Condition[]; path: Path; join?: string }) {
  return <>{list.map((c, i) => <ConditionPart key={i} c={c} path={[...path, i]} index={i} tag={i ? join : undefined} />)}</>;
}

function AddCondition({ path, text = 'Add a condition' }: { path: Path; text?: string }) {
  const { pick, push, ctx } = useEd();
  return <AddButton text={text} onPress={() => pick({ type: 'list', title: text, options: CONDITION_KINDS, onPick: k => { animateLayout(); push(path, newCondition(k as Condition['kind'], ctx)); } })} />;
}

const GROUP_TITLE = { any: 'Any one of these', all: 'All of these', not: 'None of these may hold' } as const;
function ConditionPart({ c, path, index, tag, fixed }: { c: Condition; path: Path; index: number; tag?: string; fixed?: boolean }) {
  const { set, ctx, home, names } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  let body: ReactNode = null, problem: string | undefined;
  if (isGroup(c)) {
    body = (
      <Nest title={GROUP_TITLE[c.kind]} rail={RAIL[c.kind]}>
        <ConditionList list={c.conditions} path={[...path, 'conditions']} join={c.kind === 'any' ? 'or' : c.kind === 'not' ? 'nor' : 'and'} />
        <AddCondition path={[...path, 'conditions']} text="Add to this group" />
      </Nest>
    );
    if (!c.conditions.length) problem = 'A group needs at least one condition.';
  } else switch (c.kind) {
    case 'device': body = (<>
      <DeviceChoice value={c.device} onChange={v => f('device', v)} />
      <Field label="Is"><MatchBuilder required device={c.device} value={c.is} onChange={m => f('is', m)} /></Field>
    </>); if (!c.is) problem = 'Say what state it has to be in.'; break;
    case 'numeric': {
      body = (<>
        <DeviceChoice readings value={c.device} label="Device or room" onChange={v => set(path, { ...c, device: v, ...(v.startsWith('room:') && !ROOM_FIELDS.includes(c.field) ? { field: 'temp' } : {}) })} />
        <Field label="Reading"><ReadingSelect device={c.device} value={c.field} onChange={v => f('field', v)} /></Field>
        <Field label="Above"><Num label="Above" optional value={c.above} unit={FIELD_UNIT[c.field]} onChange={v => f('above', v)} /></Field>
        <Field label="Below"><Num label="Below" optional value={c.below} unit={FIELD_UNIT[c.field]} onChange={v => f('below', v)} /></Field>
      </>);
      if (c.above == null && c.below == null) problem = 'Give a value to be above or below.'; else if (c.above != null && c.below != null && c.above >= c.below) problem = '“Above” has to be less than “below”.';
      break;
    }
    case 'time': body = (<>
      <Field label="From">
        <Segs label="From" value={c.after ? 'on' : 'any'} options={[{ v: 'any', label: 'Any time' }, { v: 'on', label: 'A time' }]} onChange={v => f('after', v === 'on' ? { kind: 'time', at: '18:00' } : undefined)} />
        {c.after ? <RhythmField label="From" value={c.after} onChange={r => f('after', r)} /> : null}
      </Field>
      <Field label="Until">
        <Segs label="Until" value={c.before ? 'on' : 'any'} options={[{ v: 'any', label: 'Any time' }, { v: 'on', label: 'A time' }]} onChange={v => f('before', v === 'on' ? { kind: 'time', at: '23:00' } : undefined)} />
        {c.before ? <RhythmField label="Until" value={c.before} onChange={r => f('before', r)} /> : null}
      </Field>
      <DayChips days={c.days} onChange={d => f('days', d)} />
    </>); if (!c.after && !c.before && !c.days) problem = 'Choose times or days.'; break;
    case 'presence': body = (<>
      <Field label="Who"><Select label="Who" value={c.who} options={withCurrent([{ v: 'anyone', label: 'Anyone' }, { v: 'no-one', label: 'No one' }, ...home.people.map(p => ({ v: p.id, label: p.name }))], c.who)} onChange={v => f('who', v)} /></Field>
      <Segs label="Home or out" value={c.home === false ? 'out' : 'home'} options={[{ v: 'home', label: 'Is home' }, { v: 'out', label: 'Is out' }]} onChange={v => f('home', v === 'home')} />
    </>); break;
    case 'mode': body = (
      <Field label="In any of these modes">
        <Chips items={[...home.modes, ...c.modes.filter(m => !home.modes.some(x => x.id === m)).map(m => ({ id: m, name: m }))]} on={id => c.modes.includes(id)} onToggle={id => f('modes', toggleIn(c.modes, id))} />
      </Field>
    ); if (!c.modes.length) problem = 'Choose at least one mode.'; break;
    case 'room': body = (<>
      <Field label="In"><Select label="Room" icon="meeting_room" value={c.room} options={roomOptions(home.rooms, c.room)} onChange={v => f('room', v)} /></Field>
      <Segs label="Activity or still" value={c.active === false ? 'still' : 'active'} options={[{ v: 'active', label: 'Some activity' }, { v: 'still', label: 'All still' }]} onChange={v => f('active', v === 'active')} />
      <Field label={c.active === false ? 'For at least' : 'In the last'} note="A person, motion, the doorbell, or a door or window opening or closing.">
        <Num label="Minutes" min={1} max={1440} value={c.withinMin ?? ACTIVE_MIN} onChange={v => f('withinMin', v ?? ACTIVE_MIN)} unit="min" />
      </Field>
      <RoomNote room={c.room} />
    </>); problem = roomProblem(c.room, home.rooms) ?? withinProblem(c.withinMin); break;
    case 'overlay': body = (<>
      <Field label="Overlay"><Select label="Overlay" value={c.overlay ?? ''} options={withCurrent([{ v: '', label: 'Any overlay' }, ...home.overlays.map(o => ({ v: o.id, label: o.name }))], c.overlay)} onChange={v => f('overlay', v || undefined)} /></Field>
      <Segs label="On or off" value={c.active === false ? 'off' : 'on'} options={[{ v: 'on', label: 'Is on' }, { v: 'off', label: 'Is off' }]} onChange={v => f('active', v === 'on')} />
    </>); break;
  }
  return (
    <Part path={path} index={index} tag={tag} what="condition" kind={c.kind} kinds={CONDITION_KINDS} canRemove={!fixed} words={conditionText(c, names)} problem={problem}
      onKind={k => set(path, changeKind(c, newCondition(k as Condition['kind'], ctx), home))}>
      {body}
    </Part>
  );
}

function ActionList({ list, path }: { list: Action[]; path: Path }) {
  return <>{list.map((a, i) => <ActionPart key={i} a={a} path={[...path, i]} index={i} tag={i ? 'then' : undefined} />)}</>;
}

function AddAction({ path, text = 'Add a step' }: { path: Path; text?: string }) {
  const { pick, push, ctx } = useEd();
  return <AddButton text={text} onPress={() => pick({ type: 'list', title: 'Add a step', options: ACTION_KINDS, onPick: k => { animateLayout(); push(path, newAction(k as Action['kind'], ctx)); } })} />;
}

// --------------------------------------------------------- set devices ---

const SWATCHES = ['#ffb46b', '#ffffff', '#ff5a4f', '#ff9f43', '#ffd84d', '#5ee08a', '#4fd6e6', '#4f8cff', '#a06bff', '#ff6bd0'];

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {SWATCHES.map(c => (
          <Press key={c} haptic="select" label={`Colour ${c}`} selected={value?.toLowerCase() === c} onPress={() => onChange(c)}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, borderWidth: value?.toLowerCase() === c ? 3 : 1, borderColor: value?.toLowerCase() === c ? C.bone : C.line }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: /^#[0-9a-f]{6}$/i.test(text) ? text : C.control, borderWidth: 1, borderColor: C.line }} />
        <View style={{ flex: 1 }}>
          <TextBox label="Colour as #rrggbb" value={text} placeholder="#rrggbb" onChange={v => { setText(v); if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v.toLowerCase()); }} />
        </View>
      </View>
    </View>
  );
}

function MediaField({ value, info, onChange }: { value: string | null | undefined; info: TargetInfo; onChange: (v: string | null) => void }) {
  const { home } = useEd();
  const k = mediaKey(value, info, home.sources, home.music);
  const options = mediaChoices(info, home.sources, home.music, value);
  return (
    <View style={{ gap: 8 }}>
      <Select label="Play" icon="play_arrow" value={k} options={options} onChange={nk => onChange(mediaFromKey(nk, value))} />
      {k === STATION_KEY ? (
        <Field label="Station from" note="An artist, album or song: Helix plays more like it.">
          <TextBox label="Station from" value={(value ?? '').replace(/^Station: /, '')} placeholder="e.g. Nina Simone" onChange={v => onChange(`Station: ${v}`)} />
        </Field>
      ) : null}
      {k === TITLE_KEY ? (
        <Field label="Title" note="Kova finds it in the library and plays it here.">
          <TextBox label="Film or show title" value={value ?? ''} placeholder="A film or show" onChange={v => onChange(v)} />
        </Field>
      ) : null}
    </View>
  );
}

function ZonesField({ value, info, onChange }: { value: Command['zoneSet']; info: TargetInfo; onChange: (v: Command['zoneSet']) => void }) {
  const zones = zonesOf(info, value);
  const z = value ?? {};
  const put = (n: string, s: { on?: boolean; open?: number } | undefined) => { const o = { ...z }; if (s) o[n] = s; else delete o[n]; onChange(o); };
  if (!zones.length) return <Hint text="No zones reported yet." />;
  return (
    <View style={{ gap: 10 }}>
      {zones.map(({ n, name }) => {
        const s = z[n];
        const v = !s ? 'leave' : s.on === false ? 'off' : s.on === true ? 'on' : null;
        return (
          <View key={n} style={{ gap: 6 }}>
            <T v="labelSm" color={C.bone2}>{name}</T>
            <Segs label={name} value={v} options={[{ v: 'leave', label: 'Leave' }, { v: 'on', label: 'On' }, { v: 'off', label: 'Off' }]}
              onChange={x => put(n, x === 'leave' ? undefined : x === 'off' ? { on: false } : { on: true, open: s?.open ?? 100 })} />
            {s && s.on !== false ? <Num label={`${name} open`} min={0} max={100} step={5} unit="% open" value={s.open} optional onChange={o => put(n, { ...s, ...(o == null ? { open: undefined } : { open: o }) })} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function ExtrasField({ value, info, onChange }: { value: Command['extras']; info: TargetInfo; onChange: (v: Record<string, boolean | number | string | null> | undefined) => void }) {
  const ex = extrasOf(info, value ?? undefined);
  const cur = { ...(value ?? {}) } as Record<string, boolean | number | string | null>;
  const put = (k: string, v: boolean | number | string | undefined) => { const o = { ...cur }; if (v === undefined) delete o[k]; else o[k] = v; onChange(Object.keys(o).length ? o : undefined); };
  return (
    <View style={{ gap: 10 }}>
      {ex.map(e => (
        <View key={e.key} style={{ gap: 6 }}>
          <T v="labelSm" color={C.bone2}>{e.key}</T>
          {e.kind === 'bool'
            ? <Segs label={e.key} value={!(e.key in cur) ? 'leave' : cur[e.key] ? 'on' : 'off'} options={[{ v: 'leave', label: 'Leave' }, { v: 'on', label: 'On' }, { v: 'off', label: 'Off' }]} onChange={x => put(e.key, x === 'leave' ? undefined : x === 'on')} />
            : e.kind === 'number'
              ? <Num label={e.key} optional value={typeof cur[e.key] === 'number' ? cur[e.key] as number : undefined} onChange={v => put(e.key, v)} />
              : <TextBox label={e.key} value={typeof cur[e.key] === 'string' ? cur[e.key] as string : ''} placeholder="Leave as it is" onChange={v => put(e.key, v || undefined)} />}
        </View>
      ))}
    </View>
  );
}

/** One field of a command: its control and a remove button. */
function FieldRow({ spec, value, info, onChange, onRemove }: { spec: CmdField; value: unknown; info: TargetInfo; onChange: (v: unknown) => void; onRemove: () => void }) {
  let control: ReactNode = null;
  switch (spec.kind) {
    case 'bool': control = <Segs label={spec.label} value={value ? 'yes' : 'no'} options={[{ v: 'yes', label: spec.yes ?? 'Yes' }, { v: 'no', label: spec.no ?? 'No' }]} onChange={v => onChange(v === 'yes')} />; break;
    case 'number': control = <Num label={spec.label} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} value={typeof value === 'number' ? value : undefined} onChange={v => onChange(v ?? spec.min ?? 0)} />; break;
    case 'choice': {
      const numeric = spec.key === 'skip' || spec.key === 'volStep';
      control = <Pills value={value == null ? undefined : String(value)} options={spec.options ?? []} onChange={v => v !== undefined && onChange(numeric ? Number(v) : v)} />;
      break;
    }
    case 'color': control = <ColorField value={typeof value === 'string' ? value : ''} onChange={onChange} />; break;
    case 'media': control = <MediaField value={value as string | null | undefined} info={info} onChange={onChange} />; break;
    case 'zones': control = <ZonesField value={value as Command['zoneSet']} info={info} onChange={onChange} />; break;
    case 'extras': control = <ExtrasField value={value as never} info={info} onChange={v => (v === undefined ? onRemove() : onChange(v))} />; break;
  }
  return (
    <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={spec.icon} size={17} color={C.stone} />
        <T v="labelSm" color={C.bone2} style={{ flex: 1 }}>{spec.label}</T>
        <Press onPress={() => { animateLayout(); onRemove(); }} haptic="select" label={`Leave ${spec.label} as it is`} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
          <Icon name="close" size={16} color={C.stone} />
        </Press>
      </View>
      {control}
    </View>
  );
}

/** What one device (or group) is set to: a field per setting, quick presets, and the settings it could add. */
function CommandEditor({ id, cmd, onChange }: { id: string; cmd: Command; onChange: (c: Command) => void }) {
  const { home } = useEd();
  const info = targetInfo(id, home.devices, home.rooms);
  const fields = fieldsFor(info, cmd).filter(f => f.key in cmd);
  const free = freeFields(info, cmd);
  const quick = presets(info, home.sources, home.music);
  const c = cmd as Record<string, unknown>;
  return (
    <View style={{ gap: 10 }}>
      {quick.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {quick.map(([q, label]) => <Pill key={label} label={label} on={sameCommand(q, cmd)} onPress={() => { animateLayout(); onChange(q); }} />)}
        </View>
      ) : null}
      {fields.map(f => <FieldRow key={f.key} spec={f} value={c[f.key]} info={info} onChange={v => onChange(withField(cmd, f.key, v))} onRemove={() => onChange(withField(cmd, f.key, undefined))} />)}
      {!fields.length ? <Hint tone="amber" text="Nothing to change yet: add a setting." /> : null}
      {free.length ? (
        <View style={{ gap: 6, paddingTop: 4 }}>
          <Label>Add a setting</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {free.map(f => <Pill key={f.key} icon="add" label={f.label} onPress={() => { animateLayout(); onChange(withField(cmd, f.key, fieldDefault(f.key, info, home.sources, home.music))); }} />)}
          </View>
        </View>
      ) : null}
      {info.type === 'zone' ? (info.devices.length
        ? <T v="footnote" size={11.5} color={C.stone2}>{`The zone serving ${info.label.replace(/ zone$/, '')}, on ${info.devices.map(d => d.name).join(' and ')}. Closing the last open zone turns the air conditioner off.`}</T>
        : <Hint tone="amber" text="No zone serves this room now. Choose a zone’s rooms in the air conditioner’s panel." />) : null}
      {info.pseudo && info.type !== 'zone' ? <T v="footnote" size={11.5} color={C.stone2}>{`Every matching device, including ones added later. Each takes only what it can do.${info.devices.length ? ` Now: ${info.devices.length} device${info.devices.length === 1 ? '' : 's'}.` : ''}`}</T> : null}
    </View>
  );
}

function TargetsEditor({ a, path }: { a: Extract<Action, { kind: 'set' }>; path: Path }) {
  const { set, remove, home } = useEd();
  const entries = Object.entries(a.targets);
  const swap = (id: string, v: string) => {
    const to = targetInfo(v, home.devices, home.rooms);
    set([...path, 'targets'], retarget(a.targets, id, v, carryCommand(a.targets[id] ?? {}, to, home.sources, home.music)));
  };
  return (
    <View style={{ gap: 8 }}>
      {entries.map(([id, cmd]) => (
        <View key={id} style={{ gap: 10, padding: 10, borderRadius: R.sm + 2, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ flex: 1 }}>
              <DeviceChoice value={id} only={canSet} groups zones onChange={v => swap(id, v)} />
            </View>
            <Press onPress={() => { animateLayout(); remove([...path, 'targets', id]); }} haptic="select" label={`Remove ${deviceLabel(id, home.devices, home.rooms)}`} style={{ width: 34, height: 34, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
              <Icon name="close" size={18} color={C.stone} />
            </Press>
          </View>
          <CommandEditor id={id} cmd={cmd} onChange={c => set([...path, 'targets', id], c)} />
        </View>
      ))}
      {!entries.length ? <Hint tone="amber" text="Add a device (or a group, like all lights) to set." /> : null}
      <AddDevice zones targets={a.targets} onAdd={v => { animateLayout(); set([...path, 'targets', v], firstCommand(targetInfo(v, home.devices, home.rooms), home.sources, home.music)); }} />
    </View>
  );
}

function AddDevice({ targets, onAdd, only = canSet, text = 'Add a device or group', zones }: { targets: Record<string, unknown>; onAdd: (id: string) => void; only?: Only; text?: string; zones?: boolean }) {
  const { pick } = useEd();
  return <AddButton text={text} onPress={() => pick({ type: 'device', title: text, groups: true, zones, only: d => only(d), onPick: v => { if (!(v in targets)) onAdd(v); } })} />;
}

function RampEditor({ a, path }: { a: Extract<Action, { kind: 'ramp' }>; path: Path }) {
  const { set, remove, home } = useEd();
  const ids = Object.keys(a.targets);
  const only: Only = d => canSet(d as Pick<Device, 'type'>) && canRamp(d as Pick<Device, 'capabilities'>, a.field);
  const withTo = (targets: Record<string, Command>, field: RampField, to: number, old?: RampField) => Object.fromEntries(Object.entries(targets).map(([id, c]) => {
    const x = { ...(c as Record<string, unknown>) };
    if (old && old !== field) delete x[old];
    x[field] = to;
    return [id, x as Command];
  }));
  const put = (p: Partial<Extract<Action, { kind: 'ramp' }>>) => {
    const n = { ...a, ...p };
    set(path, { ...n, targets: withTo(n.targets, n.field, n.to, a.field) });
  };
  const unit = a.field === 'target' ? '°C' : '%';
  return (
    <View style={{ gap: 12 }}>
      <Field label="Ease"><Segs label="Ease" value={a.field} options={RAMP_FIELDS} onChange={v => put({ field: v, to: v === 'target' ? 24 : a.to > 100 ? 100 : a.to, ...(v === 'target' && a.from != null ? { from: undefined } : {}) })} /></Field>
      <Field label="On">
        <View style={{ gap: 8 }}>
          {ids.map(id => (
            <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ flex: 1 }}><DeviceChoice value={id} only={only} groups onChange={v => set([...path, 'targets'], retarget(a.targets, id, v, { [a.field]: a.to } as Command))} /></View>
              <Press onPress={() => { animateLayout(); remove([...path, 'targets', id]); }} haptic="select" label={`Remove ${deviceLabel(id, home.devices, home.rooms)}`} style={{ width: 34, height: 34, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}>
                <Icon name="close" size={18} color={C.stone} />
              </Press>
            </View>
          ))}
          <AddDevice targets={a.targets} only={only} text="Add a device or group" onAdd={v => { animateLayout(); set([...path, 'targets', v], { [a.field]: a.to } as Command); }} />
        </View>
      </Field>
      <Field label="From (optional)" note="Empty: from where the first device is now."><Num label="Ramp from" optional value={a.from} min={a.field === 'target' ? 16 : 0} max={a.field === 'target' ? 32 : 100} step={a.field === 'target' ? 0.5 : 5} unit={unit} onChange={v => put({ from: v })} /></Field>
      <Field label="To"><Num label="Ramp to" value={a.to} min={a.field === 'target' ? 16 : 0} max={a.field === 'target' ? 32 : 100} step={a.field === 'target' ? 0.5 : 5} unit={unit} onChange={v => put({ to: v ?? 0 })} /></Field>
      <Field label="Over"><Duration label="Ramp over" min={0} seconds={a.overSec} onChange={s => put({ overSec: s ?? 60 })} /></Field>
      <Field label="A step every" note="Default: a minute."><Duration label="Step every" optional min={0} seconds={a.stepSec} onChange={s => put({ stepSec: s })} /></Field>
    </View>
  );
}

function ActionPart({ a, path, index, tag }: { a: Action; path: Path; index: number; tag?: string }) {
  const { set, ctx, home, self, names } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  let body: ReactNode = null, problem: string | undefined;
  switch (a.kind) {
    case 'set': body = <TargetsEditor a={a} path={path} />; if (!Object.keys(a.targets).length) problem = 'Choose at least one device to set.'; break;
    case 'ramp': body = <RampEditor a={a} path={path} />; if (!Object.keys(a.targets).length) problem = 'Choose what to ramp.'; else if (a.overSec < 10) problem = 'A ramp takes at least 10 seconds.'; break;
    case 'delay': body = <Duration label="How long" min={0} seconds={a.seconds} onChange={s => f('seconds', s ?? 0)} />; if (!a.seconds) problem = 'Say how long to wait.'; break;
    case 'wait': body = (<>
      <Nest title="Until" rail={RAIL.until}>
        <ConditionPart c={a.until} path={[...path, 'until']} index={0} fixed />
      </Nest>
      <Field label="At most"><Duration label="At most" optional min={0} seconds={a.timeoutSec} onChange={s => { set(path, { ...a, timeoutSec: s, ...(s ? {} : { stopOnTimeout: undefined }) }); }} /></Field>
      {a.timeoutSec ? (
        <Field label="If it never happens">
          <Segs label="If it never happens" value={a.stopOnTimeout ? 'stop' : 'carry'} options={[{ v: 'carry', label: 'Carry on anyway' }, { v: 'stop', label: 'Stop' }]} onChange={v => f('stopOnTimeout', v === 'stop')} />
        </Field>
      ) : <T v="footnote" size={11.5} color={C.stone2}>No limit: it waits as long as it takes.</T>}
    </>); break;
    case 'notify': body = (<>
      <Field label="Title"><TextBox label="Title" value={a.title ?? ''} placeholder="Optional" onChange={v => f('title', v || undefined)} /></Field>
      <Field label="Message"><TextBox label="Message" value={a.message} placeholder="What it says" multiline onChange={v => f('message', v)} /></Field>
      <Field label="To">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Pill label="Everyone" icon="group" on={!(a.people ?? []).length} onPress={() => f('people', undefined)} />
          {home.people.map(p => <Pill key={p.id} label={p.name} on={(a.people ?? []).includes(p.id)} onPress={() => { const l = toggleIn(a.people, p.id); f('people', l.length ? l : undefined); }} />)}
        </View>
      </Field>
    </>); if (!a.message.trim()) problem = 'Write the notification.'; break;
    case 'overlay': body = (<>
      <Segs label="Start or end" value={a.op} options={[{ v: 'start', label: 'Start' }, { v: 'end', label: 'End' }]} onChange={v => f('op', v)} />
      <Field label="Overlay"><Select label="Overlay" value={a.overlay} options={withCurrent(home.overlays.map(o => ({ v: o.id, label: o.name })), a.overlay)} onChange={v => f('overlay', v)} /></Field>
    </>); break;
    case 'if': body = (<>
      <Nest title="If all of these hold" rail={RAIL.if}>
        <ConditionList list={a.conditions} path={[...path, 'conditions']} />
        <AddCondition path={[...path, 'conditions']} />
      </Nest>
      <Nest title="Then" rail={RAIL.then}>
        <ActionList list={a.then} path={[...path, 'then']} />
        <AddAction path={[...path, 'then']} />
      </Nest>
      <Nest title="Otherwise" rail={RAIL.else}>
        <ActionList list={a.else ?? []} path={[...path, 'else']} />
        <AddAction path={[...path, 'else']} text="Add a step for otherwise" />
      </Nest>
    </>); if (!a.conditions.length) problem = '“If” needs at least one condition.'; else if (!a.then.length && !a.else?.length) problem = '“If” needs something to do.'; break;
    case 'repeat': body = (<>
      <Field label="Times"><Num label="Times" min={1} max={100} value={a.times} onChange={v => f('times', v ?? 1)} unit="times" /></Field>
      <Nest title={`Do, ${a.times} times`} rail={RAIL.repeat}>
        <ActionList list={a.actions} path={[...path, 'actions']} />
        <AddAction path={[...path, 'actions']} />
      </Nest>
    </>); if (!a.actions.length) problem = 'Add something to repeat.'; break;
    case 'run': body = <Field label="Automation" note="Runs its steps; its triggers and conditions are skipped."><Select label="Automation" value={a.automation} options={withCurrent(home.automations.filter(x => x.id !== self).map(x => ({ v: x.id, label: x.name })), a.automation)} onChange={v => f('automation', v)} /></Field>; if (!a.automation) problem = 'Choose the automation to run.'; break;
    case 'stop': body = <T v="footnote" color={C.stone}>Nothing after this runs.</T>; break;
    case 'announce': body = <AnnounceEditor a={a} path={path} />; problem = announceProblem(a, home); break;
  }
  return (
    <Part path={path} index={index} tag={tag} what="action" kind={a.kind} kinds={ACTION_KINDS} words={actionText(a, names).replace(/^./, c => c.toUpperCase())} problem={problem}
      onKind={k => set(path, changeActionKind(a, newAction(k as Action['kind'], ctx)))}>
      {body}
    </Part>
  );
}

// ------------------------------------------------------------ announce ---

/** What plays (the main pick, or Fajr's own): the choice, and a box for a song title or a web address. */
function AnnounceMedia({ value, onChange, label, same }: { value: string | undefined; onChange: (v: string | undefined) => void; label: string; same?: string }) {
  const { pick, home, names } = useEd();
  const k = announceMediaKey(value);
  const adhan = value?.startsWith('adhan:') ? home.adhans.find(x => x.id === value) : undefined;
  const text = value ? announceMediaName(value, names) : same ?? 'Choose what to play';
  return (
    <View style={{ gap: 8 }}>
      <Choice label={label} icon={value?.startsWith('adhan:') ? 'mosque' : value?.startsWith('clip:') ? 'graphic_eq' : 'campaign'} text={text} muted={!value && !same}
        onPress={() => pick({ type: 'media', title: label, value, same, onPick: v => onChange(v || undefined) })} />
      {k === SONG_KEY ? <TextBox label="Song title" value={(value ?? '').slice(6)} placeholder="A song’s title, from Helix" onChange={v => onChange(`Song: ${v}`)} /> : null}
      {k === URL_KEY ? <TextBox label="Web address" value={value ?? ''} placeholder="https://… an MP3 or a stream" onChange={v => onChange(v)} /> : null}
      {adhan ? <AdhanCredit a={adhan} /> : null}
    </View>
  );
}

/** One speaker of an announcement: on or off (one tap), what it plays at, its own level, and when it's left out. */
function SpeakerTarget({ a, id, path }: { a: AnnounceAction; id: string; path: Path }) {
  const { set, remove, home } = useEd();
  const t: AnnounceTarget = a.targets[id] ?? {};
  const d = home.devices.find(x => x.id === id);
  const group = isSpeakerGroup(d);
  const members = targetSpeakers(id, home.devices, home.speakerGroups);
  const level = targetLevel(a, id);
  const put = (p: Partial<AnnounceTarget>) => {
    const n: Record<string, unknown> = { ...t, ...p };
    for (const key of Object.keys(n)) if (n[key] === undefined || n[key] === false || (Array.isArray(n[key]) && !(n[key] as unknown[]).length)) delete n[key];
    set([...path, 'targets', id], n);
  };
  const on = !t.off;
  // Its own level and when it's left out fold away under one line saying what's set, so the list stays short.
  const [more, setMore] = useState(false);
  const skips = home.overlays.filter(o => (t.skipWhile ?? []).includes(o.id)).map(o => o.name);
  const extra = [t.vol != null ? `own level ${t.vol}%` : 'the level for all', skips.length ? `skips while ${skips.join(' or ')}` : ''].filter(Boolean).join(' · ');
  const room = home.rooms.find(r => r.id === d?.room)?.name;
  const sub = !on ? 'Left out for now: switch it back on any time'
    : group ? `${members.length} speaker${members.length === 1 ? '' : 's'}${room ? ` · ${room}` : ''}`
      : `${room ? `${room} · ` : ''}plays at ${calibratedVol(level, trimOf(d))}% · loudness ${trimOf(d)}%`;
  return (
    <View style={{ gap: 10, padding: 10, borderRadius: R.sm + 2, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, opacity: on ? 1 : 0.7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconWell icon={group ? 'speaker_group' : 'speaker'} color={on ? C.blue : C.stone} bg={on ? undefined : C.control} size={34} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T v="headline" size={14.5} numberOfLines={2} color={d ? C.bone : C.stone}>{d?.name ?? `${id} (missing)`}</T>
          <T v="footnote" color={on ? C.stone : C.stone2}>{sub}</T>
        </View>
        <Switch on={on} label={`${d?.name ?? id} plays it`} color={C.blue} onChange={v => { animateLayout(); put({ off: !v }); }} />
      </View>
      {on && group && members.length ? (
        <View style={{ gap: 4, paddingLeft: 44 }}>
          {members.map(m => <T key={m.id} v="footnote" color={C.stone}>{`${m.name} · plays at ${calibratedVol(level, trimOf(m))}%`}</T>)}
        </View>
      ) : null}
      {on ? (
        <Press onPress={() => { animateLayout(); setMore(m => !m); }} haptic="select" selected={more} label={`Level and skipping for ${d?.name ?? id}: ${extra}`}
          style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="tune" size={16} color={C.stone} />
          <T v="footnote" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{extra.charAt(0).toUpperCase() + extra.slice(1)}</T>
          <Icon name={more ? 'expand_less' : 'expand_more'} size={18} color={C.stone2} />
        </Press>
      ) : null}
      {on && more ? (
        <Field label="Own level" note={t.vol == null ? `Empty: the level for all (${a.vol}%)` : undefined}>
          <Num label={`${d?.name ?? id} own level`} optional min={0} max={100} step={5} unit="%" value={t.vol} onChange={v => put({ vol: v })} />
        </Field>
      ) : null}
      {on && more && home.overlays.length ? (
        <Field label="Skip while" note="Left out while any of these is on.">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {home.overlays.map(o => <Pill key={o.id} label={o.name} icon="layers" on={(t.skipWhile ?? []).includes(o.id)} onPress={() => put({ skipWhile: toggleIn(t.skipWhile, o.id) })} />)}
          </View>
        </Field>
      ) : null}
      {!on || more ? <Press onPress={() => { animateLayout(); remove([...path, 'targets', id]); }} haptic="select" label={`Remove ${d?.name ?? id} from the list`} style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
        <Icon name="close" size={16} color={C.stone} />
        <T v="footnote" color={C.stone}>Remove from the list</T>
      </Press> : null}
    </View>
  );
}

/** The announce step: what plays (and Fajr's own), the level, every speaker, what pauses, and what happens after. */
function AnnounceEditor({ a, path }: { a: AnnounceAction; path: Path }) {
  const { set, pick, home } = useEd();
  const f = (k: string, v: unknown) => set([...path, k], v);
  const ids = Object.keys(a.targets);
  const free = [...announceSpeakers(home.devices), ...home.devices.filter(d => isSpeakerGroup(d) && !d.hidden && !d.archived)].filter(d => !(d.id in a.targets));
  const players = pauseChoices(home.devices, a.pause);
  const fajrOwn = a.mediaFor?.fajr !== undefined;
  const add = () => pick({
    type: 'list', title: 'Add a speaker', options: free.map(d => ({ v: d.id, label: deviceLabel(d.id, home.devices, home.rooms) })),
    note: free.length ? undefined : 'Every speaker is in the list already.', onPick: v => { animateLayout(); set([...path, 'targets', v], {}); },
  });
  return (
    <View style={{ gap: 12 }}>
      <Field label="What to play"><AnnounceMedia label="What to play" value={a.media} onChange={v => f('media', v ?? '')} /></Field>
      {home.prayerOn || fajrOwn ? (
        <Field label="Fajr plays" note="When Fajr’s time starts it.">
          <Segs label="Fajr plays" value={fajrOwn ? 'own' : 'same'} options={[{ v: 'same', label: 'The same' }, { v: 'own', label: 'Its own' }]}
            onChange={v => f('mediaFor', v === 'own' ? { ...(a.mediaFor ?? {}), fajr: home.prayer?.adhan.fajr ?? '' } : undefined)} />
          {fajrOwn ? <AnnounceMedia label="Fajr plays" value={a.mediaFor?.fajr || undefined} onChange={v => f('mediaFor', { ...(a.mediaFor ?? {}), fajr: v ?? '' })} /> : null}
        </Field>
      ) : null}
      <Field label="Level for every speaker" note="Each speaker plays it at this × its loudness, so it sounds the same everywhere.">
        <Num label="Level" min={0} max={100} step={5} unit="%" value={a.vol} onChange={v => f('vol', v ?? 0)} />
      </Field>
      <Field label={`Speakers · ${ids.filter(id => !a.targets[id]!.off).length} of ${ids.length} on`}>
        <View style={{ gap: 8 }}>
          {ids.map(id => <SpeakerTarget key={id} a={a} id={id} path={path} />)}
          {free.length ? <AddButton text="Add a speaker" onPress={add} /> : null}
          {!ids.length && !free.length ? <Hint tone="amber" text="No speakers yet. Kova finds Google Cast and Sonos speakers by itself." /> : null}
        </View>
      </Field>
      {players.length ? (
        <Field label="Pause during it" note="They carry on after.">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {players.map(d => <Pill key={d.id} icon="pause" label={d.name} on={(a.pause ?? []).includes(d.id)} onPress={() => f('pause', toggleIn(a.pause, d.id))} />)}
          </View>
        </Field>
      ) : null}
      <Field label="Afterwards" note={a.restore === false ? 'Leave speakers idle: volumes go back; nothing starts playing again.' : 'Put everything back: each speaker’s volume, and what it was playing, carries on where it can.'}>
        <Segs label="Afterwards" value={a.restore === false ? 'idle' : 'back'} options={[{ v: 'back', label: 'Put back' }, { v: 'idle', label: 'Leave idle' }]} onChange={v => f('restore', v === 'back')} />
      </Field>
      <Field label="At most" note="Default 7 min. Then Kova puts everything back, even if it’s still playing.">
        <Duration label="At most" optional min={5} seconds={a.maxSec} onChange={sec => f('maxSec', sec)} />
      </Field>
    </View>
  );
}

/** Asks the browser for an audio file (Kova on the web). On a phone there's no file picker without a store build. */
const canUpload = Platform.OS === 'web' && typeof document !== 'undefined';
function pickAudioFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = CLIP_TYPES;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function MediaSheet({ p, close }: { p: Extract<Picker, { type: 'media' }>; close: () => void }) {
  const { home } = useEd();
  const { api, say, refresh } = useHub();
  const [busy, setBusy] = useState(false);
  const choose = (v: string) => { p.onPick(v); close(); };
  const key = announceMediaKey(p.value);
  const row = (v: string, label: string, icon: string, sub?: string, extra?: ReactNode) => {
    const on = v === (p.value ? key : '');
    return (
      <View key={v || 'same'} style={{ borderRadius: R.sm + 2, backgroundColor: on ? C.amberTint : 'transparent' }}>
        <Press haptic="select" label={label} selected={on} onPress={() => choose(announceMediaFromKey(v, p.value))}
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
          <Icon name={icon} size={18} color={on ? C.amber : C.stone} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T v="body" weight={on ? 700 : 500} color={on ? C.amber : C.bone}>{label}</T>
            {sub ? <T v="footnote" color={C.stone}>{sub}</T> : null}
          </View>
          {on ? <Icon name="check" size={20} color={C.amber} /> : null}
        </Press>
        {extra ? <View style={{ paddingLeft: 40, paddingRight: 12, paddingBottom: 6 }}>{extra}</View> : null}
      </View>
    );
  };
  const upload = async () => {
    if (busy) return;
    const file = await pickAudioFile();
    if (!file) return;
    const bad = clipFileProblem(file);
    if (bad) { say(bad, { error: true }); return; }
    setBusy(true);
    try {
      const r = await api<{ clip: Clip }>('POST', `/api/clips?name=${encodeURIComponent(clipName(file.name))}`, file, 120_000);
      await refresh();
      say(`${r.clip.name} uploaded`);
      choose(`clip:${r.clip.id}`);
    } catch (e) { say((e as Error).message, { error: true }); }
    finally { setBusy(false); }
  };
  const mins = (ms?: number) => ms ? (ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 1000)} s`) : '';
  return (
    <View style={{ gap: 12 }}>
      <T v="heading">{p.title}</T>
      {p.same ? <View style={{ gap: 2 }}>{row('', p.same, 'sync')}</View> : null}
      {home.prayerOn && home.adhans.length ? (
        <View style={{ gap: 2 }}>
          <Label>Call to prayer</Label>
          {home.adhans.map(x => row(x.id, x.title, 'mosque', [mins(x.durationMs), x.ready ? '' : 'Downloads the first time it plays'].filter(Boolean).join(' · '), <AdhanCredit a={x} />))}
        </View>
      ) : null}
      <View style={{ gap: 2 }}>
        <Label>Your clips</Label>
        {home.clips.map(c => row(`clip:${c.id}`, c.name, 'graphic_eq', mins(c.durationMs)))}
        {canUpload ? (
          <Press onPress={() => void upload()} haptic="select" label="Upload a clip" style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
            <Icon name="backup" size={18} color={C.amber} />
            <T v="body" weight={600} color={C.amber} style={{ flex: 1, minWidth: 0 }}>{busy ? 'Uploading…' : 'Upload a clip…'}</T>
          </Press>
        ) : <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 12 }}>{`${home.clips.length ? '' : 'No clips yet. '}Upload one from Kova in a browser (MP3, M4A, WAV, FLAC or Ogg, up to 15 MB).`}</T>}
      </View>
      {home.sources.length ? (
        <View style={{ gap: 2 }}>
          <Label>Sources</Label>
          {home.sources.map(x => row(x.name, x.name, 'radio'))}
        </View>
      ) : null}
      <View style={{ gap: 2 }}>
        <Label>Something else</Label>
        {home.music.length ? row(SONG_KEY, 'A song from Helix…', 'music_note') : null}
        {row(URL_KEY, 'A web address…', 'link', 'An MP3 or a stream on the web')}
      </View>
    </View>
  );
}

// ------------------------------------------------------------- sheets -----

function ListSheet({ p, close }: { p: Extract<Picker, { type: 'list' }>; close: () => void }) {
  return (
    <View style={{ gap: 4 }}>
      <T v="heading" style={{ marginBottom: 6 }}>{p.title}</T>
      {p.note ? <T v="footnote" color={C.stone} style={{ marginBottom: 6 }}>{p.note}</T> : null}
      {p.options.map(o => {
        const on = o.v === (p.value ?? '');
        return (
          <Press key={o.v} haptic="select" label={o.label} selected={on} onPress={() => { p.onPick(o.v); close(); }}
            style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: R.sm + 2, backgroundColor: on ? C.amberTint : 'transparent' }}>
            <T v="body" weight={on ? 700 : 500} color={on ? C.amber : C.bone} style={{ flex: 1 }}>{o.label}</T>
            {on ? <Icon name="check" size={20} color={C.amber} /> : null}
          </Press>
        );
      })}
    </View>
  );
}

function MenuSheet({ p, close }: { p: Extract<Picker, { type: 'menu' }>; close: () => void }) {
  return (
    <View style={{ gap: 6 }}>
      <T v="heading" style={{ marginBottom: 6 }}>{p.title}</T>
      {p.items.map(it => (
        <Press key={it.label} label={it.label} haptic="select" disabled={it.disabled} onPress={() => { close(); it.run(); }}
          style={{ minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: R.sm + 2, backgroundColor: C.card }}>
          <Icon name={it.icon} size={20} color={it.danger ? C.red : C.bone} />
          <T v="label" color={it.danger ? C.red : C.bone}>{it.label}</T>
        </Press>
      ))}
    </View>
  );
}

function DeviceSheet({ p, close }: { p: Extract<Picker, { type: 'device' }>; close: () => void }) {
  const { home } = useEd();
  const [q, setQ] = useState('');
  const sections = deviceSections(home.devices.filter(d => !d.hidden || d.id === p.value), home.rooms, q, p.only);
  const words = q.trim().toLowerCase();
  const groups = p.groups ? pseudoTargets(home.devices.filter(d => !p.only || p.only(d)), home.rooms).filter(o => !words || o.label.toLowerCase().includes(words)) : [];
  const zones = p.zones ? zoneTargets(home.devices, home.rooms).filter(o => !words || o.label.toLowerCase().includes(words)) : [];
  const roomReads = p.readings ? readingRooms(home.rooms, home.roomStatus, p.value).filter(o => !words || o.label.toLowerCase().includes(words)) : [];
  const row = (o: Opt, label: string, icon?: string) => {
    const on = o.v === p.value;
    return (
      <Press key={o.v} haptic="select" label={label} selected={on} onPress={() => { p.onPick(o.v); close(); }}
        style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: R.sm + 2, backgroundColor: on ? C.amberTint : 'transparent' }}>
        {icon ? <Icon name={icon} size={18} color={on ? C.amber : C.stone} /> : null}
        <T v="body" weight={on ? 700 : 500} color={on ? C.amber : C.bone} style={{ flex: 1 }}>{o.label}</T>
        {on ? <Icon name="check" size={20} color={C.amber} /> : null}
      </Press>
    );
  };
  return (
    <View style={{ gap: 12 }}>
      <T v="heading">{p.title}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: R.md, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
        <Icon name="search" size={20} color={C.stone2} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search devices or rooms" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search devices"
          style={{ flex: 1, minWidth: 0, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
        {q ? <Press onPress={() => setQ('')} label="Clear search" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
      </View>
      {roomReads.length ? (
        <View style={{ gap: 2 }}>
          <Label>Rooms</Label>
          {roomReads.map(o => row(o, o.label, 'meeting_room'))}
        </View>
      ) : null}
      {zones.length ? (
        <View style={{ gap: 2 }}>
          <Label>Room zones</Label>
          {zones.map(o => row(o, o.label, 'ac_unit'))}
        </View>
      ) : null}
      {groups.length ? (
        <View style={{ gap: 2 }}>
          <Label>Groups</Label>
          {groups.map(o => row(o, o.label, 'category'))}
        </View>
      ) : null}
      {sections.map(s => (
        <View key={s.room} style={{ gap: 2 }}>
          <Label>{s.room}</Label>
          {s.items.map(o => row(o, `${s.room} ${o.label}`))}
        </View>
      ))}
      {!sections.length && !groups.length && !zones.length && !roomReads.length ? <T v="callout" color={C.stone}>{q ? `Nothing called “${q}”.` : 'No devices here yet.'}</T> : null}
    </View>
  );
}

const cellGrid = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6 };
function Cell({ label, on, onPress, a11y, disabled, width = '14.8%' }: { label: string; on: boolean; onPress: () => void; a11y: string; disabled?: boolean; width?: `${number}%` }) {
  return (
    <Press haptic="select" label={a11y} selected={on} disabled={disabled} onPress={onPress} style={{ width, height: 40, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.amber : C.control }}>
      <T mono size={14} color={on ? C.onAmber : C.bone}>{label}</T>
    </Press>
  );
}

/** Hours and minutes as grids (minutes in fives, with the current one kept). */
function ClockGrids({ h, m, onChange }: { h: number; m: number; onChange: (h: number, m: number) => void }) {
  const mins = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!mins.includes(m)) { mins.push(m); mins.sort((a, b) => a - b); }
  return (
    <>
      <Label>Hour</Label>
      <View style={cellGrid}>{Array.from({ length: 24 }, (_, i) => <Cell key={i} label={String(i).padStart(2, '0')} on={i === h} a11y={`${i} hours`} onPress={() => onChange(i, m)} />)}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Label>Minute</Label>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Press haptic="select" label="A minute earlier" onPress={() => onChange(h, (m + 59) % 60)} style={{ width: 34, height: 30, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control }}><Icon name="remove" size={17} /></Press>
          <Press haptic="select" label="A minute later" onPress={() => onChange(h, (m + 1) % 60)} style={{ width: 34, height: 30, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control }}><Icon name="add" size={17} /></Press>
        </View>
      </View>
      <View style={cellGrid}>{mins.map(i => <Cell key={i} label={String(i).padStart(2, '0')} on={i === m} a11y={`${i} minutes`} onPress={() => onChange(h, i)} />)}</View>
    </>
  );
}

function TimeSheet({ p, close }: { p: Extract<Picker, { type: 'time' }>; close: () => void }) {
  const [[h, m], setHM] = useState(parseClock(p.value));
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T v="heading">{p.title}</T>
        <T mono size={28} color={C.amber} accessibilityLiveRegion="polite">{clockOf(h, m)}</T>
      </View>
      <ClockGrids h={h} m={m} onChange={(a, b) => setHM([a, b])} />
      <Button label={`Set ${clockOf(h, m)}`} onPress={() => { p.onPick(clockOf(h, m)); close(); }} />
    </View>
  );
}

/** A date and a time on the home's clock: quick choices, a month to pick the day from, then the hour and minute. */
function DateTimeSheet({ p, close }: { p: Extract<Picker, { type: 'datetime' }>; close: () => void }) {
  const { home } = useEd();
  const now = home.now;
  const start = parseStamp(p.value) ?? parseStamp(addMinutes(now, 60))!;
  const [sel, setSel] = useState(start);
  const [view, setView] = useState<[number, number]>([start.y, start.mo]);
  const today = parseStamp(now)!;
  const stamp = stampOf(sel.y, sel.mo, sel.d, sel.h, sel.mi);
  const past = stamp <= now;
  const weeks = monthGrid(view[0], view[1]);
  const before = (y: number, mo: number) => y < today.y || (y === today.y && mo < today.mo);
  const dayPast = (d: number) => `${view[0]}-${String(view[1]).padStart(2, '0')}-${String(d).padStart(2, '0')}` < dateOf(now);
  const go = (s: string) => { const x = parseStamp(s)!; setSel(x); setView([x.y, x.mo]); };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 2 }}>
        <T v="overline" color={C.stone2}>{p.title}</T>
        <T v="title" color={past ? C.red : C.bone} accessibilityLiveRegion="polite">{onceWords(stamp, now).replace(/^./, c => c.toUpperCase())}</T>
        <T v="footnote" color={past ? C.red : C.amber}>{past ? 'That time has passed: choose a later one' : `${untilWords(stamp, now)} · on the home’s clock (now ${timeOf(now)})`}</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {onceChips(now).map(c => <Pill key={c.label} label={c.label} on={c.at === stamp} onPress={() => go(c.at)} />)}
      </View>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="headline" style={{ flex: 1 }}>{`${MONTH_NAMES[view[1] - 1]} ${view[0]}`}</T>
          {(() => { const [py, pm] = shiftMonth(view[0], view[1], -1); return (
            <Press haptic="select" label="Month before" disabled={before(py, pm)} onPress={() => setView([py, pm])} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}><Icon name="chevron_left" size={22} /></Press>
          ); })()}
          <Press haptic="select" label="Month after" onPress={() => setView(shiftMonth(view[0], view[1], 1))} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.control2 }}><Icon name="chevron_right" size={22} /></Press>
        </View>
        <View style={{ flexDirection: 'row' }}>
          {DAYS.map((d, i) => <T key={i} v="micro" color={C.stone2} center style={{ flex: 1 }}>{d}</T>)}
        </View>
        {weeks.map((w, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 4 }}>
            {w.map((d, j) => {
              if (d == null) return <View key={j} style={{ flex: 1, height: 40 }} />;
              const on = sel.y === view[0] && sel.mo === view[1] && sel.d === d;
              const isToday = today.y === view[0] && today.mo === view[1] && today.d === d;
              const dis = dayPast(d);
              return (
                <Press key={j} haptic="select" label={`${d} ${MONTH_NAMES[view[1] - 1]}`} selected={on} disabled={dis} onPress={() => setSel({ ...sel, y: view[0], mo: view[1], d })}
                  style={{ flex: 1, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.amber : 'transparent', borderWidth: isToday && !on ? 1 : 0, borderColor: C.amberLine }}>
                  <T v="labelSm" color={on ? C.onAmber : dis ? C.stone3 : C.bone}>{String(d)}</T>
                </Press>
              );
            })}
          </View>
        ))}
      </View>
      <ClockGrids h={sel.h} m={sel.mi} onChange={(h, mi) => setSel({ ...sel, h, mi })} />
      <Button label={past ? 'Choose a later time' : `Set ${onceWords(stamp, now)}`} onPress={() => { if (past) { haptic.error(); return; } p.onPick(stamp); close(); }} />
    </View>
  );
}

/** A yes-or-no in a sheet: delete, discard changes. */
export function Confirm({ open, title, text, yes, no = 'Cancel', danger, onYes, onClose }: { open: boolean; title: string; text?: string; yes: string; no?: string; danger?: boolean; onYes: () => void; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <View style={{ gap: 6 }}>
        <T v="heading" size={19}>{title}</T>
        {text ? <T v="callout" color={C.stone}>{text}</T> : null}
      </View>
      <View style={{ gap: 8 }}>
        <Button kind={danger ? 'danger' : 'primary'} label={yes} onPress={() => { onYes(); }} />
        <Button kind="secondary" label={no} onPress={onClose} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------- history ----

function History({ runs, loading }: { runs: AutomationRun[]; loading: boolean }) {
  if (!runs.length) return <T v="callout" color={C.stone}>{loading ? 'Reading its history…' : 'It hasn’t run yet. Runs show here, with each step.'}</T>;
  return (
    <View style={{ gap: 10 }}>
      {runs.map((r, i) => {
        const [label, colour] = RESULT[r.result] ?? ['', C.stone];
        return (
          <Appear key={r.id} index={i} style={{ borderRadius: R.lg - 2, backgroundColor: C.card, padding: 14, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: R.full, backgroundColor: alpha(colour, 0.15) }}><T v="micro" color={colour}>{label}</T></View>
              <T v="labelSm" weight={600} style={{ flex: 1 }} numberOfLines={2}>{r.why}</T>
              <T mono size={11.5} color={C.stone}>{runTime(r.at)}</T>
            </View>
            {r.detail ? <T v="footnote" color={r.result === 'failed' ? C.red : C.stone}>{r.detail}</T> : null}
            {r.steps.length ? (
              <View style={{ gap: 5, paddingTop: 2 }}>
                {r.steps.map((st, j) => (
                  <View key={j} style={{ flexDirection: 'row', gap: 8 }} accessible accessibilityLabel={`${st.ok ? 'Done' : 'Failed'}: ${st.text}${st.detail ? `. ${st.detail}` : ''}`}>
                    <Icon name={st.ok ? 'check' : 'error'} size={16} color={st.ok ? C.green : C.red} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T v="footnote" color={st.ok ? C.bone2 : C.red}>{st.text}</T>
                      {st.detail ? <T v="footnote" size={11.5} color={C.stone}>{st.detail}</T> : null}
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

/** A section of the editor: a heading with what it means, and a count. */
function SectionHead({ title, sub, icon, color }: { title: string; sub: string; icon: string; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: SP[3] }}>
      <IconWell icon={icon} color={color} size={34} />
      <View style={{ flex: 1, gap: 1 }}>
        <T v="heading" size={20} accessibilityRole="header">{title}</T>
        <T v="footnote" color={C.stone}>{sub}</T>
      </View>
    </View>
  );
}

/** The automation in plain words, live as it's edited. */
function SummaryCard({ draft, names }: { draft: Draft; names: Names }) {
  const s = draftSummary(draft, names);
  return (
    <View style={{ gap: 6, padding: 14, borderRadius: R.lg, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge, borderTopColor: C.edgeTop }} accessibilityLiveRegion="polite">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="auto_awesome" size={15} color={C.amber} />
        <T v="eyebrow" color={C.amber}>In plain words</T>
      </View>
      <T v="callout" color={C.bone2}>{s.sentence}</T>
    </View>
  );
}

export function AutomationEditor() {
  const route = useRoute<RouteProp<Stack, 'AutomationEditor'>>();
  const params = route.params ?? {};
  const s = useSnap();
  const { api, say } = useHub();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const all = automationsOf(s);
  const now = localNowOf(s);
  const [id, setId] = useState<string | undefined>(params.id);
  const live = id ? all.find(a => a.id === id) : undefined;
  const schedule = !!params.schedule;
  // A new one starts as itself (so leaving it untouched doesn't ask); one from the hub (or a suggestion) as given.
  const [initial] = useState<Draft>(() => draftOf(params.id ? live ?? null : params.draft ?? (schedule ? scheduleDraft(now) : null)));
  const [saved, setSaved] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(() => (params.draft ? draftOf(params.draft) : initial));
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(!!id);
  const [tab, setTab] = useState<'edit' | 'history'>(params.tab ?? 'edit');
  const [pick, setPickRaw] = useState<Picker | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'run'>('');
  const [guard, setGuard] = useState<NavigationAction | null>(null);
  const [more, setMore] = useState(!schedule);
  /** Leaving on purpose (saved, or changes discarded): the guard stands down, then the screen goes. */
  const [exit, setExit] = useState<NavigationAction | 'back' | null>(null);
  const scroll = useRef<ScrollView>(null);
  const dirty = !sameDraft(draft, saved);
  const fresh = !id;
  const oneTime = isOneTime(draft);

  // A sheet opening while another is still closing waits for it, so they don't stack.
  const pickT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setPick = useCallback((p: Picker | null) => {
    if (pickT.current) clearTimeout(pickT.current);
    setPickRaw(cur => {
      if (cur && p) { pickT.current = setTimeout(() => setPickRaw(p), 320); return null; }
      return p;
    });
  }, []);
  useEffect(() => () => { if (pickT.current) clearTimeout(pickT.current); }, []);

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

  const music = useMemo(() => (s.music ?? []) as MusicItem[], [s.music]);
  const home = useMemo<Home>(() => ({
    devices: s.devices, rooms: s.rooms, roomStatus: s.roomStatus, people: s.people, modes: s.modes, overlays: s.overlays, automations: all, sources: s.sources, music, now,
    speakerGroups: s.speakerGroups ?? [], clips: s.clips ?? [], adhans: s.adhans ?? [], prayer: s.prayer, prayerOn: prayerOn(s),
  }), [s, all, music, now]);
  const names = useMemo<Names>(() => ({ devices: home.devices, rooms: home.rooms, people: home.people, modes: home.modes, overlays: home.overlays, automations: home.automations, now, clips: home.clips, adhans: home.adhans, speakerGroups: home.speakerGroups }), [home, now]);
  const ctx = useMemo(() => ctxOf({ ...home, self: id, prayer: home.prayer }), [home, id]);
  const ed = useMemo<Ed>(() => ({
    draft, home, ctx, names, self: id,
    set: (p, v) => { setDraft(d => setAt(d, p, v)); setErr(null); },
    remove: p => { haptic.select(); setDraft(d => removeAt(d, p)); setErr(null); },
    move: (p, dir) => setDraft(d => moveAt(d, p, dir)),
    push: (p, v) => { setDraft(d => pushAt(d, p, v)); setErr(null); },
    dup: p => setDraft(d => duplicateAt(d, p)),
    pick: p => setPick(p),
  }), [draft, home, ctx, names, id, setPick]);

  // Schedule once: the time first, then what to do.
  const flowed = useRef(false);
  useEffect(() => {
    if (!schedule || flowed.current || params.draft) return;
    const t0 = draft.triggers[0];
    const t = setTimeout(() => { flowed.current = true; setPick({
      type: 'datetime', title: 'When, once', value: t0?.kind === 'once' ? t0.at : addMinutes(now, 60),
      onPick: at => {
        setDraft(d => setAt(d, ['triggers', 0], onceAt(at)));
        setTimeout(() => setPick({ type: 'list', title: 'Then what to do', options: ACTION_KINDS, onPick: k => { animateLayout(); setDraft(d => pushAt(d, ['actions'], newAction(k as Action['kind'], ctx))); } }), 360);
      },
    }); }, 380);
    return () => clearTimeout(t);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving with changes asks first.
  usePreventRemove(dirty && !exit, ({ data }) => setGuard(data.action));
  useEffect(() => { if (exit === 'back') nav.goBack(); else if (exit) nav.dispatch(exit); }, [exit, nav]);

  const autoName = oneTime ? scheduleName(draft, names) : '';
  const fail = (m: string) => { setErr(m); haptic.error(); scroll.current?.scrollTo({ y: 0, animated: true }); };
  const save = async () => {
    if (busy || (!fresh && !dirty)) return;
    const body = bodyOf(draft);
    if (!body.name && autoName) body.name = autoName;
    if (!body.name) return fail('Give it a name');
    if (!body.triggers.length) return fail('Add at least one trigger: what starts it');
    if (!body.actions.length) return fail('Add at least one step: what it does');
    const late = onceProblem(body, now);
    if (late) return fail(late);
    const spoken = announceSaveProblem(body.actions, home);
    if (spoken) return fail(spoken);
    setBusy('save');
    try {
      const r = id
        ? await api<{ id?: string; undo?: string }>('PUT', `/api/automations/${encodeURIComponent(id)}`, body)
        : await api<{ id?: string; undo?: string }>('POST', '/api/automations', body);
      haptic.success();
      say(id ? `${body.name} saved` : oneTime ? `${body.name}: scheduled` : `${body.name} added`, { undo: r?.undo });
      setSaved(body);
      setDraft(body);
      if (!id && r?.id) setId(r.id);
      setExit('back');
    } catch (e) {
      // The hub's own words, inline, where they can be acted on.
      fail((e as Error).message);
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
  const late = onceProblem(draft, now);
  const title = fresh ? (schedule || oneTime ? 'Schedule once' : 'New automation') : oneTime ? 'One-time schedule' : 'Automation';

  return (
    <EdCtx.Provider value={ed}>
      <View style={{ flex: 1, backgroundColor: C.page }}>
        <View style={{ paddingTop: insets.top + 10, paddingHorizontal: SP.gutter, paddingBottom: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: C.hairline, backgroundColor: C.page }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Press onPress={() => nav.goBack()} label="Back" style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.control2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="arrow_back" size={21} />
            </Press>
            <View style={{ flex: 1 }}>
              <T v="footnote" color={dirty ? C.amber : C.stone}>{dirty && !fresh ? 'Edited · not saved yet' : title}</T>
              <T v="heading" size={19} numberOfLines={1}>{draft.name || autoName || (fresh ? title : 'Untitled')}</T>
            </View>
            <Press onPress={() => void save()} disabled={(!fresh && !dirty) || busy === 'save'} label={fresh ? (oneTime ? 'Schedule' : 'Add automation') : 'Save'}
              style={{ minHeight: 40, paddingHorizontal: 16, justifyContent: 'center', borderRadius: R.sm + 2, backgroundColor: C.amber }}>
              <T v="label" weight={800} color={C.onAmber}>{busy === 'save' ? 'Saving…' : fresh ? (oneTime ? 'Schedule' : 'Add') : 'Save'}</T>
            </Press>
          </View>
          {id ? (
            <Segmented compact label="Edit or history" value={tab} options={[{ id: 'edit', label: 'Edit' }, { id: 'history', label: `History${runs.length ? ` · ${runs.length}` : ''}` }]} onChange={k => { animateLayout(); setTab(k as 'edit' | 'history'); }} />
          ) : null}
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: SP.gutter, paddingBottom: insets.bottom + 120, gap: 14 }}>
            {tab === 'history' && id ? (
              <>
                {/* Side by side where both fit on one line; each its own row on a small phone or with large text. */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <View style={{ flexGrow: 1, flexBasis: 150 * Math.min(fontScale, 1.6) }}><Button full label={busy === 'run' ? 'Running…' : 'Run now'} icon="play_arrow" onPress={() => void run(false)} /></View>
                  <View style={{ flexGrow: 1, flexBasis: 150 * Math.min(fontScale, 1.6) }}><Button full kind="secondary" label="Check, then run" icon="fact_check" onPress={() => void run(true)} /></View>
                </View>
                <T v="footnote" color={C.stone}>{dirty ? 'Runs the saved version, not your changes. ' : ''}Run now skips its conditions; Check, then run stops if one doesn’t hold.</T>
                <History runs={runs} loading={loadingRuns} />
              </>
            ) : (
              <>
                {err ? (
                  <Appear>
                    <View accessibilityLiveRegion="assertive" style={{ flexDirection: 'row', gap: 10, padding: 14, borderRadius: R.md, backgroundColor: C.redTint, borderWidth: 1, borderColor: C.redLine }}>
                      <Icon name="error" size={19} color={C.red} fill />
                      <View style={{ flex: 1, gap: 2 }}>
                        <T v="label" color={C.redText}>{fresh ? 'Couldn’t add it' : 'Couldn’t save it'}</T>
                        <T v="callout" color={C.redText}>{err}</T>
                      </View>
                      <Press onPress={() => setErr(null)} label="Dismiss" style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={18} color={C.redText} /></Press>
                    </View>
                  </Appear>
                ) : null}
                {/* What Kova learned about this automation from what you do (hub engine/learn.ts). */}
                {id ? s.findings.filter(f => f.automationId === id).map(f => (
                  <FindingCard key={f.id} f={f} tag={false} onApplied={() => void load(true)} />
                )) : null}
                <SummaryCard draft={draft} names={names} />
                {notes.length ? (
                  <View style={{ gap: 6, padding: 14, borderRadius: R.md, backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                      <Icon name="info" size={18} color={C.amber} />
                      <T v="label" color={C.amber}>Converted from Home Assistant: left out</T>
                    </View>
                    {notes.map((n, i) => <T key={i} v="footnote" color={C.bone2}>{`· ${n}`}</T>)}
                  </View>
                ) : null}

                <Field label="Name" note={!draft.name && autoName ? `Leave it empty to call it “${autoName}”.` : undefined}>
                  <TextBox label="Name" value={draft.name} placeholder={autoName || 'e.g. Porch light at sunset'} onChange={v => ed.set(['name'], v)} />
                </Field>

                <SectionHead title="When" icon="bolt" color={C.amber} sub={oneTime ? 'Once, at this date and time' : draft.triggers.length > 1 ? 'Any one of these starts it' : 'What starts it'} />
                {draft.triggers.map((t, i) => <TriggerPart key={i} t={t} path={['triggers', i]} index={i} />)}
                <AddButton text={draft.triggers.length ? 'Add another trigger' : 'Add a trigger'} onPress={() => setPick({ type: 'list', title: 'Add a trigger', options: TRIGGER_KINDS, onPick: k => { animateLayout(); ed.push(['triggers'], newTrigger(k as Trigger['kind'], ctx)); } })} />
                {home.prayerOn && !oneTime && missingPrayers(draft.triggers).length ? (
                  <Press onPress={() => { animateLayout(); haptic.select(); ed.set(['triggers'], withEveryPrayer(draft.triggers)); }} label="Every prayer time: add Fajr, Dhuhr, Asr, Maghrib and Isha"
                    style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: R.sm + 2, backgroundColor: C.control }}>
                    <Icon name="mosque" size={18} color={C.green} />
                    <T v="labelSm" color={C.bone2} style={{ flexShrink: 1 }}>{missingPrayers(draft.triggers).length === 5 ? 'Every prayer time' : `Every prayer time (add ${missingPrayers(draft.triggers).length} more)`}</T>
                  </Press>
                ) : null}
                {late ? <Hint tone="red" icon="error" text={late} /> : null}

                {more || draft.conditions.length ? (
                  <>
                    <SectionHead title="Only if" icon="fact_check" color={C.blue} sub={draft.conditions.length ? (draft.conditions.length > 1 ? 'All of these have to hold' : 'This has to hold') : 'Always: no conditions'} />
                    <ConditionList list={draft.conditions} path={['conditions']} />
                    <AddCondition path={['conditions']} />
                  </>
                ) : null}

                <SectionHead title="Then" icon="play_arrow" color={C.green} sub={draft.actions.length > 1 ? 'These steps, in order' : 'What it does'} />
                <ActionList list={draft.actions} path={['actions']} />
                <AddAction path={['actions']} />

                {more ? (
                  <View style={{ gap: 14, marginTop: SP[3] }}>
                    <T v="overline" color={C.stone2}>Details</T>
                    <Field label="Description"><TextBox label="Description" value={draft.description ?? ''} placeholder="Optional: what it’s for" multiline onChange={v => ed.set(['description'], v || undefined)} /></Field>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: R.md, backgroundColor: C.card }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <T v="headline">{draft.enabled ? 'On' : 'Off'}</T>
                        <T v="footnote" color={C.stone}>{draft.enabled ? (oneTime ? 'Goes off at its time, then switches itself off' : 'Runs when something starts it') : 'Kept, but doesn’t run'}</T>
                      </View>
                      <Switch on={draft.enabled} onChange={v => ed.set(['enabled'], v)} label="Automation on" />
                    </View>
                    <Field label="If it starts again while still running" note={labelOf(RUN_MODES, draft.mode) + (draft.mode === 'single' ? ': the new start is ignored.' : draft.mode === 'restart' ? ': the run is cancelled and starts over.' : draft.mode === 'queued' ? ': it runs again once this one ends.' : ': both runs go at once.')}>
                      <Pills value={draft.mode} options={RUN_MODES} onChange={v => v && ed.set(['mode'], v)} />
                    </Field>
                  </View>
                ) : (
                  <Press onPress={() => { animateLayout(); setMore(true); }} haptic="select" label="More options: conditions, description, on or off, run mode"
                    style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: SP[2] }}>
                    <Icon name="tune" size={18} color={C.stone} />
                    <T v="labelSm" color={C.stone}>More options</T>
                  </Press>
                )}

                <View style={{ marginTop: SP[3], gap: 8 }}>
                  {err ? <Hint tone="red" icon="error" text={err} /> : null}
                  <Button label={busy === 'save' ? 'Saving…' : fresh ? (oneTime ? 'Schedule it' : 'Add automation') : dirty ? 'Save changes' : 'Saved'} icon="check" busy={busy === 'save'} onPress={() => void save()} />
                  {id ? <Button kind="secondary" icon="play_arrow" label={busy === 'run' ? 'Running…' : dirty ? 'Run the saved version now' : 'Run now'} onPress={() => void run(false)} /> : null}
                </View>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>

        <Sheet open={!!pick} onClose={() => setPick(null)}>
          {pick?.type === 'list' ? <ListSheet p={pick} close={() => setPick(null)} />
            : pick?.type === 'menu' ? <MenuSheet p={pick} close={() => setPick(null)} />
              : pick?.type === 'device' ? <DeviceSheet key={pick.title + pick.value} p={pick} close={() => setPick(null)} />
                : pick?.type === 'time' ? <TimeSheet key={pick.value} p={pick} close={() => setPick(null)} />
                  : pick?.type === 'datetime' ? <DateTimeSheet key={pick.value} p={pick} close={() => setPick(null)} />
                    : pick?.type === 'media' ? <MediaSheet p={pick} close={() => setPick(null)} /> : null}
        </Sheet>
        <Confirm open={!!guard} title="Leave without saving?" text={fresh ? 'This won’t be added.' : 'Your changes to this automation will be lost.'} yes="Discard changes" no="Keep editing" danger
          onClose={() => setGuard(null)} onYes={() => { const a = guard; setGuard(null); if (a) setExit(a); }} />
      </View>
    </EdCtx.Provider>
  );
}
