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
