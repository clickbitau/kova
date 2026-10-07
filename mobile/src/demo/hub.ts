// A fake Kova hub that lives on the phone: it answers the same API the app uses (GET /api/state, device commands,
// overlays, automations, Ask Kova, undo…) from the demo home's state (demo/home.ts), with no network at all.
// state/demo.tsx plugs it in where the real hub's requests would go. Plain TypeScript, so the tests run it under Node.
import { HubError } from '../api/client.ts';
import type { AskReply, Command, Snapshot } from '../api/types.ts';
import type { AutomationView, Draft, RunAnswer } from '../logic/automations.ts';
import { applyCommand, applyTargets, automationWords, buildSnapshot, clockOf, DEMO_MODES, DEMO_OVERLAYS, deviceLabel, followPlan, initialState, log, type DemoState } from './home.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What the demo says when something needs a real hub (linking accounts, phones, updates). */
export const NEEDS_A_HUB = 'That needs your own Kova hub. This is the demo home, so nothing here is real.';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isLight = (t: string) => t === 'light' || t === 'dimmer';

export interface DemoHub {
  /** The live snapshot now. */
  snapshot(): Snapshot;
  /** One API request, answered the way the hub would (throws HubError when the hub would refuse). */
  request<T = unknown>(method: Method, path: string, body?: unknown): T;
  /** Called with a fresh snapshot after every change (the hub's socket, here). */
  subscribe(fn: (s: Snapshot) => void): () => void;
  /** Time passing: the clock, solar and the day's modes move on. Call it every so often. */
  tick(): void;
}

