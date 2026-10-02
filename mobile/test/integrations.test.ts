import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionButton, addable, blankRow, codeFromPaste, describeHubUpdate, describeResult, entries, errorLines, fromForm, isLocked, nounOf,
  optionsFor, pairWords, planActions, pollsAfter, problems, rowSummary, savedWords, segmentable, setIn, statusOf, toForm, SECRET,
  type CatalogItem, type Field, type Form, type HubUpdate,
} from '../src/logic/integrations.ts';

const room: Field = { key: 'room', label: 'Room', type: 'select', options: 'rooms', required: true };
const home = { rooms: [{ id: 'lounge', name: 'Lounge' }, { id: 'den', name: 'Den' }], people: [{ id: 'sam', name: 'Sam' }] };

const tuya: Field[] = [{
  key: 'devices', label: 'Devices', type: 'list', addLabel: 'Add device', required: true,
  item: [
    { key: 'id', label: 'Device id', type: 'text', required: true },
    { key: 'host', label: 'IP address', type: 'text' },
    { key: 'key', label: 'Local key', type: 'password', required: true },
    { key: 'switches', label: 'Channels', type: 'list', shape: 'map', mapKey: 'dp', addLabel: 'Add channel', item: [
      { key: 'dp', label: 'DP', type: 'number', required: true }, { key: 'name', label: 'Name', type: 'text', required: true }, room,
    ] },
  ],
}];

test('a saved section becomes form state and comes back the same, secrets still "••••" for the hub to keep', () => {
  const saved = { devices: [{ id: 'bf1', host: '192.0.2.5', key: SECRET, hasKey: true, switches: { 1: { name: 'Lamp', room: 'lounge' } } }], pollMs: 5000 };
  const form = toForm(tuya, saved);
  const dev = (form.devices as Form[])[0];
  assert.equal(dev.key, SECRET);
  assert.deepEqual(dev.switches, [{ dp: '1', name: 'Lamp', room: 'lounge' }]);
  const back = fromForm(tuya, form);
  assert.deepEqual(back, { devices: [{ id: 'bf1', host: '192.0.2.5', key: SECRET, hasKey: true, switches: { 1: { name: 'Lamp', room: 'lounge' } } }], pollMs: 5000 });
});

test('a map with a single value field (speaker → room) round-trips through rows', () => {
  const f: Field[] = [{ key: 'rooms', label: 'Rooms', type: 'list', shape: 'map', mapKey: 'name', mapValue: 'room', item: [{ key: 'name', label: 'Speaker', type: 'text', required: true }, room] }];
  const form = toForm(f, { rooms: { 'Kitchen speaker': 'lounge' } });
  assert.deepEqual(form.rooms, [{ name: 'Kitchen speaker', room: 'lounge' }]);
  const more = setIn(form, ['rooms', 1], { name: ' Den speaker ', room: 'den' });
  assert.deepEqual(fromForm(f, more), { rooms: { 'Kitchen speaker': 'lounge', 'Den speaker': 'den' } });
  // A row without its key is skipped; an empty map is left out altogether.
  assert.deepEqual(fromForm(f, { rooms: [{ name: '', room: 'den' }] }), {});
});

test('blanks are dropped, numbers become numbers, comma lists become arrays, nested keys nest', () => {
  const f: Field[] = [
    { key: 'host', label: 'Host', type: 'text' }, { key: 'port', label: 'Port', type: 'number' },
    { key: 'hosts', label: 'Hosts', type: 'text', multiple: true }, { key: 'opnsense.url', label: 'URL', type: 'text' }, { key: 'opnsense.key', label: 'Key', type: 'password' },
    { key: 'extra', label: 'Extra', type: 'list', item: [{ key: 'a', label: 'A', type: 'text' }] },
  ];
  const form = toForm(f, { hosts: ['a', 'b'], port: 502, opnsense: { url: 'https://x' } });
  assert.equal(form.hosts, 'a, b');
  assert.equal(form.port, '502');
  assert.deepEqual(fromForm(f, { ...form, host: '  ', hosts: 'a, , c ', port: ' 503 ' }), { hosts: ['a', 'c'], port: 503, opnsense: { url: 'https://x' } });
  assert.deepEqual(fromForm(f, { ...form, opnsense: { url: '', key: '' } }), { hosts: ['a', 'b'], port: 502 });
});

