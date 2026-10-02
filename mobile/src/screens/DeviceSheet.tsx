import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, F, R, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { hubUrl } from '../logic/connect';
import { combinedOf, devs, FAN_SPEEDS, has, HVAC, ICON, isPlayer, stateOf, tint, type Dev } from '../logic/devices';
import { arcPath, clampTarget, TARGET_MAX, TARGET_MIN } from '../logic/climate';
import { Icon } from '../ui/Icon';
import { Button, Card, Group, IconButton, IconWell, Pill, HScroll, Press, Row, Section, Segmented, Sheet, Slider, Stat, Switch, SwitchRow, Tag } from '../ui/kit';
import { T } from '../ui/Text';
import { CameraStill } from './SecurityScreen';

const TEMPS: [number, string, string][] = [[2200, '#ffb56b', 'Candle'], [2700, '#ffc98a', 'Warm'], [3000, '#ffd9a8', 'Soft'], [4000, '#fff1dc', 'Neutral'], [5000, '#f4f7ff', 'Daylight']];
/** Inputs a TV with `input` can switch to. The one it's on is marked when the TV can say (through SmartThings). */
const INPUTS: [string, string][] = [['hdmi1', 'HDMI 1'], ['hdmi2', 'HDMI 2'], ['hdmi3', 'HDMI 3'], ['hdmi4', 'HDMI 4'], ['tv', 'TV']];
/** A soundbar's inputs (it says which it's on) and sound modes: [id, label, icon]. */
const BAR_INPUTS: [string, string, string][] = [['tv', 'TV (eARC)', 'tv'], ['hdmi1', 'HDMI 1', 'settings_input_hdmi'], ['hdmi2', 'HDMI 2', 'settings_input_hdmi'], ['bluetooth', 'Bluetooth', 'bluetooth'], ['wifi', 'Wi-Fi', 'wifi']];
const SOUNDS: [string, string, string][] = [['standard', 'Standard', 'equalizer'], ['surround', 'Surround', 'surround_sound'], ['game', 'Game', 'sports_esports'], ['adaptive', 'Adaptive', 'auto_awesome']];
const COLOURS: [string, string][] = [['#ff5a4e', 'Red'], ['#ff9f43', 'Orange'], ['#ffd93d', 'Yellow'], ['#6bd968', 'Green'], ['#3fd0c9', 'Teal'], ['#4aa3ff', 'Blue'], ['#8b6bff', 'Violet'], ['#ff6bd6', 'Pink']];
const MUSIC = '#c79bf2';

/** One choice of a few (an input, a sound mode): a tile with an icon, two to a row, the chosen one lit. */
function Choice({ label, icon, on, onPress, color = C.blue }: { label: string; icon: string; on: boolean; onPress: () => void; color?: string }) {
  return (
    <Press label={label} selected={on} onPress={onPress} style={{ flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: SP[3], height: 52, paddingHorizontal: SP[3], borderRadius: R.md,
      backgroundColor: on ? alpha(color, 0.16) : C.inset, borderWidth: 1, borderColor: on ? alpha(color, 0.45) : C.edge }}>
      <Icon name={icon} size={20} color={on ? color : C.stone} fill={on} />
      <T v="label" weight={on ? 700 : 600} color={on ? C.bone : C.bone2} numberOfLines={1} style={{ flex: 1 }}>{label}</T>
      {on ? <Icon name="check" size={18} color={color} /> : null}
    </Press>
  );
}

/** A text field with its button: "Play", "Save". */
function FieldWithButton({ value, onChange, placeholder, button, color = C.amber, onColor = C.onAmber, onSubmit, label, show }: { value: string; onChange: (v: string) => void; placeholder?: string; button: string; color?: string; onColor?: string; onSubmit: () => void; label: string; show?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: SP[2] }}>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone2} returnKeyType="go" onSubmitEditing={onSubmit} accessibilityLabel={label} autoCorrect={false}
        style={{ flex: 1, height: 48, paddingHorizontal: SP[3] + 2, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
      {(show ?? !!value.trim()) ? (
        <Press onPress={onSubmit} label={button} style={{ height: 48, paddingHorizontal: SP[4], borderRadius: R.md, backgroundColor: color, justifyContent: 'center' }}>
          <T v="label" color={onColor}>{button}</T>
        </Press>
      ) : null}
    </View>
  );
}

