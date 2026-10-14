// Kova's design tokens (docs/design/tokens), for the phone. Colour means state:
// amber = light / on / primary, blue = media and air, green = healthy / present / live, red = alert.
const DARK = {
  page: '#0e0f10',
  nav: '#111214',
  card: '#16171a',
  inset: '#1c1d20',
  control: '#232428',
  selected: '#2a2b2f',
  switchOff: '#35363a',
  sheet: '#141517',
  coal: '#141517',
  bone: '#f1efea',
  bone2: '#d8d5cf',
  soft: '#c9c6c0',
  stone: '#a3a09a',
  stone2: '#8a8781',
  /** Decorative only (dividers, disabled glyphs): too dim for text. Use stone2 for the smallest text. */
  stone3: '#6f6d69',
  amber: '#f2b14c',
  amberHover: '#f7cb82',
  onAmber: '#1a1408',
  blue: '#7cb8f0',
  onBlue: '#0d1a26',
  green: '#7fd4a0',
  red: '#ff6b5e',
  hairline: 'rgba(255,255,255,0.05)',
  line: 'rgba(255,255,255,0.08)',
  control2: 'rgba(255,255,255,0.07)',
  scrim: 'rgba(0,0,0,0.55)',
  amberTint: 'rgba(242,177,76,0.11)',
  amberLine: 'rgba(242,177,76,0.28)',
  blueTint: 'rgba(124,184,240,0.12)',
  blueLine: 'rgba(124,184,240,0.3)',
  greenTint: 'rgba(127,212,160,0.15)',
  greenLine: 'rgba(127,212,160,0.32)',
  redTint: 'rgba(255,107,94,0.14)',
  redLine: 'rgba(255,107,94,0.35)',
  onRed: '#2a0f0c',
  redText: '#ffb4ab',
  /** Raised surfaces: a card a step above the page, and the light edge along its top. */
  raised: '#18191c',
  edge: 'rgba(255,255,255,0.06)',
  edgeTop: 'rgba(255,255,255,0.09)',
  /** The scrim behind a sheet: dark enough that the page clearly steps back. */
  scrimDeep: 'rgba(0,0,0,0.66)',
  shimmer: 'rgba(255,255,255,0.06)',
  /** The clear end of a shimmer sweep: the shimmer colour at no alpha, so the gradient doesn't pass through another hue. */
  shimmerEnd: 'rgba(255,255,255,0)',
  /** Sensor and chart accents beyond the four state colours. */
  yellow: '#dcd27e',
  violet: '#c9a0f0',
  /** Music (stations): its own accent, and text on it. */
  music: '#c79bf2',
  onMusic: '#1a1020',
  /** The page and the tab bar seen through frosted glass (the large title bar, the tab bar). */
  glass: 'rgba(14,15,16,0.94)',
  navGlass: 'rgba(17,18,20,0.97)',
  /** A dashed outline around an empty state. */
  dash: 'rgba(255,255,255,0.1)',
  /** An avatar ring on a lit (amber) tile: the tile's tint settled onto the card. */
  amberSolid: '#2a2318',
  /** Toasts: the bone toast's edge, an error toast's fill, and the Undo button on a bone toast. */
  toastEdge: 'rgba(255,255,255,0.6)',
  toastErr: '#3a1d1a',
  toastBtn: 'rgba(0,0,0,0.08)',
  /** A day bar's "skipped" swatch, and its key. */
  skipped: '#26272b',
  skippedKey: '#3a3b40',
  /** The "now" line across the day bar. */
  nowLine: '#ffffff',
};

export type Palette = { [K in keyof typeof DARK]: string };

