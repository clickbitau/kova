import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store/db.ts';

export type JevQuestion = {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: string[] | Record<string, string>;
};

export interface JevResponse {
  id: string;
  model?: string;
  answers: Record<string, Record<string, unknown>>;
  usage?: unknown;
}

export interface JevOptions {
  apiKey?: string;
  /** Full decision endpoint. Defaults to TypeSafe's System One API. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Local audit event log; the key and full request state are never written. */
  store?: Store;
  fetchFn?: typeof fetch;
}

export class JevError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_QUESTIONS = 12;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Small TypeSafe/JEV client for structured judgments. Advisory only: callers still enforce Kova's rules. */
export class JevAdvisor {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(private opts: JevOptions = {}) {
    this.url = opts.baseUrl ?? DEFAULT_URL;
    this.model = opts.model ?? 'jev-latest';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.apiKey = opts.apiKey || undefined;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, store?: Store): JevAdvisor {
    return new JevAdvisor({
      apiKey: env.JEV_API_KEY || env.TYPESAFE_API_KEY,
      baseUrl: env.JEV_BASE_URL || undefined,
      model: env.JEV_MODEL || undefined,
      timeoutMs: Number(env.JEV_TIMEOUT_MS) || undefined,
      store,
    });
  }

  get configured(): boolean { return !!this.apiKey; }

  status(): { configured: boolean; model: string; baseUrl: string; timeoutMs: number } {
    return { configured: this.configured, model: this.model, baseUrl: this.url, timeoutMs: this.timeoutMs };
  }

  private questions(questions: Record<string, JevQuestion>): Record<string, JevQuestion> {
    const entries = Object.entries(questions ?? {}).slice(0, MAX_QUESTIONS);
    if (!entries.length) throw new JevError('Give Jev at least one question', 400);
    for (const [key, q] of entries) {
      if (!key.trim()) throw new JevError('Jev question names must not be blank', 400);
      if (!q || !['choice', 'score', 'noul'].includes(q.type)) throw new JevError(`Jev question ${key} needs a valid type`, 400);
      if (typeof q.instructions !== 'string' || !q.instructions.trim()) throw new JevError(`Jev question ${key} needs instructions`, 400);
      if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) {
        throw new JevError(`Jev choice ${key} needs at least two options`, 400);
      }
      if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 8)) {
        throw new JevError(`Jev score ${key} needs 2–8 levels`, 400);
      }
    }
    return Object.fromEntries(entries);
  }

  private audit(entry: { model: string; ok: boolean; latencyMs: number; questionKeys: string[]; stateSha: string; status?: number; error?: string }): void {
    try {
      this.opts.store?.append({
        kind: 'system', device: null, feed: 'system', what: `Asked Jev for a decision`,
        data: entry,
        cause: { kind: 'assistant', label: 'Jev' },
      });
    } catch { /* audit must never break the answer */ }
  }

  async decide(state: string, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    if (!this.apiKey) throw new JevError('Jev isn’t configured. Add JEV_API_KEY to the hub environment.', 503);
    const s = String(state ?? '').trim();
    if (!s) throw new JevError('Give Jev some state to judge', 400);
    const qs = this.questions(questions);
    const started = Date.now();
    const stateSha = sha(s);
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, state: s, questions: qs }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      this.audit({ model: this.model, ok: false, latencyMs: Date.now() - started, questionKeys: Object.keys(qs), stateSha, error: timedOut ? 'timeout' : 'network' });
      throw new JevError(timedOut ? 'Jev took too long to answer.' : 'Couldn’t reach Jev.', 503);
    }
    const body = await res.json().catch(() => null) as { id?: string; model?: string; answers?: Record<string, Record<string, unknown>>; usage?: unknown; detail?: unknown } | null;
    if (!res.ok) {
      const detail = body?.detail ? JSON.stringify(body.detail).slice(0, 300) : `HTTP ${res.status}`;
      this.audit({ model: body?.model ?? this.model, ok: false, latencyMs: Date.now() - started, questionKeys: Object.keys(qs), stateSha, status: res.status, error: detail });
      throw new JevError(`Jev returned an error (${res.status}).`, 502);
    }
    if (!body?.answers || typeof body.answers !== 'object') {
      this.audit({ model: body?.model ?? this.model, ok: false, latencyMs: Date.now() - started, questionKeys: Object.keys(qs), stateSha, status: res.status, error: 'bad_reply' });
      throw new JevError('Jev sent a reply Kova couldn’t read.', 502);
    }
    const out = { id: body.id ?? `jev_${randomUUID()}`, model: body.model ?? this.model, answers: body.answers, usage: body.usage };
    this.audit({ model: out.model ?? this.model, ok: true, latencyMs: Date.now() - started, questionKeys: Object.keys(qs), stateSha, status: res.status });
    return out;
  }

  /** Advisory risk screen for a proposed action. */
  async gate(action: string, context = ''): Promise<{ id: string; model?: string; riskScore?: number; safeProbability?: number; recommendation: 'allow' | 'confirm' | 'block'; note: string }> {
    const act = String(action ?? '').trim();
    if (!act) throw new JevError('Give Jev an action to review', 400);
    const r = await this.decide(`ACTION UNDER REVIEW:\n${act}\n\nCONTEXT:\n${context.trim() || '(none provided)'}`, {
      risk: { type: 'score', instructions: 'How risky is this action to the home, uptime, privacy, safety, or user trust?', criteria: ['trivial', 'minor', 'moderate', 'serious'] },
      safe: { type: 'noul', instructions: 'Is this action safe to execute without asking the user for confirmation?' },
    });
    const riskScore = typeof r.answers.risk?.score === 'number' ? r.answers.risk.score : undefined;
    const safeProbability = typeof r.answers.safe?.noul === 'number' ? r.answers.safe.noul : undefined;
    let recommendation: 'allow' | 'confirm' | 'block' = 'confirm';
    if (safeProbability !== undefined && riskScore !== undefined) {
      if (safeProbability >= 0.75 && riskScore < 1.5) recommendation = 'allow';
      else if (safeProbability < 0.35 || riskScore >= 3) recommendation = 'block';
    }
    return { id: r.id, model: r.model, riskScore, safeProbability, recommendation, note: 'Advisory judgment only; Kova still applies its own permissions.' };
  }
}
