import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { hubUrl } from '../logic/connect';
import { stateOf, devs, type Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Avatar, Card, Empty, Press, PulseDot, Section, Skeleton } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear } from '../ui/motion';

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

/** A camera: its latest picture (shimmering until it comes), its name and last event; tap for live video. */
function CameraCard({ c, uri, wide, index, onPress }: { c: Dev; uri: string | null; wide: boolean; index: number; onPress: () => void }) {
  const [st, fg] = stateOf(c);
  const off = c.online === false;
  const line = c.why?.now && !/No change/.test(c.why.now) ? c.why.now : st;
  return (
    <Appear index={index} style={{ flexBasis: wide ? '100%' : '47%', flexGrow: 1 }}>
      <Press onPress={onPress} give="soft" label={`${c.name}, ${line}. Watch live`}>
        <Card style={{ overflow: 'hidden' }}>
          <View style={{ aspectRatio: 16 / 9, backgroundColor: C.inset, alignItems: 'center', justifyContent: 'center' }}>
            <CameraStill uri={uri} off={off} />
            <View style={{ position: 'absolute', left: SP[2] + 2, top: SP[2] + 2, flexDirection: 'row', alignItems: 'center', gap: 6, height: 24, paddingHorizontal: 9, borderRadius: R.full, backgroundColor: 'rgba(14,15,16,0.72)' }}>
              {off ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.red }} /> : <PulseDot color={C.green} size={7} />}
              <T v="micro" color={C.bone}>{off ? 'Offline' : 'Watch live'}</T>
            </View>
          </View>
          <View style={{ paddingVertical: SP[3], paddingHorizontal: SP[3] + 2, gap: 2 }}>
            <T v="headline" numberOfLines={1}>{c.name}</T>
            <T v="footnote" color={off ? C.red : line === st ? fg : C.stone} numberOfLines={1}>{line}</T>
          </View>
        </Card>
      </Press>
    </Appear>
  );
}

/** Cameras (latest picture, tap for live), who's home, the network, and today's comings and goings. */
export function SecurityScreen() {
  const s = useSnap();
  const { cfg } = useHub();
  const nav = useNav();
  const all = devs(s);
  const cams = Object.values(all).filter(d => d.type === 'camera' && !d.hidden);
  const home = s.people.filter(p => p.home);
  const internet = all.warden_internet;
  const warden = s.integrations.find(i => i.id === 'warden');
  const events = s.activity.filter(a => a.type === 'people' && ['doorbell', 'person', 'person_pin_circle', 'directions_walk'].includes(a.icon)).slice(0, 8);
  // Snapshot images change as events happen: bust the cache every minute.
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 60_000); return () => clearInterval(t); }, []);
  const watch = (id: string, name: string) => nav.navigate('Web', { title: name, path: `/phone.html?embed=1&cam=${encodeURIComponent(id)}` });
  const summary = `${home.length ? (home.length === s.people.length && home.length > 1 ? 'Everyone home' : `${home.map(p => p.name).join(' and ')} home`) : 'Nobody home'} · ${cams.length} camera${cams.length === 1 ? '' : 's'}`;
  const netBad = internet?.on === false || internet?.online === false;

  return (
    <Screen title="Security" over={summary}>
      {cams.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
          {cams.map((c, i) => (
            <CameraCard key={c.id} c={c} index={i} wide={cams.length === 1 || (cams.length % 2 === 1 && i === cams.length - 1)} onPress={() => watch(c.id, c.name)}
              uri={cfg ? `${hubUrl(cfg, `/api/devices/${encodeURIComponent(c.id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}` : null} />
          ))}
        </View>
      ) : (
        <Empty compact icon="videocam" title="No cameras yet" text="Link Google Nest to see your doorbell and cameras here." action="Set up" onAction={() => nav.navigate('Integration', { id: 'nest' })} />
      )}

      <Section title="Who’s home">
        {s.people.length ? (
          <Card style={{ overflow: 'hidden' }}>
            {s.people.map((p, i) => (
              <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                <Avatar name={p.name} home={p.home} size={38} ring={C.card} />
                <View style={{ flex: 1, gap: 1 }}>
                  <T v="headline">{p.name}</T>
                  <T v="footnote" color={C.stone}>{`${p.home ? 'Home' : 'Out'}${p.sinceLabel ? ` since ${p.sinceLabel}` : ''}${p.detail ? ` · ${p.detail}` : ''}`}</T>
                </View>
                <T v="micro" color={p.home ? C.green : C.stone2}>{p.home ? 'HOME' : 'OUT'}</T>
              </View>
            ))}
          </Card>
        ) : <Empty compact icon="group" title="No people yet" text="Add the people who live here in Customise home." />}
      </Section>

      {internet || warden ? (
        <Section title="Network">
          <Card style={{ padding: SP[4], gap: SP[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
              <Icon name="router" size={22} color={netBad ? C.red : C.green} />
              <T v="headline" style={{ flex: 1 }}>{internet ? stateOf(internet)[0] : 'Warden'}</T>
              {internet ? <PulseDot color={netBad ? C.red : C.green} size={7} /> : null}
            </View>
            {warden?.note ? <T v="footnote" color={C.stone}>{warden.note}</T> : null}
          </Card>
        </Section>
      ) : null}

      <Section title="Today" gap={SP[1]}>
        {events.length ? events.map((e, i) => (
          <Appear key={e.id} index={i} style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, alignItems: 'center' }}>
            <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: C.greenTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={e.icon} size={18} color={C.green} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="callout" weight={600} color={C.bone}>{e.what}</T>
              {e.why ? <T v="footnote" color={C.stone}>{e.why}</T> : null}
            </View>
            <T mono size={11.5} color={C.stone2}>{e.t}</T>
          </Appear>
        )) : <Empty compact icon="shield" tone={C.green} title="All quiet today" text="Doorbell rings and people coming and going show up here." />}
      </Section>
    </Screen>
  );
}
