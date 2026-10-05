import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glanceCards, insightColor } from '../src/logic/glance.ts';

test('glance cards: outside with today, inside as a range, the air worst first', () => {
  const cards = glanceCards({
    outside: { temp: 21, text: 'Sunny', icon: 'sunny', high: 22, low: 13, uvMax: 9, rain: null },
    inside: [{ name: 'Lounge', temp: 20.8, device: 'ac1' }, { name: 'Bedroom', temp: 23, device: 'ac2' }],
    air: [{ name: 'Lounge purifier', level: 3, label: 'Poor', device: 'p1' }, { name: 'Bedroom purifier', level: 1, label: 'Good', device: 'p2' }],
  });
  assert.deepEqual(cards.map(c => [c.label, c.value, c.sub]), [
    ['Outside', '21° sunny', '22° / 13° today · UV 9 at midday'],
    ['Inside', '20.8–23°', 'Lounge 20.8° · Bedroom 23°'],
    ['Air', 'Poor', 'Lounge purifier: poor · Bedroom purifier: good'],
  ]);
  assert.equal(glanceCards({ outside: { temp: 18, text: 'Rain', icon: 'rainy', rain: 'Might rain soon (2 mm)' }, inside: [], air: [] })[0].sub, 'Might rain soon (2 mm)');
  assert.deepEqual(glanceCards(undefined), []);
  assert.equal(insightColor('alert'), '#ff6b5e');
});
