import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinNames, locationPlan } from '../src/logic/presence.ts';

test('when Warden (or the router) already knows, location is not needed', () => {
  const p = locationPlan({ name: 'Sam', via: ['Warden'] });
  assert.equal(p.needed, false);
  assert.equal(p.by, 'Warden');
  assert.equal(p.text, 'Warden already tells Kova when you’re home. Location isn’t needed.');
  assert.equal(locationPlan({ name: 'Sam', via: ['your router', 'a network check'] }).text, 'Your router and a network check already tell Kova when you’re home. Location isn’t needed.');
  assert.match(locationPlan({ name: 'Sam', via: ['Warden'] }, false).text, /when Sam’s home/);
});

test('with nothing else, or an older hub that doesn’t say, location is how Kova knows', () => {
  for (const person of [{ name: 'Sam', via: [] }, { name: 'Sam' }, { name: 'Sam', via: ['', '  '] }]) {
    const p = locationPlan(person);
    assert.equal(p.needed, true);
    assert.equal(p.by, null);
    assert.match(p.text, /location tells Kova when you get home or go out/);
  }
  assert.match(locationPlan({ name: 'Sam' }, false).text, /when Sam gets home or goes out/);
});

test('no person chosen yet: location is the plan, once they choose', () => {
  assert.deepEqual(locationPlan(undefined), { needed: true, by: null, text: 'Choose whose phone this is first.' });
});

test('names join like a sentence', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Warden']), 'Warden');
  assert.equal(joinNames(['Warden', 'your router', 'a network check']), 'Warden, your router and a network check');
});
