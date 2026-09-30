import { hubUrl, type HubConfig } from '../logic/connect';

export class HubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const withTimeout = (ms: number) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

/** JSON over HTTP to the hub, with its token. Errors carry the hub's own message. */
export async function call<T = unknown>(cfg: HubConfig, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, timeoutMs = 12_000): Promise<T> {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(hubUrl(cfg, path), {
      method,
      signal: t.signal,
      headers: {
        accept: 'application/json',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new HubError(res.status === 401 ? 'The hub wants its token. Scan the code in Kova on your computer, or enter the token.' : msg, res.status);
    }
    return json as T;
  } catch (e) {
    if (e instanceof HubError) throw e;
    throw new HubError((e as Error).name === 'AbortError' ? 'The hub didn’t answer in time.' : 'Can’t reach the hub. Is this phone on the home network?', 0);
  } finally {
    t.done();
  }
}

export interface Health { ok: boolean; version: string }

/** Is there a Kova hub at this address? (GET /api/health needs no token and says nothing about the home.) */
export async function probe(url: string, timeoutMs = 1500): Promise<Health | null> {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, { signal: t.signal });
    if (!res.ok) return null;
    const j = await res.json() as Partial<Health>;
    return j && j.ok && typeof j.version === 'string' ? { ok: true, version: j.version } : null;
  } catch {
    return null;
  } finally {
    t.done();
  }
}

/** Try addresses a few dozen at a time; stop at the first hub. */
export async function findHub(candidates: string[], opts: { parallel?: number; timeoutMs?: number; cancelled?: () => boolean } = {}): Promise<string | null> {
  const parallel = opts.parallel ?? 32;
  for (let i = 0; i < candidates.length; i += parallel) {
    if (opts.cancelled?.()) return null;
    const batch = candidates.slice(i, i + parallel);
    const hits = await Promise.all(batch.map(async u => (await probe(u, opts.timeoutMs ?? 1200)) ? u : null));
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return null;
}
