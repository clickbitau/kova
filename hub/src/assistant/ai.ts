import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../engine/engine.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Store } from '../store/db.ts';
import { ROOM_ICONS, type Automation, type Cause, type Command, type Device, type Targets } from '../model/types.ts';
import { FIELD_CAP, isPlayer, pseudoLabel, targetLabel } from '../util/describe.ts';
import { checkAutomation } from '../engine/automation-check.ts';
import { actionWords, condWords, triggerWords } from '../engine/automations.ts';
import { slug } from '../tools/import-ha.ts';
import { clock } from '../util/time.ts';
import { norm, type AskReply } from './assistant.ts';

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
const SHARE_KEYS = ['names', 'rooms', 'history', 'presence'] as const;

export function defaultSettings(): AssistantSettings {
  return {
    engine: 'builtin',
    share: { names: true, rooms: true, history: false, presence: false, cameras: false },
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
    description: 'Change one or more devices. Only use device ids from the home context. bri is brightness 1-100, k is colour temperature in Kelvin, color is #rrggbb, vol is volume 0-100. Turning a speaker or TV off also stops what it plays. paused pauses or carries on (devices with the pause capability). media on a device with the library capability is a film or show title to find and play there (a Helix box). On a speaker with the queue capability, media can also be Helix music: "Shuffle all", "Loved", a playlist title, or "Station: <artist, album or song>"; shuffle true plays it in a shuffled order; skip 1 is the next song, -1 the previous. media can also be a named playable source from the context (ambient loops, radio streams) — prefer those over a station when the name matches. Any other field a device shows in its state is set through "set" — e.g. {"childLock": true}, {"display": false} or {"mode": "Sleep"} on a purifier, {"hvac": "cool", "target": 23, "fanSpeed": "low"} on an air conditioner, {"input": "hdmi1"}, {"muted": true} or {"night": true} on a TV or soundbar, {"zoneSet": {"1": {"on": true, "open": 50}, "2": {"on": false}}} for the named zones of a ducted air conditioner, {"extras": {"eco": true}} for the extra switches a device lists under "extras". Only fields the device actually lists in its state can be set.',
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
    description: 'List what the home has planned for the rest of tonight (mode changes and timed moments).',
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
when: {kind:'time', at:'HH:MM' or {kind:'time', at:'HH:MM'} or {kind:'sun', event:'sunrise|sunset|dawn|dusk', offsetMin?:n} or {kind:'prayer', prayer:'fajr|sunrise|dhuhr|asr|maghrib|isha'}, days?:[0-6, 0=Sunday, empty=every day]} | {kind:'device', device:id, to?:{on?, online?, mode?, hvac?, input?, playing?, muted?}, from?:{...}, forSec?:n} | {kind:'numeric', device:id, field:'temp|target|power|energy|battery|bri|vol|grid|load|humidity|lux', above?:n, below?:n} | {kind:'event', device:id, event:string} | {kind:'every', minutes:n} | {kind:'presence', event:'arrives|leaves|first-arrives|last-leaves', person?:id} | {kind:'mode', mode:id} | {kind:'overlay', overlay:id, event:'starts|ends'} | {kind:'hub', event:'start'}
if: {kind:'device', device:id, is:{on?...}} | {kind:'numeric', device:id, field, above?, below?} | {kind:'time', after?/before?:'HH:MM' or a sun/prayer object as above, days?} | {kind:'presence', who:'anyone|no-one|person id', home:boolean} | {kind:'mode', modes:[id]} | {kind:'overlay', overlay?:id, active:boolean} | {kind:'all|any|not', conditions:[...]}
then: {kind:'set', targets:{deviceId:{on:false, bri:50, ...same fields as set_devices + set}, or 'type:light'|'type:media'|'type:<device type>'|'room:<room id>' to reach EVERY matching device — including devices added later (use "type:light" for "all lights")}} | {kind:'delay', seconds:n} | {kind:'wait', until:condition, timeoutSec?:n, stopOnTimeout?:bool} | {kind:'notify', message:string, title?:string, people?:[ids]} | {kind:'overlay', overlay:id, op:'start|end'} | {kind:'if', conditions:[...], then:[...], else?:[...]} | {kind:'repeat', times:n, actions:[...]} | {kind:'ramp', targets:{same target map as set}, field:'bri'|'vol'|'target', to:number, from?:number, overSec:number, stepSec?:number} — gradual changes like brightness climbing over an hour | {kind:'run', automation:id} | {kind:'stop'}
runMode: what a second start does while it's still running — single (ignore), restart (start over), queued (run after), parallel (alongside). Default single.
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
    description: `Change how a device is organised — for "the X is in the master bedroom", "rename it", "hide it", "put it on my favourites". name renames it, room moves it (a room id from the Rooms list — create_room first if it doesn't exist yet), favourite puts it on the Now page, hidden takes it out of view.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        room: { type: 'string' },
        favourite: { type: 'boolean' },
        hidden: { type: 'boolean' },
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
    description: `Remove a room. Devices in it aren't lost — they move to moveTo, another room id from the Rooms list. If the room has devices and no moveTo is given, the call fails with the count so you can ask where they should go.`,
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        moveTo: { type: 'string' },
      },
      required: ['room'],
    },
  },
] as const;

