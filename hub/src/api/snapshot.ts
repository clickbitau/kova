import type { Hub } from '../hub.ts';
import type { Device, Mode, Targets } from '../model/types.ts';
import type { LogEntry } from '../store/db.ts';
import { clock, localDate, localHour, atLocal, localStamp, stampWords } from '../util/time.ts';
import { isLight, pseudoLabel, targetLabel } from '../util/describe.ts';
import { rhythmLabel } from '../rhythms/rhythms.ts';
import { automationIdeas } from '../engine/automation-ideas.ts';
import { combineIdeas, combinedDeviceId } from '../adapters/combined.ts';
import { AUTOMATION_EVENTS, actionWords, condWords, isOneTime, nextRun, triggerWords } from '../engine/automations.ts';
import { wattsSetting } from '../services/energy.ts';
import SunCalc from 'suncalc';
import { alertsFor, isCamera, isOutdoor, kindOf, isSensor } from '../util/sensors.ts';
import { roomClimate, sensorViews } from '../services/sensors.ts';
import { roomOutdoor } from '../util/sensors.ts';
import { engineInfo, loadSettings } from '../assistant/ai.ts';
import { hasZones, suggestZoneRooms, zoneCommandWords, type ZoneCommand } from '../util/zones.ts';
import { SEASON_LABEL } from '../engine/room-climate.ts';

const FEED_ICON: Record<string, string> = { mode: 'routine', run: 'bolt', presence: 'person_pin_circle', state: 'lightbulb', system: 'info', skip: 'event_busy' };

/** Activity icons for device events (cameras, doorbells, players). */
const DEVICE_EVENT_ICON: Record<string, string> = { ring: 'doorbell', person: 'person', motion: 'sensors', vehicle: 'directions_car', animal: 'pets', package: 'package_2', sound: 'graphic_eq' };

