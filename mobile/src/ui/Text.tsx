import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { C, F } from '../theme';

type Weight = 400 | 500 | 600 | 700 | 800;

export interface TProps extends TextProps {
  size?: number;
  weight?: Weight;
  color?: string;
  mono?: boolean;
  /** Letter spacing in em, as the design gives it (-0.03em). */
  tracking?: number;
  lineHeight?: number;
  center?: boolean;
  upper?: boolean;
}

/** Text in Manrope (or JetBrains Mono for times and ids), sized and weighted like the design. */
export function T({ size = 14, weight = 400, color = C.bone, mono, tracking, lineHeight, center, upper, style, ...rest }: TProps) {
  const s: TextStyle = {
    fontFamily: mono ? F.mono : F[weight],
    fontSize: size,
    color,
    ...(tracking != null ? { letterSpacing: tracking * size } : {}),
    ...(lineHeight != null ? { lineHeight: lineHeight * size } : {}),
    ...(center ? { textAlign: 'center' } : {}),
    ...(upper ? { textTransform: 'uppercase' } : {}),
  };
  return <RNText {...rest} style={[s, style]} />;
}
