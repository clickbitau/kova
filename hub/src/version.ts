import { readFileSync } from 'node:fs';

/** The hub's version, from hub/package.json. */
export const KOVA_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
