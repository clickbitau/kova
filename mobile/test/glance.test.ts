import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertActions, glanceCards, glanceColumns, insightColor, shownAlerts } from '../src/logic/glance.ts';

test('glance cards: outside with today, inside as a range, the air worst first', () => {
  const cards = glanceCards({
    outside: { temp: 21, text: 'Sunny', icon: 'sunny', high: 22, low: 13, uvMax: 9, rain: null },
    inside: [{ name: 'Lounge', temp: 20.8, device: 'ac1' }, { name: 'Bedroom', temp: 23, device: 'ac2' }],
    air: [{ name: 'Lounge purifier', level: 3, label: 'Poor', device: 'p1' }, { name: 'Bedroom purifier', level: 1, label: 'Good', device: 'p2' }],
  });
  assert.deepEqual(cards.map(c => [c.label, c.value, c.caption, c.sub]), [
    ['Outside', '21°', 'Sunny', '22° / 13° today · UV 9 at midday'],
    ['Inside', '20.8–23°', '2 rooms', 'Lounge 20.8° · Bedroom 23°'],
    ['Air', 'Poor', 'Lounge purifier', 'Bedroom purifier: good'],
  ]);
  const one = glanceCards({ outside: null, inside: [{ name: 'Lounge', temp: 21, device: 'a' }], air: [{ name: 'Purifier', level: 1, label: 'Good', device: 'p' }] });
  assert.deepEqual(one.map(c => [c.value, c.caption, c.sub]), [['21°', 'Lounge', 'Lounge 21°'], ['Good', 'Purifier', '']]);
  assert.equal(glanceCards({ outside: { temp: 18, text: 'Rain', icon: 'rainy', rain: 'Might rain soon (2 mm)' }, inside: [], air: [] })[0].sub, 'Might rain soon (2 mm)');
  assert.deepEqual(glanceCards(undefined), []);
  assert.equal(insightColor('alert'), '#ff6b5e');
});

test('glance cards: three to a row on a 375 pt phone, two on a small one or with large text', () => {
  assert.equal(glanceColumns(390, 1, 3), 3);
  assert.equal(glanceColumns(375, 1, 3), 3);
  assert.equal(glanceColumns(320, 1, 3), 2);
  assert.equal(glanceColumns(390, 1.3, 3), 2);
  assert.equal(glanceColumns(430, 1, 2), 2);
  assert.equal(glanceColumns(320, 1, 1), 1);
});

test('alerts: Open only for a device; the first two in full and the rest folded, unless only one would fold', () => {
  assert.deepEqual(alertActions({ device: 'x' }), ['open', 'later', 'expected']);
  assert.deepEqual(alertActions({}), ['later', 'expected']);
  assert.deepEqual(shownAlerts([1, 2, 3], false), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(shownAlerts([1, 2, 3, 4, 5], false), { shown: [1, 2], more: 3 });
  assert.deepEqual(shownAlerts([1, 2, 3, 4, 5], true), { shown: [1, 2, 3, 4, 5], more: 0 });
  assert.deepEqual(shownAlerts([], false), { shown: [], more: 0 });
});
