// Sensors: they only report. By room, each with its main reading, which way it's heading, the rest of its
// readings, its battery, and whether it's answering. A tap opens its panel (readings, today's chart, settings).
import { useState } from 'react';
import { View } from 'react-native';
import { C, R, SP, alpha } from '../theme';
import { useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { groupSensors, sensorFlags, type SensorCard } from '../logic/sensors';
import { plural } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Card, Empty, Notice, Press } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear, animateLayout } from '../ui/motion';

function SensorTile({ c, index, onPress }: { c: SensorCard; index: number; onPress: () => void }) {
  return (
    <Appear index={index} style={{ flexBasis: '47%', flexGrow: 1 }}>
      <Press onPress={onPress} give="soft" label={c.label}>
        <Card tint={c.live ? c.color : undefined} style={{ padding: SP[3] + 2, gap: SP[3], opacity: c.online ? 1 : 0.6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: SP[2] }}>
            <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.live ? c.color : alpha(c.color, 0.16) }}>
              <Icon name={c.icon} size={20} color={c.live ? '#1a1408' : c.color} fill />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end', flexShrink: 1 }}>
              {c.pills.map(p => (
                <View key={p.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 22, paddingHorizontal: 7, borderRadius: R.full, backgroundColor: alpha(p.color, 0.14) }}>
                  <Icon name={p.icon} size={13} color={p.color} />
                  <T v="micro" size={10.5} color={p.color}>{p.text}</T>
                </View>
              ))}
            </View>
          </View>
          <View style={{ gap: 2 }}>
            <T v="label" numberOfLines={2}>{c.name}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T size={24} weight={700} tracking={-0.03} tabular color={c.mainColor} numberOfLines={1}>{c.main}</T>
              {c.trend ? <Icon name={c.trend[0]} size={18} color={c.trend[1]} /> : null}
            </View>
            <T v="footnote" color={C.bone2} numberOfLines={1}>{c.sub}</T>
            {c.foot ? <T v="micro" size={11} color={C.stone2} numberOfLines={2}>{c.foot}</T> : null}
          </View>
        </Card>
      </Press>
    </Appear>
  );
}

export function SensorsScreen() {
  const s = useSnap();
  const sheet = useSheet();
  const nav = useNav();
  const [showHidden, setShowHidden] = useState(false);
  const all = s.sensors ?? [];
  const groups = groupSensors(s, { showHidden });
  const flags = sensorFlags(all, s.rooms);
  const hidden = all.filter(x => x.hidden).length;
  const rooms = new Set(all.map(x => x.room)).size;
  let i = 0;
  return (
    <Screen title="Sensors" over={all.length ? `${plural(all.length, 'sensor')} in ${plural(rooms, 'room')}` : 'They only report'} onBack={() => nav.goBack()}>
      {flags.length ? (
        <View style={{ gap: SP[2] }}>
          {flags.map(f => <Notice key={f.text} compact icon={f.icon} color={f.color} title={f.text} />)}
        </View>
      ) : null}

      {groups.map(g => (
        <View key={g.id} style={{ gap: SP[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
            <Icon name={g.icon} size={19} color={C.stone} />
            <T v="heading" size={17}>{g.name}</T>
            {g.summary ? <T v="footnote" color={C.stone}>{g.summary}</T> : null}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
            {g.cards.map(c => <SensorTile key={c.id} c={c} index={i++} onPress={() => sheet.open(c.id)} />)}
          </View>
        </View>
      ))}

      {!all.length ? (
        <Empty icon="sensors" tone={C.green} title="No sensors yet" text="Temperature, humidity, motion, door and power sensors show up here once an integration finds them. They only report: their readings fill in each room, and automations can start on them." action="Add an integration" onAction={() => nav.navigate('IntegrationAdd')} />
      ) : null}

      {hidden ? (
        <Press onPress={() => { animateLayout(); setShowHidden(v => !v); }} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: SP[4], borderRadius: R.full, backgroundColor: C.control2 }}>
          <Icon name={showHidden ? 'visibility_off' : 'visibility'} size={17} color={C.stone} />
          <T v="labelSm" color={C.bone2}>{showHidden ? 'Hide hidden sensors' : `Show ${plural(hidden, 'hidden sensor')}`}</T>
        </Press>
      ) : null}
    </Screen>
  );
}
