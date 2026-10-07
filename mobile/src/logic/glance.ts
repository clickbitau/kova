// The home at a glance, as cards: outside, inside, the air. And how loud each alert is.
import type { Glance, Insight } from '../api/types';

export interface GlanceCard { key: string; icon: string; color: string; label: string; value: string; sub: string; device?: string }

const AIR_COLOR: Record<number, string> = { 1: '#7fd4a0', 2: '#dcd27e', 3: '#f2b14c', 4: '#ff6b5e' };

export function glanceCards(g: Glance | undefined): GlanceCard[] {
  if (!g) return [];
  const out: GlanceCard[] = [];
  const o = g.outside;
  if (o) {
    out.push({
      key: 'outside', icon: o.icon, color: '#f2b14c', label: 'Outside', value: `${o.temp}° ${o.text.toLowerCase()}`,
      sub: [o.high != null && o.low != null ? `${o.high}° / ${o.low}° today` : '', o.rain ?? '', !o.rain && o.uvMax != null && o.uvMax >= 6 ? `UV ${Math.round(o.uvMax)} at midday` : '', o.wind != null && o.wind >= 30 ? `windy, ${o.wind} km/h` : ''].filter(Boolean).join(' · '),
    });
  }
  if (g.inside.length) {
    const ts = g.inside.map(x => x.temp);
    out.push({
      key: 'inside', icon: 'thermostat', color: '#7cb8f0', label: 'Inside', device: g.inside[0].device,
      value: ts.length === 1 ? `${ts[0]}°` : `${Math.min(...ts)}–${Math.max(...ts)}°`, sub: g.inside.map(x => `${x.name} ${x.temp}°${x.humidity != null ? ` ${x.humidity}%` : ''}`).join(' · '),
    });
  }
  if (g.air.length) {
    const worst = g.air[0];
    out.push({
      key: 'air', icon: 'air', color: AIR_COLOR[worst.level] ?? '#a3a09a', label: 'Air', value: worst.label, device: worst.device,
      sub: g.air.length > 1 ? g.air.map(a => `${a.name}: ${a.label.toLowerCase()}`).join(' · ') : worst.name,
    });
  }
  return out;
}

/** An alert's colour, by how urgent it is. */
export const insightColor = (level: Insight['level']) => level === 'alert' ? '#ff6b5e' : level === 'warning' ? '#f2b14c' : '#7cb8f0';
