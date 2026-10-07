import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askKova, Cancelled, engineLine, followJob, mergeHistory, progressLines, sourceIcon, STILL_WAITING, SENT_NO_ANSWER, type AskJob, type ChatMsg } from '../src/logic/ask.ts';

// Ask Kova from the phone, against a fake hub: a long request followed to its answer through dropped polls, a hub
// that restarted, and answers that landed while the app was away.

const err = (status: number, message: string, timedOut = false) => Object.assign(new Error(message), { status, timedOut });
const job = (rev: number, over: Partial<AskJob> = {}): AskJob => ({ id: 'j1', text: 'big ask', status: 'working', engine: { kind: 'cloud', label: 'MiniMax' }, steps: [], started: 0, rev, ...over });
const REPLY = { text: 'Done:\n- Combined the TV', source: 'MiniMax · sent names', actions: [], understood: true, engine: 'cloud' as const };

/** A fake hub: POST answers with a job; each GET pops the next scripted answer (an AskJob or an error to throw). */
function fakeHub(gets: (AskJob | Error)[], post: unknown = { job: job(1) }) {
  const seen: string[] = [];
  const api = async <T,>(method: string, path: string, _body?: unknown, timeoutMs?: number): Promise<T> => {
    seen.push(`${method} ${path} ${timeoutMs ?? ''}`.trim());
    if (method === 'POST') { if (post instanceof Error) throw post; return post as T; }
    const next = gets.shift();
    if (!next) throw new Error('no more scripted answers');
    if (next instanceof Error) throw next;
    return next as T;
  };
  return { api, seen };
}
const noSleep = async () => {};

test('A long ask: steps arrive as they happen, then the answer — no request is ever held for the whole minute', async () => {
  const h = fakeHub([
    job(2, { steps: [{ tool: 'combine_devices', label: 'Combining Bedroom TV and TV', status: 'working' }] }),
    job(3, { steps: [{ tool: 'combine_devices', label: 'Combining Bedroom TV and TV', status: 'ok' }, { tool: 'update_device', label: 'Moving Lamp to Entryway', status: 'working' }] }),
    job(4, { status: 'done', reply: REPLY, steps: [] }),
  ]);
  const titles: string[] = [];
  const r = await askKova('big ask', { api: h.api, sleep: noSleep, onJob: j => titles.push(progressLines(j).steps.map(s => s.label).join(' | ') || progressLines(j).title) });
  assert.deepEqual(r, REPLY);
  assert.deepEqual(titles, ['Asking MiniMax…', 'Combining Bedroom TV and TV…', 'Combining Bedroom TV and TV | Moving Lamp to Entryway…', 'Asking MiniMax…']);
  assert.equal(h.seen[0], 'POST /api/ask 25000');
  // Each follow passes the last rev and waits 20 s at the hub, with a phone-side limit just above that.
  assert.deepEqual(h.seen.slice(1), ['GET /api/ask/jobs/j1?rev=1&wait=20 30000', 'GET /api/ask/jobs/j1?rev=2&wait=20 30000', 'GET /api/ask/jobs/j1?rev=3&wait=20 30000']);
});

test('A built-in answer comes straight back, no job', async () => {
  const h = fakeHub([], { text: 'Lamp set to 30%.', source: 'Device control', actions: [], understood: true, engine: 'builtin' });
  const r = await askKova('lamp to 30%', { api: h.api });
  assert.equal(r.text, 'Lamp set to 30%.');
  assert.equal(h.seen.length, 1);
});

test('Follows that can’t get through are tried again, without giving up and without “can’t reach the hub”', async () => {
  const offline = () => err(0, 'Can’t reach the hub. Is this phone on the home network?');
  const h = fakeHub([offline(), offline(), offline(), job(1), offline(), job(5, { status: 'done', reply: REPLY })]);
  const trouble: (string | null)[] = [];
  const waits: number[] = [];
  const r = await followJob(job(1), { api: h.api, sleep: async ms => { waits.push(ms); }, onTrouble: m => trouble.push(m) });
  assert.equal(r.text, REPLY.text);
  // Said once after the second miss, cleared when a follow worked again.
  assert.deepEqual(trouble, [STILL_WAITING, null]);
  assert.doesNotMatch(STILL_WAITING, /can’t reach/i);
  assert.deepEqual(waits, [1000, 2000, 3000, 1000]);
});

test('A follow that hangs past its own time limit is just asked again', async () => {
  const h = fakeHub([err(0, 'The hub didn’t answer in time.', true), job(2, { status: 'done', reply: REPLY })]);
  assert.equal((await followJob(job(1), { api: h.api, sleep: noSleep })).text, REPLY.text);
});

