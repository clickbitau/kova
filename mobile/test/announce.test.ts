import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_KINDS, FIVE_PRAYERS, KIND_ICON, RHYTHMS, actionText, announceMediaFromKey, announceMediaKey, announceMediaName, announceProblem, announceSaveProblem, calibratedVol,
  ctxOf, missingPrayers, newAction, pauseChoices, rhythmChoices, targetLevel, targetSpeakers, trimOf, withEveryPrayer, type Action, type AnnounceAction, type Names, type Trigger,
} from '../src/logic/automations.ts';
import { prayerOn } from '../src/logic/prayer.ts';
import { clipFileProblem, clipName, loudnessBody, loudnessWords, snapLoudness } from '../src/logic/media.ts';

const spk = (id: string, room: string, extra: Record<string, unknown> = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), room, type: 'media' as const, capabilities: ['onoff', 'media', 'volume'], canAnnounce: true, ...extra });
const devices = [
  spk('kitchen', 'kitchen'), spk('bar', 'lounge', { announceTrim: 60 }), spk('study', 'study', { hidden: true }), spk('old', 'study', { archived: true }),
  { id: 'group1', name: 'Downstairs', room: 'lounge', type: 'media' as const, capabilities: ['onoff', 'media', 'volume'], adapter: 'groups' },
  { id: 'box', name: 'Lounge box', room: 'lounge', type: 'tv' as const, capabilities: ['onoff', 'media', 'pause', 'library'] },
  { id: 'lamp', name: 'Lamp', room: 'lounge', type: 'dimmer' as const, capabilities: ['onoff', 'brightness'] },
];
const groups = [{ deviceId: 'group1', members: ['kitchen', 'bar'] }];
const names: Names = {
  devices: devices.map(d => ({ id: d.id, name: d.name })), rooms: [{ id: 'lounge', name: 'Lounge' }, { id: 'kitchen', name: 'Kitchen' }], people: [], modes: [], overlays: [{ id: 'guests', name: 'Guests' }], automations: [],
  clips: [{ id: 'c1', name: 'Chime' }], adhans: [{ id: 'adhan:short', title: 'Short adhan' }], speakerGroups: groups,
};
const home = { devices, overlays: [{ id: 'guests' }], clips: [{ id: 'c1', name: 'Chime' }] };
const base = (p: Partial<AnnounceAction> = {}): AnnounceAction => ({ kind: 'announce', media: 'adhan:short', vol: 20, targets: { kitchen: {}, bar: {} }, pause: [], restore: true, ...p });

test('announce: a kind of step with an icon; a new one plays on every speaker (not hidden or archived) at 20%, putting them back', () => {
  assert.ok(ACTION_KINDS.some(k => k.v === 'announce'));
  assert.equal(KIND_ICON['action:announce'], 'campaign');
  const off = ctxOf({ devices, sources: [], modes: [], overlays: [], automations: [], prayer: { on: false, adhan: { media: 'adhan:short' } } });
  assert.deepEqual(newAction('announce', off), { kind: 'announce', media: '', vol: 20, targets: { kitchen: {}, bar: {} }, pause: [], restore: true });
  const on = ctxOf({ devices, sources: [], modes: [], overlays: [], automations: [], prayer: { on: true, adhan: { media: 'adhan:short' } } });
  assert.equal((newAction('announce', on) as AnnounceAction).media, 'adhan:short', 'the home’s call to prayer, while prayer times are on');
});

test('announce in words: what, how many speakers, the level, what pauses, and after', () => {
  assert.equal(actionText(base({ pause: ['box'] }), names), 'announce Short adhan on 2 speakers at 20%, pausing Lounge box, then back to what they played');
  assert.equal(actionText(base({ targets: { kitchen: {}, bar: { off: true } }, restore: false, vol: 15 }), names), 'announce Short adhan on 1 of 2 speakers at 15%, then leave them idle');
  assert.equal(actionText(base({ targets: { kitchen: {} }, media: 'clip:c1' }), names), 'announce Chime on Kitchen at 20%, then back to what they played');
  assert.equal(actionText(base({ targets: { group1: {}, lamp: {} } }), names).includes('on 3 speakers'), true, 'a group counts its speakers');
  assert.equal(actionText(base({ media: '', mediaFor: { fajr: 'adhan:short' } }), names), 'announce something (choose what to play) (Fajr: Short adhan) on 2 speakers at 20%, then back to what they played');
});

test('what plays, by name and by choice', () => {
  assert.equal(announceMediaName('Radio', names), 'Radio');
  assert.equal(announceMediaName('clip:c1', names), 'Chime');
  assert.equal(announceMediaName('clip:gone', names), 'a clip (gone)');
  assert.equal(announceMediaName('adhan:short', names), 'Short adhan');
  assert.equal(announceMediaName('Song: Morning', names), 'Morning (Helix)');
  assert.equal(announceMediaName('https://example.com/sounds/bell%20one.mp3', names), 'bell one.mp3');
  assert.equal(announceMediaName('https://radio.example.com/', names), 'radio.example.com');
  assert.equal(announceMediaKey('Song: X'), 'song');
  assert.equal(announceMediaKey('http://x/y.mp3'), 'url');
  assert.equal(announceMediaKey('Radio'), 'Radio');
  assert.equal(announceMediaFromKey('song', 'Song: Kept'), 'Song: Kept');
  assert.equal(announceMediaFromKey('url', 'Radio'), 'https://');
  assert.equal(announceMediaFromKey('clip:c1', 'Radio'), 'clip:c1');
});

