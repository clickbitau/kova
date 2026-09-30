import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubUrl, normalizeHubUrl, parseConnectLink, subnetCandidates, wsUrl } from '../src/logic/connect.ts';
import { distanceM, presenceFor } from '../src/logic/geo.ts';

test('hub addresses: bare IPs get Kova’s port; HTTPS and explicit ports are kept', () => {
  assert.equal(normalizeHubUrl('192.168.1.20'), 'http://192.168.1.20:8140');
  assert.equal(normalizeHubUrl(' kova.local/ '), 'http://kova.local:8140');
  assert.equal(normalizeHubUrl('http://10.0.0.5:9000/'), 'http://10.0.0.5:9000');
  assert.equal(normalizeHubUrl('http://10.0.0.5:80'), 'http://10.0.0.5:80');
  assert.equal(normalizeHubUrl('https://kova.example.com/'), 'https://kova.example.com');
  assert.equal(normalizeHubUrl(''), null);
});

test('connect links from the hub’s QR code', () => {
  assert.deepEqual(parseConnectLink('kova://connect?url=http%3A%2F%2F192.168.1.20%3A8140&token=abc'), { url: 'http://192.168.1.20:8140', token: 'abc' });
  assert.deepEqual(parseConnectLink('kova://connect?url=192.168.1.20'), { url: 'http://192.168.1.20:8140' });
  assert.deepEqual(parseConnectLink('10.0.0.9'), { url: 'http://10.0.0.9:8140' });
  assert.equal(parseConnectLink('kova://connect'), null);
});

test('looking for the hub on the phone’s network: the other 253 addresses, nearest first', () => {
  const c = subnetCandidates('192.168.1.50');
  assert.equal(c.length, 253);
  assert.ok(!c.includes('http://192.168.1.50:8140'));
  assert.deepEqual(c.slice(0, 3), ['http://192.168.1.1:8140', 'http://192.168.1.49:8140', 'http://192.168.1.51:8140']);
  assert.deepEqual(subnetCandidates(null), []);
  assert.deepEqual(subnetCandidates('127.0.0.1'), []);
});

test('token goes in the query only where headers can’t', () => {
  const cfg = { url: 'http://10.0.0.2:8140', token: 't/1' };
  assert.equal(hubUrl(cfg, '/api/state'), 'http://10.0.0.2:8140/api/state');
  assert.equal(hubUrl(cfg, '/phone.html?cam=door', true), 'http://10.0.0.2:8140/phone.html?cam=door&token=t%2F1');
  assert.equal(wsUrl(cfg), 'ws://10.0.0.2:8140/api/ws?token=t%2F1');
  assert.equal(wsUrl({ url: 'https://k.example' }), 'wss://k.example/api/ws');
});

test('geofence: arriving counts at once; leaving only when really away', () => {
  const home = { latitude: -31.95, longitude: 115.86 };
  assert.ok(Math.abs(distanceM(home, { latitude: -31.95, longitude: 115.87 }) - 944) < 5);
  assert.equal(presenceFor('enter'), true);
  assert.equal(presenceFor('exit', { latitude: -31.9505, longitude: 115.86 }, home), null, 'still within the circle: GPS noise');
  assert.equal(presenceFor('exit', { latitude: -31.96, longitude: 115.86 }, home), false);
  assert.equal(presenceFor('exit', null, home), false);
});
