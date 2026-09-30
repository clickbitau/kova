import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreBackup } from '../services/backup.ts';
import { LockedError } from '../util/lock.ts';

// Put a Kova backup back. Stop the hub first; this refuses to run while it's up.
//
//   node --import tsx src/tools/restore.ts <backup.tar.gz> [--data <KOVA_DATA>] [--force]
//
// --force ignores a lock file left behind by a hub that crashed (it goes stale by itself after 90 s).
// Exit codes: 0 restored, 1 failed, 2 the data folder is in use.

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const data = flag('--data');
const force = args.includes('--force');
const rest = args.filter(a => a !== '--force');
const archive = rest[0];

if (!archive || rest.length > 1 || archive.startsWith('-')) {
  console.error('Usage: restore.ts <backup.tar.gz> [--data <dir>] [--force]');
  process.exit(1);
}

const dataDir = resolve(data ?? process.env.KOVA_DATA ?? resolve(here, '../../../data'));

try {
  const r = await restoreBackup(resolve(archive), dataDir, { force });
  console.log(`Restored ${r.restored.join(', ')} into ${dataDir}`);
  console.log(`Backup made ${r.manifest.createdAt}${r.manifest.version ? ` by Kova ${r.manifest.version}` : ''}.`);
  if (r.aside) console.log(`The files it replaced are in ${r.aside} (delete that folder once you're happy).`);
  console.log('Start the hub again (e.g. systemctl start kova).');
} catch (err) {
  if (err instanceof LockedError) {
    console.error(`${err.message}.\nStop the hub first (systemctl stop kova, or docker compose stop kova), then run this again.`);
    process.exit(2);
  }
  console.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}\nNothing in ${dataDir} was changed.`);
  process.exit(1);
}
