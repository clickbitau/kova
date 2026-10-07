import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHome, calls, fakeModel, lastResults, say } from './ask-helpers.ts';

// Ask Kova's AI acts with the asker's role, never more: a child's or a guest's ask can't reach past what their
// account may do, whatever the model sends — and what it's told about the home is only what they may use.

async function member(h: Awaited<ReturnType<typeof askHome>>, invite: Record<string, unknown>) {
  const inv = (await h.app.inject({ method: 'POST', url: '/api/invites', payload: invite })).json();
  const r = await h.app.inject({ method: 'POST', url: '/api/invite/accept', payload: { code: inv.code, device: 'Phone' } });
  assert.equal(r.statusCode, 200, r.body);
  const { token, personId } = r.json() as { token: string; personId: string };
  const ask = async (text: string) => (await h.app.inject({ method: 'POST', url: '/api/ask', headers: { authorization: `Bearer ${token}` }, payload: { text } })).json();
  return { token, personId, ask };
}

test('a child’s ask: the AI’s tools refuse other rooms, automations, modes and settings', async () => {
  const sent: any[] = [];
  const model = await fakeModel([
    (body: any) => { sent.push(body); return calls(
      ['set_devices', { devices: [{ id: 'kitchen_ceiling', on: true }, { id: 'baby_light', on: true }] }],
      ['create_automation', { name: 'Kitchen at 7', when: [{ kind: 'time', at: '07:00' }], then: [{ kind: 'set', targets: { kitchen_ceiling: { on: true } } }] }],
      ['start_overlay', { id: 'party' }],
      ['rename_room', { room: 'baby', name: 'My den' }],
    ); },
    (body: any) => { sent.push(body); return say('Done what I could.'); },
  ]);
  const h = await askHome({ tweak: c => { c.automations = []; } });
  try {
    await h.useModel(model.url);
    const kid = await member(h, { role: 'child', name: 'Kid', rooms: ['baby'] });
    const r = await kid.ask('sort out the usual evening stuff for me please');
    const results = lastResults(sent[1]);
    // set_devices: the kitchen isn't theirs, so to the AI it doesn't exist; their own light is switched.
    assert.match(JSON.stringify(results[0]), /kitchen_ceiling/, JSON.stringify(results[0]));
    assert.equal(h.hub.reg.get('kitchen_ceiling')!.state.on, false);
    assert.equal(h.hub.reg.get('baby_light')!.state.on, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].error, /automations/);
    assert.equal(results[2].ok, false);
    assert.match(results[2].error, /modes/);
    assert.equal(results[3].ok, false);
    assert.equal(h.hub.engine.overlay, null);
    assert.deepEqual(h.hub.config.get().automations, []);
    assert.equal(h.hub.config.get().rooms.find(x => x.id === 'baby')!.name, 'Baby room');
    assert.ok(r.text);
    // What the model was told about the home: only the child's rooms and devices, and who's asking.
    const system = sent[0].messages[0].content as string;
    assert.match(system, /The person asking: Kid \(child; they can control only the devices listed below; refuse anything else\)/);
    assert.ok(!/kitchen_ceiling/.test(system), 'no kitchen devices in the context');
    assert.ok(/baby_light/.test(system));
  } finally { await h.close(); await model.close(); }
});

test('a guest’s ask: only their devices; an adult’s: automations, but no integrations; "remind me" reaches only them', async () => {
  const sent: any[] = [];
  const model = await fakeModel((body: any, round: number) => {
    sent.push(body);
    if (round === 0) return calls(['set_devices', { devices: [{ id: 'guest_speaker', on: true }] }], ['set_devices', { devices: [{ id: 'doorbell', on: true }] }]);
    if (round === 1) return say('ok');
    if (round === 2) return calls(['create_automation', { name: 'Bins', when: [{ kind: 'time', at: '21:00' }], then: [{ kind: 'notify', message: 'Put the bins out', people: ['me'] }] }]);
    return say('ok');
  });
  const h = await askHome({ tweak: c => { c.automations = []; } });
  try {
    await h.useModel(model.url);
    const guest = await member(h, { role: 'guest', name: 'Visitor', rooms: ['guest'] });
    await guest.ask('play something in my room and turn on the doorbell');
    const res = lastResults(sent[1]);
    assert.equal(res[0].ok, true);
    assert.equal(h.hub.reg.get('guest_speaker')!.state.on, true);
    assert.equal(res[1].ok, false, 'a camera is never a guest’s');

    const sam = await member(h, { role: 'adult', name: 'Sam' });
    await sam.ask('remind me every night at 9 to put the bins out');
    const a = (h.hub.config.get().automations ?? []).find(x => x.name === 'Bins');
    assert.ok(a, JSON.stringify(lastResults(sent[3])));
    assert.deepEqual((a!.actions[0] as { people?: string[] }).people, [sam.personId]);
    // The adult still can't change Ask Kova's own settings (an owner's), with or without the AI.
    const r = await h.app.inject({ method: 'PUT', url: '/api/assistant/settings', headers: { authorization: `Bearer ${sam.token}` }, payload: { engine: 'builtin' } });
    assert.equal(r.statusCode, 403);
  } finally { await h.close(); await model.close(); }
});

test('a learned phrase replays only for someone whose role can do it', async () => {
  const model = await fakeModel([calls(['start_overlay', { id: 'party' }]), say('Party on.'), say('no')]);
  const h = await askHome();
  try {
    await h.useModel(model.url);
    // The owner (no key on this hub) teaches it.
    const owner = await h.ask('get this party started please');
    assert.equal(h.hub.engine.overlay?.id, 'party', owner.text);
    await h.hub.engine.endOverlay('user');
    const kid = await member(h, { role: 'child', name: 'Kid', rooms: ['baby'] });
    const r = await kid.ask('get this party started please');
    assert.equal(h.hub.engine.overlay, null, r.text);
    assert.notEqual(r.source, 'Learned · no AI needed');
  } finally { await h.close(); await model.close(); }
});
