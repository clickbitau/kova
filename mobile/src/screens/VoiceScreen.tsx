import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { clashText, comfortStep, googleSteps, homekitState, manualCode, matterState, roomAcRow, seasonLine, type VoicePairing } from '../logic/voice';
import { Card, Empty, ExpandRow, Group, IconButton, IconWell, Notice, NoticeAction, Row, Skeleton, SwitchRow } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { canCopy, copy } from '../native/clipboard';
import { haptic } from '../ui/motion';

/**
 * Settings → Voice and other apps: the room ACs Kova publishes (one per room a ducted zone serves), the steps to do
 * once in Google Home, the bridges' pairing codes, the season and comfortable temperatures Kova chooses with, what
 * Kova does when the AC is turned on from another app, and the note about the maker's own link.
 */
export function VoiceScreen() {
  const s = useSnap();
  const nav = useNav();
  const { api, act, say } = useHub();
  const [pair, setPair] = useState<VoicePairing | null>(null);
  const [open, setOpen] = useState<'matter' | 'homekit' | null>(null);
  const rc = s.roomClimate;
  const load = useCallback(() => { api<VoicePairing>('GET', '/api/room-climate/pairing').then(setPair).catch(() => setPair({ matter: { enabled: false }, homekit: { enabled: false } })); }, [api]);
  useEffect(() => { if (rc?.rooms.length) load(); }, [load, !!rc?.rooms.length]);

  if (!rc) {
    return (
      <Screen title="Voice and other apps" over="Settings" onBack={() => nav.goBack()}>
        <Empty icon="cloud_download" title="Update the hub" text="Room ACs for Google Home, Alexa and Apple Home arrive with hub 0.7.57." />
      </Screen>
    );
  }
  const units = s.devices.filter(d => !d.archived && Array.isArray(d.state.zones) && d.state.zones.length);
  if (!rc.rooms.length) {
    return (
      <Screen title="Voice and other apps" over="Settings" onBack={() => nav.goBack()}>
        <Empty icon="mode_fan" title="No room ACs yet" text="Choose the rooms each zone serves in the AC’s panel. Then each room gets its own AC in Google Home, Alexa and Apple Home."
          action={units.length ? 'Devices' : undefined} onAction={units.length ? () => nav.navigate('Tabs', { tab: 'Devices' }) : undefined} />
      </Screen>
    );
  }
  const set = rc.settings;
  const step = (key: 'coolTo' | 'heatTo', d: number) => {
    const r = comfortStep(set, key, d);
    if (!r) return;
    if ('error' in r) { say(r.error, { error: true }); return; }
    const v = r.body[key]!;
    void act('PUT', '/api/room-climate', r.body, `${key === 'coolTo' ? 'Cools' : 'Heats'} to ${v}°`);
  };
  const season = seasonLine(rc);
  const clash = clashText([...new Set(units.map(d => d.integration).filter(Boolean))]);
  const ms = matterState(pair), ks = homekitState(pair);
  const code = (qr: string | null | undefined, text: string, label: string) => (
    <View style={{ gap: SP[3], alignItems: 'center' }}>
      {qr ? <View style={{ borderRadius: R.md, backgroundColor: C.bone, padding: SP[3], overflow: 'hidden' }}><SvgXml xml={qr} width={180} height={180} /></View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], alignSelf: 'stretch' }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="footnote" color={C.stone}>Or type this code</T>
          <T mono size={22} color={C.bone} selectable>{text}</T>
        </View>
        {canCopy && text ? <IconButton icon="content_copy" label={`Copy the ${label} code`} size={38} onPress={() => { void copy(text.replace(/-/g, '')).then(ok => ok && haptic.success()); }} /> : null}
      </View>
    </View>
  );

  return (
    <Screen title="Voice and other apps" over="Settings" onBack={() => nav.goBack()} onRefresh={load}>
      <T v="callout" color={C.stone}>Each room a zone serves is its own AC in Google Home, Alexa and Apple Home. “Hey Google, turn on the AC” opens that room’s zone, and Kova picks the mode and temperature.</T>

      <Group title={`${rc.rooms.length} room AC${rc.rooms.length === 1 ? '' : 's'}`}>
        {rc.rooms.map((r, i) => {
          const row = roomAcRow(r, s.rooms);
          return <Row key={r.room} first={i === 0} icon="mode_fan" iconFg={row.on ? C.blue : C.bone} fill={row.on} title={row.title} sub={`${row.now}\n${row.sub}`} subColor={row.on ? C.blue : C.stone} />;
        })}
      </Group>

      <Card pad={SP[4]} style={{ gap: SP[3] }}>
        <T v="headline">Once, in Google Home</T>
        {googleSteps(rc).map((t, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: SP[3], alignItems: 'flex-start' }}>
            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: C.selected, alignItems: 'center', justifyContent: 'center' }}><T v="labelSm" color={C.bone}>{String(i + 1)}</T></View>
            <T v="body" color={C.bone2} style={{ flex: 1, minWidth: 0 }}>{t}</T>
          </View>
        ))}
        <T v="footnote" color={C.stone}>Also: “set the AC to 22”, “cool mode”, “turn off the AC”. Your choice holds until that room’s AC is turned off, and comes back the next time this season. Alexa and Apple Home work the same way.</T>
      </Card>

      <Group title="Bridges" note={pair?.matter.roomAcs?.length ? `The Matter bridge publishes ${pair.matter.roomAcs.length} room AC${pair.matter.roomAcs.length === 1 ? '' : 's'}.` : undefined}>
        {!pair ? <View style={{ padding: SP[4], gap: SP[2] }}><Skeleton h={18} w="60%" /><Skeleton h={14} w="40%" /></View> : (
          <>
            {pair.matter.enabled
              ? <ExpandRow first icon="hub" iconFg={C.blue} title="Matter bridge" sub={ms.text} open={open === 'matter'} onToggle={() => setOpen(open === 'matter' ? null : 'matter')}>{code(pair.matter.qrSvg, manualCode(pair.matter.manualCode), 'Matter')}</ExpandRow>
              : <Row first icon="hub" iconFg={C.blue} title="Matter bridge" sub={ms.text} onPress={() => nav.navigate('Integration', { id: 'matterBridge' })} />}
            {pair.homekit.enabled
              ? <ExpandRow icon="home" title="Apple Home bridge" sub={ks.text} open={open === 'homekit'} onToggle={() => setOpen(open === 'homekit' ? null : 'homekit')}>{code(pair.homekit.qrSvg, pair.homekit.pincode ?? '', 'Apple Home')}</ExpandRow>
              : <Row icon="home" title="Apple Home bridge" sub={ks.text} onPress={() => nav.navigate('Integration', { id: 'homekitBridge' })} />}
          </>
        )}
      </Group>

      <Group title="Comfort" note={`${season.title}. ${season.text}`}>
        {([['coolTo', 'Cool to', 'ac_unit', C.blue], ['heatTo', 'Heat to', 'local_fire_department', C.amber]] as const).map(([k, label, icon, color], i) => (
          <Row key={k} first={i === 0} icon={icon} iconFg={color} title={label} sub={`${set[k]}°`}
            right={<View style={{ flexDirection: 'row', gap: SP[2] }}>
              <IconButton icon="remove" label={`${label}, lower`} size={40} onPress={() => step(k, -0.5)} />
              <IconButton icon="add" label={`${label}, higher`} size={40} onPress={() => step(k, 0.5)} />
            </View>} />
        ))}
      </Group>

      <Group>
        <SwitchRow first icon="directions_walk" iconFg={C.amber} title="Turned on from another app" sub="When the AC comes on with every zone closed, open the rooms where someone is, else ask on your phones. Off: Kova leaves it."
          on={set.fromElsewhere === 'rooms'} onChange={v => void act('PUT', '/api/room-climate', { fromElsewhere: v ? 'rooms' : 'off' }, v ? 'Kova opens the rooms where someone is' : 'Kova leaves it')} />
      </Group>

      <Card tint={C.blue} pad={SP[4]} style={{ gap: SP[3], backgroundColor: alpha(C.blue, 0.08) }}>
        <View style={{ flexDirection: 'row', gap: SP[3], alignItems: 'center' }}>
          <IconWell icon="info" color={C.blue} bg={alpha(C.blue, 0.16)} size={38} fill />
          <T v="headline" style={{ flex: 1, minWidth: 0 }}>{clash.title}</T>
        </View>
        <T v="body" color={C.bone2}>{clash.text}</T>
        <T v="footnote" color={C.stone}>{clash.fix}</T>
      </Card>
    </Screen>
  );
}

/** The AC's panel: a short note about voice, and the maker's own link, with the way to the Voice screen. */
export function VoiceNote({ integration, onOpen }: { integration: string; onOpen: () => void }) {
  return (
    <Notice icon="graphic_eq" color={C.blue} compact title="Each room is its own AC for voice"
      text={`${integration || 'Its maker'} linked in Google Home adds a second AC: unlink or rename it there.`}>
      <NoticeAction main color={C.blue} label="Voice and other apps" onPress={onOpen} />
    </Notice>
  );
}
