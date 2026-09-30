import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';

// Connecting the Kova phone app: a kova://connect link (and its QR code) with this hub's address and,
// when the hub has one, its token. Only callers who already have the token get it back (the API's auth
// covers this route), so showing the code in the web app hands the phone nothing the browser didn't have.

/** An address a phone on the same network can reach: the one the browser used, unless that was localhost. */
export function lanBase(req: Pick<FastifyRequest, 'headers' | 'protocol'>, port: number, nets = os.networkInterfaces()): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host && !/^(localhost|127\.|::1$|0\.0\.0\.0$)/.test(name)) return `${proto}://${host}`;
  const ip = Object.values(nets).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  return `http://${ip ?? 'localhost'}:${port}`;
}

export function appLink(base: string, token?: string): string {
  const q = new URLSearchParams({ url: base, ...(token ? { token } : {}) });
  return `kova://connect?${q}`;
}

export function registerAppLinkRoutes(app: FastifyInstance, o: { token?: string; port: () => number }): void {
  app.get('/api/app-link', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const base = lanBase(req, o.port());
    const link = appLink(base, o.token);
    const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#141517', light: '#f1efea' } });
    return { url: base, link, qrSvg, hasToken: !!o.token };
  });
}
