import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const CAMERAS = ['office_cam', 'garage_cam', 'doorbell'];

interface Received { url: string; headers: IncomingHttpHeaders; body: any }

/** A tiny HTTP server that answers each POST with the next scripted reply and records what it got. */
async function fakeServer(replies: unknown[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const r = replies[Math.min(received.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>(ok => server.close(() => ok())) };
}

const openAiToolCall = (name: string, args: unknown) => ({
  id: 'c1', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const openAiText = (text: string) => ({ id: 'c2', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

const anthropicMsg = (content: unknown[], stop_reason: string) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

async function setup(startHour = 19.5, ai: { anthropicBaseUrl?: string } = {}) {
  const t = await testHub(startHour);
  const app = await buildServer(t.hub, { webRoot, ai: { timeoutMs: 3000, ...ai } });
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/assistant/settings', payload: payload as object });
  const ask = async (text: string) => (await app.inject({ method: 'POST', url: '/api/ask', payload: { text } })).json();
  return { ...t, app, put, ask };
}

test('Local AI: tool call changes a device through the engine, logged, tagged and undoable', async () => {
  const fake = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lamp', bri: 30 }] }), openAiText('Lamp is at 30% now.')]);
  const { hub, app, put, ask, dev } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'llama3' } });
  await hub.engine.command('lamp', { on: false });

  const r = await ask('make the lounge feel cosy');
  assert.equal(r.text, 'Lamp is at 30% now.');
  assert.equal(r.source, 'Local AI on your server');
  assert.equal(r.understood, true);
  assert.equal(dev('lamp').on, true);
  assert.equal(dev('lamp').bri, 30);

  // Two round trips: the request, then the tool result.
  assert.equal(fake.received.length, 2);
  assert.equal(fake.received[0].url, '/v1/chat/completions');
  assert.equal(fake.received[0].body.model, 'llama3');
  assert.deepEqual(fake.received[0].body.tools.map((t: any) => t.function.name), ['set_devices', 'start_overlay', 'end_overlay', 'explain_device', 'list_schedule']);
  const toolMsg = fake.received[1].body.messages.find((m: any) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(JSON.parse(toolMsg.content).ok, true);

  // Default sharing: names and states yes; presence and history no; cameras never.
  const sent = JSON.stringify(fake.received[0].body);
  assert.match(sent, /Lamp/);
  assert.match(sent, /\\"bri\\"/);
  assert.doesNotMatch(sent, /Who's home/);
  assert.doesNotMatch(sent, /Activity, last 7 days/);
  assert.doesNotMatch(sent, /Methel|Brishti/);
  for (const c of CAMERAS) assert.ok(!sent.includes(c), `camera ${c} was sent`);

  // Logged in Activity: the request itself, and the change with its AI cause.
  const feed = hub.store.feed(20);
  const req = feed.find(e => e.what === 'Ask Kova sent a request to Local AI');
  assert.ok(req);
  assert.equal(req.feed, 'system');
  assert.equal(req.data.engine, 'local');
  assert.ok((req.data.chars as number) > 0);
  assert.deepEqual(req.cause, { kind: 'assistant', label: 'Ask Kova' });
  assert.ok(feed.some(e => e.kind === 'run' && e.cause.label === 'Ask Kova (AI)'));

  assert.ok(r.undo);
  await app.inject({ method: 'POST', url: `/api/undo/${r.undo}` });
  assert.equal(dev('lamp').on, false);

  await app.close(); await hub.stop(); await fake.close();
});

test('Local AI: built-in commands never reach the AI', async () => {
  const fake = await fakeServer([openAiText('should not be called')]);
  const { hub, app, put, ask, dev } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'llama3' } });
  const r = await ask('lamp to 30%');
  assert.equal(r.source, 'Device control');
  assert.equal(dev('lamp').bri, 30);
  assert.equal(fake.received.length, 0);
  assert.ok(!hub.store.feed(20).some(e => e.what.startsWith('Ask Kova sent a request')));
  await app.close(); await hub.stop(); await fake.close();
});

test('Share toggles control the context; cameras are never sent', async () => {
  const fake = await fakeServer([openAiText('ok')]);
  const { hub, app, put, ask } = await setup();
  await hub.engine.setPresence('brishti', false);

  const on = (await put({ engine: 'local', local: { url: fake.url, model: 'm' }, share: { names: true, rooms: true, history: true, presence: true, cameras: true } })).json();
  assert.equal(on.share.cameras, false, 'cameras forced off');
  await ask('make the lounge feel cosy');
  const all = JSON.stringify(fake.received[0].body);
  assert.match(all, /Who's home: Methel home, Brishti out/);
  assert.match(all, /Activity, last 7 days/);
  assert.match(all, /Brishti left home/);
  for (const c of CAMERAS) assert.ok(!all.includes(c), `camera ${c} was sent`);
  assert.doesNotMatch(all, /Camera|Doorbell/);

  await put({ share: { names: false, rooms: false, history: false, presence: false } });
  await ask('make the lounge feel cosy');
  const none = JSON.stringify(fake.received[1].body);
  assert.doesNotMatch(none, /Lamp|Lounge|kitchen_ceiling/);
  assert.doesNotMatch(none, /\\"state\\"/);
  assert.doesNotMatch(none, /Who's home|Methel|Brishti/);
  assert.doesNotMatch(none, /Activity, last 7 days/);
  assert.match(none, /device1/);
  await app.close(); await hub.stop(); await fake.close();
});

test('Settings: keys are write-only and never returned', async () => {
  const { hub, app, put } = await setup();
  const r = await put({ engine: 'cloud', cloud: { apiKey: 'sk-ant-secret-123' }, local: { url: 'http://192.168.1.5:11434', model: 'qwen', apiKey: 'local-secret' } });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes('secret'));
  const g = await app.inject({ url: '/api/assistant/settings' });
  assert.ok(!g.body.includes('secret'));
  const s = g.json();
  assert.equal(s.engine, 'cloud');
  assert.deepEqual(s.cloud, { model: 'claude-opus-5-5', hasKey: true });
  assert.deepEqual(s.local, { url: 'http://192.168.1.5:11434', model: 'qwen', hasKey: true });
  assert.equal(s.share.cameras, false);
  // Changing other settings keeps the key; an empty key clears it.
  await put({ share: { history: true } });
  assert.equal(hub.store.get<any>('assistant').cloud.apiKey, 'sk-ant-secret-123');
  assert.equal((await put({ cloud: { apiKey: '' } })).json().cloud.hasKey, false);
  assert.equal((await put({ engine: 'nope' })).statusCode, 400);
  await app.close(); await hub.stop();
});

test('Cloud AI: Anthropic Messages tool loop against a fake endpoint', async () => {
  const fake = await fakeServer([
    anthropicMsg([{ type: 'text', text: 'Starting Movie.' }, { type: 'tool_use', id: 'toolu_1', name: 'start_overlay', input: { id: 'movie' } }], 'tool_use'),
    anthropicMsg([{ type: 'text', text: 'Movie is on. Enjoy.' }], 'end_turn'),
  ]);
  const { hub, app, put, ask } = await setup(19.5, { anthropicBaseUrl: fake.url });
  await put({ engine: 'cloud', cloud: { apiKey: 'sk-ant-test' } });

  const r = await ask('help me relax');
  assert.equal(r.text, 'Movie is on. Enjoy.');
  assert.equal(r.source, 'Cloud AI · sent names and device states');
  assert.equal(hub.engine.overlay?.id, 'movie');
  assert.ok(r.undo);

  assert.equal(fake.received.length, 2);
  const first = fake.received[0];
  assert.match(first.url, /^\/v1\/messages/);
  assert.equal(first.headers['x-api-key'], 'sk-ant-test');
  assert.equal(first.headers.authorization, undefined);
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.deepEqual(first.body.tools.map((t: any) => t.name), ['set_devices', 'start_overlay', 'end_overlay', 'explain_device', 'list_schedule']);
  assert.ok(!('tool_choice' in first.body) || first.body.tool_choice.type === 'auto');
  const sys = JSON.stringify(first.body.system);
  for (const c of CAMERAS) assert.ok(!sys.includes(c), `camera ${c} was sent`);
  // The tool result goes back in one user turn after the unchanged assistant turn.
  const msgs = fake.received[1].body.messages;
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content[1].type, 'tool_use');
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].content[0].tool_use_id, 'toolu_1');

  assert.ok(hub.store.feed(20).some(e => e.what === 'Ask Kova sent a request to Cloud AI'));
  await app.inject({ method: 'POST', url: `/api/undo/${r.undo}` });
  assert.equal(hub.engine.overlay, null);
  await app.close(); await hub.stop(); await fake.close();
});

test('Errors come back as replies, never thrown', async () => {
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: 'http://127.0.0.1:1', model: 'm' } });
  const r = await ask('make the lounge feel cosy');
  assert.match(r.text, /^Couldn’t reach your local AI at http:\/\/127\.0\.0\.1:1/);
  assert.equal(r.understood, false);
  assert.equal(r.source, 'Local AI on your server');

  await put({ engine: 'cloud', cloud: { apiKey: '' } });
  const c = await ask('make the lounge feel cosy');
  assert.match(c.text, /needs your API key/);
  await app.close(); await hub.stop();
});
