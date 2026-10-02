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
  assert.deepEqual(s.cloud, { provider: 'anthropic', model: 'claude-opus-5-5', hasKey: true });
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

test('Cloud AI: MiniMax provider uses the OpenAI-compatible loop with the preset defaults', async () => {
  const fake = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lamp', bri: 40 }] }), openAiText('Lamp set to 40%.')]);
  const { hub, app, put, ask, dev } = await setup();
  const r = await put({ engine: 'cloud', cloud: { provider: 'minimax', apiKey: 'sk-cp-test', baseUrl: fake.url } });
  assert.equal(r.statusCode, 200);
  const s = (await app.inject({ url: '/api/assistant/settings' })).json();
  assert.equal(s.cloud.provider, 'minimax');
  assert.equal(s.cloud.model, 'MiniMax-M2.7-highspeed'); // provider default
  assert.equal(s.cloud.hasKey, true);

  const a = await ask('make the lounge feel cosy');
  assert.equal(a.text, 'Lamp set to 40%.');
  assert.equal(a.source, 'MiniMax · sent names and device states');
  assert.equal(dev('lamp').bri, 40);

  // OpenAI-compatible request: bearer key, /v1/chat/completions, tools.
  assert.equal(fake.received[0].url, '/v1/chat/completions');
  assert.equal(fake.received[0].headers.authorization, 'Bearer sk-cp-test');
  assert.equal(fake.received[0].body.model, 'MiniMax-M2.7-highspeed');
  assert.ok(hub.store.feed(20).some(e => e.what === 'Ask Kova sent a request to MiniMax' && e.data.engine === 'cloud'));
  await app.close(); await hub.stop(); await fake.close();
});

test('Learned: an AI-run phrase replays without the AI; undo forgets it', async () => {
  const fake = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lamp', bri: 30 }] }), openAiText('Lamp is at 30%.')]);
  const { hub, app, put, ask, dev } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'llama3' } });

  const r1 = await ask('make the lounge feel cosy');
  assert.equal(r1.understood, true);
  assert.equal(dev('lamp').bri, 30);
  assert.equal(fake.received.length, 2);

  // Learned phrase was stored.
  const learned = (await app.inject({ url: '/api/assistant/learned' })).json();
  assert.deepEqual(learned.map((x: any) => x.phrase), ['make the lounge feel cosy']);

  // Same ask: no AI call, replayed locally.
  const r2 = await ask('Make the lounge feel cosy!');
  assert.equal(r2.source, 'Learned · no AI needed');
  assert.equal(r2.understood, true);
  assert.equal(fake.received.length, 2, 'no new request to the AI');

  // Undoing the AI's first run forgets the phrase.
  await app.inject({ method: 'POST', url: `/api/undo/${r1.undo}` });
  assert.deepEqual((await app.inject({ url: '/api/assistant/learned' })).json(), []);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/assistant/learned/nope' })).statusCode, 404);
  await app.close(); await hub.stop(); await fake.close();
});

test('Requests log captures what reached the AI, with the tools it ran', async () => {
  const fake = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lamp', on: true }] }), openAiText('done')]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'llama3' } });
  await ask('gibberish that needs the ai');

  const log = (await app.inject({ url: '/api/assistant/requests' })).json();
  assert.equal(log[0].text, 'gibberish that needs the ai');
  assert.equal(log[0].engine, 'Local AI');
  assert.deepEqual(log[0].tools, ['set_devices']);
  assert.equal(log[0].ok, true);
  await app.close(); await hub.stop(); await fake.close();
});

