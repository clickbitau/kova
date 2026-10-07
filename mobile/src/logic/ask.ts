// Ask Kova from the phone: sending a request, following a long one to its answer, and showing what the hub is doing
// meanwhile. Kept free of React Native (the requests and timers come in) so it's tested under Node: test/ask.test.ts.
//
// The hub answers POST /api/ask { text, job: true } at once: the built-in parser's reply, or, for what goes on to an
// AI engine, a job. The job is followed with short long-polls (GET /api/ask/jobs/:id?rev=…&wait=20): each comes back
// as soon as a step starts or ends, or the answer lands. So:
//  - no single request is held open for the whole minute a big request can take, and none is ever timed out while
//    the hub is still working;
//  - a follow that fails (the phone slept, Wi-Fi went, the app went to the background) is simply asked again, with
//    nothing lost (`rev`);
//  - if the app was closed, the answer is in the hub's conversation (GET /api/ask/history) and shows when it opens;
//  - "Can't reach the hub" is only said when nothing answers; anything else says what happened.

import type { AskReply } from '../api/types.ts';

export interface AskStep { tool: string; label: string; status: 'working' | 'ok' | 'failed'; note?: string }
export type EngineKind = 'builtin' | 'local' | 'cloud';
export interface AskEngine { kind: EngineKind; label: string; model?: string; ready?: boolean }
export interface AskJob {
  id: string; text: string; status: 'working' | 'done'; engine: AskEngine; steps: AskStep[];
  started: number; finished?: number; rev: number; reply?: AskReply;
}
/** One turn of the hub's conversation (GET /api/ask/history). */
export interface AskTurn { role: 'user' | 'assistant'; text: string; ts: number; job?: string; source?: string; engine?: EngineKind; undo?: string; failed?: boolean }
export interface AskHistory { turns: AskTurn[]; jobs: AskJob[]; engine?: AskEngine }

/** A failed request, as api/client.ts HubError has it. */
interface ReqError { status: number; message: string; timedOut?: boolean; problem?: 'unreachable' | 'signedOut' | 'hub' }
const isReq = (e: unknown): e is ReqError => !!e && typeof e === 'object' && typeof (e as ReqError).status === 'number';

export type AskApi = <T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<T>;

export interface FollowOpts {
  api: AskApi;
  /** The job as it changes: new steps, then done. */
  onJob?: (job: AskJob) => void;
  /** A follow keeps failing (null when it works again): what to show meanwhile. */
  onTrouble?: (message: string | null) => void;
  /** Stop following (the screen went away). The job carries on at the hub. */
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long each long-poll waits at the hub (s), and how long the phone gives it. */
  waitS?: number;
  pollTimeoutMs?: number;
}

/** Thrown by followJob when `cancelled` says stop. */
export class Cancelled extends Error {}

/** The words while a follow can't get through. Not "can't reach": the hub was there a moment ago. */
export const STILL_WAITING = 'Lost touch with the hub for a moment. It’s still working on this; the answer will show here.';
/** A POST that timed out: it may have reached the hub, which then answers into the conversation. */
export const SENT_NO_ANSWER = 'The hub didn’t confirm it got that. If it did, the answer will show here when it’s done.';

const sleepMs = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));
/** Waits between failed follows: quick at first, then every 10 s. */
const RETRY_MS = [1000, 2000, 3000, 5000, 8000, 10_000];

/** Send a request. The built-in parser's reply comes straight back; a long one is followed to its answer. */
export async function askKova(text: string, o: FollowOpts): Promise<AskReply> {
  let r: AskReply & { job?: AskJob };
  try {
    r = await o.api<AskReply & { job?: AskJob }>('POST', '/api/ask', { text, job: true }, 25_000);
  } catch (e) {
    if (isReq(e) && e.status === 0 && e.timedOut) return { text: SENT_NO_ANSWER, source: '', actions: [], understood: false, failed: true };
    throw e;
  }
  if (!r.job) return r;
  return followJob(r.job, o);
}

/**
 * Follow a job until it's done. Never gives up on a job the hub is still working on: a follow that can't get through
 * is tried again (onTrouble says so meanwhile). A hub that no longer knows the job (it restarted) says that.
 */