const LIGHT: Palette = {
  page: '#f5f3ee',
  nav: '#efece6',
  card: '#ffffff',
  inset: '#f3f0ea',
  control: '#ebe7e0',
  selected: '#e3dfd6',
  switchOff: '#d6d1c7',
  sheet: '#fbfaf7',
  coal: '#fbfaf7',
  bone: '#1c1b19',
  bone2: '#33312d',
  soft: '#46433e',
  stone: '#66625b',
  stone2: '#77736c',
  stone3: '#8f8b83',
  amber: '#b9770b',
  amberHover: '#a5690a',
  onAmber: '#1a1408',
  blue: '#2a73b8',
  onBlue: '#ffffff',
  green: '#1d8a52',
  red: '#cf3a2d',
  hairline: 'rgba(30,26,20,0.06)',
  line: 'rgba(30,26,20,0.10)',
  control2: 'rgba(30,26,20,0.06)',
  scrim: 'rgba(20,16,10,0.35)',
  amberTint: 'rgba(185,119,11,0.10)',
  amberLine: 'rgba(185,119,11,0.30)',
  blueTint: 'rgba(42,115,184,0.10)',
  blueLine: 'rgba(42,115,184,0.30)',
  greenTint: 'rgba(29,138,82,0.11)',
  greenLine: 'rgba(29,138,82,0.30)',
  redTint: 'rgba(207,58,45,0.10)',
  redLine: 'rgba(207,58,45,0.30)',
  onRed: '#ffffff',
  redText: '#b8372b',
  raised: '#ffffff',
  edge: 'rgba(30,26,20,0.08)',
  edgeTop: 'rgba(30,26,20,0.05)',
  scrimDeep: 'rgba(20,16,10,0.45)',
  shimmer: 'rgba(30,26,20,0.06)',
  shimmerEnd: 'rgba(30,26,20,0)',
  yellow: '#8f8312',
  violet: '#7d4cc0',
  music: '#7d4cc0',
  onMusic: '#ffffff',
  glass: 'rgba(245,243,238,0.94)',
  navGlass: 'rgba(239,236,230,0.97)',
  dash: 'rgba(30,26,20,0.14)',
  amberSolid: '#f7ecd6',
  toastEdge: 'rgba(30,26,20,0.9)',
  toastErr: '#fbe9e6',
  toastBtn: 'rgba(255,255,255,0.14)',
  skipped: '#e3dfd6',
  skippedKey: '#d6d1c7',
  nowLine: '#1c1b19',
};

export type Scheme = 'light' | 'dark';
let current: Scheme = 'dark';

/** The colours in use. Screens read `C.x` when they render; `applyScheme` rewrites this object, then the app remounts. */
export const C: Palette = { ...DARK };

/** Switch the palette (and the shadows) to light or dark. Nothing re-renders by itself: App.tsx remounts under a new key. */
export function applyScheme(s: Scheme) {
  current = s === 'light' ? 'light' : 'dark';
  Object.assign(C, current === 'light' ? LIGHT : DARK);
  Object.assign(SHADOW, current === 'light' ? SHADOW_LIGHT : SHADOW_DARK);
}

/** The scheme in use. */
export const scheme = (): Scheme => current;

/**
 * The type scale. Every piece of text in the app is one of these; screens don't pick sizes.
 * [size, weight, tracking (em), line height (× size)]
 */
export const TYPE = {
  /** The mode name on Now. */
  hero: [40, 800, -0.035, 1.05],
  /** A tab's large title. */
  largeTitle: [32, 800, -0.03, 1.1],
  /** A device panel's name, a big number. */
  title: [24, 700, -0.02, 1.15],
  /** A section heading. */
  heading: [18, 700, -0.015, 1.25],
  /** A card or row title. */
  headline: [15, 700, -0.005, 1.3],
  /** Reading text. */
  body: [15, 500, 0, 1.45],
  /** Secondary lines under a title. */
  callout: [13.5, 500, 0, 1.4],
  /** Labels on controls and buttons. */
  label: [14, 700, 0, 1.25],
  /** Small labels, metadata. */
  footnote: [12.5, 500, 0, 1.35],
  /** Smaller labels on controls: chips, small buttons. */
  labelSm: [13, 700, 0, 1.25],
  /** Section captions in capitals. */
  overline: [11.5, 800, 0.08, 1.2],
  /** Captions in capitals inside a card. */
  eyebrow: [10.5, 800, 0.08, 1.2],
  /** Tab bar labels, badges. */
  micro: [11, 700, 0.01, 1.2],
} as const;
export type TypeVariant = keyof typeof TYPE;

/** Spacing, on a 4 pt grid. `gutter` is the page's side margin. */
export const SP = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40, gutter: 18, section: 28 } as const;

/** Corner radii: small controls, controls, cards, big cards and tiles, sheets, fully round. */
export const R = { xs: 8, sm: 10, md: 14, lg: 18, xl: 22, sheet: 28, full: 999 } as const;

/** Font families as loaded in App.tsx (one family per weight, which is how React Native wants custom fonts). */
export const F = {
  400: 'Manrope_400Regular',
  500: 'Manrope_500Medium',
  600: 'Manrope_600SemiBold',
  700: 'Manrope_700Bold',
  800: 'Manrope_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  icons: 'KovaSymbols',
  iconsFilled: 'KovaSymbolsFilled',
} as const;

/** A colour at an alpha, from #rrggbb (the design writes mode tints as colour + hex alpha). */
export const alpha = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Text and glyphs over a camera picture or live video: always light, on the dark pill behind them, in either scheme. */
export const ON_PHOTO = { text: '#f1efea', dim: '#d8d5cf' } as const;

