// Live camera video in the app, in place of the camera's picture. The video plays in a small page of its own (in the
// WebView the store build already has, or an iframe on the web), which only does WebRTC: it makes a receive-only
// offer (audio, then video, then the data channel Google's Nest cameras need) and plays what comes back. The page
// never talks to the hub: it hands its offer to the app, the app asks the hub with its own client (key, addresses),
// and hands the answer back. So no key sits in the page and nothing needs CORS.
//
// Messages, as JSON strings:
//   page → app: { kova: 'offer', sdp } | { kova: 'playing' } | { kova: 'failed', reason, message? }
//   app → page: { kova: 'answer', sdp } | { kova: 'mute', muted } | { kova: 'stop' }
//
// LiveSession is the app's side: connecting → live (or error), the stream kept going before it expires, and stopped
// at the hub when it ends (Stop, leaving the screen, the app going to the background).

export type FromPlayer =
  | { kova: 'offer'; sdp: string }
  | { kova: 'playing' }
  | { kova: 'failed'; reason: PlayerFailure; message?: string };
export type ToPlayer = { kova: 'answer'; sdp: string } | { kova: 'mute'; muted: boolean } | { kova: 'stop' };
/** no-webrtc: this phone's web view can't do it; offer/answer: WebRTC refused the session; dropped: it connected, then failed. */
export type PlayerFailure = 'no-webrtc' | 'offer' | 'answer' | 'dropped';

export type LivePhase = 'idle' | 'connecting' | 'live' | 'error';
export interface LiveView {
  phase: LivePhase;
  /** When the video started playing (live). */
  since?: number;
  /** Why it can't stream (error). */
  reason?: string;
  /** Counts each start: the player page is made again for each (its key). */
  gen: number;
}

/** What the screen's title says over the reason when it can't stream. */
export const CANT_STREAM = 'This camera can’t stream right now';

/** How long to wait for video before giving up. */
export const CONNECT_MS = 30_000;
/** Extend this long before the stream expires (Nest streams last about 5 minutes). */
export const EXTEND_AHEAD_MS = 60_000;
/** When the hub gives no expiry: extend every 4 minutes, as the web app does. */
export const EXTEND_DEFAULT_MS = 4 * 60_000;
/** A failed extend is tried again this soon, while the stream still has time. */
export const EXTEND_RETRY_MS = 15_000;
const EXTEND_MIN_MS = 10_000;
/** The offer can take a while: Google's cloud starts the camera's stream first. */
export const OFFER_TIMEOUT_MS = 25_000;

const MAX_SDP = 64_000;

/** A message from the player page, checked (anything else is ignored). */
export function readPlayerMessage(data: unknown): FromPlayer | null {
  let m: unknown = data;
  if (typeof data === 'string') { try { m = JSON.parse(data); } catch { return null; } }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.kova === 'offer' && typeof o.sdp === 'string' && o.sdp.startsWith('v=') && o.sdp.length <= MAX_SDP) return { kova: 'offer', sdp: o.sdp };
  if (o.kova === 'playing') return { kova: 'playing' };
  if (o.kova === 'failed' && typeof o.reason === 'string' && ['no-webrtc', 'offer', 'answer', 'dropped'].includes(o.reason))
    return { kova: 'failed', reason: o.reason as PlayerFailure, ...(typeof o.message === 'string' && o.message ? { message: o.message.slice(0, 200) } : {}) };
  return null;
}

/** JavaScript for the WebView to run: hands the page a message. */
export const injectFor = (m: ToPlayer) => `window.kovaLive && window.kovaLive(${JSON.stringify(m)}); true;`;

/** The words for a page that couldn't play. */
export function playerFailureText(reason: PlayerFailure): string {
  if (reason === 'no-webrtc') return 'This phone can’t play live video in Kova. Update the phone’s system web view, then try again.';
  if (reason === 'dropped') return 'The live stream dropped. The camera or the internet may have hiccupped.';
  return 'The camera’s video couldn’t be set up.';
}

/**
 * What a hub error means for live video, in words for the owner. The hub's own reason comes through (it names what
 * Google said); a few common ones get plainer words.
 */