/** The air conditioner's dial: a 270° arc filled to the target in the mode's colour, the target in the middle. */
function Dial({ target, room, color, on }: { target: number; room: number | null; color: string; on: boolean }) {
  const size = 200, sw = 12, r = (size - sw) / 2 - 4;
  const f = (target - TARGET_MIN) / (TARGET_MAX - TARGET_MIN);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`Set to ${target} degrees${room != null ? `, room ${room} degrees` : ''}`}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Path d={arcPath(size / 2, size / 2, r, 1)} stroke={C.control} strokeWidth={sw} strokeLinecap="round" fill="none" />
        {on ? <Path d={arcPath(size / 2, size / 2, r, Math.max(0.02, f))} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" /> : null}
        {room != null ? (() => {
          const fr = Math.max(0, Math.min(1, (room - TARGET_MIN) / (TARGET_MAX - TARGET_MIN)));
          const a = (135 + fr * 270) * Math.PI / 180;
          return <Circle cx={size / 2 + r * Math.cos(a)} cy={size / 2 + r * Math.sin(a)} r={4} fill={C.bone} />;
        })() : null}
      </Svg>
      <T v="eyebrow" color={on ? color : C.stone2}>{on ? 'Set to' : 'Off'}</T>
      <T size={54} weight={700} tracking={-0.04} tabular color={on ? C.bone : C.stone}>{`${target}°`}</T>
      {room != null ? <T v="footnote" color={C.stone}>{`Room ${room}°`}</T> : null}
    </View>
  );
}

