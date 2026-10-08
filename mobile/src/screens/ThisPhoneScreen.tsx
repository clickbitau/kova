import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import * as Device from 'expo-device';
import { C, R, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { arriveLeaveOn, startArriveLeave, stopArriveLeave } from '../native/arrive-leave';
import { forgetPushToken, pushToken, savedPushToken } from '../native/push';
import { endHomeActivity, liveActivityRunning, liveActivitySupported, startHomeActivity } from '../native/extensions';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Card, Empty, Group, IconWell, Press, Row, Section, SwitchRow } from '../ui/kit';
import { animateLayout } from '../ui/motion';
import { locationPlan } from '../logic/presence';
import { meOf, presenceKeyFrom } from '../logic/roles';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { HubAddresses } from './HubAddresses';
import { useLocationDisclosure } from './LocationDisclosure';
import { useDemo } from '../state/demo';

/** Who this phone belongs to, arriving and leaving by location, notifications, and which hub it talks to. */
export function ThisPhoneScreen() {
  const s = useSnap();
  const { cfg, api, say, setPerson, forget, addresses, route } = useHub();
  const nav = useNav();
  const { demo, leaveDemo } = useDemo();
  const { disclose, view: disclosure } = useLocationDisclosure();
  const [geo, setGeo] = useState(false);
  const [push, setPush] = useState(false);
  const [lock, setLock] = useState(liveActivityRunning());
  const canLock = Platform.OS === 'ios';
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Signed in as one of the home's people (household accounts): this phone is theirs, and that's not a choice here.
  const account = meOf(s);
  const signedInAs = account.via === 'session' ? account.personId : null;
  const me = s.people.find(p => p.id === (signedInAs ?? cfg?.personId));
  // Warden or the router may already know when this person is home: then location is only an extra.
  const plan = locationPlan(me);
  const [extra, setExtra] = useState(false);

  useEffect(() => {
    void arriveLeaveOn().then(setGeo);
    void savedPushToken().then(t => setPush(!!t));
  }, []);

  const toggleGeo = async (on: boolean) => {
    // The demo home shows the disclosure as it is, but never asks for location or starts watching it.
    if (demo) { if (on && await disclose('foreground')) say('In the demo home Kova doesn’t use your location. Connect your own hub to turn this on.'); return; }
    if (!cfg) return;
    if (!on) { await stopArriveLeave(); setGeo(false); say('Kova no longer uses this phone’s location'); return; }
    if (!me) { say('First choose who this phone belongs to', { error: true }); return; }
    const home = s.home.location;
    if (!home || (!home.latitude && !home.longitude)) { say('Set the home’s location on the hub first', { error: true }); return; }
    setBusy('geo');
    try {
      // The owner reads every person's key; anyone else their own, from their account.
      const key = account.can.owner
        ? (await api<{ people: { id: string; key: string }[] }>('GET', '/api/presence/setup')).people.find(p => p.id === me.id)?.key
        : presenceKeyFrom((await api<{ presence: { arriveUrl: string } | null }>('GET', '/api/me')).presence?.arriveUrl);
      if (!key) throw new Error('The hub has no key for this person yet');
      const r = await startArriveLeave({ hubUrl: route?.url ?? cfg.url, addresses, hubId: cfg.hubId ?? null, personId: me.id, key, home }, disclose);
      if (!r.ok) { say(r.why, { error: !r.declined }); return; }
      setGeo(true);
      say(`Kova will know when ${me.name} arrives and leaves`);
    } catch (e) { say((e as Error).message, { error: true }); } finally { setBusy(null); }
  };

  const toggleLock = async (on: boolean) => {
    if (!on) { await endHomeActivity(); setLock(false); return; }
    if (!liveActivitySupported()) { say('Turn on Live Activities for Kova in Settings', { error: true }); return; }
    try { await startHomeActivity(s); setLock(true); say('Your home is on the lock screen'); } catch (e) { say((e as Error).message, { error: true }); }
  };

  const togglePush = async (on: boolean) => {
    if (demo) { if (on) say('Notifications come from your own hub. The demo home doesn’t send any.'); return; }
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
      await api('POST', '/api/push/app', { token: r.token, personId: signedInAs ?? cfg?.personId, name: Device.deviceName ?? undefined, platform: Platform.OS });
      setPush(true);
      say('Notifications are on');
    } catch (e) { say((e as Error).message, { error: true }); } finally { setBusy(null); }
  };

  const disconnect = async () => {
    if (demo) { await leaveDemo(); return true; }
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return true; }
    await stopArriveLeave(); await togglePush(false); await forget();
    return true;
  };

  return (
    <Screen title="This phone" over={s.home.name} onBack={() => nav.goBack()} gap={SP[6]}>
      <Section title="Whose phone is this?" caption>
        {signedInAs && me ? (
          <Card style={{ padding: SP[4], flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <Avatar name={me.name} home={me.home} size={40} ring={C.card} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T v="headline" numberOfLines={2}>{`${me.name}’s phone`}</T>
              <T v="footnote" color={C.stone}>{`Signed in as ${me.name} (${account.roleLabel.toLowerCase()}). Their notifications and arriving and leaving come here.`}</T>
            </View>
          </Card>
        ) : s.people.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
            {s.people.map(p => {
              const on = cfg?.personId === p.id;
              return (
                <Press key={p.id} selected={on} haptic="select" label={p.name} onPress={() => void setPerson(on ? undefined : p.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] + 2, height: 52, paddingLeft: 8, paddingRight: 16, borderRadius: R.lg, backgroundColor: on ? C.amberTint : C.card, borderWidth: 1, borderColor: on ? C.amberLine : C.edge }}>
                  <Avatar name={p.name} home={p.home} size={36} ring={on ? '#2a2318' : C.card} />
                  <T v="label" color={on ? C.bone : C.bone2}>{p.name}</T>
                  {on ? <Icon name="check" size={18} color={C.amber} /> : null}
                </Press>
              );
            })}
          </View>
        ) : <Empty compact icon="group" title="No people yet" text="Add the people who live here in Customise home first." />}
      </Section>

      {plan.needed ? (
        <Group note="Location stays on this phone: it only tells your hub “arrived” or “left”.">
          <SwitchRow first icon="location_on" title="Arrive and leave" sub={plan.text} on={geo} busy={busy === 'geo'} onChange={v => void toggleGeo(v)} />
        </Group>
      ) : (
        <View style={{ gap: SP[2] }}>
          <T v="overline" color={C.stone2} style={{ paddingHorizontal: 4 }}>Arrive and leave</T>
          <Card style={{ overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', gap: SP[3], padding: SP[4] }}>
              <IconWell icon="check_circle" color={C.green} size={36} fill />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="headline">{`Kova knows when ${me?.name ?? 'you'} ${me ? 'is' : 'are'} home`}</T>
                <T v="footnote" color={C.stone}>{plan.text}</T>
              </View>
            </View>
            {extra || geo ? (
              <SwitchRow icon="location_on" title="Also use this phone’s location" sub="Optional. It notices leaving a little sooner." on={geo} busy={busy === 'geo'} onChange={v => void toggleGeo(v)} />
            ) : (
              <Press onPress={() => { animateLayout(); setExtra(true); }} label="Also use this phone’s location" style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], minHeight: 48, paddingHorizontal: SP[4], borderTopWidth: 1, borderTopColor: C.hairline }}>
                <Icon name="location_on" size={18} color={C.stone} />
                <T v="labelSm" color={C.bone2} style={{ flex: 1 }}>Also use this phone’s location</T>
                <Icon name="expand_more" size={20} color={C.stone2} />
              </Press>
            )}
          </Card>
        </View>
      )}

      <Group>
        <SwitchRow first icon="notifications" title="Notifications" sub="On this phone" on={push} busy={busy === 'push'} onChange={v => void togglePush(v)} />
        <Row icon="tune" iconFg={C.amber} title="What you’re told about" sub="Each kind, and how often: every time, now and then, or never" onPress={() => nav.navigate('NotifyPrefs')} />
        {canLock ? <SwitchRow icon="lock" title="Home on the lock screen" sub="The mode, lights on and what’s next, on the lock screen and in the Dynamic Island" on={lock} onChange={v => void toggleLock(v)} /> : null}
      </Group>

      {demo ? (
        <>
          <Button kind="secondary" icon="link" label="Leave the demo and connect your hub" onPress={disconnect} />
          <T v="footnote" color={C.stone2} center style={{ marginTop: -SP[4] }}>The demo home runs on this phone only. Nothing here is real or sent anywhere.</T>
        </>
      ) : (
        <>
          <HubAddresses />
          <Button kind="danger" icon="link_off" label={confirm ? 'Tap again to disconnect' : 'Disconnect this phone'} onPress={disconnect} />
          <T v="footnote" color={C.stone2} center style={{ marginTop: -SP[4] }}>This phone stops controlling the home until you connect it again.</T>
        </>
      )}
      {disclosure}
    </Screen>
  );
}