export function liveErrorText(e: unknown): string {
  const x = (e ?? {}) as { status?: number; detail?: string; message?: string; timedOut?: boolean };
  const msg = x.detail ?? x.message ?? '';
  if (x.status === 0) return x.timedOut ? 'The camera didn’t answer in time. It may be asleep or busy.' : (x.message || 'Can’t reach the hub.');
  if (/Google API 429/.test(msg)) return 'Google is limiting live streams right now. Try again in a minute.';
  if (/Google API 40[13]/.test(msg)) return 'Google didn’t allow live video for this camera. Link Google Nest again in Integrations.';
  if (/Google API 404/.test(msg)) return 'Google doesn’t know this camera anymore. Link Google Nest again in Integrations.';
  if (/Google API 5\d\d/.test(msg)) return 'Google’s camera service had a problem. Try again in a minute.';
  if (/^Google API \d+: ?/.test(msg)) return `Google said: ${msg.replace(/^Google API \d+: ?/, '')}`;
  if (x.status === 404) return 'The hub doesn’t know this camera anymore.';
  return msg || 'Something went wrong starting the video.';
}

/** Whether a camera can play live video in Kova, and if not, why (in a few words). */
export type LiveSupport = { can: true } | { can: false; offline?: boolean; why: string };

/**
 * `live` is the hub's word (hub 0.7.58 and later): true when the camera's integration can stream it. Older hubs
 * don't say: then Google Nest cameras can (the hub refuses the ones that can't, with its reason).
 */
export function liveSupport(d: { type?: string; adapter?: string; integration?: string; online?: boolean; live?: boolean | null }): LiveSupport {
  if (d.online === false) return { can: false, offline: true, why: 'Live video comes back when the camera does.' };
  const nest = d.adapter === 'nest';
  if (d.live === true || (d.live == null && nest)) return { can: true };
  if (d.adapter === 'virtual') return { can: false, why: 'A demo camera: it has no live video.' };
  if (nest) return { can: false, why: 'Google streams this camera only over RTSP, which Kova can’t show yet.' };
  return { can: false, why: `Kova can’t show live video from ${d.integration?.trim() || 'this camera'} yet.` };
}

/** How long it's been live: 0:42, 12:05, 1:02:03. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** When to extend a stream that expires at `expiresAt` (ISO), from `now`: a minute ahead, never sooner than 10 s. */
export function extendDelay(expiresAt: string | undefined, now: number): number {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(t)) return EXTEND_DEFAULT_MS;
  return Math.max(EXTEND_MIN_MS, t - now - EXTEND_AHEAD_MS);
}

type Api = <T>(method: 'POST', path: string, body: unknown, timeoutMs?: number) => Promise<T>;
type Timer = ReturnType<typeof setTimeout>;
export interface LiveDeps {
  api: Api;
  /** Hand the player page a message. */
  toPage: (m: ToPlayer) => void;
  onChange: (v: LiveView) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

interface Offer { answerSdp: string; mediaSessionId: string; expiresAt: string }

/** One camera's live video, from Watch live until it stops. */
export class LiveSession {
  private v: LiveView = { phase: 'idle', gen: 0 };
  private sid: string | null = null;
  private expires: number | null = null;
  private watchdog: Timer | null = null;
  private extender: Timer | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  private readonly cam: string;
  private readonly deps: LiveDeps;

  constructor(cam: string, deps: LiveDeps) {
    this.cam = cam;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? (t => clearTimeout(t));
  }

  get view(): LiveView { return this.v; }
  /** The hub's id for the stream now (null before the answer and after it stops). */
  get mediaSessionId(): string | null { return this.sid; }
  private get base() { return `/api/devices/${encodeURIComponent(this.cam)}/webrtc`; }

  private set(v: Omit<LiveView, 'gen'>, gen = this.v.gen) { this.v = { ...v, gen }; this.deps.onChange(this.v); }

  /** Watch live (or Try again): a new player page starts and sends its offer. */
  start(): void {
    this.end();
    this.set({ phase: 'connecting' }, this.v.gen + 1);
    const gen = this.v.gen;
    this.watchdog = this.setTimer(() => { if (this.v.gen === gen && this.v.phase === 'connecting') this.fail('The video didn’t arrive. The camera may be asleep or busy.'); }, CONNECT_MS);
  }

