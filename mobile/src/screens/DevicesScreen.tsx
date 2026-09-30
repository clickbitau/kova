import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { devs, groupDevices, isLight, plural, toggleCommand, TYPES, type Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Empty, HScroll, PageHead, Pill, Press } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { TileGrid } from '../ui/Tile';

export function DevicesScreen() {
  const s = useSnap();
  const { send, act } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const [room, setRoom] = useState('all');
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const all = Object.values(devs(s));
  const groups = groupDevices(all, s.rooms, { room, type, q, showHidden });
  const visible = all.filter(d => !d.hidden);
  const lightsOn = visible.filter(d => isLight(d) && d.on).length;
  const hidden = all.filter(d => d.hidden).length;
  const types = TYPES.filter(t => t.id === 'all' || all.some(t.test));
  const tap = (d: Dev) => { const c = toggleCommand(d, s.sources); if (c) void send(d.id, c); else sheet.open(d.id); };
  const pills = [{ id: 'all', name: 'All rooms' }, ...s.rooms.filter(r => all.some(d => d.room === r.id)), ...(all.some(d => d.room === 'unassigned') ? [{ id: 'unassigned', name: 'Other' }] : [])];

  return (
    <Screen>
      <PageHead title="Devices" right={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Press label="Customise" onPress={() => nav.navigate('Web', { title: 'Customise home', path: '/phone.html?embed=1&page=customise' })} style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: C.control2, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="tune" size={19} />
          </Press>
          <Press onPress={() => nav.navigate('Web', { title: 'Add a device', path: '/phone.html?embed=1&add=1' })} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingLeft: 9, paddingRight: 12, borderRadius: 12, backgroundColor: C.amber }}>
            <Icon name="add" size={19} color={C.onAmber} />
            <T size={13} weight={700} color={C.onAmber}>Add</T>
          </Press>
        </View>
      } />
      <T size={13} color={C.stone} style={{ marginTop: -18 }}>{`${plural(visible.length, 'device')} · ${plural(lightsOn, 'light')} on`}</T>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 6, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, marginTop: -8 }}>
        <Icon name="search" size={20} color={C.stone2} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search devices" placeholderTextColor={C.stone3} autoCorrect={false} autoCapitalize="none"
          style={{ flex: 1, color: C.bone, fontFamily: F[400], fontSize: 16, paddingVertical: 11 }} />
        {q ? <Press onPress={() => setQ('')} label="Clear" style={{ padding: 6 }}><Icon name="close" size={19} color={C.stone2} /></Press> : null}
      </View>

      <View style={{ marginTop: -8 }}>
        <HScroll>{pills.map(p => <Pill key={p.id} label={p.name} on={room === p.id} onPress={() => setRoom(p.id)} />)}</HScroll>
      </View>
      {types.length > 2 ? (
        <View style={{ marginTop: -12 }}>
          <HScroll>
            {types.map(t => {
              const on = type === t.id;
              return (
                <Press key={t.id} onPress={() => setType(t.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 10, backgroundColor: on ? 'rgba(242,177,76,0.14)' : 'transparent', borderWidth: 1, borderColor: on ? 'rgba(242,177,76,0.4)' : C.line }}>
                  <Icon name={t.icon} size={15} color={on ? C.amber : C.bone2} />
                  <T size={12} weight={700} color={on ? C.amber : C.bone2}>{t.label}</T>
                </Press>
              );
            })}
          </HScroll>
        </View>
      ) : null}

      {groups.map(g => (
        <View key={g.id} style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <Icon name={g.icon} size={18} color={C.stone2} />
              <T size={16} weight={700}>{g.name}</T>
              <T size={12} color={C.stone2}>{plural(g.devices.length, 'device')}</T>
            </View>
            {g.lightsOn && g.id !== 'unassigned' ? (
              <Press onPress={() => void act('POST', `/api/rooms/${encodeURIComponent(g.id)}/off`, {}, `${g.name}: lights off`)}>
                <T size={13} weight={600} color={C.amber}>All off</T>
              </Press>
            ) : null}
          </View>
          <TileGrid items={g.devices} onToggle={tap} onOpen={d => sheet.open(d.id)} />
        </View>
      ))}

      {!groups.length ? (
        all.length
          ? <Empty icon="search_off" title="Nothing matches" text={q ? `No device called “${q}” here.` : 'No devices of that kind in this room.'} />
          : <Empty icon="devices" title="No devices yet" text="Add your lights, speakers and cameras. Kova finds some by itself." action="Add a device" onAction={() => nav.navigate('Web', { title: 'Add a device', path: '/phone.html?embed=1&add=1' })} />
      ) : null}

      {hidden ? (
        <Press onPress={() => setShowHidden(v => !v)} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.06)' }}>
          <Icon name={showHidden ? 'visibility_off' : 'visibility'} size={17} color={C.stone} />
          <T size={12.5} weight={600} color={C.stone}>{showHidden ? 'Hide hidden devices' : `Show ${plural(hidden, 'hidden device')}`}</T>
        </Press>
      ) : null}
    </Screen>
  );
}
