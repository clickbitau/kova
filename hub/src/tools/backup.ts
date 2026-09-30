import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, formatSize, pruneBackups } from '../services/backup.ts';
import { KOVA_VERSION } from '../version.ts';

// Make a backup from the command line (deploy/update.sh runs this before updating).
// Safe while the hub is running: SQLite's backup API reads a consistent snapshot.
//
//   node --import tsx src/tools/backup.ts [--data <KOVA_DATA>]

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--data');
const dataDir = resolve((i !== -1 ? args[i + 1] : undefined) ?? process.env.KOVA_DATA ?? resolve(here, '../../../data'));
const dbPath = join(dataDir, 'kova.db');

if (!existsSync(dbPath)) {
  console.error(`No kova.db in ${dataDir}; nothing to back up.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout = 10000');
  const cfg = db.prepare("SELECT value FROM kv WHERE key = 'config'").get() as { value: string } | undefined;
  const timezone = cfg ? (JSON.parse(cfg.value) as { timezone?: string }).timezone : undefined;
  const dir = process.env.KOVA_BACKUP_DIR ? resolve(process.env.KOVA_BACKUP_DIR) : undefined;
  const b = await createBackup({ db, dataDir, dir, timezone, version: KOVA_VERSION, reason: 'cli' });
  const pruned = pruneBackups(dirname(b.path), Number(process.env.KOVA_BACKUP_KEEP ?? 14) || 14);
  console.log(`${b.path} (${formatSize(b.size)})${pruned.length ? ` · removed ${pruned.length} old backup(s)` : ''}`);
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
