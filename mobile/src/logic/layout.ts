// How the app lays out on a phone and on a tablet. Pure (no React), so it's tested; ui/layout.ts gives it to screens.

/** From this width (points) the app is laid out for a tablet: a side rail instead of the tab bar, more columns. */
export const RAIL_AT = 768;
/** The side rail's width. */
export const RAIL_W = 96;
/** The widest a page's content gets: a tab's page (tiles, cards), and a page opened from one (settings, editors). */
export const PAGE_MAX = 1120;
export const READ_MAX = 720;
/** A bottom sheet's width on a tablet: it rises in the middle, not across the whole screen. */
export const SHEET_MAX = 600;

const GUTTER = 18;

export interface Layout {
  /** A tablet's layout: the side rail. */
  rail: boolean;
  /** The width the page's content has, inside its gutters. */
  content: number;
}

/** The layout for a window `width` wide: `read` for a page opened from a tab (narrower, for reading). */
export function layoutFor(width: number, read = false): Layout {
  const rail = width >= RAIL_AT;
  const room = width - (rail ? RAIL_W : 0);
  return { rail, content: Math.max(0, Math.min(room, read ? READ_MAX : PAGE_MAX) - GUTTER * 2) };
}

/**
 * How many to a row, for things at least `min` wide (scaled by the text size) with `gap` between: never fewer than
 * `least` (two device tiles side by side on any phone, as before), never more than `most`.
 */
export function columnsFor(content: number, min: number, fontScale = 1, o: { gap?: number; least?: number; most?: number } = {}): number {
  const gap = o.gap ?? 10;
  const fit = Math.floor((content + gap) / (min * Math.max(1, Math.min(fontScale, 2)) + gap));
  return Math.max(o.least ?? 1, Math.min(o.most ?? 4, fit));
}
