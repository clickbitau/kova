import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TextInput, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Path } from 'react-native-svg';
import { C, F, R, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { VoiceNote } from './VoiceScreen';
import { hubUrl } from '../logic/connect';
import { AIR, combinedOf, devs, FAN_SPEEDS, filterNote, has, HVAC, ICON, iconOf, isPlayer, routerPanel, stateOf, tint, type Dev } from '../logic/devices';
import { arcPath, clampTarget, TARGET_MAX, TARGET_MIN } from '../logic/climate';
import { servesLine, snapOpen, suggestionsBody, toggleRoom, visibleZones, zoneRoomsBody, zoneRoomViews, roomWords } from '../logic/zones';
import { combineChoices, placeChoices, placeName } from '../logic/customise';
import { Icon } from '../ui/Icon';
import { Button, Card, Chips, Group, IconButton, Notice, IconWell, Pill, HScroll, Press, Row, Section, Segmented, Sheet, Slider, Stat, Switch, SwitchRow, Tag } from '../ui/kit';
import { T } from '../ui/Text';
import { CameraStill } from './SecurityScreen';
import { SensorReadings, WatchSettings } from './SensorPanel';
import { isSensor } from '../logic/sensors';
import { calibratedVol, trimOf } from '../logic/automations';
import { LOUDNESS_MAX, LOUDNESS_MIN, loudnessBody, loudnessWords, snapLoudness } from '../logic/media';

const TEMPS: [number, string, string][] = [[2200, '#ffb56b', 'Candle'], [2700, '#ffc98a', 'Warm'], [3000, '#ffd9a8', 'Soft'], [4000, '#fff1dc', 'Neutral'], [5000, '#f4f7ff', 'Daylight']];
/** Inputs a TV with `input` can switch to. The one it's on is marked when the TV can say (through SmartThings). */
const INPUTS: [string, string][] = [['hdmi1', 'HDMI 1'], ['hdmi2', 'HDMI 2'], ['hdmi3', 'HDMI 3'], ['hdmi4', 'HDMI 4'], ['tv', 'TV']];
/** A soundbar's inputs (it says which it's on) and sound modes: [id, label, icon]. */
const BAR_INPUTS: [string, string, string][] = [['tv', 'TV (eARC)', 'tv'], ['hdmi1', 'HDMI 1', 'settings_input_hdmi'], ['hdmi2', 'HDMI 2', 'settings_input_hdmi'], ['bluetooth', 'Bluetooth', 'bluetooth'], ['wifi', 'Wi-Fi', 'wifi']];
const SOUNDS: [string, string, string][] = [['standard', 'Standard', 'equalizer'], ['surround', 'Surround', 'surround_sound'], ['game', 'Game', 'sports_esports'], ['adaptive', 'Adaptive', 'auto_awesome']];
const COLOURS: [string, string][] = [['#ff5a4e', 'Red'], ['#ff9f43', 'Orange'], ['#ffd93d', 'Yellow'], ['#6bd968', 'Green'], ['#3fd0c9', 'Teal'], ['#4aa3ff', 'Blue'], ['#8b6bff', 'Violet'], ['#ff6bd6', 'Pink']];
const MUSIC = '#c79bf2';

/** One choice of a few (an input, a sound mode): a tile with an icon, two to a row, the chosen one lit. */
export function Choice({ label, icon, on, onPress, color = C.blue }: { label: string; icon: string; on: boolean; onPress: () => void; color?: string }) {
  // Two to a row, or one when half the row is too narrow for a label (a small phone with large text).
  const { fontScale } = useWindowDimensions();
  return (
    <Press label={label} selected={on} onPress={onPress} style={{ flexBasis: '47%', minWidth: 134 * Math.min(Math.max(fontScale, 1), 1.6), flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: SP[2] + 2, minHeight: 52, paddingVertical: SP[2], paddingHorizontal: SP[3], borderRadius: R.md,
      backgroundColor: on ? alpha(color, 0.16) : C.inset, borderWidth: 1, borderColor: on ? alpha(color, 0.45) : C.edge }}>
      <Icon name={icon} size={20} color={on ? color : C.stone} fill={on} />
      <T v="label" weight={on ? 700 : 600} color={on ? C.bone : C.bone2} numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>{label}</T>
      {on ? <Icon name="check" size={18} color={color} /> : null}
    </Press>
  );
}

/** A text field with its button: "Play", "Save". */
export function FieldWithButton({ value, onChange, placeholder, button, color = C.amber, onColor = C.onAmber, onSubmit, label, show }: { value: string; onChange: (v: string) => void; placeholder?: string; button: string; color?: string; onColor?: string; onSubmit: () => void; label: string; show?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: SP[2] }}>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone2} returnKeyType="go" onSubmitEditing={onSubmit} accessibilityLabel={label} autoCorrect={false}
        style={{ flex: 1, minWidth: 0, height: 48, paddingHorizontal: SP[3] + 2, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, color: C.bone, fontFamily: F[500], fontSize: 16 }} />
      {(show ?? !!value.trim()) ? (
        <Press onPress={onSubmit} label={button} style={{ height: 48, paddingHorizontal: SP[4], borderRadius: R.md, backgroundColor: color, justifyContent: 'center' }}>
          <T v="label" color={onColor}>{button}</T>
        </Press>
      ) : null}
    </View>
  );
}

