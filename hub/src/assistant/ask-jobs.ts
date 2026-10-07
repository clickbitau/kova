import { randomUUID } from 'node:crypto';
import type { AskReply } from './assistant.ts';
import type { AskStep } from './ai.ts';

// A request to an AI engine can take a minute or more: several model round trips, each with tool calls. Rather than
// hold one HTTP request open for all of it (a phone's networking, a proxy or the app itself gives up first, and the
// answer is lost), POST /api/ask answers at once with a job, and the client follows it with
// GET /api/ask/jobs/:id?rev=n — a long poll that comes back as soon as anything changes (a step starts or ends, the
// answer lands), or after a while with nothing new. Each follow is short, so a dropped one is simply asked again;
// `rev` makes it lossless. The job runs to the end whatever the client does, and its answer goes into the
// conversation (assistant.conversation), so an app that was closed shows it when it comes back.

export interface AskJob {
  id: string;
  /** What was asked. */
  text: string;
  status: 'working' | 'done';
  /** Who asked (services/actor.ts actorKey): only they follow it. */
  who?: string;
  /** The engine working on it, for the header and "Asking MiniMax…". */
  engine: { kind: 'builtin' | 'local' | 'cloud'; label: string };
  /** Each tool step so far, as the person reads it ("Combining Bedroom TV and TV"). */
  steps: AskStep[];
  /** The answer, once done. */
  reply?: AskReply;
  started: number;
  finished?: number;
  /** Goes up with every change: a follower passes the last one it saw. */
  rev: number;
}

/** Finished jobs are kept this long for a client that comes back late (the conversation keeps the answer longer). */
const KEEP_MS = 60 * 60_000;
const KEEP_MAX = 50;

export class AskJobs {
  private jobs = new Map<string, AskJob>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Start a job: `run` does the work, calling `progress` with the steps as they change, and returns the reply.
   * `run` should not throw; if it does, the job ends with the error as its reply.
   */
  start(text: string, engine: AskJob['engine'], run: (progress: (steps: AskStep[]) => void) => Promise<AskReply>, onDone?: (job: AskJob) => void, who?: string): AskJob {
    this.prune();
    const job: AskJob = { id: randomUUID().replace(/-/g, '').slice(0, 16), text, status: 'working', engine, steps: [], started: this.now(), rev: 1, ...(who ? { who } : {}) };
    this.jobs.set(job.id, job);
    const bump = () => { job.rev++; const w = this.waiters.get(job.id); if (w) { this.waiters.delete(job.id); for (const f of w) f(); } };
    void (async () => {
      let reply: AskReply;
      try {
        reply = await run(steps => { if (job.status === 'working') { job.steps = steps; bump(); } });
      } catch (e) {
        reply = { text: `Something went wrong on the hub: ${e instanceof Error ? e.message : String(e)}`, source: 'Built-in · nothing left your home', actions: [], understood: false, engine: engine.kind };
      }
      job.reply = reply;
      job.status = 'done';
      job.finished = this.now();
      // The finished answer is in the conversation before any follower hears it's done.
      try { onDone?.(job); } catch { /* the answer still reaches the follower */ }
      bump();
    })();
    return job;
  }

  get(id: string): AskJob | undefined { return this.jobs.get(id); }

  /** The job once its rev is past `rev` (or it's done), or as it is after `ms`. Undefined: no such job (the hub restarted). */
  async wait(id: string, rev: number, ms: number): Promise<AskJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || job.rev > rev || job.status === 'done' || ms <= 0) return job;
    await new Promise<void>(ok => {
      const set = this.waiters.get(id) ?? new Set();
      const done = () => { clearTimeout(t); set.delete(done); ok(); };
      const t = setTimeout(done, ms);
      t.unref?.();
      set.add(done);
      this.waiters.set(id, set);
    });
    return this.jobs.get(id);
  }

  /** Jobs still being worked on (for a client that comes back). */
  /** Jobs still being worked on; `who`: only that person's. */
  running(who?: string): AskJob[] { return [...this.jobs.values()].filter(j => j.status === 'working' && (who === undefined || (j.who ?? 'owner') === who)); }

  /** Let every follower go (the hub is stopping). */
  close(): void {
    for (const set of this.waiters.values()) for (const f of [...set]) f();
    this.waiters.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, j] of this.jobs) if (j.status === 'done' && now - (j.finished ?? now) > KEEP_MS) this.jobs.delete(id);
    const done = [...this.jobs.values()].filter(j => j.status === 'done').sort((a, b) => a.started - b.started);
    while (this.jobs.size > KEEP_MAX && done.length) this.jobs.delete(done.shift()!.id);
  }
}
