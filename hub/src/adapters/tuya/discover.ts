import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { ecbDecrypt, unpack6699, VERSIONS, type Version } from './protocol.ts';

// Tuya devices announce themselves on the LAN every few seconds with a UDP broadcast:
//   port 6666: protocol 3.1, plain JSON in a 55AA frame
//   port 6667: 3.3 and newer, AES-128-ECB with md5("yGAdlopoPVldABfn") in a 55AA frame;
//              3.5 devices send a 6699 frame sealed with AES-GCM under the same key
// The JSON carries the device id (gwId), its IP and protocol version. This is how
// tinytuya's scanner finds IPs, and it needs no keys.
//
// Some 3.5 devices only broadcast after the app pokes them on port 7000; that poke isn't sent here.

export const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();

export interface Discovered { id: string; ip: string; version?: Version | string; productKey?: string }

export interface DiscoverOptions {
  /** How long to listen. Tuya devices broadcast about every 5 s. Default 6000. */
  durationMs?: number;
  /** Ports to listen on. Default [6666, 6667]. */
  ports?: number[];
  /** Address to bind. Default all interfaces. */
  address?: string;
  /** Stop early once all of these ids are found. */
  want?: string[];
  onError?: (port: number, err: Error) => void;
}

/** Decode one broadcast datagram → the device's announcement, or null. Exported for tests. */
export function parseBroadcast(msg: Buffer, from?: string): Discovered | null {
  let text: string | null = null;
  try {
    const prefix = msg.length >= 4 ? msg.readUInt32BE(0) : 0;
    if (prefix === 0x6699) {
      const f = unpack6699(msg, UDP_KEY, 'auto').frames[0];
      text = f ? f.payload.toString('utf8') : null;
    } else if (prefix === 0x55aa && msg.length >= 24) {
      const len = msg.readUInt32BE(12);
      let p = msg.subarray(16, Math.min(msg.length, 16 + len) - 8); // drop CRC and suffix
      if (p.length > 4 && p[0] !== 0x7b && (p.length % 16 === 4 || p[4] === 0x7b)) p = p.subarray(4); // return code
      text = p[0] === 0x7b ? p.toString('utf8') : ecbDecrypt(UDP_KEY, p).toString('utf8');
    } else if (msg.length % 16 === 0) {
      text = ecbDecrypt(UDP_KEY, msg).toString('utf8');
    }
  } catch { return null; }
  if (!text) return null;
  try {
    const j = JSON.parse(text.replace(/\0+$/, '')) as { gwId?: string; devId?: string; ip?: string; version?: string; productKey?: string };
    const id = j.gwId ?? j.devId;
    const ip = j.ip ?? from;
    if (!id || !ip) return null;
    return { id, ip, ...(j.version ? { version: j.version } : {}), ...(j.productKey ? { productKey: j.productKey } : {}) };
  } catch { return null; }
}

export const isSupportedVersion = (v: unknown): v is Version => VERSIONS.includes(v as Version);

/** Listen for Tuya broadcasts for a while. Resolves with every device heard, by id. Never throws. */
export function discover(opts: DiscoverOptions = {}): Promise<Map<string, Discovered>> {
  const found = new Map<string, Discovered>();
  const ports = opts.ports ?? [6666, 6667];
  const socks: dgram.Socket[] = [];
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of socks) { try { s.close(); } catch { /* already closed */ } }
      resolve(found);
    };
    const timer = setTimeout(finish, opts.durationMs ?? 6000);
    for (const port of ports) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(s);
      s.on('error', err => { opts.onError?.(port, err); try { s.close(); } catch { /* ignore */ } });
      s.on('message', (msg, rinfo) => {
        const d = parseBroadcast(msg, rinfo.address);
        if (!d) return;
        found.set(d.id, d);
        if (opts.want?.length && opts.want.every(id => found.has(id))) finish();
      });
      s.bind(port, opts.address);
    }
  });
}