test('Reasoning models: <think> blocks never reach the reply', async () => {
  const fake = await fakeServer([openAiText('<think>\nreasoning here\n</think>\nHi there!')]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm2.7' } });
  const r = await ask('say something kind');
  assert.equal(r.text, 'Hi there!');
  await app.close(); await hub.stop(); await fake.close();
});

test('Greeting is answered by the built-in parser, no AI call', async () => {
  const fake = await fakeServer([openAiText('should not run')]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' } });
  const r = await ask('hi');
  assert.equal(r.understood, true);
  assert.match(r.text, /What do you need\?/);
  assert.equal(fake.received.length, 0);
  await app.close(); await hub.stop(); await fake.close();
});

test('AI can set any field a device exposes (childLock), even with no named parameter', async () => {
  const fake = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lounge_purifier', set: { childLock: true } }] }), openAiText('Child lock is on.')]);
  const { hub, app, put, ask, dev } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' } });

  const r = await ask('turn on child lock on the lounge purifier');
  assert.equal(r.text, 'Child lock is on.');
  assert.equal(dev('lounge_purifier').childLock, true);
  // …and a field the device doesn't have is refused.
  const fake2 = await fakeServer([openAiToolCall('set_devices', { devices: [{ id: 'lamp', set: { childLock: true } }] }), openAiText('Sorry, no.')]);
  const r2 = await ask('turn on child lock on the lamp');
  assert.equal(fake2.received.length >= 1, true);
  assert.equal(dev('lamp').childLock, undefined);
  void r2;
  await app.close(); await hub.stop(); await fake.close(); await fake2.close();
});

test('AI creates a real, validated automation that shows in the engine and can be undone', async () => {
  const fake = await fakeServer([
    openAiToolCall('create_automation', { name: 'Porch off at eight', when: [{ kind: 'time', at: { kind: 'time', at: '08:00' } }], then: [{ kind: 'set', targets: { front_1: { on: false } } }] }),
    openAiText('Done — the porch light goes off at 8 every morning.'),
  ]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' } });

  const r = await ask('can you make sure the porch light is off by 8 am every morning');
  assert.match(r.text, /porch light/i);
  const autos = hub.engine.automations.list();
  const made = autos.find(a => a.name === 'Porch off at eight');
  assert.ok(made, 'automation was saved');
  assert.equal(made.enabled, true);
  assert.ok(r.undo, 'an undo was offered');
  await app.inject({ method: 'POST', url: `/api/undo/${r.undo}` });
  assert.equal(hub.engine.automations.list().find(a => a.name === 'Porch off at eight'), undefined, 'undo removed it');
  await app.close(); await hub.stop(); await fake.close();
});

test('A bad automation is refused by validation, not saved', async () => {
  const fake = await fakeServer([
    openAiToolCall('create_automation', { name: 'Bad', when: [{ kind: 'device', device: 'no_such_thing', to: { on: true } }], then: [{ kind: 'stop' }] }),
    openAiText('I couldn’t set that up.'),
  ]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' } });
  await ask('do something with a device that does not exist');
  assert.equal(hub.engine.automations.list().length, 0);
  await app.close(); await hub.stop(); await fake.close();
});

test("Device questions don't match the generic 'what's on' intent", async () => {
  const fake = await fakeServer([openAiText('The Helix box is idle.')]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' } });
  // Before the fix this parsed as 'whatsOn' and listed the lights.
  const r = await ask('what mode is the helix box on');
  assert.equal(r.source, 'Local AI on your server');
  assert.equal(fake.received.length, 1, 'reached the AI instead of the lights list');
  await app.close(); await hub.stop(); await fake.close();
});

test('Standing instructions reach the AI system prompt', async () => {
  const fake = await fakeServer([openAiText('ok')]);
  const { hub, app, put, ask } = await setup();
  await put({ engine: 'local', local: { url: fake.url, model: 'm' }, instructions: "Baby's room speaker stays quiet." });
  const r = await ask('gibberish that needs the ai');
  assert.match(JSON.stringify(fake.received[0].body), /Baby's room speaker stays quiet/);
  const s = (await app.inject({ url: '/api/assistant/settings' })).json();
  assert.equal(s.instructions, "Baby's room speaker stays quiet.");
  await app.close(); await hub.stop(); await fake.close();
});

test('Cloud AI: unknown provider and bad baseUrl are rejected', async () => {
  const { hub, app, put } = await setup();
  assert.equal((await put({ cloud: { provider: 'nope' } })).statusCode, 400);
  assert.equal((await put({ cloud: { baseUrl: 'not a url' } })).statusCode, 400);
  // openai-compat needs a baseUrl and model; with neither it explains itself.
  await put({ engine: 'cloud', cloud: { provider: 'openai-compat', apiKey: 'k' } });
  const ask = async (text: string) => (await app.inject({ method: 'POST', url: '/api/ask', payload: { text } })).json();
  assert.match((await ask('make the lounge feel cosy')).text, /needs a server address/);
  await app.close(); await hub.stop();
});
