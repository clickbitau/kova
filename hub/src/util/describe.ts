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
};

const FIELD_CAP: Record<string, Capability> = {
  on: 'onoff', bri: 'brightness', k: 'colorTemp', color: 'color', mode: 'fanMode', media: 'media', vol: 'volume', power: 'power',
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
  if (d.type === 'fan') return `${d.name} on ${t.mode ?? (t.on === false ? 'off' : 'Auto')}`;
  if (isPlayer(d)) return t.on === false || t.media === null ? `${d.name} stops` : `${d.name} · ${t.media ?? 'on'}${t.vol != null ? ` ${t.vol}%` : ''}`;
  if (t.on === false) return `${d.name} off`;
  if (t.bri != null) return `${d.name} ${t.bri}%${t.k ? ` · ${t.k}K` : t.color ? ' · colour' : ''}`;
  return `${d.name} on`;
}

/** Activity-feed sentence for a single device change: "Lamp dimmed to 78%". */
export function changeSentence(d: Device, prev: Command, next: Command): string {
  if (d.type === 'fan' && next.mode) return `${d.name} set to ${next.mode}`;
  if (isPlayer(d)) {
    if (next.on === false || next.media === null) return `${d.name} stopped`;
    if (next.media) return `${d.name} playing ${next.media}`;
    if (next.vol != null) return `${d.name} volume ${next.vol}%`;
  }
  if (next.on === true && !prev.on) return next.bri != null ? `${d.name} on at ${next.bri}%` : `${d.name} on`;
  if (next.on === false) return `${d.name} off`;
  if (next.bri != null) return `${d.name} ${prev.bri != null && next.bri < prev.bri ? 'dimmed' : 'brightened'} to ${next.bri}%`;
  if (next.k != null) return `${d.name} set to ${next.k}K`;
  if (next.color) return `${d.name} colour changed`;
  return `${d.name} changed`;
}
