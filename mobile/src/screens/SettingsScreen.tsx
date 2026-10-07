import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { methodName, PRAYER_METHODS, searchZones, timezones, zoneLabel } from '../logic/settings';
import { prayerSub } from '../logic/prayer';
import { Group, Row, Sheet, SwitchRow } from '../ui/kit';
import { cleanName } from '../logic/customise';
import { FieldWithButton } from './DeviceSheet';
import { SoftwareUpdate } from './SoftwareUpdate';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Icon } from '../ui/Icon';

/** More → Settings: the home's name, where it is (its own screen: the map, the address, the circle), its timezone and prayer method, behaviours, and Software update. */
export function SettingsScreen() {
  const s = useSnap();
  const nav = useNav();
  const { act } = useHub();
  const [pick, setPick] = useState<'tz' | 'method' | 'name' | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [q, setQ] = useState('');
  const loc = s.home.location;
  const put = (body: object, done: string) => act('PUT', '/api/home', body, done);

  const saveName = async () => {
    const n = cleanName(nameDraft);
    if (!n) return false;
    const ok = await act('PUT', '/api/home', { name: n }, 'Home renamed');
    if (ok) setPick(null);
    return ok;
  };

  const zones = searchZones(timezones(s.home.timezone), q);
  return (
    <Screen title="Settings" over={s.home.name} onBack={() => nav.goBack()}>
      <Group title="Home">
        <Row first icon="home" iconFg={C.amber} title="Name" sub={s.home.name} onPress={() => { setNameDraft(s.home.name); setPick('name'); }} />
        <Row icon="location_on" iconFg={C.amber} title="Where the home is"
          sub={loc && (loc.latitude || loc.longitude) ? `${s.home.address ? `${s.home.address} · ` : ''}${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} · ${loc.radiusM ?? 150} m circle` : 'Not set: paste from Google Maps, search the address, or use this phone. Sun and prayer times need it.'}
          onPress={() => nav.navigate('HomeLocation')} />
        <Row icon="schedule" iconFg={C.blue} title="Timezone" sub={zoneLabel(s.home.timezone)} onPress={() => { setQ(''); setPick('tz'); }} />
        {s.prayer
          ? <Row icon="mosque" iconFg={s.prayer.on ? C.green : C.stone} title="Prayer times" sub={prayerSub(s.prayer)} onPress={() => nav.navigate('PrayerTimes')} />
          : <Row icon="mosque" iconFg={C.green} title="Prayer times" sub={methodName(s.home.prayerMethod)} onPress={() => setPick('method')} />}
        <Row icon="meeting_room" title="Rooms, people and devices" sub="Rooms and groups of rooms, people, devices, favourites, archived" onPress={() => nav.navigate('Customise')} />
      </Group>
      <Group title="Behaviours">
        <SwitchRow first icon="doorbell" iconFg={C.amber} title="Pause for the doorbell" sub="When it rings, pause what’s playing on players that can pause"
          on={s.home.pauseForDoorbell !== false} onChange={v => void put({ pauseForDoorbell: v }, v ? 'The doorbell pauses what’s playing' : 'The doorbell no longer pauses anything')} />
        <Row icon="routine" title="Modes and Light the way" sub="The home through the day" onPress={() => nav.navigate('Modes')} />
        <Row icon="account_tree" title="Automations" sub="When something happens, do something" onPress={() => nav.navigate('Automations')} />
        {s.roomClimate?.rooms.length ? (
          <Row icon="graphic_eq" iconFg={C.blue} title="Voice and other apps" sub={`${s.roomClimate.rooms.length} room AC${s.roomClimate.rooms.length === 1 ? '' : 's'} for Google Home, Alexa and Apple Home`} onPress={() => nav.navigate('Voice')} />
        ) : null}
      </Group>
      <Group title="Presence, alerts and access">
        <Row first icon="router" iconFg={C.blue} title="How Kova knows who’s home" sub="Warden or your router, phones, network checks" onPress={() => nav.navigate('Integration', { id: 'presence' })} />
        <Row icon="notifications" iconFg={C.amber} title="Notifications" sub="Which alerts, push and ntfy, send a test" onPress={() => nav.navigate('Integration', { id: 'notify' })} />
        <Row icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Your home on a computer, and signed-in browsers" onPress={() => nav.navigate('Browsers')} />
        <Row icon="hub" title="Integrations" sub="What’s connected, and adding more" onPress={() => nav.navigate('Integrations')} />
      </Group>

      <SoftwareUpdate hub={s.update} />

      <Sheet open={pick === 'name'} onClose={() => setPick(null)} label="Home name">
        <T v="title">Home name</T>
        <FieldWithButton value={nameDraft} onChange={setNameDraft} button="Save" label="Home name" show={!!cleanName(nameDraft) && cleanName(nameDraft) !== s.home.name} onSubmit={() => void saveName()} />
        <T v="footnote" color={C.stone}>Shown at the top of the app, on the web and in notifications.</T>
      </Sheet>
      <Sheet open={pick === 'tz'} onClose={() => setPick(null)} label="Timezone">
        <T v="title">Timezone</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[3], borderRadius: R.md, backgroundColor: C.inset }}>
          <Icon name="search" size={20} color={C.stone2} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search, e.g. Sydney" placeholderTextColor={C.stone3} autoCorrect={false} accessibilityLabel="Search timezones"
            style={{ flex: 1, minWidth: 0, color: C.bone, fontFamily: F[500], fontSize: 15, paddingVertical: SP[3] }} />
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
    </Screen>
  );
}

