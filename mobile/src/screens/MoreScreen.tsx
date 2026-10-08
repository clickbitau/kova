import { cloneElement, type ReactElement } from 'react';
import { View } from 'react-native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { running, useAppUpdate } from '../native/updates';
import { updateNotice } from '../logic/updates';
import { Button, Card, Group, IconWell, Mark, PulseDot, Row } from '../ui/kit';
import { Icon } from '../ui/Icon';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { display, KIND_LABEL } from '../logic/addresses';
import { linkWords } from '../logic/link';
import { automationsOf } from '../logic/automations';
import { features, meOf } from '../logic/roles';
import { useDemo } from '../state/demo';
import { openPrivacyPolicy } from '../ui/PrivacyLink';

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
  // What this person's role can use (logic/roles.ts); the hub refuses the rest anyway.
  const who = meOf(s);
  const can = features(who);
  const { demo, leaveDemo } = useDemo();
  return (
    <Screen title="More" over={s.home.name} gap={SP[6]}>
      {demo ? (
        <Card tint={C.amber} style={{ padding: SP[4], gap: SP[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <IconWell icon="science" color={C.amber} size={40} fill />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="headline">You’re in the demo home</T>
              <T v="footnote" color={C.stone}>It runs on this phone only. Nothing here is real, and nothing is sent anywhere.</T>
            </View>
          </View>
          <Button icon="link" label="Connect your own hub" onPress={() => leaveDemo()} />
        </Card>
      ) : <Card style={{ padding: SP[4], flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <IconWell icon="router" color={tone} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
            <PulseDot color={tone} size={7} />
            <T v="headline" style={{ flexShrink: 1 }}>{words.title}</T>
          </View>
          <T v="footnote" color={C.stone} numberOfLines={1}>{live && route ? `${KIND_LABEL[route.kind]} · ${display(route.url)}` : display(cfg?.url)}</T>
        </View>
      </Card>}


      <Group title="Your home">
        {[
          can.modes && <Row key="modes" icon="routine" iconFg={C.amber} title="Modes" sub={`${s.modes.length} modes · now ${mode?.name ?? ''}${s.findings.length ? ` · ${s.findings.length} to look at` : ''}`} subColor={s.findings.length ? C.amber : C.stone} badge={s.findings.length > 0} onPress={() => nav.navigate('Modes')} />,
          can.automations && <Row key="autos" icon="account_tree" iconFg={C.amber} title="Automations" sub={autos.length ? `${autos.length} · ${autos.filter(a => a.enabled).length} on` : 'When something happens, do something'} onPress={() => nav.navigate('Automations')} />,
          can.activity && <Row key="activity" icon="history" iconFg={C.blue} title="Activity" sub={can.modes ? 'Everything that happened, and why' : 'What happened with your devices'} onPress={() => nav.navigate('Activity')} />,
          can.sensors && <Row key="sensors" icon="sensors" iconFg={C.green} title="Sensors" sub={s.sensors?.length ? `${s.sensors.length} · temperature, motion, doors and more` : 'Temperature, motion and door sensors'} onPress={() => nav.navigate('Sensors')} />,
          can.energy && <Row key="energy" icon="solar_power" iconFg={C.amber} title="Energy" sub="Solar, use and the grid today" onPress={() => nav.navigate('Energy')} />,
          <Row key="media" icon="speaker_group" iconFg={C.blue} title="Media" sub={players ? `${players} playing` : 'Speakers, TVs and speaker groups'} onPress={() => nav.navigate('Media')} />,
        ].filter((r): r is ReactElement<{ first?: boolean }> => !!r).map((r, i) => (i === 0 ? cloneElement(r, { first: true }) : r))}
      </Group>

      <Group title={can.settings ? 'Set up' : 'Your account'}>
        <Row first icon="group" iconFg={C.green} title={can.manage ? 'People and access' : 'You'} sub={can.manage ? 'Invite people, roles, their devices' : `${who.name} · ${who.roleLabel}`} onPress={() => nav.navigate('People')} />
        {can.settings ? <Row icon="settings" iconFg={C.amber} title="Settings" sub={notice ?? 'The home, behaviours, notifications, software update'} subColor={notice ? C.blue : C.stone} badge={!!notice} onPress={() => nav.navigate('Settings')} /> : null}
        {can.customise ? <Row icon="home" title="Customise home" sub="Rooms and groups, people, devices, favourites" onPress={() => nav.navigate('Customise')} /> : null}
        {can.integrations ? <Row icon="hub" title="Integrations" sub={bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : `${s.integrations.length} connected`} subColor={bad.length ? C.amber : C.stone} badge={bad.length > 0} onPress={() => nav.navigate('Integrations')} /> : null}
      </Group>

      <Group title="This phone">
        <Row first icon="phone_iphone" iconFg={C.green} title={me ? `${me.name}’s phone` : 'This phone'} sub="Arriving and leaving, notifications, the hub it talks to" onPress={() => nav.navigate('ThisPhone')} />
        <Row icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Type the code your Kova address shows on a computer" onPress={() => nav.navigate('Browsers')} />
      </Group>

      <Group title="About">
        <Row first icon="lock" iconFg={C.green} title="Privacy policy" sub="What Kova collects, where it goes, and your choices" onPress={openPrivacyPolicy} right={<Icon name="arrow_outward" size={18} color={C.stone2} />} />
        <Row icon="info" title={`Kova ${running.version}`} sub="Made by ClickBIT" />
      </Group>

      <View style={{ alignItems: 'center', gap: SP[2], paddingTop: SP[2] }}>
        <Mark size={22} ink={C.stone2} />
        <T v="footnote" color={C.stone2} center>Kova runs on your hub, on your own network.</T>
      </View>
    </Screen>
  );
}
