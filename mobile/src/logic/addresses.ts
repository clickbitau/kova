// Two ways to one hub: its address on the home network, and its remote one (Tailscale, or a reverse proxy).
//
// At home the phone talks to the hub on the LAN: fast, and it keeps working when the internet is down, which is
// often exactly when somebody opens the app. Away, only the remote address reaches it. So each hub keeps a list of
// addresses and the app uses the best one that answers *as this hub*: a home-network one whenever one does,
// otherwise the remote one. Nothing here sends the token anywhere: an address is only used once GET /api/hello
// there (no token) says it's the same hub. Kept free of React Native so it can be tested under Node.

export type AddressKind = 'local' | 'remote';

export interface HubAddress {
  /** A base URL with no trailing slash: http://192.168.1.20:8140, https://kova.example.ts.net */
  url: string;
  kind: AddressKind;
  /** Added by the owner, not learned from the hub: learning never removes it, and it may be plain http. */
  manual?: boolean;
}

/** What GET /api/hello says (an older hub's /api/health stands in, with no ID). */
export interface Hello { kova: true; hubId: string | null; version?: string }

/** The address in use: one that answered as this hub. */
export interface Route { url: string; kind: AddressKind; hubId: string | null }

export const KIND_LABEL: Record<AddressKind, string> = { local: 'Home network', remote: 'Remote' };

/** How long a home-network address gets to answer (it's near, so it's quick or it isn't there). */
export const LOCAL_TIMEOUT_MS = 1500;
/** A remote address goes over the internet, and may have to wake a tunnel. */
export const REMOTE_TIMEOUT_MS = 5000;

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(url.trim());
  return (m ? m[1] : '').replace(/^\[|\]$/g, '').toLowerCase();
}

/** 10/8, 172.16/12, 192.168/16, and IPv6 link-local / unique-local. */
function isPrivateIp(h: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^(fe80|fc|fd)[0-9a-f]*:/i.test(h);
}

/**
 * Whether an address only works on the home network: a private IP, a .local name, or a bare name ("kova").
 * Everything else, a Tailscale name or 100.64.0.0/10 address included, is remote.
 */
