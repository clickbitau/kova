import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf, listeningWord, SPEECH_LANGS, speechLangs, voiceFor } from '../src/logic/speech.ts';

test('speech: the phone’s language, then the ones added, no repeats', () => {
  assert.deepEqual(speechLangs('en-AU', []), ['en-AU']);
  assert.deepEqual(speechLangs('en-AU', ['bn-BD', 'en-au', 'es-ES']), ['en-AU', 'bn-BD', 'es-ES']);
  assert.ok(SPEECH_LANGS.every(l => /^[a-z]{2}-[A-Z]{2}$/.test(l.tag)));
  assert.equal(baseOf('pt_BR'), 'pt');
});

test('speech: the listening word is in the language, else English', () => {
  assert.equal(listeningWord('en-US'), 'Listening…');
  assert.equal(listeningWord('bn-BD'), 'শুনছি…');
  assert.equal(listeningWord('es-MX'), 'Escuchando…');
  assert.equal(listeningWord('sw-KE'), 'Listening…');
});

test('speech: the voice follows the words’ script, not one language', () => {
  const phone = 'en-US';
  assert.equal(voiceFor('The lights are on', 'en-US', ['en-US'], phone), 'en-US');
  assert.equal(voiceFor('আলো জ্বলছে', 'en-US', ['en-US', 'bn-BD'], phone), 'bn-BD');
  assert.equal(voiceFor('आज मौसम अच्छा है', 'en-US', ['en-US'], phone), 'hi-IN', 'a script not set up: its usual language');
  assert.equal(voiceFor('الأضواء مفتوحة', 'en-US', ['en-US', 'ar-EG', 'ur-PK'], phone), 'ar-EG', 'the configured language that writes in it');
  assert.equal(voiceFor('روشنی چل رہی ہے', 'ur-PK', ['en-US', 'ur-PK'], phone), 'ur-PK');
  assert.equal(voiceFor('照明がついています', 'en-US', [], phone), 'ja-JP');
  assert.equal(voiceFor('The lights are on', 'bn-BD', ['en-US', 'bn-BD'], phone), 'en-US', 'Latin words asked in a non-Latin language: the phone’s');
  assert.equal(voiceFor('Les lumières sont allumées', 'fr-FR', ['en-US', 'fr-FR'], phone), 'fr-FR');
});
