import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testHub } from './helpers.ts';
import { buildServer } from '../src/api/server.ts';
import { Notifier } from '../src/services/notify.ts';
import { Presence } from '../src/services/presence.ts';
import { INVITE_MS } from '../src/services/accounts.ts';

// Household accounts: invites, roles on every route that matters, identity in Activity, notifications and presence,
// managing members, and keeping the keys from before accounts working as the owner's.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const MASTER = 'master-key-for-tests-0123456789abcdef';

async function fakeExpo() {
  const to: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const msgs = JSON.parse(raw) as { to: string }[];
      to.push(...msgs.map(m => m.to));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }));
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, to, close: () => new Promise<void>(ok => server.close(() => ok())) };
}

async function home(seed?: (h: Awaited<ReturnType<typeof testHub>>['hub']) => void) {
  const t = await testHub(12);
  seed?.(t.hub);
  const expo = await fakeExpo();
  const notifier = new Notifier(t.hub, { expo: { url: expo.url } }, { dataDir: mkdtempSync(join(tmpdir(), 'kova-acct-')) });
  const presence = new Presence(t.hub, {});
  const app = await buildServer(t.hub, { webRoot, token: MASTER, notifier, presence });
  const call = (key: string | null, method: string, url: string, payload?: unknown, ip?: string) =>
    app.inject({ method: method as 'GET', url, headers: key ? { authorization: `Bearer ${key}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}), ...(ip ? { remoteAddress: ip } : {}) });
  /** Invite someone and accept it on their device: their key and person. */
  const join_ = async (invite: Record<string, unknown>, accept: Record<string, unknown>) => {
    const inv = await call(MASTER, 'POST', '/api/invites', invite);
    assert.equal(inv.statusCode, 200, inv.body);
    const r = await call(null, 'POST', '/api/invite/accept', { code: inv.json().code, device: 'Test phone', ...accept });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { token: string; personId: string; role: string; name: string };
  };
  const close = async () => { await app.close(); await t.hub.stop(); await expo.close(); };
  return { ...t, app, call, join: join_, notifier, presence, expo, close };
}

test('an invite: a link and QR with a one-time code, picked or new person, a key of their own kept as a hash', async () => {
  const h = await home();
  try {
    // Only the owner invites.
    let r = await h.call(MASTER, 'POST', '/api/invites', { role: 'adult' });
    assert.equal(r.statusCode, 200);
    const inv = r.json();
    assert.match(inv.code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    assert.match(inv.link, /\/join\.html#code=[A-Z0-9-]+/);
    assert.match(inv.appLink, /^kova:\/\/join\?url=/);
    assert.match(inv.qrSvg, /^<svg/);
    assert.equal(inv.invite.expires - inv.invite.created, INVITE_MS, 'valid 24 hours');

    // On the new device: what it's for, and who they can be (people without an account).
    r = await h.call(null, 'POST', '/api/invite/peek', { code: inv.code.toLowerCase() });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().roleLabel, 'Adult');
    assert.deepEqual(r.json().people.map((p: { id: string }) => p.id), ['methel', 'brishti']);

    // Accepting as an existing person.
    r = await h.call(null, 'POST', '/api/invite/accept', { code: inv.code, personId: 'brishti', device: 'Brishti’s iPhone' });
    assert.equal(r.statusCode, 200, r.body);
    const { token, personId, role } = r.json();
    assert.equal(personId, 'brishti');
    assert.equal(role, 'adult');
    assert.equal((await h.call(token, 'GET', '/api/state')).statusCode, 200);
    const me = (await h.call(token, 'GET', '/api/me')).json();
    assert.equal(me.me.name, 'Brishti');
    assert.equal(me.me.role, 'adult');
    assert.match(me.presence.arriveUrl, /\/api\/people\/brishti\/presence\?key=.+&home=1$/, 'their own presence key, from their account');

    // Single use.
    r = await h.call(null, 'POST', '/api/invite/accept', { code: inv.code, name: 'Someone else' });
    assert.equal(r.statusCode, 410);
    assert.match(r.json().error, /used/);

    // Keys and codes are kept only as hashes.
    const stored = JSON.stringify([h.hub.store.get('web-sessions'), h.hub.store.get('household')]);
    assert.ok(!stored.includes(token));
    assert.ok(!stored.includes(inv.code) && !stored.includes(inv.code.replace('-', '')));

    // A new person, named on the invite.
    const sam = await h.join({ role: 'adult', name: 'Sam' }, {});
    assert.equal(sam.name, 'Sam');
    assert.ok(h.hub.config.get().people.some(p => p.id === sam.personId && p.name === 'Sam'));

    // An invite for someone who already has an account is refused.
    assert.equal((await h.call(MASTER, 'POST', '/api/invites', { role: 'adult', personId: 'brishti' })).statusCode, 400);
  } finally { await h.close(); }
});

test('invite codes: wrong ones are rate-limited by address, and they lapse after 24 hours', async () => {
  const h = await home();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await h.call(null, 'POST', '/api/invite/peek', { code: `WRONG-CODE${i % 10}` }, '10.0.0.9')).statusCode, 404);
    const inv = (await h.call(MASTER, 'POST', '/api/invites', { role: 'guest', rooms: ['guest'] })).json();
    // Blocked at that address, even with the right code; another address still gets in.
    assert.equal((await h.call(null, 'POST', '/api/invite/accept', { code: inv.code, name: 'Visitor' }, '10.0.0.9')).statusCode, 429);
    assert.equal((await h.call(null, 'POST', '/api/invite/peek', { code: inv.code }, '10.0.0.10')).statusCode, 200);
    h.clock.t += INVITE_MS + 1000;
    const r = await h.call(null, 'POST', '/api/invite/accept', { code: inv.code, name: 'Visitor' }, '10.0.0.11');
    assert.equal(r.statusCode, 410);
    assert.match(r.json().error, /expired/);
  } finally { await h.close(); }
});

test('keys from before accounts become owner keys; the master key stays the owner', async () => {
  const t = await testHub(12);
  // A browser signed in on the old hub: a session with no person.
  t.hub.store.set('web-sessions', [{ id: 's1', name: 'Chrome on Mac', hash: 'x'.repeat(64), created: 1, lastSeen: 1 }]);
  const app = await buildServer(t.hub, { webRoot, token: MASTER });
  try {
    const l = t.hub.store.get<{ owner?: boolean; personId?: string }[]>('web-sessions')!;
    assert.equal(l[0]!.owner, true);
    assert.equal(l[0]!.personId, undefined);
    // The master key does everything, as before.
    const as = { authorization: `Bearer ${MASTER}` };
    assert.equal((await app.inject({ url: '/api/members', headers: as })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/integrations/catalog', headers: as })).statusCode, 200);
    const me = (await app.inject({ url: '/api/me', headers: as })).json().me;
    assert.equal(me.role, 'owner');
    assert.equal(me.via, 'master');
  } finally { await app.close(); await t.hub.stop(); }
});

test('an old owner key keeps full access; signing a browser in with a code makes it the approver’s', async () => {
  const h = await home();
  try {
    // An owner browser from before accounts.
    let r = await h.call(null, 'POST', '/api/login/start');
    const old = r.json();
    await h.call(MASTER, 'POST', '/api/login/approve', { code: old.code });
    const ownerKey = (await h.call(null, 'GET', `/api/login/poll/${old.id}`)).json().token as string;
    assert.equal((await h.call(ownerKey, 'GET', '/api/integrations/catalog')).statusCode, 200);

    // A child signs in a second device of their own: it's the child's.
    const kid = await h.join({ role: 'child', name: 'Kid', rooms: ['baby'] }, {});
    r = await h.call(null, 'POST', '/api/login/start', { name: 'Kid’s iPad' });
    const s = r.json();
    assert.equal((await h.call(kid.token, 'POST', '/api/login/approve', { code: s.code })).statusCode, 200);
    const ipad = (await h.call(null, 'GET', `/api/login/poll/${s.id}`)).json().token as string;
    const me = (await h.call(ipad, 'GET', '/api/me')).json().me;
    assert.equal(me.personId, kid.personId);
    assert.equal(me.role, 'child');

    // Sessions: the child sees their own two; the owner sees everyone's, with whose they are.
    const theirs = (await h.call(kid.token, 'GET', '/api/sessions')).json().sessions;
    assert.equal(theirs.length, 2);
    const all = (await h.call(MASTER, 'GET', '/api/sessions')).json().sessions;
    assert.equal(all.length, 3);
    assert.ok(all.some((x: { personName: string | null }) => x.personName === 'Kid'));
    // A child can't sign out someone else's device; the owner can.
    const ownerSession = all.find((x: { personId?: string }) => !x.personId).id;
    assert.equal((await h.call(kid.token, 'DELETE', `/api/sessions/${ownerSession}`)).statusCode, 404);
    const ipadId = theirs.find((x: { current?: boolean }) => !x.current).id;
    assert.equal((await h.call(MASTER, 'DELETE', `/api/sessions/${ipadId}`)).statusCode, 200);
    assert.equal((await h.call(ipad, 'GET', '/api/state')).statusCode, 401);
  } finally { await h.close(); }
});

/** What each role may call: [method, url, body, owner, adult, child, guest] — "ok" or the status. */
const MATRIX: [string, string, unknown, ...(number | 'ok')[]][] = [
  ['GET', '/api/state', undefined, 'ok', 'ok', 'ok', 'ok'],
  ['GET', '/api/me', undefined, 'ok', 'ok', 'ok', 'ok'],
  ['POST', '/api/devices/baby_light', { on: true }, 'ok', 'ok', 'ok', 403],
  ['POST', '/api/devices/guest_speaker', { on: true }, 'ok', 'ok', 403, 'ok'],
  ['POST', '/api/devices/kitchen_ceiling', { on: true }, 'ok', 'ok', 403, 403],
  ['POST', '/api/rooms/kitchen/off', {}, 'ok', 'ok', 403, 403],
  ['POST', '/api/rooms/baby/off', {}, 'ok', 'ok', 'ok', 403],
  ['POST', '/api/devices/doorbell/webrtc', { offerSdp: 'x' }, 400, 400, 403, 403],
  ['GET', '/api/devices/doorbell/snapshot', undefined, 'ok', 'ok', 403, 403],
  ['GET', '/api/timeline', undefined, 'ok', 'ok', 403, 403],
  ['GET', '/api/sensors', undefined, 'ok', 'ok', 403, 403],
  ['POST', '/api/overlays/movie/start', {}, 'ok', 'ok', 403, 403],
  ['POST', '/api/plan/skip', { id: 'x', skip: false }, 'ok', 'ok', 403, 403],
  ['GET', '/api/automations', undefined, 'ok', 'ok', 403, 403],
  ['POST', '/api/automations', { name: 'X', when: [] }, 400, 400, 403, 403],
  ['POST', '/api/modes', { name: 'Late' }, 400, 400, 403, 403],
  ['PUT', '/api/rooms/order', { ids: [] }, 400, 400, 403, 403],
  ['PATCH', '/api/devices/lamp/settings', { favourite: true }, 'ok', 'ok', 403, 403],
  ['POST', '/api/ask', { text: 'hello' }, 'ok', 'ok', 'ok', 'ok'],
  ['GET', '/api/ask/history', undefined, 'ok', 'ok', 'ok', 'ok'],
  ['POST', '/api/people', { name: 'New' }, 'ok', 403, 403, 403],
  ['GET', '/api/members', undefined, 'ok', 403, 403, 403],
  ['POST', '/api/invites', { role: 'adult' }, 'ok', 403, 403, 403],
  ['GET', '/api/integrations/catalog', undefined, 'ok', 403, 403, 403],
  ['GET', '/api/integrations/config', undefined, 503, 403, 403, 403],
  ['GET', '/api/update', undefined, 404, 403, 403, 403],
  ['GET', '/api/backups', undefined, 404, 403, 403, 403],
  ['GET', '/api/presence/setup', undefined, 'ok', 403, 403, 403],
  ['GET', '/api/app-link', undefined, 'ok', 403, 403, 403],
  ['PUT', '/api/assistant/settings', {}, 'ok', 403, 403, 403],
  ['PUT', '/api/home', { name: 'Home' }, 'ok', 403, 403, 403],
  ['POST', '/api/import/ha/apply', {}, 503, 403, 403, 403],
  ['POST', '/api/devices/doorbell/event', { type: 'ring' }, 'ok', 403, 403, 403],
  // A speaker group's timing: adults tune it, children and guests don't.
  ['PUT', '/api/speaker-groups/none/offsets', { offsets: {} }, 404, 404, 403, 403],
  ['POST', '/api/speaker-groups/none/sync-test', {}, 404, 404, 403, 403],
];

test('the role matrix: each role on the routes that matter', async () => {
  const h = await home();
  try {
    const owner = await h.join({ role: 'owner', personId: 'methel' }, {});
    const adult = await h.join({ role: 'adult', personId: 'brishti' }, {});
    const child = await h.join({ role: 'child', name: 'Kid', rooms: ['baby'] }, {});
    const guest = await h.join({ role: 'guest', name: 'Visitor', rooms: ['guest'] }, {});
    const keys = [owner.token, adult.token, child.token, guest.token];
    for (const [method, url, body, ...want] of MATRIX) {
      for (const [i, key] of keys.entries()) {
        const r = await h.call(key, method, url, body);
        const role = ['owner', 'adult', 'child', 'guest'][i];
        if (want[i] === 'ok') assert.ok(r.statusCode < 300, `${role} ${method} ${url}: ${r.statusCode} ${r.body}`);
        else assert.equal(r.statusCode, want[i], `${role} ${method} ${url}: ${r.body}`);
      }
    }
    // No key at all: nothing.
    assert.equal((await h.call(null, 'GET', '/api/state')).statusCode, 401);
  } finally { await h.close(); }
});

test('every API route is on the access allow-list (a new route is a decision, not an accident)', async () => {
  const { ROUTES } = await import('../src/api/access.ts');
  const { routesOf } = await import('../src/api/server.ts');
  const t = await testHub(12);
  const app = await buildServer(t.hub, { webRoot, token: MASTER, otaDir: mkdtempSync(join(tmpdir(), 'kova-ota-')), presence: new Presence(t.hub, {}) });
  try {
    await app.ready();
    const missing = routesOf(app).filter(r => !ROUTES[r]);
    assert.deepEqual(missing, [], 'routes without a rule in api/access.ts');
    const stale = Object.keys(ROUTES).filter(r => !routesOf(app).includes(r));
    assert.deepEqual(stale, [], 'rules for routes that no longer exist');
  } finally { await app.close(); await t.hub.stop(); }
});

test('a child sees only their rooms; a guest no cameras, history or people; guests lapse', async () => {
  const h = await home();
  try {
    const child = await h.join({ role: 'child', name: 'Kid', rooms: ['baby'] }, {});
    const until = h.clock.t + 3 * 3600_000;
    const guest = await h.join({ role: 'guest', name: 'Visitor', rooms: ['guest'], devices: ['lamp'], until }, {});

    let s = (await h.call(child.token, 'GET', '/api/state')).json();
    assert.deepEqual([...new Set(s.devices.map((d: { room: string }) => d.room))], ['baby']);
    assert.deepEqual(s.rooms.map((r: { id: string }) => r.id), ['baby']);
    assert.ok(!s.devices.some((d: { type: string }) => d.type === 'camera'));
    assert.deepEqual(s.automations, []);
    assert.equal(s.me.role, 'child');
    assert.equal(s.me.can.automate, false);
    assert.ok(s.people.length > 0, 'a child sees who’s home');

    s = (await h.call(guest.token, 'GET', '/api/state')).json();
    assert.deepEqual(s.devices.map((d: { id: string }) => d.id).sort(), ['guest_speaker', 'lamp']);
    assert.deepEqual(s.people, []);
    assert.deepEqual(s.activity, []);
    assert.deepEqual(s.security.recent, []);
    assert.equal(s.me.until, until);

    // All lights off: only theirs.
    await h.call(MASTER, 'POST', '/api/devices/kitchen_ceiling', { on: true });
    await h.call(MASTER, 'POST', '/api/devices/baby_light', { on: true });
    assert.equal((await h.call(child.token, 'POST', '/api/lights/off')).statusCode, 200);
    assert.equal(h.dev('baby_light').on, false);
    assert.equal(h.dev('kitchen_ceiling').on, true);

    // A child can't undo an adult's change.
    const undo = (await h.call(MASTER, 'POST', '/api/devices/baby_light', { on: true })).json().undo;
    assert.equal((await h.call(child.token, 'POST', `/api/undo/${undo}`)).statusCode, 410);
    assert.equal(h.dev('baby_light').on, true);

    // The guest's time runs out: signed out everywhere.
    h.clock.t = until + 1;
    const r = await h.call(guest.token, 'GET', '/api/state');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, 'signed-out');
  } finally { await h.close(); }
});

test('Activity says who did what; Ask Kova acts as the asker', async () => {
  const h = await home();
  try {
    const sam = await h.join({ role: 'adult', name: 'Sam' }, {});
    await h.call(MASTER, 'POST', '/api/devices/lounge_main', { on: true });
    await h.call(MASTER, 'POST', '/api/devices/lounge_down', { on: true });
    assert.equal((await h.call(sam.token, 'POST', '/api/rooms/lounge/off', {})).statusCode, 200);
    const act = (await h.call(sam.token, 'GET', '/api/state')).json().activity;
    const row = act.find((a: { who: string | null }) => a.who === 'Sam');
    assert.ok(row, JSON.stringify(act.slice(0, 3)));
    assert.equal(row.what, 'Sam turned off Lounge lights · 2 devices changed');

    // Built-in Ask Kova: "my room" is theirs; a child's "turn off the lights" only reaches their rooms.
    const kid = await h.join({ role: 'child', name: 'Kid', rooms: ['baby'] }, {});
    await h.call(MASTER, 'PUT', `/api/members/${kid.personId}`, { room: 'baby' });
    await h.call(MASTER, 'POST', '/api/devices/baby_light', { on: true });
    await h.call(MASTER, 'POST', '/api/devices/kitchen_ceiling', { on: true });
    let r = (await h.call(kid.token, 'POST', '/api/ask', { text: 'turn off my room' })).json();
    assert.equal(h.dev('baby_light').on, false, r.text);
    r = (await h.call(kid.token, 'POST', '/api/ask', { text: 'turn off the kitchen lights' })).json();
    assert.equal(h.dev('kitchen_ceiling').on, true, `a child can't reach the kitchen: ${r.text}`);
    r = (await h.call(kid.token, 'POST', '/api/ask', { text: 'start movie' })).json();
    assert.equal(h.hub.engine.overlay, null, r.text);
    assert.match(r.text, /can’t change the home’s modes/);
    r = (await h.call(kid.token, 'POST', '/api/ask/act', { action: { type: 'learnGroup', name: 'downstairs', rooms: ['kitchen'] } }));
    assert.equal(r.statusCode, 403);
    r = (await h.call(kid.token, 'POST', '/api/ask/act', { action: { type: 'apply', targets: { kitchen_ceiling: { on: false } }, label: 'x', done: 'x' } }));
    assert.equal(r.statusCode, 403);
    assert.equal(h.dev('kitchen_ceiling').on, true);

    // Each person's conversation is their own.
    const theirs = (await h.call(kid.token, 'GET', '/api/ask/history')).json().turns;
    assert.ok(theirs.every((t: { who?: string }) => t.who === kid.personId));
    assert.ok(!(await h.call(sam.token, 'GET', '/api/ask/history')).json().turns.some((t: { text: string }) => /my room/.test(t.text)));
  } finally { await h.close(); }
});

test('managing members: change a role, resend an invite, remove someone (everything of theirs goes)', async () => {
  const h = await home();
  try {
    const sam = await h.join({ role: 'adult', personId: 'brishti' }, {});
    // Their phone registers for notifications as them; a member can't register for someone else.
    assert.equal((await h.call(sam.token, 'POST', '/api/push/app', { token: 'ExponentPushToken[sam]' })).statusCode, 200);
    assert.equal((await h.call(sam.token, 'POST', '/api/push/app', { token: 'ExponentPushToken[x]', personId: 'methel' })).statusCode, 403);
    assert.equal(h.notifier.appPhones().find(a => a.token === 'ExponentPushToken[sam]')?.personId, 'brishti');

    let m = (await h.call(MASTER, 'GET', '/api/members')).json();
    assert.equal(m.members.length, 1);
    assert.equal(m.members[0].name, 'Brishti');
    assert.ok(m.members[0].lastSeen > 0);
    assert.equal(m.members[0].sessions.length, 1);
    assert.deepEqual(m.others.map((p: { personId: string }) => p.personId), ['methel']);

    // Change role: their key follows at once.
    assert.equal((await h.call(MASTER, 'PUT', '/api/members/brishti', { role: 'guest', rooms: ['guest'] })).statusCode, 200);
    assert.equal((await h.call(sam.token, 'GET', '/api/automations')).statusCode, 403);
    assert.equal((await h.call(MASTER, 'PUT', '/api/members/brishti', { role: 'boss' })).statusCode, 400);

    // A guest's phone hears only what's sent to them by name.
    assert.equal(h.notifier.audience('brishti', { title: 'Doorbell', body: '' }), false);
    assert.equal(h.notifier.audience('brishti', { title: 'Hi', body: '', people: ['brishti'] }), true);
    assert.equal(h.notifier.audience('methel', { title: 'Doorbell', body: '' }), true);

    // Resend: a fresh code; the old one stops working.
    const inv = (await h.call(MASTER, 'POST', '/api/invites', { role: 'adult', name: 'Pat' })).json();
    const again = (await h.call(MASTER, 'POST', `/api/invites/${inv.invite.id}/resend`)).json();
    assert.notEqual(again.code, inv.code);
    assert.equal((await h.call(null, 'POST', '/api/invite/peek', { code: inv.code })).statusCode, 404);
    assert.equal((await h.call(null, 'POST', '/api/invite/peek', { code: again.code })).statusCode, 200);
    m = (await h.call(MASTER, 'GET', '/api/members')).json();
    assert.equal(m.invites.length, 1);
    assert.ok(!JSON.stringify(m.invites).includes(again.code), 'the code is never shown again');

    // Remove: signed out, no more notifications, a new presence key.
    const keyBefore = h.presence.keyFor('brishti');
    const r = (await h.call(MASTER, 'DELETE', '/api/members/brishti')).json();
    assert.equal(r.signedOut, 1);
    assert.equal((await h.call(sam.token, 'GET', '/api/state')).statusCode, 401);
    assert.ok(!h.notifier.appPhones().some(a => a.personId === 'brishti'));
    assert.notEqual(h.presence.keyFor('brishti'), keyBefore);
    assert.ok(h.hub.config.get().people.some(p => p.id === 'brishti'), 'they still live here (presence), without an account');
  } finally { await h.close(); }
});

test('the owner says which person they are: the master key stays, the device gets a key of theirs', async () => {
  const h = await home();
  try {
    const r = await h.call(MASTER, 'POST', '/api/me/claim', { personId: 'methel', name: 'Kova app on iPhone' });
    assert.equal(r.statusCode, 200, r.body);
    const key = r.json().token as string;
    const me = (await h.call(key, 'GET', '/api/me')).json().me;
    assert.equal(me.personId, 'methel');
    assert.equal(me.role, 'owner');
    assert.equal((await h.call(MASTER, 'GET', '/api/members')).statusCode, 200, 'recovery: the master key still works');
    // Now their changes are theirs in Activity.
    await h.call(key, 'POST', '/api/devices/lamp', { on: true });
    const act = (await h.call(key, 'GET', '/api/state')).json().activity;
    assert.equal(act[0].who, 'Methel');
  } finally { await h.close(); }
});

test('a member reports only their own presence with their key; the owner anyone’s', async () => {
  const h = await home();
  try {
    const sam = await h.join({ role: 'adult', personId: 'brishti' }, {});
    assert.equal((await h.call(sam.token, 'POST', '/api/people/brishti/presence', { home: false })).statusCode, 200);
    assert.equal((await h.call(sam.token, 'POST', '/api/people/methel/presence', { home: false })).statusCode, 403);
    assert.equal((await h.call(MASTER, 'POST', '/api/people/methel/presence', { home: false })).statusCode, 200);
    // The phone automation's own key still works without signing in.
    const key = h.presence.keyFor('methel')!;
    assert.equal((await h.call(null, 'POST', `/api/people/methel/presence?key=${encodeURIComponent(key)}&home=1`)).statusCode, 200);
  } finally { await h.close(); }
});

test('a username and password: set by the person or the owner, sign in on any device, wrong tries limited, kept as a hash', async () => {
  const h = await home();
  try {
    const b = await h.join({ role: 'adult' }, { personId: 'brishti' });
    // Their own username and password, from a signed-in device.
    let r = await h.call(b.token, 'PUT', '/api/me/login', { user: 'Brishti', password: 'short' });
    assert.equal(r.statusCode, 400);
    r = await h.call(b.token, 'PUT', '/api/me/login', { user: 'Brishti', password: 'correct horse' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().user, 'brishti');
    assert.equal((await h.call(b.token, 'GET', '/api/me')).json().me.user, 'brishti');
    // Signing in on a new phone: its own key, as them.
    r = await h.call(null, 'POST', '/api/login/password', { user: ' BRISHTI ', password: 'correct horse', device: 'New phone' });
    assert.equal(r.statusCode, 200, r.body);
    const key = r.json().token;
    assert.equal(r.json().personId, 'brishti');
    assert.equal((await h.call(key, 'GET', '/api/me')).json().me.name, 'Brishti');
    // Wrong password or username: the same answer.
    const bad1 = await h.call(null, 'POST', '/api/login/password', { user: 'brishti', password: 'wrong one!' }, '10.0.0.7');
    const bad2 = await h.call(null, 'POST', '/api/login/password', { user: 'nobody', password: 'correct horse' }, '10.0.0.7');
    assert.deepEqual([bad1.statusCode, bad2.statusCode], [401, 401]);
    assert.equal(bad1.json().error, bad2.json().error);
    // A change needs the current password; the owner can reset it without.
    assert.equal((await h.call(b.token, 'PUT', '/api/me/login', { password: 'another pass', current: 'nope' })).statusCode, 403);
    assert.equal((await h.call(b.token, 'PUT', '/api/me/login', { password: 'another pass', current: 'correct horse' })).statusCode, 200);
    assert.equal((await h.call(MASTER, 'PUT', '/api/members/brishti/login', { password: 'reset by owner' })).statusCode, 200);
    assert.equal((await h.call(null, 'POST', '/api/login/password', { user: 'brishti', password: 'reset by owner' })).statusCode, 200);
    // Only the owner sets someone else's; usernames are unique.
    const sam = await h.join({ role: 'adult', name: 'Sam' }, {});
    assert.equal((await h.call(sam.token, 'PUT', '/api/members/brishti/login', { password: 'taken over!' })).statusCode, 403);
    assert.equal((await h.call(sam.token, 'PUT', '/api/me/login', { user: 'brishti', password: 'sams password' })).statusCode, 409);
    // The owners' list shows the username; only a hash is kept.
    assert.equal((await h.call(MASTER, 'GET', '/api/members')).json().members.find((m: { personId: string }) => m.personId === 'brishti').user, 'brishti');
    assert.ok(!JSON.stringify(h.hub.store.get('household')).includes('reset by owner'));
    // Too many wrong tries from one address: blocked for a while, even with the right password.
    for (let i = 0; i < 10; i++) await h.call(null, 'POST', '/api/login/password', { user: 'brishti', password: `guess ${i}xx` }, '10.0.0.9');
    assert.equal((await h.call(null, 'POST', '/api/login/password', { user: 'brishti', password: 'reset by owner' }, '10.0.0.9')).statusCode, 429);
    // Removed from the home: the username stops working.
    await h.call(MASTER, 'DELETE', '/api/members/brishti');
    assert.equal((await h.call(null, 'POST', '/api/login/password', { user: 'brishti', password: 'reset by owner' }, '10.0.0.3')).statusCode, 401);
  } finally { await h.close(); }
});
