import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Hub } from './hub.ts';
import type { AdapterStatus } from './adapters/sdk.ts';
import { ADAPTER_FACTORIES, adapterFor, loadIntegrations, type Integrations } from './integrations.ts';
import { catalogItem, validateSection, type CatalogItem } from './integrations-catalog.ts';
import { KlapSession, authHash } from './adapters/tapo.ts';
import { TuyaConnection } from './adapters/tuya/connection.ts';
import { VeSyncClient, VeSyncError, VESYNC_HOSTS } from './adapters/vesync.ts';
import { readRegisters } from './adapters/goodwe.ts';
import { DEFAULT_PORTS, parseInfo } from './adapters/samsung-tv.ts';
import { Warden } from './adapters/warden.ts';
import { HelixApi } from './adapters/helix.ts';

/**
 * In-app setup for integrations.json: read it with secrets hidden, change one
 * section at a time, and restart just that integration.
 */

export type IntegrationsData = Integrations & Record<string, unknown>;

/** What the API shows instead of a stored secret. Sending it back means "keep what's stored". */
export const REDACTED = '••••';
const SECRETS = new Set(['password', 'key', 'authHash', 'clientSecret', 'refreshToken', 'accessToken', 'token', 'secret', 'apiKey']);
const flagOf = (k: string) => `has${k[0].toUpperCase()}${k.slice(1)}`;
const FLAGS = new Set([...SECRETS].map(flagOf));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v != null && typeof v === 'object' && !Array.isArray(v);

/** A copy with every secret replaced by "••••" and a `hasX: true` flag next to it. */
export function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redact) as T;
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRETS.has(k) && typeof x === 'string') {
      out[k] = x ? REDACTED : '';
      if (x) out[flagOf(k)] = true;
    } else out[k] = redact(x);
  }
  return out as T;
}

/** The stored row an incoming row stands for: same id, else same host, else same position. */
function counterpart(x: unknown, prev: unknown[], i: number): unknown {
  if (isObj(x)) {
    for (const k of ['id', 'host', 'url'] as const) {
      if (x[k] == null || x[k] === '') continue;
      const m = prev.find(p => isObj(p) && p[k] === x[k]);
      if (m) return m;
    }
  }
  return prev[i];
}

/**
 * `incoming` with each "••••" replaced by the stored secret at the same place,
 * and the `hasX` flags dropped. A "••••" with nothing stored behind it is dropped.
 */
export function keepSecrets(incoming: unknown, stored: unknown): unknown {
  if (Array.isArray(incoming)) {
    const prev = Array.isArray(stored) ? stored : [];
    return incoming.map((x, i) => keepSecrets(x, counterpart(x, prev, i)));
  }
  if (!isObj(incoming)) return incoming;
  const prev = isObj(stored) ? stored : {};
  const out: Obj = {};
  for (const [k, x] of Object.entries(incoming)) {
    if (FLAGS.has(k) && typeof x === 'boolean') continue;
    if (x === REDACTED) { if (typeof prev[k] === 'string' && prev[k] !== REDACTED) out[k] = prev[k]; continue; }
    out[k] = keepSecrets(x, prev[k]);
  }
  return out;
}

