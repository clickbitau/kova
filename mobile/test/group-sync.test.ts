import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delayWords, draftSyncNote, driftWords, groupHow, groupParts, msWords, offsetWords, partSub, partTitle, snapOffset, testLeft, testSteps } from '../src/logic/group-sync.ts';
import type { GroupPart, NativeGroup } from '../src/api/types';

const cast = (id: string, members: string[]): NativeGroup => ({ via: 'cast', id, name: 'Home speakers', members });
const sonos: NativeGroup = { via: 'sonos', id: 'group', name: 'Sonos', members: ['ray', 'era'], dynamic: true };
const dev = (id: string, adapter: string, name = id) => ({ id, adapter, name, capabilities: ['media'] as never });

test('the group editor’s note: perfect sync, a native group with speakers alongside (named), or each kept in time', () => {
  const natives = [cast('home', ['k', 'd', 'b']), sonos];
  assert.equal(draftSyncNote([dev('k', 'cast')], natives).title, 'Pick at least two speakers');
  assert.equal(draftSyncNote(['k', 'd', 'b'].map(x => dev(x, 'cast')), natives).title, 'Perfect sync');
  const mixed = draftSyncNote([...['k', 'd', 'b'].map(x => dev(x, 'cast')), dev('ray', 'sonos', 'Ray')], natives);
  assert.equal(mixed.tone, 'blue');
  assert.match(mixed.text, /“Home speakers” \(a Google Cast group, 3 speakers\) plays in perfect sync\. Ray \(Sonos\) plays alongside/);
  assert.match(mixed.text, /not sample-locked/);
  assert.match(draftSyncNote([dev('ray', 'sonos'), dev('era', 'sonos')], natives).text, /Sonos plays 2 speakers as one group/);
  assert.match(draftSyncNote([dev('k', 'cast'), dev('d', 'cast')], natives).text, /Google Home app/);
  // A combined soundbar plays through its Cast member.
  const bar = draftSyncNote([dev('k', 'cast'), dev('d', 'cast'), dev('combined_bar', 'combined', 'Soundbar')], natives, [{ deviceId: 'combined_bar', members: ['bar_st', 'b'] }], [{ id: 'bar_st', capabilities: [] as never }, { id: 'b', capabilities: ['media'] as never }]);
  assert.equal(bar.title, 'Perfect sync');
});

test('parts: the fewest streams from the native groups, as the hub does it', () => {
  const ps = groupParts(['a', 'b', 'c', 'd', 'e'], [cast('abc', ['a', 'b', 'c']), cast('cd', ['c', 'd']), cast('de', ['d', 'e'])]);
  assert.deepEqual(ps.map(p => p.native?.id), ['abc', 'de']);
  assert.deepEqual(groupParts(['k', 'ray'], [cast('home', ['k', 'x'])]).map(p => p.ids), [['k'], ['ray']]);
});

test('timing in words: 10 ms steps within ±1000, earlier and later, the start delay, drift, the test', () => {
  assert.equal(snapOffset(123), 120);
  assert.equal(snapOffset(-2000), -1000);
  assert.equal(snapOffset(-4), 0);
  assert.equal(msWords(-40), '−40 ms');
  assert.equal(offsetWords(120), '+120 ms · earlier');
  assert.equal(offsetWords(-50), '−50 ms · later');
  assert.equal(offsetWords(0), '0 ms · in step');
  assert.equal(delayWords({ latencyMs: 1234, latencyN: 1 }), 'Measured start delay: 1.23 s (from 1 play)');
  assert.match(delayWords({ latencyMs: null, latencyN: 0 }), /not yet/);
  assert.equal(driftWords(15), 'Right now: in time');
  assert.equal(driftWords(-180), 'Right now: 180 ms behind (being lined up)');
  assert.equal(driftWords(null), null);
  const parts = [{ reference: true, name: 'Home speakers', listenWith: null }, { reference: false, name: 'Ray', listenWith: 'Kitchen speaker' }];
  assert.match(testSteps(parts)!, /Stand between Kitchen speaker and Ray/);
  assert.match(testSteps(parts)!, /Ray’s tick comes after the other, move Ray towards Earlier/);
  assert.equal(testSteps([parts[0]!]), null);
  assert.equal(testLeft(10_000 + 185_000, 10_000), '3:05 left');
  assert.equal(testLeft(5, 10), null);
});

test('a part’s title and line, and how a group plays', () => {
  const p = (o: Partial<GroupPart>): GroupPart => ({ key: 'k', kind: 'single', via: 'sonos', name: 'Ray', members: ['ray'], reference: false, offset: 0, latencyMs: null, latencyN: 0, driftMs: null, listenWith: null, ...o });
  const home = p({ key: 'cast:home', kind: 'native', via: 'cast', name: 'Home speakers', members: ['a', 'b', 'c'], reference: true });
  assert.equal(partTitle(home), 'Google Cast group “Home speakers”');
  assert.equal(partSub(home), '3 speakers, in perfect sync · the others follow it');
  assert.equal(partTitle(p({})), 'Ray (Sonos)');
  assert.equal(partSub(p({})), 'Played alongside');
  assert.equal(groupHow({ members: ['a', 'b', 'c', 'ray'], parts: [home, p({})] }), '“Home speakers” in perfect sync · Ray alongside');
  assert.equal(groupHow({ members: ['a', 'b'], parts: [home] }), '2 speakers as one stream, in perfect sync');
});
