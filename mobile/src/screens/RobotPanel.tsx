import { useEffect, useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { C, F, SP, R, alpha } from '../theme';
import { useHub } from '../state/hub';
import { Icon } from '../ui/Icon';
import { Button, Card, Chips, Group, HScroll, IconWell, Notice, Pill, Press, Row, Section, Segmented, Slider, Stat, Switch, SwitchRow, Tag } from '../ui/kit';
import { T } from '../ui/Text';
import { features, meOf } from '../logic/roles';
import { placeChoices } from '../logic/customise';
import { robotJobLabel, robotStation, SUCTIONS, CLEAN_MODES, partColor, type RobotMap } from '../logic/robot';
import type { Dev } from '../logic/devices';
import type { RobotCommand } from '../api/types';

// A robot vacuum's panel: what it's doing, cleaning chosen rooms on its map, how it cleans, its base station, the
// parts that wear, and its settings. Everything is optional: a model that doesn't report something doesn't show it.

export function RobotPanel({ D, vac, status, statusColor }: { D: Dev; vac: string; status: string; statusColor: string }) {
  const { send, snap, api } = useHub();
  const { width, fontScale } = useWindowDimensions();
  // A small phone or large text: one choice to a row, so labels aren't cut short.
  const narrow = (width - SP[5] * 2) / Math.max(1, fontScale) < 300;
  const r = D.robot ?? null;
  const owner = snap ? features(meOf(snap)).customise : false;
  const [map, setMap] = useState<RobotMap | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [panel, setPanel] = useState<'rooms' | null>(null);
  const areaRooms = D.areaRooms ?? {};
  // The map: asked for when the robot has one, and again when the owner gives an area its room (names change).
  const roomsKey = JSON.stringify(areaRooms);
  useEffect(() => {
    if (!r?.map) { setMap(null); return; }
    let live = true;
    api<RobotMap>('GET', `/api/devices/${encodeURIComponent(D.id)}/map`).then(m => { if (live) setMap(m); }).catch(() => { if (live) setMap(null); });
    return () => { live = false; };
  }, [D.id, r?.map, roomsKey, api]);
  const do_ = (rs: RobotCommand, done: string) => send(D.id, { robotSet: rs }, done);
  const cleaning = vac === 'cleaning', paused = vac === 'paused';
  const areas = map?.areas ?? (r?.areas ?? []).map((a, i) => ({ id: a.id, name: a.name || `Area ${String.fromCharCode(65 + i)}`, room: areaRooms[a.id] ?? null, own: a.name || null }));
  const placed = areas.filter(a => a.room).length;
  const nameOf = (id: string) => areas.find(a => a.id === id)?.name ?? `Area ${id}`;
  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const station = r?.station && r.station !== 'idle' ? robotStation(r.station) : null;

  return (
    <View style={{ gap: SP[5] }}>
      <Card style={{ padding: SP[4], gap: SP[4] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="eyebrow" color={C.stone2}>Battery</T>
            <T v="title" tabular>{D.battery != null ? `${D.battery}%` : '–'}</T>
          </View>
          <Tag text={status} color={statusColor} />
        </View>
        {D.battery != null ? (
          <View style={{ height: 8, borderRadius: 4, backgroundColor: C.control, overflow: 'hidden' }}>
            <View style={{ width: `${D.battery}%`, height: 8, borderRadius: 4, backgroundColor: D.battery < 20 ? C.red : C.green }} />
          </View>
        ) : null}
        {station ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}><Icon name="home_iot_device" size={17} color={C.blue} /><T v="footnote" color={C.bone2}>{`Base station: ${station}`}</T></View> : null}
        <View style={{ flexDirection: 'row', gap: SP[2], flexWrap: 'wrap' }}>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            {cleaning ? <Button full icon="pause" label="Pause" kind="secondary" onPress={() => send(D.id, { activity: 'paused' }, `${D.name} paused`)} />
              : <Button full icon={paused ? 'play_arrow' : 'cleaning_services'} label={paused ? 'Carry on' : 'Clean everywhere'} onPress={() => send(D.id, { on: true }, paused ? `${D.name} carries on` : `${D.name} is cleaning`)} />}
          </View>
          <View style={{ flexGrow: 1, flexBasis: 120 }}>
            <Button full icon="home" label={vac === 'docked' ? 'Docked' : vac === 'returning' ? 'Going home' : 'Send home'} kind="secondary" onPress={() => send(D.id, { on: false }, `${D.name} is going back to its dock`)} />
          </View>
        </View>
      </Card>

      {r?.problems?.length ? <Notice icon="error" color={C.red} title={r.problems.map(p => p.text).join(' · ')} text="Sort it out at the robot or its base station; it carries on once it’s fixed." /> : null}

      {areas.length ? (
        <Section title="Clean rooms" caption gap={SP[2] + 2}>
          {map ? <FloorMap map={map} picked={picked} naming={naming} onTap={id => panel === 'rooms' ? setNaming(id) : toggle(id)} /> : null}
          <HScroll>
            {areas.map(a => <Pill key={a.id} label={a.name} icon={a.room ? 'meeting_room' : 'radio_button_unchecked'} on={panel === 'rooms' ? naming === a.id : picked.includes(a.id)} onPress={() => panel === 'rooms' ? setNaming(a.id) : toggle(a.id)} />)}
          </HScroll>
          {panel !== 'rooms' ? (
            picked.length ? (
              <View style={{ flexDirection: 'row', gap: SP[2] }}>
                <View style={{ flex: 1 }}><Button full icon="cleaning_services" label={picked.length === 1 ? `Clean ${nameOf(picked[0]!)}` : `Clean ${picked.length} rooms`} onPress={async () => { if (await do_({ areas: picked }, `${D.name} is cleaning ${picked.map(nameOf).join(', ')}`)) setPicked([]); }} /></View>
                <Button kind="secondary" label="Clear" onPress={() => setPicked([])} />
              </View>
            ) : <T v="footnote" color={C.stone2}>{map ? 'Tap the rooms to clean on the map.' : 'Pick the rooms to clean.'}</T>
          ) : null}
          {owner ? (
            <Group>
              <Row first icon="location_on" iconFg={C.amber} title="Which room is each area?" sub={placed ? `${placed} of ${areas.length} given a room · Ask Kova and automations clean rooms by name` : 'Give the areas their rooms, so you can say “vacuum the kitchen”'} onPress={() => { setPanel(panel === 'rooms' ? null : 'rooms'); setNaming(panel === 'rooms' ? null : areas.find(a => !a.room)?.id ?? areas[0]?.id ?? null); }} />
            </Group>
          ) : null}
          {panel === 'rooms' && naming ? <AreaRoom D={D} areaId={naming} name={nameOf(naming)} own={areas.find(a => a.id === naming)?.own ?? null} room={areaRooms[naming] ?? null} onDone={() => { const next = areas.find(a => a.id !== naming && !a.room && !areaRooms[a.id]); setNaming(next?.id ?? null); if (!next) setPanel(null); }} /> : null}
        </Section>
      ) : null}

      {r && (r.suction || r.mode || r.water != null || r.passes != null) ? (
        <Section title="How it cleans" caption gap={SP[3]}>
          {r.mode ? <T v="footnote" weight={600} color={C.bone2}>What it does</T> : null}
          {r.mode ? <Chips label="What it does" columns={narrow ? 1 : 2} value={r.mode} color={C.blue} options={CLEAN_MODES.map(([id, label, icon]) => ({ id, label, icon }))} onChange={id => void do_({ mode: id as RobotCommand['mode'] }, `${D.name}: ${CLEAN_MODES.find(m => m[0] === id)![1].toLowerCase()}`)} /> : null}
          {r.suction ? <T v="footnote" weight={600} color={C.bone2}>Suction</T> : null}
          {r.suction ? <Chips label="Suction" columns={narrow ? 2 : 4} value={r.suction} color={C.amber} options={SUCTIONS.map(([id, label]) => ({ id, label }))} onChange={id => void do_({ suction: id as RobotCommand['suction'] }, `${D.name}: suction ${SUCTIONS.find(s => s[0] === id)![1]}`)} /> : null}
          {r.water != null && r.mode !== 'vacuum' ? (
            <View style={{ gap: SP[1] }}>
              <T v="footnote" weight={600} color={C.bone2}>Mop water</T>
              <Slider value={r.water} min={1} max={r.waterMax ?? 4} suffix="" color={C.blue} onColor={C.onBlue} icon="water_drop" label="Mop water" onRelease={v => void do_({ water: v }, `${D.name}: mop water ${v}`)} />
            </View>
          ) : null}
          {r.passes != null ? <T v="footnote" weight={600} color={C.bone2}>Going over each spot</T> : null}
          {r.passes != null ? <Segmented label="Passes" compact value={String(r.passes)} color={C.bone} options={[{ id: '1', label: 'Once over' }, { id: '2', label: 'Twice over' }]} onChange={id => void do_({ passes: Number(id) }, `${D.name}: ${id === '2' ? 'twice' : 'once'} over each spot`)} /> : null}
        </Section>
      ) : null}

      {r?.stationJobs?.length ? (
        <Section title="Base station" caption gap={SP[2] + 2}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            {r.stationJobs.map(j => <View key={j} style={{ flexGrow: 1, flexBasis: narrow ? '100%' : 130 }}><Button full kind="secondary" icon={j === 'empty' ? 'delete' : j === 'wash' ? 'water_drop' : 'air'} label={robotJobLabel(j)} onPress={() => do_({ station: j }, `${D.name}: ${robotJobLabel(j).toLowerCase()}`)} /></View>)}
          </View>
          {r.settings?.autoEmpty !== undefined || r.settings?.dryMinutes != null ? (
            <Group>
              {r.settings.autoEmpty !== undefined ? <SwitchRow first icon="delete" title="Empty the bin after each clean" on={r.settings.autoEmpty} onChange={v => void do_({ settings: { autoEmpty: v } }, v ? 'Empties itself after each clean' : 'Empties only when you ask')} /> : null}
              {r.settings.dryMinutes != null ? (
                <View style={{ padding: SP[4], gap: SP[2], borderTopWidth: r.settings.autoEmpty !== undefined ? 1 : 0, borderTopColor: C.hairline }}>
                  <T v="headline">Drying the mop</T>
                  <Chips label="Drying time" columns={3} value={String(r.settings.dryMinutes)} color={C.blue} options={[...new Set([120, 180, 240, r.settings.dryMinutes])].sort((a, b) => a - b).map(m => ({ id: String(m), label: `${m / 60 % 1 ? (m / 60).toFixed(1) : m / 60} h` }))} onChange={id => void do_({ settings: { dryMinutes: Number(id) } }, `Dries the mop for ${Number(id) / 60} hours`)} />
                </View>
              ) : null}
            </Group>
          ) : null}
        </Section>
      ) : null}

      {r?.parts?.length ? <Parts D={D} parts={r.parts} owner={owner} /> : null}

      {r?.last || r?.totals ? (
        <View style={{ flexDirection: 'row', gap: SP[2] }}>
          {r.last ? <Stat label="Last clean" value={`${r.last.area} m² · ${r.last.minutes} min`} icon="history" /> : null}
          {r.totals ? <Stat label="All time" value={`${r.totals.count} cleans`} icon="trending_up" /> : null}
        </View>
      ) : null}

      {r?.settings ? <RobotSettingsGroup D={D} r={r} /> : null}
      {r?.firmware || r?.wifi != null ? <T v="footnote" color={C.stone2} center>{[r.totals ? `${r.totals.area.toLocaleString()} m² and ${r.totals.hours} hours so far` : '', r.firmware ? `Software ${r.firmware}` : '', r.wifi != null ? `Wi-Fi ${r.wifi > -60 ? 'strong' : r.wifi > -72 ? 'fair' : 'weak'} (${r.wifi} dBm)` : ''].filter(Boolean).join(' · ')}</T> : null}
    </View>
  );
}

/** The robot's map: areas as shapes (picked ones lit, ones with a room tinted), walls, the dock, and each area's name. */
function FloorMap({ map, picked, naming, onTap }: { map: RobotMap; picked: string[]; naming: string | null; onTap: (id: string) => void }) {
  const { width } = useWindowDimensions();
  const [x, y, w, h] = map.viewBox;
  // Wide maps fill the sheet's width; tall ones are kept to about a phone screen's height.
  const shown = Math.min(width - SP[5] * 2, 520);
  const height = Math.min((shown * h) / w, 460);
  const font = Math.max(w, h) / 30;
  return (
    <View style={{ borderRadius: R.lg, backgroundColor: C.inset, padding: SP[2], alignItems: 'center' }}>
      <Svg width="100%" height={height} viewBox={`${x} ${y} ${w} ${h}`} accessibilityLabel="The robot’s map. Tap a room to pick it.">
        {map.areas.map(a => {
          const on = picked.includes(a.id) || naming === a.id;
          return <Path key={a.id} d={a.path} fill={on ? alpha(C.amber, 0.55) : a.room ? alpha(C.blue, 0.2) : alpha(C.stone, 0.14)} stroke={on ? C.amber : alpha(C.stone, 0.35)} strokeWidth={font / 8} onPress={() => onTap(a.id)} />;
        })}
        <Path d={map.walls} fill="none" stroke={C.bone2} strokeWidth={font / 6} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
        {map.dock ? <Circle cx={map.dock.x} cy={map.dock.y} r={font / 2.2} fill={C.green} stroke={C.page} strokeWidth={font / 10} /> : null}
        {map.areas.map(a => (
          <SvgText key={`t${a.id}`} x={a.x} y={a.y + font / 3} fontSize={font} fontFamily={F[700]} textAnchor="middle" fill={picked.includes(a.id) || naming === a.id ? C.onAmber : C.bone} pointerEvents="none">{shortName(a.name)}</SvgText>
        ))}
      </Svg>
    </View>
  );
}
const shortName = (n: string) => n.length > 12 ? `${n.slice(0, 11)}…` : n;

/** Which room an area is in: the home's rooms to pick from. */
function AreaRoom({ D, areaId, name, own, room, onDone }: { D: Dev; areaId: string; name: string; own: string | null; room: string | null; onDone: () => void }) {
  const { act, snap } = useHub();
  const rooms = useMemo(() => placeChoices(snap?.rooms ?? [], '').filter(r => r.id !== 'unassigned' && r.id !== 'whole_home'), [snap?.rooms]);
  const set = async (to: string | null) => {
    const ok = await act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, { areaRooms: { [areaId]: to } }, to ? `${name} is ${rooms.find(r => r.id === to)?.name}` : `${name} has no room now`);
    if (ok) onDone();
  };
  return (
    <Card style={{ padding: SP[4], gap: SP[3] }}>
      <T v="headline">{room ? `${name}: which room is it?` : `Which room is ${name}?`}</T>
      {own ? <T v="footnote" color={C.stone2}>{`The robot’s app calls it “${own}”.`}</T> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
        {rooms.map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={r.id === room} onPress={() => void set(r.id === room ? null : r.id)} />)}
      </View>
      <Press onPress={onDone} label="Skip this one" style={{ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' }}><T v="labelSm" color={C.amber}>Skip this one</T></Press>
    </Card>
  );
}

/** Parts that wear, the most worn first; one at or near the end says so, and resets once replaced. */
function Parts({ D, parts, owner }: { D: Dev; parts: NonNullable<Dev['robot']>['parts'] & object; owner: boolean }) {
  const { send } = useHub();
  const [resetting, setResetting] = useState<string | null>(null);
  const sorted = [...parts].sort((a, b) => a.left - b.left);
  return (
    <Group title="Upkeep" note={owner ? 'Replaced a part? Tap it to start its count again.' : undefined}>
      {sorted.map((p, i) => (
        <View key={p.id}>
          <Press onPress={owner ? () => setResetting(resetting === p.id ? null : p.id) : undefined} disabled={!owner} label={`${p.name}, ${p.left}% left`} style={{ paddingVertical: SP[3], paddingHorizontal: SP[4], gap: SP[2], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
              <T v="headline" style={{ flex: 1 }}>{p.name}</T>
              <T v="footnote" weight={700} color={partColor(p.left)} tabular>{p.left <= 0 ? 'Replace now' : `${p.left}%${p.hoursLeft != null ? ` · ${p.hoursLeft} h` : ''}`}</T>
            </View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: C.control, overflow: 'hidden' }}>
              <View style={{ width: `${Math.max(2, p.left)}%`, height: 6, borderRadius: 3, backgroundColor: partColor(p.left) }} />
            </View>
          </Press>
          {resetting === p.id ? (
            <View style={{ flexDirection: 'row', gap: SP[2], paddingHorizontal: SP[4], paddingBottom: SP[3] }}>
              <View style={{ flex: 1 }}><Button full size="sm" icon="restart_alt" label={`Replaced: reset it`} onPress={async () => { if (await send(D.id, { robotSet: { resetPart: p.id } }, `${p.name}: counting from new`)) setResetting(null); }} /></View>
              <Button size="sm" kind="secondary" label="Cancel" onPress={() => setResetting(null)} />
            </View>
          ) : null}
        </View>
      ))}
    </Group>
  );
}

/** The robot's own settings, each where the model has it. */
function RobotSettingsGroup({ D, r }: { D: Dev; r: NonNullable<Dev['robot']> }) {
  const { send } = useHub();
  const s = r.settings ?? {};
  const set = (v: NonNullable<RobotCommand['settings']>, done: string) => void send(D.id, { robotSet: { settings: v } }, done);
  const rows: [keyof typeof s, string, string, string][] = [
    ['carpetBoost', 'layers', 'More suction on carpet', 'Carpet boost'],
    ['obstacles', 'visibility', 'Sees cables, socks and the like, and goes round them', 'Avoid things on the floor'],
    ['resume', 'battery_full', 'Recharges mid-clean, then finishes the job', 'Carry on after charging'],
    ['childLock', 'lock', 'The buttons on the robot don’t work', 'Child lock'],
    ['voiceAssistant', 'mic', 'Answers its own wake word', 'Voice assistant'],
    ['autoUpdate', 'cloud_download', 'Installs its own software updates', 'Automatic updates'],
  ];
  const shown = rows.filter(([k]) => typeof s[k] === 'boolean');
  return (
    <View style={{ gap: SP[3] }}>
      <Group title="Robot settings">
        {shown.map(([k, icon, sub, title], i) => <SwitchRow key={k} first={i === 0} icon={icon} title={title} sub={sub} on={!!s[k]} onChange={v => set({ [k]: v }, `${title}: ${v ? 'on' : 'off'}`)} />)}
        {s.quiet ? <Quiet q={s.quiet} first={!shown.length} onChange={q => set({ quiet: q }, q.on ? `Do not disturb ${q.start}–${q.end}` : 'Do not disturb off')} /> : null}
        {s.voice != null ? (
          <View style={{ padding: SP[4], gap: SP[2], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <T v="headline">Its voice</T>
            <Slider value={s.voice} min={0} max={s.voiceMax ?? 10} suffix="" color={C.blue} onColor={C.onBlue} icon="volume_up" label="Robot voice volume" onRelease={v => set({ voice: v }, v ? `Voice ${v} of ${s.voiceMax ?? 10}` : 'Its voice is off')} />
          </View>
        ) : null}
      </Group>
      <Button kind="secondary" icon="campaign" label="Find it" onPress={() => send(D.id, { robotSet: { locate: true } }, `${D.name} is saying where it is`)} />
    </View>
  );
}

/** Do not disturb: on or off, and when, from a few likely start and end times. */
function Quiet({ q, first, onChange }: { q: { on: boolean; start: string; end: string }; first: boolean; onChange: (q: { on: boolean; start: string; end: string }) => void }) {
  const [open, setOpen] = useState(false);
  const starts = [...new Set(['20:00', '21:00', '22:00', '23:00', q.start])].sort();
  const ends = [...new Set(['06:00', '07:00', '08:00', '09:00', q.end])].sort();
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 62, paddingVertical: SP[3], paddingHorizontal: SP[4] }}>
        <IconWell icon="do_not_disturb_on" color={q.on ? C.green : C.bone} bg={q.on ? undefined : C.selected} fill={q.on} size={36} />
        <Press onPress={() => setOpen(!open)} label={`Do not disturb, ${q.start} to ${q.end}. Change the times`} style={{ flex: 1, gap: 2 }}>
          <T v="headline">Do not disturb</T>
          <T v="footnote" color={C.amber}>{`${q.start}–${q.end} · change`}</T>
        </Press>
        <Switch label="Do not disturb" on={q.on} onChange={v => onChange({ ...q, on: v })} />
      </View>
      {open ? (
        <View style={{ paddingHorizontal: SP[4], paddingBottom: SP[4], gap: SP[2] }}>
          <T v="footnote" color={C.stone}>No talking, and no cleans it starts by itself, between</T>
          <HScroll>{starts.map(t => <Pill key={t} label={t} on={t === q.start} onPress={() => onChange({ ...q, on: true, start: t })} />)}</HScroll>
          <T v="footnote" color={C.stone}>and</T>
          <HScroll>{ends.map(t => <Pill key={t} label={t} on={t === q.end} onPress={() => onChange({ ...q, on: true, end: t })} />)}</HScroll>
        </View>
      ) : null}
    </View>
  );
}
