import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testHub } from './helpers.ts';

test('learns what "downstairs" means, then uses it', async () => {
  const { hub, dev } = await testHub(19);
  await hub.engine.tick(hub.engine.now() + 1);
  await hub.engine.command('kitchen_ceiling', { on: true });

  const r1 = await hub.assistant.ask('Turn off downstairs');
  assert.match(r1.text, /don’t know which rooms are “downstairs”/);

  const r2 = await hub.assistant.ask('downstairs is lounge, kitchen and laundry');
  assert.equal(r2.actions[0].action.type, 'learnGroup');
  await hub.assistant.act(r2.actions[0].action);
  assert.deepEqual(hub.config.get().groups.downstairs, ['lounge', 'kitchen', 'laundry']);

  const r3 = await hub.assistant.ask('turn off downstairs');
  assert.match(r3.text, /^Done\. Downstairs/);
  assert.equal(dev('kitchen_ceiling').on, false);
  await hub.stop();
});

test('explains why something is on and offers to turn it off', async () => {
  const { hub, advance } = await testHub(17.5);
  await advance(19);
  const r = await hub.assistant.ask('Why is the garage light on?');
  assert.match(r.text, /Light is on\. Evening started set this/);
  assert.equal(r.actions[0].label, 'Turn it off now');
  await hub.stop();
});

test('starts an overlay by name', async () => {
  const { hub } = await testHub(19);
  await hub.assistant.ask('Start Movie Mode');
  assert.equal(hub.engine.overlay?.id, 'movie');
  await hub.stop();
});
