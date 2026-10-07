// Signing this phone in again, without a computer's QR code: the hub's own sign-in by code (hub/src/services/
// sessions.ts, the same one a browser uses). The phone asks for a code, someone already signed in approves it
// (Kova on a computer: Signed-in browsers; or another phone: More → Sign in a browser), and the phone gets a key
// of its own, listed and signed out on its own. Plain TypeScript, tested under Node.
//
// Only ever sent to an address that has just answered GET /api/hello as this hub (logic/link.ts chooses it), and
// nothing secret goes out: the code is shown here and typed there.

export interface SignInCode { id: string; code: string; expiresAt: number }

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** What the phone calls itself in the hub's list: "Kova app on iPhone". */
export function appName(platform: string): string {
  const os = platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android' : '';
  return os ? `Kova app on ${os}` : 'Kova app';
}

/** Ask the hub for a sign-in code. */
export async function startSignIn(base: string, name: string, f: Fetch = fetch as unknown as Fetch): Promise<SignInCode> {
  const res = await f(`${base}/api/login/start`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`Your hub didn’t give a sign-in code (HTTP ${res.status}).`);
  const j = await res.json() as Partial<SignInCode>;
  if (!j || typeof j.id !== 'string' || typeof j.code !== 'string') throw new Error('Your hub didn’t give a sign-in code.');
  return { id: j.id, code: j.code, expiresAt: typeof j.expiresAt === 'number' ? j.expiresAt : Date.now() + 5 * 60_000 };
}

export interface WaitOptions {
  /** How often to ask (ms). */
  everyMs?: number;
  cancelled?: () => boolean;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for the code to be approved: the phone's new key, or null when the code ran out (or waiting was cancelled).
 * A moment where the hub doesn't answer is waited out, not given up on.
 */
export async function waitForSignIn(base: string, c: SignInCode, o: WaitOptions = {}): Promise<string | null> {
  const f = o.fetch ?? (fetch as unknown as Fetch);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const every = o.everyMs ?? 2000;
  while (!o.cancelled?.() && now() < c.expiresAt + 5000) {
    try {
      const res = await f(`${base}/api/login/poll/${encodeURIComponent(c.id)}`, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const j = await res.json() as { state?: string; token?: string };
        if (j?.state === 'approved' && typeof j.token === 'string' && j.token) return j.token;
        if (j?.state === 'expired') return null;
      }
    } catch { /* not answering this moment: ask again */ }
    await sleep(every);
  }
  return null;
}
