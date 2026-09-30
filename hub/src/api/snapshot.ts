import type { Hub } from '../hub.ts';
import type { Device, Mode, Targets } from '../model/types.ts';
import type { LogEntry } from '../store/db.ts';
import { clock, localDate, localHour, atLocal } from '../util/time.ts';
import { isLight, targetLabel } from '../util/describe.ts';
import { rhythmLabel } from '../rhythms/rhythms.ts';

const FEED_ICON: Record<string, string> = { mode: 'routine', run: 'bolt', presence: 'person_pin_circle', state: 'lightbulb', system: 'info', skip: 'event_busy' };

function feedIcon(e: LogEntry): string {
  if (e.kind === 'device_event') return e.data.type === 'ring' ? 'doorbell' : 'person';
  if (e.kind === 'presence') return e.data.home ? 'person_pin_circle' : 'directions_walk';
  if (e.kind === 'run' && e.cause.kind === 'overlay') return 'layers';
  return FEED_ICON[e.kind] ?? 'bolt';
}

/** "Lounge: Lamp 78% · 3000K", with a room's lights collapsed when they're all switched off. */
function chipsByRoom(targets: Targets, devices: Map<string, Device>, roomName: (id: string) => string) {
  const byRoom = new Map<string, { chips: string[]; offLights: number }>();
  for (const [id, t] of Object.entries(targets)) {
    const d = devices.get(id);
    if (!d) continue;
    const g = byRoom.get(d.room) ?? { chips: [], offLights: 0 };
    if (isLight(d) && t.on === false) g.offLights++;
    g.chips.push(targetLabel(d, t));
    byRoom.set(d.room, g);
  }
  return [...byRoom].map(([room, g]) => {
    const lightsInRoom = [...devices.values()].filter(d => d.room === room && isLight(d)).length;
    const chips = g.offLights > 1 && g.offLights === lightsInRoom
      ? ['All lights off', ...g.chips.filter(c => !c.endsWith(' off'))]
      : g.chips;
    return { room: roomName(room), chips };
  });
}

