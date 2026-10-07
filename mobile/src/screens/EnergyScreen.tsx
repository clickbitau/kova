import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import { C, SP, alpha } from '../theme';
import { useHub, useSnap } from '../state/hub';
import { useNav } from '../navigation';
import { devs, ICON, type Dev } from '../logic/devices';
import { energyView, kwh, parseWatts, wattsNote, type EnergyBar, type EnergyStat } from '../logic/energy';
import { Icon } from '../ui/Icon';
import { Button, Card, Empty, IconWell, Press, Row, Section, Sheet } from '../ui/kit';
import { Appear } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { T } from '../ui/Text';
import { SearchField } from './DevicesScreen';
import { SheetHead, TextField } from './SpeakerGroupSheet';

/** Home use in the chart: a light neutral beside solar's amber, so the two read apart without colour too. */
const USE = '#9c9a95';
const TONE: Record<EnergyStat['tone'], string> = { amber: C.amber, bone: C.bone, blue: C.blue, green: C.green, muted: C.stone2 };

/** A bar with a rounded top, standing on the baseline. */
const bar = (x: number, w: number, base: number, h: number) => {
  if (h <= 0) return '';
  const r = Math.min(2, w / 2, h);
  return `M${x} ${base}V${base - h + r}Q${x} ${base - h} ${x + r} ${base - h}H${x + w - r}Q${x + w} ${base - h} ${x + w} ${base - h + r}V${base}Z`;
};

/** Today by the hour: solar and home use side by side, hours to come faint, a line at now. Tap an hour for its numbers. */
function DayChart({ bars, max, hasUse, nowHour, raw }: { bars: EnergyBar[]; max: number; hasUse: boolean; nowHour: number; raw: { solar: number; use: number | null }[] }) {
  const [w, setW] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const H = 132, base = H - 1;
  const slot = w / 24, bw = Math.max(2, (slot - 3) / (hasUse ? 2 : 1) - (hasUse ? 1 : 0));
  const pick = sel != null ? raw[sel] : null;
  return (
    <View style={{ gap: SP[2] }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 20 }} accessibilityLiveRegion="polite">
        {pick && sel != null ? (
          <T v="footnote" weight={600} color={C.bone2} tabular>{`${String(sel).padStart(2, '0')}:00 · solar ${kwh(pick.solar)}${hasUse ? ` · use ${kwh(pick.use)}` : ''}`}</T>
        ) : <T v="footnote" color={C.stone2} tabular>{`Busiest hour ${kwh(max)}`}</T>}
        <View style={{ flexDirection: 'row', gap: SP[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: C.amber }} /><T v="micro" color={C.stone}>Solar</T></View>
          {hasUse ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: USE }} /><T v="micro" color={C.stone}>Home use</T></View> : null}
        </View>
      </View>
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height: H }}
        accessibilityLabel={`Today by the hour. ${raw.map((x, h) => x.solar || x.use ? `${h}:00 solar ${x.solar} kilowatt hours${x.use != null ? `, use ${x.use}` : ''}` : '').filter(Boolean).join('. ') || 'Nothing yet.'}`}>
        {w ? (
          <Svg width={w} height={H}>
            {[0.5, 1].map(f => <Line key={f} x1={0} x2={w} y1={base - f * (H - 8)} y2={base - f * (H - 8)} stroke={C.hairline} strokeWidth={1} />)}
            {bars.map(b => {
              const x = b.hour * slot + 1.5, o = b.later ? 0.28 : sel == null || sel === b.hour ? 1 : 0.45;
              return (
                <Path key={`s${b.hour}`} d={bar(x, bw, base, b.solar * (H - 8))} fill={C.amber} opacity={o} />
              );
            })}
            {hasUse ? bars.map(b => {
              const x = b.hour * slot + 1.5 + bw + 2, o = b.later ? 0.28 : sel == null || sel === b.hour ? 1 : 0.45;
              return b.use != null ? <Path key={`u${b.hour}`} d={bar(x, bw, base, b.use * (H - 8))} fill={USE} opacity={o} /> : null;
            }) : null}
            <Line x1={0} x2={w} y1={base + 0.5} y2={base + 0.5} stroke={C.line} strokeWidth={1} />
            <Rect x={(nowHour / 24) * w - 1} y={0} width={2} height={H} rx={1} fill={C.bone} opacity={0.7} />
          </Svg>
        ) : null}
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row' }}>
          {bars.map(b => <Press key={b.hour} give="soft" haptic="select" label={`${b.hour}:00`} onPress={() => setSel(s => s === b.hour ? null : b.hour)} style={{ flex: 1 }} />)}
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {['00', '06', '12', '18', '24'].map(h => <T key={h} mono size={10.5} color={C.stone2}>{h}</T>)}
      </View>
    </View>
  );
}

