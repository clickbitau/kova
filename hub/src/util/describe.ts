import type { Command, Device, DeviceType, Capability } from '../model/types.ts';

export const CAPS: Record<DeviceType, Capability[]> = {
  light: ['onoff'],
  dimmer: ['onoff', 'brightness'],
  fan: ['onoff', 'fanMode'],
  media: ['onoff', 'media', 'volume'],
  tv: ['onoff', 'media', 'volume'],
  plug: ['onoff', 'power'],
  camera: ['events'],
  sensor: ['events'],
  vacuum: ['onoff', 'vacuum', 'battery'],
  internet: ['onoff'],
  climate: ['onoff', 'climate'],
};

export const FIELD_CAP: Record<string, Capability> = {
  on: 'onoff', bri: 'brightness', k: 'colorTemp', color: 'color', mode: 'fanMode', media: 'media', vol: 'volume', power: 'power',
  activity: 'vacuum', battery: 'battery', paused: 'pause', input: 'input', skip: 'queue', shuffle: 'queue',
  muted: 'mute', sound: 'sound', night: 'sound', volStep: 'volume',
  hvac: 'climate', target: 'climate', fanSpeed: 'climate', zoneSet: 'zones', zones: 'zones',
  fanLevel: 'purifier', display: 'purifier', childLock: 'purifier',
};