/** The air conditioner's dial: a 270° arc filled to the target in the mode's colour, the target in the middle. */
function Dial({ target, room, color, on, size = 200 }: { target: number; room: number | null; color: string; on: boolean; size?: number }) {
  const sw = 12, r = (size - sw) / 2 - 4;
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
      <T size={Math.round(size * 0.27)} weight={700} tracking={-0.04} tabular color={on ? C.bone : C.stone} maxFontSizeMultiplier={1.15}>{`${target}°`}</T>
      {room != null ? <T v="footnote" color={C.stone}>{`Room ${room}°`}</T> : null}
    </View>
  );
}

/** Every control a device has, why it's like this, and its settings. Opened from ⋯ or a long press on any tile. */
export function DeviceSheet() {
  const { snap, send, act, say, cfg } = useHub();
  const { id, close } = useSheet();
  const nav = useNav();
  const { width, fontScale } = useWindowDimensions();
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [station, setStation] = useState('');
  const [musicShuffle, setMusicShuffle] = useState(false);
  // The AC's target answers each tap at once and goes to the hub once the taps stop.
  const [target, setTarget] = useState<number | null>(null);
  // Settings that open in place: combining with another device (searched by name), and archiving after a confirmation.
  const [panel, setPanel] = useState<'combine' | 'archive' | null>(null);
  const [combineQ, setCombineQ] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setName(null); setTitle(''); setStation(''); setTarget(null); setPanel(null); setCombineQ(''); }, [id]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const D = snap && id ? devs(snap)[id] : undefined;
  if (!snap || !D) return <Sheet open={false} onClose={close}>{null}</Sheet>;

  const t = tint(D);
  // The sheet's content width (20 pt each side), less the card's padding: room for − and + beside the dial?
  const inner = width - SP[5] * 2 - SP[3] * 2;
  const dialSide = inner >= 200 + 52 * 2 + SP[2] * 2;
  const dialSize = dialSide ? 200 : Math.min(200, inner);
  const [st, sf] = stateOf(D);
  const fav = (snap.favourites ?? []).includes(D.id);
  const draft = name ?? D.name;
  const combo = combinedOf(snap).find(c => c.deviceId === D.id);
  const settings = (body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, body, done);
  const group = snap.speakerGroups.find(g => g.deviceId === D.id);
  const router = routerPanel(snap, D);
  const readings = ([D.power != null && !router && ['Using now', Math.abs(D.power) >= 1000 ? `${(D.power / 1000).toFixed(1)} kW` : `${Math.round(D.power)} W`, 'bolt'], D.energy != null && ['Today', `${D.energy} kWh`, 'electric_meter'], D.battery != null && D.type !== 'vacuum' && ['Battery', `${D.battery}%`, 'battery_full']] as const)
    .filter((x): x is [string, string, string] => !!x);
  // Every room, then Whole home (a ducted air conditioner serves every room) and No room (where a deleted room's
  // devices go); a room the home doesn't know is shown as it is.
  const rooms = placeChoices(snap.rooms, D.room);
  const canCombine = !combo && !group && D.adapter !== 'combined' && D.adapter !== 'groups' && !combinedOf(snap).some(c => c.members.includes(D.id));
  const choices = panel === 'combine' ? combineChoices(D.id, snap.devices, combinedOf(snap), combineQ).slice(0, 30) : [];
  const combineWith = async (other: { id: string; name: string }) => {
    const ok = await act('POST', '/api/combined', { members: [D.id, other.id], name: D.name }, `${D.name} and ${other.name} are one device now`);
    if (ok) close();
    return ok;
  };
  const archive = async (on: boolean) => {
    const ok = await settings({ archived: on }, on ? `${D.name} archived` : `${D.name} restored`);
    if (ok && on) close();
    return ok;
  };
  const roomName = rooms.find(r => r.id === D.room)?.name ?? '';
  const vac = D.type === 'vacuum' ? D.activity || (D.on ? 'cleaning' : 'docked') : null;
  const sensor = isSensor(D) ? snap.sensors?.find(x => x.id === D.id) : undefined;
  const watched = isSensor(D) || D.type === 'camera';
  const canPower = !watched;
  const stackHead = width - SP[5] * 2 - 52 - 14 - (watched ? 0 : 68) < 190 * Math.max(1, fontScale);
  const power = canPower ? <Switch big label={`${D.name} power`} on={!!D.on} onChange={v => void send(D.id, isPlayer(D) && !v ? { on: false, media: null } : { on: v })} /> : null;
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
      {/* The name beside the icon and the switch where it has room; on a small phone or with large text it gets a line
          of its own under them, so a long name wraps by words instead of breaking. */}
      {stackHead ? (
        <View style={{ gap: SP[2] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <IconWell icon={sensor?.icon ?? iconOf(D)} color={D.online === false ? C.red : t.iconFg} bg={D.online === false ? C.redTint : t.iconBg} size={48} radius={24} fill />
            <T v="footnote" weight={600} color={C.stone} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{roomName}</T>
            {power}
          </View>
          <View style={{ gap: 2 }}>
            <T v="title">{D.name}</T>
            <T v="callout" weight={600} color={sf}>{st}</T>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] + 2 }}>
          <IconWell icon={sensor?.icon ?? iconOf(D)} color={D.online === false ? C.red : t.iconFg} bg={D.online === false ? C.redTint : t.iconBg} size={52} radius={26} fill />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T v="footnote" weight={600} color={C.stone} numberOfLines={1}>{roomName}</T>
            <T v="title" numberOfLines={3}>{D.name}</T>
            <T v="callout" weight={600} color={sf} numberOfLines={2}>{st}</T>
          </View>
          {power}
        </View>
      )}

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
          {/* The dial between − and + where they fit beside it; on a small phone, − and + sit under it. */}
          <Card style={{ paddingVertical: SP[4], alignItems: 'center', flexDirection: dialSide ? 'row' : 'column', justifyContent: 'space-between', paddingHorizontal: SP[3], gap: dialSide ? 0 : SP[2] }}>
            {dialSide ? <IconButton icon="remove" label="Cooler" size={52} onPress={() => nudge(-1)} /> : null}
            <Dial target={shownTarget} room={D.temp ?? null} color={hv?.[3] ?? C.blue} on={!!D.on} size={dialSize} />
            {dialSide ? <IconButton icon="add" label="Warmer" size={52} onPress={() => nudge(1)} /> : (
              <View style={{ flexDirection: 'row', gap: SP[6] }}>
                <IconButton icon="remove" label="Cooler" size={52} onPress={() => nudge(-1)} />
                <IconButton icon="add" label="Warmer" size={52} onPress={() => nudge(1)} />
              </View>
            )}
          </Card>
          {block('hvac', 'Mode', <Segmented label="Mode" value={D.on ? D.hvac ?? null : null} options={HVAC.map(([id, label, icon, color]) => ({ id, label, icon, color }))} onChange={id => void send(D.id, { on: true, hvac: id as Dev['hvac'] })} />)}
          {block('fan', 'Fan', <Chips label="Fan speed" value={D.fanSpeed ?? null} color={C.blue} options={FAN_SPEEDS.map(([id, label]) => ({ id, label }))} onChange={id => void send(D.id, { fanSpeed: id as Dev['fanSpeed'] })} />)}
          {D.zones?.length ? <Zones D={D} /> : null}
          {D.zones?.length && snap?.roomClimate ? <VoiceNote integration={D.integration} onOpen={() => { close(); nav.navigate('Voice'); }} /> : null}
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
          {D.canAnnounce ? block('loud', 'Announcement loudness',
            <View style={{ gap: SP[2] }}>
              <Slider value={trimOf(D)} min={LOUDNESS_MIN} max={LOUDNESS_MAX} color={C.blue} onColor={C.onBlue} icon="campaign" label="Announcement loudness"
                onRelease={v => { const n = snapLoudness(v); void settings(loudnessBody(n), `${D.name}: announcements ${loudnessWords(n)}`); }} />
              <T v="footnote" color={C.stone2}>{`A 20% announcement plays at ${calibratedVol(20, trimOf(D))}% here. A speaker that sounds louder than the rest gets less.`}</T>
              <Press onPress={() => { close(); nav.navigate('SpeakerLoudness'); }} label="Speaker loudness: every speaker, with a test" style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], alignSelf: 'flex-start', minHeight: 36 }}>
                <Icon name="tune" size={17} color={C.amber} />
                <T v="labelSm" color={C.amber}>Speaker loudness</T>
              </Press>
            </View>,
          ) : null}
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

      {D.type === 'fan' && has(D, 'purifier') ? <Purifier D={D} /> : null}
      {router ? <RouterPower P={router} /> : null}
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
          <Button full icon="videocam" label="View camera" onPress={() => { close(); nav.navigate('Camera', { id: D.id }); }} />
        </View>
      ) : null}

      {sensor ? <SensorReadings v={sensor} /> : null}

      {readings.length && !sensor ? (
        <View style={{ flexDirection: 'row', gap: SP[2] }}>
          {readings.map(([k, v, icon]) => <Stat key={k} label={k} value={v} icon={icon} />)}
        </View>
      ) : null}

      {D.why && !watched ? (
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
        {watched ? <WatchSettings D={D} /> : null}
        <Group>
          <SwitchRow first icon="star" iconFg={C.amber} title="Favourite" sub="Keep it on Now" on={fav} onChange={() => void settings({ favourite: !fav }, fav ? 'Removed from favourites' : 'Added to favourites')} />
          <SwitchRow icon="visibility_off" iconFg={C.stone} title="Hide from lists" sub={watched ? 'It keeps working in automations' : 'It keeps working in modes'} on={!!D.hidden} onChange={() => void settings({ hidden: !D.hidden }, D.hidden ? 'Shown in lists again' : 'Hidden from lists')} />
          <Row icon="routine" iconFg={C.bone} title="Used in" sub={D.usedIn?.length ? D.usedIn.map(u => u.name).join(' · ') : 'Not in any mode or overlay yet'} />
          {combo ? (
            <Row icon="join" iconFg={C.amber} title="One device, through two integrations" sub={`${combo.memberNames.join(' and ')}. Tap to separate them again.`}
              onPress={() => { void act('DELETE', `/api/combined/${encodeURIComponent(combo.id)}`, {}, `${combo.name} is two devices again`).then(ok => { if (ok) close(); }); }} />
          ) : null}
          {canCombine ? (
            <Row icon="join" iconFg={C.amber} title="Combine with another device…" sub="When it’s the same thing reached through two integrations" onPress={() => setPanel(panel === 'combine' ? null : 'combine')} />
          ) : null}
          <Row icon={D.archived ? 'history' : 'remove_circle'} iconFg={D.archived ? C.green : C.stone} title={D.archived ? 'Restore' : 'Archive…'}
            sub={D.archived ? 'Archived: back into lists, Ask Kova and modes' : 'Gone, or not wanted: out of every list'}
            onPress={() => { if (D.archived) void archive(false); else setPanel(panel === 'archive' ? null : 'archive'); }} />
        </Group>
        {panel === 'combine' ? (
          <Card style={{ padding: SP[4], gap: SP[3] }}>
            <T v="headline">{`Combine ${D.name} with`}</T>
            <TextInput value={combineQ} onChangeText={setCombineQ} placeholder="Search by name" placeholderTextColor={C.stone2} accessibilityLabel="Search devices" autoCorrect={false}
              style={{ height: 44, paddingHorizontal: SP[3], borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.inset, color: C.bone, fontFamily: F[500], fontSize: 15 }} />
            {choices.length ? (
              <Group>
                {choices.map((o, i) => <Row key={o.id} first={i === 0} icon={ICON[o.type] ?? 'devices'} title={o.name} sub={`${placeName(o.room, snap.rooms)} · ${o.integration}`} onPress={() => void combineWith(o)} />)}
              </Group>
            ) : <T v="footnote" color={C.stone}>{combineQ ? `Nothing called “${combineQ}”.` : 'No other device to combine with.'}</T>}
            <T v="footnote" color={C.stone2}>They show as one, named “{D.name}”; each command goes through whichever of them can do it. Separate them again any time.</T>
          </Card>
        ) : null}
        {panel === 'archive' ? (
          <Card tint={C.red} style={{ padding: SP[4], gap: SP[3] }}>
            <T v="headline">{`Archive ${D.name}?`}</T>
            <T v="footnote" color={C.stone}>It leaves every list, Ask Kova and alerts, and modes leave it alone. Restore it from Customise home → Archived.</T>
            <View style={{ flexDirection: 'row', gap: SP[2] }}>
              <View style={{ flex: 1 }}><Button full kind="secondary" label="Keep it" onPress={() => setPanel(null)} /></View>
              <View style={{ flex: 1 }}><Button full kind="danger" icon="remove_circle" label="Archive" onPress={() => archive(true)} /></View>
            </View>
          </Card>
        ) : null}
        <T mono size={11} color={C.stone2} center>{`${D.integration} · ${D.address}`}</T>
      </View>
    </Sheet>
  );
}

