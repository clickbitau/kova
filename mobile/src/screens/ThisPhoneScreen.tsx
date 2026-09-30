import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import * as Device from 'expo-device';
import { C } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { arriveLeaveOn, startArriveLeave, stopArriveLeave } from '../native/arrive-leave';
import { forgetPushToken, pushToken, savedPushToken } from '../native/push';
import { Icon } from '../ui/Icon';
import { Button, Card, HScroll, PageHead, Pill, Switch } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

/** Who this phone belongs to, arriving and leaving by location, notifications, and which hub it talks to. */
export function ThisPhoneScreen() {
  const s = useSnap();
  const { cfg, api, say, setPerson, forget } = useHub();
  const nav = useNav();
  const [geo, setGeo] = useState(false);
  const [push, setPush] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const me = s.people.find(p => p.id === cfg?.personId);

  useEffect(() => {
    void arriveLeaveOn().then(setGeo);
    void savedPushToken().then(t => setPush(!!t));
  }, []);

  const toggleGeo = async (on: boolean) => {
    if (!cfg) return;
    if (!on) { await stopArriveLeave(); setGeo(false); say('Kova no longer uses this phone’s location'); return; }
    if (!me) { say('First choose who this phone belongs to', { error: true }); return; }
    const home = s.home.location;
    if (!home || (!home.latitude && !home.longitude)) { say('Set the home’s location on the hub first', { error: true }); return; }
    setBusy('geo');
    try {
      const setup = await api<{ people: { id: string; key: string }[] }>('GET', '/api/presence/setup');
      const key = setup.people.find(p => p.id === me.id)?.key;
      if (!key) throw new Error('The hub has no key for this person yet');
      const r = await startArriveLeave({ hubUrl: cfg.url, personId: me.id, key, home });
      if (!r.ok) { say(r.why, { error: true }); return; }
      setGeo(true);
      say(`Kova will know when ${me.name} arrives and leaves`);
    } catch (e) { say((e as Error).message, { error: true }); } finally { setBusy(null); }
  };

  const togglePush = async (on: boolean) => {
    if (!on) {
      const t = await savedPushToken();
      if (t) await api('DELETE', '/api/push/app', { token: t }).catch(() => {});
      await forgetPushToken();
      setPush(false);
      return;
    }
    setBusy('push');
    try {
      const r = await pushToken();
      if (!r.ok) { say(r.why, { error: true }); return; }
      await api('POST', '/api/push/app', { token: r.token, personId: cfg?.personId, name: Device.deviceName ?? undefined, platform: Platform.OS });
      setPush(true);
      say('Notifications are on');
    } catch (e) { say((e as Error).message, { error: true }); } finally { setBusy(null); }
  };

  return (
    <Screen gap={18}>
      <PageHead over={s.home.name} title="This phone" onBack={() => nav.goBack()} />

      <View style={{ gap: 8 }}>
        <T size={13} weight={600}>This phone belongs to</T>
        <HScroll>
          {s.people.map(p => <Pill key={p.id} label={p.name} on={cfg?.personId === p.id} onPress={() => void setPerson(cfg?.personId === p.id ? undefined : p.id)} />)}
        </HScroll>
        {!s.people.length ? <T size={12.5} color={C.stone}>Add the people who live here in Customise home first.</T> : null}
      </View>

      <Card style={{ overflow: 'hidden' }}>
        {([
          ['location_on', 'Arrive and leave', me ? `Tells Kova when ${me.name} gets home or goes out, even with the app closed` : 'Choose who this phone belongs to first', geo, toggleGeo, 'geo'],
          ['notifications', 'Notifications', 'The doorbell, everyone out with lights on, the internet dropping', push, togglePush, 'push'],
        ] as const).map(([icon, title, sub, on, go, id], i) => (
          <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, opacity: busy === id ? 0.6 : 1 }}>
            <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: on ? 'rgba(127,212,160,0.15)' : C.selected, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={20} color={on ? C.green : C.bone} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={14.5} weight={700}>{title}</T>
              <T size={12} color={C.stone} lineHeight={1.35}>{sub}</T>
            </View>
            <Switch on={on} onChange={v => void go(v)} />
          </View>
        ))}
      </Card>
      <T size={12} color={C.stone2} lineHeight={1.45}>Location stays on this phone: it only tells your hub “arrived” or “left”. Kova also uses Warden or your router to see phones on the Wi-Fi, so either one is enough.</T>

      <Card style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="hub" size={20} color={C.stone} />
          <View style={{ flex: 1, gap: 2 }}>
            <T size={14} weight={700}>Hub</T>
            <T mono size={11.5} color={C.stone}>{cfg?.url ?? ''}</T>
          </View>
        </View>
        <Button kind="secondary" label="Disconnect this phone" icon="link_off" onPress={() => void (async () => { await stopArriveLeave(); await togglePush(false); await forget(); })()} />
      </Card>
    </Screen>
  );
}