/** Camera and sensor events as the timelines show them, each with its picture's address when one was kept. */
export function timelineRows(hub: Hub, events: import('../engine/rooms.ts').RoomEvent[]) {
  const cfg = hub.config.get(), tz = cfg.timezone, today = localDate(hub.engine.now(), tz);
  return events.map(e => ({
    id: e.id, at: e.at, t: localDate(e.at, tz) === today ? clock(e.at, tz) : `${new Date(e.at).toLocaleDateString('en-AU', { weekday: 'short', timeZone: tz })} ${clock(e.at, tz)}`,
    room: e.room, roomName: cfg.rooms.find(r => r.id === e.room)?.name ?? null, device: e.device, kind: e.kind, source: e.source, outdoor: e.outdoor, what: e.what,
    icon: e.kind === 'opened' || e.kind === 'closed' ? 'sensor_door' : DEVICE_EVENT_ICON[e.kind] ?? 'videocam',
    frame: hub.security.hasFrame(e.device, e.id) ? `/api/frames/${encodeURIComponent(e.device)}/${e.id}` : null,
  }));
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/** Which physical device (MAC) a registry device sits on, via the router's device table. */
function netOf(reg: Hub['reg']) {
  const warden = reg.adapters.get('warden') as { byIp?: Map<string, { mac: string; name?: string }> } | undefined;
  if (!warden?.byIp?.size) return undefined;
  const byIp = warden.byIp;
  return (d: Device) => {
    const ip = IPV4.exec(d.address ?? '')?.[0] ?? IPV4.exec(d.name)?.[0];
    return ip ? byIp.get(ip) : undefined;
  };
}

function feedIcon(e: LogEntry): string {
  if (e.kind === 'device_event') return /^power-supply-/.test(String(e.data.type)) ? 'power' : DEVICE_EVENT_ICON[String(e.data.type)] ?? 'person';
  if (e.kind === 'state' && e.data && typeof (e.data.patch as { open?: unknown } | undefined)?.open === 'boolean') return 'sensor_door';
  if (e.kind === 'presence') return e.data.home ? 'person_pin_circle' : 'directions_walk';
  if (e.kind === 'run' && e.cause.kind === 'overlay') return 'layers';
  if (e.kind === 'system' && 'backup' in e.data) return 'backup';
  return FEED_ICON[e.kind] ?? 'bolt';
}

/** "Lounge: Lamp 78% · 3000K", with a room's lights collapsed when they're all switched off. */
function chipsByRoom(targets: Targets, devices: Map<string, Device>, roomName: (id: string) => string) {
  const byRoom = new Map<string, { chips: string[]; offLights: number }>();
  for (const [id, t] of Object.entries(targets)) {
    const d = devices.get(id);
    // A room's air conditioner zone shows with the room: "Zone open 50%, AC cool 23°".
    const zm = !d && /^zone:(.+)$/.exec(id);
    if (zm) { const g = byRoom.get(zm[1]) ?? { chips: [], offLights: 0 }; g.chips.push(`Zone ${zoneCommandWords(t as unknown as ZoneCommand)}`); byRoom.set(zm[1], g); continue; }
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
  // Devices in none of the home's rooms ("unassigned", or a room that's gone) are in "No room".
  const roomName = (id: string) => cfg.rooms.find(r => r.id === id)?.name ?? 'No room';
  const inRoom = (id: string) => cfg.rooms.some(r => r.id === id);
  const mn = engine.planner.modeAt(now);
  /** Editable target rows: which device, what it's set to, and the chip text. */
  const targetList = (t: Targets) => Object.entries(t).map(([id, cmd]) => {
    const d = devices.get(id);
    // A room's air conditioner zone ("zone:lounge").
    if (!d && id.startsWith('zone:')) { const rn = cfg.rooms.find(r => r.id === id.slice(5))?.name; return { deviceId: id, name: `${rn ?? id.slice(5)} zone`, label: pseudoLabel(id, cfg.rooms, cmd) ?? id, target: cmd, missing: !rn }; }
    return { deviceId: id, name: d ? (inRoom(d.room) ? `${roomName(d.room)} ${d.name.toLowerCase()}` : d.name) : `${id} (missing)`, label: d ? targetLabel(d, cmd) : 'Device not found', target: cmd, missing: !d };
  });
  const findings = checker.findings();
  // Each part of an automation in words, for lists and the editor's summary.
  const words = { reg, cfg, now };
  const tgt = (id: string, cmd: object) => { const d = reg.get(id); return d ? targetLabel(d, cmd) : pseudoLabel(id, cfg.rooms, cmd) ?? id; };
  const autoWords = (a: Pick<import('../model/types.ts').Automation, 'triggers' | 'conditions' | 'actions'>) => ({
    triggerLabels: a.triggers.map(t => triggerWords(t, words)),
    conditionLabels: a.conditions.map(c => condWords(c, words)),
    actionLabels: a.actions.map(x => actionWords(x, words, tgt)),
  });
  const runSummary = (r?: import('../model/types.ts').AutomationRun) => r ? { at: r.at, atLabel: clock(r.at, cfg.timezone), result: r.result, why: r.why, detail: r.detail ?? null } : null;

  const modes = cfg.modes.map((m: Mode, i) => {
    const next = cfg.modes[(i + 1) % cfg.modes.length];
    const kd = engine.planner.kovaDayAt(now);
    const entry = kd.modes.find(x => x.mode.id === m.id);
    // What's still on from earlier modes when this one starts.
    let inherit: string[] = [];
    if (entry) {
      const st = engine.preview(entry.at + 60_000);
      inherit = reg.list().filter(d => isLight(d) && st[d.id]?.on && !m.targets[d.id])
        .map(d => d.type === 'dimmer' && st[d.id].bri != null && st[d.id].bri! < 100 ? `${d.name} ${st[d.id].bri}%` : inRoom(d.room) ? `${roomName(d.room)} ${d.name.toLowerCase()}` : d.name);
    }
    const moments = kd.items.filter(x => x.kind === 'moment' && x.modeId === m.id).map(x => ({ id: x.refId, t: clock(x.at, tz), text: `${x.label} · ${x.what}` }));
    return {
      id: m.id, name: m.name, color: m.color, icon: m.icon,
      startLabel: rhythmLabel(m.start), endLabel: rhythmLabel(next.start), nextId: next.id,
      start: entry ? localHour(entry.at, tz) : null,
      onlyWhenSomeoneHome: !!m.onlyWhenSomeoneHome, lightTheWay: !!m.lightTheWay,
      groups: chipsByRoom(m.targets, devices, roomName), inherit, moments,
      rhythm: m.start, targets: targetList(m.targets),
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
  const marks = [...store.between(dayStart, now + 1, 'presence'), ...store.between(dayStart, now + 1, 'run').filter(e => e.cause.kind === 'behaviour' || e.cause.kind === 'overlay')]
    .sort((a, b) => a.ts - b.ts || a.id - b.id)
    .slice(-6).map(e => ({ hour: localHour(e.ts, tz), label: e.kind === 'presence' ? e.what.replace(' arrived home', ' home').replace(' left home', ' left') : e.cause.kind === 'behaviour' ? 'Light the way' : e.cause.label }));

  const feed = store.feed(80);
  const activity = feed.map(e => ({
    id: e.id, ts: e.ts, t: localDate(e.ts, tz) === today ? clock(e.ts, tz) : `${new Date(e.ts).toLocaleDateString('en-AU', { weekday: 'short', timeZone: tz })} ${clock(e.ts, tz)}`,
    type: e.feed!, icon: feedIcon(e), what: e.what, device: e.device,
    why: [e.cause.label, e.cause.detail].filter(Boolean).join(' · '),
  }));

  const ov = engine.overlay && cfg.overlays.find(o => o.id === engine.overlay!.id);
  return {
    home: {
      name: cfg.name, timezone: tz, now, nowHour: localHour(now, tz), date: today,
      // en-AU writes September as "Sept"; the design (and every other month) uses three letters.
      dateLabel: new Date(now).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz }).replace(/\bSept\b/, 'Sep'),
      clock: clock(now, tz),
      // Where the home is, for the phone app's arriving and leaving (it watches a circle around this).
      location: cfg.location ? { latitude: cfg.location.latitude, longitude: cfg.location.longitude, ...(cfg.location.radiusM !== undefined ? { radiusM: cfg.location.radiusM } : {}), ...(cfg.location.source ? { source: cfg.location.source } : {}), ...(cfg.location.updatedAt !== undefined ? { updatedAt: cfg.location.updatedAt } : {}), ...(cfg.location.provider ? { provider: cfg.location.provider } : {}) } : { latitude: cfg.latitude, longitude: cfg.longitude },
      // Whether address search goes through Google (suggestions as text; Google's points on Google's map only).
      maps: { google: hub.maps.google },
      // For Settings: how prayer times are worked out, and whether the doorbell pauses what's playing.
      prayerMethod: cfg.prayerMethod ?? 'MuslimWorldLeague', pauseForDoorbell: cfg.pauseForDoorbell !== false, address: cfg.address ?? null,
      // Today's sunrise and sunset as local hours, for day strips.
      sun: (() => { const t = SunCalc.getTimes(new Date(now), cfg.latitude, cfg.longitude); const h = (d: Date) => (isNaN(+d) ? null : localHour(+d, tz)); return { rise: h(t.sunrise), set: h(t.sunset) }; })(),
    },
    rooms: cfg.rooms,
    // Each room's temperature, humidity and light (sensors first), and what's been happening there.
    roomStatus: roomClimate(reg.list(), cfg, engine.rooms),
    // Sensors: they only report. Their readings with units, trends, last changed and reported, battery, offline.
    sensors: sensorViews(reg.list(), cfg, hub.sensors),
    // Cameras and sensors: inside or out, when each kind of event alerts; quiet hours and per-room choices; the latest events.
    security: {
      ...hub.security.settings(), quietNow: hub.security.quietNow(),
      outdoorRooms: cfg.rooms.filter(r => roomOutdoor(r)).map(r => r.id),
      devices: Object.fromEntries(reg.list().filter(d => isCamera(d) || isSensor(d)).map(d => [d.id, { outdoor: isOutdoor(d, cfg), outdoorSet: typeof cfg.devices?.[d.id]?.outdoor === 'boolean', alerts: alertsFor(d, cfg) }])),
      recent: timelineRows(hub, engine.rooms.timeline({ limit: 24 })),
      decisions: hub.security.recent(10).map(d => ({ ...d, atLabel: clock(d.at, tz) })),
    },
    // The owner's favourites (null until they pick some: the apps then suggest a few).
    favourites: cfg.favourites ?? null,
    // Speaker groups, and whether they play in perfect sync (their speakers are exactly a Cast group made in Google Home).
    speakerGroups: (cfg.speakerGroups ?? []).map(g => {
      const ms = g.members.map(id => reg.get(id)).filter((d): d is Device => !!d);
      const cast = reg.adapters.get('cast') as { castGroupFor?: (d: Device[]) => string | undefined } | undefined;
      const castGroup = ms.length === g.members.length && ms.every(d => d.adapter === 'cast') ? cast?.castGroupFor?.(ms) : undefined;
      return { ...g, deviceId: `group_${g.id}`, missing: g.members.filter(id => !reg.get(id)), sync: castGroup ? 'perfect' : 'together', castGroup: castGroup ?? null };
    }),
    groups: cfg.groups,
    // Which engine Ask Kova hands what the built-in parser can't do to (no keys, no settings beyond its name).
    assistant: engineInfo(loadSettings(store)),
    // `via`: what already knows whether they're home without their phone's location (the app then doesn't need it).
    people: cfg.people.map(p => {
      const st = engine.people[p.id];
      return { ...p, via: hub.presenceVia(p.id), home: st?.home ?? true, since: st?.since ?? null, sinceLabel: st ? clock(st.since, tz) : '', confidence: st?.confidence ?? null, confidenceLabel: st?.confidence == null ? '' : `${Math.round(st.confidence * 100)}%`, evidence: st?.evidence ?? [] };
    }),
    // zoneNames: what the owner calls a ducted air conditioner's zones; zoneRooms: the rooms each zone serves, as the
    // owner confirmed them; zoneSuggest: rooms Kova suggests for the named zones not yet confirmed, from their names.
    // `watts` / `typicalWatts`: what a device with no meter draws while on, the owner's figure and Kova's (Energy page).
    // `kind`: device (something to control), sensor (only reports) or camera. Sensors stay here so ids keep working.
    devices: reg.list().map(d => ({ ...d, kind: kindOf(d), why: engine.why(d.id), usedIn: engine.usedIn(d.id), ...wattsSetting(d, cfg.devices?.[d.id]?.watts), ...zoneSettings(d, cfg) })),
    modes,
    current: {
      modeId: mn.mode.id, since: mn.since, until: mn.until, untilLabel: clock(mn.until, tz), nextId: mn.next.id,
      waitingForSomeone: engine.pendingEntry === mn.mode.id,
      overlay: ov ? { id: ov.id, name: ov.name, icon: ov.icon, endsLabel: ov.endsLabel } : null,
    },
    day: { bands: engine.planner.bands(today), items, marks },
    upcoming,
    lightTheWay: cfg.lightTheWay.triggers.map(t => ({ id: t.id, label: t.label, minutes: t.minutes, lights: t.lights })),
    // When / if / then, with each part in words; and ones Kova suggests from how devices are connected.
    automations: engine.automations.list().map(a => {
      // The next clock start: a one-time schedule, a time of day (sun and prayer times too) or every few minutes.
      const next = nextRun(a, cfg, now);
      // One-time schedules: when the next one goes off ("today at 15:30"), and whether it's all done.
      return { ...a, ...autoWords(a), lastRun: runSummary(engine.automations.lastRun(a.id)), running: engine.automations.running(a.id),
        oneTime: isOneTime(a), nextAt: next, nextLabel: next != null ? stampWords(localStamp(next, tz), now, tz) : null,
        done: isOneTime(a) && a.triggers.every(t => t.kind === 'once' && !!t.firedAt) };
    }),
    /** The home's clock, for editors that pick a date and time ("2026-10-07T21:05"). */
    localNow: localStamp(now, tz),
    // Devices that look like one thing reached through two integrations, and the ones already combined.
    combineIdeas: combineIdeas(reg.list(), cfg.combined ?? [], cfg.dismissedFindings, id => !!cfg.devices?.[id]?.hidden, a => reg.adapters.get(a)?.name ?? a, netOf(reg)),
    combined: (cfg.combined ?? []).map(c => ({ ...c, deviceId: combinedDeviceId(c), memberNames: c.members.map(m => reg.get(m)?.name ?? m) })),
    automationIdeas: automationIdeas(cfg, reg.devices, hub.screens()).map(i => ({ ...i, ...autoWords(i) })),
    // The device events automations can start on, for the editors (engine/automations.ts AUTOMATION_EVENTS).
    automationEvents: AUTOMATION_EVENTS,
    overlays: cfg.overlays.map(o => ({ id: o.id, name: o.name, icon: o.icon, endsLabel: o.endsLabel, ends: o.ends, allOff: !!o.allOff, targets: targetList(o.targets) })),
    moments: cfg.moments.map(mo => ({ id: mo.id, label: mo.label, what: mo.what, at: mo.at, atLabel: rhythmLabel(mo.at), targets: targetList(mo.targets) })),
    sources: cfg.sources,
    // Helix music any speaker can play: Shuffle all, Loved, each playlist (empty until Helix is paired).
    music: hub.music?.cached() ?? [],
    update: hub.updates?.status() ?? null,
    findings,
    // What Kova notices: the home at a glance, and alerts and warnings (services/insights.ts).
    insights: hub.insights.current(),
    glance: hub.insights.glance(),
    activity,
    integrations: [
      ...[...reg.adapters.values()].map(a => ({ id: a.id, name: a.name, icon: a.icon, kind: a.kind, ...a.status(), devices: reg.list().filter(d => d.adapter === a.id && !isSensor(d)).length, sensors: reg.list().filter(d => d.adapter === a.id && isSensor(d)).length })),
      ...hub.services.map(x => ({ id: x.id, name: x.name, icon: x.icon, kind: x.kind, ...x.status(), devices: x.devices ?? 0 })),
    ],
    weather: hub.weather?.current ?? null,
    // Room ACs (engine/room-climate.ts): one per room a ducted unit's zone serves, what Kova does with "turn on the AC",
    // the season it chooses by, and which bridges publish them to voice assistants and other apps.
    roomClimate: (() => {
      const season = hub.roomClimate.season();
      return {
        settings: hub.roomClimate.settings(), season, seasonLabel: season ? SEASON_LABEL[season] : null,
        rooms: hub.roomClimate.rooms(),
        bridges: { matter: hub.services.some(x => x.id === 'matter-bridge'), homekit: hub.services.some(x => x.id === 'homekit-bridge') },
      };
    })(),
    energy: hub.energy.today(),
    demo: hub.demo,
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

/** A ducted unit's zone names, the rooms the owner gave its zones, and Kova's suggestions for the rest. */
function zoneSettings(d: Device, cfg: import('../model/types.ts').HomeConfig) {
  const s = cfg.devices?.[d.id];
  if (!hasZones(d)) return s?.zoneNames ? { zoneNames: s.zoneNames } : {};
  const confirmed = s?.zoneRooms ?? {};
  const names = Object.fromEntries(Object.entries(s?.zoneNames ?? {}).filter(([n]) => !confirmed[n]));
  return { zoneNames: s?.zoneNames ?? {}, zoneRooms: confirmed, zoneSuggest: suggestZoneRooms(names, cfg.rooms) };
}