export function snapshot(hub: Hub) {
  const { engine, reg, config, checker, store } = hub;
  const cfg = config.get();
  const tz = cfg.timezone;
  const now = engine.now();
  const today = localDate(now, tz);
  const devices = reg.devices;
  const roomName = (id: string) => cfg.rooms.find(r => r.id === id)?.name ?? id;
  const mn = engine.planner.modeAt(now);
  const findings = checker.findings();

  const modes = cfg.modes.map((m: Mode, i) => {
    const next = cfg.modes[(i + 1) % cfg.modes.length];
    const kd = engine.planner.kovaDayAt(now);
    const entry = kd.modes.find(x => x.mode.id === m.id);
    // What's still on from earlier modes when this one starts.
    let inherit: string[] = [];
    if (entry) {
      const st = engine.preview(entry.at + 60_000);
      inherit = reg.list().filter(d => isLight(d) && st[d.id]?.on && !m.targets[d.id])
        .map(d => d.type === 'dimmer' && st[d.id].bri != null && st[d.id].bri! < 100 ? `${d.name} ${st[d.id].bri}%` : `${roomName(d.room)} ${d.name.toLowerCase()}`);
    }
    const moments = kd.items.filter(x => x.kind === 'moment' && x.modeId === m.id).map(x => ({ t: clock(x.at, tz), text: `${x.label} · ${x.what}` }));
    return {
      id: m.id, name: m.name, color: m.color, icon: m.icon,
      startLabel: rhythmLabel(m.start), endLabel: rhythmLabel(next.start), nextId: next.id,
      start: entry ? localHour(entry.at, tz) : null,
      onlyWhenSomeoneHome: !!m.onlyWhenSomeoneHome, lightTheWay: !!m.lightTheWay,
      groups: chipsByRoom(m.targets, devices, roomName), inherit, moments,
      test: checker.test(m.id),
    };
  });

  // Today's plan, with each item's skip state; "coming up" can run past midnight.
  const dayStart = atLocal(today, 0, tz);
  const items = engine.planner.itemsBetween(dayStart - 1, dayStart + 24 * 3600_000).map(x => ({
    id: x.id, kind: x.kind, hour: localHour(x.at, tz), t: clock(x.at, tz), label: x.label, what: x.what,
    modeId: x.modeId ?? null, past: x.at <= now, skipped: engine.skips.has(x.id),
  }));
  const upcoming = engine.planner.itemsBetween(now, now + 24 * 3600_000).slice(0, 3).map(x => ({
    id: x.id, t: clock(x.at, tz), label: x.label, what: x.what, modeId: x.modeId ?? null, skipped: engine.skips.has(x.id),
  }));
  // Things that happened today that weren't in the plan: arrivals, people seen, overlays.
  const marks = store.between(dayStart, now + 1).filter(e => e.kind === 'presence' || (e.kind === 'run' && (e.cause.kind === 'behaviour' || e.cause.kind === 'overlay')))
    .slice(-6).map(e => ({ hour: localHour(e.ts, tz), label: e.kind === 'presence' ? e.what.replace(' arrived home', ' home').replace(' left home', ' left') : e.cause.kind === 'behaviour' ? 'Light the way' : e.cause.label }));

  const feed = store.feed(80);
  const activity = feed.map(e => ({
    id: e.id, ts: e.ts, t: localDate(e.ts, tz) === today ? clock(e.ts, tz) : `${new Date(e.ts).toLocaleDateString('en-AU', { weekday: 'short', timeZone: tz })} ${clock(e.ts, tz)}`,
    type: e.feed!, icon: feedIcon(e), what: e.what,
    why: [e.cause.label, e.cause.detail].filter(Boolean).join(' · '),
  }));

  const ov = engine.overlay && cfg.overlays.find(o => o.id === engine.overlay!.id);
  return {
    home: {
      name: cfg.name, timezone: tz, now, nowHour: localHour(now, tz), date: today,
      dateLabel: new Date(now).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }),
      clock: clock(now, tz),
    },
    rooms: cfg.rooms,
    groups: cfg.groups,
    people: cfg.people.map(p => ({ ...p, home: engine.people[p.id]?.home ?? true, since: engine.people[p.id]?.since ?? null, sinceLabel: engine.people[p.id] ? clock(engine.people[p.id].since, tz) : '' })),
    devices: reg.list().map(d => ({ ...d, why: engine.why(d.id), usedIn: engine.usedIn(d.id) })),
    modes,
    current: {
      modeId: mn.mode.id, since: mn.since, until: mn.until, untilLabel: clock(mn.until, tz), nextId: mn.next.id,
      waitingForSomeone: engine.pendingEntry === mn.mode.id,
      overlay: ov ? { id: ov.id, name: ov.name, icon: ov.icon, endsLabel: ov.endsLabel } : null,
    },
    day: { bands: engine.planner.bands(today), items, marks },
    upcoming,
    lightTheWay: cfg.lightTheWay.triggers.map(t => ({ id: t.id, label: t.label, minutes: t.minutes, lights: t.lights })),
    overlays: cfg.overlays.map(o => ({ id: o.id, name: o.name, icon: o.icon, endsLabel: o.endsLabel })),
    sources: cfg.sources,
    findings,
    activity,
    integrations: [
      ...[...reg.adapters.values()].map(a => ({ id: a.id, name: a.name, icon: a.icon, kind: a.kind, ...a.status(), devices: reg.list().filter(d => d.adapter === a.id).length })),
      ...hub.services.map(x => ({ id: x.id, name: x.name, icon: x.icon, kind: x.kind, ...x.status(), devices: x.devices ?? 0 })),
    ],
    weather: hub.weather?.current ?? null,
    demo: hub.demo,
  };
}

export type Snapshot = ReturnType<typeof snapshot>;
