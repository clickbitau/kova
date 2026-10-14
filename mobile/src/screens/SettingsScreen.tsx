import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { searchZones, timezones, zoneLabel } from '../logic/settings';
import { prayerSub } from '../logic/prayer';
import { Group, Row, Segmented, Sheet } from '../ui/kit';
import { cleanName } from '../logic/customise';
import { updateNotice } from '../logic/updates';
import { useAppUpdate } from '../native/updates';
import { FieldWithButton } from './DeviceSheet';
import { SoftwareUpdate } from './SoftwareUpdate';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Icon } from '../ui/Icon';
import { openPrivacyPolicy } from '../ui/PrivacyLink';

type Tab = 'home' | 'alerts' | 'access' | 'system';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' }, { id: 'alerts', label: 'Alerts', icon: 'notifications' },
  { id: 'access', label: 'Access', icon: 'key' }, { id: 'system', label: 'System', icon: 'dns' },
];

/** More → Settings, a tab at a time: the home (name, where it is, timezone, rooms, who's home), notifications, access
 *  and other apps, and the system (Software update, privacy). What Kova does by itself lives in Automations. */
export function SettingsScreen() {
  const s = useSnap();
  const nav = useNav();
  const { act } = useHub();
  const [pick, setPick] = useState<'tz' | 'name' | null>(null);
  const [tab, setTab] = useState<Tab>('home');
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
  const notice = updateNotice(s.update, useAppUpdate());
  return (
    <Screen title="Settings" over={s.home.name} onBack={() => nav.goBack()}>
      <Segmented label="Settings sections" value={tab} onChange={id => setTab(id as Tab)} options={TABS.map(o => ({ ...o, label: o.id === 'system' && notice ? `${o.label} •` : o.label }))} />
      {tab === 'home' ? (
        <Group title="Home">
          <Row first icon="home" iconFg={C.amber} title="Name" sub={s.home.name} onPress={() => { setNameDraft(s.home.name); setPick('name'); }} />
          <Row icon="location_on" iconFg={C.amber} title="Where the home is"
            sub={loc && (loc.latitude || loc.longitude) ? `${s.home.address ? `${s.home.address} · ` : ''}${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} · ${loc.radiusM ?? 150} m circle` : 'Not set: paste from Google Maps, search the address, or use this phone. Sun and prayer times need it.'}
            onPress={() => nav.navigate('HomeLocation')} />
          <Row icon="schedule" iconFg={C.blue} title="Timezone" sub={zoneLabel(s.home.timezone)} onPress={() => { setQ(''); setPick('tz'); }} />
          {s.prayer?.on ? <Row icon="mosque" iconFg={C.green} title="Prayer times" sub={prayerSub(s.prayer)} onPress={() => nav.navigate('PrayerTimes')} /> : null}
          <Row icon="meeting_room" title="Rooms, people and devices" sub="Rooms and groups of rooms, people, devices, favourites, archived" onPress={() => nav.navigate('Customise')} />
          <Row icon="router" iconFg={C.blue} title="How Kova knows who’s home" sub="Your router, phones, network checks" onPress={() => nav.navigate('Integration', { id: 'presence' })} />
        </Group>
      ) : null}
      {tab === 'alerts' ? (
        <Group title="Notifications">
          <Row first icon="notifications" iconFg={C.amber} title="What you’re told about" sub="Each kind of notification, and how often" onPress={() => nav.navigate('NotifyPrefs')} />
          <Row icon="send" iconFg={C.stone} title="Phone push and ntfy" sub="Turn them on, switch one off for everyone, send a test" onPress={() => nav.navigate('Integration', { id: 'notify' })} />
        </Group>
      ) : null}
      {tab === 'access' ? (
        <Group title="Access and other apps">
          <Row first icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Your home on a computer, and signed-in browsers" onPress={() => nav.navigate('Browsers')} />
          {s.roomClimate?.rooms.length ? (
            <Row icon="graphic_eq" iconFg={C.blue} title="Voice and other apps" sub={`${s.roomClimate.rooms.length} room AC${s.roomClimate.rooms.length === 1 ? '' : 's'} for Google Home, Alexa and Apple Home`} onPress={() => nav.navigate('Voice')} />
          ) : null}
        </Group>
      ) : null}
      {tab === 'system' ? (
        <>
          <SoftwareUpdate hub={s.update} />
          <Group title="About">
            <Row first icon="lock" iconFg={C.green} title="Privacy policy" sub="What Kova collects, where it goes, and your choices" onPress={openPrivacyPolicy} right={<Icon name="arrow_outward" size={18} color={C.stone2} />} />
          </Group>
        </>
      ) : null}

      <Sheet open={pick === 'name'} onClose={() => setPick(null)} label="Home name">
        <T v="title">Home name</T>
        <FieldWithButton value={nameDraft} onChange={setNameDraft} button="Save" label="Home name" show={!!cleanName(nameDraft) && cleanName(nameDraft) !== s.home.name} onSubmit={() => void saveName()} />
        <T v="footnote" color={C.stone}>Shown at the top of the app, on the web and in notifications.</T>
      </Sheet>
      <Sheet open={pick === 'tz'} onClose={() => setPick(null)} label="Timezone">
        <T v="title">Timezone</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[3], borderRadius: R.md, backgroundColor: C.inset }}>
          <Icon name="search" size={20} color={C.stone2} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search, e.g. London" placeholderTextColor={C.stone3} autoCorrect={false} accessibilityLabel="Search timezones"
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
    </Screen>
  );
}