/** Every control a device has, why it's like this, and its settings. Opened from ⋯ or a long press on any tile. */
export function DeviceSheet() {
  const { snap, send, act, say, cfg } = useHub();
  const { id, close } = useSheet();
  const nav = useNav();
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [station, setStation] = useState('');
  const [musicShuffle, setMusicShuffle] = useState(false);
  // The AC's target answers each tap at once and goes to the hub once the taps stop.
  const [target, setTarget] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setName(null); setTitle(''); setStation(''); setTarget(null); }, [id]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const D = snap && id ? devs(snap)[id] : undefined;
  if (!snap || !D) return <Sheet open={false} onClose={close}>{null}</Sheet>;

  const t = tint(D);
  const [st, sf] = stateOf(D);
  const fav = (snap.favourites ?? []).includes(D.id);
  const draft = name ?? D.name;
  const combo = combinedOf(snap).find(c => c.deviceId === D.id);
  const settings = (body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, body, done);
  const group = snap.speakerGroups.find(g => g.deviceId === D.id);
  const readings = ([D.power != null && ['Using now', Math.abs(D.power) >= 1000 ? `${(D.power / 1000).toFixed(1)} kW` : `${Math.round(D.power)} W`, 'bolt'], D.energy != null && ['Today', `${D.energy} kWh`, 'electric_meter'], D.battery != null && D.type !== 'vacuum' && ['Battery', `${D.battery}%`, 'battery_full']] as const)
    .filter((x): x is [string, string, string] => !!x);
  const rooms = snap.rooms.some(r => r.id === D.room) ? snap.rooms : [...snap.rooms, { id: D.room, name: D.room === 'unassigned' ? 'No room' : D.room, icon: 'category' }];
  const roomName = rooms.find(r => r.id === D.room)?.name ?? '';
  const vac = D.type === 'vacuum' ? D.activity || (D.on ? 'cleaning' : 'docked') : null;
  const canPower = !['camera', 'sensor'].includes(D.type);
  const shownTarget = target ?? D.target ?? 24;
  const hv = HVAC.find(h => h[0] === D.hvac);
  const nudge = (d: number) => {
    const n = clampTarget(shownTarget + d);
    if (n === shownTarget) return;
    setTarget(n);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void send(D.id, { target: n }).finally(() => setTarget(null)); }, 600);
  };
  const playStation = () => { const w = station.trim(); if (w) { void send(D.id, { on: true, media: `Station: ${w}`, shuffle: true }, `Playing a station from ${w} on ${D.name}`); setStation(''); } };
  const playTitle = () => { if (title.trim()) { void send(D.id, { on: true, media: title.trim() }, `Playing on ${D.name}`); setTitle(''); } };
  const block = (k: string, title: string | undefined, body: ReactNode) => <Section key={k} title={title} caption gap={SP[2] + 2}>{body}</Section>;

  return (
    <Sheet open onClose={close} label={`${D.name} panel`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] + 2 }}>
        <IconWell icon={ICON[D.type] ?? 'devices'} color={D.online === false ? C.red : t.iconFg} bg={D.online === false ? C.redTint : t.iconBg} size={52} radius={26} fill />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="footnote" weight={600} color={C.stone}>{roomName}</T>
          <T v="title" numberOfLines={2}>{D.name}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T v="callout" weight={600} color={sf} numberOfLines={1} style={{ flexShrink: 1 }}>{st}</T>
          </View>
        </View>
        {canPower ? <Switch big label={`${D.name} power`} on={!!D.on} onChange={v => void send(D.id, isPlayer(D) && !v ? { on: false, media: null } : { on: v })} /> : null}
      </View>

      {(D.type === 'dimmer' || has(D, 'brightness')) ? block('bri', 'Brightness',
        <Slider value={D.bri ?? 100} min={1} icon="light_mode" label="Brightness" color={D.on ? (D.color || C.amber) : C.stone3} onRelease={v => void send(D.id, { on: true, bri: v })} />,
      ) : null}
      {has(D, 'colorTemp') && D.on ? block('k', 'Warmth',
        <View style={{ flexDirection: 'row', gap: SP[2] }}>
          {TEMPS.map(([k, bg, nm]) => {
            const a = D.k === k && !D.color;
            return (
              <Press key={k} onPress={() => void send(D.id, { on: true, k, color: null })} label={`${nm}, ${k} kelvin`} selected={a} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                <View style={{ width: '100%', height: 44, borderRadius: R.md, backgroundColor: bg, borderWidth: 2, borderColor: a ? C.bone : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {a ? <Icon name="check" size={20} color={C.coal} /> : null}
                </View>
                <T v="micro" size={10.5} color={a ? C.bone : C.stone}>{nm}</T>
              </Press>
            );
          })}
        </View>,
      ) : null}
      {has(D, 'color') && D.on ? block('c', 'Colour',
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {COLOURS.map(([c, nm]) => {
            const a = (D.color ?? '').toLowerCase() === c;
            return (
              <Press key={c} onPress={() => void send(D.id, { on: true, color: c })} label={nm} selected={a} style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: a ? C.bone : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c }} />
              </Press>
            );
          })}
        </View>,
      ) : null}

      {D.type === 'climate' ? (
        <View style={{ gap: SP[5] }}>
          <Card style={{ paddingVertical: SP[4], alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: SP[3] }}>
            <IconButton icon="remove" label="Cooler" size={52} onPress={() => nudge(-1)} />
            <Dial target={shownTarget} room={D.temp ?? null} color={hv?.[3] ?? C.blue} on={!!D.on} />
            <IconButton icon="add" label="Warmer" size={52} onPress={() => nudge(1)} />
          </Card>
          {block('hvac', 'Mode', <Segmented label="Mode" value={D.on ? D.hvac ?? null : null} options={HVAC.map(([id, label, icon, color]) => ({ id, label, icon, color }))} onChange={id => void send(D.id, { on: true, hvac: id as Dev['hvac'] })} />)}
          {block('fan', 'Fan', <Segmented compact label="Fan speed" value={D.fanSpeed ?? null} color={C.blue} options={FAN_SPEEDS.map(([id, label]) => ({ id, label }))} onChange={id => void send(D.id, { fanSpeed: id as Dev['fanSpeed'] })} />)}
        </View>
      ) : null}

      {isPlayer(D) ? (
        <View style={{ gap: SP[5] }}>
          {has(D, 'queue') && D.on && D.track ? (
            <Card style={{ padding: SP[4], gap: SP[4] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] + 2 }}>
                {D.track.art ? <Image source={{ uri: D.track.art }} style={{ width: 64, height: 64, borderRadius: R.sm + 2, backgroundColor: C.inset }} contentFit="cover" transition={200} /> : (
                  <View style={{ width: 64, height: 64, borderRadius: R.sm + 2, backgroundColor: alpha(MUSIC, 0.16), alignItems: 'center', justifyContent: 'center' }}><Icon name="music_note" size={28} color={MUSIC} /></View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="eyebrow" color={MUSIC}>Now playing</T>
                  <T v="headline" size={16} numberOfLines={1}>{D.track.title}</T>
                  <T v="footnote" color={C.stone} numberOfLines={1}>{[D.track.artist, D.media].filter(Boolean).join(' · ')}</T>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: SP[2] }}>
                <IconButton icon="shuffle" label={D.shuffle ? 'Shuffle is on. Play in order' : 'Shuffle'} tone="ghost" color={D.shuffle ? MUSIC : C.stone} onPress={() => void send(D.id, { shuffle: !D.shuffle }, D.shuffle ? 'Back in order' : 'Shuffled')} size={44} />
                <IconButton icon="skip_previous" label="Previous song" onPress={() => void send(D.id, { skip: -1 })} size={52} fill />
                {has(D, 'pause') ? <IconButton icon={D.paused ? 'play_arrow' : 'pause'} label={D.paused ? 'Play' : 'Pause'} tone="amber" onPress={() => void send(D.id, { paused: !D.paused })} size={60} fill /> : null}
                <IconButton icon="skip_next" label="Next song" onPress={() => void send(D.id, { skip: 1 })} size={52} fill />
                <View style={{ width: 44 }} />
              </View>
            </Card>
          ) : null}
          {block('vol', 'Volume',
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] + 2 }}>
              {has(D, 'mute') ? (
                <IconButton icon={D.muted ? 'volume_off' : 'volume_up'} label={D.muted ? 'Unmute' : 'Mute'} size={52} color={D.muted ? C.red : C.bone} onPress={() => void send(D.id, { muted: !D.muted })} />
              ) : null}
              <View style={{ flex: 1, opacity: D.muted ? 0.45 : 1 }}>
                <Slider value={D.vol ?? 30} color={C.blue} onColor={C.onBlue} icon={has(D, 'mute') ? undefined : 'volume_up'} label="Volume" onRelease={v => void send(D.id, { vol: v })} />
              </View>
            </View>,
          )}
          {has(D, 'pause') && D.on && !(has(D, 'queue') && D.track) ? (
            <View style={{ flexDirection: 'row', gap: SP[2] }}>
              <View style={{ flex: 1 }}><Button kind="blue" full icon={D.paused ? 'play_arrow' : 'pause'} label={D.paused ? 'Play' : 'Pause'} onPress={() => send(D.id, { paused: !D.paused })} /></View>
              <Button kind="secondary" icon="stop" label="Stop" onPress={() => send(D.id, { on: false, media: null })} />
            </View>
          ) : null}
          {has(D, 'queue') && snap.music?.length ? block('music', 'Your music',
            <View style={{ gap: SP[3] }}>
              <HScroll>
                <Pill icon="shuffle" label={musicShuffle ? 'Shuffle on' : 'Shuffle off'} on={musicShuffle} onPress={() => setMusicShuffle(v => !v)} />
                {snap.music.map(m => {
                  const sh = m.kind === 'all' || musicShuffle;
                  return <Pill key={m.name} icon={m.icon} label={m.name} on={!!D.on && D.media === m.name} onPress={() => void send(D.id, { on: true, media: m.name, shuffle: sh }, `Playing ${m.name}${sh && m.kind !== 'all' ? ' on shuffle' : ''} on ${D.name}`)} />;
                })}
              </HScroll>
              <FieldWithButton value={station} onChange={setStation} placeholder="A station from an artist, album or song" button="Play" color={MUSIC} onColor="#1a1020" onSubmit={playStation} label="Start a station" />
            </View>,
          ) : null}
          {has(D, 'sound') && D.on ? (
            <>
              {block('in', 'Input', <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>{BAR_INPUTS.map(([id, label, icon]) => <Choice key={id} label={label} icon={icon} on={D.input === id} onPress={() => void send(D.id, { input: id })} />)}</View>)}
              {block('snd', 'Sound', <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>{SOUNDS.map(([id, label, icon]) => <Choice key={id} label={label} icon={icon} on={D.sound === id} onPress={() => void send(D.id, { sound: id })} />)}</View>)}
              <Group><SwitchRow first icon="nightlight" iconFg={C.blue} color={C.blue} title="Night mode" sub="Softer loud scenes, clearer voices" on={!!D.night} onChange={v => void send(D.id, { night: v })} /></Group>
            </>
          ) : null}
          {has(D, 'input') && !has(D, 'sound') && D.on ? block('src', 'Source',
            <Segmented compact label="Source" value={D.input ?? null} color={C.blue} options={INPUTS.map(([id, label]) => ({ id, label }))} onChange={id => void send(D.id, { input: id }).then(ok => { if (ok) say(`${D.name} is on ${INPUTS.find(i => i[0] === id)?.[1]}`); })} />,
          ) : null}
          {has(D, 'library') ? block('lib', 'Play a film or show',
            <View style={{ gap: SP[2] }}>
              <FieldWithButton value={title} onChange={setTitle} placeholder="e.g. a film or a show" button="Play" color={C.blue} onColor={C.onBlue} onSubmit={playTitle} label="Film or show to play" />
              <T v="footnote" color={C.stone2}>Shows carry on from where you left off.</T>
            </View>,
          ) : snap.sources.length && has(D, 'media') ? block('play', 'Play',
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
              {snap.sources.map(so => <Choice key={so.name} label={so.name} icon={so.icon} on={!!D.on && D.media === so.name} onPress={() => void send(D.id, { on: true, media: so.name, vol: D.vol ?? 30 })} />)}
            </View>,
          ) : null}
          {group ? (
            <Card style={{ padding: SP[4], gap: SP[3] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                <IconWell icon={group.sync === 'perfect' ? 'graphic_eq' : 'sync'} color={group.sync === 'perfect' ? C.green : C.amber} size={36} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="headline" size={14}>{`Plays on ${group.members.length} speakers`}</T>
                  <T v="footnote" color={C.stone}>{group.sync === 'perfect' ? `In perfect sync through “${group.castGroup}”` : 'They start together'}</T>
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {group.members.map(m => <Tag key={m} text={snap.devices.find(x => x.id === m)?.name ?? m} color={C.blue} />)}
              </View>
            </Card>
          ) : null}
        </View>
      ) : null}

      {D.type === 'fan' ? block('fanmode', 'Mode',
        <Segmented label="Fan mode" value={D.on !== false ? D.mode ?? null : null} color={C.blue} options={[{ id: 'Auto', label: 'Auto', icon: 'auto_mode' }, { id: 'Sleep', label: 'Sleep', icon: 'bedtime' }, { id: 'Manual', label: 'Manual', icon: 'tune' }]} onChange={m => void send(D.id, { on: true, mode: m })} />,
      ) : null}

      {vac ? (
        <Card style={{ padding: SP[4], gap: SP[4] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="eyebrow" color={C.stone2}>Battery</T>
              <T v="title" tabular>{D.battery != null ? `${D.battery}%` : '–'}</T>
            </View>
            <Tag text={st.split(' · ')[0]} color={sf} />
          </View>
          {D.battery != null ? (
            <View style={{ height: 8, borderRadius: 4, backgroundColor: C.control, overflow: 'hidden' }}>
              <View style={{ width: `${D.battery}%`, height: 8, borderRadius: 4, backgroundColor: D.battery < 20 ? C.red : C.green }} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: SP[2] }}>
            <View style={{ flex: 1 }}><Button full icon="cleaning_services" label={vac === 'cleaning' ? 'Cleaning' : 'Clean'} kind={vac === 'cleaning' ? 'secondary' : 'primary'} onPress={() => send(D.id, { on: true })} /></View>
            <View style={{ flex: 1 }}><Button full icon="home" label={vac === 'docked' ? 'Docked' : vac === 'returning' ? 'Returning' : 'Dock'} kind="secondary" onPress={() => send(D.id, { on: false })} /></View>
          </View>
        </Card>
      ) : null}

      {D.type === 'camera' ? (
        <View style={{ gap: SP[3] }}>
          <View style={{ aspectRatio: 16 / 9, borderRadius: R.lg, overflow: 'hidden', backgroundColor: C.inset }}>
            <CameraStill uri={cfg ? hubUrl(cfg, `/api/devices/${encodeURIComponent(D.id)}/snapshot`, true) : null} off={D.online === false} label={`Latest picture from ${D.name}`} />
          </View>
          <Button full icon="videocam" label="Watch live" onPress={() => { close(); nav.navigate('Web', { title: D.name, path: `/phone.html?embed=1&cam=${encodeURIComponent(D.id)}` }); }} />
        </View>
      ) : null}

      {readings.length ? (
        <View style={{ flexDirection: 'row', gap: SP[2] }}>
          {readings.map(([k, v, icon]) => <Stat key={k} label={k} value={v} icon={icon} />)}
        </View>
      ) : null}

      {D.why ? (
        <Group>
          {[['help', 'Why it’s like this', D.why.now, C.stone], ['schedule', 'What’s next', D.why.next, C.amber]].map(([icon, k, v, fg], i) => (
            <View key={k} style={{ flexDirection: 'row', gap: SP[3], padding: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
              <Icon name={icon} size={20} color={fg} />
              <View style={{ flex: 1, gap: 3 }}>
                <T v="eyebrow" color={C.stone2}>{k}</T>
                <T v="callout" color={C.bone}>{v}</T>
              </View>
            </View>
          ))}
        </Group>
      ) : null}

      <View style={{ gap: SP[4] }}>
        <T v="overline" color={C.stone2}>Settings</T>
        <View style={{ gap: SP[2] }}>
          <T v="footnote" weight={600} color={C.bone2}>Name</T>
          <FieldWithButton value={draft} onChange={setName} button="Save" label="Name" show={!!draft.trim() && draft.trim() !== D.name} onSubmit={() => { const n = draft.trim(); if (n && n !== D.name) void settings({ name: n }, `Renamed to ${n}`).then(() => setName(null)); }} />
          {D.original && D.original.name !== D.name ? <T v="footnote" color={C.stone2}>{`${D.integration || 'The integration'} calls it “${D.original.name}”.`}</T> : null}
        </View>
        <View style={{ gap: SP[2] }}>
          <T v="footnote" weight={600} color={C.bone2}>Room</T>
          <HScroll>{rooms.map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={r.id === D.room} onPress={() => r.id !== D.room && void settings({ room: r.id }, `Moved to ${r.name}`)} />)}</HScroll>
        </View>
        <Group>
          <SwitchRow first icon="star" iconFg={C.amber} title="Favourite" sub="Keep it on Now" on={fav} onChange={() => void settings({ favourite: !fav }, fav ? 'Removed from favourites' : 'Added to favourites')} />
          <SwitchRow icon="visibility_off" iconFg={C.stone} title="Hide from lists" sub="It keeps working in modes" on={!!D.hidden} onChange={() => void settings({ hidden: !D.hidden }, D.hidden ? 'Shown in lists again' : 'Hidden from lists')} />
          <Row icon="routine" iconFg={C.bone} title="Used in" sub={D.usedIn?.length ? D.usedIn.map(u => u.name).join(' · ') : 'Not in any mode or overlay yet'} />
          {combo ? (
            <Row icon="join" iconFg={C.amber} title="One device, through two integrations" sub={`${combo.memberNames.join(' and ')}. Tap to separate them again.`}
              onPress={() => { void act('DELETE', `/api/combined/${encodeURIComponent(combo.id)}`, {}, `${combo.name} is two devices again`).then(ok => { if (ok) close(); }); }} />
          ) : null}
        </Group>
        <T mono size={11} color={C.stone2} center>{`${D.integration} · ${D.address}`}</T>
      </View>
    </Sheet>
  );
}
