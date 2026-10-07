// The home at a glance, as cards: outside, inside, the air. And how loud each alert is.
import type { Glance, Insight } from '../api/types';
import type { Waqt } from './prayer.ts';

/** A card: a short value (a number or a word, so it fits a third of a phone), a line naming it, and the detail. */
export interface GlanceCard { key: string; icon: string; color: string; label: string; value: string; caption: string; sub: string; device?: string }

const AIR_COLOR: Record<number, string> = { 1: '#7fd4a0', 2: '#dcd27e', 3: '#f2b14c', 4: '#ff6b5e' };

export function glanceCards(g: Glance | undefined): GlanceCard[] {
  if (!g) return [];
  const out: GlanceCard[] = [];
  const o = g.outside;
  if (o) {
    out.push({
      key: 'outside', icon: o.icon, color: '#f2b14c', label: 'Outside', value: `${o.temp}°`, caption: o.text,
      sub: [o.high != null && o.low != null ? `${o.high}° / ${o.low}° today` : '', o.rain ?? '', !o.rain && o.uvMax != null && o.uvMax >= 6 ? `UV ${Math.round(o.uvMax)} at midday` : '', o.wind != null && o.wind >= 30 ? `windy, ${o.wind} km/h` : ''].filter(Boolean).join(' · '),
    });
  }
  if (g.inside.length) {
    const ts = g.inside.map(x => x.temp);
    out.push({
      key: 'inside', icon: 'thermostat', color: '#7cb8f0', label: 'Inside', device: g.inside[0].device,
      value: ts.length === 1 ? `${ts[0]}°` : Math.round(Math.min(...ts)) === Math.round(Math.max(...ts)) ? `${Math.round(Math.min(...ts))}°` : `${Math.round(Math.min(...ts))}–${Math.round(Math.max(...ts))}°`, caption: g.inside.length === 1 ? g.inside[0].name : `${g.inside.length} rooms`, sub: g.inside.map(x => `${x.name} ${x.temp}°${x.humidity != null ? ` ${x.humidity}%` : ''}`).join(' · '),
    });
  }
  if (g.air.length) {
    const worst = g.air[0];
    out.push({
      key: 'air', icon: 'air', color: AIR_COLOR[worst.level] ?? '#a3a09a', label: 'Air', value: worst.label, caption: worst.name, device: worst.device,
      sub: g.air.slice(1).map(a => `${a.name}: ${a.label.toLowerCase()}`).join(' · '),
    });
  }
  return out;
}

/** The waqt as a glance card: the prayer now, the next with its countdown, and its time. Opens Prayer times. */
export function waqtCard(w: Waqt | null): GlanceCard | null {
  if (!w) return null;
  // The caption stays short enough for a third of a small phone; the countdown is the line that may wrap.
  return { key: 'waqt', icon: 'mosque', color: w.soon ? '#f2b14c' : '#7fd4a0', label: 'Prayer', value: w.current, caption: `${w.next} ${w.at}`, sub: w.left.charAt(0).toUpperCase() + w.left.slice(1) };
}

/** An alert's colour, by how urgent it is. */
export const insightColor = (level: Insight['level']) => level === 'alert' ? '#ff6b5e' : level === 'warning' ? '#f2b14c' : '#7cb8f0';

/** How many glance cards to a row: three when a third of the phone fits one (a 375 pt phone at the usual text size), else two. */
export function glanceColumns(width: number, fontScale: number, cards: number): number {
  if (cards <= 1) return 1;
  const fit = (width - 36 + 8) / (104 * Math.max(1, fontScale) + 8);
  return Math.max(1, Math.min(cards, fit >= 3 ? 3 : 2));
}

export type AlertAction = 'open' | 'later' | 'expected';

/** What an alert offers: Open (when it's about a device), Not now (a day), That's expected (while it stays so). */
export const alertActions = (i: Pick<Insight, 'device'>): AlertAction[] => i.device ? ['open', 'later', 'expected'] : ['later', 'expected'];

/**
 * The alerts Now shows in full: the first two (they come most urgent first), or all of them once asked; the rest
 * fold into one line. A third is shown rather than a line saying "1 more".
 */
export function shownAlerts<X>(list: X[], all: boolean, max = 2): { shown: X[]; more: number } {
  if (all || list.length <= max + 1) return { shown: list, more: 0 };
  return { shown: list.slice(0, max), more: list.length - max };
}
