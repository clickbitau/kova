import { useEffect, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useSheet } from '../state/sheet';
import { useNav } from '../navigation';
import { devs, favourites, isLight, plural, toggleCommand, type Dev } from '../logic/devices';
import { dayBands } from '../logic/day';
import { alertActions, glanceCards, glanceColumns, insightColor, shownAlerts, waqtCard, type AlertAction } from '../logic/glance';
import { waqtOf } from '../logic/prayer';
import type { Insight } from '../api/types';
import { Icon } from '../ui/Icon';
import { Avatar, Button, Card, Empty, HScroll, IconWell, Mark, Notice, NoticeAction, Press, Section, Skeleton } from '../ui/kit';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { Appear } from '../ui/motion';
import { TileGrid, TileSkeleton } from '../ui/Tile';

/** "Wednesday 30 Sept" → "Wed 30 Sep", as in the phone design. */
const shortDate = (d: string) => d.replace(/^(\w{3})\w*/, '$1').replace(/\bSept\b/, 'Sep');

export function NowScreen() {
  const s = useSnap();
  const { send, act, api, say } = useHub();
  const sheet = useSheet();
  const nav = useNav();
  const all = devs(s);
  const modeById = (id: string | null) => s.modes.find(m => m.id === id) ?? s.modes[0];
  const M = modeById(s.current.modeId), next = modeById(s.current.nextId);
  const on = s.devices.filter(d => isLight(d) && d.state.on && !d.hidden).length;
  const w = s.weather;
  const ov = s.current.overlay;
  const favs = favourites(s, all);
  const happened = s.activity.filter(a => a.type === 'auto' || a.type === 'people').slice(0, 4);
  const tap = (d: Dev) => { const c = toggleCommand(d, s.sources); if (c) void send(d.id, c); else sheet.open(d.id); };
  const end = () => api('POST', '/api/overlays/end').then(() => { say(`Back to ${M?.name}`); return true; }).catch(e => { say((e as Error).message, { error: true }); return false; });
  const bands = dayBands(s);
  // The waqt counts down live: the card follows the clock every half minute while prayer times are on.
  const [clock, setClock] = useState(() => Date.now());
  const prayerOn = !!s.prayer?.on;
  useEffect(() => {
    if (!prayerOn) return;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [prayerOn]);
  const waqt = waqtCard(waqtOf(s.prayer, clock, s.home.timezone));
  const cards = [...(waqt ? [waqt] : []), ...glanceCards(s.glance)];
  const alerts = s.insights ?? [];
  const [allAlerts, setAllAlerts] = useState(false);
  const { shown, more } = shownAlerts(alerts, allAlerts);
  const { width, fontScale } = useWindowDimensions();
  const cols = glanceColumns(width, fontScale, cards.length);
  const cardW = Math.floor((width - SP.gutter * 2 - SP[2] * (cols - 1)) / cols) - 1;
  const anyLights = s.devices.some(d => isLight(d) && !d.hidden && !d.archived);

  return (
    <Screen glow={M?.color} head={
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}>
          <Mark size={22} />
          <T v="label" color={C.bone2}>{s.home.name}</T>
        </View>
        <Press onPress={() => nav.navigate('Tabs', { screen: 'Security' } as never)} label={`${plural(s.people.filter(p => p.home).length, 'person', 'people')} home`} style={{ flexDirection: 'row' }}>
          {s.people.slice(0, 4).map((p, i) => <View key={p.id} style={{ marginLeft: i ? -8 : 0 }}><Avatar name={p.name} home={p.home} size={32} /></View>)}
        </Press>
      </View>
    }>
      <View style={{ gap: SP[2], marginTop: -SP[1] }}>
        <T v="callout" color={C.stone} tabular>{`${shortDate(s.home.dateLabel)} · ${s.home.clock}${w ? ` · ${w.temp}° ${w.text.toLowerCase()}` : ''}`}</T>
        <Press onPress={() => nav.navigate('Modes')} label={`${M?.name} mode. Open modes`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], alignSelf: 'flex-start' }}>
          <Icon name={M?.icon ?? 'routine'} size={38} color={M?.color} fill />
          <T v="hero">{M?.name ?? ''}</T>
          <Icon name="chevron_right" size={26} color={C.stone2} />
        </Press>
        <T v="body" color={C.soft}>{`Until ${s.current.untilLabel}, then ${next?.name ?? ''}`}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2], marginTop: SP[1] }}>
          {on ? (
            <Press onPress={() => void act('POST', '/api/lights/off', {}, 'Lights off')} label={`${plural(on, 'light')} on. Turn them off`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: R.full, backgroundColor: C.amberTint, borderWidth: 1, borderColor: C.amberLine }}>
              <Icon name="lightbulb" size={17} color={C.amber} fill />
              <T v="labelSm">{plural(on, 'light')} on</T>
              <View style={{ width: 1, height: 14, backgroundColor: C.amberLine }} />
              <T v="labelSm" color={C.amber}>Turn off</T>
            </Press>
          ) : anyLights ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], height: 36, paddingHorizontal: 12, borderRadius: R.full, backgroundColor: C.card, borderWidth: 1, borderColor: C.edge }}>
              <Icon name="light_off" size={17} color={C.stone} />
              <T v="labelSm" color={C.stone}>All lights off</T>
            </View>
          ) : null}
          {ov ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2], height: 36, paddingLeft: 10, paddingRight: 4, borderRadius: R.full, backgroundColor: C.card, borderWidth: 1, borderColor: C.edgeTop }}>
              <Icon name={ov.icon} size={17} color={C.amber} fill />
              <T v="labelSm">{`${ov.name} · ${ov.endsLabel.toLowerCase()}`}</T>
              <Press onPress={() => void end()} label={`End ${ov.name}`} style={{ height: 28, justifyContent: 'center', paddingHorizontal: 10, borderRadius: R.full, backgroundColor: C.control2 }}>
                <T v="label" size={12.5}>End</T>
              </Press>
            </View>
          ) : null}
        </View>
      </View>

      {alerts.length ? (
        <View style={{ gap: SP[2] + 2 }}>
          {shown.map((i, n) => <AlertCard key={i.id} i={i} index={n} />)}
          {more || allAlerts ? (
            <Press onPress={() => setAllAlerts(!allAlerts)} haptic="select" label={allAlerts ? 'Show fewer alerts' : `Show ${plural(more, 'more alert')}`}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SP[1], minHeight: 40, borderRadius: R.md, borderWidth: 1, borderColor: C.edge, backgroundColor: C.card }}>
              <T v="labelSm" color={C.bone2}>{allAlerts ? 'Show fewer' : `${plural(more, 'more alert')}`}</T>
              <Icon name={allAlerts ? 'expand_less' : 'expand_more'} size={18} color={C.stone} />
            </Press>
          ) : null}
        </View>
      ) : null}

      {cards.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
          {cards.map(c => (
            <Press key={c.key} give="soft" onPress={c.key === 'waqt' ? () => nav.navigate('PrayerTimes') : c.device ? () => sheet.open(c.device!) : undefined} label={`${c.label}: ${c.value}, ${c.caption}. ${c.sub}`} style={{ flexGrow: 1, flexBasis: cardW, minWidth: 0 }}>
              <Card pad={SP[3]} style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <Icon name={c.icon} size={16} color={c.color} fill />
                  <T v="eyebrow" color={C.stone2} numberOfLines={1} style={{ flexShrink: 1 }}>{c.label}</T>
                </View>
                <T v="heading" tabular numberOfLines={1}>{c.value}</T>
                <T v="footnote" weight={600} color={C.bone2} numberOfLines={1}>{c.caption}</T>
                {c.sub ? <T v="footnote" color={C.stone} numberOfLines={2}>{c.sub}</T> : null}
              </Card>
            </Press>
          ))}
        </View>
      ) : null}

      <Card style={{ padding: SP[4], gap: SP[2] }}>
        <View style={{ height: 40, borderRadius: R.sm, overflow: 'hidden', flexDirection: 'row' }} accessibilityLabel={`Today: ${bands.map(b => `${b.name} from ${b.from}`).join(', ')}`}>
          {bands.map((b, i) => (
            <View key={i} style={{ height: '100%', width: `${b.width * 100}%`, backgroundColor: alpha(b.color, b.current ? 0.42 : 0.2), borderRightWidth: i < bands.length - 1 ? 1 : 0, borderRightColor: C.card, justifyContent: 'center', paddingHorizontal: 6 }}>
              {b.width >= 0.12 ? <T v="micro" size={10.5} color={b.current ? C.bone : b.color} numberOfLines={1}>{b.name}</T> : null}
            </View>
          ))}
          <View style={{ position: 'absolute', left: `${(s.home.nowHour / 24) * 100}%`, top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: '#fff', boxShadow: '0px 0px 6px rgba(255,255,255,0.6)' }} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {['00', '06', '12', '18', '24'].map(h => <T key={h} mono size={10.5} color={C.stone2}>{h}</T>)}
        </View>
      </Card>

      {s.upcoming.length ? (
        <Section title="Coming up">
          <HScroll gap={SP[2] + 2}>
            {s.upcoming.map((u, i) => {
              const color = modeById(u.modeId)?.color ?? C.stone;
              return (
                <Appear key={u.id} index={i}>
                  <Card style={{ width: 216, padding: SP[4], gap: SP[2], opacity: u.skipped ? 0.6 : 1, flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                      <T mono size={12.5} color={color}>{u.t}</T>
                    </View>
                    <T v="headline" style={u.skipped ? { textDecorationLine: 'line-through' } : null}>{u.label}</T>
                    <T v="footnote" color={C.stone} numberOfLines={2} style={{ flex: 1 }}>{u.skipped ? 'Skipped tonight' : u.what}</T>
                    <View style={{ marginTop: SP[1] }}>
                      <Button size="sm" kind="secondary" label={u.skipped ? 'Undo skip' : 'Skip tonight'}
                        onPress={() => api('POST', '/api/plan/skip', { id: u.id, skip: !u.skipped }).then(() => true).catch(e => { say((e as Error).message, { error: true }); return false; })} />
                    </View>
                  </Card>
                </Appear>
              );
            })}
          </HScroll>
        </Section>
      ) : null}

      <Section title="Favourites" action={favs.length ? 'All devices' : undefined} onAction={() => nav.navigate('Tabs', { screen: 'Devices' } as never)}>
        {favs.length ? <TileGrid items={favs} onToggle={tap} onOpen={d => sheet.open(d.id)} />
          : s.devices.length ? <Empty compact icon="star" tone={C.amber} title="No favourites yet" text="Star a device in its panel to keep it here." />
          : <Empty compact icon="devices" tone={C.amber} title="No devices yet" text="Connect your lights, speakers and cameras, and keep the ones you use most here." action="Add an integration" onAction={() => nav.navigate('IntegrationAdd')} />}
      </Section>

      {s.overlays.length ? (
        <Section title="Switch the home to">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] + 2 }}>
            {s.overlays.map((o, i) => {
              const a = ov?.id === o.id;
              return (
                <Appear key={o.id} index={i} style={{ flexBasis: '47%', flexGrow: 1 }}>
                  <Press give="soft" selected={a} label={a ? `${o.name} is on. End it` : `Switch to ${o.name}`}
                    onPress={() => a ? void end() : void act('POST', `/api/overlays/${encodeURIComponent(o.id)}/start`, {}, `${o.name} is on`)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], padding: SP[3], borderRadius: R.lg, backgroundColor: a ? C.amberTint : C.card, borderWidth: 1, borderColor: a ? C.amberLine : C.edge, borderTopColor: a ? C.amberLine : C.edgeTop }}>
                    <IconWell icon={o.icon} color={C.amber} fill size={38} bg={a ? alpha(C.amber, 0.22) : undefined} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T v="headline" size={14.5} numberOfLines={1}>{o.name}</T>
                      <T v="footnote" size={11.5} color={a ? C.amber : C.stone} numberOfLines={2}>{a ? 'On now · tap to end' : o.endsLabel}</T>
                    </View>
                  </Press>
                </Appear>
              );
            })}
          </View>
        </Section>
      ) : null}

      {s.findings.length ? (
        <Press give="soft" onPress={() => nav.navigate('Modes')} label={`${plural(s.findings.length, 'thing')} worth a look in your modes`}>
          <Card tint={C.green} style={{ paddingVertical: SP[4], paddingHorizontal: SP[4], flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
            <IconWell icon="fact_check" color={C.green} size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="headline">{`${plural(s.findings.length, 'thing')} worth a look`}</T>
              <T v="footnote" color={C.stone}>Kova checked your modes against the last two weeks</T>
            </View>
            <Icon name="chevron_right" size={20} color={C.stone} />
          </Card>
        </Press>
      ) : null}

      <Section title="Just happened" action={happened.length ? 'See all' : undefined} onAction={() => nav.navigate('Activity')} gap={SP[1]}>
        {happened.length ? happened.map((h, i) => (
          <Appear key={h.id} index={i} style={{ flexDirection: 'row', gap: SP[3], paddingVertical: SP[3], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
            <T mono size={12} color={C.stone2} style={{ width: 40, paddingTop: 2 }}>{h.t}</T>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="callout" weight={600} color={C.bone}>{h.what}</T>
              {h.why ? <T v="footnote" color={C.stone}>{`↳ ${h.why}`}</T> : null}
            </View>
          </Appear>
        )) : <Empty compact icon="history" title="Quiet so far" text="What your modes and people do shows up here." />}
      </Section>
    </Screen>
  );
}

const LEVEL: Record<Insight['level'], string> = { alert: 'Needs you now', warning: 'Worth a look', info: 'Good to know' };
const ACTION: Record<AlertAction, string> = { open: 'Open', later: 'Not now', expected: 'That’s expected' };

/**
 * One alert, as a Notice: how urgent it is, what's wrong and the detail, then Open (in the alert's colour), Not now
 * and That's expected. On a narrow phone or with large text the buttons wrap and share the width.
 */
function AlertCard({ i, index }: { i: Insight; index: number }) {
  const { act } = useHub();
  const sheet = useSheet();
  const col = insightColor(i.level);
  const run = (a: AlertAction) => {
    if (a === 'open') sheet.open(i.device!);
    else if (a === 'later') void act('POST', `/api/insights/${encodeURIComponent(i.id)}/snooze`, { hours: 24 }, 'Hidden for a day');
    // Hidden for as long as it stays exactly so; a change, or its coming back later, shows again.
    else void act('POST', `/api/insights/${encodeURIComponent(i.id)}/snooze`, { untilItChanges: true }, 'Hidden while it stays like this');
  };
  return (
    <Appear index={index}>
      <Notice icon={i.icon} color={col} eyebrow={LEVEL[i.level]} title={i.title} text={i.detail}>
        {alertActions(i).map(a => <NoticeAction key={a} label={ACTION[a]} main={a === 'open'} color={col} a11y={a === 'open' ? `Open ${i.title}` : undefined} onPress={() => run(a)} />)}
      </Notice>
    </Appear>
  );
}

/** Now's shape while the first state comes in: header, mode, timeline and tiles as shimmering blocks. */
export function NowSkeleton() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.page, paddingTop: insets.top + SP[4], paddingHorizontal: SP.gutter, gap: SP.section }} accessibilityLabel="Loading your home">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[2] }}><Mark size={22} /><Skeleton w={110} h={14} r={7} /></View>
        <Skeleton w={56} h={32} r={16} />
      </View>
      <View style={{ gap: SP[3] }}>
        <Skeleton w={170} h={13} r={6} />
        <Skeleton w={210} h={42} r={12} />
        <Skeleton w={240} h={15} r={7} />
      </View>
      <Skeleton h={78} r={R.lg} />
      <View style={{ gap: SP[3] }}>
        <Skeleton w={120} h={18} r={8} />
        <TileSkeleton rows={2} />
      </View>
    </View>
  );
}