  /** Stop (the button, leaving the screen, the app going to the background). Tells the hub to end the stream. */
  stop(): void {
    if (this.v.phase === 'idle') return;
    this.end();
    this.set({ phase: 'idle' });
  }

  /** A message from the player page. */
  fromPage(raw: unknown): void {
    const m = readPlayerMessage(raw);
    if (!m || this.v.phase === 'idle' || this.v.phase === 'error') return;
    if (m.kova === 'offer') void this.negotiate(m.sdp, this.v.gen);
    else if (m.kova === 'playing') {
      if (this.v.phase === 'connecting') { this.clearWatchdog(); this.set({ phase: 'live', since: this.now() }); }
    } else this.fail(playerFailureText(m.reason));
  }

  private async negotiate(offerSdp: string, gen: number): Promise<void> {
    if (this.sid) return; // one offer per page
    let r: Offer;
    try {
      r = await this.deps.api<Offer>('POST', this.base, { offerSdp }, OFFER_TIMEOUT_MS);
    } catch (e) {
      if (this.v.gen === gen && this.v.phase === 'connecting') this.fail(liveErrorText(e));
      return;
    }
    // Stopped (or started again) while the hub was answering: end the stream that just began.
    if (this.v.gen !== gen || this.v.phase === 'idle' || this.v.phase === 'error') {
      if (r?.mediaSessionId) void this.deps.api('POST', `${this.base}/stop`, { mediaSessionId: r.mediaSessionId }).catch(() => {});
      return;
    }
    if (!r?.answerSdp) { this.fail('The camera sent no video description.'); return; }
    this.sid = r.mediaSessionId || null;
    this.expires = Number.isFinite(Date.parse(r.expiresAt)) ? Date.parse(r.expiresAt) : null;
    this.deps.toPage({ kova: 'answer', sdp: r.answerSdp });
    this.scheduleExtend(r.expiresAt, gen);
  }

  private scheduleExtend(expiresAt: string | undefined, gen: number, ms = extendDelay(expiresAt, this.now())) {
    if (this.extender) this.clearTimer(this.extender);
    if (!this.sid) return;
    this.extender = this.setTimer(() => void this.extend(gen), ms);
  }

  private async extend(gen: number): Promise<void> {
    this.extender = null;
    const sid = this.sid;
    if (!sid || this.v.gen !== gen) return;
    try {
      const r = await this.deps.api<{ mediaSessionId?: string; expiresAt?: string }>('POST', `${this.base}/extend`, { mediaSessionId: sid });
      if (this.v.gen !== gen || this.sid !== sid) return;
      this.sid = r?.mediaSessionId || sid;
      if (r?.expiresAt && Number.isFinite(Date.parse(r.expiresAt))) this.expires = Date.parse(r.expiresAt);
      this.scheduleExtend(r?.expiresAt, gen);
    } catch (e) {
      if (this.v.gen !== gen || this.sid !== sid) return;
      // Still time before it expires: try again shortly. Otherwise it's over.
      const left = this.expires == null ? EXTEND_RETRY_MS * 2 : this.expires - this.now();
      if (left > EXTEND_RETRY_MS + 5_000) this.scheduleExtend(undefined, gen, EXTEND_RETRY_MS);
      else this.fail(`The stream ended: ${liveErrorText(e)}`);
    }
  }

  private fail(reason: string) {
    this.end();
    this.set({ phase: 'error', reason });
  }

  private clearWatchdog() { if (this.watchdog) { this.clearTimer(this.watchdog); this.watchdog = null; } }

