// In a sensor's or camera's panel: its readings with trends and today's chart; where it looks; when it alerts.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { C, SP, alpha } from '../theme';
import { useHub } from '../state/hub';
import type { SensorView } from '../api/types';
import { alertRows, sparkPath, TREND } from '../logic/sensors';
import type { Dev } from '../logic/devices';
import { Icon } from '../ui/Icon';
import { Card, ExpandRow, Group, Section, Segmented } from '../ui/kit';
import { T } from '../ui/Text';

/** A sensor's readings, which way each is heading and since when, and the main one's day as a chart. */
export function SensorReadings({ v }: { v: SensorView }) {
  const { api } = useHub();
  const f = v.readings.find(r => typeof r.value === 'number' && r.field !== 'battery');
  const [pts, setPts] = useState<[number, number][]>([]);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!f) return;
    let live = true;
    api<{ points: { t: number; v: number }[] }>('GET', `/api/sensors/${encodeURIComponent(v.id)}/history/${f.field}`).then(r => { if (live) setPts(r.points.map(p => [p.t, p.v])); }).catch(() => {});
    return () => { live = false; };
  }, [api, v.id, f?.field]);
  const sp = w ? sparkPath(pts, w, 84) : null;
  return (
    <View style={{ gap: SP[3] }}>
      <Card style={{ overflow: 'hidden' }}>
        {v.readings.map((r, i) => {
          const tr = r.trend ? TREND[r.trend] : null;
          return (
            <View key={r.field} accessible accessibilityLabel={`${r.label} ${r.text}${tr ? `, ${tr[2].toLowerCase()}` : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: SP[3], paddingVertical: SP[3], paddingHorizontal: SP[4], borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline }}>
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <T v="callout" color={C.bone2}>{r.label}</T>
                {r.changedLabel ? <T v="footnote" color={C.stone2}>{`Since ${r.changedLabel}`}</T> : null}
              </View>
              <T v="headline" tabular>{r.text}</T>
              <View style={{ width: 20 }}>{tr ? <Icon name={tr[0]} size={18} color={tr[1]} /> : null}</View>
            </View>
          );
        })}
      </Card>
      {f && pts.length > 1 ? (
        <Card style={{ padding: SP[4], gap: SP[2] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T v="footnote" color={C.stone}>{`${f.label}, today`}</T>
            {sp ? <T v="footnote" color={C.stone} tabular>{`${sp.min} – ${sp.max}${f.unit === '°C' ? '°' : ` ${f.unit}`}`}</T> : null}
          </View>
          <View style={{ height: 84 }} onLayout={e => setW(e.nativeEvent.layout.width)}>
            {sp ? (
              <Svg width={w} height={84}>
                <Path d={sp.area} fill={alpha(C.blue, 0.14)} />
                <Path d={sp.line} stroke={C.blue} strokeWidth={2} fill="none" strokeLinejoin="round" />
              </Svg>
            ) : null}
          </View>
        </Card>
      ) : null}
      <T v="footnote" color={C.stone2}>{`${v.integration}. A sensor only reports: use it in automations — a reading, or something happening in its room.`}</T>
    </View>
  );
}

const WHEN = [{ id: '', label: 'Default' }, { id: 'always', label: 'Always' }, { id: 'away', label: 'Away' }, { id: 'never', label: 'Never' }];

/** Where a camera or sensor looks (from its room, inside, outside), and when each kind of event alerts phones. */
export function WatchSettings({ D }: { D: Dev }) {
  const { snap, act } = useHub();
  const sec = snap?.security;
  const s = sec?.devices[D.id];
  const [open, setOpen] = useState<string | null>(null);
  if (!s) return null;
  const settings = (body: object, done: string) => act('PATCH', `/api/devices/${encodeURIComponent(D.id)}/settings`, body, done);
  const rows = alertRows(D, sec);
  const place = s.outdoorSet ? (s.outdoor ? 'out' : 'in') : 'auto';
  return (
    <View style={{ gap: SP[4] }}>
      <Section title="Where it looks" caption gap={SP[2]}>
        <Segmented compact label="Where it looks" value={place} options={[{ id: 'auto', label: s.outdoorSet ? 'Automatic' : `Auto (${s.outdoor ? 'out' : 'in'})` }, { id: 'in', label: 'Inside' }, { id: 'out', label: 'Outside' }]}
          onChange={id => void settings({ outdoor: id === 'auto' ? null : id === 'out' }, id === 'auto' ? 'Inside or out: from its room' : `Looks ${id === 'out' ? 'outside' : 'inside'}`)} />
        <T v="footnote" color={C.stone2}>{s.outdoor ? 'Outside: someone seen here alerts any time; motion here never does, unless you choose it.' : 'Inside: people and motion here alert only while nobody’s home.'}</T>
      </Section>
      {rows.length ? (
        <Section title="Alerts to phones" caption gap={SP[2]}>
          <Group>
            {rows.map((r, i) => (
              <ExpandRow key={r.kind} first={i === 0} icon={r.icon} title={r.label} sub={r.value ? `${WHEN.find(w => w.id === r.value)?.label}, set for this one` : r.note} open={open === r.kind} onToggle={() => setOpen(open === r.kind ? null : r.kind)}>
                <Segmented compact label={`${r.label} alerts`} value={r.value} options={WHEN} onChange={id => void settings({ alerts: { [r.kind]: id || null } }, id ? `${r.label}: ${id === 'away' ? 'while nobody’s home' : id}` : `${r.label}: back to the default`)} />
              </ExpandRow>
            ))}
          </Group>
          <T v="footnote" color={C.stone2}>Quiet hours and each room’s choices are on Security.</T>
        </Section>
      ) : null}
    </View>
  );
}
