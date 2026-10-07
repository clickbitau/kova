import { useEffect, useState, type ReactNode } from 'react';
import { Linking, View } from 'react-native';
import { C, SP } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import type { Adhan, PrayerName, PrayerView } from '../api/types';
import { announceMediaName } from '../logic/automations';
import { ADJUSTABLE, MADHABS, PRAYER_LABEL, adjustSummary, adjustWords, clampAdjust, methodLabel, todayTimes, withAdjust } from '../logic/prayer';
import { PRAYER_METHODS } from '../logic/settings';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, ExpandRow, Group, IconButton, Press, Segmented, SwitchRow, Tag } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';

type Body = { on?: boolean; method?: string; madhab?: 'shafi' | 'hanafi'; adjust?: Partial<Record<PrayerName, number>>; adhan?: { media?: string | null; fajr?: string | null } };

/** A built-in recording's credit: title · author · licence, linking to its page (CC BY-SA asks for it). */
export function AdhanCredit({ a }: { a: Adhan }) {
  return (
    <Press onPress={() => void Linking.openURL(a.page)} role="link" label={`${a.title} by ${a.author}, ${a.licence}. Open its page`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}>
      <Icon name="open_in_new" size={14} color={C.stone2} />
      <T v="footnote" color={C.stone} style={{ flex: 1, minWidth: 0 }}>{`${a.title} · ${a.author} · ${a.licence}`}</T>
    </Press>
  );
}

/** One choice in a list that opened in place: a name, a line under it, and a check when it's the one. */
function Pick({ label, sub, on, onPress, children }: { label: string; sub?: string; on: boolean; onPress: () => void; children?: ReactNode }) {
  return (
    <View>
      <Press onPress={onPress} haptic="select" selected={on} label={label} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[2] }}>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T v="callout" weight={on ? 700 : 500} color={on ? C.amber : C.bone}>{label}</T>
          {sub ? <T v="footnote" color={C.stone}>{sub}</T> : null}
        </View>
        {on ? <Icon name="check" size={20} color={C.amber} /> : null}
      </Press>
      {children}
    </View>
  );
}

/** What can be the call announcements play: the built-in recordings, uploaded clips, the home's sources. */
function CallChoices({ value, onPick, same }: { value?: string; onPick: (v: string) => void; same?: string }) {
  const s = useSnap();
  return (
    <View>
      {same ? <Pick label={same} on={!value} onPress={() => onPick('')} /> : null}
      {(s.adhans ?? []).map(a => (
        <Pick key={a.id} label={a.title} sub={a.ready ? undefined : 'Downloads the first time it plays'} on={value === a.id} onPress={() => onPick(a.id)}>
          <AdhanCredit a={a} />
        </Pick>
      ))}
      {(s.clips ?? []).map(c => <Pick key={c.id} label={c.name} sub="Your clip" on={value === `clip:${c.id}`} onPress={() => onPick(`clip:${c.id}`)} />)}
      {s.sources.map(x => <Pick key={x.name} label={x.name} sub="Source" on={value === x.name} onPress={() => onPick(x.name)} />)}
    </View>
  );
}

/**
 * Integrations → Prayer times: off unless the owner turns it on. On, the waqt shows on Now, prayer times can start
 * modes and automations, and announcements can play the call to prayer. How the times are worked out (the method,
 * Asr, a few minutes either way to match the local mosque) and which call plays, with Fajr's own.
 */
