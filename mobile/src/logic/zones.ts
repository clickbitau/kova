// Ducted air conditioner zones in the device panel: which to show and what to call them.

export interface ZoneView { n: number; name: string; on: boolean; open: number }

/** The zones in use (on, open, or named) unless `all`; each with its name, or "Zone n". */
export function visibleZones(zones: { n: number; on: boolean; open: number | null }[] | null | undefined, names: Record<string, string> = {}, all = false): ZoneView[] {
  return (zones ?? [])
    .filter(z => all || z.on || (z.open ?? 0) > 0 || !!names[String(z.n)])
    .map(z => ({ n: z.n, name: names[String(z.n)] || `Zone ${z.n}`, on: z.on, open: z.open ?? 0 }));
}

/** Openings move in steps of 5%, as the units do. */
export const snapOpen = (v: number) => Math.max(0, Math.min(100, Math.round(v / 5) * 5));
