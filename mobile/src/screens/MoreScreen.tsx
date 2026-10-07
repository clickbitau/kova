import { View } from 'react-native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { useAppUpdate } from '../native/updates';
import { updateNotice } from '../logic/updates';
import { Card, Group, IconWell, Mark, PulseDot, Row } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { display, KIND_LABEL } from '../logic/addresses';
import { linkWords } from '../logic/link';
import { automationsOf } from '../logic/automations';

export function MoreScreen() {
  const s = useSnap();
  const autos = automationsOf(s);
  const { cfg, conn, route } = useHub();
  const nav = useNav();
  const mode = s.modes.find(m => m.id === s.current.modeId);
  const bad = s.integrations.filter(i => !i.ok);
  const players = s.devices.filter(d => (d.type === 'media' || d.type === 'tv') && d.state.on).length;
  const me = s.people.find(p => p.id === cfg?.personId);
  const live = conn === 'live';
  const words = linkWords({ state: conn });
  const tone = words.tone === 'ok' ? C.green : words.tone === 'down' ? C.red : C.amber;
  // Software update lives in Settings; a waiting one shows here as a note on that row, nothing more.
  const notice = updateNotice(s.update, useAppUpdate());
  return (
    <Screen title="More" over={s.home.name} gap={SP[6]}>
      <Card style={{ padding: SP[4], flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <IconWell icon="router" color={tone} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
            <PulseDot color={tone} size={7} />
            <T v="headline" style={{ flexShrink: 1 }}>{words.title}</T>
          </View>
          <T v="footnote" color={C.stone} numberOfLines={1}>{live && route ? `${KIND_LABEL[route.kind]} · ${display(route.url)}` : display(cfg?.url)}</T>
        </View>
      </Card>


      <Group title="Your home">
        <Row first icon="routine" iconFg={C.amber} title="Modes" sub={`${s.modes.length} modes · now ${mode?.name ?? ''}${s.findings.length ? ` · ${s.findings.length} to look at` : ''}`} subColor={s.findings.length ? C.amber : C.stone} badge={s.findings.length > 0} onPress={() => nav.navigate('Modes')} />
        <Row icon="account_tree" iconFg={C.amber} title="Automations" sub={autos.length ? `${autos.length} · ${autos.filter(a => a.enabled).length} on` : 'When something happens, do something'} onPress={() => nav.navigate('Automations')} />
        <Row icon="history" iconFg={C.blue} title="Activity" sub="Everything that happened, and why" onPress={() => nav.navigate('Activity')} />
        <Row icon="sensors" iconFg={C.green} title="Sensors" sub={s.sensors?.length ? `${s.sensors.length} · temperature, motion, doors and more` : 'Temperature, motion and door sensors'} onPress={() => nav.navigate('Sensors')} />
        <Row icon="solar_power" iconFg={C.amber} title="Energy" sub="Solar, use and the grid today" onPress={() => nav.navigate('Energy')} />
        <Row icon="speaker_group" iconFg={C.blue} title="Media" sub={players ? `${players} playing` : 'Speakers, TVs and speaker groups'} onPress={() => nav.navigate('Media')} />
      </Group>

      <Group title="Set up">
        <Row first icon="settings" iconFg={C.amber} title="Settings" sub={notice ?? 'The home, behaviours, notifications, software update'} subColor={notice ? C.blue : C.stone} badge={!!notice} onPress={() => nav.navigate('Settings')} />
        <Row icon="home" title="Customise home" sub="Rooms and groups, people, devices, favourites" onPress={() => nav.navigate('Customise')} />
        <Row icon="hub" title="Integrations" sub={bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : `${s.integrations.length} connected`} subColor={bad.length ? C.amber : C.stone} badge={bad.length > 0} onPress={() => nav.navigate('Integrations')} />
      </Group>

      <Group title="This phone">
        <Row first icon="phone_iphone" iconFg={C.green} title={me ? `${me.name}’s phone` : 'This phone'} sub="Arriving and leaving, notifications, the hub it talks to" onPress={() => nav.navigate('ThisPhone')} />
        <Row icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Type the code your Kova address shows on a computer" onPress={() => nav.navigate('Browsers')} />
      </Group>


      <View style={{ alignItems: 'center', gap: SP[2], paddingTop: SP[2] }}>
        <Mark size={22} ink={C.stone2} />
        <T v="footnote" color={C.stone2} center>Kova runs on your hub, on your own network.</T>
      </View>
    </Screen>
  );
}
