import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP, alpha } from '../theme';
import { useSnap } from '../state/hub';
import type { Command, Device, TargetRow } from '../api/types';
import {
  RHYTHMS, canSet, clockOf, commandChoices, commandFromKey, commandKey, deviceLabel, deviceSections, firstCommand, parseClock, rhythmFromKey, rhythmKey, rhythmWords, withOffset,
  type Rhythm, type Targets,
} from '../logic/automations';
import { OFFSETS, offsetWords } from '../logic/modes';
import { Icon } from '../ui/Icon';
import { Button, Card, HScroll, IconButton, Pill, Press, Row, Sheet } from '../ui/kit';
import { T } from '../ui/Text';

// The parts the mode, overlay and moment editors share: icons, colours, a time of day, devices and what they're set to.

/** A grid of icons to pick one from. */
export function IconGrid({ icons, value, onChange, color = C.amber }: { icons: string[]; value: string; onChange: (i: string) => void; color?: string }) {
  const list = icons.includes(value) ? icons : [value, ...icons];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
      {list.map(i => {
        const on = i === value;
        return (
          <Press key={i} onPress={() => onChange(i)} haptic="select" selected={on} label={i.replace(/_/g, ' ')}
            style={{ width: '18%', flexGrow: 1, aspectRatio: 1, maxHeight: 60, borderRadius: R.md, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? alpha(color, 0.16) : C.inset, borderWidth: 1, borderColor: on ? alpha(color, 0.5) : C.edge }}>
            <Icon name={i} size={24} color={on ? color : C.bone2} fill={on} />
          </Press>
        );
      })}
    </View>
  );
}

/** Colour swatches. */
export function Swatches({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  const list = colors.includes(value) ? colors : [value, ...colors];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[3] }}>
      {list.map(c => {
        const on = c === value;
        return (
          <Press key={c} onPress={() => onChange(c)} haptic="select" selected={on} label={`Colour ${c}`}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c, alignItems: 'center', justifyContent: 'center', borderWidth: on ? 3 : 0, borderColor: C.bone }}>
            {on ? <Icon name="check" size={20} color={C.coal} /> : null}
          </Press>
        );
      })}
    </View>
  );
}

/** Pick a clock time: hours, then minutes in fives. */
function TimeSheet({ open, value, title, onPick, onClose }: { open: boolean; value: string; title: string; onPick: (v: string) => void; onClose: () => void }) {
  const [[h, m], setHM] = useState(parseClock(value));
  useEffect(() => { if (open) setHM(parseClock(value)); }, [open, value]);
  const mins = Array.from({ length: 12 }, (_, i) => i * 5);
  if (!mins.includes(m)) { mins.push(m); mins.sort((a, b) => a - b); }
  const cell = (label: string, on: boolean, fn: () => void, a11y: string) => (
    <Press key={label} haptic="select" label={a11y} onPress={fn} style={{ width: '14.8%', height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.amber : C.control }}>
      <T mono size={14} color={on ? C.onAmber : C.bone}>{label}</T>
    </Press>
  );
  const grid = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6 };
  return (
    <Sheet open={open} onClose={onClose} label={title}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T size={18} weight={700}>{title}</T>
        <T mono size={28} color={C.amber} accessibilityLiveRegion="polite">{clockOf(h, m)}</T>
      </View>
      <T v="overline" color={C.stone2}>Hour</T>
      <View style={grid}>{Array.from({ length: 24 }, (_, i) => cell(String(i).padStart(2, '0'), i === h, () => setHM([i, m]), `${i} hours`))}</View>
      <T v="overline" color={C.stone2}>Minute</T>
      <View style={grid}>{mins.map(i => cell(String(i).padStart(2, '0'), i === m, () => setHM([h, i]), `${i} minutes`))}</View>
      <Button label={`Set ${clockOf(h, m)}`} onPress={() => { onPick(clockOf(h, m)); onClose(); }} />
    </Sheet>
  );
}

/** A time of day that can move: a clock time, sunrise or sunset, or a prayer time, with an offset. */
export function RhythmEditor({ value, onChange, title }: { value: Rhythm; onChange: (r: Rhythm) => void; title: string }) {
  const [clock, setClock] = useState(false);
  const k = rhythmKey(value);
  return (
    <View style={{ gap: SP[2] }}>
      <HScroll>{RHYTHMS.map(o => <Pill key={o.v} label={o.label} on={k === o.v} onPress={() => onChange(rhythmFromKey(o.v, value))} />)}</HScroll>
      {value.kind === 'time' ? (
        <Press onPress={() => setClock(true)} label={`${title}: ${value.at}. Change`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 52, paddingHorizontal: SP[4], borderRadius: R.md, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
          <Icon name="schedule" size={20} color={C.amber} />
          <T mono size={20} color={C.bone} style={{ flex: 1 }}>{value.at}</T>
          <T v="label" color={C.amber}>Change</T>
        </Press>
      ) : (
        <HScroll>{OFFSETS.map(m => <Pill key={m} label={offsetWords(m)} on={(value.offsetMin ?? 0) === m} onPress={() => onChange(withOffset(value, m))} />)}</HScroll>
      )}
      <T v="footnote" color={C.stone}>{rhythmWords(value)}</T>
      <TimeSheet open={clock} value={value.kind === 'time' ? value.at : '21:00'} title={title} onClose={() => setClock(false)}
        onPick={at => onChange({ kind: 'time', at })} />
    </View>
  );
}

/** Pick a device: by room, with a search. Cameras and sensors only report, so they aren't offered. */
export function DevicePicker({ open, title, exclude = [], onPick, onClose }: { open: boolean; title: string; exclude?: string[]; onPick: (id: string) => void; onClose: () => void }) {
  const s = useSnap();
  const [q, setQ] = useState('');
  useEffect(() => { if (open) setQ(''); }, [open]);
  const list = s.devices.filter(d => canSet(d) && !d.hidden && !(d as { archived?: boolean }).archived && !exclude.includes(d.id));
  const sections = deviceSections(list, s.rooms, q);
  return (
    <Sheet open={open} onClose={onClose} label={title}>
      <T size={18} weight={700}>{title}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line }}>
        <Icon name="search" size={20} color={C.stone2} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search devices or rooms" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Search devices"
          style={{ flex: 1, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
        {q ? <Press onPress={() => setQ('')} label="Clear search" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
      </View>
      {sections.map(sec => (
        <View key={sec.room} style={{ gap: 2 }}>
          <T v="overline" color={C.stone2}>{sec.room}</T>
          {sec.items.map(o => (
            <Press key={o.v} haptic="select" label={`${sec.room} ${o.label}`} onPress={() => { onPick(o.v); onClose(); }}
              style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12 }}>
              <T size={15} weight={500} color={C.bone} style={{ flex: 1 }}>{o.label}</T>
              <Icon name="chevron_right" size={18} color={C.stone2} />
            </Press>
          ))}
        </View>
      ))}
      {!sections.length ? <T size={13} color={C.stone}>{q ? `Nothing called “${q}”.` : 'No devices to add.'}</T> : null}
    </Sheet>
  );
}