export function createDemoHub(opts: { now?: () => number } = {}): DemoHub {
  const now = opts.now ?? Date.now;
  let st: DemoState = initialState(now());
  const undos = new Map<string, DemoState>();
  let undoSeq = 0;
  const subs = new Set<(s: Snapshot) => void>();
  const snapshot = () => buildSnapshot(st, now());
  const emit = () => { const s = snapshot(); subs.forEach(f => f(s)); };

  /** Keep the state as it was, so Undo can put it back; returns the undo id. */
  const keep = (before: DemoState) => {
    const id = `demo-${++undoSeq}`;
    undos.set(id, before);
    if (undos.size > 30) undos.delete(undos.keys().next().value as string);
    return id;
  };
  /** A change: run it on the state, remember how to undo it, tell the screens. */
  const change = <R extends object>(fn: () => R): R & { undo: string } => {
    const before = clone(st);
    const r = fn();
    const undo = keep(before);
    emit();
    return { ...r, undo };
  };
  const dev = (id: string) => {
    const d = st.devices.find(x => x.id === id);
    if (!d) throw new HubError('No such device', 404);
    return d;
  };
  const auto = (id: string) => {
    const a = st.automations.find(x => x.id === id);
    if (!a) throw new HubError('No such automation', 404);
    return a;
  };
  const names = () => Object.fromEntries([
    ...st.devices.map(d => [d.id, deviceLabel(st, d)]), ...st.people.map(p => [p.id, p.name]),
    ...DEMO_MODES.map(m => [m.id, m.name]), ...DEMO_OVERLAYS.map(o => [o.id, o.name]),
  ]);
  const withWords = (id: string, d: Draft, prev?: AutomationView): AutomationView => ({
    ...d, id, ...automationWords(d, names()), lastRun: prev?.lastRun ?? null, running: 0,
  });

  const lightsOff = (room?: string) => change(() => {
    const ids = st.devices.filter(d => isLight(d.type) && d.state.on && (!room || d.room === room)).map(d => d.id);
    applyTargets(st.devices, Object.fromEntries(ids.map(i => [i, { on: false }])));
    if (ids.length) log(st, now(), 'device', 'light_off', `${ids.length} light${ids.length === 1 ? '' : 's'} off`, room ? `${st.rooms.find(r => r.id === room)?.name ?? 'Room'} off` : 'Everything off, from the app');
    return { changed: ids };
  });

  const startOverlay = (id: string) => {
    const o = DEMO_OVERLAYS.find(x => x.id === id);
    if (!o) throw new HubError('No such overlay', 404);
    return change(() => {
      if (o.allOff) applyTargets(st.devices, Object.fromEntries(st.devices.filter(d => d.state.on && d.type !== 'plug' && d.type !== 'fan').map(d => [d.id, d.type === 'media' ? { on: false, media: null } : { on: false }])));
      applyTargets(st.devices, o.targets);
      st.overlay = { id: o.id, since: now() };
      log(st, now(), 'auto', o.icon, `${o.name} started`, 'Started from the app');
      return {};
    });
  };

  const run = (a: AutomationView): RunAnswer => {
    if (!a.enabled) return { ran: false, why: 'it’s switched off' };
    const at = now();
    const steps: { at: number; text: string; ok: boolean }[] = [];
    for (const x of a.actions) {
      if (x.kind === 'set') applyTargets(st.devices, x.targets);
      if (x.kind === 'overlay' && x.op === 'start') { const o = DEMO_OVERLAYS.find(y => y.id === x.overlay); if (o) { applyTargets(st.devices, o.targets); st.overlay = { id: o.id, since: at }; } }
      if (x.kind === 'overlay' && x.op === 'end') st.overlay = null;
      if (x.kind === 'delay') break; // the demo doesn't wait: what comes after a delay is left out
      steps.push({ at, text: x.kind === 'notify' ? `Notification (not sent in the demo): ${x.message}` : x.kind, ok: true });
    }
    a.lastRun = { at, atLabel: clockOf(at), result: 'done', why: 'Run now, from the app', detail: null };
    log(st, at, 'auto', 'account_tree', a.name, 'Run now, from the app');
    return { ran: true, run: { id: `run-${at}`, automation: a.id, at, why: 'Run now', result: 'done', steps, endedAt: at } };
  };

  // ---------------------------------------------------------------- Ask --

  const findDevice = (q: string) => {
    const words = q.toLowerCase();
    const rooms = st.rooms.filter(r => words.includes(r.name.toLowerCase().replace('’', '\'')) || words.includes(r.name.toLowerCase()) || words.includes(r.id));
    // The longest names first, so "porch light" wins over "light".
    const hits = st.devices.filter(d => words.includes(d.name.toLowerCase()) && (!rooms.length || rooms.some(r => r.id === d.room)));
    const longest = Math.max(0, ...hits.map(d => d.name.length));
    const byName = hits.filter(d => d.name.length === longest || !hits.some(x => x.name.length > d.name.length && x.name.toLowerCase().includes(d.name.toLowerCase())));
    return { rooms, devices: byName };
  };
  const SRC = 'Built-in · nothing left your home';
  const reply = (text: string, extra: Partial<AskReply> = {}): AskReply => ({ text, source: SRC, actions: [], understood: true, ...extra });
  const ask = (text: string): AskReply => {
    const q = text.toLowerCase().replace(/[’']/g, '\'').trim();
    const s = snapshot();
    const lightsOn = s.devices.filter(d => isLight(d.type) && d.state.on);
    if (/who'?s home|who is home|anyone home/.test(q)) {
      const home = st.people.filter(p => p.home);
      return reply(home.length ? `${home.map(p => p.name).join(' and ')} ${home.length === 1 ? 'is' : 'are'} home.${st.people.length > home.length ? ` ${st.people.filter(p => !p.home).map(p => p.name).join(' and ')} is out.` : ''}` : 'Nobody is home.');
    }
    if (/tonight|happening|what'?s next|plan/.test(q)) {
      const next = s.upcoming.slice(0, 3).map(u => `${u.t} ${u.label}${u.skipped ? ' (skipped)' : ''}`).join(', ');
      return reply(`It’s ${s.modes.find(m => m.id === s.current.modeId)?.name} mode until ${s.current.untilLabel}. Coming up: ${next}.`, { source: 'From your modes' });
    }
    if (/solar|energy|power|grid/.test(q)) {
      const e = s.energy!;
      return reply(`The panels are making ${(e.now.solar / 1000).toFixed(1)} kW and the home is using ${((e.now.load ?? 0) / 1000).toFixed(1)} kW. ${e.solarKwh} kWh of solar so far today.`);
    }
    if (/why.*(on|off)/.test(q)) {
      const { devices } = findDevice(q);
      const d = devices[0];
      if (d) {
        const a = st.activity.find(x => x.device === d.id);
        return reply(a ? `${deviceLabel(st, d)}: ${a.what} at ${a.t} (${a.why.toLowerCase()}).` : `${deviceLabel(st, d)} is ${d.state.on ? 'on' : 'off'}: ${s.modes.find(m => m.id === s.current.modeId)?.name} mode left it that way.`, { source: 'From the activity log' });
      }
    }
    if (/leaving|i'?m off|goodbye|bye/.test(q)) {
      return reply(`Want me to start Away? It turns off ${lightsOn.length} light${lightsOn.length === 1 ? '' : 's'} and the speakers.`, { actions: [{ label: 'Start Away', action: { overlay: 'away' } }] });
    }
    for (const o of DEMO_OVERLAYS) {
      if (q.includes(o.name.toLowerCase()) && /start|movie|party|dinner|good night|time/.test(q)) {
        const r = startOverlay(o.id);
        return reply(`${o.name} is on. ${o.endsLabel}.`, { source: 'Device control', undo: r.undo });
      }
    }
    const pct = /(\d{1,3})\s*%/.exec(q);
    const wantOff = /\boff\b/.test(q), wantOn = /\bon\b/.test(q) || !!pct;
    if (wantOff || wantOn) {
      const { rooms, devices } = findDevice(q);
      const lightsWord = /light/.test(q);
      let targets = devices;
      if (!targets.length && rooms.length) targets = st.devices.filter(d => rooms.some(r => r.id === d.room) && (lightsWord ? isLight(d.type) : isLight(d.type) || d.type === 'media' || d.type === 'tv'));
      if (!targets.length && /all|every|lights/.test(q)) targets = st.devices.filter(d => isLight(d.type));
      if (targets.length) {
        const cmd: Command = pct ? { on: true, bri: Math.min(100, Number(pct[1])) } : { on: !wantOff };
        const r = change(() => {
          for (const d of targets) d.state = applyCommand(d, d.type === 'media' && cmd.on === false ? { on: false, media: null } : !d.capabilities.includes('brightness') && cmd.bri != null ? { on: true } : cmd);
          log(st, now(), 'device', 'graphic_eq', `${targets.length === 1 ? deviceLabel(st, targets[0]) : `${targets.length} devices`} ${cmd.bri != null ? `to ${cmd.bri}%` : cmd.on ? 'on' : 'off'}`, 'Asked Kova');
          return {};
        });
        const what = targets.length === 1 ? deviceLabel(st, targets[0]) : rooms.length ? `${rooms.map(x => x.name).join(' and ')}${lightsWord ? ' lights' : ''}` : `${targets.length} lights`;
        return reply(`Done: ${what} ${cmd.bri != null ? `to ${cmd.bri}%` : cmd.on ? 'on' : 'off'}.`, { source: 'Device control', undo: r.undo });
      }
    }
    if (/what'?s on|lights on|anything on/.test(q)) {
      return reply(lightsOn.length ? `${lightsOn.length} light${lightsOn.length === 1 ? ' is' : 's are'} on: ${lightsOn.slice(0, 5).map(d => deviceLabel(st, d)).join(', ')}${lightsOn.length > 5 ? '…' : ''}.` : 'All the lights are off.');
    }
    return reply('In the demo home I understand things like “Turn off the kitchen”, “Lamp to 30%”, “Who’s home?”, “Start movie” or “What’s happening tonight?”. With your own hub, Ask Kova can also use an AI model you choose.', { understood: false });
  };
  const parse = (text: string) => {
    const q = text.toLowerCase();
    const { rooms, devices } = findDevice(q);
    const chips = [/\boff\b/.test(q) ? 'Turn off' : /\bon\b/.test(q) ? 'Turn on' : '', ...rooms.map(r => r.name), ...devices.slice(0, 2).map(d => d.name), /(\d{1,3})\s*%/.exec(q)?.[0] ?? ''].filter(Boolean);
    return { understood: chips.length > 0, chips };
  };

  // --------------------------------------------------------------- routes --

  const handle = (method: Method, path: string, body: unknown): unknown => {
    const url = new URL(path, 'http://demo');
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', 'devices', 'lamp']
    const b = (body ?? {}) as Record<string, unknown>;
    const at = (...parts: string[]) => p.length === parts.length + 1 && parts.every((x, i) => x === '*' || p[i + 1] === x);
    if (p[0] !== 'api') throw new HubError('Not found', 404);

    if (method === 'GET' && at('state')) return snapshot();
    if (method === 'GET' && (at('health') || at('hello'))) return { ok: true, version: 'demo', hubId: 'DEMO' };

    // Devices
    if (method === 'POST' && at('devices', '*')) {
      const d = dev(p[2]);
      const cmd = b as Command;
      return change(() => {
        d.state = applyCommand(d, cmd);
        if (d.id === 'lounge_tv' && cmd.on === false && st.overlay?.id === 'movie') st.overlay = null;
        log(st, now(), 'device', d.type === 'media' || d.type === 'tv' ? 'speaker' : 'lightbulb', `${deviceLabel(st, d)} ${cmd.on === false ? 'off' : cmd.bri != null ? `${cmd.bri}%` : cmd.media ? `playing ${cmd.media}` : 'on'}`, 'From the app', d.id);
        return {};
      });
    }
    if (method === 'PATCH' && at('devices', '*', 'settings')) {
      const d = dev(p[2]);
      return change(() => {
        if (typeof b.name === 'string' && b.name.trim()) d.name = b.name.trim();
        if (typeof b.room === 'string') d.room = b.room;
        if (typeof b.hidden === 'boolean') d.hidden = b.hidden;
        if ('watts' in b) d.watts = (b.watts as number | null) ?? null;
        if (typeof b.favourite === 'boolean') {
          const f = (st.favourites ?? []).filter(x => x !== d.id);
          st.favourites = b.favourite ? [...f, d.id] : f;
        }
        return {};
      });
    }
    if (method === 'POST' && at('lights', 'off')) return lightsOff();
    if (method === 'POST' && at('rooms', '*', 'off')) return lightsOff(p[2]);

    // Modes, overlays and the plan
    if (method === 'POST' && at('overlays', '*', 'start')) return startOverlay(p[2]);
    if (method === 'POST' && at('overlays', 'end')) {
      return change(() => {
        const o = DEMO_OVERLAYS.find(x => x.id === st.overlay?.id);
        st.overlay = null;
        const m = DEMO_MODES.find(x => x.id === st.modeId);
        if (m) applyTargets(st.devices, m.targets);
        log(st, now(), 'auto', o?.icon ?? 'layers', `${o?.name ?? 'Overlay'} ended`, `Back to ${m?.name ?? 'the mode'}`);
        return {};
      });
    }
    if (method === 'POST' && at('plan', 'skip')) {
      const id = String(b.id ?? '');
      return change(() => { st.skipped = b.skip ? [...new Set([...st.skipped, id])] : st.skipped.filter(x => x !== id); return {}; });
    }
    if (method === 'POST' && at('findings', '*', 'fix')) return change(() => { st.findingsDismissed.push(p[2]); return {}; });
    if (method === 'POST' && at('findings', '*', 'dismiss')) return change(() => { st.findingsDismissed.push(p[2]); return {}; });
    if (method === 'POST' && at('insights', '*', 'snooze')) return change(() => { st.insightsSnoozed.push(p[2]); return {}; });
    if (method === 'POST' && at('undo', '*')) {
      const prev = undos.get(p[2]);
      if (!prev) throw new HubError('That can’t be undone any more', 410);
      undos.delete(p[2]);
      st = prev;
      emit();
      return { ok: true };
    }

    // The home: name, behaviours, rooms, people, favourites
    if (method === 'PUT' && at('home')) {
      return change(() => {
        if (typeof b.name === 'string' && b.name.trim()) st.name = b.name.trim();
        if (typeof b.pauseForDoorbell === 'boolean') st.pauseForDoorbell = b.pauseForDoorbell;
        if (typeof b.prayerMethod === 'string') st.prayerMethod = b.prayerMethod;
        return {};
      });
    }
    if (method === 'PUT' && at('favourites')) return change(() => { st.favourites = Array.isArray(b.ids) ? (b.ids as string[]) : st.favourites; return {}; });
    if (method === 'POST' && at('rooms')) {
      const name = String(b.name ?? '').trim();
      if (!name) throw new HubError('A room needs a name', 400);
      return change(() => { const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${st.rooms.length}`; st.rooms.push({ id, name, icon: 'meeting_room' }); return { id }; });
    }
    if (method === 'PUT' && at('rooms', 'order')) {
      const ids = (b.ids as string[] | undefined) ?? [];
      return change(() => { st.rooms.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); return {}; });
    }
    if (method === 'PUT' && at('rooms', '*')) {
      return change(() => { const r = st.rooms.find(x => x.id === p[2]); if (r) { if (typeof b.name === 'string') r.name = b.name; if (typeof b.icon === 'string') r.icon = b.icon; } return {}; });
    }
    if (method === 'DELETE' && at('rooms', '*')) {
      return change(() => { st.rooms = st.rooms.filter(r => r.id !== p[2]); for (const d of st.devices) if (d.room === p[2]) d.room = 'unassigned'; return {}; });
    }
    if (method === 'POST' && at('people')) {
      const name = String(b.name ?? '').trim();
      if (!name) throw new HubError('Who is it?', 400);
      return change(() => { const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${st.people.length}`; st.people.push({ id, name, detail: '', home: true, since: now() }); return { id }; });
    }
    if (method === 'PUT' && at('people', '*')) {
      return change(() => { const x = st.people.find(q => q.id === p[2]); if (x) { if (typeof b.name === 'string') x.name = b.name; if (typeof b.detail === 'string') x.detail = b.detail; } return {}; });
    }
    if (method === 'DELETE' && at('people', '*')) return change(() => { st.people = st.people.filter(x => x.id !== p[2]); return {}; });

    // Automations
    if (method === 'GET' && at('automations', '*')) {
      const a = auto(p[2]);
      const runs = a.lastRun ? [{ id: `run-${a.lastRun.at}`, automation: a.id, at: a.lastRun.at, why: a.lastRun.why, result: a.lastRun.result, steps: [], endedAt: a.lastRun.at }] : [];
      const { lastRun: _l, running: _r, triggerLabels: _t, conditionLabels: _c, actionLabels: _a, ...automation } = a;
      return { automation, runs };
    }
    if (method === 'POST' && at('automations')) {
      const d = b as unknown as Draft;
      if (!d.name?.trim()) throw new HubError('Give it a name', 400);
      return change(() => { const id = `auto_${Date.now().toString(36)}`; st.automations.push(withWords(id, { ...d, enabled: d.enabled ?? true })); return { id }; });
    }
    if (method === 'PUT' && at('automations', '*')) {
      const a = auto(p[2]);
      return change(() => { st.automations = st.automations.map(x => (x.id === a.id ? withWords(a.id, b as unknown as Draft, a) : x)); return { id: a.id }; });
    }
    if (method === 'PATCH' && at('automations', '*')) {
      const a = auto(p[2]);
      return change(() => { if (typeof b.enabled === 'boolean') a.enabled = b.enabled; return {}; });
    }
    if (method === 'DELETE' && at('automations', '*')) {
      const a = auto(p[2]);
      return change(() => { st.automations = st.automations.filter(x => x.id !== a.id); return {}; });
    }
    if (method === 'POST' && at('automations', '*', 'duplicate')) {
      const a = auto(p[2]);
      return change(() => { const id = `${a.id}_copy${Date.now().toString(36)}`; st.automations.push({ ...clone(a), id, name: `${a.name} (copy)`, enabled: false, lastRun: null }); return { id }; });
    }
    if (method === 'POST' && at('automations', '*', 'run')) {
      const a = auto(p[2]);
      if (url.searchParams.get('check')) return { ran: a.enabled, why: a.enabled ? undefined : 'it’s switched off' } satisfies RunAnswer;
      const r = run(a);
      emit();
      return r;
    }
    if (method === 'GET' && at('import', 'ha', 'automations')) throw new HubError('No Home Assistant import in the demo home', 503);

    // Ask Kova
    if (method === 'POST' && at('ask')) return ask(String(b.text ?? ''));
    if (method === 'POST' && at('ask', 'parse')) return parse(String(b.text ?? ''));
    if (method === 'POST' && at('ask', 'act')) {
      const a = (b.action ?? {}) as { overlay?: string };
      if (a.overlay) { const r = startOverlay(a.overlay); return { text: `${DEMO_OVERLAYS.find(o => o.id === a.overlay)?.name} is on.`, undo: r.undo }; }
      throw new HubError(NEEDS_A_HUB, 501);
    }

    // Things only a real hub can do: say so plainly.
    if (method === 'GET' && at('sessions')) return { sessions: [] };
    if (method === 'POST' && at('app', 'crash')) return { ok: true };
    throw new HubError(NEEDS_A_HUB, 501);
  };

  let lastTick = now();
  return {
    snapshot,
    request<T>(method: Method, path: string, body?: unknown): T {
      return clone(handle(method, path, body)) as T;
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    tick() {
      const t = now();
      followPlan(st, t);
      // The clock on screen moves on a minute at a time.
      if (Math.floor(t / 60_000) !== Math.floor(lastTick / 60_000)) emit();
      lastTick = t;
    },
  };
}
