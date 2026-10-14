// Talking to Kova: the languages a person can add beside their phone's own, the word shown while listening, and which
// voice reads an answer. Free of React Native so the tests run it under plain Node.

/** Common languages to add for speech, as BCP-47 tags with their own names. */
export const SPEECH_LANGS: { tag: string; name: string }[] = [
  { tag: 'en-US', name: 'English (US)' }, { tag: 'en-GB', name: 'English (UK)' }, { tag: 'en-AU', name: 'English (Australia)' }, { tag: 'en-CA', name: 'English (Canada)' }, { tag: 'en-IN', name: 'English (India)' },
  { tag: 'es-ES', name: 'Español' }, { tag: 'es-MX', name: 'Español (México)' }, { tag: 'fr-FR', name: 'Français' }, { tag: 'de-DE', name: 'Deutsch' }, { tag: 'it-IT', name: 'Italiano' },
  { tag: 'pt-BR', name: 'Português (Brasil)' }, { tag: 'pt-PT', name: 'Português (Portugal)' }, { tag: 'nl-NL', name: 'Nederlands' }, { tag: 'tr-TR', name: 'Türkçe' },
  { tag: 'ar-SA', name: 'العربية' }, { tag: 'hi-IN', name: 'हिन्दी' }, { tag: 'bn-BD', name: 'বাংলা' }, { tag: 'ur-PK', name: 'اردو' },
  { tag: 'zh-CN', name: '中文 (简体)' }, { tag: 'zh-TW', name: '中文 (繁體)' }, { tag: 'ja-JP', name: '日本語' }, { tag: 'ko-KR', name: '한국어' }, { tag: 'id-ID', name: 'Bahasa Indonesia' },
];

/** A tag's language part, lower-case: "en-AU" → "en". */
export const baseOf = (tag: string) => tag.toLowerCase().split(/[-_]/)[0]!;

/** The languages to choose from: the phone's own first, then the ones added (no repeats of a language already there). */
export function speechLangs(phone: string, extra: string[]): string[] {
  const out = [phone];
  for (const t of extra) if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** What the box says while listening, in the language heard; English where there's no word for it here. */
const LISTENING: Record<string, string> = {
  bn: 'শুনছি…', es: 'Escuchando…', fr: 'J’écoute…', de: 'Ich höre zu…', it: 'Ascolto…', pt: 'Ouvindo…', nl: 'Ik luister…', tr: 'Dinliyorum…',
  ar: 'أستمع…', hi: 'सुन रहा हूँ…', ur: 'سن رہا ہوں…', zh: '正在聆听…', ja: '聞いています…', ko: '듣고 있어요…', id: 'Mendengarkan…',
};
export const listeningWord = (tag: string) => LISTENING[baseOf(tag)] ?? 'Listening…';

/** Scripts that tell a language from the words alone: the languages that write in each, the first being the usual one. */
const SCRIPTS: { re: RegExp; langs: string[]; tag: string }[] = [
  { re: /[ঀ-৿]/, langs: ['bn', 'as'], tag: 'bn-BD' },
  { re: /[ऀ-ॿ]/, langs: ['hi', 'mr', 'ne'], tag: 'hi-IN' },
  { re: /[؀-ۿݐ-ݿ]/, langs: ['ar', 'ur', 'fa'], tag: 'ar-SA' },
  { re: /[぀-ヿ]/, langs: ['ja'], tag: 'ja-JP' },
  { re: /[가-힯]/, langs: ['ko'], tag: 'ko-KR' },
  { re: /[一-鿿]/, langs: ['zh', 'ja'], tag: 'zh-CN' },
  { re: /[฀-๿]/, langs: ['th'], tag: 'th-TH' },
  { re: /[Ͱ-Ͽ]/, langs: ['el'], tag: 'el-GR' },
  { re: /[֐-׿]/, langs: ['he'], tag: 'he-IL' },
  { re: /[Ѐ-ӿ]/, langs: ['ru', 'uk', 'bg', 'sr'], tag: 'ru-RU' },
];

/**
 * The language to read `text` in. Words in a script of their own (Bengali, Arabic, Hindi, Chinese…) go to the
 * configured language that writes in it, else its usual one; Latin words go to `asked` unless that language isn't
 * written in Latin letters (then the phone's own). `configured` are the languages set up for talking.
 */
export function voiceFor(text: string, asked: string, configured: string[], phone: string): string {
  const sc = SCRIPTS.find(x => x.re.test(text));
  if (sc) {
    if (sc.langs.includes(baseOf(asked))) return asked;
    return configured.find(t => sc.langs.includes(baseOf(t))) ?? sc.tag;
  }
  const own = SCRIPTS.some(x => x.langs.includes(baseOf(asked)));
  return own && /[A-Za-z]/.test(text) ? phone : asked;
}
