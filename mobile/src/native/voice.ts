import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { baseOf, SPEECH_LANGS, speechLangs, voiceFor } from '../logic/speech';
import { getItem, getJson, setItem, setJson } from './storage';

// Talking to Ask Kova, the way Helix's apps do: the phone's own speech recognition (Apple's on iPhone, Google's on
// Android) turns what's said into words. Recognisers need the language first (none detects it), so it's the phone's
// own language, plus any the person adds on This phone. The choice and the added languages are kept on the phone.
// Before listening, a language the recogniser doesn't offer, or one that failed this session, is
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
const base = baseOf;

const EXTRA = 'kova.voiceExtra';
let extra: string[] = [];
const watchers = new Set<(l: string[]) => void>();
const loaded = getJson<string[]>(EXTRA).then(l => { if (Array.isArray(l)) extra = l.filter(x => typeof x === 'string'); });

/** The languages to choose from: the phone's own, and any added. */
export const voiceLangs = (): string[] => speechLangs(phoneLang(), extra);

/** The languages to choose from, kept current as they're added, and a way to change the added ones. */
export function useVoiceLangs(): { langs: string[]; extra: string[]; setExtra: (l: string[]) => void } {
  const [list, setList] = useState(extra);
  useEffect(() => {
    watchers.add(setList);
    void loaded.then(() => setList(extra));
    return () => { watchers.delete(setList); };
  }, []);
  const setExtra = (l: string[]) => { extra = l; void setJson(EXTRA, l.length ? l : null).catch(() => {}); watchers.forEach(w => w(l)); };
  return { langs: speechLangs(phoneLang(), list), extra: list, setExtra };
}

/** A language's name in a few words: its own name when the list has it, else the phone's name for it ("English"), else its tag. */
export function langName(tag: string): string {
  const own = SPEECH_LANGS.find(l => l.tag.toLowerCase() === tag.toLowerCase());
  if (own && base(tag) !== base(phoneLang())) return own.name;
  try { const n = new Intl.DisplayNames([phoneLang()], { type: 'language' }).of(tag); if (n) return n[0]!.toUpperCase() + n.slice(1); } catch { /* an engine without DisplayNames */ }
  return own?.name ?? tag;
}

const KEY = 'kova.voiceLang';
export async function voiceLang(): Promise<string> {
  await loaded;
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

/** Read an answer out: a voice for the script the words are in (Bengali, Arabic, Hindi…), else the language it was asked in. */
export function speak(text: string, lang: string): void {
  if (!tts || !text) return;
  tts.stop();
  tts.speak(text.replace(/https?:\/\/\S+/g, ''), { language: voiceFor(text, lang, voiceLangs(), phoneLang()) });
}

export function quiet(): void { tts?.stop(); }