test('a required list stays even when empty, so the hub can say what is missing', () => {
  assert.deepEqual(fromForm(tuya, { devices: [] }), { devices: [] });
});

test('new rows start blank with their nested lists empty', () => {
  assert.deepEqual(blankRow(tuya[0]), { id: '', host: '', key: '', switches: [] });
});

test('a stored secret shows as locked until it is changed', () => {
  const pw: Field = { key: 'password', label: 'Password', type: 'password' };
  assert.equal(isLocked(pw, SECRET), true);
  assert.equal(isLocked(pw, 'typed'), false);
  assert.equal(isLocked({ ...pw, type: 'text' }, SECRET), false);
});

test('what still has to be filled in, with paths into lists, and two map rows with the same key', () => {
  const form: Form = { devices: [{ id: 'x', key: '', host: '', switches: [{ dp: 'one', name: 'A', room: 'lounge' }, { dp: '1', name: '', room: '' }, { dp: '1', name: 'B', room: 'den' }] }] };
  const p = problems(tuya, form).map(x => `${x.path.join('/')}: ${x.message}`);
  assert.deepEqual(p, [
    'devices/0/key: Local key is needed',
    'devices/0/switches/0/dp: A number',
    'devices/0/switches/1/name: Name is needed',
    'devices/0/switches/1/room: Room is needed',
    'devices/0/switches/2/dp: Already in the list above',
  ]);
  assert.deepEqual(problems(tuya, { devices: [] }).map(x => x.message), ['Add at least one device']);
  assert.deepEqual(problems(tuya, { devices: [{ id: 'x', key: SECRET, host: '', switches: [] }] }), []);
});

test('options: rooms and people from the home, segmented only for a few short ones', () => {
  assert.deepEqual(optionsFor(room, home), [{ value: 'lounge', label: 'Lounge' }, { value: 'den', label: 'Den' }]);
  assert.deepEqual(optionsFor({ key: 'p', label: 'P', type: 'select', options: 'people' }, home), [{ value: 'sam', label: 'Sam' }]);
  assert.equal(segmentable([{ value: '3.3', label: '3.3' }, { value: '3.4', label: '3.4' }, { value: '3.5', label: '3.5' }]), true);
  assert.equal(segmentable([{ value: 'us', label: 'US, Australia, Asia' }, { value: 'eu', label: 'Europe' }]), false);
  assert.equal(segmentable([{ value: 'a', label: 'A' }]), false);
});

test('a folded row says what it is', () => {
  const f: Field = { key: 'tvs', label: 'TVs', type: 'list', addLabel: 'Add TV', item: [{ key: 'host', label: 'IP', type: 'text' }, room, { key: 'name', label: 'Name', type: 'text' }] };
  assert.equal(rowSummary(f, { host: '192.0.2.40', room: 'den', name: '' }, home), '192.0.2.40 · Den');
  assert.equal(nounOf(f), 'TV');
  assert.equal(nounOf({ ...f, addLabel: 'Add a plug' }), 'Plug');
  assert.equal(nounOf({ ...f, addLabel: 'Put a box in a room' }), 'Put a box in a room');
});

test('a pasted sign-in address gives its code; a bare code stays as it is', () => {
  assert.equal(codeFromPaste(' https://example.com/callback?state=x&code=4%2F0AbC-d&scope=y '), '4/0AbC-d');
  assert.equal(codeFromPaste('https://example.com/#code=abc'), 'abc');
  assert.equal(codeFromPaste('abc123'), 'abc123');
});

const act = (id: string, method: 'GET' | 'POST', path: string, extra: Partial<CatalogItem['actions'] & object> = {}) => ({ id, label: id, icon: 'link', method, path, ...extra });

