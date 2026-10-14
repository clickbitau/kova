import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Polygon, Text as SvgText } from 'react-native-svg';
import { C, F, alpha } from '../theme';
import type { FloorPlan } from '../api/types';
import { iconOf, isLight, type Dev } from '../logic/devices';
import { Press } from '../ui/kit';
import { Icon } from '../ui/Icon';

/** How a device's dot looks on the plan: lit lights amber, playing media blue, cameras and sensors green, the rest plain. */
export function dotTone(d: Pick<Dev, 'type' | 'on'>): { bg: string; fg: string; edge: string } {
  if (d.on && (isLight(d as Dev) || d.type === 'plug')) return { bg: C.amber, fg: C.onAmber, edge: C.amber };
  if (d.on && (d.type === 'media' || d.type === 'tv' || d.type === 'climate')) return { bg: alpha(C.blue, 0.2), fg: C.blue, edge: C.blueLine };
  if (d.type === 'camera' || d.type === 'sensor') return { bg: alpha(C.green, 0.16), fg: C.green, edge: C.greenLine };
  return { bg: C.control, fg: C.stone, edge: C.line };
}

/**
 * Devices → Floor plan: the home's rooms as drawn in Settings (on the web), each device at its spot. Tapping a device
 * opens it; tapping a room shows that room's devices in the list.
 */
export function FloorPlanView({ plan, devices, onDevice, onRoom }: { plan: FloorPlan; devices: Dev[]; onDevice: (id: string) => void; onRoom: (room: string) => void }) {
  const [w, setW] = useState(0);
  const k = w ? w / plan.widthM : 0;
  const h = plan.heightM * k;
  const f = Math.max(plan.widthM, plan.heightM) / 45;
  const lit = new Set(devices.filter(d => isLight(d) && d.on).map(d => d.room));
  const dot = Math.max(18, Math.min(30, k * 0.7));
  const shown = devices.filter(d => plan.spots[d.id]);
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} accessibilityLabel={`Floor plan: ${shown.length} devices`} style={{ width: '100%' }}>
      {k ? (
        <View style={{ width: w, height: h }}>
          <Svg width={w} height={h} viewBox={`0 0 ${plan.widthM} ${plan.heightM}`}>
            {plan.rooms.map(r => (
                <Polygon key={r.id} points={r.points.map(p => p.join(',')).join(' ')} onPress={r.room ? () => onRoom(r.room!) : undefined}
                  fill={r.outdoor ? alpha(C.bone, 0.03) : r.room && lit.has(r.room) ? alpha(C.amber, 0.17) : C.card}
                  stroke={C.bone} strokeOpacity={0.5} strokeWidth={1.5 / k} strokeDasharray={r.outdoor ? `${6 / k} ${4 / k}` : undefined} />
            ))}
            {plan.rooms.map(r => {
              const xs = r.points.map(p => p[0]), ys = r.points.map(p => p[1]);
              return <SvgText key={`t${r.id}`} x={Math.min(...xs) + f * 0.5} y={Math.min(...ys) + f * 1.3} fontSize={f} fontFamily={F[700]} fill={C.bone} opacity={0.75}>{r.name}</SvgText>;
            })}
          </Svg>
          {shown.map(d => {
            const at = plan.spots[d.id]!, t = dotTone(d);
            return (
              <Press key={d.id} label={d.name} onPress={() => onDevice(d.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                style={{ position: 'absolute', left: at.x * k - dot / 2, top: at.y * k - dot / 2, width: dot, height: dot, borderRadius: dot / 2, backgroundColor: t.bg, borderWidth: 1.5, borderColor: t.edge, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={iconOf(d)} size={dot * 0.58} color={t.fg} fill />
              </Press>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
