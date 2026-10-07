import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanInviteCode, parseConnectLink, parseInviteLink } from '../src/logic/connect.ts';
import { accessBody, features, inviteLine, inviteProblem, meOf, OWNER, presenceKeyFrom, roleLine, seenWords, tabsFor, untilPresets, untilWords } from '../src/logic/roles.ts';

test('invite links: the join page (https or http, code after #) and kova://join', () => {
  assert.deepEqual(parseInviteLink('https://kova.example.com/join.html#code=abcde-fghjk&hub=h1'), { url: 'https://kova.example.com', code: 'ABCDE-FGHJK', hubId: 'h1' });
  const lan = parseInviteLink('http://192.168.1.20:8140/join.html#code=ABCDE-FGHJK&hub=h1&alt=https%3A%2F%2Fkova.example.com');
  assert.equal(lan?.url, 'http://192.168.1.20:8140');
  assert.deepEqual(lan?.addresses?.map(a => [a.url, a.kind]), [['http://192.168.1.20:8140', 'local'], ['https://kova.example.com', 'remote']]);
  assert.deepEqual(parseInviteLink('kova://join?url=http%3A%2F%2F10.0.0.2%3A8140&code=ABCDEFGHJK'), { url: 'http://10.0.0.2:8140', code: 'ABCDE-FGHJK' });
  // Behind a proxy with a path.
  assert.equal(parseInviteLink('https://home.example/kova/join.html#code=ABCDE-FGHJK')?.url, 'https://home.example/kova');
  // Not invites.
  assert.equal(parseInviteLink('kova://connect?url=10.0.0.2&token=x'), null);
  assert.equal(parseInviteLink('https://kova.example.com/join.html#code=short'), null);
  assert.equal(parseInviteLink('https://kova.example.com/'), null);
  assert.equal(parseInviteLink('192.168.1.20'), null);
  // A connect link is still a connect link.
  assert.equal(parseConnectLink('kova://connect?url=10.0.0.2')?.url, 'http://10.0.0.2:8140');
  assert.equal(cleanInviteCode(' abcde fghjk '), 'ABCDE-FGHJK');
  assert.equal(cleanInviteCode('ABCD'), null);
});

test('who the app is signed in as: a hub from before accounts is the owner', () => {
  assert.equal(meOf({}), OWNER);
  const kid = meOf({ me: { role: 'child', roleLabel: 'Child', personId: 'kid', name: 'Kid', rooms: ['baby'], devices: null, until: null, room: 'baby', via: 'session', can: { view: true, control: true, people: true } as never } });
  assert.equal(kid.can.automate, false);
  assert.deepEqual(tabsFor(kid), ['Now', 'Devices', 'Ask', 'More']);
  assert.deepEqual(tabsFor(OWNER), ['Now', 'Devices', 'Ask', 'Security', 'More']);
  const f = features(kid);
  assert.equal(f.modes, false);
  assert.equal(f.integrations, false);
  assert.equal(f.activity, true);
  assert.equal(features(meOf({ me: { ...kid, role: 'guest' } })).activity, false);
  assert.equal(roleLine(kid, id => (id === 'baby' ? 'Baby room' : id)), 'Child · Baby room');
});

test('guest end times: presets at round hours, and how they read', () => {
  const now = new Date(2026, 9, 7, 14, 30).getTime(); // a Wednesday
  const p = untilPresets(now);
  assert.deepEqual(p.map(x => x.id), ['tonight', 'tomorrow', 'sunday', 'week', 'none']);
  assert.equal(new Date(p[2]!.at!).getDay(), 0);
  assert.equal(new Date(p[1]!.at!).getHours(), 18);
  assert.equal(p[4]!.at, null);
  assert.equal(untilWords(new Date(2026, 9, 7, 18, 0).getTime(), now), 'until 18:00 today');
  assert.equal(untilWords(new Date(2026, 9, 8, 18, 0).getTime(), now), 'until tomorrow 18:00');
  assert.equal(untilWords(new Date(2026, 9, 11, 18, 0).getTime(), now), 'until Sun 18:00');
  assert.equal(untilWords(new Date(2026, 10, 3, 18, 0).getTime(), now), 'until 3 Nov');
  assert.equal(untilWords(now - 1, now), 'access ended');
  // Late at night there's no "tonight".
  assert.ok(!untilPresets(new Date(2026, 9, 7, 22, 50).getTime()).some(x => x.id === 'tonight'));
});

test('invites and member changes: rooms only for a child or guest, an end only for a guest', () => {
  assert.deepEqual(accessBody({ role: 'adult', rooms: ['x'], until: 5 }), { role: 'adult' });
  assert.deepEqual(accessBody({ role: 'child', rooms: ['baby'], until: 5 }), { role: 'child', rooms: ['baby'] });
  assert.deepEqual(accessBody({ role: 'guest', rooms: ['guest'], until: null }), { role: 'guest', rooms: ['guest'], until: null });
  assert.match(inviteProblem({ role: 'child', rooms: [] })!, /at least one room/);
  assert.equal(inviteProblem({ role: 'adult', rooms: [] }), null);
  const now = 1_000_000_000;
  assert.equal(inviteLine({ roleLabel: 'Adult', name: 'Sam', expires: now + 23 * 3600_000 }, id => id, now), 'Adult · for Sam · expires in 23 h');
  assert.equal(inviteLine({ roleLabel: 'Guest', expires: now - 1 }, id => id, now), 'Guest · anyone · expired: resend it');
  assert.equal(seenWords(null), 'not seen yet');
  assert.equal(seenWords(now - 5 * 60_000, now), '5 min ago');
  assert.equal(presenceKeyFrom('http://h/api/people/sam/presence?key=a%2Fb&home=1'), 'a/b');
  assert.equal(presenceKeyFrom(null), null);
});
