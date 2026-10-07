import { View } from 'react-native';
import { C, SP } from '../theme';
import type { Room, RoomZone } from '../api/types';
import { useHub } from '../state/hub';
import { useSheet } from '../state/sheet';
import { HVAC } from '../logic/devices';
import { acOnFor, offersAcOn, roomZoneLine, sharedWith, suggestWords, zoneOpenAt, zoneSwitch } from '../logic/zones';
import { Button, Card, IconWell, Press, Slider, Switch } from '../ui/kit';
import { T } from '../ui/Text';

/**
 * A room's air conditioner zones, as controls: open or closed, how far open, and the unit's mode, set temperature and
 * whether it's on. Opening the zone while the unit is off offers to turn it on, in the mode Kova suggests for the
 * room; it never happens by itself. Nothing here turns the unit off (closing the last open zone is the hub's call).
 */
export function RoomZones({ room, zones, rooms }: { room: string; zones: RoomZone[]; rooms: Room[] }) {
  if (!zones.length) return null;
  return <View style={{ gap: SP[2] }}>{zones.map(z => <ZoneCard key={`${z.device}:${z.n}`} z={z} room={room} rooms={rooms} />)}</View>;
}

function ZoneCard({ z, room, rooms }: { z: RoomZone; room: string; rooms: Room[] }) {
  const { send, say } = useHub();
  const sheet = useSheet();
  const live = z.on && z.ac.on && z.ac.online;
  const hv = HVAC.find(h => h[0] === z.ac.hvac);
  const tone = live ? hv?.[3] ?? C.blue : C.stone;
  const shared = sharedWith(z, room, rooms);
  const title = `${z.name} zone`;
  const turnAcOn = () => send(z.device, acOnFor(z), `${z.deviceName} on · ${suggestWords(z)}`);
  const flip = (on: boolean) => {
    void send(z.device, zoneSwitch(z, on)).then(ok => {
      // The zone opens, the unit stays off: say so, and offer to turn it on (the card offers it too).
      if (ok && on && !z.ac.on && z.ac.online) say(`${title} open. ${z.deviceName} is off`, { action: { label: 'Turn it on', run: () => void turnAcOn() } });
    });
  };
  return (
    <Card tint={live ? tone : undefined} style={{ padding: SP[3], gap: SP[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
        <Press onPress={() => sheet.open(z.device)} give="soft" label={`${title}: ${roomZoneLine(z)}. Open ${z.deviceName}`} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
          <IconWell icon={hv?.[2] ?? 'ac_unit'} color={tone} size={36} fill={live} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T v="headline" numberOfLines={1}>{title}</T>
            <T v="footnote" color={live ? C.bone2 : C.stone} numberOfLines={3}>{[roomZoneLine(z), shared ? `Shared with ${shared}` : ''].filter(Boolean).join(' · ')}</T>
          </View>
        </Press>
        <Switch on={z.on} color={C.blue} label={`${title} open`} disabled={!z.ac.online} onChange={flip} />
      </View>
      {z.on ? <Slider value={z.open ?? 100} color={C.blue} onColor={C.onBlue} label={`${title} opening`} disabled={!z.ac.online} onRelease={v => void send(z.device, zoneOpenAt(z, v))} /> : null}
      {offersAcOn(z) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: SP[2] }}>
          <T v="footnote" color={C.stone} style={{ flexShrink: 1 }}>{`${z.deviceName} is off.`}</T>
          <Button size="sm" kind="blue" icon="power_settings_new" label={`Turn on · ${suggestWords(z)}`} onPress={turnAcOn} />
        </View>
      ) : null}
    </Card>
  );
}
