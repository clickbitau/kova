import { useState } from 'react';
import { TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { methodName, PRAYER_METHODS, searchZones, timezones, zoneLabel } from '../logic/settings';
import { Group, Row, Sheet, SwitchRow } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { askLocation } from '../logic/location-consent';
import { locationAsk } from '../native/arrive-leave';
import { useDemo } from '../state/demo';
import { openPrivacyPolicy } from '../ui/PrivacyLink';
import { useLocationDisclosure } from './LocationDisclosure';

/** More → Settings: where the home is (sun and prayer times follow it), its timezone and prayer method, behaviours, and the rest. */
export function SettingsScreen() {
  const s = useSnap();
  const nav = useNav();
  const { act, say } = useHub();
  const { demo } = useDemo();
  const { disclose, view: disclosure } = useLocationDisclosure();
  const [pick, setPick] = useState<'tz' | 'method' | null>(null);
  const [q, setQ] = useState('');
  const [locating, setLocating] = useState(false);
  const loc = s.home.location;
  const put = (body: object, done: string) => act('PUT', '/api/home', body, done);

  const here = async () => {
    if (demo) { if (await disclose('once')) say('In the demo home Kova doesn’t use your location.'); return; }
    setLocating(true);
    try {
      // Kova's own disclosure first, then the system prompt (logic/location-consent.ts).
      const p = await askLocation('once', locationAsk(disclose));
      if (!p.ok) { if (p.reason !== 'declined') say(p.why, { error: true }); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await put({ location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, radiusM: loc?.radiusM, source: 'phone' } }, 'Location saved: sun and prayer times follow it');
    } catch (e) { say((e as Error).message, { error: true }); } finally { setLocating(false); }
  };

  const zones = searchZones(timezones(s.home.timezone), q);
  return (
    <Screen title="Settings" over={s.home.name} onBack={() => nav.goBack()}>
      <Group title="Home">
        <Row first icon="location_on" iconFg={C.amber} title="Where the home is" busy={locating}
          sub={loc && (loc.latitude || loc.longitude) ? `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}. Tap to use where this phone is now.` : 'Not set: sun and prayer times need it. Tap at home to use this phone’s location.'}
          onPress={() => void here()} />
        <Row icon="schedule" iconFg={C.blue} title="Timezone" sub={zoneLabel(s.home.timezone)} onPress={() => { setQ(''); setPick('tz'); }} />
        <Row icon="mosque" iconFg={C.green} title="Prayer times" sub={methodName(s.home.prayerMethod)} onPress={() => setPick('method')} />
        <Row icon="home" title="Rooms, people and devices" sub="Names, rooms, favourites, speaker groups" onPress={() => nav.navigate('Customise')} />
      </Group>
      <Group title="Behaviours">
        <SwitchRow first icon="doorbell" iconFg={C.amber} title="Pause for the doorbell" sub="When it rings, pause what’s playing on players that can pause"
          on={s.home.pauseForDoorbell !== false} onChange={v => void put({ pauseForDoorbell: v }, v ? 'The doorbell pauses what’s playing' : 'The doorbell no longer pauses anything')} />
        <Row icon="routine" title="Modes and Light the way" sub="The home through the day" onPress={() => nav.navigate('Modes')} />
        <Row icon="account_tree" title="Automations" sub="When something happens, do something" onPress={() => nav.navigate('Automations')} />
      </Group>
      <Group title="Presence, alerts and access">
        <Row first icon="router" iconFg={C.blue} title="How Kova knows who’s home" sub="Warden or your router, phones, network checks" onPress={() => nav.navigate('Integration', { id: 'presence' })} />
        <Row icon="notifications" iconFg={C.amber} title="Notifications" sub="Which alerts, push and ntfy, send a test" onPress={() => nav.navigate('Integration', { id: 'notify' })} />
        <Row icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Your home on a computer, and signed-in browsers" onPress={() => nav.navigate('Browsers')} />
        <Row icon="hub" title="Integrations and hub updates" sub="What’s connected, Kova’s version and updates" onPress={() => nav.navigate('Integrations')} />
      </Group>
      <Group title="About">
        <Row first icon="lock" iconFg={C.green} title="Privacy policy" sub="What Kova collects, where it goes, and your choices" onPress={openPrivacyPolicy} right={<Icon name="arrow_outward" size={18} color={C.stone2} />} />
      </Group>

      <Sheet open={pick === 'tz'} onClose={() => setPick(null)} label="Timezone">
        <T v="title">Timezone</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[3], borderRadius: R.md, backgroundColor: C.inset }}>
          <Icon name="search" size={20} color={C.stone2} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search, e.g. Sydney" placeholderTextColor={C.stone3} autoCorrect={false} accessibilityLabel="Search timezones"
            style={{ flex: 1, color: C.bone, fontFamily: F[500], fontSize: 15, paddingVertical: SP[3] }} />
        </View>
        <Group>
          {zones.slice(0, 60).map((z, i) => (
            <Row key={z} first={i === 0} title={zoneLabel(z)} right={z === s.home.timezone ? <Icon name="check" size={20} color={C.amber} /> : undefined}
              onPress={() => { setPick(null); void put({ timezone: z }, `Timezone: ${zoneLabel(z)}`); }} />
          ))}
        </Group>
        {zones.length > 60 ? <T v="footnote" color={C.stone}>Keep typing to narrow it down.</T> : null}
      </Sheet>
      <Sheet open={pick === 'method'} onClose={() => setPick(null)} label="Prayer times">
        <T v="title">Prayer times</T>
        <T v="footnote" color={C.stone}>How Fajr, Dhuhr, Asr, Maghrib and Isha are worked out. Modes and automations that start at a prayer time follow it.</T>
        <Group>
          {PRAYER_METHODS.map(([id, name], i) => (
            <Row key={id} first={i === 0} title={name} right={id === (s.home.prayerMethod ?? 'MuslimWorldLeague') ? <Icon name="check" size={20} color={C.amber} /> : undefined}
              onPress={() => { setPick(null); void put({ prayerMethod: id }, 'Prayer times recalculated'); }} />
          ))}
        </Group>
      </Sheet>
      {disclosure}
    </Screen>
  );
}

