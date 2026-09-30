import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub } from './helpers.ts';

test('finds a light that one mode turns on and nothing turns off before night', async () => {
  const { hub } = await testHub(12);
  const f = hub.checker.findings().find(x => x.id.startsWith('stays-on:kitchen_ceiling'));
  assert.ok(f, 'kitchen ceiling finding');
  assert.equal(f.id, 'stays-on:kitchen_ceiling:wind');
  assert.match(f.title, /Kitchen ceiling stays on all night/);
  // The lamp is deliberately dimmed by Wind down, so it isn't flagged.
  assert.ok(!hub.checker.findings().some(x => x.id.includes(':lamp:')));

  const undo = hub.checker.fix(f.id);
  assert.deepEqual(hub.config.get().modes.find(m => m.id === 'wind')!.targets.kitchen_ceiling, { on: false });
  assert.ok(!hub.checker.findings().some(x => x.id === f.id));
  undo();
  assert.ok(hub.checker.findings().some(x => x.id === f.id));
  await hub.stop();
});

test('replays history: lights switched on for an empty house', async () => {
  const { hub, advance } = await testHub(17);
  await hub.engine.setPresence('methel', false);
  await hub.engine.setPresence('brishti', false);
  await advance(18.5);
  const f = hub.checker.findings().find(x => x.id === 'empty-house:evening');
  assert.ok(f);
  assert.match(f.body, /lit an empty house on 1 day/);
  const t = hub.checker.test('evening');
  assert.equal(t.days.at(-1), 'problem');
  assert.equal(t.days.filter(d => d === 'none').length, 13);

  hub.checker.fix(f.id);
  assert.equal(hub.config.get().modes.find(m => m.id === 'evening')!.onlyWhenSomeoneHome, true);
  assert.ok(!hub.checker.findings().some(x => x.id === 'empty-house:evening'));
  await hub.stop();
});

test('dismissed findings stay dismissed', async () => {
  const { hub } = await testHub(12);
  hub.checker.dismiss('stays-on:kitchen_ceiling:wind');
  assert.ok(!hub.checker.findings().some(x => x.id === 'stays-on:kitchen_ceiling:wind'));
  await hub.stop();
});
