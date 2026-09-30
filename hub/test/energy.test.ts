import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { Registry } from '../src/devices/registry.ts';
import { GoodWeAdapter, DT_MAP, decode, readRegisters } from '../src/adapters/goodwe.ts';
import { VirtualAdapter, solarWatts } from '../src/adapters/virtual.ts';
import { Energy } from '../src/services/energy.ts';
import { at, TZ } from './helpers.ts';

/** A fake Modbus TCP inverter holding a register block. */
function fakeInverter(regs: Map<number, number>) {
  const reads: [number, number, number][] = [];
  const server = net.createServer(sock => sock.on('data', d => {
    const unit = d[6], start = d.readUInt16BE(8), count = d.readUInt16BE(10);
    reads.push([unit, start, count]);
    const body = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) body.writeUInt16BE(regs.get(start + i) ?? 0, i * 2);
    const head = Buffer.alloc(9);
    head.writeUInt16BE(d.readUInt16BE(0), 0); head.writeUInt16BE(0, 2); head.writeUInt16BE(3 + body.length, 4);
    head[6] = unit; head[7] = 3; head[8] = body.length;
    sock.write(Buffer.concat([head, body]));
  }));
  return { server, reads };
}

test('GoodWe: reads PV strings and today\'s energy over Modbus TCP', async () => {
  // Two strings: 350.0 V × 5.2 A and 340.0 V × 3.0 A; 12.4 kWh today.
  const regs = new Map([[30103, 3500], [30104, 52], [30105, 3400], [30106, 30], [30144, 124]]);
  const f = fakeInverter(regs);
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r));
  const port = (f.server.address() as AddressInfo).port;
  const raw = await readRegisters('127.0.0.1', port, 247, 30100, 73);
  assert.equal(raw.length, 73);
  assert.deepEqual(f.reads[0], [247, 30100, 73]);

  const reg = new Registry(new Store(':memory:'));
  await reg.addAdapter(new GoodWeAdapter({ host: '127.0.0.1', port, pollMs: 0, room: 'garage' }));
  const inv = reg.get('solar_inverter')!;
  assert.equal(inv.type, 'sensor');
  assert.equal(inv.state.power, Math.round(350 * 5.2 + 340 * 3));
  assert.equal(inv.state.energy, 12.4);
  await reg.stop(); f.server.close();
});

test('GoodWe: an asleep inverter reads as zero, not an error on the device', async () => {
  const reg = new Registry(new Store(':memory:'));
  const g = new GoodWeAdapter({ host: '127.0.0.1', port: 1, pollMs: 0 });
  await reg.addAdapter(g);
  assert.equal(reg.get('solar_inverter')!.state.power, 0);
  assert.equal(g.status().ok, false);
  assert.match(g.status().note!, /normal at night/);
  await reg.stop();
});

test('meter decoding gives grid and home use', () => {
  const map = { ...DT_MAP, meter: 30200, meterImportPositive: true };
  const regs = Array(200).fill(0);
  const put = (addr: number, v: number) => { regs[addr - 30100] = v; };
  put(30103, 3000); put(30104, 20);            // 600 W solar
  put(30200, 0); put(30201, 900);              // importing 900 W
  const s = decode({ ...map, block: [30100, 200] }, regs);
  assert.equal(s.power, 600);
  assert.equal(s.grid, 900);
  assert.equal(s.load, 1500);
});

test('Energy: turns samples into today\'s solar, hours and peak', async () => {
  const clock = { t: at(10) };
  const store = new Store(':memory:', () => clock.t);
  const reg = new Registry(store);
  const v = new VirtualAdapter([{ id: 'inv', name: 'Solar inverter', room: 'garage', type: 'sensor', integration: 'x', address: 'x', capabilities: ['power', 'energy'], state: {} }]);
  await reg.addAdapter(v);
  const e = new Energy(store, reg, () => TZ, () => clock.t);
  assert.equal(e.today().available, true);
  for (let m = 0; m < 120; m++) {           // 10:00–12:00 at 2 kW, sampled each minute
    clock.t = at(10 + m / 60);
    v.physical('inv', { power: 2000 });
    e.sample();
  }
  clock.t = at(12);
  const t = e.today();
  assert.ok(Math.abs(t.hours[10].solar - 2) < 0.05, `hour 10 = ${t.hours[10].solar}`);
  assert.ok(Math.abs(t.solarKwh - 4) < 0.1);
  assert.equal(t.peak!.w, 2000);
  assert.equal(t.usedKwh, null, 'no meter, no home use');
  v.physical('inv', { energy: 4.2 });
  assert.equal(e.today().solarKwh, 4.2, 'the inverter\'s own counter wins');
  await reg.stop();
});

test('simulated solar follows the sun', () => {
  const sim = { lat: -31.95, lon: 115.86, peakW: 2900 };
  assert.equal(solarWatts(sim, at(0)), 0);
  assert.ok(solarWatts(sim, at(12.5)) > 2000);
  assert.ok(solarWatts(sim, at(8)) < solarWatts(sim, at(12)));
});