type ToolName = typeof TOOLS[number]['name'];

const AI_CAUSE: Cause = { kind: 'assistant', label: 'Ask Kova (AI)' };
const MAX_ROUNDS = 6;

/** Fields that are readings, not commands — never settable through `set`. */
const READONLY = new Set(['power', 'energy', 'grid', 'load', 'temp', 'humidity', 'lux', 'pm25', 'airQuality', 'filterLife', 'battery', 'online', 'track', 'fanLevelMax', 'zones']);

/** Models sometimes send a list argument as a JSON string — accept it. */
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
const REQUESTS_CAP = 200;
const LEARNED_CAP = 100;
const MEMORY_CAP = 50;

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
}

/** Runs tool calls against the engine, collecting undo ids. One per ask. */
export class Toolbox {
  readonly undos: string[] = [];
  /** Tool names called, in order (for the request log). */
  readonly called: string[] = [];
  /** Each call with args and outcome — enough to see why the AI struggled. */
  readonly calls: { tool: string; args: unknown; ok: boolean; error?: string }[] = [];
  /** Mutating steps that succeeded — the learnable part of this ask. */
  readonly learned: LearnedStep[] = [];
  /** False once any tool reports ok:false — such sessions aren't learned. */
  okAll = true;
  constructor(private ai: AiAssistant, private ctx: AiContext) {}

  private device(alias: unknown): Device | undefined {
    const id = typeof alias === 'string' ? this.ctx.deviceIds.get(alias) : undefined;
    return id ? this.ai.reg.get(id) : undefined;
  }

  /** The real room id for what the model sent (a `roomN` alias when names are private), or undefined. */
  private roomId(alias: unknown): string | undefined {
    if (typeof alias !== 'string') return undefined;
    const rooms = this.ai.config.get().rooms;
    if (rooms.some(r => r.id === alias)) return alias;
    const id = this.ctx.roomIds.get(alias);
    return id && rooms.some(r => r.id === id) ? id : undefined;
  }

  async run(name: string, input: unknown): Promise<string> {
    this.called.push(name);
    // The same call failing again means the model is guessing — tell it to stop and explain.
    const fails = this.calls.filter(c => c.tool === name && !c.ok).length;
    if (fails >= 2) {
      this.calls.push({ tool: name, args: input, ok: false, error: 'already failed twice' });
      this.okAll = false;
      return JSON.stringify({ ok: false, error: `This has failed ${fails} times. Don't try the same call again — tell the user what you can't do or what's missing instead.` });
    }
    const out = await this.dispatch(name, input);
    let ok = true, error: string | undefined;
    try {
      const r = JSON.parse(out) as { ok?: boolean; error?: string };
      if (r.ok === false) { ok = false; error = r.error; this.okAll = false; }
    } catch { /* not json */ }
    this.calls.push({ tool: name, args: input, ok, ...(error ? { error: error.slice(0, 300) } : {}) });
    return out;
  }

