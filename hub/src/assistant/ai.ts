import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../engine/engine.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Store } from '../store/db.ts';
import { ROOM_ICONS, UNASSIGNED_ROOM, WHOLE_HOME, type Automation, type Cause, type Command, type Device, type Targets } from '../model/types.ts';
import { FIELD_CAP, isPlayer, pseudoLabel, targetLabel } from '../util/describe.ts';
import { cleanZoneCommand, ZONE_FIELDS, zonesServing, type ZoneCommand } from '../util/zones.ts';
import { hardwareSummary, hasHardware } from '../util/hardware.ts';
import { announceWithoutMedia, CheckError, checkAutomation } from '../engine/automation-check.ts';
import { canAnnounce, isSpeakerGroup, trimOf } from '../engine/announce.ts';
import { BUILTIN_ADHANS, adhanCredit } from '../services/adhans.ts';
import { actionWords, condWords, nextOnce, triggerWords } from '../engine/automations.ts';
import { slug } from '../tools/import-ha.ts';
import { atLocal, clock, localDate, localStamp, stampWords } from '../util/time.ts';
import { isCamera, isSensor, readingsOf } from '../util/sensors.ts';
import { ROOM_EVENT_TEXT } from '../engine/automations.ts';
import { norm, type AskReply } from './assistant.ts';
import type { JevAdvisor } from '../services/jev.ts';
import { AccessDenied, ROLE_LABEL, allows, canDevice, canRoom, currentActor, demandTargets, needs, scoped, type Perm } from '../services/actor.ts';

// Optional AI engines for Ask Kova. They only ever see requests the built-in
// parser couldn't handle, only the context the user chose to share, never
// cameras, and they can only act through a small set of tools that go through
// the engine (so every change is logged and undoable).

// --------------------------------------------------------------- settings --

export type EngineKind = 'builtin' | 'local' | 'cloud';

/**
 * "What the AI can see". Keys match the phone app's settings sheet. Cameras are locked off.
 */
export interface ShareSettings {
  /** Device and room names. */
  names: boolean;
  /** Current device states (on/off, brightness, what's playing). The key name predates the label. */
  rooms: boolean;
  /** Last 7 days of activity. */
  history: boolean;
  /** Who's home. */
  presence: boolean;
  /**
   * Room activity: how many times cameras and sensors noticed a person, motion, the doorbell or a door in each
   * room today, and when last. Never pictures, camera names or anything a camera saw beyond the kind of event.
   */
  security: boolean;
  cameras: false;
}

/**
 * Cloud AI providers. 'anthropic' uses the Messages API; the rest are
 * OpenAI-compatible chat-completions endpoints (MiniMax, OpenAI, or any
 * custom server via 'openai-compat' + baseUrl).
 */
export type CloudProvider = 'anthropic' | 'minimax' | 'openai' | 'openai-compat';

export interface AssistantSettings {
  engine: EngineKind;
  share: ShareSettings;
  /** Standing notes for the AI ("baby's room speaker stays quiet"), sent with every request. */
  instructions: string;
  local: { url: string; model: string; apiKey?: string };
  cloud: { provider: CloudProvider; model: string; apiKey?: string; baseUrl?: string };
}

/** What GET /api/assistant/settings returns: never any key. */
export interface PublicAssistantSettings {
  engine: EngineKind;
  share: ShareSettings;
  instructions: string;
  local: { url: string; model: string; hasKey: boolean };
  cloud: { provider: CloudProvider; model: string; hasKey: boolean; baseUrl?: string };
}

export interface SettingsPatch {
  engine?: EngineKind;
  share?: Partial<Record<keyof ShareSettings, boolean>>;
  instructions?: string;
  local?: { url?: string; model?: string; apiKey?: string | null };
  cloud?: { provider?: CloudProvider; model?: string; apiKey?: string | null; baseUrl?: string | null };
}

export const DEFAULT_CLOUD_MODEL = 'claude-opus-5-5';

/** Preset cloud providers. baseUrl is used unless the user overrides it. */
export const CLOUD_PROVIDERS: Record<CloudProvider, { label: string; baseUrl?: string; defaultModel: string }> = {
  anthropic: { label: 'Cloud AI', defaultModel: DEFAULT_CLOUD_MODEL },
  minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.io', defaultModel: 'MiniMax-M2.7-highspeed' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com', defaultModel: 'gpt-5-mini' },
  'openai-compat': { label: 'OpenAI-compatible AI', defaultModel: '' },
};
const PROVIDER_KEYS = Object.keys(CLOUD_PROVIDERS) as CloudProvider[];

const ENGINES: EngineKind[] = ['builtin', 'local', 'cloud'];
const SHARE_KEYS = ['names', 'rooms', 'history', 'presence', 'security'] as const;

export function defaultSettings(): AssistantSettings {
  return {
    engine: 'builtin',
    share: { names: true, rooms: true, history: false, presence: false, security: false, cameras: false },
    instructions: '',
    local: { url: '', model: '' },
    cloud: { provider: 'anthropic', model: DEFAULT_CLOUD_MODEL },
  };
}

/** Settings as stored, filled in with defaults (older stores only had engine + share). */
export function loadSettings(store: Store): AssistantSettings {
  const d = defaultSettings();
  const s = store.get<Partial<AssistantSettings>>('assistant') ?? {};
  const cloud = { ...d.cloud, ...(s.cloud ?? {}) };
  if (!PROVIDER_KEYS.includes(cloud.provider)) cloud.provider = 'anthropic';
  return {
    engine: ENGINES.includes(s.engine as EngineKind) ? s.engine as EngineKind : d.engine,
    share: { ...d.share, ...(s.share ?? {}), cameras: false },
    instructions: typeof s.instructions === 'string' ? s.instructions : d.instructions,
    local: { ...d.local, ...(s.local ?? {}) },
    cloud,
  };
}

export function publicSettings(s: AssistantSettings): PublicAssistantSettings {
  return {
    engine: s.engine,
    share: { ...s.share, cameras: false },
    instructions: s.instructions,
    local: { url: s.local.url, model: s.local.model, hasKey: !!s.local.apiKey },
    cloud: { provider: s.cloud.provider, model: s.cloud.model || CLOUD_PROVIDERS[s.cloud.provider].defaultModel, hasKey: !!s.cloud.apiKey, ...(s.cloud.baseUrl ? { baseUrl: s.cloud.baseUrl } : {}) },
  };
}

/** Merge a PUT body into the stored settings. Throws on invalid input. An empty/null apiKey clears it. */
export function saveSettings(store: Store, patch: SettingsPatch): AssistantSettings {
  const cur = loadSettings(store);
  const engine = patch.engine ?? cur.engine;
  if (!ENGINES.includes(engine)) throw new Error('unknown engine');
  const share = { ...cur.share };
  for (const k of SHARE_KEYS) if (typeof patch.share?.[k] === 'boolean') share[k] = patch.share[k]!;
  share.cameras = false;
  const str = (v: unknown, name: string) => { if (typeof v !== 'string') throw new Error(`${name} must be a string`); return v.trim(); };
  const instructions = patch.instructions === undefined ? cur.instructions : str(patch.instructions, 'instructions').slice(0, 2000);
  const local = { ...cur.local };
  if (patch.local?.url !== undefined) {
    const url = str(patch.local.url, 'local.url');
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('local.url must be an http(s) URL');
    local.url = url;
  }
  if (patch.local?.model !== undefined) local.model = str(patch.local.model, 'local.model');
  if (patch.local && 'apiKey' in patch.local) { if (patch.local.apiKey) local.apiKey = str(patch.local.apiKey, 'local.apiKey'); else delete local.apiKey; }
  const cloud = { ...cur.cloud };
  if (patch.cloud?.provider !== undefined) {
    const provider = str(patch.cloud.provider, 'cloud.provider') as CloudProvider;
    if (!PROVIDER_KEYS.includes(provider)) throw new Error('unknown provider');
    // Switching providers resets the model to the provider's default unless the patch names one.
    if (provider !== cloud.provider && patch.cloud.model === undefined) cloud.model = CLOUD_PROVIDERS[provider].defaultModel;
    cloud.provider = provider;
  }
  if (patch.cloud && 'baseUrl' in patch.cloud) {
    if (patch.cloud.baseUrl) {
      const url = str(patch.cloud.baseUrl, 'cloud.baseUrl');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('cloud.baseUrl must be an http(s) URL');
      cloud.baseUrl = url;
    } else delete cloud.baseUrl;
  }
  if (patch.cloud?.model !== undefined) cloud.model = str(patch.cloud.model, 'cloud.model') || CLOUD_PROVIDERS[cloud.provider].defaultModel;
  if (patch.cloud && 'apiKey' in patch.cloud) { if (patch.cloud.apiKey) cloud.apiKey = str(patch.cloud.apiKey, 'cloud.apiKey'); else delete cloud.apiKey; }
  const next: AssistantSettings = { engine, share, instructions, local, cloud };
  store.set('assistant', next);
  return next;
}

// ------------------------------------------------------------------ tools --

/** Tool definitions in a provider-neutral JSON Schema form. */
export const TOOLS = [
  {
    name: 'set_devices',
    description: 'Change one or more devices. Only use device ids from the home context. bri is brightness 1-100, k is colour temperature in Kelvin, color is #rrggbb, vol is volume 0-100. Turning a speaker or TV off also stops what it plays. paused pauses or carries on (devices with the pause capability). media on a device with the library capability is a film or show title to find and play there (a Helix box). On a speaker with the queue capability, media can also be Helix music: "Shuffle all", "Loved", a playlist title, or "Station: <artist, album or song>"; shuffle true plays it in a shuffled order; skip 1 is the next song, -1 the previous. media can also be a named playable source from the context (ambient loops, radio streams) — prefer those over a station when the name matches. Any other field a device shows in its state is set through "set" — e.g. {"childLock": true}, {"display": false} or {"mode": "Sleep"} on a purifier, {"hvac": "cool", "target": 23, "fanSpeed": "low"} on an air conditioner, {"input": "hdmi1"}, {"muted": true} or {"night": true} on a TV or soundbar, {"zoneSet": {"1": {"on": true, "open": 50}, "2": {"on": false}}} for the named zones of a ducted air conditioner (a zone key can also be the id of a room it serves), {"extras": {"eco": true}} for the extra switches a device lists under "extras". Only fields the device actually lists in its state can be set. A room’s air conditioner zone (see "AC zones by room") is the id "zone:<room id>": on opens (true) or closes (false) the zone, open is how far open 0-100, set.hvac / set.target / set.fanSpeed run the AC itself (a mode turns it on), ac true or false turns the whole AC on or off.',
    parameters: {
      type: 'object',
      properties: {
        devices: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              on: { type: 'boolean' },
              bri: { type: 'integer', minimum: 1, maximum: 100 },
              k: { type: 'integer', minimum: 1500, maximum: 9000 },
              color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              vol: { type: 'integer', minimum: 0, maximum: 100 },
              paused: { type: 'boolean' },
              media: { type: 'string' },
              shuffle: { type: 'boolean' },
              skip: { type: 'integer', enum: [-1, 1] },
              open: { type: 'integer', minimum: 0, maximum: 100, description: 'How far a room zone ("zone:<room id>") opens.' },
              ac: { type: 'boolean', description: 'For a room zone ("zone:<room id>"): turn the whole air conditioner on or off as well.' },
              set: { type: 'object', description: 'Any other fields from the device state to change, e.g. childLock, display, mode, hvac, target, fanSpeed, input, muted, night, fanLevel.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['devices'],
    },
  },
  {
    name: 'start_overlay',
    description: 'Start an overlay (a temporary scene such as Movie or Away) by its id from the home context.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'end_overlay',
    description: 'End the overlay that is currently on, returning the home to its mode.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'explain_device',
    description: 'Explain why a device is in its current state and what will change it next.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_schedule',
    description: 'List what the home has planned for the rest of tonight (mode changes and timed moments), and every one-time schedule still to come.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'remember',
    description: 'Remember a fact the user asked you to keep — a note about the home, a preference, something coming later. The ONLY way you recall anything next time; saying "I\'ll remember" without this tool loses it.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'forget',
    description: 'Forget a fact previously remembered — the exact text, or enough of it to match.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'create_automation',
    description: `Create a home automation: "when" (triggers) starts it, every "if" (condition) must hold, then "then" (actions) run in order. It is saved and runs on its own from then on — only use it when the user asks for something ongoing or scheduled, not for a one-off change (use set_devices). Shapes:
when: {kind:'time', at:'HH:MM' or {kind:'time', at:'HH:MM'} or {kind:'sun', event:'sunrise|sunset|dawn|dusk', offsetMin?:n (minutes, negative = before, e.g. -15)} or {kind:'prayer', prayer:'fajr|sunrise|dhuhr|asr|maghrib|isha', offsetMin?:n}, days?:[0-6, 0=Sunday, empty=every day]} — e.g. 15 minutes before sunset is {kind:'time', at:{kind:'sun', event:'sunset', offsetMin:-15}} | {kind:'device', device:id, to?:{on?, online?, mode?, hvac?, input?, playing?, muted?, motion?, open?}, from?:{...}, forSec?:n} | {kind:'numeric', device:id, field:'temp|target|power|energy|battery|bri|vol|grid|load|humidity|lux|pm25', above?:n, below?:n} (sensors included) | {kind:'event', device:id, event:string} | {kind:'room', room:roomId, event:'person|motion|ring|vehicle|animal|package|sound|opened|closed'} (anything a camera or sensor in that room notices; 'motion' includes a person seen) | {kind:'every', minutes:n} | {kind:'presence', event:'arrives|leaves|first-arrives|last-leaves', person?:id} | {kind:'mode', mode:id} | {kind:'overlay', overlay:id, event:'starts|ends'} | {kind:'hub', event:'start'} | {kind:'once', at:'YYYY-MM-DDTHH:MM' in the home's time} or {kind:'once', inMinutes:n} — ONE time only
if: {kind:'device', device:id, is:{on?...}} | {kind:'numeric', device:id, field, above?, below?} | {kind:'time', after?/before?:'HH:MM' or a sun/prayer object as above, days?} | {kind:'presence', who:'anyone|no-one|person id', home:boolean} | {kind:'mode', modes:[id]} | {kind:'overlay', overlay?:id, active:boolean} | {kind:'room', room:roomId, active:boolean, withinMin?:n} (a person, motion or a door in that room in the last withinMin minutes, default 10) | {kind:'all|any|not', conditions:[...]}
then: {kind:'announce', media:'<source name | clip:<id> | adhan:<key> | https URL | Song: <Helix title>>', vol:15, targets:{<speaker id>:{}, …}, pause?:[<player ids to pause, e.g. a Helix box>], restore:true, mediaFor?:{fajr:'<media>'}} — play something over speakers (an announcement, a call to prayer, a chime) and then put each speaker back as it was (volume, and what it was playing, resumed where possible); vol is the level the owner says, each speaker plays it × its own announcement loudness; list EVERY speaker it should play on in targets (or a speaker group); TVs and Helix boxes go in pause, never in targets; leave media out when the user hasn't said which audio and none fits, and ask them | {kind:'set', targets:{deviceId:{on:false, bri:50, ...same fields as set_devices + set}, or 'type:light'|'type:media'|'type:<device type>'|'room:<room id>' to reach EVERY matching device — including devices added later (use "type:light" for "all lights")}} | {kind:'delay', seconds:n} | {kind:'wait', until:condition, timeoutSec?:n, stopOnTimeout?:bool} | {kind:'notify', message:string, title?:string, people?:[ids]} | {kind:'overlay', overlay:id, op:'start|end'} | {kind:'if', conditions:[...], then:[...], else?:[...]} | {kind:'repeat', times:n, actions:[...]} | {kind:'ramp', targets:{same target map as set}, field:'bri'|'vol'|'target', to:number, from?:number, overSec:number, stepSec?:number} — gradual changes like brightness climbing over an hour | {kind:'run', automation:id} | {kind:'stop'}
runMode: what a second start does while it's still running — single (ignore), restart (start over), queued (run after), parallel (alongside). Default single.
One-time schedules: anything asked for once at a later time ("turn the AC off at 3pm", "in 20 minutes", "tomorrow at 7 open the blinds", "remind me tonight") is create_automation with only a once trigger — it runs once, then switches itself off. Name it after what it does and when ("AC off at 15:00"). Never use a daily time trigger for a one-off.
Prefer ONE automation per intent: several triggers plus if/else branches beat overlapping automations. Check the Automations list first — update_automation an existing one rather than adding another.
Only use device, person, mode and overlay ids from the home context; never invent them.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        when: { type: 'array', items: { type: 'object' } },
        if: { type: 'array', items: { type: 'object' } },
        then: { type: 'array', items: { type: 'object' } },
        runMode: { type: 'string', enum: ['single', 'restart', 'queued', 'parallel'] },
        enabled: { type: 'boolean' },
      },
      required: ['name', 'when', 'then'],
    },
  },
  {
    name: 'update_automation',
    description: `Change an existing automation (ids in the Automations list): rename, enable/disable, or replace its when/if/then — given parts replace those lists wholesale, omitted parts stay. Same shapes as create_automation. Prefer this over creating a second automation that overlaps an existing one.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        when: { type: 'array', items: { type: 'object' } },
        if: { type: 'array', items: { type: 'object' } },
        then: { type: 'array', items: { type: 'object' } },
        runMode: { type: 'string', enum: ['single', 'restart', 'queued', 'parallel'] },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_automation',
    description: 'Delete an automation by id (from the Automations list). Only when the user asks, or it is a duplicate of one being created. When merging automations, create or update the surviving one FIRST and delete the other only after that returns ok.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_room',
    description: 'Create a room — a part of the home like Nursery, Garage or Hallway. Returns its room id; put devices in it with update_device.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        icon: { type: 'string', enum: [...ROOM_ICONS], description: 'Pick the closest fit; optional.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_device',
    description: `Change how a device is organised — for "the X is in the master bedroom", "rename it", "hide it", "put it on my favourites". name renames it, room moves it (a room id from the Rooms list — create_room first if the room the user named doesn't exist; "unassigned" puts it in no room), favourite puts it on the Now page, hidden takes it out of view (hidden:false shows it again). zoneNames names a ducted air conditioner's zones by number, e.g. {"1": "Living", "3": "Theatre"} (an empty name clears one). loudness is a speaker's announcement loudness, in % of the level an announcement asks for (20–200, 100 = as asked): a speaker that sounds louder than the rest gets less (e.g. 80, 70, 60). The result says the room's real name — use that name in the reply.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        room: { type: 'string' },
        favourite: { type: 'boolean' },
        hidden: { type: 'boolean' },
        zoneNames: { type: 'object', description: 'Zone number → name, for an air conditioner with zones.' },
        loudness: { type: 'integer', minimum: 20, maximum: 200, description: 'Speakers: announcement loudness in % (100 = as asked).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rename_room',
    description: 'Rename a room, or change its icon. room is a room id from the Rooms list.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        name: { type: 'string' },
        icon: { type: 'string', enum: [...ROOM_ICONS] },
      },
      required: ['room'],
    },
  },
  {
    name: 'delete_room',
    description: `Remove a room. Devices in it aren't lost — they move to moveTo, another room id from the Rooms list, or "unassigned" to leave them in no room. If the room has devices and no moveTo is given, the call fails with the count so you can ask where they should go.`,
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        moveTo: { type: 'string' },
      },
      required: ['room'],
    },
  },
  {
    name: 'combine_devices',
    description: `Show device entries that are really one physical device seen through different integrations (e.g. the same TV found twice) as one device; the parts are hidden while combined. Use when the user says entries are the same thing — put ALL of them in one call. To add entries to a device that is already combined, include its combined id (or any of its parts) with the new ones: they join it, no need to separate first. name defaults to the existing combined device's or first member's name; room is a room id, optional. The result gives the combined device's id — use it for any later change (room, name).`,
    parameters: {
      type: 'object',
      properties: {
        members: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        room: { type: 'string' },
      },
      required: ['members'],
    },
  },
  {
    name: 'separate_devices',
    description: 'Split a combined device back into its separate devices — only when the user wants them apart again (to add a part, use combine_devices instead). id is the combined device id (or one of its parts). The result lists the parts\' ids.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'review_action',
    description: 'Ask the local Jev advisor for an advisory risk check before a destructive, broad, privacy-sensitive, security-sensitive, or hard-to-undo action. Returns allow, confirm, or block. Use sparingly — not for routine light, media, or climate changes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The action being considered, in plain words.' },
        context: { type: 'string', description: 'Why the user wants it and anything that makes it safer or riskier.' },
      },
      required: ['action'],
    },
  },
] as const;

