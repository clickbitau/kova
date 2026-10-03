import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { C, F, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { combineIdeasOf, devs, groupDevices, isLight, plural, toggleCommand, TYPES, type Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Button, Empty, HScroll, IconButton, Pill, Press } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { TileGrid } from '../ui/Tile';
import { animateLayout } from '../ui/motion';
import { CombineIdeaCard } from './CustomiseScreen';

/** A search box: icon, field, a clear button when there's something to clear. */
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], height: 46, paddingLeft: SP[3], paddingRight: 4, borderRadius: R.md, backgroundColor: C.card, borderWidth: 1, borderColor: focus ? C.amberLine : C.edge }}>
      <Icon name="search" size={20} color={focus ? C.amber : C.stone2} />
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.stone2} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} accessibilityLabel={placeholder}
        style={{ flex: 1, color: C.bone, fontFamily: F[500], fontSize: 16, paddingVertical: 10 }} />
      {value ? <IconButton icon="close" label="Clear search" size={34} tone="ghost" color={C.stone} onPress={() => onChange('')} /> : null}
    </View>
  );
}

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
  const add = () => nav.navigate('IntegrationAdd');
  const filtered = room !== 'all' || type !== 'all' || !!q;

  return (
    <Screen title="Devices" over={`${plural(visible.length, 'device')} · ${plural(lightsOn, 'light')} on`} right={
      <View style={{ flexDirection: 'row', gap: SP[2], paddingBottom: 4 }}>
        <IconButton icon="tune" label="Customise home" onPress={() => nav.navigate('Customise')} />
        <IconButton icon="add" label="Add a device" tone="amber" onPress={add} />
      </View>
    }>
      {combineIdeasOf(s).map(ci => <CombineIdeaCard key={ci.key} ci={ci} />)}
      <View style={{ gap: SP[3] }}>
        <SearchField value={q} onChange={setQ} placeholder="Search devices" />
        <HScroll>{pills.map(p => <Pill key={p.id} label={p.name} on={room === p.id} onPress={() => { animateLayout(); setRoom(p.id); }} />)}</HScroll>
        {types.length > 2 ? (
          <HScroll gap={SP[2]}>
            {types.map(t => {
              const on = type === t.id;
              return (
                <Press key={t.id} haptic="select" selected={on} label={t.label} onPress={() => { animateLayout(); setType(t.id); }} hitSlop={{ top: 6, bottom: 6 }}
                  style={{ height: 32, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, borderRadius: R.sm, backgroundColor: on ? alpha(C.amber, 0.14) : 'transparent', borderWidth: 1, borderColor: on ? C.amberLine : C.line }}>
                  <Icon name={t.icon} size={15} color={on ? C.amber : C.stone} fill={on} />
                  <T v="micro" size={12} color={on ? C.amber : C.bone2}>{t.label}</T>
                </Press>
              );
            })}
          </HScroll>
        ) : null}
      </View>

      {groups.map(g => (
        <View key={g.id} style={{ gap: SP[3] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SP[3], minHeight: 36 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], flexShrink: 1 }}>
              <Icon name={g.icon} size={19} color={C.stone} />
              <T v="heading" size={17} numberOfLines={1} style={{ flexShrink: 1 }}>{g.name}</T>
              <T v="footnote" color={C.stone2}>{String(g.devices.length)}</T>
            </View>
            {g.lightsOn && g.id !== 'unassigned' ? (
              <Button size="sm" kind="ghost" icon="light_off" label="All off" onPress={() => act('POST', `/api/rooms/${encodeURIComponent(g.id)}/off`, {}, `${g.name}: lights off`)} />
            ) : null}
          </View>
          <TileGrid items={g.devices} onToggle={tap} onOpen={d => sheet.open(d.id)} />
        </View>
      ))}

      {!groups.length ? (
        all.length
          ? <Empty icon="search_off" title="Nothing matches" text={q ? `No device called “${q}” here.` : 'No devices of that kind in this room.'} action={filtered ? 'Show everything' : undefined} onAction={() => { animateLayout(); setQ(''); setRoom('all'); setType('all'); }} />
          : <Empty icon="devices" tone={C.amber} title="No devices yet" text="Add your lights, speakers and cameras. Kova finds some by itself." action="Add a device" onAction={add} />
      ) : null}

      {hidden ? (
        <Press onPress={() => { animateLayout(); setShowHidden(v => !v); }} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: SP[4], borderRadius: R.full, backgroundColor: C.control2 }}>
          <Icon name={showHidden ? 'visibility_off' : 'visibility'} size={17} color={C.stone} />
          <T v="labelSm" color={C.bone2}>{showHidden ? 'Hide hidden devices' : `Show ${plural(hidden, 'hidden device')}`}</T>
        </Press>
      ) : null}
    </Screen>
  );
}
