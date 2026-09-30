import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';

const webRoot = resolve(import.meta.dirname, '../../web');

test('Speaker groups: make one, play to it, every speaker plays; volume, stop, delete', async () => {
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot });
  try {
    const call = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload: payload ?? {} });
    // Validation: at least two speakers, and only speakers.
    assert.equal((await call('POST', '/api/speaker-groups', { name: 'Upstairs', members: ['master_speaker'] })).statusCode, 400);
    assert.match((await call('POST', '/api/speaker-groups', { name: 'Upstairs', members: ['master_speaker', 'lamp'] })).json().error, /can’t be in a speaker group/);

    const r = await call('POST', '/api/speaker-groups', { name: 'Upstairs', members: ['master_speaker', 'baby_speaker', 'bedroom_tv'] });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().deviceId, 'group_upstairs');
    const g = t.hub.reg.get('group_upstairs')!;
    assert.equal(g.type, 'media');
    assert.equal(g.name, 'Upstairs');
    assert.equal(g.room, 'unassigned', 'members are in different rooms');

    // Play to the group: all three play the same thing, logged with why.
    await t.hub.reg.command('group_upstairs', { on: true, media: 'Rain sounds', vol: 25 }, { kind: 'user', label: 'You' });
    for (const id of ['master_speaker', 'baby_speaker', 'bedroom_tv']) {
      assert.equal(t.dev(id).media, 'Rain sounds', id);
      assert.equal(t.dev(id).vol, 25, id);
    }
    const why = t.hub.store.feed(30).find(e => e.device === 'baby_speaker' && e.kind === 'state');
    assert.equal(why!.cause.detail, 'through Upstairs');
    assert.deepEqual({ on: t.dev('group_upstairs').on, media: t.dev('group_upstairs').media }, { on: true, media: 'Rain sounds' });

    // A member changed on its own: the group follows (mixed), without an Activity entry of its own.
    await t.hub.reg.command('bedroom_tv', { media: 'Radio' }, { kind: 'user', label: 'You' });
    assert.equal(t.dev('group_upstairs').media, 'Mixed');
    assert.ok(!t.hub.store.feed(50).some(e => e.device === 'group_upstairs' && e.cause.kind === 'device'), 'derived state is quiet');

    await t.hub.reg.command('group_upstairs', { vol: 40 }, { kind: 'user', label: 'You' });
    assert.deepEqual(['master_speaker', 'baby_speaker', 'bedroom_tv'].map(id => t.dev(id).vol), [40, 40, 40]);
    await t.hub.reg.command('group_upstairs', { on: false, media: null }, { kind: 'user', label: 'You' });
    assert.equal(t.dev('master_speaker').on, false);
    assert.equal(t.dev('group_upstairs').on, false);

    // The snapshot says how it syncs (the demo speakers aren't a Cast group, so they start together).
    const st = (await app.inject({ method: 'GET', url: '/api/state' })).json();
    const sg = st.speakerGroups.find((x: { id: string }) => x.id === 'upstairs');
    assert.equal(sg.sync, 'together');
    assert.equal(st.devices.some((d: { id: string }) => d.id === 'group_upstairs'), true);

    // Rename, change members, then delete: the device goes too.
    await call('PUT', '/api/speaker-groups/upstairs', { name: 'Bedrooms', members: ['master_speaker', 'baby_speaker'], room: 'master' });
    assert.equal(t.hub.reg.get('group_upstairs')!.name, 'Bedrooms');
    assert.equal(t.hub.reg.get('group_upstairs')!.room, 'master');
    const del = await call('DELETE', '/api/speaker-groups/upstairs');
    assert.equal(del.statusCode, 200);
    assert.equal(t.hub.reg.get('group_upstairs'), undefined);
    // Undo brings it back.
    await call('POST', `/api/undo/${del.json().undo}`);
    assert.ok(t.hub.reg.get('group_upstairs'));
  } finally { await app.close(); await t.hub.stop(); }
});