type ToolName = typeof TOOLS[number]['name'];
export type ToolDef = { name: string; description: string; parameters: unknown };

/** Prayer-time words, which only go to the model while prayer times are on (Integrations → Prayer times). */
const PRAYER_WHEN = " or {kind:'prayer', prayer:'fajr|sunrise|dhuhr|asr|maghrib|isha', offsetMin?:n}";

/** The tools as the model gets them: without prayer times while they're off. */
export function toolDefs(o: { prayer: boolean }): ToolDef[] {
  return TOOLS.map(t => {
    if (o.prayer || (t.name !== 'create_automation' && t.name !== 'update_automation')) return t as ToolDef;
    return { ...t, description: t.description.split(PRAYER_WHEN).join('').replace(/ or a sun\/prayer object as above/g, ' or a sun object as above').replace(/, mediaFor\?:\{fajr:'<media>'\}/, '').replace(/, a call to prayer/, '') } as ToolDef;
  });
}

const AI_CAUSE: Cause = { kind: 'assistant', label: 'Ask Kova (AI)' };
/** Model round trips per ask. A house-organising request ("combine these, move that, make a room…") takes several. */
const MAX_ROUNDS = 14;

/** One thing the AI is doing, as the person sees it while it works ("Combining Bedroom TV and TV…"). */
export interface AskStep { tool: string; label: string; status: 'working' | 'ok' | 'failed'; note?: string }

/** What the tools confirmed, after a re-read of what they touched: the honest summary of an ask. */
export interface AskOutcome { done: string[]; couldnt: string[] }

/** Fields that are readings, not commands — never settable through `set`. */
const READONLY = new Set(['power', 'energy', 'grid', 'load', 'temp', 'humidity', 'lux', 'pm25', 'airQuality', 'filterLife', 'battery', 'online', 'track', 'fanLevelMax', 'zones']);

/** Models sometimes send a list argument as a JSON string — accept it. */
/**
 * "Remind me": a notification to "me" goes to the person asking (their phones), whoever they are. Asked with the
 * master key (no person), it goes to everyone.
 */
export function forMe(v: unknown, personId: string | undefined = currentActor()?.personId): unknown {
  if (Array.isArray(v)) return v.map(x => forMe(x, personId));
  if (!v || typeof v !== 'object') return v;
  const o = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, forMe(x, personId)]));
  if (o.kind === 'notify' && Array.isArray(o.people)) {
    const people = [...new Set((o.people as unknown[]).flatMap(p => (p === 'me' ? (personId ? [personId] : []) : [p])))];
    if (people.length) o.people = people; else delete o.people;
  }
  return o;
}

const listArg = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) as unknown; } catch { return v; }
};

/** { "1": {on, open} } for ducted AC zones — the same shape cleanTarget accepts. */
function cleanZoneSet(v: unknown): Command['zoneSet'] | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: NonNullable<Command['zoneSet']> = {};
  for (const [n, z] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[1-9]\d?$/.test(n) || !z || typeof z !== 'object') return undefined;
    const zz = z as Record<string, unknown>;
    const entry: { on?: boolean; open?: number } = {};
    if (typeof zz.on === 'boolean') entry.on = zz.on;
    if (typeof zz.open === 'number' && Number.isFinite(zz.open)) entry.open = Math.max(0, Math.min(100, Math.round(zz.open)));
    if (!Object.keys(entry).length) return undefined;
    out[n] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Closed lists for string fields. */
const ENUMS: Record<string, readonly string[]> = {
  hvac: ['cool', 'heat', 'dry', 'fan', 'auto'],
  fanSpeed: ['auto', 'quiet', 'low', 'medium', 'high', 'turbo'],
  activity: ['cleaning', 'returning', 'docked', 'paused', 'idle', 'error'],
};