export function kindFor(url: string): AddressKind {
  const h = hostOf(url);
  if (!h) return 'local';
  if (isPrivateIp(h) || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return 'local';
  if (/^[a-z0-9-]+$/.test(h) && !/^\d+$/.test(h)) return 'local';
  return 'remote';
}

/**
 * Whether the app may send its token to this address at all. A remote address must be https (the token would
 * otherwise cross the internet in the clear), unless the owner added a plain-http one by hand.
 */
export function allowed(a: HubAddress): boolean {
  if (!/^https?:\/\//i.test(a.url)) return false;
  return a.kind === 'local' || a.manual === true || /^https:/i.test(a.url);
}

/** The bare host for showing: "192.168.1.20:8140", "kova.example.ts.net". */
export function display(url: string | undefined | null): string {
  return (url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

function dedupe(list: HubAddress[]): HubAddress[] {
  const out: HubAddress[] = [];
  for (const a of list) {
    const i = out.findIndex(o => o.url === a.url);
    if (i < 0) out.push(a);
    else if (a.manual && !out[i].manual) out[i] = { ...out[i], manual: true };
  }
  return out;
}

/** Home-network addresses first, each group in the order given. */
export function sortAddresses(list: HubAddress[]): HubAddress[] {
  return [...list.filter(a => a.kind === 'local'), ...list.filter(a => a.kind === 'remote')];
}

/** The stored list, or, for a phone set up before there was one, the single address it had. */
export function addressesOf(cfg: { url: string; addresses?: HubAddress[] }): HubAddress[] {
  const list = Array.isArray(cfg.addresses) ? cfg.addresses.filter(a => a && typeof a.url === 'string' && a.url) : [];
  if (list.length) return list.map(a => ({ url: a.url, kind: a.kind === 'remote' || a.kind === 'local' ? a.kind : kindFor(a.url), ...(a.manual ? { manual: true } : {}) }));
  return cfg.url ? [{ url: cfg.url, kind: kindFor(cfg.url) }] : [];
}

/**
 * The hub's own list (GET /api/connect/addresses), merged into what the phone has.
 * The hub's addresses replace the learned ones; the owner's own stay, and so does the one in use (it's answering,
 * which is better evidence than the hub's opinion: the phone may reach it by a name the hub doesn't know).
 */
export function learn(have: HubAddress[], fromHub: { url: string; kind?: string }[], inUse?: string | null, removed: string[] = []): HubAddress[] {
  const hub: HubAddress[] = [];
  for (const a of fromHub ?? []) {
    if (!a || typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url)) continue;
    const url = a.url.trim().replace(/\/+$/, '');
    if (removed.includes(url)) continue; // the owner took it away
    hub.push({ url, kind: a.kind === 'local' || a.kind === 'remote' ? a.kind : kindFor(url) });
  }
  const kept = have.filter(a => a.manual || a.url === inUse);
  return sortAddresses(dedupe([...hub, ...kept]));
}

/** Add an address by hand (it goes to the front of its kind), or take one away. */
export function addManual(have: HubAddress[], url: string, kind: AddressKind = kindFor(url)): HubAddress[] {
  return sortAddresses(dedupe([{ url, kind, manual: true }, ...have.filter(a => a.url !== url)]));
}

export function remove(have: HubAddress[], url: string): HubAddress[] {
  return have.filter(a => a.url !== url);
}

/** Whether an answer at an address came from this hub. A phone that doesn't know the hub's ID yet takes any Kova. */
export function sameHub(expect: string | null | undefined, hello: Hello | null): boolean {
  if (!hello || hello.kova !== true) return false;
  return expect ? hello.hubId === expect : true;
}

/** The order to try: home network first; within a kind, the last one that worked first. */
export function tryOrder(list: HubAddress[], lastGood?: string | null): HubAddress[] {
  const ok = sortAddresses(list.filter(allowed));
  const i = ok.findIndex(a => a.url === lastGood);
  if (i > 0) {
    const [hit] = ok.splice(i, 1);
    const at = ok.findIndex(a => a.kind === hit.kind);
    ok.splice(at < 0 ? ok.length : at, 0, hit);
  }
  return ok;
}

export interface ChooseOptions {
  /** GET <url>/api/hello with a timeout; null when nothing (or not Kova) answered. Never sends the token. */
  hello(url: string, timeoutMs: number): Promise<Hello | null>;
  /** The hub's ID, when the phone knows it. */
  hubId?: string | null;
  lastGood?: string | null;
  localTimeoutMs?: number;
  remoteTimeoutMs?: number;
}

/**
 * Which address to use now. Every address is asked at once. The first home-network one to answer as this hub wins
 * at once; a remote one that answers first waits until the home-network ones have had their chance (a second or
 * so), so the phone uses the LAN whenever it's on it. Among remote ones, the earliest in order that answers.
 * Null when no address answered as this hub.
 */
export async function chooseAddress(list: HubAddress[], o: ChooseOptions): Promise<Route | null> {
  const order = tryOrder(list, o.lastGood);
  if (!order.length) return null;
  const ask = (a: HubAddress) => o.hello(a.url, a.kind === 'local' ? o.localTimeoutMs ?? LOCAL_TIMEOUT_MS : o.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS)
    .catch(() => null)
    .then(h => (sameHub(o.hubId, h) ? { url: a.url, kind: a.kind, hubId: h!.hubId ?? o.hubId ?? null } as Route : null));
  const locals = order.filter(a => a.kind === 'local').map(ask);
  const remotes = order.filter(a => a.kind === 'remote').map(ask);

  const local = await firstHit(locals);
  if (local) return local;
  // Home network had its chance: the best remote one that answered (in order).
  for (const p of remotes) { const r = await p; if (r) return r; }
  return null;
}

/** The first promise to resolve to something (any order), or null once all are done with nothing. */
function firstHit<T>(ps: Promise<T | null>[]): Promise<T | null> {
  if (!ps.length) return Promise.resolve(null);
  return new Promise(resolve => {
    let left = ps.length;
    for (const p of ps) {
      void p.then(v => {
        if (v) resolve(v);
        else if (--left === 0) resolve(null);
      });
    }
  });
}

/** Reads an /api/hello (or, from an older hub, /api/health) answer. */
export function parseHello(body: unknown): Hello | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kova === true) return { kova: true, hubId: typeof b.hubId === 'string' && b.hubId ? b.hubId : null, ...(typeof b.version === 'string' ? { version: b.version } : {}) };
  // GET /api/health on a hub from before /api/hello: Kova, but it can't say which one.
  if (b.ok === true && typeof b.version === 'string') return { kova: true, hubId: null, version: b.version };
  return null;
}

/** The status line: "Connected · Home network". */
export function pathLabel(route: Route | null): string {
  return route ? KIND_LABEL[route.kind] : '';
}
