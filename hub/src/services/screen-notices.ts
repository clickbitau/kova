import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub.ts';
import type { DeviceEvent } from '../devices/registry.ts';
import { HelixAdapter } from '../adapters/helix.ts';
import type { Snapshot } from '../adapters/sdk.ts';

/**
 * The doorbell on the TV: when it rings, every Helix screen that's on shows a card with who's there (Helix's
 * D98.5, `POST /v1/players/{id}/notify`), with the doorbell's snapshot.
 *
 * Helix Server fetches the picture itself, so it gets a link of its own: `/api/snap/<key>`, a random key that
 * opens only that one picture, for two minutes. Nothing else of Kova's is reachable with it.
 */
export class SnapLinks {
  private snaps = new Map<string, { snap: Snapshot; until: number }>();
  constructor(private ttlMs = 120_000, private now = () => Date.now()) {}

  put(snap: Snapshot): string {
    const key = randomBytes(16).toString('hex');
    this.snaps.set(key, { snap, until: this.now() + this.ttlMs });
    for (const [k, v] of this.snaps) if (v.until < this.now()) this.snaps.delete(k);
    return key;
  }

  get(key: string): Snapshot | null {
    const s = /^[0-9a-f]{32}$/.test(key) ? this.snaps.get(key) : undefined;
    if (!s || s.until < this.now()) return null;
    return s.snap;
  }
}

export class ScreenNotices {
  private onEvent = (e: DeviceEvent) => { if (e.type === 'ring') void this.ring(e).catch(() => {}); };

  constructor(private hub: Hub, private o: { links: SnapLinks; kovaUrl: () => string | null; seconds?: number; snapshotMs?: number }) {}

  start(): void { this.hub.reg.on('event', this.onEvent); }
  stop(): void { this.hub.reg.off('event', this.onEvent); }

  async ring(e: DeviceEvent): Promise<void> {
    const helix = this.hub.reg.adapters.get('helix');
    if (!(helix instanceof HelixAdapter)) return;
    // Screens in use: a box that's on (playing or paused).
    const boxes = [...this.hub.reg.devices.values()].filter(d => d.adapter === 'helix' && d.state.on && d.state.online !== false);
    if (!boxes.length) return;
    const room = this.hub.config.get().rooms.find(r => r.id === e.device.room)?.name;
    const where = room && /door/i.test(room) ? room.toLowerCase() : room ? `${room.toLowerCase()} door` : 'door';
    let imageUrl: string | undefined;
    const base = this.o.kovaUrl();
    const a = this.hub.reg.adapters.get(e.device.adapter);
    if (base && a?.snapshot) {
      try {
        const snap = await Promise.race([a.snapshot(e.device), new Promise<never>((_, no) => setTimeout(() => no(new Error('slow')), this.o.snapshotMs ?? 4000).unref?.())]);
        imageUrl = `${base}/api/snap/${this.o.links.put(snap)}`;
      } catch { /* the card goes without a picture */ }
    }
    await Promise.all(boxes.map(b => helix.notice(b, { title: `Someone’s at the ${where}`, body: `${e.device.name} rang.`, ...(imageUrl ? { imageUrl } : {}), seconds: this.o.seconds ?? 15 }).catch(() => {})));
  }
}
