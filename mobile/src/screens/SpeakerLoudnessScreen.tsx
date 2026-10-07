import { useState } from 'react';
import { View } from 'react-native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import type { Device } from '../api/types';
import { announceSpeakers, calibratedVol, trimOf } from '../logic/automations';
import { LOUDNESS_MAX, LOUDNESS_MIN, loudnessBody, loudnessWords, snapLoudness } from '../logic/media';
import { Button, Card, Empty, IconWell, Section, Slider } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

/** One speaker: its loudness (20–200 %), what the test level plays at, and a test. */
function SpeakerRow({ d, room, level, first }: { d: Device; room: string; level: number; first: boolean }) {
  const { act, api } = useHub();
  const [live, setLive] = useState<number | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const trim = live ?? trimOf(d);
  const test = async () => {
    setNote(null);
    try {
      const r = await api<{ ok: boolean; vol: number }>('POST', `/api/devices/${encodeURIComponent(d.id)}/announce-test`, { level }, 20_000);
      setNote({ text: `Played at ${r.vol}%`, error: false });
      return true;
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
      return false;
    }
  };
  return (
    <View style={{ gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <IconWell icon="speaker" color={C.blue} size={36} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T v="headline" numberOfLines={2}>{d.name}</T>
          <T v="footnote" color={C.stone} numberOfLines={1}>{[room, `${level}% plays at ${calibratedVol(level, trim)}%`].filter(Boolean).join(' · ')}</T>
        </View>
      </View>
      <Slider value={trimOf(d)} min={LOUDNESS_MIN} max={LOUDNESS_MAX} color={C.blue} onColor={C.onBlue} icon="volume_up" label={`${d.name} loudness`}
        onChange={v => setLive(snapLoudness(v))}
        onRelease={v => { const n = snapLoudness(v); setLive(n); void act('PATCH', `/api/devices/${encodeURIComponent(d.id)}/settings`, loudnessBody(n), `${d.name}: ${loudnessWords(n)}`).finally(() => setLive(null)); }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SP[3] }}>
        <Button size="sm" kind="secondary" icon="play_arrow" label="Play test" onPress={test} />
        {note ? <T v="footnote" color={note.error ? C.redText : C.green} style={{ flex: 1, minWidth: 120 }}>{note.text}</T> : null}
      </View>
    </View>
  );
}

/**
 * Speaker loudness: one announcement level should sound the same in every room. Each speaker gets a loudness (a
 * soundbar that booms gets less, a small speaker more), tried out with a short chime at the test level.
 */
export function SpeakerLoudnessScreen() {
  const s = useSnap();
  const nav = useNav();
  const [level, setLevel] = useState(20);
  const rooms = s.rooms;
  const order = (id: string) => { const i = rooms.findIndex(r => r.id === id); return i < 0 ? rooms.length : i; };
  const speakers = announceSpeakers(s.devices).sort((a, b) => order(a.room) - order(b.room) || a.name.localeCompare(b.name));
  return (
    <Screen title="Speaker loudness" over={s.home.name} onBack={() => nav.goBack()} gap={SP[6]}>
      <T v="callout" color={C.stone}>One level sounds the same everywhere: a speaker that sounds louder gets less.</T>
      {speakers.length ? (
        <>
          <Section title="Test at" caption gap={SP[2]}>
            <Slider value={level} min={1} max={100} label="Test level" icon="campaign" onRelease={v => setLevel(Math.max(1, v))} />
            <T v="footnote" color={C.stone2}>Play test plays a short chime on that speaker at this level, then puts it back as it was.</T>
          </Section>
          <Section title={`Speakers · ${speakers.length}`} caption gap={SP[2]}>
            <Card style={{ overflow: 'hidden' }}>
              {speakers.map((d, i) => <SpeakerRow key={d.id} d={d} first={!i} level={level} room={rooms.find(r => r.id === d.room)?.name ?? ''} />)}
            </Card>
            <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>100% plays as asked. Announcements use it; music and the volume slider don’t.</T>
          </Section>
        </>
      ) : <Empty icon="speaker" tone={C.blue} title="No speakers yet" text="Kova finds Google Cast and Sonos speakers by itself. Add others in Integrations." />}
    </Screen>
  );
}