/**
 * A ducted air conditioner's zones: name (tap to rename), on or off, how far open, and the rooms each one serves
 * (one or several), so rooms show and control their zone. Kova suggests rooms from the zones' names; the owner
 * confirms them one by one, or all at once. The ones in use first.
 */
function Zones({ D }: { D: Dev }) {
  const { send, act, snap } = useHub();
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState<number | null>(null);
  const rooms = snap?.rooms ?? [];
  const zones = zoneRoomViews(visibleZones(D.zones, D.zoneNames ?? {}, all), D, rooms);
  const total = D.zones?.length ?? 0;
  const suggested = suggestionsBody(D, rooms);
  const settings = (body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, body, done);
  const set = (n: number, c: { on?: boolean; open?: number }) => void send(D.id, { zoneSet: { [n]: c } });
  const rename = (n: number) => {
    setEditing(null);
    void settings({ zoneNames: { [n]: draft.trim() || null } }, draft.trim() ? `Zone ${n} is “${draft.trim()}”` : `Zone ${n} unnamed`);
  };
  const serve = (z: { n: number; name: string }, ids: string[]) => settings(zoneRoomsBody(z.n, ids), ids.length ? `${z.name} serves ${roomWords(ids, rooms)}` : `${z.name} serves no room`);
  const pending = zones.filter(z => z.suggest.length).length;
  const right = total > zones.length || all
    ? <Press onPress={() => setAll(!all)} label={all ? 'Show only zones in use' : `Show all ${total} zones`} hitSlop={10}><T v="footnote" weight={700} color={C.amber}>{all ? 'In use' : `All ${total}`}</T></Press>
    : undefined;
  return (
    <Section title="Zones" caption gap={SP[2]} right={right}>
      {suggested ? (
        // Kova's suggestions, all at once: the app's suggestion card (as for combining devices).
        <Card tint={C.amber} style={{ gap: SP[2], padding: SP[4], backgroundColor: alpha(C.amber, 0.07) }}>
          <View style={{ flexDirection: 'row', gap: SP[2], alignItems: 'flex-start' }}>
            <Icon name="auto_awesome" size={20} color={C.amber} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="eyebrow" color={C.amber}>Suggested rooms</T>
              <T v="headline">{`Kova matched ${Object.keys(suggested.zoneRooms).length === 1 ? 'a zone' : `${Object.keys(suggested.zoneRooms).length} zones`} to rooms`}</T>
              <T v="footnote" color={C.stone}>From the zones’ names. Check each one below, or use them all.</T>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button size="sm" label="Use all suggestions" onPress={() => settings(suggested, 'Zones matched to rooms')} />
          </View>
        </Card>
      ) : null}
      {!zones.length ? <T v="footnote" color={C.stone}>No zones open.</T> : null}
      {zones.map(z => (
        <Card key={z.n} style={{ padding: SP[4], gap: SP[3] }}>
          {/* Name (never cut short: it wraps), then open or closed and the switch, which drop below when space is short. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SP[3], rowGap: SP[2] }}>
            {editing === z.n ? (
              <TextInput autoFocus value={draft} onChangeText={setDraft} onSubmitEditing={() => rename(z.n)} onBlur={() => rename(z.n)} placeholder={`Zone ${z.n}`} placeholderTextColor={C.stone3}
                accessibilityLabel={`Name for zone ${z.n}`} returnKeyType="done" style={{ flexGrow: 1, flexBasis: 140, color: C.bone, fontFamily: F[700], fontSize: 15, paddingVertical: 2 }} />
            ) : (
              <Press onPress={() => { setDraft(D.zoneNames?.[String(z.n)] ?? ''); setEditing(z.n); }} label={`${z.name}, rename`} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 'auto', maxWidth: '100%' }}>
                <T v="headline" color={z.on ? C.bone : C.bone2}>{z.name}</T>
              </Press>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], marginLeft: 'auto' }}>
              <T v="footnote" color={z.on ? C.blue : C.stone}>{z.on ? `${z.open}% open` : 'Closed'}</T>
              <Switch on={z.on} color={C.blue} label={`${z.name} open`} onChange={v => set(z.n, { on: v })} />
            </View>
          </View>
          {/* How far open, while it's open (as on the room's card); closed, the switch opens it. */}
          {z.on ? <Slider value={z.open} color={C.blue} onColor={C.onBlue} label={`${z.name} opening`} onRelease={v => set(z.n, { on: true, open: snapOpen(v) })} /> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SP[3], rowGap: SP[2], paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 150, flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
              <Icon name="meeting_room" size={18} color={z.rooms.length ? C.stone : C.stone2} />
              <View style={{ flex: 1, gap: 1 }}>
                <T v="eyebrow" color={C.stone2}>Serves</T>
                <T v="callout" weight={600} color={z.rooms.length ? C.bone : C.stone}>{z.rooms.length ? servesLine(z, rooms) : 'No room yet'}</T>
              </View>
            </View>
            <View style={{ marginLeft: 'auto' }}>
              <Button size="sm" kind="secondary" icon={picking === z.n ? 'check' : 'edit'} label={picking === z.n ? 'Done' : 'Choose rooms'} onPress={() => setPicking(picking === z.n ? null : z.n)} />
            </View>
          </View>
          {picking === z.n ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {rooms.map(r => <Pill key={r.id} icon={r.icon} label={r.name} on={z.rooms.includes(r.id)} onPress={() => void serve(z, toggleRoom(z.rooms, r.id))} />)}
            </View>
          ) : z.suggest.length ? (
            <Card tint={C.amber} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SP[3], rowGap: SP[2], padding: SP[3], backgroundColor: alpha(C.amber, 0.07) }}>
              <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 150, flexDirection: 'row', gap: SP[2], alignItems: 'flex-start' }}>
                <Icon name="auto_awesome" size={18} color={C.amber} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="eyebrow" color={C.amber}>Kova suggests</T>
                  <T v="headline">{roomWords(z.suggest, rooms)}</T>
                </View>
              </View>
              <View style={{ marginLeft: 'auto' }}>
                <Button size="sm" label="Confirm" onPress={() => serve(z, z.suggest)} />
              </View>
            </Card>
          ) : null}
        </Card>
      ))}
      {pending === 0 && zones.some(z => z.rooms.length) ? <T v="micro" color={C.stone2}>Each room shows its zone in Devices. A zone can serve several rooms.</T> : null}
    </Section>
  );
}