test('The hub restarted and lost the job: say that, don’t say it can’t be reached', async () => {
  const h = fakeHub([err(404, 'The hub restarted before it finished that request. Some of it may have been done — check, then ask again.')]);
  const r = await followJob(job(1), { api: h.api, sleep: noSleep });
  assert.equal(r.failed, true);
  assert.match(r.text, /restarted/);
});

test('A POST that timed out may have reached the hub: say the answer will show, don’t claim it failed to reach', async () => {
  const h = fakeHub([], err(0, 'The hub didn’t answer in time.', true));
  const r = await askKova('big ask', { api: h.api });
  assert.equal(r.text, SENT_NO_ANSWER);
  // Nothing answered at all: that's the one time "can't reach" is right, and it's the caller's to show.
  const off = fakeHub([], err(0, 'Can’t reach the hub. Is this phone on the home network?'));
  await assert.rejects(askKova('x', { api: off.api }), /Can’t reach the hub/);
});

test('Leaving the screen stops following (the hub carries on); a refused key stops too', async () => {
  let stop = false;
  const h = fakeHub([job(2), job(3)]);
  await assert.rejects(followJob(job(1), { api: h.api, sleep: noSleep, cancelled: () => stop, onJob: j => { if (j.rev === 2) stop = true; } }), Cancelled);
  const k = fakeHub([err(401, 'Your hub didn’t accept this phone’s key.')]);
  await assert.rejects(followJob(job(1), { api: k.api, sleep: noSleep }), /key/);
});

test('Answers that landed while the app was away join the chat once, in order', () => {
  const greet: ChatMsg = { id: 'g', from: 'kova', text: 'Hi.' };
  const shown: ChatMsg[] = [greet, { id: 'a', from: 'you', text: 'lamp to 30%', ts: 1000 }, { id: 'b', from: 'kova', text: 'Lamp set to 30%.', ts: 1100 }];
  const turns = [
    { role: 'user' as const, text: 'lamp to 30%', ts: 1000 },
    { role: 'assistant' as const, text: 'Lamp set to 30%.', ts: 1050 },
    { role: 'user' as const, text: 'big ask', ts: 2000, job: 'j1' },
    { role: 'assistant' as const, text: 'Done:\n- Combined', ts: 90_000, job: 'j1', source: 'MiniMax · sent names', engine: 'cloud' as const, undo: 'u1' },
  ];
  const out = mergeHistory(shown, turns);
  assert.deepEqual(out.map(m => `${m.from}:${m.text}`), ['kova:Hi.', 'you:lamp to 30%', 'kova:Lamp set to 30%.', 'you:big ask', 'kova:Done:\n- Combined']);
  assert.equal(out[4]!.undo, 'u1');
  assert.equal(out[4]!.engine, 'cloud');
  // Merging again adds nothing.
  assert.equal(mergeHistory(out, turns).length, out.length);
});

test('The header and footers name the engine actually in use', () => {
  assert.deepEqual(engineLine({ kind: 'builtin', label: 'Built in' }), { icon: 'lock', text: 'Built in · works without the internet', tone: 'green' });
  assert.equal(engineLine({ kind: 'cloud', label: 'MiniMax', ready: true }).text, 'Built in, then MiniMax (online)');
  assert.equal(engineLine({ kind: 'local', label: 'Local AI', ready: true }).icon, 'dns');
  assert.equal(engineLine({ kind: 'cloud', label: 'MiniMax', ready: false }).text, 'MiniMax isn’t set up · built in only');
  assert.equal(engineLine(undefined).tone, 'green', 'an older hub that doesn’t say');
  // A MiniMax reply's footer is a cloud, not a lock.
  assert.equal(sourceIcon('MiniMax · sent names and device states', 'cloud'), 'cloud');
  assert.equal(sourceIcon('MiniMax · sent names and device states'), 'cloud');
  assert.equal(sourceIcon('Local AI on your server', 'local'), 'dns');
  assert.equal(sourceIcon('Device control', 'builtin'), 'toggle_on');
});

test('Every icon Ask uses is in the app’s icon font', async () => {
  const { ICON_CODES } = await import('../src/ui/icon-codes.ts');
  const used = ['lock', 'dns', 'cloud', 'error', 'toggle_on', 'history', 'routine', 'check_circle', 'pending',
    ...[undefined, { kind: 'local' as const, label: 'L' }, { kind: 'cloud' as const, label: 'C' }, { kind: 'cloud' as const, label: 'C', ready: false }].map(e => engineLine(e).icon),
    ...['Device control', 'Learned · no AI needed', 'X · sent names', 'Local AI on your server', 'other'].map(s => sourceIcon(s))];
  for (const i of used) assert.ok(i in ICON_CODES, i);
});