/** One of right now's three flows: solar, the home, the grid. */
function Flow({ icon, label, value, color, dim }: { icon: string; label: string; value: string; color: string; dim?: boolean }) {
  return (
    <View style={{ flex: 1, gap: SP[2], alignItems: 'flex-start' }}>
      <IconWell icon={icon} color={dim ? C.stone2 : color} size={34} fill={!dim} />
      <View style={{ gap: 1 }}>
        <T v="title" size={21} tabular color={dim ? C.stone : C.bone} numberOfLines={1} maxFontSizeMultiplier={1.2}>{value}</T>
        <T v="footnote" weight={600} color={C.stone} numberOfLines={1}>{label}</T>
      </View>
    </View>
  );
}

/** What a device with no meter draws while on: the owner's figure, or Kova's guess. */
function WattsSheet({ d, onClose }: { d: Dev | null; onClose: () => void }) {
  const { act } = useHub();
  const [text, setText] = useState('');
  useEffect(() => { if (d) setText(d.watts != null ? String(d.watts) : ''); }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const p = parseWatts(text);
  const changed = p.ok && p.watts !== (d.watts ?? null);
  const save = async () => {
    if (!p.ok) return false;
    const ok = await act('PATCH', `/api/devices/${encodeURIComponent(d.id)}/settings`, { watts: p.watts }, p.watts == null ? `${d.name}: back to Kova’s figure` : `${d.name}: ${p.watts} W while on`);
    if (ok) onClose();
    return ok;
  };
  return (
    <Sheet open onClose={onClose} label={`${d.name} power`}>
      <SheetHead kicker="What it draws while on" title={d.name} icon={ICON[d.type] ?? 'devices'} color={C.amber} />
      <T v="callout" color={C.stone}>{`${d.name} doesn’t measure its own power, so Kova counts a figure while it’s on. The label on the device or its plug usually says.`}</T>
      <Section title="Watts while on" caption gap={SP[2]}>
        <TextField value={text} onChange={setText} keyboard="number-pad" label="Watts while on" placeholder={d.typicalWatts != null ? `${d.typicalWatts} (Kova’s guess)` : 'e.g. 60'} onSubmit={() => void save()} />
        <T v="footnote" color={p.ok ? C.stone2 : C.redText}>{p.ok ? (d.typicalWatts != null ? `Leave it empty to use Kova’s guess, about ${d.typicalWatts} W.` : 'Leave it empty and it isn’t counted.') : p.why}</T>
      </Section>
      <Button full kind={changed ? 'primary' : 'secondary'} icon="check" label="Save" onPress={changed ? save : undefined} />
      {d.watts != null ? <Button full kind="ghost" label="Use Kova’s figure" onPress={() => act('PATCH', `/api/devices/${encodeURIComponent(d.id)}/settings`, { watts: null }, `${d.name}: back to Kova’s figure`).then(ok => { if (ok) onClose(); return ok; })} /> : null}
    </Sheet>
  );
}

/** Pick a device with no meter, to set what it draws. */
function PickSheet({ open, list, onPick, onClose }: { open: boolean; list: Dev[]; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const shown = list.filter(d => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sheet open={open} onClose={onClose} label="Choose a device">
      <SheetHead kicker="Energy" title="Set what a device draws" />
      <SearchField value={q} onChange={setQ} placeholder="Search devices" />
      <Card style={{ overflow: 'hidden' }}>
        {shown.map((d, i) => <Row key={d.id} first={!i} icon={ICON[d.type] ?? 'devices'} title={d.name} sub={wattsNote(d)} subColor={d.watts != null ? C.amber : C.stone} onPress={() => onPick(d.id)} />)}
        {!shown.length ? <View style={{ padding: SP[4] }}><T v="callout" color={C.stone}>{q ? `Nothing called “${q}”.` : 'Every device measures its own power.'}</T></View> : null}
      </Card>
    </Sheet>
  );
}

/**
 * Energy: solar, the home and the grid right now, today by the hour, today's totals, what's using power now, and
 * the figures Kova counts for devices that don't measure their own.
 */
export function EnergyScreen() {
  const s = useSnap();
  const nav = useNav();
  const all = devs(s);
  const source = s.integrations.find(i => i.id === 'goodwe' || i.id === 'virtual')?.name ?? null;
  const v = energyView(s.energy, s.home.nowHour, source);
  const E = s.energy;
  const [watts, setWatts] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const settable = Object.values(all).filter(d => d.typicalWatts !== undefined || d.watts !== undefined).sort((a, b) => a.name.localeCompare(b.name));
  const own = settable.filter(d => d.watts != null);
  const openWatts = (id: string) => { if (all[id] && (all[id].watts !== undefined || all[id].typicalWatts !== undefined)) setWatts(id); };

  return (
    <Screen title="Energy" over={v.sub} onBack={() => nav.goBack()} gap={SP[6]}>
      {!v.available ? (
        <Empty icon="solar_power" tone={C.amber} title="No energy data yet" text="Connect a solar inverter, a grid meter or plugs that measure power in Integrations, and Kova shows where your power comes from and goes." />
      ) : (
        <>
          <Appear>
            <Card style={{ padding: SP[4], gap: SP[4] }}>
              <T v="eyebrow" color={C.stone2}>Right now</T>
              <View style={{ flexDirection: 'row', gap: SP[3] }}>
                {v.now.hasSolar ? <Flow icon="solar_power" label={v.producing ? 'Solar' : 'Solar · idle'} value={v.now.solar} color={C.amber} dim={!v.producing} /> : null}
                <Flow icon="home" label={E?.estimated ? 'Home · about' : 'Home'} value={v.now.load} color={C.bone} dim={E?.now.load == null} />
                <Flow icon={v.now.gridDir === 'out' ? 'arrow_upward' : v.now.gridDir === 'in' ? 'arrow_downward' : 'electrical_services'} label={v.now.gridLabel} value={v.now.grid} color={v.now.gridDir === 'out' ? C.green : C.blue} dim={!v.now.gridDir} />
              </View>
              <View style={{ flexDirection: 'row', gap: SP[3], paddingTop: SP[3], borderTopWidth: 1, borderTopColor: C.hairline }}>
                <Icon name="tips_and_updates" size={19} color={v.producing ? C.amber : C.stone} fill={v.producing} />
                <T v="callout" color={C.bone2} style={{ flex: 1 }}>{v.insight}</T>
              </View>
            </Card>
          </Appear>

          <Section title="Today">
            <Card style={{ padding: SP[4] }}>
              {v.hasHistory
                ? <DayChart bars={v.bars} max={v.max} hasUse={v.hasUse} nowHour={s.home.nowHour} raw={E?.hours ?? []} />
                : <View style={{ paddingVertical: SP[4], alignItems: 'center', gap: SP[2] }}><Icon name="schedule" size={24} color={C.stone2} /><T v="callout" color={C.stone} center>Kova notes power every minute. Today’s hours fill in as it does.</T></View>}
            </Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] }}>
              {v.stats.map((st, i) => (
                <Appear key={st.id} index={i} style={{ flexBasis: '47%', flexGrow: 1 }}>
                  <Card style={{ padding: SP[3] + 2, gap: SP[1], flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TONE[st.tone] }} />
                      <T v="eyebrow" color={C.stone2}>{st.label}</T>
                    </View>
                    <T v="title" size={21} tabular color={st.tone === 'muted' ? C.stone : C.bone} maxFontSizeMultiplier={1.2}>{st.value}</T>
                    <T v="footnote" color={C.stone} numberOfLines={2}>{st.sub}</T>
                  </Card>
                </Appear>
              ))}
            </View>
          </Section>

          <Section title="Using power now" caption gap={SP[2]}>
            {v.devices.length ? (
              <Card style={{ overflow: 'hidden' }}>
                {v.devices.slice(0, 10).map((d, i) => {
                  const dev = all[d.id];
                  const can = !!dev && (dev.watts !== undefined || dev.typicalWatts !== undefined);
                  const body = (
                    <>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3] }}>
                        <IconWell icon={ICON[dev?.type ?? ''] ?? 'bolt'} color={i === 0 ? C.amber : C.stone} size={32} />
                        <T v="headline" size={14.5} numberOfLines={1} style={{ flex: 1 }}>{d.name}</T>
                        <T v="label" tabular color={d.estimated ? C.stone : C.bone}>{d.value}</T>
                        {can ? <Icon name="chevron_right" size={18} color={C.stone2} /> : null}
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: C.inset, marginLeft: 44, overflow: 'hidden' }}>
                        <View style={{ width: `${Math.max(2, d.share * 100)}%`, height: 6, borderRadius: 3, backgroundColor: i === 0 ? C.amber : alpha(C.bone, d.estimated ? 0.25 : 0.45) }} />
                      </View>
                    </>
                  );
                  const style = { gap: SP[2], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline };
                  return can ? <Press key={d.id} give="soft" label={`${d.name}, ${d.value}. Set what it draws`} onPress={() => openWatts(d.id)} style={style}>{body}</Press> : <View key={d.id} style={style}>{body}</View>;
                })}
              </Card>
            ) : <Empty compact icon="bolt" title="Nothing reports power" text="Plugs that measure energy, or a figure for a device below, fill this in." />}
            <T v="footnote" color={C.stone2} style={{ paddingHorizontal: 4 }}>{v.foot}</T>
          </Section>
        </>
      )}

      {settable.length ? (
        <Section title="Figures for devices without a meter" caption action="Add" onAction={() => setPicking(true)} gap={SP[2]}>
          {own.length ? (
            <Card style={{ overflow: 'hidden' }}>
              {own.map((d, i) => <Row key={d.id} first={!i} icon={ICON[d.type] ?? 'devices'} iconFg={C.amber} title={d.name} sub={wattsNote(d)} onPress={() => setWatts(d.id)} />)}
            </Card>
          ) : <Empty compact icon="electric_meter" title="Kova’s guesses for now" text="Give a TV, heater or lamp its own figure to make the totals closer." action="Add" onAction={() => setPicking(true)} />}
        </Section>
      ) : null}

      <PickSheet open={picking} list={settable} onClose={() => setPicking(false)} onPick={id => { setPicking(false); setTimeout(() => setWatts(id), 320); }} />
      <WattsSheet d={watts ? all[watts] ?? null : null} onClose={() => setWatts(null)} />
    </Screen>
  );
}
