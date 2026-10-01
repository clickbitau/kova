import { generateKeyPairSync, sign } from 'node:crypto';

/** A throwaway ClickBit signing key, and CR1- keys minted with it the way clickbit-admin does. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
export const TEST_PUBKEY = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');

export function mintKey(claim: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ id: 'lic_test', edition: 'home', features: ['updates'], product: 'kova', issuedAt: '2026-10-01T00:00:00Z', ...claim }));
  return `CR1-${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`;
}
