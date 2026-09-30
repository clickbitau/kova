import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { C } from '../theme';

/** The mode glow: a radial gradient in the mode colour behind the top-left of the screen. */
export function Glow({ color }: { color: string }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: -160, left: -80, width: 520, height: 420 }}>
      <Svg width={520} height={420}>
        <Defs>
          <RadialGradient id="g" cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={color} stopOpacity={0.2} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width={520} height={420} fill="url(#g)" />
      </Svg>
    </View>
  );
}

/** A scrolling page with the design's padding (18 px sides, 22 px between sections) under the status bar. */
export function Screen({ children, glow, onRefresh, refreshing, gap = 22 }: { children: ReactNode; glow?: string; onRefresh?: () => void; refreshing?: boolean; gap?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.page, overflow: 'hidden' }}>
      {glow ? <Glow color={glow} /> : null}
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 18, paddingHorizontal: 18, paddingBottom: 28, gap }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.stone} /> : undefined}
      >
        {children}
      </ScrollView>
    </View>
  );
}