export async function followJob(job: AskJob, o: FollowOpts): Promise<AskReply> {
  const sleep = o.sleep ?? sleepMs;
  let j = job;
  let misses = 0, troubled = false;
  o.onJob?.(j);
  while (j.status !== 'done') {
    if (o.cancelled?.()) throw new Cancelled('cancelled');
    try {
      const next = await o.api<AskJob>('GET', `/api/ask/jobs/${encodeURIComponent(j.id)}?rev=${j.rev}&wait=${o.waitS ?? 20}`, undefined, o.pollTimeoutMs ?? ((o.waitS ?? 20) * 1000 + 10_000));
      misses = 0;
      if (troubled) { troubled = false; o.onTrouble?.(null); }
      if (next.rev !== j.rev || next.status !== j.status) { j = next; o.onJob?.(j); }
    } catch (e) {
      if (o.cancelled?.()) throw new Cancelled('cancelled');
      if (isReq(e) && e.status === 404) return { text: e.message, source: '', actions: [], understood: false, failed: true };
      if (isReq(e) && e.status === 401) throw e;
      misses++;
      // Nothing answered, or the hub hiccuped: keep the job, say so after a couple of tries, try again.
      if (misses >= 2 && !troubled) { troubled = true; o.onTrouble?.(STILL_WAITING); }
      if (isReq(e) && e.status !== 0 && misses > 30) throw e;
      await sleep(RETRY_MS[Math.min(misses - 1, RETRY_MS.length - 1)]!);
    }
  }
  return j.reply ?? { text: 'The hub finished without an answer.', source: '', actions: [], understood: false, failed: true };
}

// --------------------------------------------------------------- showing --

/** The line under the Ask header: which engine answers what the built-in parser can't. */
export function engineLine(e: AskEngine | undefined | null): { icon: string; text: string; tone: 'green' | 'plain' | 'warn' } {
  if (!e || e.kind === 'builtin') return { icon: 'lock', text: 'Built in · works without the internet', tone: 'green' };
  if (e.ready === false) return { icon: 'error', text: `${e.label} isn’t set up · built in only`, tone: 'warn' };
  if (e.kind === 'local') return { icon: 'dns', text: 'Built in, then Local AI on your server', tone: 'plain' };
  return { icon: 'cloud', text: `Built in, then ${e.label} (online)`, tone: 'plain' };
}

/** The icon beside a reply's source: by the engine that answered (older hubs: by the words). */
export function sourceIcon(src: string, engine?: EngineKind): string {
  const KNOWN: Record<string, string> = { 'Device control': 'toggle_on', 'From the activity log': 'history', 'From your modes': 'routine', 'Built-in · nothing left your home': 'lock', 'Learned · no AI needed': 'history' };
  if (KNOWN[src]) return KNOWN[src]!;
  if (engine === 'cloud' || / · sent /.test(src)) return 'cloud';
  if (engine === 'local' || src.startsWith('Local')) return 'dns';
  return 'lock';
}

/** What the working bubble says: "Asking MiniMax…" until the first step, then each step. */
export function progressLines(job: Pick<AskJob, 'engine' | 'steps'> | null): { title: string; steps: { label: string; status: AskStep['status']; note?: string }[] } {
  if (!job) return { title: 'Thinking…', steps: [] };
  const who = job.engine.kind === 'builtin' ? 'Kova' : job.engine.label;
  const steps = job.steps.map(s => ({ label: s.status === 'working' ? `${s.label}…` : s.label, status: s.status, ...(s.note ? { note: s.note } : {}) }));
  return { title: !steps.length ? `Asking ${who}…` : `${who} is working on it…`, steps };
}

/** A message in the Ask chat. */
export interface ChatMsg {
  id: string; from: 'you' | 'kova'; text: string; src?: string; engine?: EngineKind; undo?: string; failed?: boolean;
  actions?: AskReply['actions']; job?: string; ts?: number;
}

/**
 * The chat with what the hub has: its turns (answers that landed while the app was closed or away) merged into what's
 * on screen, without doubling anything already shown. A turn is the same message when it has the same job, or, for
 * built-in answers, the same words at about the same time.
 */
export function mergeHistory(chat: ChatMsg[], turns: AskTurn[]): ChatMsg[] {
  const out = [...chat];
  const has = (t: AskTurn) => out.some(m => (t.job && m.job === t.job && m.from === (t.role === 'user' ? 'you' : 'kova'))
    || (m.from === (t.role === 'user' ? 'you' : 'kova') && m.text.trim() === t.text.trim() && (!m.ts || Math.abs(m.ts - t.ts) < 5 * 60_000)));
  for (const t of turns) {
    if (has(t)) continue;
    out.push({
      id: `h${t.ts}${t.role}`, from: t.role === 'user' ? 'you' : 'kova', text: t.text, ts: t.ts,
      ...(t.job ? { job: t.job } : {}), ...(t.source ? { src: t.source } : {}), ...(t.engine ? { engine: t.engine } : {}),
      ...(t.undo ? { undo: t.undo } : {}), ...(t.failed ? { failed: true } : {}),
    });
  }
  // On screen in the order they happened; messages without a time (the greeting) stay first.
  return out.map((m, i) => ({ m, i })).sort((a, b) => (a.m.ts ?? 0) - (b.m.ts ?? 0) || a.i - b.i).map(x => x.m);
}