/** The light square behind a QR code, so it scans in either scheme. */
export const QR_PAPER = '#f1efea';

/** How bright a #rrggbb is, 0 to 1 (WCAG relative luminance). */
const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
};

/**
 * A colour the person or the design picked (a mode's, a light's) as text or a glyph on the page: unchanged on dark;
 * on light, a pale one is darkened toward the text colour until it can be read there.
 */
export const ink = (hex: string): string => {
  if (current !== 'light' || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  let out = hex;
  for (let i = 0; i < 12 && luma(out) > 0.17; i++) {
    const a = parseInt(out.slice(1), 16), b = parseInt(LIGHT.bone.slice(1), 16);
    const m = (s: number) => Math.round(((a >> s) & 255) * 0.85 + ((b >> s) & 255) * 0.15);
    out = `#${[16, 8, 0].map(s => m(s).toString(16).padStart(2, '0')).join('')}`;
  }
  return out;
};

/** Text or a glyph on a fill of this colour: the coal one on dark; on light, dark on a pale fill and white on a deep one. */
export const readableOn = (hex: string): string => current !== 'light' || !/^#[0-9a-f]{6}$/i.test(hex) ? C.coal : luma(hex) > 0.18 ? LIGHT.onAmber : '#ffffff';

/**
 * Motion tokens. Durations from the design language (120 ms press to 0.97, 200 ms state changes, 280 ms sheets);
 * springs for anything a finger lets go of, so it settles with a little weight instead of stopping dead.
 * Springs are stiffness / damping / mass, as Animated.spring takes them. ui/motion.ts turns these into
 * animations, and into instant changes when the phone asks for reduced motion.
 */
export const MOTION = {
  dur: { press: 120, state: 200, sheet: 280, exit: 180, fade: 160, shimmer: 1400, spin: 900, done: 1400 },
  /** cubic-bezier control points: `out` for things arriving, `in` for things leaving. */
  ease: { out: [0.2, 0.8, 0.2, 1], in: [0.4, 0, 1, 1] },
  /** A press scales to 0.97 (the design) and dims a touch; with reduced motion it only dims, a little more. */
  press: { scale: 0.97, dim: 0.88, dimReduced: 0.6 },
  spring: {
    /** A button coming back up after a press: quick, a hint of overshoot. */
    press: { stiffness: 480, damping: 26, mass: 1 },
    /** A switch's thumb crossing over. */
    toggle: { stiffness: 560, damping: 32, mass: 1 },
    /** A sheet rising, or settling back after a drag. */
    sheet: { stiffness: 320, damping: 34, mass: 1 },
    /** Toasts and icons popping in. */
    pop: { stiffness: 420, damping: 20, mass: 1 },
    /** A slider thumb growing under the finger. */
    grow: { stiffness: 520, damping: 28, mass: 1 },
  },
  /** List items fading up one after another: per-item delay, how many get a delay, how far they rise, how long. */
  stagger: { step: 32, max: 10, rise: 10, dur: 260 },
  /** Touch targets are at least this big (points): the hit area is padded when the visible control is smaller. */
  target: 44,
} as const;

/** Elevation for things that float over the page (sheets, toasts), and the glow of a lit tile. */
const SHADOW_DARK = {
  sheet: '0px -12px 48px rgba(0,0,0,0.6)',
  /** A card lifted a little off the page. */
  card: '0px 1px 2px rgba(0,0,0,0.4), 0px 8px 24px rgba(0,0,0,0.18)',
  /** The tab bar's Ask button. */
  fab: '0px 6px 18px rgba(242,177,76,0.35), 0px 2px 6px rgba(0,0,0,0.4)',
  toast: '0px 10px 28px rgba(0,0,0,0.45)',
  raised: '0px 4px 14px rgba(0,0,0,0.35)',
};
const SHADOW_LIGHT: typeof SHADOW_DARK = {
  sheet: '0px -12px 48px rgba(30,26,20,0.18)',
  card: '0px 1px 2px rgba(30,26,20,0.08), 0px 8px 24px rgba(30,26,20,0.06)',
  fab: '0px 6px 18px rgba(185,119,11,0.3), 0px 2px 6px rgba(30,26,20,0.15)',
  toast: '0px 10px 28px rgba(30,26,20,0.25)',
  raised: '0px 4px 14px rgba(30,26,20,0.12)',
};
export const SHADOW: typeof SHADOW_DARK = { ...SHADOW_DARK };
