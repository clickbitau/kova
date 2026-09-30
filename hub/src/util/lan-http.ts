import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';

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
  timeoutMs?: number;
}

export interface LanResponse<T> { status: number; json: T; fingerprint?: string }

export class LanHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); }
}

const norm = (f: string) => f.toUpperCase().replace(/[^0-9A-F]/g, '');

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
        fingerprint = (res.socket as TLSSocket).getPeerCertificate?.()?.fingerprint256;
        if (o.fingerprint && (!fingerprint || norm(fingerprint) !== norm(o.fingerprint))) {
          res.destroy();
          return reject(new LanHttpError(`${u.host} presented a different certificate than when it was linked. Link it again if you replaced it.`, 0));
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
