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
  assert.match(r.text, /^Garage light is on\. Evening started set this/);
  assert.equal(r.source, 'From the activity log');
  assert.equal(r.actions[0].label, 'Turn it off now');
  await hub.stop();
});

test('starts an overlay by name', async () => {
  const { hub } = await testHub(19);
  await hub.assistant.ask('Start Movie Mode');
  assert.equal(hub.engine.overlay?.id, 'movie');
  await hub.stop();
});

test('brightness, who is home, tonight, leaving and arriving', async () => {
  const { hub, dev } = await testHub(19.5);
  const r1 = await hub.assistant.ask('lamp to 30%');
  assert.equal(r1.source, 'Device control');
  assert.equal(dev('lamp').bri, 30);
  assert.deepEqual(hub.assistant.chips(hub.assistant.parse('dim the lounge lamp to 20')), ['Set to 20%', 'Lounge lamp', '1 device']);

  await hub.engine.setPresence('brishti', false);
  const r2 = await hub.assistant.ask('Who’s home?');
  assert.equal(r2.text, 'Methel is home. Brishti is out.');

  const r3 = await hub.assistant.ask("What's happening tonight?");
  assert.equal(r3.source, 'From your modes');
  assert.match(r3.text, /^20:00 Wind down/);

  await hub.assistant.ask("I'm leaving");
  assert.equal(hub.engine.overlay?.id, 'away');
  await hub.assistant.ask("I'm home");
  assert.equal(hub.engine.overlay, null);
  await hub.stop();
});

test('understood chips preview a command without running it', async () => {
  const { hub, dev } = await testHub(12);
  const i = hub.assistant.parse('turn on the kitchen lights');
  assert.deepEqual(hub.assistant.chips(i), ['Turn on', 'Kitchen lights', '3 devices']);
  assert.equal(dev('kitchen_ceiling').on, false, 'parse alone changes nothing');
  const r = await hub.assistant.ask('make me a sandwich');
  assert.equal(r.understood, false);
  assert.equal(r.source, 'Built-in · nothing left your home');
  await hub.stop();
});