/** Automation ids look like the editor's: name_slug + 4 random chars. */
const autoSlug = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'automation'}_${randomUUID().slice(0, 4)}`;

/** MiniMax-style reasoning blocks must never reach the reply text. */
const stripThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/** Models love markdown; the chat shows plain text — strip it so **bold** and `code` don't show raw. */
const cleanReply = (s: string) => stripThink(s)
  .replace(/\*\*([^*\n]+)\*\*/g, '$1')
  .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
  .replace(/(?<![\w_])__([^_\n]+)__(?![\w_])/g, '$1')
  .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1')
  .replace(/`([^`\n]+)`/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*[*•]\s+/gm, '- ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const cap = (s: string) => s ? s[0]!.toUpperCase() + s.slice(1) : s;
/** "a, b and c". */
const andList = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** A tool's error as the person reads it: no instructions meant for the model, no ids-list advice. */
export function tidyError(e: string | undefined): string {
  const t = (e ?? '').trim();
  if (!t) return 'it didn’t work.';
  if (/^This (exact call already failed|has failed)/.test(t)) return 'it kept failing.';
  if (/^Unknown device ids?:? /i.test(t)) return 'Ask Kova can’t use that device (cameras and unknown ids are off limits).';
  const out = t.replace(/\s+—\s+(use an id|ask where|create_room|use a room id)[^]*$/i, '').replace(/\s*\(?use an id from[^)]*\)?\.?$/i, '').trim();
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

/** A mutating step the AI took, with resolved device ids — replayable without the AI. */
export type LearnedStep =
  | { tool: 'set_devices'; targets: Targets }
  | { tool: 'start_overlay'; id: string }
  | { tool: 'end_overlay' }
  | { tool: 'create_automation'; automation: Omit<Automation, 'id'> };

/** One request that reached an AI engine (or fell through the built-in parser). */
export interface AiRequestLog {
  ts: number; engine: string; text: string; reply: string; ok: boolean;
  /** Tool names in order (kept for old entries). */
  tools: string[];
  /** Each call with its args and outcome — the detail needed to see why the AI struggled. */
  calls?: { tool: string; args: unknown; ok: boolean; error?: string }[];
}
/** A learned phrase: normalized text → steps to replay locally. */
export interface LearnedEntry { ts: number; engine: string; uses: number; steps: LearnedStep[] }

const REQUESTS_KEY = 'assistant.requests';
const LEARNED_KEY = 'assistant.learned';
const MEMORY_KEY = 'assistant.memory';
const CONVO_KEY = 'assistant.conversation';
const REQUESTS_CAP = 200;
const LEARNED_CAP = 100;
const MEMORY_CAP = 50;
const CONVO_CAP = 20;
/** Older turns are dropped — a stale thread confuses the model more than no thread does. */
const CONVO_AGE_MS = 8 * 3600_000;

/**
 * One turn of the Ask Kova conversation — user said, Kova replied. A reply also keeps where it came from and its
 * undo, so a phone that was closed while it was being worked on shows it as it would have (GET /api/ask/history).
 */
export interface ConvoTurn {
  role: 'user' | 'assistant'; text: string; ts: number;
  /** The ask job it belongs to (POST /api/ask with job: true). */
  job?: string;
  source?: string; engine?: 'builtin' | 'local' | 'cloud'; undo?: string; failed?: boolean;
  /** Whose conversation it is (services/actor.ts actorKey); none: from before accounts, the owner's. */
  who?: string;
}

/** The last few exchanges, oldest first, so "yes", "the second one" and "do it" still land. */
export function convoRecent(store: Store, who?: string): ConvoTurn[] {
  const all = (store.get<ConvoTurn[]>(CONVO_KEY) ?? []).filter(t => Date.now() - t.ts < CONVO_AGE_MS);
  // Each person has their own conversation: "yes" follows what *they* were asked.
  return (who === undefined ? all : all.filter(t => (t.who ?? 'owner') === who)).slice(-CONVO_CAP);
}

/** Remember one turn of the conversation. Called for every ask, whichever side handled it. */
export function convoAdd(store: Store, role: ConvoTurn['role'], text: string, extra: Partial<Omit<ConvoTurn, 'role' | 'text'>> = {}): void {
  const t = text.trim().slice(0, 2000);
  if (!t) return;
  const turn: ConvoTurn = { role, text: t, ts: Date.now(), ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) };
  // Kept per person: each one's last exchanges, everyone's within the age limit.
  const all = (store.get<ConvoTurn[]>(CONVO_KEY) ?? []).filter(t => Date.now() - t.ts < CONVO_AGE_MS);
  const who = turn.who ?? 'owner';
  const theirs = all.filter(t => (t.who ?? 'owner') === who);
  const drop = new Set(theirs.slice(0, Math.max(0, theirs.length + 1 - CONVO_CAP)));
  store.set(CONVO_KEY, [...all.filter(t => !drop.has(t)), turn].sort((a, b) => a.ts - b.ts).slice(-CONVO_CAP * 6));
}

/** Facts the user asked the AI to keep ("note it down"): {ts, text} list, newest last. */
export function memoryList(store: Store): { ts: number; text: string }[] {
  return store.get<{ ts: number; text: string }[]>(MEMORY_KEY) ?? [];
}
/** Drop a remembered fact by index (or exact/normalized text). */
export function forgetMemory(store: Store, key: string | number): boolean {
  const all = memoryList(store);
  const i = typeof key === 'number' ? key : all.findIndex(m => norm(m.text) === norm(key) || norm(m.text).includes(norm(key)));
  if (i < 0 || i >= all.length) return false;
  all.splice(i, 1);
  store.set(MEMORY_KEY, all);
  return true;
}

/** Every request the built-in parser couldn't handle — the raw material for new intents. */
export function requestLog(store: Store): AiRequestLog[] {
  return store.get<AiRequestLog[]>(REQUESTS_KEY) ?? [];
}
/** Phrases learned from AI runs, oldest uses first shown last. */
export function learnedPhrases(store: Store): { phrase: string; ts: number; engine: string; uses: number }[] {
  const all = store.get<Record<string, LearnedEntry>>(LEARNED_KEY) ?? {};
  return Object.entries(all).map(([phrase, e]) => ({ phrase, ts: e.ts, engine: e.engine, uses: e.uses })).sort((a, b) => b.ts - a.ts);
}
/** Forget a learned phrase (by its normalized text). */
export function forgetPhrase(store: Store, key: string): boolean {
  const all = store.get<Record<string, LearnedEntry>>(LEARNED_KEY) ?? {};
  if (!(key in all)) return false;
  delete all[key];
  store.set(LEARNED_KEY, all);
  return true;
}

/** What was shared with the model, and how to map the ids it uses back to real devices. */
export interface AiContext {
  text: string;
  shared: string[];
  deviceIds: Map<string, string>;
  /** The room id the model gives → the real one (neutral `roomN` aliases when names are private). */
  roomIds: Map<string, string>;
  /** Names are shared, so real device ids are what the model sees (and may use for devices made during the ask). */
  realIds?: boolean;
}

/** The id the model knows a device by: its own id, or a neutral alias when names are private (made on first use). */
export function aliasOf(ctx: AiContext, realId: string): string {
  for (const [a, id] of ctx.deviceIds) if (id === realId) return a;
  if (ctx.realIds) { ctx.deviceIds.set(realId, realId); return realId; }
  let n = ctx.deviceIds.size + 1;
  while (ctx.deviceIds.has(`device${n}`)) n++;
  ctx.deviceIds.set(`device${n}`, realId);
  return `device${n}`;
}

/** One tool call, kept for the honest summary at the end. */
interface CallRecord {
  tool: string; args: unknown; ok: boolean; error?: string;
  /** The step as the person sees it: "Combining Bedroom TV and TV", and "combine Bedroom TV and TV" for "Couldn't …". */
  doing: string; what: string;
  /** What it did, in words, with real names ("Moved Lamp to Front door"). */
  said?: string;
  /** Things this call is about: a later call of the same tool about one of them supersedes it (a retry that worked). */
  keys: string[];
  /** Re-read after the run: null when it holds, else what's wrong. */
  verify?: () => string | null;
  /** Part of it didn't happen even though the call worked (a device that didn't answer). */
  partial?: string;
  /** Room ids the call put things in: the reply must name these rooms, not the words the person said. */
  rooms?: string[];
}

/**
 * What each tool needs of the person asking: Ask Kova acts with the asker's role, never more (services/actor.ts).
 * Switching devices is checked device by device too (a child: only their rooms).
 */
export const TOOL_PERM: Record<string, Perm> = {
  set_devices: 'control', explain_device: 'view', list_schedule: 'view', review_action: 'view',
  start_overlay: 'modes', end_overlay: 'modes',
  create_automation: 'automate', update_automation: 'automate', delete_automation: 'automate',
  remember: 'home', forget: 'home', create_room: 'home', update_device: 'home', rename_room: 'home', delete_room: 'home', combine_devices: 'home', separate_devices: 'home',
};

const MUTATING = new Set<string>(['set_devices', 'start_overlay', 'end_overlay', 'remember', 'forget', 'create_automation', 'update_automation', 'delete_automation', 'create_room', 'update_device', 'rename_room', 'delete_room', 'combine_devices', 'separate_devices']);

/** Runs tool calls against the engine, collecting undo ids. One per ask. */
export class Toolbox {
  readonly undos: string[] = [];
  /** Tool names called, in order (for the request log). */
  readonly called: string[] = [];
  /** Each call with args and outcome — enough to see why the AI struggled. */
  readonly calls: { tool: string; args: unknown; ok: boolean; error?: string }[] = [];
  /** Mutating steps that succeeded — the learnable part of this ask. */
  readonly learned: LearnedStep[] = [];
  /** What the person sees while it works. */
  readonly steps: AskStep[] = [];
  private records: CallRecord[] = [];
  /** Filled in by a tool case that worked: what it did, for the record. */
  private note: Pick<CallRecord, 'said' | 'keys' | 'verify' | 'partial' | 'rooms'> | null = null;
  /** Combined devices separated during this ask → their members, so "combine <the old id> with X" still means them. */
  private separated = new Map<string, string[]>();
  /** False once any tool reports ok:false, or the ask made a one-time schedule — such sessions aren’t learned. */
  okAll = true;
  /** The tools as the model sees them (prayer times only while they're on). */
  readonly defs: ToolDef[];
  constructor(private ai: AiAssistant, private ctx: AiContext, private onSteps?: (steps: AskStep[]) => void) {
    this.defs = toolDefs({ prayer: !!ai.config.get().prayer?.on });
  }

  /** The checker's context for an automation the model sends: real devices, the home, and what announcements can play. */
  private checkCtx() {
    return { device: (id: string) => this.ai.reg.get(id), cfg: this.ai.config.get(), now: this.ai.engine.now(), media: (m: string) => this.ai.mediaProblem?.(m) ?? null };
  }

  /** Prayer times are off: an automation the model sends mustn't start on one (existing ones keep running). */
  private prayerOff(a: unknown): string | null {
    if (this.ai.config.get().prayer?.on) return null;
    return JSON.stringify(a ?? null).includes('"prayer"') ? 'Prayer times are off in this home: the owner turns them on in Integrations → Prayer times. Don’t use prayer times; tell the user that.' : null;
  }

  /** A device the model means: its id (or alias) from the context, or — names shared — any device made since. */
  private device(alias: unknown): Device | undefined {
    if (typeof alias !== 'string') return undefined;
    const id = this.ctx.deviceIds.get(alias) ?? (this.ctx.realIds ? alias : undefined);
    const d = id ? this.ai.reg.get(id) : undefined;
    // Only what the person asking may use (a child: their rooms' devices).
    return d && !isCamera(d) && canDevice(currentActor(), d) ? d : undefined;
  }

  /** The id the model should use for a device from now on. */
  private alias(realId: string): string { return aliasOf(this.ctx, realId); }

  /** The real room id for what the model sent (a `roomN` alias when names are private), or undefined. */
  private roomId(alias: unknown): string | undefined {
    if (typeof alias !== 'string') return undefined;
    const rooms = this.ai.config.get().rooms;
    if (rooms.some(r => r.id === alias)) return alias;
    const id = this.ctx.roomIds.get(alias);
    if (id && rooms.some(r => r.id === id)) return id;
    // A room made during this ask: the model may use its id even when names are private (create_room returned it).
    return undefined;
  }

  private roomName(id: string | undefined): string {
    if (!id || id === UNASSIGNED_ROOM) return 'no room';
    return this.ai.config.get().rooms.find(r => r.id === id)?.name ?? id;
  }

  private nameOf(alias: unknown): string {
    const d = this.device(alias);
    if (d) return d.name;
    const sep = typeof alias === 'string' ? this.separated.get(this.ctx.deviceIds.get(alias) ?? alias) : undefined;
    return sep ? 'the separated device' : typeof alias === 'string' && this.ctx.realIds ? `“${alias}”` : 'a device';
  }

  /** What a call is about to do, in words, before it runs. */
  private describe(name: string, a: Record<string, unknown>): { doing: string; what: string } {
    const both = (ing: string, inf: string) => ({ doing: ing, what: inf });
    const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
    const autoName = (id: unknown) => (this.ai.config.get().automations ?? []).find(x => x.id === id)?.name;
    const roomOf = (id: unknown) => { const r = this.roomId(id); return r ? this.roomName(r) : String(id ?? ''); };
    switch (name) {
      case 'set_devices': {
        const ds = Array.isArray(a.devices) ? a.devices as Record<string, unknown>[] : [];
        if (ds.length === 1) {
          const n = this.nameOf(ds[0]?.id), on = ds[0]?.on;
          return on === false ? both(`Turning off ${n}`, `turn off ${n}`) : on === true && Object.keys(ds[0] ?? {}).length === 2 ? both(`Turning on ${n}`, `turn on ${n}`) : both(`Changing ${n}`, `change ${n}`);
        }
        return both(`Changing ${ds.length} devices`, `change ${ds.length} devices`);
      }
      case 'start_overlay': { const o = this.ai.config.get().overlays.find(x => x.id === a.id); return both(`Starting ${o?.name ?? 'the overlay'}`, `start ${o?.name ?? String(a.id)}`); }
      case 'end_overlay': return both('Ending the overlay', 'end the overlay');
      case 'explain_device': return both(`Looking into ${this.nameOf(a.id)}`, `look into ${this.nameOf(a.id)}`);
      case 'list_schedule': return both('Reading what’s planned', 'read what’s planned');
      case 'remember': return both('Remembering that', 'remember that');
      case 'forget': return both('Forgetting that', 'forget that');
      case 'create_automation': return both(`Making the automation “${String(a.name ?? '')}”`, `make the automation “${String(a.name ?? '')}”`);
      case 'update_automation': { const n = String(a.name ?? autoName(a.id) ?? a.id ?? ''); return both(`Changing the automation “${n}”`, `change the automation “${n}”`); }
      case 'delete_automation': { const n = autoName(a.id) ?? String(a.id ?? ''); return both(`Removing the automation “${n}”`, `remove the automation “${n}”`); }
      case 'create_room': return both(`Making the room ${String(a.name ?? '')}`, `make the room ${String(a.name ?? '')}`);
      case 'rename_room': return a.name ? both(`Renaming ${roomOf(a.room)} to ${String(a.name)}`, `rename ${roomOf(a.room)} to ${String(a.name)}`) : both(`Changing ${roomOf(a.room)}`, `change ${roomOf(a.room)}`);
      case 'delete_room': return both(`Removing the room ${roomOf(a.room)}`, `remove the room ${roomOf(a.room)}`);
      case 'update_device': {
        const n = this.nameOf(a.id);
        const ing: string[] = [], inf: string[] = [];
        if (typeof a.name === 'string' && a.name.trim()) { ing.push(`renaming ${n} to ${a.name.trim()}`); inf.push(`rename ${n} to ${a.name.trim()}`); }
        if (a.room != null && String(a.room).trim()) { const r = roomOf(a.room); ing.push(`moving ${ing.length ? 'it' : n} to ${r}`); inf.push(`move ${inf.length ? 'it' : n} to ${r}`); }
        if (a.hidden === true) { ing.push(`hiding ${ing.length ? 'it' : n}`); inf.push(`hide ${inf.length ? 'it' : n}`); }
        if (a.hidden === false) { ing.push(`showing ${ing.length ? 'it' : n} again`); inf.push(`show ${inf.length ? 'it' : n} again`); }
        if (typeof a.favourite === 'boolean') { ing.push(`${a.favourite ? 'favouriting' : 'unfavouriting'} ${ing.length ? 'it' : n}`); inf.push(`${a.favourite ? 'favourite' : 'unfavourite'} ${inf.length ? 'it' : n}`); }
        if (a.zoneNames && typeof a.zoneNames === 'object') { ing.push(`naming ${ing.length ? 'its' : `${n}’s`} zones`); inf.push(`name ${inf.length ? 'its' : `${n}’s`} zones`); }
        if (typeof a.loudness === 'number') { ing.push(`setting ${ing.length ? 'its' : `${n}’s`} announcement loudness to ${Math.round(a.loudness)}%`); inf.push(`set ${inf.length ? 'its' : `${n}’s`} announcement loudness to ${Math.round(a.loudness)}%`); }
        if (!ing.length) return both(`Changing ${n}`, `change ${n}`);
        const s = list(ing);
        return both(s[0]!.toUpperCase() + s.slice(1), list(inf));
      }
      case 'combine_devices': {
        const ms = Array.isArray(listArg(a.members)) ? (listArg(a.members) as unknown[]).map(m => this.nameOf(m)) : [];
        const names = [...new Set(ms)];
        return both(`Combining ${list(names) || 'devices'}`, `combine ${list(names) || 'those devices'}`);
      }
      case 'separate_devices': return both(`Separating ${this.nameOf(a.id)}`, `separate ${this.nameOf(a.id)}`);
      case 'review_action': return both('Checking that’s safe', 'check that’s safe');
      default: return both(`Running ${name}`, `run ${name}`);
    }
  }

  private emitSteps(): void { try { this.onSteps?.(this.steps.map(x => ({ ...x }))); } catch { /* a progress listener never breaks the ask */ } }

  /** A tool case that worked says what it did (for the summary) and how to check it held. */
  private done(said: string, keys: string[], extra: Pick<CallRecord, 'verify' | 'partial' | 'rooms'> = {}): void {
    this.note = { said, keys, ...extra };
  }

  /** A room zone's change as the model sent it: on/open at the top, the AC's mode under set (or at the top). */
  private zoneCommand(x: Record<string, unknown>): ZoneCommand | undefined {
    const set = x.set && typeof x.set === 'object' && !Array.isArray(x.set) ? x.set as Record<string, unknown> : {};
    const raw: Record<string, unknown> = {};
    for (const k of ZONE_FIELDS) { const v = x[k] ?? set[k]; if (v !== undefined) raw[k] = v; }
    try { return cleanZoneCommand(raw); } catch { return undefined; }
  }

  /** zoneSet keyed by a room id (or its alias) → the zone numbers of this unit that serve that room. */
  private zoneKeys(d: Device, v: unknown): unknown {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const rooms = this.ai.config.get().devices?.[d.id]?.zoneRooms ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, z] of Object.entries(v as Record<string, unknown>)) {
      if (/^[1-9]\d?$/.test(k)) { out[k] = z; continue; }
      const rid = this.roomId(k);
      const ns = rid ? Object.entries(rooms).filter(([, rs]) => rs.includes(rid)).map(([n]) => n) : [];
      if (!ns.length) return v;
      for (const n of ns) out[n] = z;
    }
    return out;
  }

  async run(name: string, input: unknown): Promise<string> {
    this.called.push(name);
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const { doing, what } = this.describe(name, args);
    const step: AskStep = { tool: name, label: doing, status: 'working' };
    this.steps.push(step);
    this.emitSteps();
    // The same call failing again means the model is guessing — tell it to stop and explain. A corrected call
    // (different arguments) gets its chance; only a tool failing over and over is stopped.
    // The same call again is only worth it when something changed in between (create_room, then the move again).
    const sig = JSON.stringify(input ?? null);
    const failed = this.calls.filter(c => c.tool === name && !c.ok);
    const lastSame = this.records.map(r => !r.ok && r.tool === name && JSON.stringify(r.args ?? null) === sig).lastIndexOf(true);
    const same = lastSame >= 0 && !this.records.slice(lastSame + 1).some(r => r.ok && MUTATING.has(r.tool)) ? 1 : 0;
    let out: string;
    const perm = TOOL_PERM[name] ?? 'owner';
    if (!allows(currentActor(), perm)) {
      // The asker's role can't do this: refused here, whatever the model sent (no way round it through Ask Kova).
      out = JSON.stringify({ ok: false, error: `${needs(perm)} Tell them you can’t do that for them; someone who can may.` });
    } else if (same >= 1 || failed.length >= 3) {
      out = JSON.stringify({ ok: false, error: same ? 'This exact call already failed. Don’t repeat it — fix what the error said, or tell the user what you can’t do.' : `This has failed ${failed.length} times. Don't try again — tell the user what you can't do or what's missing instead.` });
    } else {
      this.note = null;
      out = await this.dispatch(name, input);
    }
    let ok = true, error: string | undefined;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(out) as Record<string, unknown>;
      if (parsed.ok === false) { ok = false; error = typeof parsed.error === 'string' ? parsed.error : 'it failed'; this.okAll = false; }
    } catch { /* not json */ }
    const note = ok ? this.note : null;
    this.note = null;
    this.calls.push({ tool: name, args: input, ok, ...(error ? { error: error.slice(0, 300) } : {}) });
    const rec: CallRecord = { tool: name, args: input, ok, ...(error ? { error } : {}), doing, what, keys: note?.keys ?? this.keysOf(name, args), ...(note?.said ? { said: note.said } : {}), ...(note?.verify ? { verify: note.verify } : {}), ...(note?.partial ? { partial: note.partial } : {}), ...(note?.rooms ? { rooms: note.rooms } : {}) };
    this.records.push(rec);
    if (note?.partial) this.okAll = false;
    step.status = ok ? 'ok' : 'failed';
    if (!ok && error) step.note = error.slice(0, 200);
    else if (note?.partial) step.note = note.partial;
    this.emitSteps();
    // The model gets the result in words too, and is told to report only what results confirm.
    if (parsed) {
      if (ok && note?.said) parsed.result = note.said + (note.partial ? ` But: ${note.partial}` : '');
      if (!ok) {
        parsed.result = `Not done: couldn’t ${what}.`;
        // A shape or id problem is the model's to fix, never the person's to answer.
        parsed.next = parsed.sendInstead
          ? 'Correct the call as sendInstead shows and call the tool again now. Never ask the user about formats, ids or tool shapes.'
          : 'If the error is about an id, a shape or a missing field, fix the call and try again yourself — never ask the user about formats, ids or tool shapes. Ask the user only about a real choice (which room, which device).';
      }
      return JSON.stringify(parsed);
    }
    return out;
  }

  /** What a call is about, for matching a retry to the failure it fixes (when the call didn't say). */
  private keysOf(name: string, a: Record<string, unknown>): string[] {
    const real = (x: unknown) => (typeof x === 'string' ? this.ctx.deviceIds.get(x) ?? x : String(x));
    switch (name) {
      case 'combine_devices': return (Array.isArray(listArg(a.members)) ? listArg(a.members) as unknown[] : []).flatMap(m => { const r = real(m); return [r, ...(this.separated.get(r) ?? [])]; });
      case 'set_devices': return (Array.isArray(a.devices) ? a.devices as Record<string, unknown>[] : []).map(x => real(x?.id));
      case 'update_device': case 'separate_devices': case 'explain_device': return [real(a.id)];
      case 'create_room': return [`room:${norm(String(a.name ?? ''))}`];
      case 'rename_room': case 'delete_room': return [`room:${this.roomId(a.room) ?? String(a.room)}`];
      case 'create_automation': return [`auto:${norm(String(a.name ?? ''))}`];
      case 'update_automation': case 'delete_automation': return [`auto:${String(a.id)}`];
      default: return [name];
    }
  }

  /** Did anything change the home? */
  get changedAnything(): boolean { return this.records.some(r => r.ok && MUTATING.has(r.tool)); }

  /**
   * The honest account of the ask: each change the tools confirmed (and that still holds when re-read now), and
   * each thing that didn't happen — a failed call no later call fixed, or a change that didn't stick.
   */
  outcome(): AskOutcome {
    const done: string[] = [], couldnt: string[] = [];
    const later = (i: number, pred: (r: CallRecord) => boolean) => this.records.slice(i + 1).some(pred);
    const overlap = (a: string[], b: string[]) => a.some(k => b.includes(k));
    this.records.forEach((r, i) => {
      if (!MUTATING.has(r.tool) && r.ok) return;
      if (!r.ok) {
        // A failure a later call of the same tool fixed (a corrected retry) isn't something that didn't happen.
        if (later(i, x => x.ok && x.tool === r.tool && overlap(x.keys, r.keys))) return;
        if (!MUTATING.has(r.tool) && r.tool !== 'review_action') return;
        if (r.tool === 'review_action') return;
        couldnt.push(`${cap(r.what)}: ${tidyError(r.error)}`);
        return;
      }
      if (r.partial) couldnt.push(r.partial);
      // A later change of the same thing has the last word (renamed twice: the second name is what's true now).
      if (later(i, x => x.ok && x.tool === r.tool && overlap(x.keys, r.keys))) return;
      // Undone by its opposite later in the same ask (separated, then combined again): the later one says it.
      if (r.tool === 'separate_devices' && later(i, x => x.ok && x.tool === 'combine_devices' && overlap(x.keys, r.keys))) { if (r.said) done.push(r.said); return; }
      const problem = r.verify?.() ?? null;
      if (problem) couldnt.push(problem);
      else if (r.said) done.push(r.said);
    });
    return { done: [...new Set(done)], couldnt: [...new Set(couldnt)] };
  }

  /** The rooms this ask put things in (or made), by their names now. */
  roomsUsed(): string[] {
    const rooms = this.ai.config.get().rooms;
    return [...new Set(this.records.filter(r => r.ok).flatMap(r => r.rooms ?? []).map(id => rooms.find(x => x.id === id)?.name).filter((x): x is string => !!x))];
  }

  private async dispatch(name: string, input: unknown): Promise<string> {
    try {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      switch (name as ToolName) {
        case 'set_devices': {
          const list = Array.isArray(args.devices) ? args.devices as Record<string, unknown>[] : [];
          const targets: Targets = {};
          const unknown: string[] = [];
          const skipped: string[] = [];
          for (const x of list) {
            // A room's air conditioner zone: "zone:<room id>".
            const zm = typeof x?.id === 'string' ? /^zone:(.+)$/.exec(x.id) : null;
            if (zm) {
              const rid = this.roomId(zm[1]);
              const zc = rid ? this.zoneCommand(x) : undefined;
              if (!rid || !zc) { unknown.push(String(x.id)); continue; }
              if (!Object.keys(this.ai.reg.expandTargets({ [`zone:${rid}`]: zc as unknown as Command })).length) return JSON.stringify({ ok: false, error: `No air conditioner zone serves ${zm[1]} yet — ask the user which zone it is` });
              targets[`zone:${rid}`] = zc as unknown as Command;
              continue;
            }
            const d = this.device(x?.id);
            if (!d) { unknown.push(String(x?.id)); continue; }
            const c: Command = {};
            const has = (cap: string) => d.capabilities.includes(cap as never);
            // A field the device can't do is left out — and said, so the reply doesn't claim it ("Downlights can't dim").
            const cant = (what: string) => skipped.push(`${d.name} can’t ${what}`);
            if (typeof x.on === 'boolean') c.on = x.on;
            if (typeof x.bri === 'number' && Number.isFinite(x.bri)) { if (has('brightness')) c.bri = Math.round(Math.max(1, Math.min(100, x.bri))); else cant('dim'); }
            if (typeof x.k === 'number' && Number.isFinite(x.k)) { if (has('colorTemp')) c.k = Math.round(Math.max(1500, Math.min(9000, x.k))); else cant('change colour temperature'); }
            if (typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color)) { if (has('color')) c.color = x.color.toLowerCase(); else cant('change colour'); }
            if (typeof x.vol === 'number' && Number.isFinite(x.vol)) { if (has('volume')) c.vol = Math.round(Math.max(0, Math.min(100, x.vol))); else cant('change volume'); }
            if (typeof x.paused === 'boolean' && d.capabilities.includes('pause')) c.paused = x.paused;
            // A title only means something to a TV that finds titles itself; elsewhere media is a named source.
            if (typeof x.media === 'string' && x.media.trim() && (d.capabilities.includes('library') || this.ai.config.get().sources.some(s => s.name === x.media)
              || (d.capabilities.includes('queue') && (this.ai.reg.isMusic?.(x.media.trim()) || /^station: /i.test(x.media.trim()))))) c.media = x.media.trim().slice(0, 120);
            if (typeof x.shuffle === 'boolean' && d.capabilities.includes('queue')) c.shuffle = x.shuffle;
            if ((x.skip === 1 || x.skip === -1) && d.capabilities.includes('queue')) c.skip = x.skip;
            // Any other field the device exposes: FIELD_CAP knows which capability each needs, so
            // features work even where no screen or named parameter exists for them yet. Readings
            // (power, battery, …) are never commands. zoneSet is { "1": {on, open} } on ducted ACs.
            if (x.set && typeof x.set === 'object' && !Array.isArray(x.set)) {
              for (const [key, v] of Object.entries(x.set as Record<string, unknown>)) {
                const cap = FIELD_CAP[key];
                if (!cap || READONLY.has(key) || !d.capabilities.includes(cap)) continue;
                if (ENUMS[key] && !(typeof v === 'string' && ENUMS[key]!.includes(v))) continue;
                if (key === 'zoneSet') {
                  const zs = cleanZoneSet(this.zoneKeys(d, v));
                  if (zs) c.zoneSet = zs;
                  continue;
                }
                // extras is { name: value } — adapter-specific switches the state lists, set by name.
                if (key === 'extras') {
                  const ex: Record<string, boolean | number | string> = {};
                  if (v && typeof v === 'object' && !Array.isArray(v)) {
                    for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
                      if (typeof ev === 'boolean' || (typeof ev === 'number' && Number.isFinite(ev)) || (typeof ev === 'string' && ev)) ex[ek.slice(0, 40)] = ev;
                    }
                  }
                  if (Object.keys(ex).length) c.extras = ex;
                  continue;
                }
                if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v)) (c as Record<string, unknown>)[key] = v;
              }
            }
            if ((c.bri != null || c.k != null || c.color != null) && c.on === undefined) c.on = true;
            if (c.on === false && isPlayer(d)) c.media = null;
            if (Object.keys(c).length) targets[d.id] = c;
          }
          if (!Object.keys(targets).length) return JSON.stringify({ ok: false, error: unknown.length ? `Unknown device ids: ${unknown.join(', ')}` : skipped.length ? `${skipped.join('; ')}` : 'Nothing to change — only fields the device lists in its state can be set' });
          const r = await this.ai.engine.applyMany(targets, AI_CAUSE);
          if (r.changed.length) this.undos.push(r.undo);
          const failed = (r.failed ?? []).filter(f => f.id in targets);
          const name = (id: string) => this.ai.reg.get(id)?.name ?? id;
          if (failed.length === Object.keys(targets).length) {
            return JSON.stringify({ ok: false, error: failed.map(f => `${name(f.id)}: ${f.error}`).join('; ') });
          }
          this.learned.push({ tool: 'set_devices', targets });
          const okIds = Object.keys(targets).filter(id => !failed.some(f => f.id === id));
          const what = okIds.map(id => { const d = this.ai.reg.get(id); return d ? targetLabel(d, targets[id]!) : pseudoLabel(id, this.ai.config.get().rooms, targets[id]) ?? id; });
          const problems = [...failed.map(f => `${name(f.id)} didn’t answer (${f.error})`), ...skipped, ...(unknown.length ? [`no device ${unknown.join(', ')}`] : [])];
          this.done(what.length <= 3 ? what.join(', ') : `Changed ${what.length} devices`, Object.keys(targets), problems.length ? { partial: `Couldn’t change everything: ${problems.join('; ')}` } : {});
          return JSON.stringify({ ok: true, changed: r.changed.length, unchanged: okIds.length - r.changed.length, ...(skipped.length ? { notPossible: skipped } : {}), ...(failed.length ? { failed: failed.map(f => ({ id: this.alias(f.id), error: f.error })) } : {}), ...(unknown.length ? { unknownIds: unknown } : {}) });
        }
        case 'start_overlay': {
          const o = this.ai.config.get().overlays.find(x => x.id === args.id);
          if (!o) return JSON.stringify({ ok: false, error: `Unknown overlay ${String(args.id)}` });
          this.undos.push(await this.ai.engine.startOverlay(o.id, AI_CAUSE));
          this.learned.push({ tool: 'start_overlay', id: o.id });
          this.done(`Started ${o.name} (${o.endsLabel.toLowerCase()})`, [o.id]);
          return JSON.stringify({ ok: true, started: o.name, ends: o.endsLabel });
        }
        case 'end_overlay': {
          if (!this.ai.engine.overlay) return JSON.stringify({ ok: false, error: 'No overlay is on' });
          await this.ai.engine.endOverlay('user');
          this.learned.push({ tool: 'end_overlay' });
          this.done(`Ended the overlay — back to ${this.ai.engine.mode().name}`, ['overlay']);
          return JSON.stringify({ ok: true, mode: this.ai.engine.mode().name });
        }
        case 'remember': {
          const fact = typeof args.fact === 'string' ? args.fact.trim().slice(0, 300) : '';
          if (!fact) return JSON.stringify({ ok: false, error: 'Nothing to remember' });
          const all = memoryList(this.ai.store);
          if (all.some(m => norm(m.text) === norm(fact))) return JSON.stringify({ ok: true, already: true, fact });
          const ts = Date.now();
          this.ai.store.set(MEMORY_KEY, [...all, { ts, text: fact }].slice(-MEMORY_CAP));
          this.undos.push(this.ai.engine.registerUndo(() => { forgetMemory(this.ai.store, fact); }));
          this.done(`Remembered “${fact}”`, [`memory:${norm(fact)}`]);
          return JSON.stringify({ ok: true, fact });
        }
        case 'forget': {
          const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
          if (!fact) return JSON.stringify({ ok: false, error: 'Nothing to forget' });
          return forgetMemory(this.ai.store, fact)
            ? (this.done(`Forgot “${fact}”`, [`memory:${norm(fact)}`]), JSON.stringify({ ok: true, forgot: fact }))
            : JSON.stringify({ ok: false, error: `Nothing remembered matching "${fact}"` });
        }
        case 'explain_device': {
          const d = this.device(args.id);
          if (!d) return JSON.stringify({ ok: false, error: `Unknown device ${String(args.id)}` });
          const w = this.ai.engine.why(d.id);
          return JSON.stringify({ ok: true, on: !!d.state.on, why: w.now, next: w.next });
        }
        case 'list_schedule': {
          const e = this.ai.engine, tz = this.ai.config.get().timezone, now = e.now();
          const items = e.planner.itemsBetween(now, e.planner.kovaDayAt(now).end).filter(x => !e.skips.has(x.id)).slice(0, 10)
            .map(x => ({ at: clock(x.at, tz), label: x.label, ...(this.ai.lastShare?.names ? { what: x.what } : {}) }));
          // One-time schedules still to come, whenever they are.
          const once = e.automations.list().map(a => ({ a, at: nextOnce(a, tz, now) })).filter(x => x.at != null).sort((p, q) => p.at! - q.at!).slice(0, 10)
            .map(x => ({ at: stampWords(localStamp(x.at!, tz), now, tz), automation: x.a.id, name: x.a.name }));
          return JSON.stringify({ ok: true, items, once });
        }
        case 'create_automation': {
          try {
            const cfg = this.ai.config.get();
            const off = this.prayerOff([args.when, args.if, args.then]);
            if (off) return JSON.stringify({ ok: false, error: off });
            const a = checkAutomation(
              { name: args.name, description: args.description, triggers: listArg(args.when), conditions: listArg(args.if), actions: forMe(listArg(args.then)), mode: args.runMode, enabled: args.enabled },
              this.checkCtx());
            const id = autoSlug(a.name);
            const undo = this.ai.config.update(c => { (c.automations ??= []).push({ id, ...a }); });
            this.undos.push(this.ai.engine.registerUndo(undo));
            // A one-time schedule is tied to its date: replaying it later would make one already past.
            if (!a.triggers.some(t => t.kind === 'once')) this.learned.push({ tool: 'create_automation', automation: a });
            else this.okAll = false;
            this.ai.store.append({
              kind: 'system', device: null, feed: 'system', what: `Ask Kova made the automation “${a.name}”`,
              data: { automation: id }, cause: AI_CAUSE,
            });
            const w = { reg: this.ai.reg, cfg, now: this.ai.engine.now(), clipName: (cid: string) => this.ai.clipName?.(cid) };
            const tgt = (tid: string, cmd: object) => { const d = this.ai.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, this.ai.config.get().rooms, cmd) ?? tid); };
            const words = { when: a.triggers.map(t => triggerWords(t, w)), if: a.conditions.map(c => condWords(c, w)), then: a.actions.map(x => actionWords(x, w, tgt)) };
            // Waiting for its audio: kept, switched off, and the model asks which audio to use.
            const waiting = announceWithoutMedia(a.actions);
            if (waiting) this.okAll = false;
            this.done(`Made the automation “${a.name}”${waiting ? ' (switched off until its audio is chosen)' : ''}: when ${words.when.join(' or ')}${words.if.length ? `, if ${words.if.join(' and ')}` : ''}, ${words.then.join('; ')}`, [`auto:${norm(a.name)}`, `auto:${id}`],
              { verify: () => (this.ai.config.get().automations ?? []).some(x => x.id === id) ? null : `The automation “${a.name}” isn’t there any more.` });
            return JSON.stringify({ ok: true, id, name: a.name, ...words, ...(waiting ? { enabled: false, next: 'It is saved switched off because no audio was chosen. Ask the user which audio to play (offer the recordings, clips and sources from the context by name); then update_automation with media and it switches on. Never guess a URL.' } : {}) });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof CheckError && e.fix ? { sendInstead: e.fix } : {}) }); }
        }
        case 'update_automation': {
          try {
            const cfg = this.ai.config.get();
            const id = String(args.id ?? '');
            const cur = (cfg.automations ?? []).find(a => a.id === id);
            if (!cur) return JSON.stringify({ ok: false, error: `No automation ${id} — use an id from the Automations list` });
            const off = this.prayerOff([args.when, args.if, args.then]);
            if (off && !JSON.stringify([cur.triggers, cur.conditions, cur.actions]).includes('"prayer"')) return JSON.stringify({ ok: false, error: off });
            const a = checkAutomation(
              {
                name: args.name ?? cur.name, description: args.description ?? cur.description,
                triggers: listArg(args.when) ?? cur.triggers, conditions: listArg(args.if) ?? cur.conditions,
                actions: forMe(listArg(args.then)) ?? cur.actions, mode: args.runMode ?? cur.mode,
                // An announcement given its audio now switches on (it was kept off waiting for it), unless asked otherwise.
                enabled: args.enabled ?? (cur.enabled || (announceWithoutMedia(cur.actions) && args.then !== undefined)),
              },
              this.checkCtx());
            const undo = this.ai.config.update(c => {
              const i = (c.automations ?? []).findIndex(x => x.id === id);
              if (i >= 0) c.automations![i] = { ...c.automations![i]!, ...a };
            });
            this.undos.push(this.ai.engine.registerUndo(undo));
            this.ai.store.append({
              kind: 'system', device: null, feed: 'system', what: `Ask Kova changed the automation “${a.name}”`,
              data: { automation: id }, cause: AI_CAUSE,
            });
            const w = { reg: this.ai.reg, cfg, now: this.ai.engine.now(), clipName: (cid: string) => this.ai.clipName?.(cid) };
            const tgt = (tid: string, cmd: object) => { const d = this.ai.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, this.ai.config.get().rooms, cmd) ?? tid); };
            const words = { when: a.triggers.map(t => triggerWords(t, w)), if: a.conditions.map(c => condWords(c, w)), then: a.actions.map(x => actionWords(x, w, tgt)) };
            this.done(`Changed the automation “${a.name}”${a.enabled ? '' : ' (it’s off)'}: when ${words.when.join(' or ')}${words.if.length ? `, if ${words.if.join(' and ')}` : ''}, ${words.then.join('; ')}`, [`auto:${id}`, `auto:${norm(a.name)}`]);
            return JSON.stringify({ ok: true, id, name: a.name, ...words });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof CheckError && e.fix ? { sendInstead: e.fix } : {}) }); }
        }
        case 'delete_automation': {
          try {
            const cfg = this.ai.config.get();
            const id = String(args.id ?? '');
            const cur = (cfg.automations ?? []).find(a => a.id === id);
            if (!cur) return JSON.stringify({ ok: false, error: `No automation ${id} — use an id from the Automations list` });
            const undo = this.ai.config.update(c => { c.automations = (c.automations ?? []).filter(a => a.id !== id); });
            this.undos.push(this.ai.engine.registerUndo(undo));
            this.ai.store.append({
              kind: 'system', device: null, feed: 'system', what: `Ask Kova removed the automation “${cur.name}”`,
              data: { automation: id }, cause: AI_CAUSE,
            });
            this.done(`Removed the automation “${cur.name}”`, [`auto:${id}`, `auto:${norm(cur.name)}`]);
            return JSON.stringify({ ok: true, id, name: cur.name });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof CheckError && e.fix ? { sendInstead: e.fix } : {}) }); }
        }
        case 'create_room': {
          const name = typeof args.name === 'string' ? args.name.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
          if (!name) return JSON.stringify({ ok: false, error: 'Give the room a name' });
          const icon = typeof args.icon === 'string' && (ROOM_ICONS as readonly string[]).includes(args.icon) ? args.icon : 'meeting_room';
          const rooms = this.ai.config.get().rooms;
          // The room already exists by that name: use it rather than making a second one.
          const same = rooms.find(r => norm(r.name) === norm(name));
          if (same) {
            this.ctx.roomIds.set(same.id, same.id);
            this.done(`${same.name} was already a room`, [`room:${norm(name)}`, `room:${same.id}`], { rooms: [same.id] });
            return JSON.stringify({ ok: true, id: same.id, name: same.name, already: true });
          }
          let id = slug(name) || 'room', n = 2;
          while (rooms.some(r => r.id === id)) id = `${slug(name) || 'room'}_${n++}`;
          const undo = this.ai.config.update(c => { c.rooms.push({ id, name, icon }); });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.ai.store.append({ kind: 'system', device: null, feed: 'system', what: `Ask Kova made the room “${name}”`, data: { room: id }, cause: AI_CAUSE });
          // The model may now use the new id, even when names are private.
          this.ctx.roomIds.set(id, id);
          this.done(`Made the room ${name}`, [`room:${norm(name)}`, `room:${id}`], { rooms: [id], verify: () => this.ai.config.get().rooms.some(r => r.id === id) ? null : `The room ${name} isn’t there any more.` });
          return JSON.stringify({ ok: true, id, name });
        }
        case 'update_device': {
          const d = this.device(args.id);
          if (!d) return JSON.stringify({ ok: false, error: `Unknown device ${String(args.id)}` });
          const rawRoom = args.room == null ? undefined : String(args.room).trim();
          const room = !rawRoom ? rawRoom : rawRoom === UNASSIGNED_ROOM ? UNASSIGNED_ROOM : this.roomId(rawRoom);
          if (rawRoom && !room) return JSON.stringify({ ok: false, error: `Unknown room ${rawRoom} — use an id from the Rooms list, or create_room first` });
          const name = args.name == null ? undefined : String(args.name).trim().replace(/\s+/g, ' ').slice(0, 60);
          if (name === '') return JSON.stringify({ ok: false, error: 'Give it a name' });
          const favourite = typeof args.favourite === 'boolean' ? args.favourite : undefined;
          const hidden = typeof args.hidden === 'boolean' ? args.hidden : undefined;
          // A ducted AC's zones by number: { "1": "Living", "2": "Theatre" } (an empty name clears one).
          let zoneNames: Record<string, string> | undefined;
          const zn = listArg(args.zoneNames);
          if (zn !== undefined && zn !== null) {
            if (typeof zn !== 'object' || Array.isArray(zn) || Object.keys(zn).some(n => !/^[1-9]\d?$/.test(n))) return JSON.stringify({ ok: false, error: 'zoneNames is { "1": "Living", "2": "Theatre" } by zone number' });
            if (!d.capabilities.includes('zones')) return JSON.stringify({ ok: false, error: `${d.name} has no zones` });
            const have = new Set((d.state.zones ?? []).map(z => String(z.n)));
            const bad = Object.keys(zn).filter(n => have.size && !have.has(n));
            if (bad.length) return JSON.stringify({ ok: false, error: `${d.name} has no zone ${bad.join(', ')} — its zones are ${[...have].join(', ')}` });
            zoneNames = Object.fromEntries(Object.entries(zn as Record<string, unknown>).map(([n, v]) => [n, typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 30) : '']));
          }
          // A speaker's announcement loudness: % of the level an announcement asks for.
          let loudness: number | undefined;
          if (args.loudness !== undefined && args.loudness !== null) {
            const v = Number(args.loudness);
            if (!canAnnounce(d)) return JSON.stringify({ ok: false, error: `${d.name} isn’t a speaker announcements play on` });
            if (!Number.isFinite(v) || v < 20 || v > 200) return JSON.stringify({ ok: false, error: 'loudness is 20–200 (% of the level asked for; 100 = as asked)' });
            loudness = Math.round(v);
          }
          if (name === undefined && room === undefined && favourite === undefined && hidden === undefined && !zoneNames && loudness === undefined) return JSON.stringify({ ok: false, error: 'Nothing to change' });
          // Same override model as PATCH /api/devices/:id/settings: store only what differs from the adapter's own.
          const orig = d.original ?? { name: d.name, room: d.room };
          const was = d.name;
          const undo = this.ai.config.update(c => {
            const s = { ...(c.devices?.[d.id] ?? {}) };
            if (name !== undefined) { if (name === orig.name) delete s.name; else s.name = name; }
            if (room !== undefined) { if (!room || room === orig.room) delete s.room; else s.room = room; }
            if (hidden !== undefined) { if (hidden) s.hidden = true; else delete s.hidden; }
            if (zoneNames) {
              const z = { ...(s.zoneNames ?? {}) };
              for (const [n, v] of Object.entries(zoneNames)) { if (v) z[n] = v; else delete z[n]; }
              if (Object.keys(z).length) s.zoneNames = z; else delete s.zoneNames;
            }
            if (loudness !== undefined) { if (loudness === 100) delete s.announceTrim; else s.announceTrim = loudness; }
            c.devices = { ...(c.devices ?? {}) };
            if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
            if (favourite !== undefined) { const f = (c.favourites ?? []).filter(x => x !== d.id); c.favourites = favourite ? [...f, d.id] : f; }
            // A combined device keeps its own room in its entry (that's what it's announced with).
            if (room !== undefined && d.adapter === 'combined') {
              const x = (c.combined ?? []).find(y => `combined_${y.id}` === d.id);
              if (x) { if (room && room !== UNASSIGNED_ROOM) x.room = room; else delete x.room; }
            }
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          const roomName = room !== undefined ? this.roomName(room || orig.room) : undefined;
          const bits: string[] = [];
          if (name) bits.push(`renamed ${was} “${name}”`);
          if (room !== undefined) bits.push(`moved ${name ? 'it' : was} to ${roomName}`);
          if (favourite === true) bits.push(`put ${bits.length ? 'it' : was} on favourites`); else if (favourite === false) bits.push(`took ${bits.length ? 'it' : was} off favourites`);
          if (hidden === true) bits.push(`hid ${bits.length ? 'it' : was}`); else if (hidden === false) bits.push(`showed ${bits.length ? 'it' : was} again`);
          if (zoneNames) bits.push(`named ${bits.length ? 'its' : `${was}’s`} zones (${Object.entries(zoneNames).map(([n, v]) => v ? `${n}: ${v}` : `${n}: no name`).join(', ')})`);
          if (loudness !== undefined) bits.push(`set ${bits.length ? 'its' : `${was}’s`} announcement loudness to ${loudness}%`);
          const said = cap(bits.join(' and '));
          this.ai.store.append({ kind: 'system', device: d.id, feed: 'system', what: `Ask Kova ${bits.join(' and ') || 'updated'} — ${was}`, data: { device: d.id }, cause: AI_CAUSE });
          const id = d.id;
          this.done(said, [id], {
            ...(room !== undefined && room !== UNASSIGNED_ROOM && (room || orig.room) ? { rooms: [room || orig.room] } : {}),
            // Re-read the device: the registry applies the settings, so this is what every screen now shows.
            verify: () => {
              const now = this.ai.reg.get(id);
              if (!now) return `${was} isn’t there any more.`;
              const want = room === undefined || room === UNASSIGNED_ROOM ? undefined : room || orig.room;
              if (want !== undefined && now.room !== want) return `${now.name} is still in ${this.roomName(now.room)}, not ${roomName}.`;
              if (name !== undefined && now.name !== name) return `${now.name} wasn’t renamed to ${name}.`;
              if (hidden !== undefined && !!now.hidden !== hidden) return `${now.name} ${hidden ? 'still shows' : 'is still hidden'}.`;
              if (loudness !== undefined && trimOf(this.ai.config.get(), id) !== loudness) return `${now.name}’s announcement loudness isn’t ${loudness}%.`;
              return null;
            },
          });
          return JSON.stringify({ ok: true, id: this.alias(d.id), name: name ?? d.name, room: room !== undefined ? (room || orig.room) : d.room, ...(roomName ? { roomName } : {}), ...(zoneNames ? { zoneNames } : {}), ...(loudness !== undefined ? { loudness } : {}) });
        }
        case 'rename_room': {
          const rid = this.roomId(args.room);
          const room = rid ? this.ai.config.get().rooms.find(r => r.id === rid) : undefined;
          if (!room) return JSON.stringify({ ok: false, error: `Unknown room ${String(args.room)} — use an id from the Rooms list` });
          const name = args.name === undefined ? undefined : String(args.name).trim().replace(/\s+/g, ' ').slice(0, 40);
          if (name === '') return JSON.stringify({ ok: false, error: 'Give the room a name' });
          const icon = typeof args.icon === 'string' && (ROOM_ICONS as readonly string[]).includes(args.icon) ? args.icon : undefined;
          if (name === undefined && icon === undefined) return JSON.stringify({ ok: false, error: 'Nothing to change' });
          const was = room.name;
          const undo = this.ai.config.update(c => { const r = c.rooms.find(x => x.id === room.id)!; if (name) r.name = name; if (icon) r.icon = icon; });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.ai.store.append({ kind: 'system', device: null, feed: 'system', what: `Ask Kova renamed the room “${was}” to “${name ?? was}”`, data: { room: room.id }, cause: AI_CAUSE });
          const rid2 = room.id, want = name ?? room.name;
          this.done(name && name !== was ? `Renamed the room ${was} to ${name}` : `Changed the room ${was}’s icon`, [`room:${room.id}`], { rooms: [room.id],
            verify: () => this.ai.config.get().rooms.find(r => r.id === rid2)?.name === want ? null : `The room ${was} wasn’t renamed to ${want}.` });
          return JSON.stringify({ ok: true, id: room.id, name: want });
        }
        case 'delete_room': {
          const cfg = this.ai.config.get();
          const rid = this.roomId(args.room);
          const room = rid ? cfg.rooms.find(r => r.id === rid) : undefined;
          if (!room) return JSON.stringify({ ok: false, error: `Unknown room ${String(args.room)} — use an id from the Rooms list` });
          const inside = this.ai.reg.list().filter(d => d.room === room.id);
          const rawMove = args.moveTo === undefined ? undefined : String(args.moveTo);
          const moveTo = rawMove === undefined ? undefined : rawMove === UNASSIGNED_ROOM ? UNASSIGNED_ROOM : this.roomId(rawMove);
          if (inside.length && moveTo === undefined) return JSON.stringify({ ok: false, error: `${inside.length} device${inside.length === 1 ? ' is' : 's are'} in ${room.name} — ask where they should go, then call again with moveTo` });
          if (moveTo !== undefined && moveTo === room.id) return JSON.stringify({ ok: false, error: 'Choose a different room to move them to' });
          if (rawMove !== undefined && moveTo === undefined) return JSON.stringify({ ok: false, error: `Unknown room ${rawMove} to move devices to` });
          const undo = this.ai.config.update(c => {
            c.rooms = c.rooms.filter(r => r.id !== room.id);
            c.devices = { ...(c.devices ?? {}) };
            for (const d of inside) {
              const orig = d.original?.room ?? d.room;
              const s = { ...(c.devices[d.id] ?? {}) };
              if (moveTo === orig) delete s.room; else s.room = moveTo;
              if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
            }
            for (const [g, rooms] of Object.entries(c.groups)) c.groups[g] = rooms.filter(r => r !== room.id);
            for (const x of c.combined ?? []) if (x.room === room.id) { if (moveTo && moveTo !== UNASSIGNED_ROOM) x.room = moveTo; else delete x.room; }
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.ai.store.append({ kind: 'system', device: null, feed: 'system', what: `Ask Kova removed the room “${room.name}”${inside.length ? `, ${inside.length} device${inside.length === 1 ? '' : 's'} moved` : ''}`, data: { room: room.id, moved: inside.map(d => d.id) }, cause: AI_CAUSE });
          this.done(`Removed the room ${room.name}${inside.length ? ` (${inside.length} device${inside.length === 1 ? '' : 's'} moved to ${this.roomName(moveTo)})` : ''}`, [`room:${room.id}`]);
          return JSON.stringify({ ok: true, removed: room.id, moved: inside.map(d => this.alias(d.id)) });
        }
        case 'combine_devices': {
          const cfg = this.ai.config.get();
          const list0 = listArg(args.members);
          const raw = Array.isArray(list0) ? [...new Set(list0.map(String))] : [];
          // What the model may pass: plain devices, a combined device (to add to it), a part of one, or a combined
          // device it separated earlier in this ask (it means that device's parts).
          const combos = cfg.combined ?? [];
          const comboOf = (id: string) => combos.find(x => `combined_${x.id}` === id) ?? combos.find(x => x.members.includes(id));
          const devs: Device[] = [], unknown: string[] = [];
          const into = new Set<string>();
          for (const m of raw) {
            const real = this.ctx.deviceIds.get(m) ?? m;
            const sep = this.separated.get(real);
            if (sep) { for (const id of sep) { const d = this.ai.reg.get(id); if (d) devs.push(d); } continue; }
            const d = this.device(m);
            if (!d) { unknown.push(m); continue; }
            if (d.adapter === 'groups') return JSON.stringify({ ok: false, error: `${d.name} is a speaker group, not one device` });
            if (d.adapter === 'combined') { const x = comboOf(d.id); if (x) into.add(x.id); continue; }
            const x = comboOf(d.id);
            if (x) into.add(x.id);
            devs.push(d);
          }
          if (unknown.length) return JSON.stringify({ ok: false, error: `Unknown device ids: ${unknown.join(', ')}` });
          const targets = [...into].map(id => combos.find(x => x.id === id)!).filter(Boolean);
          const memberIds = [...new Set([...targets.flatMap(x => x.members), ...devs.map(d => d.id)])];
          if (memberIds.length < 2) return JSON.stringify({ ok: false, error: targets.length ? `${targets[0]!.name} already has ${targets[0]!.members.map(id => this.ai.reg.get(id)?.name ?? id).join(' and ')} — name a device to add to it` : 'Pick at least two devices' });
          const reqName = typeof args.name === 'string' ? args.name.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
          const room = args.room == null || args.room === '' ? undefined : this.roomId(args.room);
          if (args.room != null && args.room !== '' && !room) return JSON.stringify({ ok: false, error: `Unknown room ${String(args.room)} — use an id from the Rooms list, or create_room first` });
          const keep = targets[0];
          // Into an existing combined device: it keeps its id (and anything that uses it), and gains the new parts.
          const name = reqName || keep?.name || devs[0]!.name;
          let id = keep?.id ?? (slug(name) || 'device');
          if (!keep) { let n = 2; while (combos.some(x => x.id === id)) id = `${slug(name) || 'device'}_${n++}`; }
          const added = memberIds.filter(m => !keep?.members.includes(m));
          if (keep && !added.length && targets.length === 1 && (!reqName || reqName === keep.name) && (!room || room === keep.room)) {
            this.done(`${keep.name} already stands for ${andList(keep.members.map(m => this.ai.reg.get(m)?.name ?? m))}`, [`combined_${keep.id}`, ...keep.members]);
            return JSON.stringify({ ok: true, id: this.alias(`combined_${keep.id}`), name: keep.name, already: true, parts: keep.members.map(m => this.alias(m)) });
          }
          const undo = this.ai.config.update(c => {
            c.devices ??= {};
            const list = c.combined ?? [];
            // Parts hidden by being combined (not hidden by the owner before) — they show again when separated.
            const hidBefore = new Set(list.filter(x => into.has(x.id)).flatMap(x => x.hid ?? []));
            const newHid = memberIds.filter(m => !hidBefore.has(m) && !c.devices![m]?.hidden);
            for (const m of newHid) c.devices[m] = { ...c.devices[m], hidden: true };
            const hid = [...memberIds.filter(m => hidBefore.has(m)), ...newHid];
            const merged = { id, name, members: memberIds, hid, ...(room ? { room } : keep?.room ? { room: keep.room } : {}) };
            c.combined = keep ? list.filter(x => x.id === id || !into.has(x.id)).map(x => x.id === id ? merged : x) : [...list, merged];
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          const realId = `combined_${id}`;
          const partNames = memberIds.map(m => this.ai.reg.get(m)?.name ?? m);
          this.ai.store.append({ kind: 'system', device: realId, feed: 'system', what: keep ? `Ask Kova added ${andList(added.map(m => this.ai.reg.get(m)?.name ?? m))} to “${name}”` : `Ask Kova shows ${andList(partNames)} as one — “${name}”`, data: { combined: id, members: memberIds }, cause: AI_CAUSE });
          const roomName = room ? this.roomName(room) : undefined;
          const said = keep
            ? `${added.length ? `Added ${andList(added.map(m => this.ai.reg.get(m)?.name ?? m))} to` : 'Updated'} ${name}${keep.name !== name ? ` (was ${keep.name})` : ''} — it now stands for ${andList(partNames)}${roomName ? `, in ${roomName}` : ''}`
            : `Combined ${andList(partNames)} into one device, “${name}”${roomName ? `, in ${roomName}` : ''}`;
          this.done(said, [realId, ...memberIds], {
            ...(room ? { rooms: [room] } : {}),
            verify: () => {
              const x = (this.ai.config.get().combined ?? []).find(y => y.id === id);
              if (!x || !memberIds.every(m => x.members.includes(m))) return `${name} isn’t combined after all.`;
              const d = this.ai.reg.get(realId);
              if (!d) return `${name} didn’t show up as one device.`;
              if (room && d.room !== room) return `${name} is in ${this.roomName(d.room)}, not ${roomName}.`;
              const showing = memberIds.filter(m => this.ai.reg.get(m) && !this.ai.reg.get(m)!.hidden);
              if (showing.length) return `${showing.map(m => this.ai.reg.get(m)!.name).join(' and ')} still show${showing.length === 1 ? 's' : ''} separately.`;
              return null;
            },
          });
          return JSON.stringify({ ok: true, id: this.alias(realId), name, parts: memberIds.map(m => this.alias(m)), ...(roomName ? { room: room!, roomName } : {}) });
        }
        case 'separate_devices': {
          const real = typeof args.id === 'string' ? (this.ctx.deviceIds.get(args.id) ?? String(args.id)) : String(args.id ?? '');
          const list = this.ai.config.get().combined ?? [];
          // The combined device's id, its config id, or one of its parts ("separate the TV").
          const x = list.find(c => `combined_${c.id}` === real || c.id === real.replace(/^combined_/, '')) ?? list.find(c => c.members.includes(real));
          if (!x) return JSON.stringify({ ok: false, error: this.separated.has(real) ? `${String(args.id)} is already separated` : `No combined device ${String(args.id)}` });
          const undo = this.ai.config.update(c => {
            for (const m of x.hid ?? []) if (c.devices?.[m]) delete c.devices[m].hidden;
            c.combined = (c.combined ?? []).filter(y => y.id !== x.id);
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.separated.set(`combined_${x.id}`, [...x.members]);
          this.ai.store.append({ kind: 'system', device: `combined_${x.id}`, feed: 'system', what: `Ask Kova separated “${x.name}” back into its devices`, data: { combined: x.id }, cause: AI_CAUSE });
          const parts = x.members.filter(m => this.ai.reg.get(m));
          this.done(`Separated ${x.name} back into ${parts.map(m => this.ai.reg.get(m)!.name).join(' and ')}`, [`combined_${x.id}`, ...x.members], {
            verify: () => (this.ai.config.get().combined ?? []).some(y => y.id === x.id && x.members.every(m => y.members.includes(m))) ? `${x.name} is still combined.` : null,
          });
          return JSON.stringify({ ok: true, separated: this.alias(`combined_${x.id}`), parts: parts.map(m => ({ id: this.alias(m), name: this.ai.lastShare?.names ? this.ai.reg.get(m)!.name : undefined })) });
        }
        case 'review_action': {
          const action = typeof args.action === 'string' ? args.action.trim() : '';
          if (!action) return JSON.stringify({ ok: false, error: 'Give the action to review' });
          const jev = this.ai.jev;
          if (!jev?.configured) return JSON.stringify({ ok: false, error: 'Jev is not configured on this hub' });
          try {
            const r = await jev.gate(action, typeof args.context === 'string' ? args.context : '');
            return JSON.stringify({ ok: true, recommendation: r.recommendation, riskScore: r.riskScore, safeProbability: r.safeProbability, note: r.note });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), ...(e instanceof CheckError && e.fix ? { sendInstead: e.fix } : {}) }); }
        }
        default:
          return JSON.stringify({ ok: false, error: `Unknown tool ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------- engines --

export interface EngineResult {
  text: string;
  /** It was still calling tools when the round limit came: what it did stands, the reply says it didn't finish. */
  unfinished?: boolean;
}

/** A plain conversation turn passed to an engine — the recent thread, ending with the current request. */
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** One AI backend. `run` drives the tool loop and returns the final text; it may throw. */
export interface AiEngine {
  readonly kind: 'local' | 'cloud';
  readonly label: string;
  run(system: string, chat: ChatTurn[], tools: Toolbox): Promise<EngineResult>;
}

/**
 * The engine Ask Kova uses for what the built-in parser can't do, for headers and footers: its kind, its name
 * ("MiniMax", "Local AI") and whether it's set up enough to run.
 */
export function engineInfo(s: AssistantSettings): { kind: EngineKind; label: string; model?: string; ready: boolean } {
  if (s.engine === 'local') return { kind: 'local', label: 'Local AI', ...(s.local.model ? { model: s.local.model } : {}), ready: !!(s.local.url && s.local.model) };
  if (s.engine === 'cloud') {
    const p = CLOUD_PROVIDERS[s.cloud.provider] ?? CLOUD_PROVIDERS.anthropic;
    return { kind: 'cloud', label: p.label, model: s.cloud.model || p.defaultModel, ready: !!s.cloud.apiKey && !!(s.cloud.provider === 'anthropic' || s.cloud.baseUrl || p.baseUrl) };
  }
  return { kind: 'builtin', label: 'Built in', ready: true };
}

/** Friendly reason a request failed, safe to show the user. */
export class AiError extends Error {}

/** Any OpenAI-compatible chat-completions server: Ollama, LM Studio, llama.cpp, vLLM, MiniMax, OpenAI. */
export class LocalAiEngine implements AiEngine {
  readonly kind: 'local' | 'cloud';
  readonly label: string;
  /** Lowercase name for inside error sentences, e.g. 'your local AI' or 'MiniMax'. */
  private name: string;
  constructor(private opts: { url: string; model: string; apiKey?: string; timeoutMs: number; label?: string; kind?: 'local' | 'cloud'; name?: string }) {
    this.label = opts.label ?? 'Local AI';
    this.kind = opts.kind ?? 'local';
    this.name = opts.name ?? 'your local AI';
  }

  private cap(): string { return this.name ? this.name[0]!.toUpperCase() + this.name.slice(1) : this.name; }

  /** http://host:11434 → http://host:11434/v1/chat/completions; full endpoints are used as given. */
  get endpoint(): string {
    const u = this.opts.url.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(u)) return u;
    return `${/\/v\d+$/.test(u) ? u : `${u}/v1`}/chat/completions`;
  }

  async run(system: string, chat: ChatTurn[], tools: Toolbox): Promise<EngineResult> {
    type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
    type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
    const messages: Msg[] = [{ role: 'system', content: system }, ...chat];
    // Each round trip has its own time limit: a long request that keeps making progress is never cut off.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const deadline = Date.now() + this.opts.timeoutMs;
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          body: JSON.stringify({
            model: this.opts.model,
            messages,
            tools: tools.defs.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: 'auto',
            stream: false,
          }),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AiError(timedOut ? `${this.cap()} at ${this.opts.url} took too long to answer.` : `Couldn’t reach ${this.name} at ${this.opts.url}.`);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ').trim();
        throw new AiError(`${this.cap()} at ${this.opts.url} returned an error (${res.status}${detail ? `: ${detail}` : ''}).`);
      }
      let body: { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
      try { body = await res.json() as typeof body; } catch { throw new AiError(`${this.cap()} at ${this.opts.url} sent a reply Kova couldn’t read.`); }
      const msg = body.choices?.[0]?.message;
      if (!msg) throw new AiError(`${this.cap()} at ${this.opts.url} sent an empty reply.`);
      const calls = (msg.tool_calls ?? []).filter(c => c?.function?.name);
      if (!calls.length) return { text: stripThink(msg.content ?? '') };
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const c of calls) {
        let input: unknown = {};
        try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = null; }
        const result = input === null ? JSON.stringify({ ok: false, error: 'Arguments were not valid JSON' }) : await tools.run(c.function.name, input);
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
    }
    return { text: '', unfinished: true };
  }
}

/** Models that accept `output_config.effort` and server-side `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const EFFORT_MODEL = /^claude-(opus-5|opus-4-[5678]|sonnet-5|fable-5|mythos-5)/;

/** Anthropic Messages API with the user's own key. */
export class CloudAiEngine implements AiEngine {
  readonly kind = 'cloud' as const;
  readonly label = 'Cloud AI';
  private client: Anthropic;
  constructor(private opts: { apiKey: string; model: string; baseURL?: string; timeoutMs: number }) {
    // authToken: null so a host-level ANTHROPIC_AUTH_TOKEN is never sent alongside the user's key.
    this.client = new Anthropic({ apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL, timeout: opts.timeoutMs, maxRetries: 1 });
  }

  async run(system: string, chat: ChatTurn[], tools: Toolbox): Promise<EngineResult> {
    const model = this.opts.model;
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = chat.map(t => ({ role: t.role, content: t.content }));
    const toolDefsA: Anthropic.Beta.Messages.BetaTool[] = tools.defs.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters as unknown as Anthropic.Beta.Messages.BetaTool.InputSchema }));
    const fallback = FALLBACK_MODELS.has(model);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await this.client.beta.messages.create({
          model,
          max_tokens: 16000,
          system,
          messages,
          tools: toolDefsA,
          ...(EFFORT_MODEL.test(model) ? { output_config: { effort: 'low' as const } } : {}),
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new AiError('Cloud AI rejected your API key. Check it in Assistant settings.');
        if (err instanceof Anthropic.NotFoundError) throw new AiError(`Cloud AI doesn’t know the model “${model}”. Check it in Assistant settings.`);
        if (err instanceof Anthropic.RateLimitError) throw new AiError('Cloud AI is rate-limiting your key right now. Try again in a minute.');
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError('Cloud AI took too long to answer.');
        if (err instanceof Anthropic.APIConnectionError) throw new AiError('Couldn’t reach Cloud AI. Check the hub’s internet connection.');
        if (err instanceof Anthropic.APIError) throw new AiError(`Cloud AI returned an error (${err.status ?? 'unknown'}).`);
        throw err;
      }
      if (msg.stop_reason === 'refusal') return { text: 'Cloud AI declined to help with that.' };
      const text = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
      const calls = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !calls.length) {
        if (msg.stop_reason === 'max_tokens' && !text) throw new AiError('Cloud AI ran out of room before answering.');
        return { text };
      }
      // Pass the whole assistant turn back unchanged (thinking blocks included), then all results in one user turn.
      messages.push({ role: 'assistant', content: msg.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const c of calls) {
        const out = await tools.run(c.name, c.input);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out, ...(JSON.parse(out).ok === false ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: '', unfinished: true };
  }
}

// -------------------------------------------------------------- assistant --

const SYSTEM = `You are Ask Kova, the assistant for a smart home hub. The hub's built-in parser couldn't handle this request, so it was passed to you.
Use the tools to act: set_devices, start_overlay, end_overlay, explain_device, list_schedule, create_automation, update_automation, delete_automation, create_room, rename_room, delete_room, update_device, combine_devices, separate_devices, remember, forget, review_action. Only use device, room, overlay, mode and person ids from the home context below; never invent ids. When the user answers a question you just asked (yes, sure, the second one, do it), read the recent conversation to see what it refers to before answering.
Anything asked to happen regularly, at a time, or when something else happens is an automation — build it with create_automation, then tell the user what it will do in the words the tool returns. A single change later ("at 9pm", "in an hour") is a one-time schedule: create_automation with a once trigger.
For destructive, broad, privacy-sensitive, security-sensitive, or hard-to-undo actions, call review_action first. If it says confirm, ask the user to confirm before acting; if it says block, do not do it. Do not use it for routine light, media, or climate changes.
Ducted air conditioner zones are numbered; a zone only has a name when the state lists one, and the rooms it serves when "AC zones by room" lists them. For a room ("cool the bedroom", "turn off the AC in the study", "open the lounge zone to 50%") use set_devices with id "zone:<room id>": "cool"/"heat" opens the zone with set.hvac; "turn off the AC in" a room only closes its zone (Kova turns the AC off by itself when no zone is left open); never turn the whole AC off for one room. If a room has no zone listed, ask which zone serves it instead of guessing.
Big requests come in several parts: work through every part, one tool call per change, and check each result before the next step. Several things that are "the same device" go into ONE combine_devices call; to add to a device that is already combined, pass its combined id with the new members (no need to separate it first).
Rooms: use a room only if it is in the Rooms list under that name (or plainly the same name, e.g. "living" for "Living room"). If the user names a room that isn't there ("entryway" when there is only "Front door"), create it with create_room and use the id it returns — never put the device in a different room that seems close. If you can't tell whether they mean an existing room, ask. In the reply, call every room by the name the tool result gives.
When a tool call fails because of how it was written (an unknown kind, a bad time, a wrong id), correct it and call again — the error says what to send instead. Never ask the user about formats, ids, schemas or tool shapes; they don't know them and shouldn't see them. Ask the user only about real choices (which automations, which room).
A request about a group ("the light automations that start at sunset", "all the bedroom lights") means every match: find them all in the home context, change each one (one call each), then name each in the reply.
Tool results are the truth: each has ok, and when it worked a "result" saying what changed, with real names. Report only what results confirmed. If any call returned ok:false, say plainly what didn't happen and why — never say "all done", "done" or "everything's set" unless every part worked. Don't claim a change you didn't make with a tool.
Announcements ("play X on all speakers at 15%", a chime, a call to prayer): one automation with an announce step. vol is the level the owner says; each speaker plays it times its own announcement loudness. List every speaker in targets (devices with "speaker": true, or a speaker group); players such as a Helix box or a TV that should stop for it go in pause (they carry on after); restore true puts every speaker back as it was. If the owner didn't say which audio and none in the context plainly fits, leave media out (the automation is saved switched off) and ask which to use, naming the choices; never guess or invent a URL. When the owner says some speakers are louder or quieter than others, suggest an announcement loudness for each (e.g. 80, 70, 60 for louder, louder still, loudest) in the reply and ask them to confirm; set them with update_device loudness only once they agree, then say what each is now.
If the request can't be done with these tools or the shared context, say so plainly instead of guessing. Reply like a text message — plain text only, no markdown (never ** or # or \` characters — they show raw in the chat). Keep it short: a sentence or two usually; when listing several things, one item per line starting with "- ". Refer to automations and devices by their names, not their ids.`;

/** Only while prayer times are on. */
const PRAYER_SYSTEM = `Prayer times: "every prayer", "each call to prayer" means the five daily prayers: five time triggers {kind:'time', at:{kind:'prayer', prayer:'fajr'}} for fajr, dhuhr, asr, maghrib and isha in ONE automation (or one trigger {kind:'time', at:{kind:'prayer', prayer:'all'}}, which the hub turns into the five). A call to prayer (adhan) is an announce step; Fajr's may differ (mediaFor.fajr). Use the owner's chosen call to prayer when there is one; otherwise ask which recording to use (they're listed with their credits).`;

/** Words of the hub's own failure lines, not names of things. */
const FAILURE_WORDS = new Set(['couldn’t', 'couldnt', 'couldn', 'change', 'everything', 'combine', 'ask', 'kova', 'move', 'unknown', 'make', 'set', 'add', 'the', 'and', 'use', 'that', 'device', 'devices', 'rename', 'create', 'delete', 'update', 'turn', 'room']);

/** A reply that says something didn't or can't happen. */
const NEGATIVE = /\b(can[’']?t|cannot|couldn[’']?t|didn[’']?t|unable|not able|isn[’']?t|aren[’']?t|doesn[’']?t|has no|have no|no such|failed|wasn[’']?t|won[’']?t|not possible)\b/i;

/** "All done", "Done.", "Everything's set" at the start of a reply. */
const OVERCLAIM = /^\s*(all done|done|all set|all sorted|sorted|everything('s| is)? (done|set|sorted|taken care of))\b[\s.!:,;—–-]*/i;

/**
 * The hub's check on the model's last word. The reply may only claim what the tools confirmed: when a call failed (and
 * no later call fixed it), a change didn't hold when re-read, the model ran out of rounds or gave up with an error,
 * the reply leads with what didn't work and the hub's own "Done: … / Couldn't: …" summary follows. A room the tools
 * used that the reply never names (it said "entryway" when the lamp went to Front door) gets the summary too.
 */
export function honestReply(text: string, o: AskOutcome, opts: { unfinished?: boolean; error?: string; rooms?: string[]; changed?: boolean } = {}): { text: string; flagged: boolean } {
  const body0 = text.trim();
  const said = norm(body0);
  const roomMiss = (opts.rooms ?? []).filter(r => !said.includes(norm(r)));
  // Nothing was done and the model says so ("The lamp has no child lock"): its words already are the honest answer.
  const owned = !o.done.length && !opts.unfinished && !opts.error && !OVERCLAIM.test(body0) && NEGATIVE.test(body0);
  const problems = !owned && (o.couldnt.length > 0 || !!opts.unfinished || !!opts.error);
  if (!problems && !roomMiss.length) {
    // "Done." with nothing done: no tool changed anything, so it can't be.
    if (!opts.changed && OVERCLAIM.test(body0) && /^\s*(all )?done\b/i.test(body0)) {
      const rest = body0.replace(OVERCLAIM, '').trim();
      return { text: `I didn’t change anything.${rest ? ` ${cap(rest)}` : ''}`, flagged: true };
    }
    return { text: body0, flagged: false };
  }
  const lines: string[] = [];
  if (opts.error) lines.push(opts.error);
  if (opts.unfinished) lines.push(o.done.length || o.couldnt.length ? 'I didn’t get to the end of that. Here’s where it stands:' : 'I didn’t get to the end of that, and nothing was changed.');
  else if (problems && !opts.error) lines.push(o.done.length ? 'Not everything worked.' : 'That didn’t work.');
  // The model's own words stay when nothing failed. When something did, only its questions and what it says didn't
  // happen stay: a summary sentence ("the TV is in Theatre and the AC is combined") can claim what the failure undid,
  // and the hub's Done/Couldn't lists below say it right.
  const sentences = (s: string) => s.replace(OVERCLAIM, '').split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  // The names in what failed ("Downlights", "AC", "office_cam"): a sentence of the model's that names one of them, and
  // isn't a question or an admission, is a claim the failure contradicts.
  const failed = new Set(o.couldnt.join(' ').match(/[“"']?[A-Z][\w’'-]*|[“"][^”"]+[”"]|\b\w+_\w+\b/g)?.map(w => norm(w.replace(/[“”"']/g, ''))).filter(w => w.length > 1 && !FAILURE_WORDS.has(w)) ?? []);
  const claims = (x: string) => [...failed].some(w => new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(norm(x)));
  const body = problems ? cap(sentences(body0).filter(x => /\?$/.test(x) || NEGATIVE.test(x) || !claims(x)).join(' ')) : body0;
  if (body && !opts.error) lines.push(body);
  const summary: string[] = [];
  if (o.done.length) summary.push(`Done:\n${o.done.map(x => `- ${x}`).join('\n')}`);
  if (o.couldnt.length) summary.push(`Couldn’t:\n${o.couldnt.map(x => `- ${x}`).join('\n')}`);
  return { text: [lines.join('\n\n'), ...summary].filter(Boolean).join('\n\n'), flagged: true };
}

export interface AiOptions {
  /** Anthropic API base URL (tests point this at a fake server). */
  anthropicBaseUrl?: string;
  /** Whole-request timeout. */
  timeoutMs?: number;
  /** Optional JEV advisor for the review_action tool. */
  jev?: JevAdvisor;
}

export class AiAssistant {
  /** Share settings of the request in progress (list_schedule hides details when names are off). */
  lastShare: ShareSettings | null = null;

  /** Helix music names for the home context (hub.music). */
  music: (() => { name: string; kind: string }[]) | null = null;
  /** Clips kept on the hub ({id, name}), for the home context and words (hub.clips). */
  clips: (() => { id: string; name: string; durationMs?: number }[]) | null = null;
  clipName: ((id: string) => string | undefined) | null = null;
  /** What's wrong with announcement media (hub.mediaProblem). */
  mediaProblem: ((m: string) => string | null) | null = null;

  constructor(readonly engine: Engine, readonly reg: Registry, readonly config: ConfigStore, readonly store: Store, private opts: AiOptions = {}) {}

  /** JEV structured decisions, when configured server-side. */
  get jev(): JevAdvisor | undefined { return this.opts.jev; }

  /** Build the home context the user chose to share. Cameras are never included. */
  buildContext(share: ShareSettings): AiContext {
    const cfg = this.config.get();
    const tz = cfg.timezone;
    const now = this.engine.now();
    // Things to control. Cameras are never sent; sensors go on their own, read-only, below. Archived devices are
    // gone as far as Ask Kova goes. A combined device stands for its parts: the parts are listed inside it (their ids
    // still work, e.g. to separate them), never as devices of their own. Hidden devices are listed apart, by name.
    const combos = (cfg.combined ?? []).filter(c => this.reg.get(`combined_${c.id}`));
    const partOf = new Map(combos.flatMap(c => c.members.map(m => [m, `combined_${c.id}`] as const)));
    // Only what the person asking may use: a child or a guest sees their own rooms' devices, nothing else.
    const asker = currentActor();
    const usable = this.reg.list().filter(d => !isCamera(d) && !isSensor(d) && !d.archived && !partOf.has(d.id) && canDevice(asker, d));
    const devices = usable.filter(d => !d.hidden);
    const hiddenDevices = usable.filter(d => d.hidden);
    const sensors = this.reg.list().filter(d => isSensor(d) && !d.hidden && !d.archived && canDevice(asker, d));
    // Real ids spell out names ("kitchen_ceiling"); use neutral ones when names are private.
    const deviceIds = new Map<string, string>();
    const roomAlias = new Map(cfg.rooms.map((r, i) => [r.id, share.names ? r.id : `room${i + 1}`]));
    // Devices in no room yet ("Unsorted" in the app) say so, rather than a room id that isn't in the list.
    roomAlias.set(UNASSIGNED_ROOM, UNASSIGNED_ROOM);
    const shared: string[] = [];
    const lines: string[] = [];
    // Who's asking: "me", "my room" and "remind me" are theirs, and they can only do what their role allows.
    if (asker && (asker.personId || asker.role !== 'owner')) {
      const roomName = asker.room ? cfg.rooms.find(r => r.id === asker.room) : undefined;
      lines.push(`The person asking: ${share.names ? asker.name : 'a member of the home'} (${ROLE_LABEL[asker.role].toLowerCase()}${asker.role === 'owner' ? '' : `; they can ${[allows(asker, 'control') && (scoped(asker) ? 'control only the devices listed below' : 'control devices'), allows(asker, 'modes') && 'switch modes and overlays', allows(asker, 'automate') && 'make automations', allows(asker, 'home') && 'change rooms and device settings'].filter(Boolean).join(', ')}; refuse anything else`}). For "remind me" or "tell me", a notify action with people ["me"] reaches only them.${roomName ? ` "My room" is ${share.names ? `${roomName.id} (${roomName.name})` : roomAlias.get(roomName.id)}.` : ''}`);
    }
    lines.push(`Time now: ${clock(now, tz)}, ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${localDate(now, tz)}T12:00:00Z`).getUTCDay()]} ${localDate(now, tz)} (the home's time; one-time schedules use it as "${localStamp(now, tz)}").`);
    const mode = this.engine.mode();
    lines.push(`Current mode: ${mode.name}.`);
    const ov = this.engine.overlay && cfg.overlays.find(o => o.id === this.engine.overlay!.id);
    lines.push(`Overlay on: ${ov ? `${ov.name} (${ov.id})` : 'none'}.`);
    if (allows(asker, 'modes')) lines.push(`Overlays you can start: ${cfg.overlays.map(o => `${o.id} (${o.name}, ${o.endsLabel.toLowerCase()})`).join('; ')}.`);
    lines.push(`Modes: ${cfg.modes.map(m => `${m.id} (${m.name})`).join(', ')}.`);
    const memory = allows(asker, 'home') ? memoryList(this.store) : [];
    if (memory.length) lines.push(`Things the user asked you to remember: ${memory.map(m => `"${m.text}"`).join('; ')}.`);
    const autos = allows(asker, 'automate') ? this.engine.automations.list() : [];
    if (autos.length) {
      const w = { reg: this.reg, cfg };
      const tgt = (tid: string, cmd: object) => { const d = this.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, cfg.rooms, cmd) ?? tid); };
      lines.push('Automations — change these with update_automation or delete_automation instead of adding overlapping ones:', ...autos.map(a => `- ${a.id} "${a.name}"${a.enabled ? '' : ' (off)'}: when ${a.triggers.map(t => triggerWords(t, w)).join(' or ') || 'nothing'}${a.conditions.length ? ` | if ${a.conditions.map(c => condWords(c, w)).join(' and ')}` : ''} | ${a.actions.map(x => actionWords(x, w, tgt)).join('; ') || 'nothing'}`));
    }

    if (share.names) lines.push(`Rooms: ${cfg.rooms.filter(r => !scoped(asker) || canRoom(asker, r.id)).map(r => `${r.id} (${r.name})`).join(', ')}. A device with room "${UNASSIGNED_ROOM}" isn't in a room yet (the app lists it under Unsorted).`);
    else lines.push(`Rooms are private: room1, room2… stand for them. "${UNASSIGNED_ROOM}" means no room yet.`);
    let n = 0;
    const idFor = (realId: string) => { const id = share.names ? realId : `device${++n}`; deviceIds.set(id, realId); return id; };
    const devLines = devices.map(d => {
      const id = idFor(d.id);
      const parts: Record<string, unknown> = { id, type: d.type };
      if (share.names) parts.name = d.name;
      if (d.adapter === 'combined') {
        const c = combos.find(x => `combined_${x.id}` === d.id);
        parts.combined = true;
        parts.parts = (c?.members ?? []).map(m => this.reg.get(m)).filter((m): m is Device => !!m && !m.archived)
          .map(m => ({ id: idFor(m.id), ...(share.names ? { name: m.name } : {}), integration: m.integration }));
      }
      parts.room = d.room === WHOLE_HOME ? WHOLE_HOME : roomAlias.get(d.room) ?? `room${cfg.rooms.length + 1}`;
      parts.can = d.capabilities.filter(c => c !== 'events' && c !== 'power');
      // Speakers announcements play on, with their announcement loudness (%), and speaker groups with their speakers.
      if (canAnnounce(d)) { parts.speaker = true; parts.loudness = trimOf(cfg, d.id); }
      if (isSpeakerGroup(d)) parts.speakerGroup = ((cfg.speakerGroups ?? []).find(g => `group_${g.id}` === d.id)?.members ?? []).map(m => share.names ? m : [...deviceIds].find(([, v]) => v === m)?.[0] ?? m);
      if (share.rooms) {
        const s = d.state;
        const zoneNames = cfg.devices?.[d.id]?.zoneNames, zoneRooms = cfg.devices?.[d.id]?.zoneRooms;
        parts.state = Object.fromEntries(Object.entries({ on: s.on, bri: s.bri, k: s.k, color: s.color, mode: s.mode, media: s.media, song: s.track ? `${s.track.title}${s.track.artist ? ` by ${s.track.artist}` : ''}` : undefined, shuffle: s.shuffle || undefined, paused: s.paused || undefined, vol: s.vol, hvac: s.hvac, target: s.target, temp: s.temp, humidity: s.humidity, lux: s.lux, fanSpeed: s.fanSpeed, extras: s.extras, fanLevel: s.fanLevel, fanLevelMax: s.fanLevelMax, airQuality: s.airQuality, pm25: s.pm25, filterLife: s.filterLife, display: s.display, childLock: s.childLock, battery: s.battery, activity: s.activity, zones: s.zones?.map(z => ({ zone: z.n, ...(zoneNames?.[String(z.n)] ? { name: zoneNames[String(z.n)] } : {}), ...(zoneRooms?.[String(z.n)]?.length ? { rooms: zoneRooms[String(z.n)]!.map(r => roomAlias.get(r) ?? r) } : {}), on: z.on, open: z.open, ...(typeof z.temp === 'number' ? { temp: z.temp } : {}) })),
          // Server hardware (the router, from Warden's BMC): what it draws, its power supplies, redundancy, temperatures and fans.
          ...(hasHardware(d) ? { watts: s.power, supplies: s.supplies?.map(x => x.ok ? `${x.name}: OK` : `${x.name}: ${x.problem ?? 'not OK'}`), redundancy: s.redundancy, sensors: s.sensors?.map(x => `${x.name} ${x.value}${x.kind === 'temp' ? '°C' : ' RPM'}`), fanMode: s.fanMode, fanPercent: s.fanPercent, health: hardwareSummary(d) } : {}),
          online: s.online }).filter(([, v]) => v !== undefined && v !== null));
      }
      return JSON.stringify(parts);
    });
    lines.push('Devices (a combined device is one physical device reached through several integrations; its parts are listed inside it and are not separate devices — refer to it, not its parts):', ...devLines);
    if (hiddenDevices.length) {
      const hLines = hiddenDevices.map(d => JSON.stringify({ id: idFor(d.id), type: d.type, ...(share.names ? { name: d.name } : {}), room: roomAlias.get(d.room) ?? `room${cfg.rooms.length + 1}` }));
      lines.push('Hidden devices (the owner hid these: leave them out of lists and answers unless the user asks about hidden devices; update_device hidden:false shows one again):', ...hLines);
    }
    // Which room each air conditioner zone serves: what "zone:<room id>" reaches.
    const zoneLines = cfg.rooms.flatMap(r => zonesServing(r.id, devices, cfg.devices ?? {}).map(({ d, n }) => {
      const z = d.state.zones?.find(x => x.n === n), name = cfg.devices?.[d.id]?.zoneNames?.[String(n)];
      return `- zone:${roomAlias.get(r.id)} → ${share.names ? d.id : [...deviceIds].find(([, v]) => v === d.id)?.[0] ?? d.id} zone ${n}${share.names && name ? ` (${name})` : ''}${share.rooms && z ? `: ${z.on ? `open${z.open != null ? ` ${z.open}%` : ''}` : 'closed'}; the AC is ${d.state.on ? `on, ${d.state.hvac ?? 'on'}${d.state.target != null ? ` ${d.state.target}°` : ''}` : 'off'}` : ''}`;
    }));
    if (zoneLines.length) lines.push('AC zones by room (a whole_home device serves every room only through these):', ...zoneLines);
    // Sensors only report: their readings feed the rooms; they can't be set, but automations can start on them.
    if (sensors.length) {
      const sLines = sensors.map((d, i) => {
        const id = share.names ? d.id : `sensor${i + 1}`;
        deviceIds.set(id, d.id);
        const parts: Record<string, unknown> = { id, room: roomAlias.get(d.room) ?? `room${cfg.rooms.length + 1}` };
        if (share.names) parts.name = d.name;
        if (share.rooms) {
          parts.readings = Object.fromEntries(readingsOf(d).map(r => [r.field, r.text]));
          if (d.state.online === false) parts.online = false;
          // Server hardware (the router, from Warden's BMC): what it draws, its power supplies, redundancy, temperatures and fans.
          if (hasHardware(d)) {
            const s = d.state;
            Object.assign(parts, { watts: s.power, supplies: s.supplies?.map(x => x.ok ? `${x.name}: OK` : `${x.name}: ${x.problem ?? 'not OK'}`), redundancy: s.redundancy, sensors: s.sensors?.map(x => `${x.name} ${x.value}${x.kind === 'temp' ? '°C' : ' RPM'}`), fanMode: s.fanMode, fanPercent: s.fanPercent, health: hardwareSummary(d) });
          }
        }
        return JSON.stringify(parts);
      });
      lines.push('Sensors (read only — use them in automation triggers and conditions, never in set_devices):', ...sLines);
    }
    // Helix music speakers can play (playlist titles are names, so only when names are shared).
    const music = devices.some(d => d.capabilities.includes('queue')) ? (this.music?.() ?? []) : [];
    if (music.length) lines.push(`Helix music for speakers with the queue capability: ${(share.names ? music : music.filter(m => m.kind !== 'playlist')).map(m => `"${m.name}"`).join(', ')}, or "Station: <artist, album or song>".`);
    // Named sources (ambient loops, radio streams): "play thunderstorm" means the source, not a music station.
    const sources = cfg.sources ?? [];
    if (share.names && sources.length) lines.push(`Playable sources — set media to the source name exactly (never "Station:" or Helix music for these): ${sources.map(s => `"${s.name}"${s.loop ? ' (loops)' : ''}`).join(', ')}.`);
    // Audio announcements can play: clips on the hub, and (prayer times on) the call-to-prayer recordings.
    const clips = this.clips?.() ?? [];
    if (clips.length) lines.push(`Clips on the hub for announcements (media "clip:<id>"): ${clips.map(c => `clip:${c.id}${share.names ? ` "${c.name}"` : ''}${c.durationMs ? ` (${Math.round(c.durationMs / 1000)} s)` : ''}`).join(', ')}.`);
    if (cfg.prayer?.on) {
      lines.push(`Prayer times are on (method ${cfg.prayerMethod ?? 'MuslimWorldLeague'}${cfg.prayer.madhab === 'hanafi' ? ', Hanafi Asr' : ''}). Call-to-prayer recordings Kova offers for announcements: ${BUILTIN_ADHANS.map(a => `${a.id} (${adhanCredit(a)}, ${Math.round(a.durationMs / 1000)} s)`).join('; ')}.`);
      const ad = cfg.prayer.adhan;
      lines.push(ad?.media ? `The owner's chosen call to prayer: ${ad.media}${ad.fajr ? `; for Fajr: ${ad.fajr}` : ''}.` : 'The owner hasn’t chosen a call to prayer yet.');
    } else lines.push('Prayer times are off in this home (Integrations → Prayer times): don’t use prayer times.');
    if (share.names) shared.push('device and room names');
    if (share.rooms) shared.push('device states');

    if (share.presence) {
      const ps = cfg.people.map(p => `${p.name} ${this.engine.people[p.id]?.home === false ? 'out' : 'home'}`);
      lines.push(`Who's home: ${ps.length ? ps.join(', ') : 'nobody set up'}.`);
      lines.push(`People: ${cfg.people.map(p => `${p.id} (${p.name})`).join(', ')}.`);
      shared.push("who's home");
    }

    // Room-level activity only: kinds of event and times, by room. Never pictures or camera names.
    if (share.security) {
      const since = atLocal(localDate(now, tz), 0, tz);
      const rows = cfg.rooms.map(r => ({ r, s: this.engine.rooms.summary(r.id, since) })).filter(x => x.s.length);
      lines.push(rows.length
        ? `Room activity today (from cameras and sensors; no pictures): ${rows.map(x => `${roomAlias.get(x.r.id)}: ${x.s.map(e => `${ROOM_EVENT_TEXT[e.kind] ?? e.kind} ×${e.count}, last ${clock(e.last, tz)}`).join(', ')}`).join('; ')}.`
        : 'Room activity today (from cameras and sensors): nothing noticed.');
      shared.push('room activity');
    }

    if (share.history) {
      const camIds = new Set(this.reg.list().filter(d => d.type === 'camera').map(d => d.id));
      const entries = this.store.between(now - 7 * 86400_000, now + 1)
        .filter(e => e.feed && e.kind !== 'device_event' && e.kind !== 'system' && !(e.device && camIds.has(e.device)))
        .filter(e => share.presence || e.kind !== 'presence');
      const counts: Record<string, number> = {};
      for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      lines.push(`Activity, last 7 days: ${entries.length} events (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}).`);
      // Entries name devices and rooms, so the detail only goes when names are shared.
      if (share.names) {
        const recent = entries.slice(-25).map(e => `${new Date(e.ts).toLocaleDateString('en-AU', { weekday: 'short', timeZone: tz })} ${clock(e.ts, tz)} ${e.what} (${e.cause.label})`);
        if (recent.length) lines.push('Recent activity:', ...recent);
      }
      shared.push('activity history');
    }
    const roomIds = new Map(cfg.rooms.map(r => [roomAlias.get(r.id)!, r.id]));
    return { text: lines.join('\n'), shared, deviceIds, roomIds, realIds: share.names };
  }

  /** The engine for the current settings, or a reason it can't run. */
  engineFor(s: AssistantSettings): AiEngine | string {
    const timeoutMs = this.opts.timeoutMs ?? 90_000;
    if (s.engine === 'local') {
      if (!s.local.url || !s.local.model) return 'Local AI isn’t set up yet. Add its address and model in Assistant settings.';
      return new LocalAiEngine({ url: s.local.url, model: s.local.model, apiKey: s.local.apiKey, timeoutMs });
    }
    if (s.engine === 'cloud') {
      const provider = CLOUD_PROVIDERS[s.cloud.provider] ?? CLOUD_PROVIDERS.anthropic;
      if (s.cloud.provider === 'anthropic') {
        if (!s.cloud.apiKey) return 'Cloud AI needs your API key. Add it in Assistant settings.';
        return new CloudAiEngine({ apiKey: s.cloud.apiKey, model: s.cloud.model || DEFAULT_CLOUD_MODEL, baseURL: this.opts.anthropicBaseUrl, timeoutMs });
      }
      if (!s.cloud.apiKey) return `${provider.label} needs your API key. Add it in Assistant settings.`;
      const baseUrl = s.cloud.baseUrl || provider.baseUrl;
      const model = s.cloud.model || provider.defaultModel;
      if (!baseUrl) return `${provider.label} needs a server address. Add it in Assistant settings.`;
      if (!model) return `${provider.label} needs a model. Add it in Assistant settings.`;
      return new LocalAiEngine({ url: baseUrl, model, apiKey: s.cloud.apiKey, timeoutMs, kind: 'cloud', label: provider.label, name: provider.label });
    }
    return 'The built-in assistant is selected.';
  }

  // ---------------------------------------------------------------- learn --

  /** A previously-learned phrase for this normalized text, if any. */
  private learned(key: string): LearnedEntry | undefined {
    return this.store.get<Record<string, LearnedEntry>>(LEARNED_KEY)?.[key];
  }

  /** Drop a learned phrase — called when the user undoes what the AI did. */
  private unlearn(key: string): void { forgetPhrase(this.store, key); }

  /** Save phrase → steps. Only called when the whole tool session succeeded. */
  private learn(key: string, engineLabel: string, steps: LearnedStep[]): void {
    const all = this.store.get<Record<string, LearnedEntry>>(LEARNED_KEY) ?? {};
    all[key] = { ts: Date.now(), engine: engineLabel, uses: 0, steps };
    const newest = Object.keys(all).sort((a, b) => all[b]!.ts - all[a]!.ts).slice(0, LEARNED_CAP);
    this.store.set(LEARNED_KEY, Object.fromEntries(newest.map(k => [k, all[k]!])));
  }

  /** Replay learned steps through the engine. Returns null if a step can't replay (the entry is then dropped). */
  private async replay(key: string, entry: LearnedEntry): Promise<AskReply | null> {
    // A learned phrase replays as the person asking now: anything their role can't do goes to the engine instead
    // (which refuses it there, in words).
    const asker = currentActor();
    if (entry.steps.some(st => !allows(asker, TOOL_PERM[st.tool] ?? 'owner'))) return null;
    try {
      for (const st of entry.steps) if (st.tool === 'set_devices') demandTargets(st.targets, id => this.reg.get(id), asker);
    } catch { return null; }
    try {
      const undos: string[] = [];
      for (const st of entry.steps) {
        if (st.tool === 'set_devices') {
          const r = await this.engine.applyMany(st.targets, AI_CAUSE);
          if (r.changed.length) undos.push(r.undo);
        } else if (st.tool === 'start_overlay') {
          if (!this.config.get().overlays.some(o => o.id === st.id)) return (this.unlearn(key), null);
          undos.push(await this.engine.startOverlay(st.id, AI_CAUSE));
        } else if (st.tool === 'end_overlay') {
          if (!this.engine.overlay) continue;
          await this.engine.endOverlay('user');
        } else if (st.tool === 'create_automation') {
          // Re-create the same automation only if it isn't there (by name) — and still
          // re-validate, since a device it uses may have gone away since it was learned.
          if ((this.config.get().automations ?? []).some(a => a.name === st.automation.name)) continue;
          const a = checkAutomation(st.automation, { device: id => this.reg.get(id), cfg: this.config.get() });
          const undo = this.config.update(c => { (c.automations ??= []).push({ id: autoSlug(a.name), ...a }); });
          undos.push(this.engine.registerUndo(undo));
        }
      }
      const all = this.store.get<Record<string, LearnedEntry>>(LEARNED_KEY) ?? {};
      if (all[key]) { all[key]!.uses++; this.store.set(LEARNED_KEY, all); }
      return { text: 'Done.', source: 'Learned · no AI needed', actions: [], understood: true, engine: 'builtin', undo: this.undoFor(undos) };
    } catch (e) {
      if (e instanceof AccessDenied) return null;
      this.unlearn(key);
      return null;
    }
  }

  /** Record the request that reached an AI engine (or, engine null, fell through with no AI). */
  logRequest(engine: string, q: string, reply: string, tools: string[], ok: boolean, calls?: Toolbox['calls']): void {
    const all = this.store.get<AiRequestLog[]>(REQUESTS_KEY) ?? [];
    all.unshift({ ts: Date.now(), engine, text: q.slice(0, 500), reply: reply.slice(0, 300), tools, ok, ...(calls?.length ? { calls } : {}) });
    this.store.set(REQUESTS_KEY, all.slice(0, REQUESTS_CAP));
  }

  /** Ask the configured AI engine. Never throws. onSteps hears each tool step as it starts and ends. */
  async ask(question: string, s: AssistantSettings, engine?: AiEngine, opts: { onSteps?: (steps: AskStep[]) => void } = {}): Promise<AskReply> {
    const e = engine ?? this.engineFor(s);
    const q = question.trim();
    // A phrase the AI already handled: replay it locally, no AI needed — even if no engine is set up.
    const hit = this.learned(norm(q));
    if (hit) {
      const r = await this.replay(norm(q), hit);
      if (r) return r;
    }
    if (typeof e === 'string') { this.logRequest('unhandled', q, e, [], false); return { text: e, source: 'Built-in · nothing left your home', actions: [], understood: false, engine: 'builtin' }; }
    const share = { ...s.share, cameras: false as const };
    const history = convoRecent(this.store);
    const chat: ChatTurn[] = [...history.map(t => ({ role: t.role, content: t.text })), { role: 'user', content: q }];
    const source: AskReply['source'] = e.kind === 'local' ? 'Local AI on your server' : `${e.label} · sent ${sharedLabel(share, history.length ? ['recent chat'] : [])}`;
    const kind: EngineKind = e.kind;
    let tools: Toolbox | null = null;
    try {
      this.lastShare = share;
      const ctx = this.buildContext(share);
      if (history.length) ctx.shared.push('recent chat');
      const notes = s.instructions.trim() ? `\n\nStanding instructions from the user:\n${s.instructions.trim()}` : '';
      const prayer = this.config.get().prayer?.on ? `\n${PRAYER_SYSTEM}` : '';
      const system = `${SYSTEM}${prayer}${notes}\n\nHome context (shared by the user):\n${ctx.text}`;
      this.store.append({
        kind: 'system', device: null, feed: 'system', what: `Ask Kova sent a request to ${e.label}`,
        data: { engine: e.kind, chars: system.length + q.length, preview: q.length > 40 ? `${q.slice(0, 40)}…` : q, shared: ctx.shared },
        cause: { kind: 'assistant', label: 'Ask Kova' },
      });
      tools = new Toolbox(this, ctx, opts.onSteps);
      const key = norm(q);
      let result: EngineResult;
      try { result = await e.run(system, chat, tools); } catch (err) {
        const msg = err instanceof AiError ? err.message : `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`;
        // Anything already done stays undoable, and the reply says what it was.
        const out = tools.called.length ? honestReply('', tools.outcome(), { error: msg, changed: tools.changedAnything }).text : msg;
        this.logRequest(e.label, q, out, tools.called, false, tools.calls);
        return { text: out, source, actions: [], understood: false, engine: kind, undo: this.undoFor(tools.undos) };
      }
      // The hub's check on the model's words: only what the tools confirmed (re-read now) is claimed.
      const checked = honestReply(cleanReply(result.text), tools.outcome(), { unfinished: result.unfinished, rooms: tools.roomsUsed(), changed: tools.changedAnything });
      const text = checked.text;
      this.logRequest(e.label, q, text, tools.called, !checked.flagged, tools.calls);
      // A clean run that changed something becomes a learned phrase: next time it replays without the AI.
      // Undoing the AI's work drops the phrase — the user said it was wrong.
      const learnedSomething = tools.okAll && !checked.flagged && tools.learned.length > 0;
      if (learnedSomething) this.learn(key, e.label, tools.learned);
      return { text: text || (tools.undos.length ? 'Done.' : 'I don’t have an answer for that.'), source, actions: [], understood: true, engine: kind, undo: this.undoFor(tools.undos, learnedSomething ? () => this.unlearn(key) : undefined) };
    } catch (err) {
      return { text: `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`, source, actions: [], understood: false, engine: kind, ...(tools?.undos.length ? { undo: this.undoFor(tools.undos) } : {}) };
    } finally {
      this.lastShare = null;
    }
  }

  /** One undo for everything the AI did, undone in reverse order. onUndo runs after it (e.g. unlearning). */
  private undoFor(ids: string[], onUndo?: () => void): string | undefined {
    if (!ids.length) return undefined;
    if (!onUndo) return ids.length === 1 ? ids[0] : this.engine.registerUndo(async () => { for (const id of [...ids].reverse()) await this.engine.undo(id); });
    return this.engine.registerUndo(async () => { for (const id of [...ids].reverse()) await this.engine.undo(id); onUndo(); });
  }
}

/** "names and device states" for the Cloud AI source tag. `extra` adds things sent that aren't share toggles (recent chat). */
export function sharedLabel(share: ShareSettings, extra: string[] = []): string {
  const parts = [share.names && 'names', share.rooms && 'device states', share.history && 'activity history', share.presence && 'who’s home', share.security && 'room activity', ...extra].filter(Boolean) as string[];
  if (!parts.length) return 'your request only';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
