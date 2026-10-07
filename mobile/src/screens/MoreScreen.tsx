import { View } from 'react-native';
import { C, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { describeUpdate, notesBetween } from '../logic/ota';
import { applyAppUpdate, checkForAppUpdate, running, useAppUpdate } from '../native/updates';
import { Icon } from '../ui/Icon';
import { Button, Card, Group, IconWell, Mark, PulseDot, Row, Spinner } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import appVersion from '../version.json';
import { display, KIND_LABEL } from '../logic/addresses';
import { linkWords } from '../logic/link';
import { automationsOf } from '../logic/automations';

const TONE = { ok: C.green, ready: C.amber, busy: C.stone, error: C.red, muted: C.stone } as const;

/** More → App updates: what's running, whether the hub has something newer, check now, restart into it, and what's new. */
function AppUpdates() {
  const u = useAppUpdate();
  const d = describeUpdate(u, running.version);
  const fg = TONE[d.tone];
  const notes = u.state === 'ready' ? (u.notes ?? notesBetween(appVersion.history, running.version, u.version)) : appVersion.history.slice(0, 1);
  return (
    <View style={{ gap: SP[2] }}>
      <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>App updates</T>
      <Card tint={u.state === 'ready' ? C.amber : undefined} style={{ padding: SP[4], gap: SP[4] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }} accessibilityLiveRegion="polite">
          <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: alpha(fg, 0.14), alignItems: 'center', justifyContent: 'center' }}>
            {u.state === 'checking' ? <Spinner color={C.bone} /> : <Icon name={u.state === 'ready' ? 'cloud_download' : u.state === 'current' ? 'check_circle' : u.state === 'unreachable' ? 'cloud_off' : 'cloud'} size={21} color={fg} fill={u.state === 'current' || u.state === 'ready'} />}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="headline">{d.title}</T>
            <T v="footnote" color={u.state === 'unreachable' ? C.redText : C.stone}>{d.sub}</T>
          </View>
        </View>
        {notes.length ? (
          <View style={{ gap: SP[2], paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
            <T v="eyebrow" color={C.stone2}>{u.state === 'ready' ? 'What’s new' : `In Kova ${running.version}`}</T>
            {notes.slice(0, 3).map(n => (
              <View key={n.version} style={{ flexDirection: 'row', gap: SP[2] }}>
                {u.state === 'ready' ? <T mono size={11.5} color={C.amber} style={{ paddingTop: 2 }}>{n.version}</T> : <Icon name="auto_awesome" size={15} color={C.stone2} style={{ marginTop: 2 }} />}
                <T v="footnote" color={C.bone2} style={{ flex: 1 }}>{n.title}</T>
              </View>
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: SP[2], flexWrap: 'wrap' }}>
          {u.state === 'ready' ? <Button icon="restart_alt" label="Restart to update" onPress={() => applyAppUpdate()} /> : null}
          {u.state !== 'unsupported' && u.state !== 'ready' ? (
            <Button kind="secondary" icon="refresh" label="Check now" busy={u.state === 'checking'} onPress={() => checkForAppUpdate(true).then(c => c.state !== 'unreachable')} />
          ) : null}
        </View>
        <T mono size={11} color={C.stone2}>{`Kova ${running.version} · ${running.train}`}</T>
      </Card>
    </View>
  );
}

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
  return (
    <Screen title="More" over={s.home.name} gap={SP[6]}>
      <Card style={{ padding: SP[4], flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <IconWell icon="router" color={tone} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
            <PulseDot color={tone} size={7} />
            <T v="headline">{words.title}</T>
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
        <Row first icon="settings" iconFg={C.amber} title="Settings" sub="Where the home is, timezone, prayer times, behaviours" onPress={() => nav.navigate('Settings')} />
        <Row icon="home" title="Customise home" sub="Rooms, people, names and favourites" onPress={() => nav.navigate('Customise')} />
        <Row icon="hub" title="Integrations" sub={bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : `${s.integrations.length} connected`} subColor={bad.length ? C.amber : C.stone} badge={bad.length > 0} onPress={() => nav.navigate('Integrations')} />
      </Group>

      <Group title="This phone">
        <Row first icon="phone_iphone" iconFg={C.green} title={me ? `${me.name}’s phone` : 'This phone'} sub="Arriving and leaving, notifications, the hub it talks to" onPress={() => nav.navigate('ThisPhone')} />
        <Row icon="computer" iconFg={C.blue} title="Sign in a browser" sub="Type the code your Kova address shows on a computer" onPress={() => nav.navigate('Browsers')} />
      </Group>

      <AppUpdates />

      <View style={{ alignItems: 'center', gap: SP[2], paddingTop: SP[2] }}>
        <Mark size={22} ink={C.stone2} />
        <T v="footnote" color={C.stone2} center>Kova runs on your hub, on your own network.</T>
      </View>
    </Screen>
  );
}
