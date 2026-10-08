import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefRows, prefShort, type NotifyPrefsView } from '../src/logic/notify-prefs.ts';

test('notification choices: in words, by group, off-for-everyone said, the household’s for the owner', () => {
  assert.deepEqual(['on', 1, 6, 24, 'off', undefined].map(v => prefShort(v as never)), ['Every time', 'Hourly at most', 'Every 6 h at most', 'Daily at most', 'Never', 'Every time']);
  const v: NotifyPrefsView = {
    who: 'sam', name: 'Sam Lee', canHousehold: true, offForAll: ['newDevice'],
    choices: [], prefs: { doorbell: 'on', threats: 6, newDevice: 'on' }, household: { doorbell: 'off', threats: 24, newDevice: 'on' },
    kinds: [
      { id: 'doorbell', label: 'Doorbell rings', help: '', icon: 'doorbell', group: 'home' },
      { id: 'threats', label: 'Attacks Warden blocked', help: '', icon: 'shield', group: 'network' },
      { id: 'newDevice', label: 'New devices', help: '', icon: 'devices', group: 'network' },
    ],
  };
  const mine = prefRows(v);
  assert.deepEqual(mine.map(g => g.title), ['The home', 'The network'], 'groups with nothing in them are left out');
  assert.deepEqual(mine[1]!.rows.map(r => [r.id, r.short, r.off]), [['threats', 'Every 6 h at most', false], ['newDevice', 'Off for everyone', true]]);
  assert.deepEqual(prefRows(v, true)[0]!.rows.map(r => r.short), ['Never']);
});
