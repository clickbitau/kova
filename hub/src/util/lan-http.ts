import http from 'node:http';
import https from 'node:https';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** How to reach an app on the home network (Warden, Helix). */
export interface LanOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Sent as `Authorization: Bearer …`. */
  token?: string;
  headers?: Record<string, string>;
  /**
   * The server's certificate, pinned when it was linked (SHA-256, "AA:BB:…"). Appliances on the LAN use
   * self-signed certificates, so this, not a CA, is what makes HTTPS trustworthy. Without it any certificate is accepted.
   */
  fingerprint?: string;
  /**
   * The server's public key (SHA-256 of its SubjectPublicKeyInfo, "AA:BB:…"). A certificate with this key is trusted
   * even when the certificate itself was reissued, as appliances do when their addresses change.
   */
  publicKeySha256?: string;
  timeoutMs?: number;
}

export interface LanResponse<T> { status: number; json: T; fingerprint?: string }

export class LanHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); }
}

const norm = (f: string) => f.toUpperCase().replace(/[^0-9A-F]/g, '');

/** SHA-256 of a certificate's public key (its SubjectPublicKeyInfo): stays the same when the certificate is reissued. */
export function spkiSha256(cert: Pick<PeerCertificate, 'raw'>): string | undefined {
  try {
    const der = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
  } catch { return undefined; }
}

/**
 * The key behind each pinned certificate, learned the first time it's seen: pinned certificate fingerprint → key.
 * Kept in <KOVA_DATA>/tls-keys.json (owner-only), so a reissued certificate with the same key is still trusted.
 */
const keyFile = () => join(resolve(process.env.KOVA_DATA ?? 'data'), 'tls-keys.json');
let learned: Record<string, string> | null = null;
const keys = (): Record<string, string> => {
  if (learned) return learned;
  try { learned = existsSync(keyFile()) ? JSON.parse(readFileSync(keyFile(), 'utf8')) : {}; } catch { learned = {}; }
  return learned!;
};
function learn(fingerprint: string, key: string): void {
  const k = keys();
  if (k[norm(fingerprint)] === key) return;
  k[norm(fingerprint)] = key;
  try {
    mkdirSync(dirname(keyFile()), { recursive: true });
    writeFileSync(keyFile(), JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
    chmodSync(keyFile(), 0o600);
  } catch { /* read-only data folder: keep it in memory */ }
}
/** For tests: forget what was learned (and read the file again next time). */
export function resetLearnedKeys(): void { learned = null; }

/**
 * Is this the server that was linked? Its certificate is the pinned one (and its key is learned then), or its key is
 * the pinned key, or the key learned for the pinned certificate. Nothing pinned: anything is accepted.
 */
export function trusted(cert: PeerCertificate | undefined, o: Pick<LanOptions, 'fingerprint' | 'publicKeySha256'>): boolean {
  if (!o.fingerprint && !o.publicKeySha256) return true;
  if (!cert?.fingerprint256) return false;
  const key = cert.raw ? spkiSha256(cert) : undefined;
  if (o.fingerprint && norm(cert.fingerprint256) === norm(o.fingerprint)) {
    if (key) learn(o.fingerprint, key);
    return true;
  }
  if (!key) return false;
  if (o.publicKeySha256 && norm(key) === norm(o.publicKeySha256)) return true;
  const known = o.fingerprint ? keys()[norm(o.fingerprint)] : undefined;
  return !!known && norm(known) === norm(key);
}

const MISMATCH = (host: string) => `${host} presented a different certificate and key than when it was linked. Link it again if you replaced it.`;

/** A JSON request to a LAN app. Rejects on HTTP errors with the app's own message when it gives one. */
export function lanJson<T = unknown>(url: string, o: LanOptions = {}): Promise<LanResponse<T>> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const tls = u.protocol === 'https:';
    const body = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const req = (tls ? https : http).request(u, {
      method: o.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
        ...o.headers,
      },
      timeout: o.timeoutMs ?? 8000,
      // Self-signed on the LAN: trust comes from the pinned fingerprint, checked below on a fresh
      // connection each time (a pooled socket may no longer say which certificate it was given).
      ...(tls ? { rejectUnauthorized: false, agent: false } : {}),
    }, res => {
      let fingerprint: string | undefined;
      if (tls) {
        const cert = (res.socket as TLSSocket).getPeerCertificate?.();
        fingerprint = cert?.fingerprint256;
        if (!trusted(cert, o)) {
          res.destroy();
          return reject(new LanHttpError(MISMATCH(u.host), 0));
        }
      }
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          const msg = json && typeof json === 'object' ? (json as { message?: string; error?: string }).message ?? (json as { error?: string }).error : undefined;
          return reject(new LanHttpError(msg ? `${msg} (HTTP ${status})` : `HTTP ${status}`, status, json));
        }
        resolve({ status, json: json as T, fingerprint });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`${u.host} didn’t answer in time`), { name: 'TimeoutError' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** One Server-Sent Event. */
export interface SseEvent { id?: string; event: string; data: string }

/**
 * Follow a Server-Sent Events stream from a LAN app (Warden's /api/v1/feed), with the same certificate pinning.
 * `done` settles when the stream ends: resolves when the server closed it, rejects on an HTTP or network error.
 * Without anything (not even a heartbeat) for `idleMs`, the connection counts as dead.
 */
export function lanStream(url: string, o: Omit<LanOptions, 'method' | 'body' | 'timeoutMs'> & { lastEventId?: string; idleMs?: number }, onEvent: (e: SseEvent) => void): { done: Promise<void>; close: () => void } {
  let req: http.ClientRequest | undefined;
  let closed = false;
  const done = new Promise<void>((resolve, reject) => {
    const u = new URL(url);
    const tls = u.protocol === 'https:';
    req = (tls ? https : http).request(u, {
      headers: {
        accept: 'text/event-stream',
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.lastEventId ? { 'last-event-id': o.lastEventId } : {}),
        ...o.headers,
      },
      timeout: o.idleMs ?? 45_000,
      ...(tls ? { rejectUnauthorized: false, agent: false } : {}),
    }, res => {
      if (tls) {
        if (!trusted((res.socket as TLSSocket).getPeerCertificate?.(), o)) {
          res.destroy();
          return reject(new LanHttpError(MISMATCH(u.host), 0));
        }
      }
      const status = res.statusCode ?? 0;
      if (status >= 400 || !/text\/event-stream/.test(String(res.headers['content-type'] ?? ''))) {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let msg = '';
          try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); msg = j?.message ?? j?.error ?? ''; } catch { /* not JSON */ }
          reject(new LanHttpError(msg ? `${msg} (HTTP ${status})` : `HTTP ${status}`, status >= 400 ? status : 415));
        });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      let cur: { id?: string; event?: string; data: string[] } = { data: [] };
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (cur.data.length || cur.event) onEvent({ id: cur.id, event: cur.event ?? 'message', data: cur.data.join('\n') });
            cur = { data: [] };
            continue;
          }
          if (line.startsWith(':')) continue;
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'data') cur.data.push(value);
          else if (field === 'event') cur.event = value;
          else if (field === 'id') cur.id = value;
        }
      });
      res.on('end', () => resolve());
      res.on('error', e => closed ? resolve() : reject(e));
    });
    req.on('timeout', () => req!.destroy(Object.assign(new Error(`${u.host} went quiet`), { name: 'TimeoutError' })));
    req.on('error', e => closed ? resolve() : reject(e));
    req.end();
  });
  return { done, close: () => { closed = true; req?.destroy(); } };
}
