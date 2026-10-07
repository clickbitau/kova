import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import type { Command, MediaSource } from '../api/types';
import { devs, has, ICON, stateOf, type Dev } from '../logic/devices';
import { groupMembers, loopDone, memberToggle, musicCommand, nowPlaying, pickPlayer, playersOf, playingCount, playPause, sourceCommand, sourceSub, stationCommand, STOP, streamUrlError } from '../logic/media';
import { plural } from '../logic/customise';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, HScroll, IconButton, IconWell, Pill, Press, Row, Section, Segmented, Sheet, Slider } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Choice, FieldWithButton } from './DeviceSheet';
import { SheetHead, SpeakerGroupSheet, TextField } from './SpeakerGroupSheet';

const MUSIC = '#c79bf2';

/** A source's stream address, and whether a recording repeats or plays once. */
function SourceSheet({ src, onClose }: { src: MediaSource | null; onClose: () => void }) {
  const { act } = useHub();
  const [url, setUrl] = useState('');
  useEffect(() => { if (src) setUrl(src.url ?? ''); }, [src?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!src) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const err = streamUrlError(url);
  const changed = url.trim() !== (src.url ?? '');
  const path = `/api/sources/${encodeURIComponent(src.name)}`;
  const save = async () => {
    if (err) return false;
    return act('PUT', path, { url: url.trim() }, `${src.name} saved`);
  };
  return (
    <Sheet open onClose={onClose} label={src.name}>
      <SheetHead kicker="Source" title={src.name} icon={src.icon} color={C.blue} />
      <Section title="Stream address" caption gap={SP[2]}>
        <TextField value={url} onChange={setUrl} keyboard="url" placeholder="https://… stream or file" label="Stream address" onSubmit={() => void save()} />
        <T v="footnote" color={err ? C.redText : C.stone2}>{err ?? 'Speakers play it from here: a live stream, or a recording.'}</T>
      </Section>
      <Button full kind={changed && !err ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed && !err ? save : undefined} />
      <Section title="When a recording ends" caption gap={SP[2]}>
        <Segmented label="When a recording ends" value={src.loop ? 'loop' : 'once'} color={C.blue}
          options={[{ id: 'once', label: 'Plays once', icon: 'arrow_forward' }, { id: 'loop', label: 'Repeats', icon: 'repeat' }]}
          onChange={id => void act('PUT', path, { loop: id === 'loop' }, loopDone(src, id === 'loop'))} />
        <T v="footnote" color={C.stone2}>Repeats plays it again from the start until someone stops it. Live streams never end, so it doesn’t matter for them.</T>
      </Section>
    </Sheet>
  );
}

/** A player in a list: icon, name, what it's doing, and play or stop on the right. */
function PlayerRow({ d, room, first, selected, onPick, onToggle }: { d: Dev; room: string; first: boolean; selected: boolean; onPick: () => void; onToggle: () => void }) {
  const [st, fg] = stateOf(d);
  const on = !!d.on && !d.paused;
  return (
    <Press onPress={onPick} give="soft" selected={selected} label={`${d.name}, ${st}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 62, paddingVertical: SP[3], paddingLeft: SP[4], paddingRight: SP[3], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline, backgroundColor: selected ? alpha(C.blue, 0.07) : 'transparent' }}>
      <IconWell icon={ICON[d.type] ?? 'speaker'} color={d.on ? C.blue : C.stone} bg={d.on ? undefined : C.control} size={36} fill={!!d.on} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <T v="headline" numberOfLines={1}>{d.name}</T>
        <T v="footnote" color={fg} numberOfLines={1}>{[room, st].filter(Boolean).join(' · ')}</T>
      </View>
      <IconButton icon={on ? (has(d, 'pause') ? 'pause' : 'stop') : 'play_arrow'} label={on ? `Stop ${d.name}` : `Play ${d.name}`} size={40} fill color={d.on ? C.blue : C.bone2} onPress={onToggle} />
    </Press>
  );
}

/**
 * Media: what's playing where, with transport and volume; the speakers in a group, each in or out at its own volume;
 * sources and Helix music to play on the chosen speaker; speaker groups; and each source's stream address and
 * whether it repeats.
 */
export function MediaScreen() {
  const s = useSnap();
  const { send, say } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const all = devs(s);
  const { players, groups } = playersOf(all, s.speakerGroups);
  const everything = [...groups, ...players];
  const [sel, setSel] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [station, setStation] = useState('');
  const [editGroup, setEditGroup] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const P = pickPlayer(everything, sel);
  const rn = (id: string) => s.rooms.find(r => r.id === id)?.name ?? '';
  const G = P ? s.speakerGroups.find(g => g.deviceId === P.id) : undefined;
  const members = groupMembers(G, all);
  const playing = playingCount(everything);
  const run = (id: string, r: { cmd: Command; done?: string } | { error: string } | null) => {
    if (!r) return;
    if ('error' in r) { say(r.error, { error: true }); return; }
    void send(id, r.cmd, r.done);
  };
  const toggle = (d: Dev) => run(d.id, playPause(d, s.sources));
  const missing = s.sources.filter(x => !x.url).length;

  if (!everything.length) {
    return (
      <Screen title="Media" over={s.home.name} onBack={() => nav.goBack()}>
        <Empty icon="speaker" tone={C.blue} title="No speakers or TVs yet" text="Kova finds Google Cast and Sonos speakers by itself. Add others in Integrations." />
      </Screen>
    );
  }
  const np = P ? nowPlaying(P, rn(P.room)) : null;

  return (
    <Screen title="Media" over={`${playing} playing · ${plural(everything.length, 'player')}`} onBack={() => nav.goBack()} gap={SP[6]}>
      <HScroll>
        {everything.map(d => <Pill key={d.id} icon={groups.includes(d) ? 'speaker_group' : ICON[d.type]} label={d.name} on={P?.id === d.id} onPress={() => setSel(d.id)} />)}
      </HScroll>

      {P && np ? (
        <Card tint={P.on ? C.blue : undefined} style={{ padding: SP[4], gap: SP[4] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] + 2 }}>
            {np.art ? <Image source={{ uri: np.art }} style={{ width: 72, height: 72, borderRadius: R.sm + 2, backgroundColor: C.inset }} contentFit="cover" transition={200} /> : (
              <View style={{ width: 72, height: 72, borderRadius: R.sm + 2, backgroundColor: P.track ? alpha(MUSIC, 0.16) : alpha(C.blue, P.on ? 0.18 : 0.08), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={P.track ? 'music_note' : G ? 'speaker_group' : ICON[P.type] ?? 'speaker'} size={32} color={P.track ? MUSIC : P.on ? C.blue : C.stone} fill />
              </View>
            )}
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <T v="eyebrow" color={P.on ? (P.track ? MUSIC : C.blue) : C.stone2}>{P.on ? (P.paused ? 'Paused' : 'Now playing') : 'Idle'}{P.track ? ` · ${P.name}` : ''}</T>
              <T v="headline" size={17} numberOfLines={2}>{np.title}</T>
              <T v="footnote" color={C.stone} numberOfLines={2}>{np.sub}</T>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: SP[4] }}>
            {np.queue ? <IconButton icon="shuffle" label={P.shuffle ? 'Shuffle is on. Play in order' : 'Shuffle'} tone="ghost" color={P.shuffle ? MUSIC : C.stone} size={44} onPress={() => void send(P.id, { shuffle: !P.shuffle }, P.shuffle ? 'Back in order' : 'Shuffled')} /> : null}
            {np.queue ? <IconButton icon="skip_previous" label="Previous song" size={50} fill onPress={() => void send(P.id, { skip: -1 })} /> : null}
            <IconButton icon={np.playing ? (np.canPause ? 'pause' : 'stop') : 'play_arrow'} label={np.playing ? (np.canPause ? 'Pause' : 'Stop') : 'Play'} tone="amber" size={60} fill onPress={() => run(P.id, playPause(P, s.sources))} />
            {np.queue ? <IconButton icon="skip_next" label="Next song" size={50} fill onPress={() => void send(P.id, { skip: 1 })} /> : null}
            {P.on && np.canPause ? <IconButton icon="stop" label={`Stop ${P.name}`} size={44} tone="ghost" color={C.stone} onPress={() => void send(P.id, STOP, `${P.name} stopped`)} /> : null}
          </View>
          {has(P, 'volume') || P.vol != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] + 2 }}>
              {has(P, 'mute') ? <IconButton icon={P.muted ? 'volume_off' : 'volume_up'} label={P.muted ? 'Unmute' : 'Mute'} size={52} color={P.muted ? C.red : C.bone} onPress={() => void send(P.id, { muted: !P.muted })} /> : null}
              <View style={{ flex: 1, opacity: P.muted ? 0.45 : 1 }}>
                <Slider value={P.vol ?? 30} color={C.blue} onColor={C.onBlue} icon={has(P, 'mute') ? undefined : 'volume_up'} label={`${P.name} volume`} onRelease={v => void send(P.id, { vol: v })} />
              </View>
            </View>
          ) : null}
          <Press onPress={() => sheet.open(P.id)} label={`All of ${P.name}’s controls`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], alignSelf: 'flex-start' }}>
            <Icon name="tune" size={17} color={C.stone} />
            <T v="labelSm" color={C.bone2}>{`All controls${G ? '' : ` · ${rn(P.room) || P.integration}`}`}</T>
          </Press>
        </Card>
      ) : null}

      {G && P ? (
        <Section title={`Speakers in ${P.name}`} caption action="Edit group" onAction={() => setEditGroup(G.id)} gap={SP[2]}>
          <Card style={{ overflow: 'hidden' }}>
            {members.map(({ d: m, in: inside }, i) => (
              <View key={m.id} style={{ gap: SP[2], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                  <IconWell icon={ICON[m.type] ?? 'speaker'} color={inside ? C.blue : C.stone} bg={inside ? undefined : C.control} size={34} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <T v="headline" size={14.5} numberOfLines={1}>{m.name}</T>
                    <T v="footnote" color={inside ? C.blue : C.stone}>{inside ? (P.on ? 'Playing with the group' : 'On') : 'Not playing'}</T>
                  </View>
                  <Button size="sm" kind={inside ? 'secondary' : 'blue'} icon={inside ? 'remove_circle' : 'add'} label={inside ? 'Take out' : 'Add back'}
                    onPress={() => { const r = memberToggle(m, P); if ('error' in r) { say(r.error, { error: true }); return false; } return send(m.id, r.cmd, r.done); }} />
                </View>
                {inside ? <Slider value={m.vol ?? 30} color={C.blue} onColor={C.onBlue} icon="volume_up" label={`${m.name} volume`} onRelease={v => void send(m.id, { vol: v })} /> : null}
              </View>
            ))}
            {!members.length ? <View style={{ padding: SP[4] }}><T v="callout" color={C.stone}>None of its speakers are here right now.</T></View> : null}
          </Card>
          <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{G.sync === 'perfect' ? `In perfect sync through “${G.castGroup}”.` : 'They start together; each keeps its own volume.'}</T>
        </Section>
      ) : null}

      {P && has(P, 'media') && s.sources.length ? (
        <Section title={`Play on ${P.name}`} caption gap={SP[2]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
            {s.sources.map(x => <Choice key={x.name} label={x.name} icon={x.icon} on={!!P.on && P.media === x.name} onPress={() => run(P.id, sourceCommand(P, x))} />)}
          </View>
        </Section>
      ) : null}

      {s.music?.length ? (
        <Section title="Your music" caption gap={SP[2]}>
          {P && has(P, 'queue') ? (
            <>
              <HScroll>
                <Pill icon="shuffle" label={shuffle ? 'Shuffle on' : 'Shuffle off'} on={shuffle} onPress={() => setShuffle(v => !v)} />
                {s.music.map(m => <Pill key={m.name} icon={m.icon} label={m.name} on={!!P.on && P.media === m.name} onPress={() => run(P.id, musicCommand(P, m, shuffle))} />)}
              </HScroll>
              <FieldWithButton value={station} onChange={setStation} placeholder="A station from an artist, album or song" button="Play" color={MUSIC} onColor="#1a1020" label="Start a station"
                onSubmit={() => { const r = stationCommand(P, station); run(P.id, r); if (r && !('error' in r)) setStation(''); }} />
            </>
          ) : <Empty compact icon="music_note" tone={MUSIC} title="Pick a speaker that plays a queue" text={`${P?.name ?? 'This one'} can’t play Helix music. Google Cast, Sonos and AirPlay speakers can.`} />}
        </Section>
      ) : null}

      <Section title="Speakers and TVs" caption gap={SP[2]}>
        <Card style={{ overflow: 'hidden' }}>
          {players.map((d, i) => <PlayerRow key={d.id} d={d} room={rn(d.room)} first={!i} selected={P?.id === d.id} onPick={() => setSel(d.id)} onToggle={() => toggle(d)} />)}
        </Card>
      </Section>

      <Section title="Speaker groups" caption action="New group" onAction={() => setEditGroup('new')} gap={SP[2]}>
        {s.speakerGroups.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.speakerGroups.map((g, i) => {
              const d = all[g.deviceId];
              return d ? <PlayerRow key={g.id} d={d} room={`${plural(g.members.length, 'speaker')}${g.sync === 'perfect' ? ' · perfect sync' : ''}`} first={!i} selected={P?.id === d.id} onPick={() => setSel(d.id)} onToggle={() => toggle(d)} />
                : <Row key={g.id} first={!i} icon="speaker_group" title={g.name} sub="Its speakers aren’t here right now" onPress={() => setEditGroup(g.id)} />;
            })}
          </Card>
        ) : <Empty compact icon="speaker_group" tone={C.blue} title="No speaker groups" text="Play speakers of any brand as one." action="Make one" onAction={() => setEditGroup('new')} />}
      </Section>

      {s.devices.some(d => d.canAnnounce) ? (
        <Section title="Announcements" caption gap={SP[2]}>
          <Card style={{ overflow: 'hidden' }}>
            <Row first icon="campaign" iconFg={C.blue} title="Speaker loudness" sub="One level sounds the same in every room" onPress={() => nav.navigate('SpeakerLoudness')} />
          </Card>
        </Section>
      ) : null}

      {s.sources.length ? (
        <Section title="Sources" caption gap={SP[2]}>
          <Card style={{ overflow: 'hidden' }}>
            {s.sources.map((x, i) => {
              const sub = sourceSub(x);
              return <Row key={x.name} first={!i} icon={x.icon} iconFg={sub.missing ? C.stone : C.blue} title={x.name} sub={sub.text} subColor={sub.missing ? C.amber : C.stone} onPress={() => setSrc(x.name)} />;
            })}
          </Card>
          <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{missing ? `${plural(missing, 'source')} ${missing === 1 ? 'needs' : 'need'} a stream address before speakers can play ${missing === 1 ? 'it' : 'them'}.` : 'Tap a source to change its stream address, or whether it repeats.'}</T>
        </Section>
      ) : null}

      <SourceSheet src={s.sources.find(x => x.name === src) ?? null} onClose={() => setSrc(null)} />
      <SpeakerGroupSheet id={editGroup} onClose={() => setEditGroup(null)} />
    </Screen>
  );
}