test('actions: sign-in then code as two steps; pairing first; finding and showing after the settings', () => {
  const smart = planActions({ actions: [
    act('create', 'POST', '/x/create-app', { opensUrl: true, fields: [{ key: 'token', label: 'Token', type: 'password' }] }),
    act('link', 'GET', '/x/auth-url', { opensUrl: true }),
    act('code', 'POST', '/x/auth-code', { fields: [{ key: 'code', label: 'Code', type: 'text', required: true }] }),
  ] as never });
  assert.deepEqual(smart.signIn?.open.map(a => a.id), ['create', 'link']);
  assert.equal(smart.signIn?.finish?.id, 'code');
  assert.deepEqual(smart.connect, []);
  const warden = planActions({ actions: [act('pair', 'POST', '/w/pair'), act('link', 'POST', '/w/link'), act('clients', 'GET', '/w/clients')] as never });
  assert.equal(warden.signIn, null);
  assert.deepEqual(warden.connect.map(a => a.id), ['pair', 'link']);
  assert.deepEqual(warden.tools.map(a => a.id), ['clients']);
  const cast = planActions({ actions: [act('find', 'POST', '/c/find')] as never });
  assert.deepEqual(cast.tools.map(a => a.id), ['find']);
});

test('action buttons say what happens', () => {
  assert.deepEqual(actionButton(act('link', 'GET', '/a', { opensUrl: true }) as never), { label: 'Open sign-in', icon: 'open_in_new' });
  assert.equal(actionButton({ ...act('code', 'GET', '/b'), label: 'Show pairing code' } as never).label, 'Show pairing code');
  assert.equal(actionButton({ ...act('clients', 'GET', '/b'), label: 'Devices on your network' } as never).label, 'Show devices on your network');
});

test('pairing that finishes elsewhere is watched until it is approved', () => {
  assert.equal(pollsAfter(act('pair', 'POST', '/api/integrations/helix/pair') as never, { code: '123456', next: '…' }), true);
  assert.equal(pollsAfter(act('pair', 'POST', '/api/integrations/samsungtv/pair') as never, { tvs: [], ok: true }), false);
  assert.equal(pairWords('approved').tone, 'ok');
  assert.equal(pairWords('pending').tone, 'wait');
  assert.equal(pairWords('denied').tone, 'bad');
});

test('an action’s answer: the sentence, a code large, the rest as rows', () => {
  const r = describeResult({ ok: true, code: '4711', next: 'Type it in Helix.' });
  assert.equal(r.headline, 'Type it in Helix.');
  assert.equal(r.code, '4711');
  assert.deepEqual(r.rows, []);
  const d = describeResult({ devices: [{ name: 'Tablet' }, { name: 'Phone' }], added: 2, paired: false });
  assert.deepEqual(d.rows.map(x => [x.label, x.value]), [['Devices', 'Tablet\nPhone'], ['Added', '2'], ['Paired', 'No']]);
  assert.match(describeResult({ enabled: false }).headline ?? '', /Not running/);
  assert.equal(describeResult({ ok: true }).headline, 'Done.');
});

const catalog = [
  { id: 'cast', name: 'Google Cast', icon: 'cast', kind: 'Local', description: 'Speakers on your network', fields: [], apply: 'hot' },
  { id: 'connectlife', name: 'Hisense ConnectLife', icon: 'ac_unit', kind: 'Cloud', description: 'Air conditioners', fields: [], apply: 'hot' },
  { id: 'aircast', name: 'AirPlay to Cast speakers', icon: 'airplay', kind: 'Local', description: 'Cast in AirPlay', fields: [], apply: 'restart' },
  { id: 'tapo', name: 'TP-Link Tapo', icon: 'outlet', kind: 'Local', description: 'Plugs', fields: [], apply: 'hot' },
] as CatalogItem[];

test('the list: what needs attention first, saved-but-idle ones included, then by name', () => {
  const live = [
    { id: 'cast', name: 'Google Cast', icon: 'cast', kind: 'Local', ok: true, devices: 4 },
    { id: 'virtual', name: 'Demo', icon: 'science', kind: 'Local', ok: true, devices: 9 },
    { id: 'tapo', name: 'TP-Link Tapo', icon: 'outlet', kind: 'Local', ok: false, note: 'Sign-in refused', devices: 2 },
  ];
  const e = entries(live, { cast: {}, tapo: {}, aircast: {} }, catalog);
  assert.deepEqual(e.map(x => x.id), ['aircast', 'tapo', 'virtual', 'cast']);
  assert.equal(e[0].note, 'Saved. Starts when the hub restarts');
  assert.equal(e.find(x => x.id === 'virtual')?.configurable, false);
});

