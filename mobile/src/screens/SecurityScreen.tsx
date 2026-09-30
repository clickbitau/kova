import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { C } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { hubUrl } from '../logic/connect';
import { stateOf, devs } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Card, PageHead, Press, SectionTitle } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

/** Cameras (latest event image, tap for live), who's home, the network (Warden), and today's events. */
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
  const summary = `${home.length ? `${home.map(p => p.name).join(' and ')} home` : 'Nobody home'} · ${cams.length} camera${cams.length === 1 ? '' : 's'}`;

  return (
    <Screen>
      <PageHead over={summary} title="Security" />

      {cams.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {cams.map(c => {
            const [st, fg] = stateOf(c);
            return (
              <Press key={c.id} onPress={() => watch(c.id, c.name)} style={{ width: cams.length === 1 ? '100%' : undefined, flexBasis: cams.length === 1 ? '100%' : '47%', flexGrow: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: C.card }}>
                <View style={{ aspectRatio: 16 / 9, backgroundColor: '#1b1c1f', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="videocam" size={26} color="#4a4b50" />
                  {cfg ? <Image source={{ uri: `${hubUrl(cfg, `/api/devices/${encodeURIComponent(c.id)}/snapshot`, true)}${cfg.token ? '&' : '?'}t=${tick}` }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="cover" transition={200} /> : null}
                  <View style={{ position: 'absolute', left: 10, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingLeft: 8, paddingRight: 12, borderRadius: 999, backgroundColor: 'rgba(14,15,16,0.78)' }}>
                    <Icon name="play_arrow" size={17} color={C.red} fill />
                    <T size={12.5} weight={700}>Live</T>
                  </View>
                </View>
                <View style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 2 }}>
                  <T size={14} weight={700}>{c.name}</T>
                  <T size={12} color={fg} numberOfLines={1}>{c.why?.now && !/No change/.test(c.why.now) ? c.why.now : st}</T>
                </View>
              </Press>
            );
          })}
        </View>
      ) : (
        <View style={{ borderRadius: 18, padding: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.14)', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Icon name="videocam" size={24} color={C.stone} />
          <View style={{ flex: 1, gap: 2 }}>
            <T size={14} weight={700}>No cameras yet</T>
            <T size={12} color={C.stone} lineHeight={1.4}>Link Google Nest to see your doorbell and cameras here.</T>
          </View>
          <Press onPress={() => nav.navigate('Web', { title: 'Google Nest', path: '/phone.html?embed=1&setup=nest' })} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)' }}>
            <T size={12.5} weight={700}>Set up</T>
          </Press>
        </View>
      )}

      <Card style={{ padding: 16, gap: 12 }}>
        <T size={15} weight={700}>Who’s home</T>
        {s.people.length ? s.people.map(p => (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: p.home ? 'rgba(127,212,160,0.18)' : C.control, alignItems: 'center', justifyContent: 'center' }}>
              <T size={13} weight={800} color={p.home ? C.green : C.stone}>{p.name[0]}</T>
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <T size={14} weight={600}>{p.name}</T>
              <T size={12} color={C.stone}>{`${p.home ? 'Home' : 'Out'}${p.sinceLabel ? ` since ${p.sinceLabel}` : ''}${p.detail ? ` · ${p.detail}` : ''}`}</T>
            </View>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.home ? C.green : C.stone3 }} />
          </View>
        )) : <T size={13} color={C.stone}>Add the people who live here in Customise home.</T>}
      </Card>

      {internet || warden ? (
        <Card style={{ padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="router" size={20} color={internet?.on === false ? C.red : C.green} />
            <T size={15} weight={700} style={{ flex: 1 }}>Network</T>
            {internet ? <T size={12.5} weight={600} color={stateOf(internet)[1]}>{stateOf(internet)[0]}</T> : null}
          </View>
          {warden?.note ? <T size={12.5} color={C.stone} lineHeight={1.4}>{warden.note}</T> : null}
        </Card>
      ) : null}

      <View style={{ gap: 6 }}>
        <SectionTitle>Today</SectionTitle>
        {events.length ? events.map(e => (
          <View key={e.id} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.hairline, alignItems: 'center' }}>
            <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(127,212,160,0.14)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={e.icon} size={18} color={C.green} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={13.5} weight={600}>{e.what}</T>
              {e.why ? <T size={12} color={C.stone}>{e.why}</T> : null}
            </View>
            <T mono size={11.5} color={C.stone}>{e.t}</T>
          </View>
        )) : <T size={13} color={C.stone}>Nothing yet today.</T>}
      </View>
    </Screen>
  );
}