  private async dispatch(name: string, input: unknown): Promise<string> {
    try {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      switch (name as ToolName) {
        case 'set_devices': {
          const list = Array.isArray(args.devices) ? args.devices as Record<string, unknown>[] : [];
          const targets: Targets = {};
          const unknown: string[] = [];
          for (const x of list) {
            const d = this.device(x?.id);
            if (!d) { unknown.push(String(x?.id)); continue; }
            const c: Command = {};
            if (typeof x.on === 'boolean') c.on = x.on;
            if (typeof x.bri === 'number' && Number.isFinite(x.bri)) c.bri = Math.round(Math.max(1, Math.min(100, x.bri)));
            if (typeof x.k === 'number' && Number.isFinite(x.k)) c.k = Math.round(Math.max(1500, Math.min(9000, x.k)));
            if (typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color)) c.color = x.color.toLowerCase();
            if (typeof x.vol === 'number' && Number.isFinite(x.vol)) c.vol = Math.round(Math.max(0, Math.min(100, x.vol)));
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
                  const zs = cleanZoneSet(v);
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
          if (!Object.keys(targets).length) return JSON.stringify({ ok: false, error: unknown.length ? `Unknown device ids: ${unknown.join(', ')}` : 'Nothing to change' });
          const r = await this.ai.engine.applyMany(targets, AI_CAUSE);
          if (r.changed.length) this.undos.push(r.undo);
          this.learned.push({ tool: 'set_devices', targets });
          return JSON.stringify({ ok: true, changed: r.changed.length, unchanged: Object.keys(targets).length - r.changed.length, ...(unknown.length ? { unknownIds: unknown } : {}) });
        }
        case 'start_overlay': {
          const o = this.ai.config.get().overlays.find(x => x.id === args.id);
          if (!o) return JSON.stringify({ ok: false, error: `Unknown overlay ${String(args.id)}` });
          this.undos.push(await this.ai.engine.startOverlay(o.id, AI_CAUSE));
          this.learned.push({ tool: 'start_overlay', id: o.id });
          return JSON.stringify({ ok: true, started: o.name, ends: o.endsLabel });
        }
        case 'end_overlay': {
          if (!this.ai.engine.overlay) return JSON.stringify({ ok: false, error: 'No overlay is on' });
          await this.ai.engine.endOverlay('user');
          this.learned.push({ tool: 'end_overlay' });
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
          return JSON.stringify({ ok: true, fact });
        }
        case 'forget': {
          const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
          if (!fact) return JSON.stringify({ ok: false, error: 'Nothing to forget' });
          return forgetMemory(this.ai.store, fact)
            ? JSON.stringify({ ok: true, forgot: fact })
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
          return JSON.stringify({ ok: true, items });
        }
        case 'create_automation': {
          try {
            const cfg = this.ai.config.get();
            const a = checkAutomation(
              { name: args.name, description: args.description, triggers: listArg(args.when), conditions: listArg(args.if), actions: listArg(args.then), mode: args.runMode, enabled: args.enabled },
              { device: id => this.ai.reg.get(id), cfg });
            const id = autoSlug(a.name);
            const undo = this.ai.config.update(c => { (c.automations ??= []).push({ id, ...a }); });
            this.undos.push(this.ai.engine.registerUndo(undo));
            this.learned.push({ tool: 'create_automation', automation: a });
            this.ai.store.append({
              kind: 'system', device: null, feed: 'system', what: `Ask Kova made the automation “${a.name}”`,
              data: { automation: id }, cause: AI_CAUSE,
            });
            const w = { reg: this.ai.reg, cfg };
            const tgt = (tid: string, cmd: object) => { const d = this.ai.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, this.ai.config.get().rooms) ?? tid); };
            return JSON.stringify({ ok: true, id, name: a.name, when: a.triggers.map(t => triggerWords(t, w)), if: a.conditions.map(c => condWords(c, w)), then: a.actions.map(x => actionWords(x, w, tgt)) });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
        }
        case 'update_automation': {
          try {
            const cfg = this.ai.config.get();
            const id = String(args.id ?? '');
            const cur = (cfg.automations ?? []).find(a => a.id === id);
            if (!cur) return JSON.stringify({ ok: false, error: `No automation ${id} — use an id from the Automations list` });
            const a = checkAutomation(
              {
                name: args.name ?? cur.name, description: args.description ?? cur.description,
                triggers: listArg(args.when) ?? cur.triggers, conditions: listArg(args.if) ?? cur.conditions,
                actions: listArg(args.then) ?? cur.actions, mode: args.runMode ?? cur.mode, enabled: args.enabled ?? cur.enabled,
              },
              { device: did => this.ai.reg.get(did), cfg });
            const undo = this.ai.config.update(c => {
              const i = (c.automations ?? []).findIndex(x => x.id === id);
              if (i >= 0) c.automations![i] = { ...c.automations![i]!, ...a };
            });
            this.undos.push(this.ai.engine.registerUndo(undo));
            this.ai.store.append({
              kind: 'system', device: null, feed: 'system', what: `Ask Kova changed the automation “${a.name}”`,
              data: { automation: id }, cause: AI_CAUSE,
            });
            const w = { reg: this.ai.reg, cfg };
            const tgt = (tid: string, cmd: object) => { const d = this.ai.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, this.ai.config.get().rooms) ?? tid); };
            return JSON.stringify({ ok: true, id, name: a.name, when: a.triggers.map(t => triggerWords(t, w)), if: a.conditions.map(c => condWords(c, w)), then: a.actions.map(x => actionWords(x, w, tgt)) });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
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
            return JSON.stringify({ ok: true, id, name: cur.name });
          } catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
        }
        case 'create_room': {
          const name = typeof args.name === 'string' ? args.name.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
          if (!name) return JSON.stringify({ ok: false, error: 'Give the room a name' });
          const icon = typeof args.icon === 'string' && (ROOM_ICONS as readonly string[]).includes(args.icon) ? args.icon : 'meeting_room';
          const rooms = this.ai.config.get().rooms;
          let id = slug(name) || 'room', n = 2;
          while (rooms.some(r => r.id === id)) id = `${slug(name) || 'room'}_${n++}`;
          const undo = this.ai.config.update(c => { c.rooms.push({ id, name, icon }); });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.ai.store.append({ kind: 'system', device: null, feed: 'system', what: `Ask Kova made the room “${name}”`, data: { room: id }, cause: AI_CAUSE });
          return JSON.stringify({ ok: true, id, name });
        }
        case 'update_device': {
          const d = this.device(args.id);
          if (!d) return JSON.stringify({ ok: false, error: `Unknown device ${String(args.id)}` });
          const rooms = this.ai.config.get().rooms;
          const rawRoom = args.room == null ? undefined : String(args.room).trim();
          const room = !rawRoom ? rawRoom : this.roomId(rawRoom);
          if (rawRoom && !room) return JSON.stringify({ ok: false, error: `Unknown room ${rawRoom} — use an id from the Rooms list, or create_room first` });
          const name = args.name == null ? undefined : String(args.name).trim().replace(/\s+/g, ' ').slice(0, 60);
          if (name === '') return JSON.stringify({ ok: false, error: 'Give it a name' });
          const favourite = typeof args.favourite === 'boolean' ? args.favourite : undefined;
          const hidden = typeof args.hidden === 'boolean' ? args.hidden : undefined;
          if (name === undefined && room === undefined && favourite === undefined && hidden === undefined) return JSON.stringify({ ok: false, error: 'Nothing to change' });
          // Same override model as PATCH /api/devices/:id/settings: store only what differs from the adapter's own.
          const orig = d.original ?? { name: d.name, room: d.room };
          const undo = this.ai.config.update(c => {
            const s = { ...(c.devices?.[d.id] ?? {}) };
            if (name !== undefined) { if (name === orig.name) delete s.name; else s.name = name; }
            if (room !== undefined) { if (!room || room === orig.room) delete s.room; else s.room = room; }
            if (hidden !== undefined) { if (hidden) s.hidden = true; else delete s.hidden; }
            c.devices = { ...(c.devices ?? {}) };
            if (Object.keys(s).length) c.devices[d.id] = s; else delete c.devices[d.id];
            if (favourite !== undefined) { const f = (c.favourites ?? []).filter(x => x !== d.id); c.favourites = favourite ? [...f, d.id] : f; }
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          const bits: string[] = [];
          if (name) bits.push(`renamed it “${name}”`);
          if (room) bits.push(`moved it to ${rooms.find(r => r.id === room)?.name ?? room}`);
          if (favourite === true) bits.push('favourited it'); else if (favourite === false) bits.push('took it off favourites');
          if (hidden === true) bits.push('hid it'); else if (hidden === false) bits.push('unhid it');
          this.ai.store.append({ kind: 'system', device: d.id, feed: 'system', what: `Ask Kova ${bits.join(' and ') || 'updated'} — ${d.name}`, data: { device: d.id }, cause: AI_CAUSE });
          return JSON.stringify({ ok: true, id: d.id, name: name ?? d.name, room: room ?? d.room });
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
          return JSON.stringify({ ok: true, id: room.id, name: name ?? room.name });
        }
        case 'delete_room': {
          const cfg = this.ai.config.get();
          const rid = this.roomId(args.room);
          const room = rid ? cfg.rooms.find(r => r.id === rid) : undefined;
          if (!room) return JSON.stringify({ ok: false, error: `Unknown room ${String(args.room)} — use an id from the Rooms list` });
          const inside = this.ai.reg.list().filter(d => d.room === room.id);
          const rawMove = args.moveTo === undefined ? undefined : String(args.moveTo);
          const moveTo = rawMove === undefined ? undefined : this.roomId(rawMove);
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
          });
          this.undos.push(this.ai.engine.registerUndo(undo));
          this.ai.store.append({ kind: 'system', device: null, feed: 'system', what: `Ask Kova removed the room “${room.name}”${inside.length ? `, ${inside.length} device${inside.length === 1 ? '' : 's'} moved` : ''}`, data: { room: room.id, moved: inside.map(d => d.id) }, cause: AI_CAUSE });
          return JSON.stringify({ ok: true, removed: room.id, moved: inside.map(d => d.id) });
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

export interface EngineResult { text: string }

/** One AI backend. `run` drives the tool loop and returns the final text; it may throw. */
export interface AiEngine {
  readonly kind: 'local' | 'cloud';
  readonly label: string;
  run(system: string, question: string, tools: Toolbox): Promise<EngineResult>;
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

  async run(system: string, question: string, tools: Toolbox): Promise<EngineResult> {
    type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
    type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
    const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: question }];
    const deadline = Date.now() + this.opts.timeoutMs;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          body: JSON.stringify({
            model: this.opts.model,
            messages,
            tools: TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
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
    throw new AiError(`${this.cap()} kept calling tools without finishing. Try asking more simply.`);
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

  async run(system: string, question: string, tools: Toolbox): Promise<EngineResult> {
    const model = this.opts.model;
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: question }];
    const toolDefs: Anthropic.Beta.Messages.BetaTool[] = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters as unknown as Anthropic.Beta.Messages.BetaTool.InputSchema }));
    const fallback = FALLBACK_MODELS.has(model);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await this.client.beta.messages.create({
          model,
          max_tokens: 16000,
          system,
          messages,
          tools: toolDefs,
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
    throw new AiError('Cloud AI kept calling tools without finishing. Try asking more simply.');
  }
}

