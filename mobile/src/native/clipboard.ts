import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';

// The clipboard, through what's already in the app: React Native's own clipboard module (still in the binary,
// though its JavaScript wrapper is deprecated) or the browser's. No new native module, so this ships over the air.
// Where neither is there, Paste and Copy don't show.

interface ClipboardModule extends TurboModule { getString(): Promise<string>; setString(s: string): void }

const native = Platform.OS === 'web' ? null : (() => { try { return TurboModuleRegistry.get<ClipboardModule>('Clipboard'); } catch { return null; } })();
const web = Platform.OS === 'web' ? (globalThis as { navigator?: { clipboard?: { readText?: () => Promise<string>; writeText?: (s: string) => Promise<void> } } }).navigator?.clipboard : undefined;

export const canPaste = !!native || !!web?.readText;
export const canCopy = !!native || !!web?.writeText;

/** What's on the clipboard, or '' when it can't be read (the browser said no). */
export async function paste(): Promise<string> {
  try {
    if (native) return (await native.getString()) ?? '';
    if (web?.readText) return await web.readText();
  } catch { /* not allowed */ }
  return '';
}

export async function copy(text: string): Promise<boolean> {
  try {
    if (native) { native.setString(text); return true; }
    if (web?.writeText) { await web.writeText(text); return true; }
  } catch { /* not allowed */ }
  return false;
}
