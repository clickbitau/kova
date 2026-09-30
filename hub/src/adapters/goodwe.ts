import net from 'node:net';
import type { Adapter, AdapterContext, AdapterStatus } from './sdk.ts';
import type { Command, Device, DeviceState } from '../model/types.ts';

// GoodWe solar inverters over Modbus TCP (port 502), read-only.
// The default register map is for the DT family (three-phase, no battery),
// the model in this home. Every address can be overridden in integrations.json
// because GoodWe's maps differ between families and firmware.

/** Minimal Modbus TCP client: read holding registers (function 3). Exported for tests. */
export async function readRegisters(host: string, port: number, unit: number, start: number, count: number, timeoutMs = 5000): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`No reply from inverter at ${host}`)); }, timeoutMs);
    let buf = Buffer.alloc(0);
    sock.once('connect', () => {
      const req = Buffer.alloc(12);
      req.writeUInt16BE(1, 0);        // transaction id
      req.writeUInt16BE(0, 2);        // protocol
      req.writeUInt16BE(6, 4);        // length
      req.writeUInt8(unit, 6);
      req.writeUInt8(3, 7);           // read holding registers
      req.writeUInt16BE(start, 8);
      req.writeUInt16BE(count, 10);
      sock.write(req);
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      const fn = buf[7];
      if (fn & 0x80) { clearTimeout(t); sock.destroy(); reject(new Error(`Inverter refused the read (Modbus error ${buf[8]})`)); return; }
      const bytes = buf[8];
      if (buf.length < 9 + bytes) return;
      clearTimeout(t);
      sock.end();
      const out: number[] = [];
      for (let i = 0; i < bytes / 2; i++) out.push(buf.readUInt16BE(9 + i * 2));
      resolve(out);
    });
    sock.once('error', e => { clearTimeout(t); reject(e); });
  });
}

/** Register addresses (and scale) for the values Kova needs. */
export interface GoodWeMap {
  block: [start: number, count: number];
  /** PV string voltage/current pairs, 0.1 V and 0.1 A. Power is their sum of products. */
  pv: [voltage: number, current: number][];
  /** Energy produced today, 0.1 kWh. */
  eDay: number;
  /** Optional grid meter power, signed 32-bit W (positive = exporting on most firmware). */
  meter?: number;
  /** Set to true if the meter reports import as positive. */
  meterImportPositive?: boolean;
}

export const DT_MAP: GoodWeMap = {
  block: [30100, 73],
  pv: [[30103, 30104], [30105, 30106], [30107, 30108]],
  eDay: 30144,
};

/** Turn a register block into readings. Exported for tests. */
export function decode(map: GoodWeMap, regs: number[]): DeviceState {
  const at = (addr: number) => regs[addr - map.block[0]] ?? 0;
  const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);
  const pv = Math.round(map.pv.reduce((w, [v, i]) => w + (at(v) / 10) * (at(i) / 10), 0));
  const s: DeviceState = { power: pv, energy: at(map.eDay) / 10, online: true };
  if (map.meter != null) {
    const raw = (s16(at(map.meter)) << 16) | at(map.meter + 1);
    const importing = map.meterImportPositive ? raw : -raw;
    s.grid = importing;
    s.load = Math.max(0, pv + importing);
  }
  return s;
}

export interface GoodWeOptions {
  host: string;
  port?: number;
  /** Modbus unit id; GoodWe inverters answer on 247. */
  unit?: number;
  room?: string;
  name?: string;
  id?: string;
  map?: Partial<GoodWeMap>;
  pollMs?: number;
}

export class GoodWeAdapter implements Adapter {
  id = 'goodwe';
  name = 'GoodWe solar';
  icon = 'solar_power';
  kind = 'Local' as const;
  private ctx?: AdapterContext;
  private timer: NodeJS.Timeout | null = null;
  private error: string | null = null;
  private map: GoodWeMap;
  private devId: string;

  constructor(private o: GoodWeOptions) {
    this.map = { ...DT_MAP, ...(o.map ?? {}) };
    this.devId = o.id ?? 'solar_inverter';
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.announce([{ id: this.devId, name: this.o.name ?? 'Solar inverter', room: this.o.room ?? 'garage', type: 'sensor', integration: 'GoodWe', address: this.o.host, capabilities: ['power', 'energy'] }]);
    await this.poll();
    const every = this.o.pollMs ?? 30_000;
    if (every > 0) this.timer = setInterval(() => void this.poll(), every);
  }

  async poll(): Promise<void> {
    try {
      const regs = await readRegisters(this.o.host, this.o.port ?? 502, this.o.unit ?? 247, ...this.map.block);
      this.ctx!.report(this.devId, decode(this.map, regs));
      this.error = null;
    } catch (err) {
      // Inverters go to sleep at night and stop answering: that's zero solar, not a fault.
      this.error = (err as Error).message;
      this.ctx!.report(this.devId, { online: false, power: 0 });
    }
  }

  async command(_d: Device, _c: Command): Promise<void> { throw new Error('The inverter is read-only'); }

  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); }

  status(): AdapterStatus {
    return this.error ? { ok: false, note: `${this.error} (normal at night)` } : { ok: true, note: 'Reading solar production every 30 s' };
  }
}