// -------------------------------------------------------------- assistant --

const SYSTEM = `You are Ask Kova, the assistant for a smart home hub. The hub's built-in parser couldn't handle this request, so it was passed to you.
Use the tools to act: set_devices, start_overlay, end_overlay, explain_device, list_schedule, create_automation, update_automation, delete_automation, create_room, rename_room, delete_room, update_device, remember, forget. Only use device, room, overlay, mode and person ids from the home context below; never invent ids.
Anything asked to happen regularly, at a time, or when something else happens is an automation — build it with create_automation, then tell the user what it will do in the words the tool returns.
Ducted air conditioner zones are numbered; a zone only has a name when the state lists one. If a request names rooms for a zoned AC and the zones are unnamed, ask which zone number is which room instead of guessing.
If the request can't be done with these tools or the shared context, say so plainly instead of guessing. Reply like a text message — plain text only, no markdown (never ** or # or \` characters — they show raw in the chat). Keep it short: a sentence or two usually; when listing several things, one item per line starting with "- ". Refer to automations and devices by their names, not their ids.`;

export interface AiOptions {
  /** Anthropic API base URL (tests point this at a fake server). */
  anthropicBaseUrl?: string;
  /** Whole-request timeout. */
  timeoutMs?: number;
}

export class AiAssistant {
  /** Share settings of the request in progress (list_schedule hides details when names are off). */
  lastShare: ShareSettings | null = null;

