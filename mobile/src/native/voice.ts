import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { getItem, setItem } from './storage';

// Talking to Ask Kova, the way Helix's apps do: the phone's own speech recognition (Apple's on iPhone, Google's on
// Android) turns what's said into words. Recognisers need the language first (none detects it), so there are two to
// choose: the phone's own language, and Bangla (unless the phone already is). The choice is kept on the phone. Before
// listening, a language the recogniser doesn't offer (Apple's has no Bangla), or one that failed this session, is
// swapped for the one that last worked, and said. The phone's own language is recognised on the phone where it can be.
// An answer to a spoken question is read out. A binary without the speech module (app 0.2.x before 0.2.0's store build)
// hides the microphone.

type Rec = typeof import('expo-speech-recognition');
type Tts = typeof import('expo-speech');

const has = Platform.OS === 'web' || !!requireOptionalNativeModule('ExpoSpeechRecognition');
// Loaded only where the native module is there (a require on an old binary would throw at start).
const rec: Rec | null = has ? require('expo-speech-recognition') as Rec : null;
const tts: Tts | null = Platform.OS === 'web' || requireOptionalNativeModule('ExpoSpeech') ? require('expo-speech') as Tts : null;

export const voiceReady = !!rec;
export const { useSpeechRecognitionEvent } = rec ?? { useSpeechRecognitionEvent: (() => {}) as Rec['useSpeechRecognitionEvent'] };

/** The phone's own language, as a BCP-47 tag (en-AU, bn-BD, ar-SA…). */
export const phoneLang = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'; } catch { return 'en-US'; } };
export const BANGLA = 'bn-BD';
const base = (tag: string) => tag.toLowerCase().split(/[-_]/)[0]!;

/** The languages to choose from: the phone's own, and Bangla unless the phone is Bangla already. */
export const voiceLangs = (): string[] => base(phoneLang()) === 'bn' ? [phoneLang()] : [phoneLang(), BANGLA];

/** A language's name in a few words: "বাংলা" for Bangla, else the phone's name for it ("English"), else its tag. */
export function langName(tag: string): string {
  if (base(tag) === 'bn') return 'বাংলা';
  try { const n = new Intl.DisplayNames([tag], { type: 'language' }).of(base(tag)); if (n) return n[0]!.toUpperCase() + n.slice(1); } catch { /* an engine without DisplayNames */ }
  return tag;
}

const KEY = 'kova.voiceLang';
export async function voiceLang(): Promise<string> {
  const v = await getItem(KEY).catch(() => null);
  return v && voiceLangs().includes(v) ? v : phoneLang();
}
export const setVoiceLang = (l: string) => setItem(KEY, l).catch(() => {});

/** Languages that failed this session, and the one that last worked. */
const failed = new Set<string>();
let worked: string | null = null;
export const markFailed = (l: string) => { failed.add(l); };
export const markWorked = (l: string) => { worked = l; failed.delete(l); };

/**
 * Start listening (asking for the microphone and speech permission the first time), in `lang` or, where the
 * recogniser can't, in the language that last worked. Says which it used, and why when it isn't `lang`.
 * Throws with words to show.
 */
export async function listen(lang: string): Promise<{ lang: string; note?: string }> {
  if (!rec) throw new Error('This version of the app can’t listen yet: update it from the App Store or Google Play');
  const m = rec.ExpoSpeechRecognitionModule;
  const p = await m.requestPermissionsAsync();
  if (!p.granted) throw new Error('Allow the microphone and speech recognition for Kova in Settings to talk to it');
  let use = lang, note: string | undefined;
  const offered = await m.getSupportedLocales({}).then(r => r.locales).catch(() => [] as string[]);
  const offers = (t: string) => !offered.length || offered.some(o => o.toLowerCase().replace('_', '-') === t.toLowerCase() || base(o) === base(t));
  if (!offers(lang) || failed.has(lang)) {
    const fallback = [worked, phoneLang()].find((t): t is string => !!t && t !== lang && offers(t) && !failed.has(t));
    if (fallback) {
      note = `${langName(lang)} ${failed.has(lang) ? 'didn’t work just now' : 'isn’t offered by this phone’s speech recognition'}: listening in ${langName(fallback)}`;
      use = fallback;
    }
  }
  // The phone's own language on the phone itself, where it can; anything else through the platform's service.
  const onDevice = use === phoneLang() && (() => { try { return m.supportsOnDeviceRecognition(); } catch { return false; } })();
  m.start({ lang: use, interimResults: true, continuous: false, maxAlternatives: 1, addsPunctuation: false, requiresOnDeviceRecognition: onDevice, iosTaskHint: 'search' });
  return { lang: use, ...(note ? { note } : {}) };
}

export function stopListening(): void { rec?.ExpoSpeechRecognitionModule.stop(); }

/** Read an answer out: a Bangla voice for Bangla words, else the language it was asked in. */
export function speak(text: string, lang: string): void {
  if (!tts || !text) return;
  tts.stop();
  tts.speak(text.replace(/https?:\/\/\S+/g, ''), { language: /[ঀ-৿]/.test(text) ? BANGLA : base(lang) === 'bn' ? phoneLang() : lang });
}

export function quiet(): void { tts?.stop(); }
