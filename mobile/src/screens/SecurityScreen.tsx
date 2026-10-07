import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { hubUrl } from '../logic/connect';
import { stateOf, devs, type Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Avatar, Card, Empty, ExpandRow, Group, IconWell, Press, PulseDot, Section, Segmented, Skeleton, SwitchRow, Tag } from '../ui/kit';
import { decisionText, EV_WORD, quietText, roomAlertLine, securityStatus } from '../logic/sensors';
import { isCamera, isSensor } from '../logic/sensors';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear } from '../ui/motion';
import { liveSupport } from '../logic/live';

/**
 * A camera's latest picture: shimmering while it comes, the camera icon if there's none yet (or it's
 * offline), cross-fading in when it arrives. Fills its parent.
 */
export function CameraStill({ uri, off, label }: { uri: string | null; off?: boolean; label?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
      {!loaded && !failed && !off ? <Skeleton h={400} r={0} style={{ position: 'absolute', left: 0, right: 0, top: 0 }} /> : null}
      <Icon name={off ? 'videocam_off' : 'videocam'} size={28} color={off || failed ? C.stone2 : C.stone3} />
      {failed && !off ? <T v="micro" color={C.stone2} style={{ marginTop: 6 }}>No picture yet</T> : null}
      {uri && !off ? <Image source={{ uri }} onLoad={() => { setLoaded(true); setFailed(false); }} onError={() => setFailed(true)} accessibilityLabel={label} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={250} /> : null}
    </View>
  );
}

