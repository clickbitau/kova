import type { Device, DeviceState, PowerProblem, PowerSupply } from '../model/types.ts';

// Words for a server's power, read through its BMC (the router, from Warden): shared by insights, the notifier and
// Ask Kova so they all say it the same way.

const PROBLEM_WORDS: Record<PowerProblem, string> = {
  'no input power': 'has no input power',
  failed: 'has failed',
  'predicted to fail': 'is predicted to fail',
  'input power out of range': 'has input power out of range',
  'not installed': 'isn’t installed',
};

/** "has no input power", or "isn’t OK" for a problem Kova has no words for. */
export const problemWords = (p?: string | null) => (p && PROBLEM_WORDS[p as PowerProblem]) || 'isn’t OK';

/** "Router power supply 1" from the device and the supply's own name ("Power supply 1", "PSU2"). */
export function supplyLabel(device: Pick<Device, 'name'>, name: string): string {
  return /power supply|psu/i.test(name) ? `${device.name} ${name[0].toLowerCase()}${name.slice(1)}` : `${device.name} power supply ${name}`;
}

/** The supplies that aren't feeding it as they should. */
export const badSupplies = (s: DeviceState): PowerSupply[] => (s.supplies ?? []).filter(x => !x.ok);

/** Whether anything about its power needs attention: a supply not OK, or redundancy that isn't full. */
export const powerTrouble = (s: DeviceState) => badSupplies(s).length > 0 || (s.redundancy != null && s.redundancy !== 'full');

/** "Router power supply 1 has no input power — redundancy lost", or null when its power is fine. */
export function powerTroubleText(d: Pick<Device, 'name' | 'state'>): string | null {
  const s = d.state;
  if (!powerTrouble(s)) return null;
  const bad = badSupplies(s).map((x, i) => i === 0 ? `${supplyLabel(d, x.name)} ${problemWords(x.problem)}` : `${x.name[0].toLowerCase()}${x.name.slice(1)} ${problemWords(x.problem)}`);
  const red = s.redundancy && s.redundancy !== 'full' ? `redundancy ${s.redundancy}` : '';
  if (!bad.length) return `${d.name} power ${red}`;
  return [bad.join(', '), red].filter(Boolean).join(' — ');
}

/** A short answer to "is the router OK?" and "how much power is it using?": power, supplies, redundancy, temperatures, fans. */
export function hardwareSummary(d: Pick<Device, 'name' | 'state'>): string {
  const s = d.state;
  const parts: string[] = [];
  const trouble = powerTroubleText(d);
  if (d.state.online === false) parts.push(`Kova can’t read the ${d.name.toLowerCase()}’s hardware right now.`);
  else if (trouble) parts.push(`Not quite: ${trouble}.`);
  else parts.push(`The ${d.name.toLowerCase()} is OK.`);
  if (s.power != null) parts.push(`It’s drawing ${Math.round(s.power)} W.`);
  const sup = s.supplies ?? [];
  if (sup.length) parts.push(`Power supplies: ${sup.map(x => `${x.name} ${x.ok ? 'OK' : problemWords(x.problem).replace(/^has |^is /, '')}`).join(', ')}${s.redundancy ? `; redundancy ${s.redundancy}` : ''}.`);
  const temps = (s.sensors ?? []).filter(x => x.kind === 'temp');
  if (temps.length) parts.push(`Temperatures: ${temps.slice(0, 4).map(x => `${x.name} ${x.value}°C`).join(', ')}.`);
  const fans = (s.sensors ?? []).filter(x => x.kind === 'fan');
  if (fans.length || s.fanMode) parts.push(`Fans${s.fanMode ? ` (${s.fanMode}${s.fanPercent != null ? `, ${s.fanPercent}%` : ''})` : ''}${fans.length ? `: ${fans.slice(0, 4).map(x => `${x.name} ${x.value} RPM`).join(', ')}` : ''}.`);
  return parts.join(' ');
}

/** Devices that report server hardware (supplies or BMC sensors). */
export const hasHardware = (d: Pick<Device, 'state'>) => Array.isArray(d.state.supplies) || Array.isArray(d.state.sensors) || d.state.redundancy != null;
