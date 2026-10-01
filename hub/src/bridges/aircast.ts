import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// AirPlay → Google Cast. Kova runs AirConnect's `aircast` (MIT, by philippe44)
// so every Cast speaker, display and Cast group shows up as an AirPlay speaker
// on iPhones, iPads and Macs. Picking a Cast group in AirPlay keeps its
// speakers in perfect sync, because Cast does the syncing.

export interface AirCastOptions {
  /** Path to the aircast binary for this OS/CPU (e.g. aircast-linux-x86_64). */
  binary: string;
  /** Where Kova writes aircast's config and log. */
  workDir: string;
  /** Network interface or IP to advertise on (needed with several networks). */
  bind?: string;
  /** Audio format sent to the speakers: flac (default, best quality), mp3, aac or wav. */
  codec?: string;
  /** Buffering in ms, "<rtp>:<http>". Raise it if audio stutters. */
  latency?: string;
  /** Cast device names that should not appear in AirPlay (those with AirPlay of their own). */
  exclude?: string[];
  /**
   * Cast ids for those names. aircast knows a device by its id (udn), not its name, so a name alone
   * doesn't keep it out; Kova's Cast adapter knows both.
   */
  castIds?: (names: string[]) => Record<string, string>;
  /** Restart delay after a crash, in ms. */
  restartMs?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** aircast's config file. Kept small: common settings, plus disabled devices (by id, with the name aircast would give them). */
export function aircastConfig(o: AirCastOptions, ids: Record<string, string> = o.castIds?.(o.exclude ?? []) ?? {}): string {
  const common = [
    '<enabled>1</enabled>',
    `<codec>${esc(o.codec ?? 'flac')}</codec>`,
    ...(o.latency ? [`<latency>${esc(o.latency)}</latency>`] : []),
  ];
  const devices = (o.exclude ?? []).map(n => `  <device>${ids[n] ? `<udn>${esc(ids[n])}</udn>` : ''}<name>${esc(n.replace(/\+$/, ''))}+</name><enabled>0</enabled></device>`);
  return `<?xml version="1.0"?>\n<aircast>\n  <common>${common.join('')}</common>\n${devices.join('\n')}${devices.length ? '\n' : ''}</aircast>\n`;
}

export class AirCastBridge extends EventEmitter<{ status: [] }> {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private lastLines: string[] = [];
  restarts = 0;
  running = false;
  lastError: string | null = null;

  constructor(private o: AirCastOptions) { super(); }

  args(): string[] {
    const cfg = join(this.o.workDir, 'aircast.xml');
    return ['-Z', '-x', cfg, ...(this.o.bind ? ['-b', this.o.bind] : [])];
  }

  start(): void {
    this.stopping = false;
    mkdirSync(this.o.workDir, { recursive: true });
    writeFileSync(join(this.o.workDir, 'aircast.xml'), aircastConfig(this.o));
    this.launch();
  }

  private launch(): void {
    let p: ChildProcess;
    try {
      p = spawn(this.o.binary, this.args(), { cwd: this.o.workDir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.fail(String(err));
      return;
    }
    this.proc = p;
    const onOut = (d: Buffer) => {
      this.lastLines.push(...d.toString().split('\n').filter(Boolean));
      this.lastLines = this.lastLines.slice(-50);
    };
    p.stdout?.on('data', onOut);
    p.stderr?.on('data', onOut);
    p.once('spawn', () => { this.running = true; this.lastError = null; this.emit('status'); });
    p.once('error', err => this.fail(err.message));
    p.once('exit', code => {
      this.running = false;
      this.proc = null;
      if (this.stopping) { this.emit('status'); return; }
      this.fail(`aircast exited (${code ?? 'signal'})${this.lastLines.length ? `: ${this.lastLines.at(-1)}` : ''}`);
    });
  }

  private fail(msg: string): void {
    this.running = false;
    this.lastError = msg;
    this.emit('status');
    if (this.stopping || this.timer) return;
    // Back off: 2 s, 4 s … up to a minute.
    const delay = Math.min(60_000, (this.o.restartMs ?? 2000) * 2 ** Math.min(this.restarts, 5));
    this.timer = setTimeout(() => { this.timer = null; this.restarts++; this.launch(); }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    if (!p) return;
    await new Promise<void>(resolve => {
      const kill = setTimeout(() => p.kill('SIGKILL'), 3000);
      p.once('exit', () => { clearTimeout(kill); resolve(); });
      p.kill('SIGTERM');
    });
  }

  status(): { running: boolean; restarts: number; error: string | null; log: string[] } {
    return { running: this.running, restarts: this.restarts, error: this.lastError, log: this.lastLines.slice(-10) };
  }
}
