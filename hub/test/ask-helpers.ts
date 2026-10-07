import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/hub.ts';
import { VirtualAdapter } from '../src/adapters/virtual.ts';
import { demoConfig, demoDevices } from '../src/seed/demo-home.ts';
import { buildServer } from '../src/api/server.ts';
import type { DeviceInfo } from '../src/adapters/sdk.ts';
import type { HomeConfig } from '../src/model/types.ts';
import { at } from './helpers.ts';

// Fake AI servers and a demo home with a few extra entries, for the Ask Kova tool-loop tests (ask-*.test.ts).

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

export interface Received { url: string; body: any }

/** What the fake model is sent each round: the messages so far (tool results included). */
export type Script = unknown[] | ((body: any, round: number) => unknown);

/** An OpenAI-compatible chat-completions server that answers each POST from a script, optionally slowly. */
export async function fakeModel(script: Script, opts: { delayMs?: number | ((round: number) => number) } = {}) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ url: req.url ?? '', body });
      const round = received.length - 1;
      const step = typeof script === 'function' ? script : script[Math.min(round, script.length - 1)];
      let r: unknown;
      // A script's own assertion failing shows up in the reply, instead of hanging the request.
      try { r = typeof step === 'function' ? (step as (b: any, n: number) => unknown)(body, round) : step; } catch (e) { r = say(`SCRIPT ERROR: ${e instanceof Error ? e.message : String(e)}`); }
      const delay = typeof opts.delayMs === 'function' ? opts.delayMs(round) : opts.delayMs ?? 0;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      }, delay);
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>(ok => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}

/** One model turn calling these tools (in one round). */
export const calls = (...cs: [name: string, args: unknown][]) => ({
  id: 'c', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: cs.map(([name, args], i) => ({ id: `call_${i}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }],
});
export const say = (text: string) => ({ id: 't', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

/** The tool results the model was sent in its last round, parsed. */
export const lastResults = (body: any): any[] => {
  const msgs = body.messages as { role: string; content: string }[];
  const out: any[] = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i]!.role === 'tool'; i--) out.unshift(JSON.parse(msgs[i]!.content));
  return out;
};

/** Extra entries a real home has: the bedroom TV seen through a second and third integration, a ducted AC, a hidden lamp. */
export const EXTRA: DeviceInfo[] = [
  { id: 'oled_cast', name: 'Bedroom OLED (Cast)', room: 'unassigned', type: 'tv', integration: 'Google Cast', address: 'demo.oled_cast', capabilities: ['media', 'volume'], state: { on: false, media: null, vol: 20 } },
  { id: 'oled_dlna', name: 'OLED TV', room: 'unassigned', type: 'tv', integration: 'DLNA', address: 'demo.oled_dlna', capabilities: ['media'], state: { on: false, media: null } },
  { id: 'ducted_ac', name: 'AC', room: 'unassigned', type: 'climate', integration: 'Ducted AC', address: 'demo.ac', capabilities: ['onoff', 'climate', 'zones'],
    state: { on: false, hvac: 'cool', target: 23, temp: 25, zones: [{ n: 1, on: true, open: 100 }, { n: 2, on: false, open: 0 }, { n: 3, on: true, open: 50 }, { n: 4, on: false, open: 0 }] } },
  { id: 'old_lamp', name: 'Old lamp', room: 'lounge', type: 'light', integration: 'Tuya', address: 'demo.old_lamp', capabilities: ['onoff'], state: { on: false } },
  { id: 'gone_plug', name: 'Gone plug', room: 'office', type: 'plug', integration: 'Tuya', address: 'demo.gone_plug', capabilities: ['onoff'], state: { on: false } },
];

/**
 * The demo home plus EXTRA: the bedroom TV and its Cast entry already combined as "Bedroom OLED", the old lamp hidden,
 * the gone plug archived. An Ask engine pointed at `modelUrl` (MiniMax-style cloud, or local).
 */
export async function askHome(opts: { tweak?: (c: HomeConfig) => void; timeoutMs?: number } = {}) {
  const clock = { t: at(19.5) };
  const hub = new Hub({
    dbPath: ':memory:',
    initialConfig: () => {
      const c = demoConfig();
      c.devices = { ...(c.devices ?? {}), bedroom_tv: { hidden: true }, oled_cast: { hidden: true }, old_lamp: { hidden: true }, gone_plug: { archived: true } };
      c.combined = [{ id: 'bedroom_oled', name: 'Bedroom OLED', members: ['bedroom_tv', 'oled_cast'], hid: ['bedroom_tv', 'oled_cast'] }];
      opts.tweak?.(c);
      return c;
    },
    adapters: [new VirtualAdapter([...demoDevices(), ...EXTRA.map(d => ({ ...d, state: { ...d.state } }))])],
    now: () => clock.t,
    tickMs: 0,
    security: { settleMs: 5, frameDelayMs: 5 },
  });
  await hub.start();
  const app = await buildServer(hub, { webRoot, ai: { timeoutMs: opts.timeoutMs ?? 5000 } });
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/assistant/settings', payload: payload as object });
  const ask = async (text: string, job = false) => (await app.inject({ method: 'POST', url: '/api/ask', payload: { text, ...(job ? { job: true } : {}) } })).json();
  const useModel = (url: string, kind: 'local' | 'minimax' = 'minimax') => put(kind === 'local'
    ? { engine: 'local', local: { url, model: 'm' } }
    : { engine: 'cloud', cloud: { provider: 'minimax', apiKey: 'test-key', baseUrl: url } });
  const close = async () => { await app.close(); await hub.stop(); };
  return { hub, app, clock, put, ask, useModel, close };
}
