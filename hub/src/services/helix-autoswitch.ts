import type { Hub } from '../hub.ts';
import type { Cause, Command, Device } from '../model/types.ts';
import type { DeviceEvent, SentEvent } from '../devices/registry.ts';
import type { HelixScreen } from './helix-link.ts';

/**
 * "Auto-switch when Helix plays": when a Helix box starts or carries on playing, get its screen ready.
 *
 * - The TV: on if it's off, then to the input the box is on (`screens.<box>.input`).
 * - The soundbar: on if it's off, then to where the box's sound goes. That's the TV's eARC ("tv"), or the
 *   soundbar's own HDMI in when the box sends 7.1 PCM or DTS there directly (Helix's D101). Helix says which
 *   in each playback event (`audio.route`: "earc" or "soundbar") and again when it changes mid-play.
 *
 * Kova never moves the TV away from an input someone chose during playback (from Kova, the Helix remote or an
 * automation). It leaves that TV's input alone until playback stops. A pause, however long, changes nothing.
 * Settings: `helix.autoSwitch` (default on).
 */
export const AUTO_SWITCH: Cause = { kind: 'behaviour', id: 'helix-autoswitch', label: 'Auto-switch for Helix' };

interface Session { manualTv: boolean; route: 'earc' | 'soundbar'; running: Promise<void> | null; again: boolean }

export class HelixAutoSwitch {
  private sessions = new Map<string, Session>();
  private onEvent = (e: DeviceEvent) => this.event(e);
  private onSent = (e: SentEvent) => this.sent(e);

  constructor(private hub: Hub, private o: {
    screens: () => HelixScreen[];
    enabled: () => boolean;
    /** How long to wait for a TV that was just switched on before changing its input. */
    tvWakeMs?: number;
    tries?: number;
  }) {}

  start(): void { this.hub.reg.on('event', this.onEvent); this.hub.reg.on('sent', this.onSent); }
  stop(): void { this.hub.reg.off('event', this.onEvent); this.hub.reg.off('sent', this.onSent); }

  private screenOf(box: Device): HelixScreen | undefined { return this.o.screens().find(s => s.playerId === box.address); }

  private event({ device, type, data }: DeviceEvent): void {
    if (device.adapter !== 'helix') return;
    if (type === 'stopped') { this.sessions.delete(device.id); return; }
    if (!['video-started', 'music-started', 'resumed', 'audio-route'].includes(type)) return;
    const s = this.sessions.get(device.id) ?? { manualTv: false, route: 'earc', running: null, again: false };
    this.sessions.set(device.id, s);
    if (data.route === 'soundbar' || data.route === 'earc') s.route = data.route;
    if (!this.o.enabled()) return;
    const screen = this.screenOf(device);
    if (!screen) return;
    // One run at a time per box; a start and a resume together make one more pass, not two.
    if (s.running) { s.again = true; return; }
    s.running = (async () => {
      try {
        do { s.again = false; await this.prepare(screen, s, type === 'audio-route'); } while (s.again);
      } finally { s.running = null; }
    })();
  }

  /** Someone changed the TV's input during playback (not Kova's auto-switch): leave that TV alone until it stops. */
  private sent({ device, cmd, cause }: SentEvent): void {
    if (cmd.input === undefined || cause.id === AUTO_SWITCH.id) return;
    for (const scr of this.o.screens().filter(x => x.tvDeviceId === device.id)) {
      const box = [...this.hub.reg.devices.values()].find(d => d.adapter === 'helix' && d.address === scr.playerId);
      const s = box && this.sessions.get(box.id);
      if (s) s.manualTv = true;
    }
  }

  private async send(id: string, cmd: Command): Promise<void> {
    try { await this.hub.reg.command(id, cmd, AUTO_SWITCH, { quiet: true }); } catch { /* logged by the registry */ }
  }

  private async prepare(screen: HelixScreen, s: Session, soundOnly: boolean): Promise<void> {
    const dev = (id: string) => this.hub.reg.get(id);
    const jobs: Promise<void>[] = [];
    if (!soundOnly) jobs.push((async () => {
      const tv = dev(screen.tvDeviceId);
      if (!tv) return;
      const woke = !tv.state.on;
      if (woke) await this.send(tv.id, { on: true });
      if (!screen.helixInput || s.manualTv) return;
      // A TV that was just switched on needs a moment before it takes a source key.
      const tries = this.o.tries ?? 3;
      for (let i = 0; i < tries; i++) {
        if (woke || i > 0) await new Promise(r => setTimeout(r, this.o.tvWakeMs ?? 4000));
        if (s.manualTv) return;
        // Only the last try's failure goes to Activity.
        try { await this.hub.reg.command(tv.id, { input: screen.helixInput }, AUTO_SWITCH, { quiet: true, retrying: i < tries - 1 }); return; } catch { /* not ready yet */ }
      }
    })());
    if (screen.soundbarDeviceId) jobs.push((async () => {
      const bar = dev(screen.soundbarDeviceId!);
      if (!bar) return;
      const input = s.route === 'soundbar' ? screen.soundbarHelixInput ?? 'hdmi1' : 'tv';
      const cmd: Command = {};
      if (!bar.state.on) cmd.on = true;
      if (bar.state.input !== input) cmd.input = input;
      if (Object.keys(cmd).length) await this.send(bar.id, cmd);
    })());
    await Promise.all(jobs);
  }
}

/** `helix.autoSwitch` from settings: on unless switched off. */
export const autoSwitchOn = (v: unknown) => v !== false && v !== 'off';
