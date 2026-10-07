import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_MS, EXTEND_DEFAULT_MS, EXTEND_RETRY_MS, OFFER_TIMEOUT_MS, LiveSession, elapsedText, extendDelay, injectFor, liveErrorText, livePlayerHtml,
  liveSupport, readPlayerMessage, type LiveView, type ToPlayer,
} from '../src/logic/live.ts';
import { HubError } from '../src/api/client.ts';

/** A clock and timers the test moves by hand. */
function fakeTime(start = Date.parse('2026-10-07T10:00:00Z')) {
  let now = start, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (t: ReturnType<typeof setTimeout>) => { timers.delete(t as unknown as number); },
    pending: () => [...timers.values()].map(t => t.at - now).sort((a, b) => a - b),
    /** Move time on, running what falls due. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
        await flush();
      }
      now = end;
    },
  };
}
const flush = () => new Promise(r => setImmediate(r));

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

function rig(answers: Partial<Record<'offer' | 'extend' | 'stop', (body: unknown) => unknown>> = {}) {
  const t = fakeTime();
  const calls: { path: string; body: unknown; timeoutMs?: number }[] = [];
  const page: ToPlayer[] = [];
  const views: LiveView[] = [];
  const api = async <T,>(_m: 'POST', path: string, body: unknown, timeoutMs?: number): Promise<T> => {
    calls.push({ path, body, timeoutMs });
    const op = path.endsWith('/extend') ? 'extend' : path.endsWith('/stop') ? 'stop' : 'offer';
    const f = answers[op];
    if (f) return await f(body) as T;
    if (op === 'offer') return { answerSdp: 'v=0 answer', mediaSessionId: 'ms-1', expiresAt: new Date(t.now() + 5 * 60_000).toISOString() } as T;
    if (op === 'extend') return { mediaSessionId: 'ms-1', expiresAt: new Date(t.now() + 5 * 60_000).toISOString() } as T;
    return { ok: true } as T;
  };
  const s = new LiveSession('front door', { api, toPage: m => page.push(m), onChange: v => views.push(v), now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
  return { s, t, calls, page, views, phases: () => views.map(v => v.phase) };
}

test('the player page: messages are checked, the page is self-contained and receive-only', () => {
  assert.deepEqual(readPlayerMessage(JSON.stringify({ kova: 'offer', sdp: OFFER })), { kova: 'offer', sdp: OFFER });
  assert.deepEqual(readPlayerMessage({ kova: 'playing' }), { kova: 'playing' });
  assert.deepEqual(readPlayerMessage('{"kova":"failed","reason":"dropped"}'), { kova: 'failed', reason: 'dropped' });
  assert.equal(readPlayerMessage({ kova: 'offer', sdp: 'not sdp' }), null);
  assert.equal(readPlayerMessage({ kova: 'offer', sdp: 'v=0' + 'x'.repeat(70_000) }), null, 'too big');
  assert.equal(readPlayerMessage({ kova: 'failed', reason: 'whatever' }), null);
  assert.equal(readPlayerMessage('nonsense'), null);
  assert.equal(injectFor({ kova: 'mute', muted: false }), 'window.kovaLive && window.kovaLive({"kova":"mute","muted":false}); true;');

  const html = livePlayerHtml();
  assert.match(html, /addTransceiver\('audio',\{direction:'recvonly'\}\);pc.addTransceiver\('video',\{direction:'recvonly'\}\);pc.createDataChannel/, 'audio, video, then the data channel, as Nest wants');
  assert.match(html, /<video id="v" playsinline webkit-playsinline muted autoplay/);
  assert.doesNotMatch(html, /getUserMedia|fetch\(|XMLHttpRequest|<script src|<link /, 'no camera or microphone, no network of its own');
  assert.doesNotMatch(html, /token|authorization/i, 'no hub key in the page');
});

test('watch live: connecting, the offer goes to the hub, the answer back to the page, then live', async () => {
  const r = rig();
  r.s.start();
  assert.equal(r.s.view.phase, 'connecting');
  assert.equal(r.s.view.gen, 1);
  r.s.fromPage({ kova: 'offer', sdp: OFFER });
  await flush();
  assert.deepEqual(r.calls[0], { path: '/api/devices/front%20door/webrtc', body: { offerSdp: OFFER }, timeoutMs: OFFER_TIMEOUT_MS });
  assert.deepEqual(r.page, [{ kova: 'answer', sdp: 'v=0 answer' }]);
  assert.equal(r.s.mediaSessionId, 'ms-1');
  assert.equal(r.s.view.phase, 'connecting', 'still connecting until the video plays');
  await r.t.advance(1_500);
  r.s.fromPage(JSON.stringify({ kova: 'playing' }));
  assert.equal(r.s.view.phase, 'live');
  assert.equal(r.s.view.since, r.t.now());
  // A second offer from the same page is ignored.
  r.s.fromPage({ kova: 'offer', sdp: OFFER });
  await flush();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.phases(), ['connecting', 'live']);
});

test('extended a minute before it expires, for as long as it stays open; a failed extend is retried, then it ends', async () => {
  const r = rig();
  r.s.start(); r.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush(); r.s.fromPage({ kova: 'playing' });
  assert.deepEqual(r.t.pending(), [4 * 60_000], 'expires in 5 min: extend in 4');
  await r.t.advance(4 * 60_000);
  assert.deepEqual(r.calls.at(-1), { path: '/api/devices/front%20door/webrtc/extend', body: { mediaSessionId: 'ms-1' }, timeoutMs: undefined });
  assert.deepEqual(r.t.pending(), [4 * 60_000], 'and again before the new expiry');
  await r.t.advance(3 * 4 * 60_000);
  assert.equal(r.calls.filter(c => c.path.endsWith('/extend')).length, 4);
  assert.equal(r.s.view.phase, 'live');

  // Google says no for a while: retried every 15 s while there's time, then it's over, with the reason.
  const bad = rig({ extend: () => { throw new HubError('Google API 500: Internal', 502, false, 'Google API 500: Internal'); } });
  bad.s.start(); bad.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush(); bad.s.fromPage({ kova: 'playing' });
  await bad.t.advance(4 * 60_000);
  assert.deepEqual(bad.t.pending(), [EXTEND_RETRY_MS]);
  await bad.t.advance(60_000);
  assert.equal(bad.s.view.phase, 'error');
  assert.match(bad.s.view.reason!, /^The stream ended: Google’s camera service had a problem/);
  assert.ok(bad.calls.filter(c => c.path.endsWith('/extend')).length >= 3);
  assert.deepEqual(bad.calls.at(-1), { path: '/api/devices/front%20door/webrtc/stop', body: { mediaSessionId: 'ms-1' }, timeoutMs: undefined }, 'and the hub is told');
  assert.deepEqual(bad.t.pending(), [], 'nothing left running');
});

test('extend timing', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  assert.equal(extendDelay('2026-10-07T10:05:00Z', now), 4 * 60_000);
  assert.equal(extendDelay('2026-10-07T10:00:30Z', now), 10_000, 'never sooner than 10 s');
  assert.equal(extendDelay('', now), EXTEND_DEFAULT_MS);
  assert.equal(extendDelay(undefined, now), EXTEND_DEFAULT_MS);
  assert.equal(extendDelay('soon', now), EXTEND_DEFAULT_MS);
});

test('stopped at the hub on Stop (leaving the screen, the app going away), and the page closes its connection', async () => {
  const r = rig();
  r.s.start(); r.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush(); r.s.fromPage({ kova: 'playing' });
  r.s.stop();
  assert.equal(r.s.view.phase, 'idle');
  assert.deepEqual(r.calls.at(-1), { path: '/api/devices/front%20door/webrtc/stop', body: { mediaSessionId: 'ms-1' }, timeoutMs: undefined });
  assert.deepEqual(r.page.at(-1), { kova: 'stop' });
  assert.deepEqual(r.t.pending(), [], 'no extend left behind');
  r.s.stop();
  assert.equal(r.calls.length, 2, 'stopping twice tells the hub once');
  // Messages from a page after it stopped are ignored.
  r.s.fromPage({ kova: 'offer', sdp: OFFER });
  await flush();
  assert.equal(r.calls.length, 2);
});

test('stopped while the hub was still answering: the stream that just began is ended', async () => {
  let answer!: (v: unknown) => void;
  const r = rig({ offer: () => new Promise(res => { answer = res; }) });
  r.s.start(); r.s.fromPage({ kova: 'offer', sdp: OFFER });
  r.s.stop();
  answer({ answerSdp: 'v=0 late', mediaSessionId: 'ms-late', expiresAt: '' });
  await flush();
  assert.deepEqual(r.calls.map(c => c.path.split('/').pop()), ['webrtc', 'stop']);
  assert.deepEqual(r.calls[1].body, { mediaSessionId: 'ms-late' });
  assert.ok(!r.page.some(m => m.kova === 'answer'), 'the page never gets the late answer');
  assert.equal(r.s.view.phase, 'idle');

  // Same when it was started again (Try again) in between: the old one ends, the new one carries on.
  let first!: (v: unknown) => void;
  let n = 0;
  const q = rig({ offer: () => ++n === 1 ? new Promise(res => { first = res; }) : { answerSdp: 'v=0 b', mediaSessionId: 'ms-b', expiresAt: '' } });
  q.s.start(); q.s.fromPage({ kova: 'offer', sdp: OFFER });
  q.s.start(); q.s.fromPage({ kova: 'offer', sdp: OFFER });
  await flush();
  first({ answerSdp: 'v=0 a', mediaSessionId: 'ms-a', expiresAt: '' });
  await flush();
  assert.equal(q.s.view.gen, 2);
  assert.equal(q.s.mediaSessionId, 'ms-b');
  assert.deepEqual(q.calls.filter(c => c.path.endsWith('/stop')).map(c => c.body), [{ mediaSessionId: 'ms-a' }]);
  assert.deepEqual(q.t.pending(), [CONNECT_MS, EXTEND_DEFAULT_MS], 'the new one waits for video and will be extended');
});

test('errors: the hub’s reason, in plain words; Try again starts over', async () => {
  const r = rig({ offer: () => { throw new HubError('Live view isn’t available for this camera yet', 400, false, 'Live view isn’t available for this camera yet'); } });
  r.s.start(); r.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush();
  assert.equal(r.s.view.phase, 'error');
  assert.equal(r.s.view.reason, 'Live view isn’t available for this camera yet');
  assert.ok(!r.calls.some(c => c.path.endsWith('/stop')), 'nothing to stop');
  r.s.start();
  assert.equal(r.s.view.phase, 'connecting');
  assert.equal(r.s.view.gen, 2, 'a new page');

  // No video within 30 s.
  const slow = rig();
  slow.s.start(); slow.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush();
  await slow.t.advance(CONNECT_MS);
  assert.equal(slow.s.view.phase, 'error');
  assert.match(slow.s.view.reason!, /didn’t arrive/);
  assert.deepEqual(slow.calls.at(-1)?.body, { mediaSessionId: 'ms-1' }, 'the stream is stopped at the hub');

  // The page itself gives up.
  const drop = rig();
  drop.s.start(); drop.s.fromPage({ kova: 'offer', sdp: OFFER }); await flush(); drop.s.fromPage({ kova: 'playing' });
  drop.s.fromPage({ kova: 'failed', reason: 'dropped' });
  assert.equal(drop.s.view.phase, 'error');
  assert.match(drop.s.view.reason!, /dropped/);
  assert.equal(drop.calls.at(-1)?.path, '/api/devices/front%20door/webrtc/stop');
  const old = rig();
  old.s.start(); old.s.fromPage({ kova: 'failed', reason: 'no-webrtc' });
  assert.match(old.s.view.reason!, /can’t play live video/);

  assert.equal(liveErrorText(new HubError('Google API 429: Rate limited', 502, false, 'Google API 429: Rate limited')), 'Google is limiting live streams right now. Try again in a minute.');
  assert.match(liveErrorText(new HubError('x', 502, false, 'Google API 403: The caller does not have permission')), /Link Google Nest again/);
  assert.equal(liveErrorText(new HubError('x', 502, false, 'Google API 400: Bad offer')), 'Google said: Bad offer');
  assert.equal(liveErrorText(new HubError('x', 502, false, 'Google returned no WebRTC answer')), 'Google returned no WebRTC answer');
  assert.match(liveErrorText(new HubError('The hub didn’t answer in time.', 0, true)), /didn’t answer in time/);
  assert.equal(liveErrorText(new HubError('Can’t reach the hub. Is this phone on the home network?', 0)), 'Can’t reach the hub. Is this phone on the home network?');
  assert.equal(liveErrorText(new HubError('unknown device', 404, false, 'unknown device')), 'The hub doesn’t know this camera anymore.');
});

test('which cameras get Watch live, and why the others don’t', () => {
  assert.deepEqual(liveSupport({ adapter: 'nest', live: true, online: true }), { can: true });
  assert.deepEqual(liveSupport({ adapter: 'nest' }), { can: true }, 'an older hub doesn’t say: Nest can');
  const rtsp = liveSupport({ adapter: 'nest', live: false });
  assert.ok(!rtsp.can && /RTSP/.test(rtsp.why));
  const tapo = liveSupport({ adapter: 'tapo', integration: 'Tapo', live: false });
  assert.ok(!tapo.can && /from Tapo yet/.test(tapo.why));
  const older = liveSupport({ adapter: 'tapo', integration: 'Tapo' });
  assert.ok(!older.can, 'an older hub, not Nest: no');
  const demo = liveSupport({ adapter: 'virtual', integration: 'Google Nest', live: false });
  assert.ok(!demo.can && /demo/.test(demo.why));
  const off = liveSupport({ adapter: 'nest', live: true, online: false });
  assert.ok(!off.can && off.offline);
});

test('elapsed time', () => {
  assert.equal(elapsedText(0), '0:00');
  assert.equal(elapsedText(42_400), '0:42');
  assert.equal(elapsedText(12 * 60_000 + 5_000), '12:05');
  assert.equal(elapsedText(3_723_000), '1:02:03');
  assert.equal(elapsedText(-5), '0:00');
});