  /** Ends whatever is running: timers, the page's connection, the hub's stream. */
  private end() {
    this.clearWatchdog();
    if (this.extender) { this.clearTimer(this.extender); this.extender = null; }
    if (this.v.phase === 'connecting' || this.v.phase === 'live') this.deps.toPage({ kova: 'stop' });
    const sid = this.sid;
    this.sid = null;
    this.expires = null;
    if (sid) void this.deps.api('POST', `${this.base}/stop`, { mediaSessionId: sid }).catch(() => {});
  }
}

/** The player page: a full-bleed video and nothing else, apart from a full-screen button (it needs the tap to happen in the page). */
export function livePlayerHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
video{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;background:transparent}
video::-webkit-media-controls{display:none!important}
video:fullscreen{object-fit:contain;background:#000}video:-webkit-full-screen{object-fit:contain;background:#000}
#full{position:absolute;right:10px;bottom:10px;width:40px;height:40px;border-radius:20px;border:0;padding:0;margin:0;background:rgba(14,15,16,.78);display:none;align-items:center;justify-content:center;cursor:pointer}
#full.on{display:flex}#full svg{width:22px;height:22px}</style></head><body>
<video id="v" playsinline webkit-playsinline muted autoplay disablepictureinpicture></video>
<button id="full" type="button" aria-label="Full screen"><svg viewBox="0 0 24 24" fill="none" stroke="#f1efea" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
<script>
(function(){
function post(m){var s=JSON.stringify(m);try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else if(window.parent!==window)window.parent.postMessage(s,'*')}catch(e){}}
var v=document.getElementById('v'),full=document.getElementById('full'),pc=null,done=false,drop=null;
function fail(r,msg){if(done)return;done=true;try{pc&&pc.close()}catch(e){}post({kova:'failed',reason:r,message:msg||''})}
function start(){
  if(typeof RTCPeerConnection==='undefined'||typeof MediaStream==='undefined'){fail('no-webrtc');return}
  try{pc=new RTCPeerConnection({bundlePolicy:'max-bundle'})}catch(e){fail('no-webrtc',e&&e.message);return}
  var stream=new MediaStream();
  // Google's cameras want exactly this: audio, then video, then a data channel.
  pc.addTransceiver('audio',{direction:'recvonly'});pc.addTransceiver('video',{direction:'recvonly'});pc.createDataChannel('dataSendChannel');
  pc.ontrack=function(e){stream.addTrack(e.track);if(v.srcObject!==stream)v.srcObject=stream;var p=v.play();if(p&&p.catch)p.catch(function(){})};
  pc.onconnectionstatechange=function(){var s=pc.connectionState;
    if(s==='failed')fail('dropped');
    else if(s==='disconnected'){clearTimeout(drop);drop=setTimeout(function(){if(pc.connectionState!=='connected')fail('dropped')},8000)}
    else if(s==='connected')clearTimeout(drop)};
  pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){post({kova:'offer',sdp:pc.localDescription.sdp})}).catch(function(e){fail('offer',e&&e.message)});
}
var told=false;v.addEventListener('playing',function(){if(!told){told=true;post({kova:'playing'})}if(canFull())full.className='on'});
function canFull(){return !!((document.fullscreenEnabled&&v.requestFullscreen)||(document.webkitFullscreenEnabled&&v.webkitRequestFullscreen)||v.webkitEnterFullscreen)}
full.addEventListener('click',function(){
  try{
    if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document);return}
    var p=null;
    if(document.fullscreenEnabled&&v.requestFullscreen)p=v.requestFullscreen();
    else if(document.webkitFullscreenEnabled&&v.webkitRequestFullscreen)p=v.webkitRequestFullscreen();
    else if(v.webkitEnterFullscreen){v.webkitEnterFullscreen();return}
    if(p&&p.then)p.then(function(){try{screen.orientation.lock('landscape').catch(function(){})}catch(e){}}).catch(function(){});
  }catch(e){}
});
window.kovaLive=function(m){if(!m)return;
  if(m.kova==='answer'&&pc&&!done)pc.setRemoteDescription({type:'answer',sdp:m.sdp}).catch(function(e){fail('answer',e&&e.message)});
  else if(m.kova==='mute'){v.muted=!!m.muted;var p=v.play();if(p&&p.catch)p.catch(function(){})}
  else if(m.kova==='stop'){done=true;clearTimeout(drop);try{pc&&pc.close()}catch(e){}v.srcObject=null}};
function onMsg(e){var m=e.data;if(typeof m==='string'){try{m=JSON.parse(m)}catch(x){return}}if(m&&m.kova)window.kovaLive(m)}
window.addEventListener('message',onMsg);document.addEventListener('message',onMsg);
start();
})();
</script></body></html>`;
}
