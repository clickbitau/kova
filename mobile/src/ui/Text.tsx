import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { C, F, TYPE, type TypeVariant } from '../theme';

type Weight = 400 | 500 | 600 | 700 | 800;

export interface TProps extends TextProps {
  /** A step of the type scale (theme.ts TYPE): size, weight, tracking and line height together. */
  v?: TypeVariant;
  size?: number;
  weight?: Weight;
  color?: string;
  mono?: boolean;
  /** Letter spacing in em, as the design gives it (-0.03em). */
  tracking?: number;
  lineHeight?: number;
  center?: boolean;
  upper?: boolean;
  /** Numbers that change (a clock, a percentage) keep their width. */
  tabular?: boolean;
}

/**
 * Text in Manrope (or JetBrains Mono for times and ids). Pick a step of the type scale with `v`;
 * size and weight can still override it for the odd case. Titles get the header role.
 */
export function T({ v, size, weight, color = C.bone, mono, tracking, lineHeight, center, upper, tabular, style, ...rest }: TProps) {
  const base = v ? TYPE[v] : null;
  const sz = size ?? base?.[0] ?? 14;
  const wt = (weight ?? base?.[1] ?? 400) as Weight;
  const tr = tracking ?? base?.[2];
  const lh = lineHeight ?? base?.[3];
  const s: TextStyle = {
    fontFamily: mono ? F.mono : F[wt],
    fontSize: sz,
    color,
    ...(tr ? { letterSpacing: tr * sz } : {}),
    ...(lh != null ? { lineHeight: Math.round(lh * sz) } : {}),
    ...(center ? { textAlign: 'center' } : {}),
    ...(upper || v === 'overline' || v === 'eyebrow' ? { textTransform: 'uppercase' } : {}),
    ...(tabular ? { fontVariant: ['tabular-nums'] } : {}),
  };
  const header = v === 'largeTitle' || v === 'hero' || v === 'heading';
  return <RNText accessibilityRole={header ? 'header' : undefined} maxFontSizeMultiplier={v === 'hero' || v === 'largeTitle' ? 1.3 : 1.6} {...rest} style={[s, style]} />;
}
