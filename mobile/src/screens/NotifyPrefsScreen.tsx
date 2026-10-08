import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { C, SP } from '../theme';
import { useHub } from '../state/hub';
import { useNav } from '../navigation';
import { prefRows, type NotifyPref, type NotifyPrefsView } from '../logic/notify-prefs';
import { Icon } from '../ui/Icon';
import { Empty, Group, Press, Row, Segmented, Sheet, Spinner } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

/**
 * What I'm told about, and how often: each kind of notification every time, at most once an hour / 6 hours / a day,
 * or never. The owner also sets the household's (phones of no one in particular, ntfy, anyone who hasn't chosen).
 */
export function NotifyPrefsScreen() {
  const nav = useNav();
  const { api, say } = useHub();
  const [v, setV] = useState<NotifyPrefsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [house, setHouse] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const load = useCallback(() => { api<NotifyPrefsView>('GET', '/api/notify/prefs').then(x => { setV(x); setErr(null); }).catch(e => setErr((e as Error).message)); }, [api]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const forHouse = house || !v?.who;
  const set = async (kind: string, value: NotifyPref) => {
    try {
      const r = await api<NotifyPrefsView>('PUT', '/api/notify/prefs', { kind, value, ...(forHouse ? { household: true } : {}) });
      setV(r);
      setPick(null);
      return true;
    } catch (e) { say((e as Error).message); return false; }
  };
  const groups = v ? prefRows(v, forHouse) : [];
  const kind = v?.kinds.find(k => k.id === pick);
  const cur = kind ? (forHouse ? v?.household ?? v?.prefs : v?.prefs)?.[kind.id] ?? 'on' : null;
  return (
    <Screen title="What you’re told" over="Notifications" onBack={() => nav.goBack()} gap={SP[6]}>
      {!v ? (err ? <Empty icon="notifications" title="Couldn’t load your choices" text={err} /> : <View style={{ padding: SP[6], alignItems: 'center' }}><Spinner /></View>) : (
        <>
          <T v="callout" color={C.stone}>{forHouse
            ? 'For phones that aren’t anyone’s in particular, ntfy, and anyone in the home who hasn’t chosen for themselves.'
            : 'Choose what reaches your phone, and how often. When one is held back, the next that comes says how many there were.'}</T>
          {v.who && v.canHousehold ? (
            <Segmented label="Whose choices" compact value={house ? 'home' : 'me'} onChange={id => setHouse(id === 'home')}
              options={[{ id: 'me', label: v.name.split(' ')[0] ?? 'Mine' }, { id: 'home', label: 'Everyone else' }]} />
          ) : null}
          {groups.map(g => (
            <Group key={g.group} title={g.title}>
              {g.rows.map((r, i) => (
                <Row key={r.id} first={!i} icon={r.icon} iconFg={r.off || r.value === 'off' ? C.stone : C.amber} title={r.label} sub={r.short}
                  subColor={r.off || r.value === 'off' ? C.stone2 : C.amber} onPress={r.off ? undefined : () => setPick(r.id)} />
              ))}
            </Group>
          ))}
          {v.offForAll.length ? (
            <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>“Off for everyone” is switched off for the whole home in Integrations → Notifications.</T>
          ) : null}
        </>
      )}
      <Sheet open={!!kind} onClose={() => setPick(null)} label={kind?.label ?? 'Notification'}>
        {kind && v ? (
          <View style={{ gap: SP[3] }}>
            <T v="title" size={20}>{kind.label}</T>
            <T v="callout" color={C.stone}>{kind.help}</T>
            <View style={{ gap: SP[1] }} accessibilityRole="radiogroup">
              {v.choices.map(c => {
                const on = c.value === cur;
                return (
                  <Press key={String(c.value)} onPress={() => void set(kind.id, c.value)} label={c.label} selected={on} haptic="select"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 48, paddingHorizontal: SP[3], borderRadius: 12, backgroundColor: on ? C.selected : 'transparent' }}>
                    <Icon name={on ? 'check_circle' : 'radio_button_unchecked'} size={20} color={on ? C.amber : C.stone2} fill={on} />
                    <T v="callout" weight={on ? 600 : 400} style={{ flex: 1, minWidth: 0 }}>{c.label}</T>
                  </Press>
                );
              })}
            </View>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
