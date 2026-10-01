import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { C, F } from '../theme';
import { useHub } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { devs, has, ICON, isPlayer, stateOf, tint } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Button, HScroll, Pill, Press, Sheet, Slider, Switch } from '../ui/kit';
import { T } from '../ui/Text';

const TEMPS: [number, string][] = [[2200, '#ffb56b'], [2700, '#ffc98a'], [3000, '#ffd9a8'], [4000, '#fff1dc'], [5000, '#f4f7ff']];
/** Inputs a TV with `input` can switch to (the TV can't say which it's on, so none shows as selected). */
const INPUTS: [string, string][] = [['hdmi1', 'HDMI 1'], ['hdmi2', 'HDMI 2'], ['hdmi3', 'HDMI 3'], ['hdmi4', 'HDMI 4'], ['tv', 'TV']];
const COLOURS = ['#ff5a4e', '#ff9f43', '#ffd93d', '#6bd968', '#3fd0c9', '#4aa3ff', '#8b6bff', '#ff6bd6'];

const Label = ({ children }: { children: string }) => <T size={13} weight={600}>{children}</T>;

/** Every control a device has, why it's like this, and its settings. Opened from ⋯ on any tile. */
export function DeviceSheet() {
  const { snap, send, act, say } = useHub();
  const { id, close } = useSheet();
  const nav = useNav();
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [station, setStation] = useState('');
  const [musicShuffle, setMusicShuffle] = useState(false);
  useEffect(() => { setName(null); setTitle(''); setStation(''); }, [id]);
  const D = snap && id ? devs(snap)[id] : undefined;
  if (!snap || !D) return <Sheet open={false} onClose={close}>{null}</Sheet>;

  const t = tint(D);
  const [st, sf] = stateOf(D);
  const fav = (snap.favourites ?? []).includes(D.id);
  const draft = name ?? D.name;
  const settings = (body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, body, done);
  const group = snap.speakerGroups.find(g => g.deviceId === D.id);
  const readings = [D.power != null && ['Using now', Math.abs(D.power) >= 1000 ? `${(D.power / 1000).toFixed(1)} kW` : `${Math.round(D.power)} W`], D.energy != null && ['Energy', `${D.energy} kWh`], D.battery != null && ['Battery', `${D.battery}%`]]
    .filter((x): x is [string, string] => !!x);
  const rooms = snap.rooms.some(r => r.id === D.room) ? snap.rooms : [...snap.rooms, { id: D.room, name: D.room === 'unassigned' ? 'No room' : D.room, icon: 'category' }];
  const modes = D.type === 'fan' ? [['Auto', 'auto_mode'], ['Sleep', 'bedtime'], ['Manual', 'tune']] : [];
  const vac = D.type === 'vacuum' ? D.activity || (D.on ? 'cleaning' : 'docked') : null;

  return (
    <Sheet open onClose={close}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={ICON[D.type] ?? 'devices'} size={24} color={t.iconFg} fill />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <T size={12} color={C.stone}>{rooms.find(r => r.id === D.room)?.name ?? ''}</T>
          <T size={22} weight={700} tracking={-0.02} numberOfLines={2}>{D.name}</T>
          <T size={13} color={sf}>{st}</T>
        </View>
        {!['camera', 'sensor'].includes(D.type) ? (
          <Switch big on={!!D.on} onChange={v => void send(D.id, isPlayer(D) && !v ? { on: false, media: null } : { on: v })} />
        ) : null}
      </View>

      {(D.type === 'dimmer' || has(D, 'brightness')) && D.on ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Label>Brightness</Label><T mono size={12} color={C.stone}>{`${D.bri}%`}</T></View>
          <Slider value={D.bri ?? 100} min={1} onRelease={v => void send(D.id, { on: true, bri: v })} />
        </View>
      ) : null}
      {has(D, 'colorTemp') && D.on ? (
        <View style={{ gap: 8 }}>
          <Label>Warmth</Label>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {TEMPS.map(([k, bg]) => (
              <Press key={k} onPress={() => void send(D.id, { on: true, k, color: null })} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
                <View style={{ width: '100%', height: 34, borderRadius: 10, backgroundColor: bg, borderWidth: D.k === k && !D.color ? 2 : 0, borderColor: C.amber }} />
                <T mono size={10} color={C.stone}>{`${k}K`}</T>
              </Press>
            ))}
          </View>
        </View>
      ) : null}
      {has(D, 'color') && D.on ? (
        <View style={{ gap: 8 }}>
          <Label>Colour</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {COLOURS.map(c => (
              <Press key={c} onPress={() => void send(D.id, { on: true, color: c })} label={`Colour ${c}`} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c, borderWidth: (D.color ?? '').toLowerCase() === c ? 2 : 0, borderColor: '#fff' }} />
            ))}
          </View>
        </View>
      ) : null}

      {isPlayer(D) ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="volume_down" size={20} color={C.stone} />
            <View style={{ flex: 1 }}><Slider value={D.vol ?? 30} color={C.blue} onRelease={v => void send(D.id, { vol: v })} /></View>
            <T mono size={12} color={C.stone} style={{ width: 36, textAlign: 'right' }}>{`${D.vol ?? 30}%`}</T>
          </View>
          {has(D, 'queue') && D.on && D.track ? (
            <View style={{ gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {D.track.art ? <Image source={{ uri: D.track.art }} style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: C.inset }} contentFit="cover" /> : (
                  <View style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}><Icon name="music_note" size={24} color={C.blue} /></View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={15} weight={700} numberOfLines={1}>{D.track.title}</T>
                  <T size={12.5} color={C.stone} numberOfLines={1}>{[D.track.artist, D.media].filter(Boolean).join(' · ')}</T>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 18 }}>
                <Press label="Shuffle" onPress={() => void send(D.id, { shuffle: !D.shuffle }, D.shuffle ? 'Back in order' : 'Shuffled')} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: D.shuffle ? 'rgba(199,155,242,0.2)' : 'transparent' }}>
                  <Icon name="shuffle" size={21} color={D.shuffle ? '#c79bf2' : C.stone} />
                </Press>
                <Press label="Previous song" onPress={() => void send(D.id, { skip: -1 })} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: C.inset }}>
                  <Icon name="skip_previous" size={26} fill />
                </Press>
                <Press label="Next song" onPress={() => void send(D.id, { skip: 1 })} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: C.inset }}>
                  <Icon name="skip_next" size={26} fill />
                </Press>
                <View style={{ width: 42 }} />
              </View>
            </View>
          ) : null}
          {has(D, 'queue') && snap.music?.length ? (
            <View style={{ gap: 8 }}>
              <Label>Helix music</Label>
              <HScroll>
                <Pill label={musicShuffle ? 'Shuffle on' : 'Shuffle off'} on={musicShuffle} onPress={() => setMusicShuffle(v => !v)} />
                {snap.music.map(m => {
                  const sh = m.kind === 'all' || musicShuffle;
                  return <Pill key={m.name} label={m.name} on={D.on && D.media === m.name} onPress={() => void send(D.id, { on: true, media: m.name, shuffle: sh }, `Playing ${m.name}${sh && m.kind !== 'all' ? ' on shuffle' : ''} on ${D.name}`)} />;
                })}
              </HScroll>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput value={station} onChangeText={setStation} placeholder="A station from… an artist, album or song" placeholderTextColor={C.stone3} returnKeyType="go"
                  onSubmitEditing={() => { const w = station.trim(); if (w) { void send(D.id, { on: true, media: `Station: ${w}`, shuffle: true }, `Playing a station from ${w} on ${D.name}`); setStation(''); } }}
                  style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.card, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
                <Press onPress={() => { const w = station.trim(); if (w) { void send(D.id, { on: true, media: `Station: ${w}`, shuffle: true }, `Playing a station from ${w} on ${D.name}`); setStation(''); } }} style={{ paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#c79bf2', justifyContent: 'center' }}>
                  <T size={13} weight={700} color="#1a1020">Play</T>
                </Press>
              </View>
            </View>
          ) : null}
          {has(D, 'input') && D.on ? (
            <View style={{ gap: 8 }}>
              <Label>Source</Label>
              <HScroll>
                {INPUTS.map(([id, label]) => (
                  <Pill key={id} label={label} onPress={() => void send(D.id, { input: id }).then(ok => { if (ok) say(`${D.name} is on ${label}`); })} />
                ))}
              </HScroll>
            </View>
          ) : null}
          {has(D, 'pause') && D.on ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Press onPress={() => void send(D.id, { paused: !D.paused })} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 11, borderRadius: 12, backgroundColor: 'rgba(124,184,240,0.16)' }}>
                <Icon name={D.paused ? 'play_arrow' : 'pause'} size={19} color={C.blue} />
                <T size={14} weight={700} color={C.blue}>{D.paused ? 'Carry on' : 'Pause'}</T>
              </Press>
              <Press onPress={() => void send(D.id, { on: false, media: null })} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.inset }}>
                <Icon name="stop" size={19} />
                <T size={14} weight={700}>Stop</T>
              </Press>
            </View>
          ) : null}
          {has(D, 'library') ? (
            <View style={{ gap: 8 }}>
              <Label>Play a film or show</Label>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput value={title} onChangeText={setTitle} placeholder="e.g. The Office" placeholderTextColor={C.stone3} returnKeyType="go"
                  onSubmitEditing={() => { if (title.trim()) { void send(D.id, { on: true, media: title.trim() }, `Playing on ${D.name}`); setTitle(''); } }}
                  style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.card, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
                <Press onPress={() => { if (title.trim()) { void send(D.id, { on: true, media: title.trim() }, `Playing on ${D.name}`); setTitle(''); } }} style={{ paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.blue, justifyContent: 'center' }}>
                  <T size={13} weight={700} color={C.onBlue}>Play</T>
                </Press>
              </View>
              <T size={12} color={C.stone}>Shows carry on from where you left off.</T>
            </View>
          ) : snap.sources.length ? (
            <View style={{ gap: 8 }}>
              <Label>Play</Label>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {snap.sources.map(so => {
                  const a = D.on && D.media === so.name;
                  return (
                    <Press key={so.name} onPress={() => void send(D.id, { on: true, media: so.name, vol: D.vol ?? 30 })} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, backgroundColor: a ? 'rgba(124,184,240,0.2)' : C.inset }}>
                      <Icon name={so.icon} size={17} color={a ? C.blue : C.bone2} />
                      <T size={13} weight={600} color={a ? C.blue : C.bone2}>{so.name}</T>
                    </Press>
                  );
                })}
              </View>
            </View>
          ) : null}
          {group ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: C.card }}>
              <Icon name={group.sync === 'perfect' ? 'graphic_eq' : 'sync'} size={20} color={group.sync === 'perfect' ? C.green : C.amber} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={13} weight={600}>{`Plays on ${group.members.map(m => snap.devices.find(x => x.id === m)?.name ?? m).join(', ')}`}</T>
                <T size={12} color={C.stone}>{group.sync === 'perfect' ? `Perfect sync through “${group.castGroup}”` : 'Start together'}</T>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {modes.length ? (
        <View style={{ gap: 8 }}>
          <Label>Mode</Label>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {modes.map(([m, icon]) => {
              const a = D.on !== false && D.mode === m;
              return (
                <Press key={m} onPress={() => void send(D.id, { on: true, mode: m })} style={{ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: 12, backgroundColor: a ? 'rgba(124,184,240,0.2)' : C.inset }}>
                  <Icon name={icon} size={20} color={a ? C.blue : C.bone2} />
                  <T size={12.5} weight={600} color={a ? C.blue : C.bone2}>{m}</T>
                </Press>
              );
            })}
          </View>
        </View>
      ) : null}
      {vac ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {([['Clean', 'cleaning_services', true, vac === 'cleaning'], ['Dock', 'home', false, vac === 'docked' || vac === 'returning']] as const).map(([label, icon, on, a]) => (
            <Press key={label} onPress={() => void send(D.id, { on })} style={{ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: 12, backgroundColor: a ? 'rgba(242,177,76,0.16)' : C.inset }}>
              <Icon name={icon} size={20} color={a ? C.amber : C.bone2} />
              <T size={12.5} weight={600} color={a ? C.amber : C.bone2}>{label}</T>
            </Press>
          ))}
        </View>
      ) : null}
      {D.type === 'camera' ? (
        <Button label="Watch live" icon="videocam" onPress={() => { close(); nav.navigate('Web', { title: D.name, path: `/phone.html?embed=1&cam=${encodeURIComponent(D.id)}` }); }} />
      ) : null}

      {readings.length ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {readings.map(([k, v]) => (
            <View key={k} style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: C.card, gap: 2 }}>
              <T size={11} weight={700} color={C.stone2} upper tracking={0.06}>{k}</T>
              <T size={17} weight={700}>{v}</T>
            </View>
          ))}
        </View>
      ) : null}

      {D.why ? (
        <View style={{ borderRadius: 16, backgroundColor: C.card, overflow: 'hidden' }}>
          {[['help', 'Why it’s like this', D.why.now, C.stone], ['schedule', 'What’s next', D.why.next, C.amber]].map(([icon, k, v, fg], i) => (
            <View key={k} style={{ flexDirection: 'row', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
              <Icon name={icon} size={20} color={fg} />
              <View style={{ flex: 1, gap: 3 }}>
                <T size={11} weight={700} color={C.stone} upper tracking={0.06}>{k}</T>
                <T size={14} lineHeight={1.4}>{v}</T>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={{ gap: 12 }}>
        <T size={12} weight={700} color={C.stone2} upper tracking={0.06}>Settings</T>
        <View style={{ gap: 6 }}>
          <Label>Name</Label>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={draft} onChangeText={setName} autoCorrect={false}
              style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: C.card, color: C.bone, fontFamily: F[400], fontSize: 16 }} />
            {draft.trim() && draft.trim() !== D.name ? (
              <Press onPress={() => void settings({ name: draft.trim() }, `Renamed to ${draft.trim()}`).then(() => setName(null))} style={{ paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.amber, justifyContent: 'center' }}>
                <T size={13} weight={700} color={C.onAmber}>Save</T>
              </Press>
            ) : null}
          </View>
          {D.original && D.original.name !== D.name ? <T size={12} color={C.stone}>{`${D.integration || 'The integration'} calls it “${D.original.name}”.`}</T> : null}
        </View>
        <View style={{ gap: 6 }}>
          <Label>Room</Label>
          <HScroll>{rooms.map(r => <Pill key={r.id} label={r.name} on={r.id === D.room} onPress={() => r.id !== D.room && void settings({ room: r.id }, `Moved to ${r.name}`)} />)}</HScroll>
        </View>
        <View style={{ borderRadius: 16, backgroundColor: C.card, overflow: 'hidden' }}>
          {([['star', 'Favourite', 'Show it on Now', fav, () => void settings({ favourite: !fav }, fav ? 'Removed from favourites' : 'Added to favourites')],
            ['visibility_off', 'Hide from lists', 'It keeps working in modes and automations', !!D.hidden, () => void settings({ hidden: !D.hidden }, D.hidden ? 'Shown in lists again' : 'Hidden from lists')]] as const)
            .map(([icon, k, sub, v, go], i) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <Icon name={icon} size={20} color={icon === 'star' ? C.amber : C.stone} fill={icon === 'star' && v} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={14.5} weight={600}>{k}</T>
                  <T size={12} color={C.stone}>{sub}</T>
                </View>
                <Switch on={v} onChange={go} />
              </View>
            ))}
        </View>
        <View style={{ gap: 4 }}>
          <Label>Used in</Label>
          <T size={12.5} color={C.stone}>{D.usedIn?.length ? D.usedIn.map(u => u.name).join(' · ') : 'Not in any mode or overlay yet'}</T>
        </View>
        <T mono size={11} color={C.stone3}>{`${D.integration} · ${D.address}`}</T>
      </View>
    </Sheet>
  );
}