/** What a device is set to: the choices it has. */
function CommandSheet({ device, cur, onPick, onClose }: { device: string | null; cur?: Command; onPick: (c: Command) => void; onClose: () => void }) {
  const s = useSnap();
  const d = s.devices.find(x => x.id === device);
  const opts = commandChoices(d, s.sources, cur);
  const now = cur ? commandKey(cur) : '';
  return (
    <Sheet open={!!device} onClose={onClose} label="Set it to">
      <T size={18} weight={700}>{d ? `${d.name}: set it to` : 'Set it to'}</T>
      <View style={{ gap: 4 }}>
        {opts.map(o => {
          const on = o.v === now;
          return (
            <Press key={o.v} haptic="select" label={o.label} onPress={() => { onPick(commandFromKey(o.v)); onClose(); }}
              style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: on ? C.amberTint : 'transparent' }}>
              <T size={15} weight={on ? 700 : 500} color={on ? C.amber : C.bone} style={{ flex: 1 }}>{o.label}</T>
              {on ? <Icon name="check" size={20} color={C.amber} /> : null}
            </Press>
          );
        })}
      </View>
    </Sheet>
  );
}

/**
 * The devices something sets, and what to. `rows` as the snapshot gives them; each change goes to `onSet`
 * (null removes the device). Adding picks a device, then what it's set to.
 */
export function TargetsEditor({ rows, onSet, empty = 'Nothing changes yet. Add the devices it sets.' }: { rows: TargetRow[]; onSet: (device: string, cmd: Command | null) => unknown; empty?: string }) {
  const s = useSnap();
  const [adding, setAdding] = useState(false);
  const [cmdFor, setCmdFor] = useState<string | null>(null);
  const cur = rows.find(r => r.deviceId === cmdFor)?.target;
  return (
    <View style={{ gap: SP[2] }}>
      {rows.length ? (
        <Card style={{ overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <Row key={r.deviceId} first={!i} title={r.missing ? `${r.deviceId} (gone)` : deviceLabel(r.deviceId, s.devices, s.rooms)} sub={r.label} subColor={r.missing ? C.redText : C.stone}
              onPress={r.missing ? undefined : () => setCmdFor(r.deviceId)}
              right={<IconButton icon="close" tone="ghost" size={36} color={C.stone} label={`Remove ${r.name}`} onPress={() => void onSet(r.deviceId, null)} />} />
          ))}
        </Card>
      ) : <T v="footnote" color={C.stone}>{empty}</T>}
      <Button kind="secondary" icon="add" label="Add a device" onPress={() => setAdding(true)} />
      <DevicePicker open={adding} title="Add a device" exclude={rows.map(r => r.deviceId)} onClose={() => setAdding(false)}
        onPick={id => setTimeout(() => setCmdFor(id), 250)} />
      <CommandSheet device={cmdFor} cur={cur ?? (cmdFor ? firstCommand(s.devices.find(d => d.id === cmdFor), s.sources) : undefined)} onClose={() => setCmdFor(null)}
        onPick={c => { if (cmdFor) void onSet(cmdFor, c); }} />
    </View>
  );
}

/** Target rows for a local targets map (a moment being edited), in the snapshot's shape. */
export function rowsOf(t: Targets, devices: Device[], sources: { name: string }[]): TargetRow[] {
  return Object.entries(t).map(([id, cmd]) => {
    const d = devices.find(x => x.id === id);
    return { deviceId: id, name: d?.name ?? id, label: commandChoices(d, sources, cmd).find(o => o.v === commandKey(cmd))?.label ?? '', target: cmd, missing: !d };
  });
}

/** A yes-or-no before something can't easily come back. */
export function ConfirmSheet({ open, title, text, yes, onYes, onClose }: { open: boolean; title: string; text?: string; yes: string; onYes: () => unknown; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} label={title}>
      <View style={{ gap: 6 }}>
        <T size={19} weight={700}>{title}</T>
        {text ? <T size={13.5} color={C.stone} lineHeight={1.45}>{text}</T> : null}
      </View>
      <Button full kind="danger" icon="delete" label={yes} onPress={onYes} />
      <Button full kind="secondary" label="Cancel" onPress={onClose} />
    </Sheet>
  );
}
