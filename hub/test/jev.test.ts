import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { JevAdvisor } from '../src/services/jev.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

interface Received { headers: IncomingHttpHeaders; body: any }

const openAiToolCall = (name: string, args: unknown) => ({
  id: 'c1', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const openAiText = (text: string) => ({ id: 'c2', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] });

async function fakeOpenAi(replies: unknown[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const r = replies[Math.min(received.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>(ok => server.close(() => ok())) };
}

async function fakeJev(answer: Record<string, unknown>) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'jev_test', model: 'jev-test', answers: answer, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>(ok => server.close(() => ok())) };
}

test('Jev gate: advisory action review over the System One API', async () => {
  const fake = await fakeJev({ risk: { score: 0.6, confidence: 0.9 }, safe: { noul: 0.91 } });
  const { hub } = await testHub();
  const jev = new JevAdvisor({ apiKey: 'test-key', baseUrl: fake.url, model: 'jev-test', store: hub.store });
  const app = await buildServer(hub, { webRoot, jev });

  assert.deepEqual((await app.inject('/api/jev/status')).json(), {
    configured: true,
    model: 'jev-test',
    baseUrl: fake.url,
    timeoutMs: 20_000,
    note: 'Structured advisory decisions are available.',
  });

  const r = await app.inject({ method: 'POST', url: '/api/jev/gate', payload: { action: 'Delete the bedtime automation', context: 'Ask Kova proposed it after the user asked to remove it.' } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.recommendation, 'allow');
  assert.equal(body.riskScore, 0.6);
  assert.equal(body.safeProbability, 0.91);

  assert.equal(fake.received.length, 1);
  assert.equal(fake.received[0].headers.authorization, 'Bearer test-key');
  assert.equal(fake.received[0].body.model, 'jev-test');
  assert.match(fake.received[0].body.state, /Delete the bedtime automation/);
  assert.deepEqual(Object.keys(fake.received[0].body.questions), ['risk', 'safe']);

  const audit = hub.store.feed(10).find(e => e.what === 'Asked Jev for a decision');
  assert.ok(audit);
  assert.equal(audit.data.ok, true);
  assert.equal(typeof audit.data.stateSha, 'string');
  assert.ok(!JSON.stringify(audit.data).includes('Delete the bedtime'));

  await app.close(); await hub.stop(); await fake.close();
});

test('Jev presence review: explains evidence without changing Kova state', async () => {
  const fake = await fakeJev({ state: { choice: 'home', confidence: 0.82, probabilities: { home: 0.82, away: 0.1, uncertain: 0.08 } }, enough: { noul: 0.9 } });
  const { hub, clock } = await testHub();
  const jev = new JevAdvisor({ apiKey: 'test-key', baseUrl: fake.url, model: 'jev-test', store: hub.store });
  const app = await buildServer(hub, { webRoot, jev });
  await hub.engine.setPresence('methel', true, 'Router (Warden)', {
    confidence: 0.86,
    evidence: [
      { source: 'Router (Warden)', kind: 'warden', home: true, weight: 0.75, reliability: 0.84, at: clock.t - 60_000 },
      { source: 'Kova app (location)', kind: 'app', home: false, weight: 0.4, reliability: 0.9, at: clock.t - 20 * 60_000 },
    ],
  });

  const r = await app.inject('/api/jev/presence-review?person=methel');
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.people[0].id, 'methel');
  assert.equal(body.people[0].current.home, true);
  assert.equal(body.people[0].review.state.choice, 'home');
  assert.equal(body.people[0].review.enough.noul, 0.9);
  assert.equal(hub.engine.people.methel.home, true, 'review is advisory only');

  const sent = fake.received[0].body;
  assert.match(sent.state, /Router \(Warden\)/);
  assert.match(sent.state, /Kova app \(location\)/);
  assert.doesNotMatch(sent.state, /Methel/, 'person names stay local');

  await app.close(); await hub.stop(); await fake.close();
});

test('Ask Kova can call Jev review_action before a risky change', async () => {
  const jevFake = await fakeJev({ risk: { score: 0.7, confidence: 0.88 }, safe: { noul: 0.9 } });
  const aiFake = await fakeOpenAi([
    openAiToolCall('review_action', { action: 'Delete the bedtime automation', context: 'The user asked whether to remove it.' }),
    openAiText('Jev says it looks safe to remove.'),
  ]);
  const { hub } = await testHub();
  const jev = new JevAdvisor({ apiKey: 'test-key', baseUrl: jevFake.url, model: 'jev-test', store: hub.store });
  const app = await buildServer(hub, { webRoot, jev, ai: { timeoutMs: 3000 } });
  await app.inject({ method: 'PUT', url: '/api/assistant/settings', payload: { engine: 'local', local: { url: aiFake.url, model: 'm' } } });

  const r = await app.inject({ method: 'POST', url: '/api/ask', payload: { text: 'gibberish that needs the ai' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().text, 'Jev says it looks safe to remove.');
  assert.equal(jevFake.received.length, 1);
  const toolMsg = aiFake.received[1].body.messages.find((m: any) => m.role === 'tool');
  assert.match(toolMsg.content, /"recommendation":"allow"/);

  await app.close(); await hub.stop(); await jevFake.close(); await aiFake.close();
});

test('Jev validation and missing key are safe', async () => {
  const { hub } = await testHub();
  const app = await buildServer(hub, { webRoot, jev: new JevAdvisor({ store: hub.store }) });
  assert.equal((await app.inject('/api/jev/status')).json().configured, false);
  const missing = await app.inject({ method: 'POST', url: '/api/jev/gate', payload: { action: 'Turn off every light' } });
  assert.equal(missing.statusCode, 503);
  const bad = await app.inject({ method: 'POST', url: '/api/jev/decide', payload: { state: 'x', questions: { pick: { type: 'choice', instructions: 'Pick', criteria: {} } } } });
  assert.equal(bad.statusCode, 503, 'configuration is checked before request validation');
  await app.close();

  const validating = await buildServer(hub, { webRoot, jev: new JevAdvisor({ apiKey: 'test-key', store: hub.store, fetchFn: async () => { throw new Error('fetch should not run'); } }) });
  const invalid = await validating.inject({ method: 'POST', url: '/api/jev/decide', payload: { state: 'x', questions: { pick: { type: 'choice', instructions: 'Pick', criteria: {} } } } });
  assert.equal(invalid.statusCode, 400);
  await validating.close(); await hub.stop();
});
