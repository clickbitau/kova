import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { getItem, setItem } from './storage';

// Talking to Ask Kova: the phone's own speech recognition (Apple's or Google's; on the phone where it can) turns what's
// said into words, in English or Bangla; an answer to a spoken question is read out. A binary from before voice
// (app 0.2.x) has no speech module: `voiceReady` is false there and the microphone isn't shown.

type Rec = typeof import('expo-speech-recognition');
type Tts = typeof import('expo-speech');

const has = Platform.OS === 'web' || !!requireOptionalNativeModule('ExpoSpeechRecognition');
// Loaded only where the native module is there (a require on an old binary would throw at start).
const rec: Rec | null = has ? require('expo-speech-recognition') as Rec : null;
const tts: Tts | null = Platform.OS === 'web' || requireOptionalNativeModule('ExpoSpeech') ? require('expo-speech') as Tts : null;

export const voiceReady = !!rec;
export const { useSpeechRecognitionEvent } = rec ?? { useSpeechRecognitionEvent: (() => {}) as Rec['useSpeechRecognitionEvent'] };

export type VoiceLang = 'en-AU' | 'bn-BD';
const KEY = 'kova.voiceLang';

export async function voiceLang(): Promise<VoiceLang> {
  const v = await getItem(KEY).catch(() => null);
  return v === 'bn-BD' || v === 'en-AU' ? v : 'en-AU';
}
export const setVoiceLang = (l: VoiceLang) => setItem(KEY, l).catch(() => {});

/** Start listening (asking for the microphone and speech permission the first time). Throws with words to show. */
export async function listen(lang: VoiceLang): Promise<void> {
  if (!rec) throw new Error('This version of the app can’t listen yet: update it from the App Store');
  const m = rec.ExpoSpeechRecognitionModule;
  const p = await m.requestPermissionsAsync();
  if (!p.granted) throw new Error('Allow the microphone and speech recognition for Kova in Settings to talk to it');
  m.start({ lang, interimResults: true, continuous: false, addsPunctuation: true, iosTaskHint: 'search' });
}

export function stopListening(): void { rec?.ExpoSpeechRecognitionModule.stop(); }

/** Read an answer out: a Bangla voice for Bangla words, else the language asked in. */
export function speak(text: string, lang: VoiceLang): void {
  if (!tts || !text) return;
  tts.stop();
  tts.speak(text.replace(/https?:\/\/\S+/g, ''), { language: /[ঀ-৿]/.test(text) ? 'bn-BD' : lang === 'bn-BD' ? 'en-AU' : lang });
}

export function quiet(): void { tts?.stop(); }
