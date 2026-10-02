import Anthropic from '@anthropic-ai/sdk';
import type { Engine } from '../engine/engine.ts';
import type { Registry } from '../devices/registry.ts';
import type { ConfigStore } from '../engine/config.ts';
import type { Store } from '../store/db.ts';
import type { Cause, Command, Device, Targets } from '../model/types.ts';
import { isPlayer } from '../util/describe.ts';
import { clock } from '../util/time.ts';
import type { AskReply } from './assistant.ts';

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
  local: { url: string; model: string; apiKey?: string };
  cloud: { provider: CloudProvider; model: string; apiKey?: string; baseUrl?: string };
}

/** What GET /api/assistant/settings returns: never any key. */
export interface PublicAssistantSettings {
  engine: EngineKind;
  share: ShareSettings;
  local: { url: string; model: string; hasKey: boolean };
  cloud: { provider: CloudProvider; model: string; hasKey: boolean; baseUrl?: string };
}

export interface SettingsPatch {
  engine?: EngineKind;
  share?: Partial<Record<keyof ShareSettings, boolean>>;
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
    local: { ...d.local, ...(s.local ?? {}) },
    cloud,
  };
}

export function publicSettings(s: AssistantSettings): PublicAssistantSettings {
  return {
    engine: s.engine,
    share: { ...s.share, cameras: false },
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
  const next: AssistantSettings = { engine, share, local, cloud };
  store.set('assistant', next);
  return next;
}

// ------------------------------------------------------------------ tools --

/** Tool definitions in a provider-neutral JSON Schema form. */
export const TOOLS = [
  {
    name: 'set_devices',
    description: 'Change one or more devices. Only use device ids from the home context. bri is brightness 1-100, k is colour temperature in Kelvin, color is #rrggbb, vol is volume 0-100. Turning a speaker or TV off also stops what it plays. paused pauses or carries on (devices with the pause capability). media on a device with the library capability is a film or show title to find and play there (a Helix box). On a speaker with the queue capability, media can also be Helix music: "Shuffle all", "Loved", a playlist title, or "Station: <artist, album or song>"; shuffle true plays it in a shuffled order; skip 1 is the next song, -1 the previous.',
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
] as const;

type ToolName = typeof TOOLS[number]['name'];

const AI_CAUSE: Cause = { kind: 'assistant', label: 'Ask Kova (AI)' };
const MAX_ROUNDS = 6;

/** What was shared with the model, and how to map the ids it uses back to real devices. */
export interface AiContext {
  text: string;
  shared: string[];
  deviceIds: Map<string, string>;
}

/** Runs tool calls against the engine, collecting undo ids. One per ask. */
export class Toolbox {
  readonly undos: string[] = [];
  constructor(private ai: AiAssistant, private ctx: AiContext) {}

  private device(alias: unknown): Device | undefined {
    const id = typeof alias === 'string' ? this.ctx.deviceIds.get(alias) : undefined;
    return id ? this.ai.reg.get(id) : undefined;
  }

  async run(name: string, input: unknown): Promise<string> {
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
            if ((c.bri != null || c.k != null || c.color != null) && c.on === undefined) c.on = true;
            if (c.on === false && isPlayer(d)) c.media = null;
            if (Object.keys(c).length) targets[d.id] = c;
          }
          if (!Object.keys(targets).length) return JSON.stringify({ ok: false, error: unknown.length ? `Unknown device ids: ${unknown.join(', ')}` : 'Nothing to change' });
          const r = await this.ai.engine.applyMany(targets, AI_CAUSE);
          if (r.changed.length) this.undos.push(r.undo);
          return JSON.stringify({ ok: true, changed: r.changed.length, unchanged: Object.keys(targets).length - r.changed.length, ...(unknown.length ? { unknownIds: unknown } : {}) });
        }
        case 'start_overlay': {
          const o = this.ai.config.get().overlays.find(x => x.id === args.id);
          if (!o) return JSON.stringify({ ok: false, error: `Unknown overlay ${String(args.id)}` });
          this.undos.push(await this.ai.engine.startOverlay(o.id, AI_CAUSE));
          return JSON.stringify({ ok: true, started: o.name, ends: o.endsLabel });
        }
        case 'end_overlay': {
          if (!this.ai.engine.overlay) return JSON.stringify({ ok: false, error: 'No overlay is on' });
          await this.ai.engine.endOverlay('user');
          return JSON.stringify({ ok: true, mode: this.ai.engine.mode().name });
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
      if (!calls.length) return { text: (msg.content ?? '').trim() };
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
Use the tools to act: set_devices, start_overlay, end_overlay, explain_device, list_schedule. Only use device and overlay ids from the home context below; never invent ids.
If the request can't be done with these tools or the shared context, say so plainly instead of guessing. Reply in one or two short, friendly sentences of plain text, no markdown.`;

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

  constructor(readonly engine: Engine, readonly reg: Registry, readonly config: ConfigStore, private store: Store, private opts: AiOptions = {}) {}

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
        parts.state = Object.fromEntries(Object.entries({ on: s.on, bri: s.bri, k: s.k, color: s.color, mode: s.mode, media: s.media, song: s.track ? `${s.track.title}${s.track.artist ? ` by ${s.track.artist}` : ''}` : undefined, shuffle: s.shuffle || undefined, paused: s.paused || undefined, vol: s.vol, online: s.online }).filter(([, v]) => v !== undefined && v !== null));
      }
      return JSON.stringify(parts);
    });
    lines.push('Devices:', ...devLines);
    // Helix music speakers can play (playlist titles are names, so only when names are shared).
    const music = devices.some(d => d.capabilities.includes('queue')) ? (this.music?.() ?? []) : [];
    if (music.length) lines.push(`Helix music for speakers with the queue capability: ${(share.names ? music : music.filter(m => m.kind !== 'playlist')).map(m => `"${m.name}"`).join(', ')}, or "Station: <artist, album or song>".`);
    if (share.names) shared.push('device and room names');
    if (share.rooms) shared.push('device states');

    if (share.presence) {
      const ps = cfg.people.map(p => `${p.name} ${this.engine.people[p.id]?.home === false ? 'out' : 'home'}`);
      lines.push(`Who's home: ${ps.length ? ps.join(', ') : 'nobody set up'}.`);
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
    return { text: lines.join('\n'), shared, deviceIds };
  }

  /** The engine for the current settings, or a reason it can't run. */
  engineFor(s: AssistantSettings): AiEngine | string {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
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

  /** Ask the configured AI engine. Never throws. */
  async ask(question: string, s: AssistantSettings, engine?: AiEngine): Promise<AskReply> {
    const e = engine ?? this.engineFor(s);
    const q = question.trim();
    if (typeof e === 'string') return { text: e, source: 'Built-in · nothing left your home', actions: [], understood: false };
    const share = { ...s.share, cameras: false as const };
    const source: AskReply['source'] = e.kind === 'local' ? 'Local AI on your server' : `${e.label} · sent ${sharedLabel(share)}`;
    try {
      this.lastShare = share;
      const ctx = this.buildContext(share);
      const system = `${SYSTEM}\n\nHome context (shared by the user):\n${ctx.text}`;
      this.store.append({
        kind: 'system', device: null, feed: 'system', what: `Ask Kova sent a request to ${e.label}`,
        data: { engine: e.kind, chars: system.length + q.length, preview: q.length > 40 ? `${q.slice(0, 40)}…` : q, shared: ctx.shared },
        cause: { kind: 'assistant', label: 'Ask Kova' },
      });
      const tools = new Toolbox(this, ctx);
      let text: string;
      try { text = (await e.run(system, q, tools)).text; } catch (err) {
        // Anything already done stays undoable.
        return { text: err instanceof AiError ? err.message : `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`, source, actions: [], understood: false, undo: this.undoFor(tools.undos) };
      }
      return { text: text || (tools.undos.length ? 'Done.' : 'I don’t have an answer for that.'), source, actions: [], understood: true, undo: this.undoFor(tools.undos) };
    } catch (err) {
      return { text: `${e.label} failed: ${err instanceof Error ? err.message : String(err)}`, source, actions: [], understood: false };
    } finally {
      this.lastShare = null;
    }
  }

  /** One undo for everything the AI did, undone in reverse order. */
  private undoFor(ids: string[]): string | undefined {
    if (!ids.length) return undefined;
    if (ids.length === 1) return ids[0];
    return this.engine.registerUndo(async () => { for (const id of [...ids].reverse()) await this.engine.undo(id); });
  }
}

/** "names and device states" for the Cloud AI source tag. */
export function sharedLabel(share: ShareSettings): string {
  const parts = [share.names && 'names', share.rooms && 'device states', share.history && 'activity history', share.presence && 'who’s home'].filter(Boolean) as string[];
  if (!parts.length) return 'your request only';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
