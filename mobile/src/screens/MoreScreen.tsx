import { View } from 'react-native';
import { C } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { automationsOf } from '../logic/automations';
import { Card, PageHead, Row } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import appVersion from '../version.json';
import { display, KIND_LABEL } from '../logic/addresses';

export function MoreScreen() {
  const s = useSnap();
  const { cfg, conn, route } = useHub();
  const nav = useNav();
  const mode = s.modes.find(m => m.id === s.current.modeId);
  const bad = s.integrations.filter(i => !i.ok);
  const players = s.devices.filter(d => (d.type === 'media' || d.type === 'tv') && d.state.on).length;
  const me = s.people.find(p => p.id === cfg?.personId);
  const web = (title: string, page: string) => () => nav.navigate('Web', { title, path: `/phone.html?embed=1&page=${page}` });
  const autos = automationsOf(s);
  const rows: [string, string, string, string, string, string, () => void, boolean?][] = [
    ['routine', 'Modes', `${s.modes.length} modes · now ${mode?.name ?? ''}${s.findings.length ? ` · ${s.findings.length} to look at` : ''}`, 'rgba(242,177,76,0.14)', C.amber, '', () => nav.navigate('Modes'), s.findings.length > 0],
    ['account_tree', 'Automations', autos.length ? `${autos.length} · ${autos.filter(a => a.enabled).length} on` : 'When something happens, do something', 'rgba(242,177,76,0.14)', C.amber, '', () => nav.navigate('Automations')],
    ['history', 'Activity', 'Everything that happened, and why', 'rgba(124,184,240,0.14)', C.blue, '', () => nav.navigate('Activity')],
    ['phone_iphone', 'This phone', me ? `${me.name}’s phone · arriving and leaving, notifications` : 'Who this phone belongs to, arriving and leaving, notifications', 'rgba(127,212,160,0.14)', C.green, '', () => nav.navigate('ThisPhone')],
    ['solar_power', 'Energy', 'Solar, use and the grid today', 'rgba(242,177,76,0.14)', C.amber, '', web('Energy', 'energy')],
    ['speaker_group', 'Media', players ? `${players} playing` : 'Speakers, TVs and speaker groups', 'rgba(124,184,240,0.14)', C.blue, '', web('Media', 'media')],
    ['home', 'Customise home', 'Rooms, people, names and favourites', C.selected, C.bone, '', web('Customise home', 'customise')],
    ['hub', 'Integrations', bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : `${s.integrations.length} connected`, C.selected, C.bone, '', web('Integrations', 'integrations'), bad.length > 0],
  ];
  return (
    <Screen>
      <PageHead over={s.home.name} title="More" />
      <Card style={{ overflow: 'hidden' }}>
        {rows.map(([icon, title, sub, bg, fg, , go, warn], i) => (
          <Row key={title} first={i === 0} icon={icon} iconBg={bg} iconFg={fg} title={title} sub={sub} subColor={warn ? C.amber : C.stone} onPress={go} />
        ))}
      </Card>
      <View style={{ alignItems: 'center', gap: 4 }}>
        <T size={11.5} color={C.stone3} center>{conn === 'live' && route ? `Connected · ${KIND_LABEL[route.kind]} · ${display(route.url)}` : `${conn === 'offline' ? 'Can’t reach' : 'Connecting to'} your hub`}</T>
        <T mono size={11} color={C.stone3} center>{`Kova ${appVersion.version}`}</T>
      </View>
    </Screen>
  );
}