test('a bridge the hub lists under its own id counts as its section', () => {
  const live = [{ id: 'matter-bridge', name: 'Matter bridge', icon: 'hub', kind: 'Local', ok: true, note: 'Not paired yet', devices: 3 }];
  const cat = [...catalog, { id: 'matterBridge', name: 'Matter bridge', icon: 'hub', kind: 'Local', description: '', fields: [], apply: 'restart' }] as CatalogItem[];
  const e = entries(live, { matterBridge: {} }, cat);
  assert.deepEqual(e.map(x => [x.id, x.ok, x.idle, x.configurable]), [['matterBridge', true, false, true]]);
  assert.equal(addable(cat, {}, live).some(c => c.id === 'matterBridge'), false);
  assert.equal(statusOf('matterBridge', live, true, cat[4]).title, 'Connected');
});

test('the add picker leaves out what is set up or running, and searches names and descriptions', () => {
  const live = [{ id: 'cast', name: 'Google Cast', icon: 'cast', kind: 'Local', ok: true, devices: 4 }];
  assert.deepEqual(addable(catalog, { tapo: {} }, live).map(c => c.id), ['aircast', 'connectlife']);
  assert.deepEqual(addable(catalog, {}, live, 'air cond').map(c => c.id), ['connectlife']);
  assert.deepEqual(addable(catalog, {}, live, 'cloud').map(c => c.id), ['connectlife']);
});

test('the status at the top of a setup screen', () => {
  const live = [{ id: 'tapo', name: 'Tapo', icon: 'outlet', kind: 'Local', ok: false, note: 'Sign-in refused', devices: 0 }];
  assert.deepEqual(statusOf('tapo', live, true, catalog[3]), { tone: 'warn', title: 'Needs attention', text: 'Sign-in refused' });
  assert.equal(statusOf('cast', [{ ...live[0], id: 'cast', ok: true, note: '', devices: 1 }], true, catalog[0]).text, '1 device');
  assert.equal(statusOf('aircast', [], true, catalog[2]).text, 'It starts when the hub restarts.');
  assert.equal(statusOf('connectlife', [], false, catalog[1]).tone, 'idle');
  const linkOnly = { ...catalog[1], actions: [{ id: 'link', label: 'Link', icon: 'link', method: 'GET', path: '/x', opensUrl: true }] } as CatalogItem;
  assert.equal(statusOf('connectlife', [], false, linkOnly).text, 'Link your account below to start.');
});

test('after saving, and the hub’s errors one per line', () => {
  assert.equal(savedWords({ applied: false, restartRequired: true }, true).text, 'Saved. Restart the hub to start it.');
  assert.deepEqual(savedWords({ applied: true, status: { ok: false, note: 'Sign-in refused' } }, false), { ok: false, text: 'Saved, but it isn’t working yet: Sign-in refused' });
  assert.deepEqual(errorLines('Device 1: Local key is required. Device 2: IP address must be text.'), ['Device 1: Local key is required', 'Device 2: IP address must be text']);
});

test('the hub’s own update card', () => {
  const u: HubUpdate = { updater: true, state: 'idle', source: 'release', note: null, current: { version: '0.7.1' }, available: { version: '0.7.2', behind: 3, changes: ['a', 'b'] }, checkedAt: 0, checkError: null, last: null, auto: { on: true, hour: 3 },
    licence: { hubId: 'H1', installed: true, activated: true, edition: 'Home', key: '…ab12', error: null } };
  const d = describeHubUpdate(u, 60_000);
  assert.equal(d.title, 'Kova 0.7.2 is available');
  assert.equal(d.canUpdate, true);
  assert.equal(d.licence, 'Licence …ab12 · Home');
  assert.match(d.auto, /03:00/);
  const none = describeHubUpdate({ ...u, available: null, updater: false }, 0);
  assert.equal(none.canCheck, false);
  assert.match(none.sub, /updater/);
});
