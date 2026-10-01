// The air conditioner's dial: its range and the arc it's drawn with. Plain TypeScript, tested under Node.

/** The targets an air conditioner takes, in °C. */
export const TARGET_MIN = 16;
export const TARGET_MAX = 32;

export const clampTarget = (n: number) => Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(n)));

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
