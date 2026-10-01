import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addManual, addressesOf, allowed, chooseAddress, kindFor, learn, parseHello, remove, sameHub, tryOrder,
  type Hello, type HubAddress,
} from '../src/logic/addresses.ts';
import { parseConnectLink } from '../src/logic/connect.ts';
import { manifestUrl, updateBase } from '../src/logic/ota.ts';

const LAN = 'http://192.168.1.20:8140';
const LAN2 = 'http://10.0.0.7:8140';
const REMOTE = 'https://kova.example.ts.net';
const ID = 'a1b2c3d4e5f6a7b8c9d0';

/** A fake network: what answers at each address, and how long it takes (ms). Records what was asked. */
function net(answers: Record<string, { hello: Hello | null; ms?: number }>) {
  const asked: string[] = [];
  const helloFn = (url: string, timeoutMs: number) => {
    asked.push(url);
    const a = answers[url];
    if (!a) return new Promise<null>(r => setTimeout(() => r(null), Math.min(timeoutMs, 30)));
    return new Promise<Hello | null>(r => setTimeout(() => r((a.ms ?? 1) > timeoutMs ? null : a.hello), Math.min(a.ms ?? 1, timeoutMs)));
  };
  return { hello: helloFn, asked };
}
const kova = (hubId: string | null = ID): Hello => ({ kova: true, hubId });
const list: HubAddress[] = [{ url: LAN, kind: 'local' }, { url: REMOTE, kind: 'remote' }];

test('addresses: which are home network and which remote', () => {
  assert.equal(kindFor(LAN), 'local');
  assert.equal(kindFor('http://kova.local:8140'), 'local');
  assert.equal(kindFor('http://kova:8140'), 'local');
  assert.equal(kindFor(REMOTE), 'remote');
  assert.equal(kindFor('http://100.101.102.103:8140'), 'remote', 'a tailnet address only works with the VPN up');
  assert.equal(kindFor('https://home.example.com'), 'remote');
});

test('addresses: the token only goes over https to a remote address, unless the owner added a plain one', () => {
  assert.ok(allowed({ url: LAN, kind: 'local' }));
  assert.ok(allowed({ url: REMOTE, kind: 'remote' }));
  assert.ok(!allowed({ url: 'http://kova.example.ts.net', kind: 'remote' }));
  assert.ok(allowed({ url: 'http://kova.example.ts.net', kind: 'remote', manual: true }));
  assert.ok(!allowed({ url: 'ftp://x', kind: 'local' }));
  assert.deepEqual(tryOrder([{ url: 'http://kova.example.ts.net', kind: 'remote' }, ...list]).map(a => a.url), [LAN, REMOTE]);
});

test('addresses: a phone from before the list keeps its one address', () => {
  assert.deepEqual(addressesOf({ url: LAN }), [{ url: LAN, kind: 'local' }]);
  assert.deepEqual(addressesOf({ url: LAN, addresses: list }), list);
  assert.deepEqual(addressesOf({ url: LAN, addresses: [] }), [{ url: LAN, kind: 'local' }]);
});

test('addresses: learned from the hub, keeping the owner’s own and the one in use, and not what was removed', () => {
  const have: HubAddress[] = [{ url: 'http://kova.local:8140', kind: 'local' }, { url: 'https://proxy.example.com', kind: 'remote', manual: true }, { url: 'http://192.168.9.9:8140', kind: 'local' }];
  const got = learn(have, [{ url: LAN, kind: 'local' }, { url: `${REMOTE}/`, kind: 'remote' }, { url: LAN2, kind: 'local' }, { url: 'nonsense' } as never], 'http://kova.local:8140', [LAN2]);
  assert.deepEqual(got, [
    { url: LAN, kind: 'local' },
    { url: 'http://kova.local:8140', kind: 'local' },
    { url: REMOTE, kind: 'remote' },
    { url: 'https://proxy.example.com', kind: 'remote', manual: true },
  ]);
  const added = addManual(got, 'http://192.168.1.30:8140');
  assert.deepEqual(added[0], { url: 'http://192.168.1.30:8140', kind: 'local', manual: true });
  assert.equal(remove(added, LAN).some(a => a.url === LAN), false);
});

