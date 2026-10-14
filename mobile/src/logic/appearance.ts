// Light or dark: the choice kept on this phone, and which scheme it comes to. Free of React Native so the tests run it under plain Node.

export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: { id: Appearance; label: string }[] = [{ id: 'system', label: 'Match phone' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

/** A stored value as a choice; anything unknown is the default, matching the phone. */
export const parseAppearance = (v: unknown): Appearance => v === 'light' || v === 'dark' ? v : 'system';

/** The scheme to draw: the choice, or the phone's own when matching it (dark when the phone doesn't say). */
export const resolveScheme = (choice: Appearance, system: string | null | undefined): 'light' | 'dark' => choice === 'system' ? (system === 'light' ? 'light' : 'dark') : choice;
