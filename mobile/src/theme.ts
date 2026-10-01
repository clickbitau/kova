// Kova's design tokens (docs/design/tokens), for the phone. Colour means state:
// amber = light / on / primary, blue = media and air, green = healthy / present / live, red = alert.
export const C = {
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
};

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

/**
 * Motion tokens. Durations from the design language (120 ms press to 0.97, 200 ms state changes, 280 ms sheets);
 * springs for anything a finger lets go of, so it settles with a little weight instead of stopping dead.
 * Springs are stiffness / damping / mass, as Animated.spring takes them. ui/motion.ts turns these into
 * animations, and into instant changes when the phone asks for reduced motion.
 */
export const MOTION = {
  dur: { press: 120, state: 200, sheet: 280, exit: 180, fade: 160 },
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
export const SHADOW = {
  sheet: '0px -10px 40px rgba(0,0,0,0.55)',
  toast: '0px 10px 28px rgba(0,0,0,0.45)',
  raised: '0px 4px 14px rgba(0,0,0,0.35)',
} as const;
