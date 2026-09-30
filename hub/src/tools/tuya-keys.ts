import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importFromCloud, REGIONS, type ImportedDevice, type Room } from '../adapters/tuya/cloud.ts';
import { loadIntegrations, saveIntegrations } from '../integrations.ts';

// Fetch Tuya local keys from the Tuya IoT cloud, once. Kova then controls the devices on the LAN.
// Keys are never printed; with --merge they're written to integrations.json (owner-only).
//
//   npx tsx src/tools/tuya-keys.ts --client-id … --secret … --region eu [--uid …] [--merge ../data/integrations.json]
//
// The client id and secret can also come from TUYA_CLIENT_ID / TUYA_SECRET, to keep them out of shell history.

const USAGE = `Usage: tsx src/tools/tuya-keys.ts --client-id ID --secret SECRET [--region ${Object.keys(REGIONS).join('|')}] [--uid UID]
                               [--merge path/to/integrations.json] [--no-discover] [--discover-ms 6000] [--base-url URL]`;

export function table(rows: ImportedDevice[]): string {
  const head = ['Name', 'Id', 'Category', 'Key', 'IP', 'Kova', 'Status'];
  const body = rows.map(r => [r.name, r.id, [r.category, r.product].filter(Boolean).join(' · '), r.hasKey ? 'yes' : 'no', r.host ?? '—', r.as ?? '—', r.status + (r.note ? ` (${r.note})` : '')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => Math.min(b[i].length, i === 6 ? 200 : 40))));
  const line = (c: string[]) => c.map((x, i) => (x.length > w[i] ? x.slice(0, w[i] - 1) + '…' : x).padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map(n => '-'.repeat(n))), ...body.map(line)].join('\n');
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      'client-id': { type: 'string' }, secret: { type: 'string' }, region: { type: 'string', default: 'eu' }, uid: { type: 'string' },
      merge: { type: 'string' }, 'base-url': { type: 'string' }, 'no-discover': { type: 'boolean', default: false }, 'discover-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const clientId = a['client-id'] ?? process.env.TUYA_CLIENT_ID;
  const secret = a.secret ?? process.env.TUYA_SECRET;
  if (a.help || !clientId || !secret) { console.error(USAGE); process.exit(a.help ? 0 : 1); }

  const mergePath = a.merge ? resolve(a.merge) : undefined;
  const current = mergePath ? loadIntegrations(mergePath) ?? {} : {};
  // Rooms come from home.json next to integrations.json, so new devices land in the right room.
  let rooms: Room[] = [];
  const homeFile = mergePath ? join(dirname(mergePath), 'home.json') : undefined;
  if (homeFile && existsSync(homeFile)) { try { rooms = (JSON.parse(readFileSync(homeFile, 'utf8')) as { rooms?: Room[] }).rooms ?? []; } catch { /* no rooms */ } }

  const r = await importFromCloud({
    clientId, secret, region: a.region, uid: a.uid, baseUrl: a['base-url'], existing: current.tuya, rooms,
    discoverMs: a['no-discover'] ? 0 : Number(a['discover-ms'] ?? 6000),
    log: l => console.error(l),
  });
  console.log(table(r.devices));
  if (mergePath) {
    saveIntegrations(mergePath, { ...current, tuya: r.tuya });
    const n = (s: ImportedDevice['status']) => r.devices.filter(d => d.status === s).length;
    console.log(`\nWrote ${mergePath}: ${n('added')} added, ${n('updated')} updated, ${n('skipped')} skipped. It holds local keys: keep it private. Restart the hub to use it.`);
    const noIp = r.tuya.devices.filter(d => !d.host);
    if (noIp.length) console.log(`No IP yet for: ${noIp.map(d => d.name ?? d.id).join(', ')}. Run this again on the same network as the devices, or set "host" by hand (your router's DHCP list shows them).`);
  } else {
    console.log('\nNothing written. Add --merge ../data/integrations.json to save the keys for Kova.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
