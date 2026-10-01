import { readFileSync } from 'node:fs';

/** The hub's version, from hub/package.json. */
export const KOVA_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The commit a release was built from (its manifest.json, beside hub/), or undefined when running from a checkout. */
export const KOVA_COMMIT: string | undefined = (() => {
  try { return (JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')) as { gitSha?: string }).gitSha || undefined; } catch { return undefined; }
})();
