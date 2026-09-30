import { Text, type TextStyle, type StyleProp } from 'react-native';
import { ICON_CODES } from './icon-codes';
import { C, F } from '../theme';

/** A Material Symbols Rounded icon by name, outlined or filled (the design's FILL 0 / 1). Unknown names fall back to a dot. */
export function Icon({ name, size = 20, color = C.bone, fill, style }: { name: string; size?: number; color?: string; fill?: boolean; style?: StyleProp<TextStyle> }) {
  const ch = ICON_CODES[name] ?? ICON_CODES.help;
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      allowFontScaling={false}
      style={[{ fontFamily: fill ? F.iconsFilled : F.icons, fontSize: size, lineHeight: size, color, width: size, height: size, textAlign: 'center' }, style]}
    >{ch}</Text>
  );
}

export const hasIcon = (name: string) => name in ICON_CODES;