/** A camera: its latest picture (shimmering until it comes), its name and last event; tap for live video (or its screen). */
function CameraCard({ c, uri, wide, index, onPress, room }: { c: Dev; uri: string | null; wide: boolean; index: number; onPress: (live: boolean) => void; room: string }) {
  const [st, fg] = stateOf(c);
  const off = c.online === false;
  const can = liveSupport(c).can;
  const line = c.why?.now && !/No change/.test(c.why.now) ? c.why.now : st;
  return (
    <Appear index={index} style={{ flexBasis: wide ? '100%' : '47%', flexGrow: 1 }}>
      <Press onPress={() => onPress(can)} give="soft" label={`${c.name}, ${line}.${can ? ' Watch live' : ''}`}>
        <Card style={{ overflow: 'hidden' }}>
          <View style={{ aspectRatio: 16 / 9, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
            <CameraStill uri={uri} off={off} />
            <View style={{ position: 'absolute', left: SP[2] + 2, top: SP[2] + 2, flexDirection: 'row', alignItems: 'center', gap: 6, height: 24, paddingHorizontal: 9, borderRadius: R.full, backgroundColor: 'rgba(14,15,16,0.72)' }}>
              {off ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} /> : <PulseDot color={C.green} size={7} />}
              <T v="micro" color={C.bone} numberOfLines={1}>{off ? 'Offline' : can ? 'Watch live' : 'Latest picture'}</T>
            </View>
          </View>
          <View style={{ paddingVertical: SP[3], paddingHorizontal: SP[3] + 2, gap: 2 }}>
            <T v="headline" numberOfLines={1}>{c.name}</T>
            <T v="footnote" numberOfLines={1} color={C.stone2}>{room}{' · '}<T v="footnote" color={off ? C.red : line === st ? fg : C.stone}>{line}</T></T>
          </View>
        </Card>
      </Press>
    </Appear>
  );
}

/** Cameras (latest picture, tap for live video on the camera's screen), who's home, the network, and today's comings and goings. */
export function SecurityScreen() {
  const s = useSnap();
  const { cfg, act } = useHub();
  const nav = useNav();
  const all = devs(s);
  const sec = s.security;
  const putSec = (body: object, done: string) => act('PUT', '/api/security/settings', body, done);
  const watchedRooms = s.rooms.filter(r => Object.values(all).some(d => d.room === r.id && (isCamera(d) || isSensor(d))));
  // A camera's card: its latest event's picture when one was kept, else what it shows now.
  const frameOf = (id: string) => sec?.recent.find(e => e.device === id && e.frame)?.frame ?? null;
  const cams = Object.values(all).filter(d => d.type === 'camera' && !d.hidden);
  const internet = all.warden_internet;
  const warden = s.integrations.find(i => i.id === 'warden');
  const events = s.activity.filter(a => a.type === 'people' && ['doorbell', 'person', 'person_pin_circle', 'directions_walk'].includes(a.icon)).slice(0, 8);
  // Snapshot images change as events happen: bust the cache every minute.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 60_000); return () => clearInterval(t); }, []);
  const [openRoom, setOpenRoom] = useState<string | null>(null);
  const watch = (id: string, live: boolean) => nav.navigate('Camera', { id, live });
  const netBad = internet?.on === false || internet?.online === false;
  const status = securityStatus({ people: s.people, cams, rooms: s.rooms, roomStatus: s.roomStatus, netDown: !!internet && netBad, quietNow: !!sec?.quietNow });

  return (
    <Screen title="Security">
      <Card tint={status.color} pad={SP[4]} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] + 2, backgroundColor: alpha(status.color, 0.07) }}>
        <IconWell icon={status.icon} color={status.color} bg={alpha(status.color, 0.16)} size={48} radius={24} fill />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="heading">{status.title}</T>
          {status.sub ? <T v="footnote" color={C.stone}>{status.sub}</T> : null}
        </View>
      </Card>

      {cams.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
          {cams.map((c, i) => (
            <CameraCard key={c.id} c={c} index={i} wide={cams.length === 1 || (cams.length % 2 === 1 && i === cams.length - 1)} onPress={live => watch(c.id, live)}
              room={s.rooms.find(r => r.id === c.room)?.name ?? 'No room'}
              uri={cfg ? (frameOf(c.id) ? hubUrl(cfg, frameOf(c.id)!, true) : `${hubUrl(cfg, `/api/devices/${encodeURIComponent(c.id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}`) : null} />
          ))}
        </View>
      ) : (
        <Empty compact icon="videocam" title="No cameras yet" text="Link Google Nest to see your doorbell and cameras here." action="Set up" onAction={() => nav.navigate('Integration', { id: 'nest' })} />
      )}

      <Section title="Today">
        {events.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {events.map((e, i) => (
              <Appear key={e.id} index={i} style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, alignItems: 'center' }}>
                <IconWell icon={e.icon} color={C.green} size={34} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T v="callout" weight={600} color={C.bone}>{e.what}</T>
                  {e.why ? <T v="footnote" color={C.stone} numberOfLines={2}>{e.why}</T> : null}
                </View>
                <T mono size={11.5} color={C.stone2}>{e.t}</T>
              </Appear>
            ))}
          </Card>
        ) : <Empty compact icon="shield" tone={C.green} title="All quiet today" text="Doorbell rings and people coming and going show up here." />}
      </Section>

      <Section title="Who’s home">
        {s.people.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.people.map((p, i) => {
              const basis = p.evidence?.[0]?.source;
              return (
                <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                  <Avatar name={p.name} home={p.home} size={38} ring={C.card} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                      <T v="headline" numberOfLines={1} style={{ flexShrink: 1 }}>{p.name}</T>
                      <Tag text={p.home ? 'Home' : 'Out'} color={p.home ? C.green : C.stone} />
                    </View>
                    <T v="footnote" color={C.stone} numberOfLines={2}>{[p.sinceLabel ? `Since ${p.sinceLabel}` : '', p.confidenceLabel ? `${p.confidenceLabel} sure` : '', p.detail, basis].filter(Boolean).join(' · ')}</T>
                  </View>
                </View>
              );
            })}
          </Card>
        ) : <Empty compact icon="group" title="No people yet" text="Add the people who live here in Customise home." />}
      </Section>

      {watchedRooms.length ? (
        <Section title="Rooms">
          <Card style={{ overflow: 'hidden' }}>
            {watchedRooms.map((r, i) => {
              const rs = s.roomStatus?.[r.id];
              const dot = rs?.occupied ? C.amber : rs?.active ? C.green : C.stone3;
              return (
                <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 52, paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
                  <T v="callout" weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>{r.name}</T>
                  <T v="footnote" color={rs?.last ? (rs.occupied ? C.amber : C.stone) : C.stone2} numberOfLines={2} style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                    {rs?.last ? `${rs.occupied ? 'Someone there · ' : ''}${EV_WORD[rs.last.kind] ?? rs.last.kind} ${rs.last.atLabel}` : 'Nothing yet'}
                  </T>
                </View>
              );
            })}
          </Card>
        </Section>
      ) : null}

      {internet || warden ? (
        <Section title="Network">
          <Card pad={SP[4]} style={{ gap: SP[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
              <IconWell icon="router" color={netBad ? C.red : C.green} size={36} />
              <T v="headline" style={{ flex: 1, minWidth: 0 }}>{internet ? stateOf(internet)[0] : 'Warden'}</T>
              {internet ? <PulseDot color={netBad ? C.red : C.green} size={7} /> : null}
            </View>
            {warden?.note ? <T v="footnote" color={C.stone}>{warden.note}</T> : null}
          </Card>
        </Section>
      ) : null}

      {sec ? (
        <Section title="Alerts">
          <Group note="Someone at the door, or inside while nobody’s home, reaches your phones, naming the room. Motion only while nobody’s home, unless you ask.">
            <SwitchRow first icon="bedtime" iconFg={C.blue} color={C.blue} title="Quiet hours" sub={quietText(sec)} on={!!sec.quiet} onChange={v => void putSec({ quiet: v ? { from: '22:00', to: '07:00' } : null }, v ? 'Quiet hours 22:00 to 07:00' : 'Quiet hours off')} />
            {sec.quiet ? (
              <View style={{ paddingHorizontal: SP[4], paddingBottom: SP[4] }}>
                <Segmented compact label="Quiet hours" value={`${sec.quiet.from}-${sec.quiet.to}`} options={[['21:00', '07:00'], ['22:00', '07:00'], ['23:00', '06:30'], ['00:00', '06:00']].map(([a, b]) => ({ id: `${a}-${b}`, label: `${a}–${b}` }))}
                  onChange={id => { const [from, to] = id.split('-'); void putSec({ quiet: { from, to } }, `Quiet ${from} to ${to}`); }} />
              </View>
            ) : null}
            <View style={{ gap: SP[2] + 2, padding: SP[4], borderTopWidth: 1, borderTopColor: C.hairline }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                <IconWell icon="timer" color={C.bone} bg={C.selected} size={36} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T v="headline">Between alerts</T>
                  <T v="footnote" color={C.stone}>At most one of a kind from a room in this time</T>
                </View>
              </View>
              <Segmented compact label="Between alerts from a room" value={String(sec.cooldownMin)} options={[1, 5, 10, 30].map(n => ({ id: String(n), label: `${n} min` }))} onChange={id => void putSec({ cooldownMin: Number(id) }, `At most one alert of a kind per room every ${id} min`)} />
            </View>
          </Group>

          {watchedRooms.length ? (
            <Group title="By room" note="Default follows each camera and sensor’s own settings.">
              {watchedRooms.map((r, i) => {
                const open = openRoom === r.id;
                return (
                  <ExpandRow key={r.id} first={i === 0} title={r.name} sub={roomAlertLine(sec, r.id)} open={open} onToggle={() => setOpenRoom(open ? null : r.id)}>
                    {(['person', 'motion'] as const).map(k => (
                      <View key={k} style={{ gap: SP[1] + 2 }}>
                        <T v="eyebrow" color={C.stone2}>{k === 'person' ? 'People' : 'Motion'}</T>
                        <Segmented compact label={`${r.name} ${k} alerts`} value={sec.rooms[r.id]?.[k] ?? ''} options={[{ id: '', label: 'Default' }, { id: 'always', label: 'Always' }, { id: 'away', label: 'Away' }, { id: 'never', label: 'Never' }]}
                          onChange={id => void putSec({ rooms: { [r.id]: { [k]: id || null } } }, `${r.name} · ${k === 'person' ? 'people' : 'motion'}: ${id || 'default'}`)} />
                      </View>
                    ))}
                  </ExpandRow>
                );
              })}
            </Group>
          ) : null}

          {sec.decisions.length ? (
            <Group title="Recent alerts">
              {sec.decisions.slice(0, 5).map((d, i) => (
                <View key={`${d.at}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                  <Icon name={d.sent ? 'notifications_active' : 'notifications_off'} size={18} color={d.sent ? C.green : C.stone2} />
                  <T v="footnote" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{decisionText(d, s.rooms)}</T>
                  <T mono size={11} color={C.stone2}>{d.atLabel}</T>
                </View>
              ))}
            </Group>
          ) : null}
        </Section>
      ) : null}
    </Screen>
  );
}