export function PrayerTimesScreen() {
  const s = useSnap();
  const nav = useNav();
  const { api, say, refresh } = useHub();
  const p = s.prayer;
  const [open, setOpen] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<Partial<Record<PrayerName, number>>>(p?.adjust ?? {});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAdjust(p?.adjust ?? {}); }, [JSON.stringify(p?.adjust ?? {})]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = async (body: Body, done: string) => {
    setBusy(true);
    try { await api<PrayerView>('PUT', '/api/prayer', body); say(done); void refresh(); return true; } catch (e) { say((e as Error).message, { error: true }); return false; } finally { setBusy(false); }
  };
  const toggle = (k: string) => setOpen(o => (o === k ? null : k));
  if (!p) {
    return (
      <Screen title="Prayer times" over={s.home.name} onBack={() => nav.goBack()}>
        <Empty icon="mosque" tone={C.green} title="Update Kova first" text="This hub doesn’t have prayer times as an integration yet. Update it in Settings → Software update." />
      </Screen>
    );
  }
  const methods = p.methods.length ? p.methods : PRAYER_METHODS.map(([id, label]) => ({ id, label }));
  const times = todayTimes(p, s.home.timezone);
  const changed = JSON.stringify(adjust) !== JSON.stringify(p.adjust ?? {});
  const names = { clips: s.clips, adhans: s.adhans };
  return (
    <Screen title="Prayer times" over={s.home.name} onBack={() => nav.goBack()} gap={SP[6]}>
      <Group note="Off hides prayer options: the card on Now, prayer times in the editors and the call to prayer. Modes and automations that already start at a prayer time keep running.">
        <SwitchRow first icon="mosque" iconFg={C.green} color={C.green} title="Prayer times" sub={p.on ? 'On' : 'Off'} on={p.on} busy={busy}
          onChange={v => void put({ on: v }, v ? 'Prayer times are on' : 'Prayer times are off')} />
      </Group>

      {p.on ? (
        <>
          {times.length ? (
            <Group title="Today">
              {times.map((t, i) => (
                <View key={t.prayer} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], minHeight: 48, paddingVertical: SP[2], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
                  <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SP[2], rowGap: 2 }}>
                    <T v="headline" color={t.prayer === 'sunrise' ? C.stone : C.bone}>{t.label}</T>
                    {t.next ? <Tag text="Next" color={C.green} /> : null}
                  </View>
                  <T v="headline" tabular color={t.next ? C.green : C.bone2}>{t.at}</T>
                </View>
              ))}
            </Group>
          ) : null}

          <Group title="How they’re worked out">
            <ExpandRow first icon="schedule" title="Method" sub={methodLabel(p)} open={open === 'method'} onToggle={() => toggle('method')}>
              {methods.map(m => <Pick key={m.id} label={m.label} on={m.id === p.method} onPress={() => { setOpen(null); void put({ method: m.id }, 'Prayer times recalculated'); }} />)}
            </ExpandRow>
            <ExpandRow icon="wb_sunny" title="Asr" sub={MADHABS.find(m => m.id === p.madhab)?.label ?? 'Standard'} open={open === 'asr'} onToggle={() => toggle('asr')}>
              <Segmented compact label="Asr" value={p.madhab} options={MADHABS.map(m => ({ id: m.id, label: m.label }))} onChange={id => void put({ madhab: id as 'shafi' | 'hanafi' }, id === 'hanafi' ? 'Asr: Hanafi' : 'Asr: standard')} />
              <T v="footnote" color={C.stone}>{MADHABS.map(m => `${m.label}: ${m.sub}`).join('. ')}.</T>
            </ExpandRow>
            <ExpandRow icon="tune" title="Adjustments" sub={adjustSummary(p.adjust ?? {})} open={open === 'adjust'} onToggle={() => toggle('adjust')}>
              <T v="footnote" color={C.stone}>A few minutes either way, to match your mosque’s timetable.</T>
              {ADJUSTABLE.map(k => (
                <View key={k} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SP[2] }}>
                  <View style={{ flexGrow: 1, flexBasis: 120, minWidth: 0 }}>
                    <T v="callout" weight={600}>{PRAYER_LABEL[k]}</T>
                    <T v="footnote" color={C.stone}>{adjustWords(adjust[k])}</T>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
                    <IconButton icon="remove" label={`${PRAYER_LABEL[k]} a minute earlier`} onPress={() => setAdjust(a => withAdjust(a, k, clampAdjust((a[k] ?? 0) - 1)))} />
                    <T v="label" tabular style={{ minWidth: 44 }} center>{`${(adjust[k] ?? 0) > 0 ? '+' : ''}${adjust[k] ?? 0}`}</T>
                    <IconButton icon="add" label={`${PRAYER_LABEL[k]} a minute later`} onPress={() => setAdjust(a => withAdjust(a, k, clampAdjust((a[k] ?? 0) + 1)))} />
                  </View>
                </View>
              ))}
              {changed ? <Button full icon="check" label="Save adjustments" onPress={() => put({ adjust }, 'Prayer times adjusted')} /> : null}
            </ExpandRow>
          </Group>

          <Group title="The call to prayer" note="What announcements play by default, and at Fajr (each announcement can choose another). Built-in recordings are free to share with credit.">
            <ExpandRow first icon="campaign" title="The call" sub={p.adhan.media ? announceMediaName(p.adhan.media, names) : 'Nothing chosen yet'} open={open === 'adhan'} onToggle={() => toggle('adhan')}>
              <CallChoices value={p.adhan.media} onPick={v => { setOpen(null); void put({ adhan: { media: v || null } }, 'The call to prayer is set'); }} />
            </ExpandRow>
            <ExpandRow icon="wb_twilight" title="Fajr’s call" sub={p.adhan.fajr ? announceMediaName(p.adhan.fajr, names) : 'The same call'} open={open === 'fajr'} onToggle={() => toggle('fajr')}>
              <CallChoices same="The same call" value={p.adhan.fajr} onPick={v => { setOpen(null); void put({ adhan: { fajr: v || null } }, v ? 'Fajr has its own call' : 'Fajr plays the same call'); }} />
            </ExpandRow>
          </Group>
          {(s.adhans ?? []).length ? (
            <Card pad={SP[4]} style={{ gap: SP[1] }}>
              <T v="eyebrow" color={C.stone2}>Recordings</T>
              {(s.adhans ?? []).map(a => <AdhanCredit key={a.id} a={a} />)}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