/** The router's hardware (Warden, from its BMC): what it draws, each power supply with what's wrong, redundancy, temperatures and fans. */
function RouterPower({ P }: { P: NonNullable<ReturnType<typeof routerPanel>> }) {
  return (
    <View style={{ gap: SP[4] }}>
      {P.alert ? (
        <Notice compact icon="power_off" color={P.alert.color} title={P.alert.text} />
      ) : null}
      <View style={{ flexDirection: 'row', gap: SP[2] }}>
        <Card style={{ flex: 1, padding: SP[3] + 2, gap: 2 }}>
          <T v="footnote" color={C.stone}>{P.title}</T>
          <T v="title" tabular>{P.watts}</T>
          <T v="micro" color={C.stone2}>{P.wattsNote}</T>
        </Card>
        <Card style={{ flex: 1, padding: SP[3] + 2, gap: 2 }}>
          <T v="footnote" color={C.stone}>Redundancy</T>
          <T v="title" color={P.redundancy.color}>{P.redundancy.label}</T>
          <T v="micro" color={C.stone2}>{P.redundancy.note}</T>
        </Card>
      </View>
      {P.supplies.length ? (
        <Group title="Power supplies">
          {P.supplies.map((x, i) => (
            <View key={x.name} accessible accessibilityLabel={`${x.name}: ${x.badge}`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingHorizontal: SP[4], paddingVertical: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
              <Icon name={x.icon} size={20} color={x.color} fill />
              <T v="body" weight={600} numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>{x.name}</T>
              <Tag text={x.badge} color={x.color} />
            </View>
          ))}
        </Group>
      ) : null}
      {P.temps.length ? (
        <Section title="Temperatures" caption gap={SP[2]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            {P.temps.map(x => (
              <Card key={x.name} style={{ flexBasis: '47%', flexGrow: 1, padding: SP[3], gap: 2 }}>
                <T v="footnote" color={C.stone} numberOfLines={2}>{x.name}</T>
                <T v="headline" color={x.color} tabular>{x.value}</T>
              </Card>
            ))}
          </View>
        </Section>
      ) : null}
      {P.fans.length || P.fanMode ? (
        <Section title="Fans" caption gap={SP[2]} right={P.fanMode ? <T v="footnote" color={C.stone}>{P.fanMode}</T> : undefined}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{P.fans.map(f => <Tag key={f} text={f} color={C.stone} />)}</View>
        </Section>
      ) : null}
      <T v="micro" color={C.stone2}>From the router’s BMC, through Warden. Read every 5 minutes, and at once when a supply changes.</T>
    </View>
  );
}

/** An air purifier: the air and the filter, fan speed (choosing one switches to Manual), display and child lock. */
function Purifier({ D }: { D: Dev }) {
  const { send } = useHub();
  const air = AIR[D.airQuality ?? 0];
  const fl = D.filterLife;
  const flColor = fl == null ? C.stone : fl <= 10 ? C.red : fl <= 20 ? C.amber : C.green;
  const max = D.fanLevelMax ?? 3;
  return (
    <View style={{ gap: SP[4] }}>
      <View style={{ flexDirection: 'row', gap: SP[2] }}>
        <Card style={{ flex: 1, gap: 2 }}>
          <T v="footnote" color={C.stone}>Air</T>
          <T v="title" color={air?.[1] ?? C.stone}>{air?.[0] ?? 'Not reported'}</T>
          {D.pm25 != null ? <T v="micro" color={C.stone2}>{`PM2.5 ${D.pm25} µg/m³`}</T> : null}
        </Card>
        <Card style={{ flex: 1, gap: SP[1] }}>
          <T v="footnote" color={C.stone}>Filter</T>
          <T v="title" color={flColor}>{fl != null ? `${fl}%` : '—'}</T>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: C.control, overflow: 'hidden' }}><View style={{ width: `${Math.max(0, Math.min(100, fl ?? 0))}%`, height: 5, backgroundColor: flColor }} /></View>
          {filterNote(fl) ? <T v="micro" color={flColor}>{filterNote(fl)}</T> : null}
        </Card>
      </View>
      <Section title="Fan speed" caption gap={SP[2]}>
        <Segmented label="Fan speed" value={D.on && D.mode === 'Manual' && D.fanLevel ? String(D.fanLevel) : null} color={C.blue}
          options={Array.from({ length: max }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }))} onChange={v => void send(D.id, { on: true, fanLevel: Number(v), mode: 'Manual' })} />
        <T v="micro" color={C.stone2}>Choosing a speed switches it to Manual.</T>
      </Section>
      <Group>
        <SwitchRow first icon="brightness_6" title="Display" on={D.display !== false} onChange={v => void send(D.id, { display: v })} />
        <SwitchRow icon="lock" title="Child lock" on={!!D.childLock} onChange={v => void send(D.id, { childLock: v })} />
      </Group>
    </View>
  );
}
