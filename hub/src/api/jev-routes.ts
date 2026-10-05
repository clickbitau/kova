import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Hub } from '../hub.ts';
import type { PresenceEvidence } from '../model/types.ts';
import { JevAdvisor, JevError, type JevQuestion } from '../services/jev.ts';

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const evidenceLine = (e: PresenceEvidence, now: number) =>
  `- ${e.source} (${e.kind}): ${e.home ? 'home' : 'away'}, effective weight ${e.weight.toFixed(2)}, learned reliability ${e.reliability.toFixed(2)}, seen ${ago(now - e.at)}`;

function fail(reply: FastifyReply, err: unknown) {
  const status = err instanceof JevError ? err.status : 500;
  return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
}

/** TypeSafe/JEV structured judgment endpoints. Advisory only; they never mutate Kova state. */
export function registerJevRoutes(app: FastifyInstance, hub: Hub, jev: JevAdvisor): void {
  app.get('/api/jev/status', async () => ({
    ...jev.status(),
    note: jev.configured ? 'Structured advisory decisions are available.' : 'Set JEV_API_KEY (or TYPESAFE_API_KEY) in the hub environment to enable Jev.',
  }));

  app.post<{ Body: { state?: string; questions?: Record<string, JevQuestion> } }>('/api/jev/decide', async (req, reply) => {
    try { return await jev.decide(String(req.body?.state ?? ''), req.body?.questions ?? {}); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Body: { action?: string; context?: string } }>('/api/jev/gate', async (req, reply) => {
    try { return await jev.gate(String(req.body?.action ?? ''), String(req.body?.context ?? '')); } catch (e) { return fail(reply, e); }
  });

  /** Read-only second opinion on Kova's presence evidence. It does not change anyone's state. */
  app.get<{ Querystring: { person?: string } }>('/api/jev/presence-review', async (req, reply) => {
    try {
      const wanted = req.query.person;
      const people = hub.config.get().people.filter(p => !wanted || p.id === wanted);
      if (wanted && !people.length) return reply.code(404).send({ error: 'No such person' });
      const now = hub.engine.now();
      const reviews = [];
      for (const [i, p] of people.entries()) {
        const st = hub.engine.people[p.id];
        const evidence = st?.evidence ?? [];
        const current = { home: st?.home ?? false, since: st?.since ?? null, confidence: st?.confidence ?? 0.5 };
        if (!evidence.length) {
          reviews.push({ id: p.id, name: p.name, current, review: null, note: 'No presence evidence yet.' });
          continue;
        }
        const state = [
          `Person ${i + 1} presence review.`,
          `Kova currently says: ${current.home ? 'home' : 'away'} with confidence ${(current.confidence * 100).toFixed(0)}%, since ${ago(now - current.since)}.`,
          'Evidence, strongest first:',
          ...evidence.map(e => evidenceLine(e, now)),
          'Judge the evidence only; do not assume any source is always right.',
        ].join('\n');
        const r = await jev.decide(state, {
          state: {
            type: 'choice',
            instructions: 'Which presence state is best supported by the evidence?',
            criteria: {
              home: 'Evidence supports the person being home now.',
              away: 'Evidence supports the person being away now.',
              uncertain: 'Evidence is stale, weak, or too conflicted to decide.',
            },
          },
          enough: { type: 'noul', instructions: 'Is the evidence sufficient to trust the current state without waiting for another observation?' },
        });
        reviews.push({ id: p.id, name: p.name, current, review: { id: r.id, model: r.model, state: r.answers.state, enough: r.answers.enough } });
      }
      return { people: reviews };
    } catch (e) { return fail(reply, e); }
  });
}
