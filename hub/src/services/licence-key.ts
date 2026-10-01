import { createPublicKey, verify } from 'node:crypto';

/**
 * Kova licence keys, checked on the hub with no network: the same CR1- format ClickBit mints for Helix and Warden
 * (helix server/internal/entitlement/licence.go). A key is
 *
 *   CR1-<base64url(JSON payload)>.<base64url(Ed25519 signature of the payload)>
 *
 * signed by clickbit-admin; the public half (GET /v1/public/pubkey) is compiled in below — it only verifies, like a
 * CA certificate. A Kova key's payload says {"product":"kova","site":"<hub ID>", edition, features, expiresAt…}.
 */
export const KEY_PREFIX = 'CR1-';
/** ClickBit's licence signing key (raw 32-byte Ed25519, base64). KOVA_LICENCE_PUBKEY overrides it (tests). */
export const SIGNING_PUBLIC_KEY = 'YCrJJEAY6SiheFUR7pc+CTmPZCoZT2l0yN+2m1sVbSg';

export interface LicenceClaim {
  id?: string;
  edition: string;
  features: string[];
  product: string;
  site?: string;
  issuedAt?: string;
  expiresAt?: string;
}

function publicKey(b64 = process.env.KOVA_LICENCE_PUBKEY || SIGNING_PUBLIC_KEY) {
  const raw = Buffer.from(b64.trim(), 'base64');
  if (raw.length !== 32) throw new Error(`The licence signing key is ${raw.length} bytes, want 32`);
  // An Ed25519 SubjectPublicKeyInfo is a fixed 12-byte header and the raw key.
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

/** Check a key and return what it says, or throw why it can't be used on this hub. */
export function parseLicenceKey(key: string, o: { hubId: string; now?: number; pubkey?: string }): LicenceClaim {
  key = key.trim();
  if (!key) throw new Error('Enter the licence key');
  if (!key.startsWith(KEY_PREFIX)) throw new Error(`That doesn’t look like a licence key (it starts with ${KEY_PREFIX})`);
  const [p, s, extra] = key.slice(KEY_PREFIX.length).split('.');
  if (!p || !s || extra !== undefined) throw new Error('The licence key is malformed: it should be a payload and a signature separated by a dot');
  const payload = Buffer.from(p, 'base64url'), sig = Buffer.from(s, 'base64url');
  if (sig.length !== 64 || !verify(null, payload, publicKey(o.pubkey), sig)) {
    throw new Error('The licence key’s signature doesn’t check out: it wasn’t issued by ClickBit, or it was changed or mistyped');
  }
  let c: Partial<LicenceClaim>;
  try { c = JSON.parse(payload.toString('utf8')); } catch { throw new Error('The licence key’s payload isn’t valid'); }
  if (!c.edition) throw new Error('The licence key names no edition');
  if (c.product !== 'kova') throw new Error(c.product ? `This licence is for ${c.product}, not Kova` : 'This licence isn’t a Kova licence');
  if (c.site && c.site !== o.hubId) throw new Error(`This licence is for hub ${c.site}; this hub is ${o.hubId}`);
  if (c.expiresAt && Date.parse(c.expiresAt) < (o.now ?? Date.now())) throw new Error(`This licence expired on ${c.expiresAt.slice(0, 10)}`);
  return { ...c, edition: c.edition, product: c.product, features: Array.isArray(c.features) ? c.features.map(String) : [] };
}