/** Drop fields the device can't do, so a mode can target mixed brands safely. */
export function fitCommand(d: Device, cmd: Command): Command {
  const out: Command = {};
  for (const [k, v] of Object.entries(cmd)) {
    const cap = FIELD_CAP[k];
    if (!cap || d.capabilities.includes(cap) || (k === 'color' && d.capabilities.includes('colorTemp'))) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export const isLight = (d: Pick<Device, 'type'>) => d.type === 'light' || d.type === 'dimmer';
export const isPlayer = (d: Pick<Device, 'type'>) => d.type === 'media' || d.type === 'tv';

/** Chip text for a target: "Lamp 78% · 3000K", "Speaker · Tarateel 15%", "Ceiling off". */
export function targetLabel(d: Device, t: Command): string {
  if (d.type === 'vacuum') return t.on === false || t.activity === 'returning' || t.activity === 'docked' ? `${d.name} docks` : `${d.name} cleans`;
  if (d.type === 'fan' && t.fanLevel != null && !t.mode) return `${d.name} on speed ${t.fanLevel}`;
  if (d.type === 'fan') return `${d.name} on ${t.mode ?? (t.on === false ? 'off' : 'Auto')}`;
  if (d.type === 'internet') return `${d.name} internet ${t.on === false ? 'paused' : 'on'}`;
  if (d.type === 'climate' && t.zoneSet && t.on === undefined && !t.hvac && t.target == null) return `${d.name} ${zoneWords(t.zoneSet)}`;
  if (d.type === 'climate') return t.on === false ? `${d.name} off` : [`${d.name}`, t.hvac ?? 'on', t.target != null ? `${t.target}°` : ''].filter(Boolean).join(' ');
  if (isPlayer(d) && t.skip && t.media === undefined) return `${d.name} ${t.skip > 0 ? 'next song' : 'previous song'}`;
  if (isPlayer(d) && t.volStep && t.media === undefined && t.on === undefined) return `${d.name} volume ${t.volStep > 0 ? 'up' : 'down'}`;
  if (isPlayer(d) && t.media === undefined && t.on === undefined && (t.input || t.muted !== undefined || t.sound || t.night !== undefined)) {
    return `${d.name} ${[t.input && `to ${t.input.toUpperCase()}`, t.muted !== undefined && (t.muted ? 'muted' : 'unmuted'), t.sound && `${t.sound} sound`, t.night !== undefined && `night mode ${t.night ? 'on' : 'off'}`].filter(Boolean).join(', ')}`;
  }
  if (isPlayer(d) && t.paused !== undefined && t.on === undefined && t.media === undefined) return `${d.name} ${t.paused ? 'pauses' : 'carries on'}`;
  if (isPlayer(d)) return t.on === false || t.media === null ? `${d.name} stops` : `${d.name} · ${t.media ?? 'on'}${t.shuffle ? ' (shuffled)' : ''}${t.vol != null ? ` ${t.vol}%` : ''}`;
  if (t.on === false) return `${d.name} off`;
  if (t.bri != null) return `${d.name} ${t.bri}%${t.k ? ` · ${t.k}K` : t.color ? ' · colour' : ''}`;
  return `${d.name} on`;
}

/** Activity-feed sentence for a single device change: "Lamp dimmed to 78%". */
export function changeSentence(d: Device, prev: Command, next: Command): string {
  if (d.type === 'vacuum') {
    const a = next.activity ?? (next.on === true ? 'cleaning' : next.on === false ? 'returning' : undefined);
    const says: Record<string, string> = { cleaning: 'started cleaning', returning: 'heading back to its dock', docked: 'docked', paused: 'paused', idle: 'stopped', error: 'needs attention' };
    if (a) return `${d.name} ${says[a]}`;
  }
  if (d.type === 'fan' && next.mode) return `${d.name} set to ${next.mode}`;
  if (d.type === 'fan' && next.fanLevel != null) return `${d.name} fan speed ${next.fanLevel}`;
  if (d.type === 'fan' && next.display !== undefined) return `${d.name} display ${next.display ? 'on' : 'off'}`;
  if (d.type === 'fan' && next.childLock !== undefined) return `${d.name} child lock ${next.childLock ? 'on' : 'off'}`;
  if (d.type === 'climate') {
    const HV: Record<string, string> = { cool: 'cooling', heat: 'heating', dry: 'drying', fan: 'fan only', auto: 'auto' };
    if (next.on === false) return `${d.name} off`;
    if (next.hvac) return `${d.name} ${HV[next.hvac] ?? next.hvac}${next.target != null ? ` to ${next.target}°` : ''}`;
    if (next.target != null) return `${d.name} set to ${next.target}°`;
    if (next.fanSpeed) return `${d.name} fan ${next.fanSpeed}`;
    if (next.zoneSet) return `${d.name} ${zoneWords(next.zoneSet)}`;
    if (Array.isArray(next.zones)) {
      const was = new Map((prev.zones ?? []).map(z => [z.n, z]));
      const set = Object.fromEntries(next.zones.filter(z => { const p = was.get(z.n); return !p || p.on !== z.on || p.open !== z.open; }).map(z => [String(z.n), { on: z.on, open: z.open ?? undefined }]));
      if (Object.keys(set).length) return `${d.name} ${zoneWords(set)}`;
    }
    if (next.on === true) return `${d.name} on`;
  }
  if (d.type === 'internet' && next.on !== undefined) return `${d.name}: internet ${next.on ? 'back on' : 'paused'}`;
  if (isPlayer(d)) {
    if (next.on === false || next.media === null) return `${d.name} stopped`;
    if (next.media) return `${d.name} playing ${next.media}`;
    if (next.paused === true) return `${d.name} paused`;
    if (next.paused === false) return `${d.name} carried on playing`;
    if (next.vol != null) return `${d.name} volume ${next.vol}%`;
  }
  if (next.on === true && !prev.on) return next.bri != null ? `${d.name} on at ${next.bri}%` : `${d.name} on`;
  if (next.on === false) return `${d.name} off`;
  if (next.bri != null) return `${d.name} ${prev.bri != null && next.bri < prev.bri ? 'dimmed' : 'brightened'} to ${next.bri}%`;
  if (next.k != null) return `${d.name} set to ${next.k}K`;
  if (next.color) return `${d.name} colour changed`;
  return `${d.name} changed`;
}

/** "zone 2 on at 50%, zone 3 off" */
export function zoneWords(set: Record<string, { on?: boolean; open?: number }>): string {
  return Object.entries(set).map(([n, z]) => `zone ${n}${z.on === false ? ' off' : z.on ? ' on' : ''}${z.open != null && z.on !== false ? ` at ${z.open}%` : ''}`).join(', ');
}