test('addresses: identity — only this hub, and any Kova until the phone knows which', () => {
  assert.ok(sameHub(ID, kova()));
  assert.ok(!sameHub(ID, kova('another')));
  assert.ok(!sameHub(ID, kova(null)));
  assert.ok(sameHub(undefined, kova(null)));
  assert.ok(!sameHub(undefined, null));
  assert.deepEqual(parseHello({ kova: true, hubId: ID, version: '0.7.8' }), { kova: true, hubId: ID, version: '0.7.8' });
  assert.deepEqual(parseHello({ ok: true, version: '0.7.6', uptimeS: 5 }), { kova: true, hubId: null, version: '0.7.6' });
  assert.equal(parseHello({ ok: true }), null);
  assert.equal(parseHello('<html>'), null);
});

test('choosing: home network wins when it answers, even if remote answers first', async () => {
  const n = net({ [LAN]: { hello: kova(), ms: 40 }, [REMOTE]: { hello: kova(), ms: 1 } });
  assert.deepEqual(await chooseAddress(list, { hello: n.hello, hubId: ID }), { url: LAN, kind: 'local', hubId: ID });
});

test('choosing: away from home, the remote address', async () => {
  const n = net({ [REMOTE]: { hello: kova(), ms: 5 } });
  assert.deepEqual(await chooseAddress(list, { hello: n.hello, hubId: ID, localTimeoutMs: 50 }), { url: REMOTE, kind: 'remote', hubId: ID });
});

test('choosing: another device at the home address (another network) is not this hub', async () => {
  // Someone else's Kova, or anything else, on the same private address: never used, so the token never goes there.
  const n = net({ [LAN]: { hello: kova('someone-else') }, [REMOTE]: { hello: kova(), ms: 5 } });
  assert.equal((await chooseAddress(list, { hello: n.hello, hubId: ID }))?.url, REMOTE);
  const none = net({ [LAN]: { hello: null } });
  assert.equal(await chooseAddress(list, { hello: none.hello, hubId: ID, localTimeoutMs: 20, remoteTimeoutMs: 20 }), null);
});

test('choosing: a slow home network loses to its timeout; the first remote in order wins', async () => {
  const r2 = 'https://proxy.example.com';
  const n = net({ [LAN]: { hello: kova(), ms: 200 }, [REMOTE]: { hello: kova(), ms: 30 }, [r2]: { hello: kova(), ms: 1 } });
  const got = await chooseAddress([...list, { url: r2, kind: 'remote' }], { hello: n.hello, hubId: ID, localTimeoutMs: 20 });
  assert.equal(got?.url, REMOTE);
});

test('choosing: the last good one goes first in its group; a phone without the hub’s ID learns it', async () => {
  const two: HubAddress[] = [{ url: LAN, kind: 'local' }, { url: LAN2, kind: 'local' }, { url: REMOTE, kind: 'remote' }];
  assert.deepEqual(tryOrder(two, LAN2).map(a => a.url), [LAN2, LAN, REMOTE]);
  assert.deepEqual(tryOrder(two, REMOTE).map(a => a.url), [LAN, LAN2, REMOTE], 'home network still comes first');
  const n = net({ [LAN2]: { hello: kova() } });
  assert.deepEqual(await chooseAddress(two, { hello: n.hello, lastGood: LAN2, localTimeoutMs: 20, remoteTimeoutMs: 20 }), { url: LAN2, kind: 'local', hubId: ID });
  assert.equal(await chooseAddress([], { hello: n.hello }), null);
});

test('the connect code carries every address and the hub’s ID; an old code still works', () => {
  const link = `kova://connect?url=${encodeURIComponent(LAN)}&token=abc&hub=${ID}&alt=${encodeURIComponent(REMOTE)}&alt=${encodeURIComponent(LAN2)}`;
  assert.deepEqual(parseConnectLink(link), {
    url: LAN, token: 'abc', hubId: ID,
    addresses: [{ url: LAN, kind: 'local' }, { url: LAN2, kind: 'local' }, { url: REMOTE, kind: 'remote' }],
  });
  assert.deepEqual(parseConnectLink(`kova://connect?url=${encodeURIComponent(LAN)}&token=abc`), { url: LAN, token: 'abc' });
});

test('updates stay on one of the hub’s addresses rather than following every switch', () => {
  const both = [{ url: LAN, kind: 'local' as const }, { url: REMOTE, kind: 'remote' as const }];
  assert.equal(updateBase(both, manifestUrl(REMOTE), LAN), REMOTE, 'already on the remote one: stays there');
  assert.equal(updateBase(both, null, REMOTE), LAN, 'first time: the home-network one');
  assert.equal(updateBase(both, manifestUrl('http://192.168.9.9:8140'), REMOTE), LAN, 'its old address is gone');
  assert.equal(updateBase([{ url: REMOTE, kind: 'remote' }], null, REMOTE), REMOTE);
  assert.equal(updateBase([], null, null), null);
});