/** Write integrations.json so a crash can't leave half a file, readable only by the hub's user. */
export function saveIntegrations(path: string, data: IntegrationsData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class SetupError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export interface ApplyResult {
  ok: true;
  /** The integration was restarted with the new settings. */
  applied: boolean;
  /** Saved, but only takes effect when the hub restarts. */
  restartRequired: boolean;
  status: AdapterStatus | null;
}

export interface TestResult { ok: boolean; message: string }

export class IntegrationsManager {
  private data: IntegrationsData;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private hub: Hub, private opts: { path: string; dataDir: string }) {
    this.data = (loadIntegrations(opts.path) ?? {}) as IntegrationsData;
  }

  /** The stored settings, secrets included. Never send this to a client. */
  get config(): IntegrationsData { return this.data; }

  /** The settings as the app sees them: every secret replaced by "••••". */
  publicConfig(): IntegrationsData { return redact(this.data); }

  private item(section: string): CatalogItem {
    const it = catalogItem(section);
    if (!it) throw new SetupError(`Unknown integration "${section}"`, 404);
    return it;
  }

  private home() {
    const c = this.hub.config.get();
    return { rooms: c.rooms.map(r => r.id), people: c.people.map(p => p.id) };
  }

  /** Settings from the app, with "••••" filled back in from what's stored, checked against the catalog. */
  private prepare(section: string, value: unknown): Obj {
    const item = this.item(section);
    const merged = keepSecrets(value, this.data[section]) as Obj;
    // Settings the form doesn't show (a pinned certificate, a poll interval) stay as they were.
    const stored = this.data[section];
    if (isObj(stored) && isObj(merged)) {
      const shown = new Set(item.fields.map(f => f.key.split('.')[0]));
      for (const [k, v] of Object.entries(stored)) if (!shown.has(k) && !(k in merged)) merged[k] = v;
    }
    const errs = validateSection(item, merged, this.home());
    if (errs.length) throw new SetupError(errs.join('. '));
    return merged as Obj;
  }

  /**
   * Bring in sections from an import (Home Assistant). Sections already set up in Kova are kept as they are;
   * new ones are written as imported, without the setup form's checks (an imported account may still need its
   * password), and started where they have enough to run.
   */
  importSections(values: Integrations): Promise<{ written: string[]; kept: string[]; started: string[] }> {
    const run = this.queue.then(async () => {
      const next: IntegrationsData = { ...this.data };
      const written: string[] = [], kept: string[] = [], started: string[] = [];
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) continue;
        if (this.data[k] !== undefined) { kept.push(k); continue; }
        next[k] = v; written.push(k);
      }
      saveIntegrations(this.opts.path, next);
      this.data = next;
      for (const k of written) {
        const item = catalogItem(k);
        if (item?.apply !== 'hot' || !(k in ADAPTER_FACTORIES) || ADAPTER_FACTORIES[k as keyof Integrations] === null) continue;
        await this.hub.reg.removeAdapter(k);
        const a = adapterFor(k as keyof Integrations, next, this.opts.dataDir);
        if (a) { await this.hub.reg.addAdapter(a); started.push(k); }
      }
      this.hub.emit('changed');
      return { written, kept, started };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** A section as stored, secrets included. For the hub's own routes only; never send it to a client. */
  raw<K extends keyof Integrations>(section: K): Integrations[K] | undefined {
    return this.data[section] as Integrations[K] | undefined;
  }

  /** Save one section (or remove it with `null`) and restart that integration when it can be done live. */
  update(section: string, value: unknown | null): Promise<ApplyResult> {
    const run = this.queue.then(() => this.apply(section, value));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(section: string, value: unknown | null): Promise<ApplyResult> {
    const item = this.item(section);
    const next: IntegrationsData = { ...this.data };
    if (value === null) delete next[section];
    else next[section] = this.prepare(section, value);
    saveIntegrations(this.opts.path, next);
    this.data = next;

    const live = item.apply === 'hot' && section in ADAPTER_FACTORIES && ADAPTER_FACTORIES[section as keyof Integrations] !== null;
    if (!live) {
      this.hub.emit('changed');
      return { ok: true, applied: false, restartRequired: true, status: this.statusOf(section) };
    }
    // Same device ids either way: a restarted adapter announces the same devices, so modes keep working.
    await this.hub.reg.removeAdapter(section, { forget: value === null });
    const a = value === null ? null : adapterFor(section as keyof Integrations, next, this.opts.dataDir);
    if (a) await this.hub.reg.addAdapter(a);
    this.hub.emit('changed');
    return {
      ok: true, applied: true, restartRequired: false,
      status: value === null ? null : a ? a.status() : { ok: false, note: 'Saved. Add the remaining settings to start it.' },
    };
  }

  statusOf(section: string): AdapterStatus | null {
    const a = this.hub.reg.adapters.get(section);
    if (a) return a.status();
    const s = this.hub.services.find(x => x.id === section);
    return s ? s.status() : null;
  }

  /** Try settings (from the app, or what's stored) without saving them. */
  async test(section: string, value?: unknown): Promise<TestResult> {
    const item = this.item(section);
    const cfg = value === undefined ? (this.data[section] ?? {}) as Obj : keepSecrets(value, this.data[section]) as Obj;
    const probe = PROBES[section];
    if (!probe) return { ok: false, message: `There’s no quick test for ${item.name}. Save it and watch its status.` };
    try {
      return { ok: true, message: await probe(cfg) };
    } catch (e) {
      return { ok: false, message: friendly(e) };
    }
  }
}

// ------------------------------------------------------------- probes --

function friendly(e: unknown): string {
  const err = e as Error & { cause?: { code?: string }; code?: string };
  const code = err.cause?.code ?? err.code;
  const why = code === 'ECONNREFUSED' ? 'it refused the connection'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it on the network'
    : code === 'ENOTFOUND' ? 'that name doesn’t resolve'
    : err.name === 'TimeoutError' || err.name === 'AbortError' || code === 'ETIMEDOUT' ? 'it didn’t answer in time'
    : null;
  return why ?? (err.message || String(e));
}

const first = <T>(xs: T[] | undefined, what: string): T => {
  if (!xs?.length) throw new Error(`Add a ${what} first`);
  return xs[0];
};

const PROBES: Record<string, (cfg: Obj) => Promise<string>> = {
  async warden(cfg) {
    const c = cfg as Integrations['warden'] & object;
    if (!c.url) throw new Error('Enter Warden’s address first');
    if (!c.token) throw new Error('Pair with Warden first (below)');
    const w = new Warden(c);
    const d = await w.dashboard().catch(e => { throw new Error(`Couldn’t read Warden at ${w.url}: ${friendly(e)}`); });
    return `Connected to Warden. Internet ${d.wanUp === false ? 'is down' : 'is up'}, ${d.clientCount ?? 0} devices online.`;
  },
  async helix(cfg) {
    const c = cfg as Integrations['helix'] & object;
    if (!c.url) throw new Error('Enter Helix Server’s address first');
    if (!c.token) throw new Error('Pair with Helix first (below)');
    const h = new HelixApi(c);
    const boxes = await h.boxes().catch(e => { throw new Error(`Couldn’t read Helix Server at ${h.url}: ${friendly(e)}`); });
    return boxes.length ? `Connected. Boxes: ${boxes.map(b => `${b.name}${b.online ? '' : ' (offline)'}`).join(', ')}.` : 'Connected. No Helix box has used this server yet.';
  },
  async tapo(cfg) {
    const c = cfg as Integrations['tapo'] & object;
    const d = first(c.devices, 'device');
    const auth = [...(c.authHash ? [Buffer.from(c.authHash, 'base64')] : []), ...(c.username != null ? [authHash(c.username, c.password ?? '')] : [])];
    if (!auth.length) throw new Error('Enter your TP-Link email and password first');
    try {
      const i = await new KlapSession(`http://${d.host}`, auth, 5000).request<{ nickname?: string; model: string; device_on: boolean }>('get_device_info');
      const name = i.nickname ? Buffer.from(i.nickname, 'base64').toString() : i.model;
      return `Reached ${name} (${i.model}) at ${d.host}. It’s ${i.device_on ? 'on' : 'off'}.`;
    } catch (e) { throw new Error(`Couldn’t sign in to ${d.host}: ${friendly(e)}`); }
  },
  async tuya(cfg) {
    const d = first((cfg as Integrations['tuya'] & object).devices, 'device');
    const conn = new TuyaConnection({ id: d.id, host: d.host, key: d.key, version: d.version ?? '3.3', port: d.port, timeoutMs: 5000, heartbeatMs: 60_000 });
    try {
      await conn.connect();
      const dps = await conn.query();
      const sw = Object.entries(dps).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => `DP ${k} ${v ? 'on' : 'off'}`);
      return `Reached ${d.host} with that key. ${sw.length ? `Channels: ${sw.join(', ')}.` : `${Object.keys(dps).length} data points.`}`;
    } catch (e) { throw new Error(`Couldn’t talk to ${d.host}: ${friendly(e)}. Check the IP, local key and version.`); } finally { conn.close(); }
  },
  async vesync(cfg) {
    const c = cfg as Integrations['vesync'] & object & { baseUrl?: string };
    if (!c.email || !c.password) throw new Error('Enter your VeSync email and password first');
    const client = new VeSyncClient(c.baseUrl ?? VESYNC_HOSTS[c.region ?? 'us'], c.email, c.password, 10_000);
    await client.login().catch(e => { throw e instanceof VeSyncError ? e : new Error(`Couldn’t reach VeSync: ${friendly(e)}`); });
    const list = await client.devices();
    return `Signed in. ${list.length} device${list.length === 1 ? '' : 's'} on the account${list.length ? `: ${list.map(d => d.deviceName).join(', ')}` : ''}.`;
  },
  async goodwe(cfg) {
    const c = cfg as Integrations['goodwe'] & object;
    if (!c.host) throw new Error('Enter the inverter’s IP address first');
    await readRegisters(c.host, c.port ?? 502, c.unit ?? 247, 30100, 1, 5000).catch(e => { throw new Error(`Couldn’t read the inverter at ${c.host}: ${friendly(e)}`); });
    return `The inverter at ${c.host} answered.`;
  },
  async samsungtv(cfg) {
    const tv = first((cfg as Integrations['samsungtv'] & object).tvs, 'TV');
    const res = await fetch(`http://${tv.host}:${DEFAULT_PORTS.info}/api/v2/`, { signal: AbortSignal.timeout(5000) }).catch(e => { throw new Error(`Couldn’t reach ${tv.host}: ${friendly(e)}. Is the TV on?`); });
    const i = parseInfo(await res.json() as Parameters<typeof parseInfo>[0]);
    return `Found ${i.name ?? 'a Samsung TV'}${i.model ? ` (${i.model})` : ''}. It’s ${i.on ? 'on' : 'in standby'}.`;
  },
  async airplay(cfg) {
    const url = String(cfg.url ?? '').replace(/\/$/, '');
    if (!url) throw new Error('Enter the OwnTone address first');
    const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(5000) }).catch(e => { throw new Error(`Couldn’t reach OwnTone at ${url}: ${friendly(e)}`); });
    if (!res.ok) throw new Error(`OwnTone at ${url} answered HTTP ${res.status}`);
    const j = await res.json() as { version?: string; library_name?: string };
    return `Connected to OwnTone${j.version ? ` ${j.version}` : ''}${j.library_name ? ` (${j.library_name})` : ''}.`;
  },
};
