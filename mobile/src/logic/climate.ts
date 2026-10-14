// The air conditioner's dial: its range and the arc it's drawn with, and °C or °F for what's shown. Plain TypeScript, tested under Node.

/** The targets an air conditioner takes, in °C. */
export const TARGET_MIN = 16;
export const TARGET_MAX = 32;

export const clampTarget = (n: number) => Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(n)));

// Devices and the hub keep °C. Where the home reads °F (home.fahrenheit) only what's shown and typed is converted: the
// app sets the unit when a snapshot arrives (state/hub.tsx), and everything that writes a temperature goes through here.
let inF = false;
export const setFahrenheit = (on: boolean) => { inF = on; };
export const isFahrenheit = () => inF;
export const unitLabel = () => inF ? '°F' : '°C';
/** °C as shown: whole °F where the home uses it, else as it is. */
export const toDisplay = (c: number) => inF ? Math.round(c * 9 / 5 + 32) : c;
/** What was read or typed back to °C, to the half degree the devices take. */
export const fromDisplay = (v: number) => inF ? Math.round((v - 32) * 5 / 9 * 2) / 2 : v;
/** A temperature for display: "23.5°", or "74°" in a Fahrenheit home. */
export const deg = (c: number) => `${toDisplay(c)}°`;
/** A target one step up or down in the unit shown (a whole °C, or a whole °F), kept in the dial's range, in °C. */
export function stepTarget(c: number, dir: 1 | -1): number {
  if (!inF) return clampTarget(c + dir);
  const n = Math.round(fromDisplay(toDisplay(c) + dir) * 2) / 2;
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, n));
}

/**
 * An SVG path for a share (0–1) of a 270° arc that opens at the bottom: it starts at the lower left
 * (135°, clockwise from 3 o'clock) and runs over the top to the lower right.
 */
export function arcPath(cx: number, cy: number, r: number, share: number): string {
  const f = Math.max(0, Math.min(1, share));
  const a0 = (135 * Math.PI) / 180, a1 = ((135 + 270 * f) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = 270 * f > 180 ? 1 : 0;
  const n = (v: number) => Math.round(v * 100) / 100;
  return `M ${n(x0)} ${n(y0)} A ${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}`;
}
