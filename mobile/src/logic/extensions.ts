// What the widgets and the lock-screen Live Activity show, worked out from the hub's snapshot.
// Plain TypeScript, so it runs under Node in the tests.
import type { Snapshot } from '../api/types';
import { devs, favourites, isLight, stateOf } from './devices.ts';

/** The home right now, for the Live Activity (times in epoch ms). */
export interface HomeState {
  mode: string;
  modeColor: string;
  modeIcon: string;
  lightsOn: number;
  since: number;
  nextAt: number | null;
  nextLabel: string | null;
  nextWhat: string | null;
  nextId: string | null;
  overlay: string | null;
}

export function homeState(s: Snapshot): HomeState {
  const mode = s.modes.find(m => m.id === s.current.modeId);
  const next = s.modes.find(m => m.id === s.current.nextId);
  // The next planned change (a mode or a moment), with its plan id for Skip; the bar runs to the next mode.
  const nextItem = s.upcoming.find(u => !u.skipped);
  return {
    mode: mode?.name ?? '',
    modeColor: mode?.color ?? '#f2b14c',
    modeIcon: mode?.icon ?? 'home',
    lightsOn: s.devices.filter(d => isLight(d) && d.state.on).length,
    since: s.current.since ?? s.home.now,
    nextAt: s.current.until ?? null,
    nextLabel: nextItem ? `${nextItem.t} ${nextItem.label}` : next ? `${s.current.untilLabel} ${next.name}` : null,
    nextWhat: nextItem?.what ?? null,
    nextId: nextItem?.id ?? null,
    overlay: s.current.overlay?.name ?? null,
  };
}

/** A stable key: the Live Activity only needs an update when this changes. */
export const homeStateKey = (h: HomeState) => JSON.stringify({ ...h, since: 0 });

/** The slice of the snapshot the iOS widgets read (they decode only these fields). */
export function widgetSnapshot(s: Snapshot) {
  return {
    home: { name: s.home.name, clock: s.home.clock },
    current: s.current,
    modes: s.modes.map(m => ({ id: m.id, name: m.name, color: m.color, icon: m.icon })),
    devices: s.devices.map(d => ({ id: d.id, name: d.name, room: d.room, type: d.type, capabilities: d.capabilities, hidden: d.hidden, state: { on: d.state.on, bri: d.state.bri, media: d.state.media, paused: d.state.paused, online: d.state.online } })),
    favourites: s.favourites,
    upcoming: s.upcoming,
    overlays: s.overlays.map(o => ({ id: o.id, name: o.name, icon: o.icon, endsLabel: o.endsLabel })),
  };
}

/** The Android widget: the mode and up to four favourites with their state. */
export function widgetModel(s: Snapshot) {
  const all = devs(s);
  const mode = s.modes.find(m => m.id === s.current.modeId);
  return {
    home: s.home.name,
    mode: mode?.name ?? '',
    modeColor: (mode?.color ?? '#f2b14c') as `#${string}`,
    lightsOn: s.devices.filter(d => isLight(d) && d.state.on).length,
    favourites: favourites(s, all).slice(0, 4).map(d => {
      const [label, color] = stateOf(d);
      return { id: d.id, name: d.name, type: d.type, on: !!d.on, label, color: color as `#${string}` };
    }),
  };
}
