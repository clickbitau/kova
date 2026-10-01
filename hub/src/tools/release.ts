/**
 * Kova releases from ClickBit's catalog, for deploy/updater.sh (root) — services/release-client.ts does the work.
 *
 *   release.ts check                    → {"offer":{version,gitSha,releaseNotes,…}|null,"soft":…,"error":…}
 *   release.ts download <version> <out> → the bundle at <out>, verified against the catalog's sha256 and size
 *   release.ts verify <dir>             → the unpacked bundle's manifest checked part by part; what it needs
 *
 * One JSON line on stdout each; exit 1 with {"error":…} when it fails. Settings from the environment (kova.env):
 * KOVA_DATA, KOVA_UPDATE_URL (default the ClickBit catalog), KOVA_UPDATE_CHANNEL (stable), KOVA_PRODUCT (kova),
 * KOVA_GIT_SHA (the running commit, when not a release).
 */
import { join } from 'node:path';
import { Catalog, nodeFits, verifyBundle } from '../services/release-client.ts';
import { KOVA_COMMIT, KOVA_VERSION } from '../version.ts';

const env = process.env;
const catalog = new Catalog({
  url: env.KOVA_UPDATE_URL || undefined,
  product: env.KOVA_PRODUCT || env.CLICKBIT_PRODUCT_ID || undefined,
  channel: env.KOVA_UPDATE_CHANNEL || undefined,
  version: KOVA_VERSION,
  gitSha: KOVA_COMMIT ?? (env.KOVA_GIT_SHA || undefined),
  dir: join(env.KOVA_DATA || '/var/lib/kova', 'update'),
  hubIdFile: join(env.KOVA_DATA || '/var/lib/kova', 'hub-id'),
});

const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'check') {
    const r = await catalog.check();
    say({ offer: r.offer, soft: r.soft ?? null, current: { version: KOVA_VERSION, commit: KOVA_COMMIT ?? (env.KOVA_GIT_SHA || null) } });
  } else if (cmd === 'download' && a && b) {
    say(await catalog.download(a, b));
  } else if (cmd === 'verify' && a) {
    const m = await verifyBundle(a);
    say({ version: m.version, gitSha: m.gitSha, nodeMin: m.node.min, ...nodeFits(m) });
  } else {
    process.stderr.write('Usage: release.ts check | download <version> <out> | verify <dir>\n');
    process.exit(64);
  }
} catch (e) {
  say({ error: (e as Error).message });
  process.exit(1);
}
