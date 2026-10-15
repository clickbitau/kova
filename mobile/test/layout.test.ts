import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_MAX, RAIL_W, READ_MAX, columnsFor, layoutFor } from '../src/logic/layout.ts';

test('layout: a phone has the tab bar and its whole width; a tablet the side rail and a page that stops growing', () => {
  assert.deepEqual(layoutFor(390), { rail: false, content: 390 - 36 });
  assert.deepEqual(layoutFor(744), { rail: false, content: 744 - 36 }, 'an iPad mini in a split view is a phone');
  assert.deepEqual(layoutFor(820), { rail: true, content: 820 - RAIL_W - 36 });
  assert.deepEqual(layoutFor(1366), { rail: true, content: PAGE_MAX - 36 });
  assert.equal(layoutFor(1366, true).content, READ_MAX - 36, 'a settings page reads at a comfortable width');
  assert.equal(layoutFor(390, true).content, 390 - 36);
});

test('layout: columns fit the width and the text size, between the least and the most', () => {
  const tiles = (w: number, f = 1) => columnsFor(layoutFor(w).content, 170, f, { least: 2 });
  assert.equal(tiles(320), 2, 'two tiles on the smallest phone, as always');
  assert.equal(tiles(430), 2);
  assert.equal(tiles(430, 2), 2, 'large text never drops a phone to one tile');
  assert.equal(tiles(820), 3);
  assert.equal(tiles(1024), 4);
  assert.equal(tiles(1366), 4);
  assert.equal(tiles(1366, 1.6), 3, 'large text on a tablet: fewer, wider tiles');
});