test('announce: checked as you type, as the hub checks it', () => {
  assert.equal(announceProblem(base(), home), undefined);
  assert.equal(announceProblem(base({ media: '' }), home), 'Choose what to play');
  assert.equal(announceProblem(base({ media: 'Song: ' }), home), 'Type the song’s title');
  assert.equal(announceProblem(base({ media: 'clip:nope' }), home), 'That clip is gone: choose another');
  assert.equal(announceProblem(base({ mediaFor: { fajr: '' } }), home), 'Fajr: choose what to play');
  assert.equal(announceProblem(base({ vol: 120 }), home), 'The level is from 0 to 100%.');
  assert.equal(announceProblem(base({ targets: {} }), home), 'Add at least one speaker.');
  assert.equal(announceProblem(base({ targets: { lamp: {} } }), home), 'Lamp isn’t a speaker.');
  assert.equal(announceProblem(base({ targets: { group1: {} } }), home), undefined, 'a speaker group is a target');
  assert.equal(announceProblem(base({ targets: { kitchen: { off: true } } }), home), 'Turn at least one speaker on.');
  assert.equal(announceProblem(base({ targets: { kitchen: { skipWhile: ['party'] } } }), home), 'Kitchen: an overlay it skips for is gone.');
  assert.equal(announceProblem(base({ pause: ['lamp'] }), home), 'Lamp can’t pause.');
  assert.equal(announceProblem(base({ maxSec: 2 }), home), 'At most takes 5 seconds to 30 minutes.');
  assert.equal(announceProblem(base({ maxSec: 1800 }), home), undefined);
  const nested: Action[] = [{ kind: 'if', conditions: [], then: [{ kind: 'stop' }], else: [base({ media: '' })] }];
  assert.equal(announceSaveProblem(nested, home), 'Choose what to play');
});

test('calibrated volume: the level × the speaker’s loudness, at least 1% unless 0, at most 100%', () => {
  assert.equal(calibratedVol(15, 60), 9);
  assert.equal(calibratedVol(20, 100), 20);
  assert.equal(calibratedVol(20, 55), 11);
  assert.equal(calibratedVol(1, 20), 1, 'never silent by rounding');
  assert.equal(calibratedVol(0, 200), 0);
  assert.equal(calibratedVol(80, 200), 100);
  assert.equal(trimOf(devices[0]), 100);
  assert.equal(trimOf(devices[1]), 60);
  assert.equal(targetLevel(base({ targets: { kitchen: { vol: 40 }, bar: {} } }), 'kitchen'), 40);
  assert.equal(targetLevel(base(), 'bar'), 20);
  assert.deepEqual(targetSpeakers('group1', devices, groups).map(d => d.id), ['kitchen', 'bar']);
  assert.deepEqual(targetSpeakers('bar', devices, groups).map(d => d.id), ['bar']);
  assert.deepEqual(pauseChoices(devices).map(d => d.id), ['box'], 'players that pause and aren’t its speakers');
  assert.equal(snapLoudness(63), 65);
  assert.equal(snapLoudness(5), 20);
  assert.deepEqual(loudnessBody(100), { announceTrim: null });
  assert.deepEqual(loudnessBody(142), { announceTrim: 140 });
  assert.equal(loudnessWords(60), '60% (quieter)');
});

test('every prayer time: adds the five that aren’t there yet', () => {
  const t: Trigger[] = [{ kind: 'time', at: { kind: 'prayer', prayer: 'asr' } }, { kind: 'time', at: { kind: 'prayer', prayer: 'isha', offsetMin: 10 } }, { kind: 'every', minutes: 5 }];
  assert.deepEqual(missingPrayers(t), ['fajr', 'dhuhr', 'maghrib', 'isha'], 'Isha + 10 min isn’t Isha');
  const all = withEveryPrayer(t);
  assert.equal(all.length, 7);
  assert.deepEqual(missingPrayers(all), []);
  assert.deepEqual(withEveryPrayer(all), all, 'nothing twice');
  assert.deepEqual(all.slice(3).map(x => x.kind === 'time' && x.at.kind === 'prayer' ? x.at.prayer : ''), ['fajr', 'dhuhr', 'maghrib', 'isha']);
  assert.deepEqual(missingPrayers([{ kind: 'time', at: { kind: 'prayer', prayer: 'all' as never } }]), [], 'the hub’s “all”');
  assert.equal(FIVE_PRAYERS.length, 5);
});

test('prayer options are hidden while prayer times are off, unless the time already is one', () => {
  const prayers = (l: { v: string }[]) => l.filter(o => o.v.startsWith('prayer:')).length;
  assert.equal(prayers(rhythmChoices(true)), 6);
  assert.equal(prayers(rhythmChoices(false)), 0);
  assert.equal(rhythmChoices(false).length, RHYTHMS.length - 6);
  assert.equal(prayers(rhythmChoices(false, { kind: 'prayer', prayer: 'asr' })), 6, 'an existing prayer time stays editable');
  assert.equal(prayers(rhythmChoices(false, { kind: 'sun', event: 'sunset' })), 0);
  assert.equal(prayerOn({ prayer: { on: false } }), false);
  assert.equal(prayerOn({ prayer: { on: true } }), true);
  assert.equal(prayerOn({}), true, 'an older hub that doesn’t say keeps them');
});

test('clips: a name from the file, and only the kinds and sizes the hub takes', () => {
  assert.equal(clipName('Door_chime.mp3'), 'Door chime');
  assert.equal(clipFileProblem({ name: 'a.ogg', size: 1000 }), null);
  assert.match(clipFileProblem({ name: 'a.txt', size: 10 })!, /MP3/);
  assert.match(clipFileProblem({ name: 'a.mp3', size: 16 * 1024 * 1024 })!, /15 MB/);
});
