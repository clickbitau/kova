import { Children, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { SP } from '../theme';
import { columnsFor, layoutFor, type Layout } from '../logic/layout';

/** The layout for this window (logic/layout.ts): `read` for a page opened from a tab. */
export function useLayout(read = false): Layout & { width: number; fontScale: number; columns: (min: number, o?: Parameters<typeof columnsFor>[3]) => number } {
  const { width, fontScale } = useWindowDimensions();
  const l = layoutFor(width, read);
  return { ...l, width, fontScale, columns: (min, o) => columnsFor(l.content, min, fontScale, o) };
}

/** The share of a row each of `n` takes, as a flex basis that leaves room for the gaps (flexGrow fills the rest). */
export const basis = (n: number): `${number}%` => `${Math.floor(100 / n) - 3}%`;

/** Its children side by side on a tablet (`two`), each taking an equal share; one under another on a phone. */
export function Columns({ two, children }: { two: boolean; children: ReactNode }) {
  return two
    ? <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SP[4] }}>{Children.map(children, c => <View style={{ flex: 1, minWidth: 0 }}>{c}</View>)}</View>
    : <View style={{ gap: SP[6] }}>{children}</View>;
}