  /** Helix music names for the home context (hub.music). */
  music: (() => { name: string; kind: string }[]) | null = null;

  constructor(readonly engine: Engine, readonly reg: Registry, readonly config: ConfigStore, readonly store: Store, private opts: AiOptions = {}) {}

  /** Build the home context the user chose to share. Cameras are never included. */
  buildContext(share: ShareSettings): AiContext {
    const cfg = this.config.get();
    const tz = cfg.timezone;
    const now = this.engine.now();
    const devices = this.reg.list().filter(d => d.type !== 'camera');
    // Real ids spell out names ("kitchen_ceiling"); use neutral ones when names are private.
    const deviceIds = new Map<string, string>();
    const roomAlias = new Map(cfg.rooms.map((r, i) => [r.id, share.names ? r.id : `room${i + 1}`]));
    const shared: string[] = [];
    const lines: string[] = [];
    lines.push(`Time now: ${clock(now, tz)}.`);
    const mode = this.engine.mode();
    lines.push(`Current mode: ${mode.name}.`);
    const ov = this.engine.overlay && cfg.overlays.find(o => o.id === this.engine.overlay!.id);
    lines.push(`Overlay on: ${ov ? `${ov.name} (${ov.id})` : 'none'}.`);
    lines.push(`Overlays you can start: ${cfg.overlays.map(o => `${o.id} (${o.name}, ${o.endsLabel.toLowerCase()})`).join('; ')}.`);
    lines.push(`Modes: ${cfg.modes.map(m => `${m.id} (${m.name})`).join(', ')}.`);
    const memory = memoryList(this.store);
    if (memory.length) lines.push(`Things the user asked you to remember: ${memory.map(m => `"${m.text}"`).join('; ')}.`);
    const autos = this.engine.automations.list();
    if (autos.length) {
      const w = { reg: this.reg, cfg };
      const tgt = (tid: string, cmd: object) => { const d = this.reg.get(tid); return d ? targetLabel(d, cmd as Command) : (pseudoLabel(tid, cfg.rooms) ?? tid); };
      lines.push('Automations — change these with update_automation or delete_automation instead of adding overlapping ones:', ...autos.map(a => `- ${a.id} "${a.name}"${a.enabled ? '' : ' (off)'}: when ${a.triggers.map(t => triggerWords(t, w)).join(' or ') || 'nothing'}${a.conditions.length ? ` | if ${a.conditions.map(c => condWords(c, w)).join(' and ')}` : ''} | ${a.actions.map(x => actionWords(x, w, tgt)).join('; ') || 'nothing'}`));
    }

    if (share.names) lines.push(`Rooms: ${cfg.rooms.map(r => `${r.id} (${r.name})`).join(', ')}.`);
    const devLines = devices.map((d, i) => {
      const id = share.names ? d.id : `device${i + 1}`;
      deviceIds.set(id, d.id);
      const parts: Record<string, unknown> = { id, type: d.type };
      if (share.names) parts.name = d.name;
      parts.room = roomAlias.get(d.room) ?? `room${cfg.rooms.length + 1}`;
      parts.can = d.capabilities.filter(c => c !== 'events' && c !== 'power');
      if (share.rooms) {
        const s = d.state;
        const zoneNames = cfg.devices?.[d.id]?.zoneNames;
        parts.state = Object.fromEntries(Object.entries({ on: s.on, bri: s.bri, k: s.k, color: s.color, mode: s.mode, media: s.media, song: s.track ? `${s.track.title}${s.track.artist ? ` by ${s.track.artist}` : ''}` : undefined, shuffle: s.shuffle || undefined, paused: s.paused || undefined, vol: s.vol, hvac: s.hvac, target: s.target, temp: s.temp, humidity: s.humidity, lux: s.lux, fanSpeed: s.fanSpeed, extras: s.extras, fanLevel: s.fanLevel, fanLevelMax: s.fanLevelMax, airQuality: s.airQuality, pm25: s.pm25, filterLife: s.filterLife, display: s.display, childLock: s.childLock, battery: s.battery, activity: s.activity, zones: s.zones?.map(z => ({ zone: z.n, ...(zoneNames?.[String(z.n)] ? { name: zoneNames[String(z.n)] } : {}), on: z.on, open: z.open })), online: s.online }).filter(([, v]) => v !== undefined && v !== null));
      }
      return JSON.stringify(parts);
    });
    lines.push('Devices:', ...devLines);
    // Helix music speakers can play (playlist titles are names, so only when names are shared).
    const music = devices.some(d => d.capabilities.includes('queue')) ? (this.music?.() ?? []) : [];
    if (music.length) lines.push(`Helix music for speakers with the queue capability: ${(share.names ? music : music.filter(m => m.kind !== 'playlist')).map(m => `"${m.name}"`).join(', ')}, or "Station: <artist, album or song>".`);
    // Named sources (ambient loops, radio streams): "play thunderstorm" means the source, not a music station.
    const sources = cfg.sources ?? [];
    if (share.names && sources.length) lines.push(`Playable sources — set media to the source name exactly (never "Station:" or Helix music for these): ${sources.map(s => `"${s.name}"${s.loop ? ' (loops)' : ''}`).join(', ')}.`);
    if (share.names) shared.push('device and room names');
    if (share.rooms) shared.push('device states');

    if (share.presence) {
      const ps = cfg.people.map(p => `${p.name} ${this.engine.people[p.id]?.home === false ? 'out' : 'home'}`);
      lines.push(`Who's home: ${ps.length ? ps.join(', ') : 'nobody set up'}.`);
      lines.push(`People: ${cfg.people.map(p => `${p.id} (${p.name})`).join(', ')}.`);
      shared.push("who's home");
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
    return { text: lines.join('\n'), shared, deviceIds, roomIds };
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
      return { text: 'Done.', source: 'Learned · no AI needed', actions: [], understood: true, undo: this.undoFor(undos) };
    } catch {
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

  /** Ask the configured AI engine. Never throws. */
  async ask(question: string, s: AssistantSettings, engine?: AiEngine): Promise<AskReply> {
    const e = engine ?? this.engineFor(s);
    const q = question.trim();
    // A phrase the AI already handled: replay it locally, no AI needed — even if no engine is set up.
    const hit = this.learned(norm(q));
    if (hit) {
      const r = await this.replay(norm(q), hit);
      if (r) return r;
    }
    if (typeof e === 'string') { this.logRequest('unhandled', q, e, [], false); return { text: e, source: 'Built-in · nothing left your home', actions: [], understood: false }; }
    const share = { ...s.share, cameras: false as const };
    const source: AskReply['source'] = e.kind === 'local' ? 'Local AI on your server' : `${e.label} · sent ${sharedLabel(share)}`;
    try {
      this.lastShare = share;
      const ctx = this.buildContext(share);
      const notes = s.instructions.trim() ? `\n\nStanding instructions from the user:\n${s.instructions.trim()}` : '';
      const system = `${SYSTEM}${notes}\n\nHome context (shared by the user):\n${ctx.text}`;
      this.store.append({
        kind: 'system', device: null, feed: 'system', what: `Ask Kova sent a request to ${e.label}`,
        data: { engine: e.kind, chars: system.length + q.length, preview: q.length > 40 ? `${q.slice(0, 40)}…` : q, shared: ctx.shared },
        cause: { kind: 'assistant', label: 'Ask Kova' },
      });
      const tools = new Toolbox(this, ctx);
      const key = norm(q);
      let text: string;
      try { text = cleanReply((await e.run(system, q, tools)).text); } catch (err) {
        const out = err instanceof AiError ? err.message : `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logRequest(e.label, q, out, tools.called, false, tools.calls);
        // Anything already done stays undoable.
        return { text: out, source, actions: [], understood: false, undo: this.undoFor(tools.undos) };
      }
      this.logRequest(e.label, q, text, tools.called, true, tools.calls);
      // A clean run that changed something becomes a learned phrase: next time it replays without the AI.
      // Undoing the AI's work drops the phrase — the user said it was wrong.
      const learnedSomething = tools.okAll && tools.learned.length > 0;
      if (learnedSomething) this.learn(key, e.label, tools.learned);
      return { text: text || (tools.undos.length ? 'Done.' : 'I don’t have an answer for that.'), source, actions: [], understood: true, undo: this.undoFor(tools.undos, learnedSomething ? () => this.unlearn(key) : undefined) };
    } catch (err) {
      return { text: `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`, source, actions: [], understood: false };
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

/** "names and device states" for the Cloud AI source tag. */
export function sharedLabel(share: ShareSettings): string {
  const parts = [share.names && 'names', share.rooms && 'device states', share.history && 'activity history', share.presence && 'who’s home'].filter(Boolean) as string[];
  if (!parts.length) return 'your request only';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
