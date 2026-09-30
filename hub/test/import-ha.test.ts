import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importHomeAssistant } from '../src/tools/import-ha.ts';
import { adaptersFor } from '../src/integrations.ts';

// A synthetic Home Assistant .storage folder (no real keys).
function fixture(nest: { token?: string; creds?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ha-'));
  const w = (f: string, data: unknown) => writeFileSync(join(dir, f), JSON.stringify({ version: 1, data }));
  w('core.config', { location_name: 'Test Home', latitude: -31.9, longitude: 115.8, time_zone: 'Australia/Perth' });
  w('core.area_registry', { areas: [{ id: 'kitchen', name: 'Kitchen' }, { id: 'living_room', name: 'Living Room' }, { id: 'music_room', name: 'Music Room' }] });
  w('person', { items: [{ id: 'p1', name: 'Methel', device_trackers: ['device_tracker.methels_iphone'] }] });
  w('core.config_entries', { entries: [
    { entry_id: 'lt', domain: 'localtuya', title: 'localtuya', data: { devices: { bf00: { friendly_name: 'Kitchen Switch', host: '192.168.1.230', local_key: 'aaaaaaaaaaaaaaaa', protocol_version: '3.3', entities: [{ id: 2, platform: 'switch', friendly_name: 'Kitchen Light' }, { id: 3, platform: 'switch', friendly_name: 'Dining Light' }] }, bf01: { friendly_name: 'Office Switch', host: '192.168.1.214', local_key: 'bbbbbbbbbbbbbbbb', protocol_version: '3.4', entities: [{ id: 1, platform: 'switch', friendly_name: 'Office Switch' }] } } } },
    { entry_id: 'tp1', domain: 'tplink', title: 'Lamp L535', data: { host: '10.0.0.5', alias: 'Lamp', credentials_hash: Buffer.alloc(32, 1).toString('base64') } },
    { entry_id: 'c', domain: 'cast', title: 'Google Cast', data: {} },
    { entry_id: 'tv', domain: 'samsungtv', title: 'Living Room TV', data: { host: '10.0.0.20', mac: 'aa:bb:cc:dd:ee:ff', method: 'websocket', port: 8002, token: 'ha-token' } },
    { entry_id: 'vs', domain: 'vesync', title: 'VeSync', data: { username: 'me@example.com', password: 'not-imported' } },
    { entry_id: 'nest', domain: 'nest', title: 'Test Home', data: {
      auth_implementation: 'nest_cred', cloud_project_id: 'my-gcp', project_id: '11111111-2222-3333-4444-555555555555',
      subscription_name: 'projects/my-gcp/subscriptions/home-assistant-sub', topic_name: 'projects/my-gcp/topics/home-assistant',
      token: { access_token: 'REDACTED', refresh_token: nest.token ?? 'REDACTED', expires_at: 1790760047, scope: 'https://www.googleapis.com/auth/sdm.service https://www.googleapis.com/auth/pubsub' },
    } },
  ] });
  if (nest.creds) w('application_credentials', { items: [{ id: 'nest_cred', domain: 'nest', client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-plain-client-secret', auth_domain: 'nest', name: 'Nest' }] });
  w('core.device_registry', { devices: [
    { name: 'Lamp', area_id: 'living_room', config_entries: ['tp1'] },
    { name: 'Music Room Speaker', area_id: null, config_entries: ['c'], model: 'Nest Audio' },
    { name: 'Home Speaker Group', area_id: null, config_entries: ['c'], model: 'Google Cast Group' },
    { name: 'Bedroom Purifier', area_id: 'living_room', config_entries: ['vs'], model: 'Core300S' },
    { name: 'Front door doorbell', area_id: null, config_entries: ['nest'], model: 'Doorbell', identifiers: [['nest', 'enterprises/11111111-2222-3333-4444-555555555555/devices/DOORBELL1']] },
    { name: 'Garage camera', area_id: null, config_entries: ['nest'], model: 'Camera', identifiers: [['nest', 'enterprises/11111111-2222-3333-4444-555555555555/devices/GARAGE1']] },
    { name: 'Office camera', area_id: null, config_entries: ['nest'], model: 'Camera' },
  ] });
  return dir;
}

test('imports rooms, people and local device details from a Home Assistant folder', () => {
  const r = importHomeAssistant(fixture());
  assert.equal(r.home.name, 'Test Home');
  assert.equal(r.home.timezone, 'Australia/Perth');
  assert.deepEqual(r.home.people.map(p => p.name), ['Methel']);
  assert.ok(r.home.rooms.some(x => x.id === 'office'), 'room inferred from a device name');
  const kitchen = r.integrations.tuya!.devices.find(d => d.id === 'bf00')!;
  assert.equal(kitchen.host, '192.168.1.230');
  assert.deepEqual(kitchen.switches!['2'], { name: 'Kitchen Light', room: 'kitchen', type: 'light', id: 'kitchen_kitchen_light' });
  assert.equal(r.integrations.tuya!.devices.find(d => d.id === 'bf01')!.version, '3.4');
  assert.equal(r.integrations.tapo!.devices[0].room, 'living_room');
  assert.ok(r.integrations.tapo!.authHash);
  assert.equal(r.integrations.cast!.rooms!['Music Room Speaker'], 'music_room');
  assert.ok(r.report.some(l => l.includes('1 groups for synced audio') || l.includes('groups for synced audio')));
  assert.deepEqual(r.integrations.samsungtv!.tvs, [{ host: '10.0.0.20', name: 'Living Room TV', room: 'living_room', mac: 'aa:bb:cc:dd:ee:ff' }]);
  assert.equal(r.integrations.vesync!.email, 'me@example.com');
  assert.equal(r.integrations.vesync!.password, '', 'the password is never imported');
  assert.deepEqual(r.integrations.vesync!.devices, { 'Bedroom Purifier': { room: 'living_room' } });
  assert.ok(r.report.some(l => l.includes('VeSync') && l.includes('password')));
  // Nest: project, subscription and camera ids/rooms; HA's redacted token isn't a token.
  const n = r.integrations.nest!;
  const sdm = (id: string) => `enterprises/11111111-2222-3333-4444-555555555555/devices/${id}`;
  assert.equal(n.projectId, '11111111-2222-3333-4444-555555555555');
  assert.equal(n.subscription, 'projects/my-gcp/subscriptions/home-assistant-sub');
  assert.equal(n.refreshToken, '');
  assert.deepEqual(n.ids, { [sdm('DOORBELL1')]: 'doorbell', [sdm('GARAGE1')]: 'garage_cam', 'Office camera': 'office_cam' });
  assert.deepEqual(n.rooms, { [sdm('DOORBELL1')]: 'front_door', [sdm('GARAGE1')]: 'garage', 'Office camera': 'office' });
  assert.ok(r.report.some(l => l.startsWith('Google Nest') && l.includes('3 cameras') && l.includes('/api/integrations/nest/auth-url')));
  assert.ok(!r.report.some(l => l.includes('nest: not imported')));
  // VeSync waits for a password and Nest for a linked account; everything else starts.
  assert.deepEqual(adaptersFor(r.integrations, tmpdir()).map(a => a.id), ['tuya', 'tapo', 'cast', 'samsungtv']);
});

test('imports a Nest sign-in only when it is stored in plain form, and never prints it', () => {
  const r = importHomeAssistant(fixture({ token: '1//0plain-refresh-token-abcdefghijklmnop', creds: true }));
  const n = r.integrations.nest!;
  assert.equal(n.refreshToken, '1//0plain-refresh-token-abcdefghijklmnop');
  assert.equal(n.clientId, '1234-abc.apps.googleusercontent.com');
  assert.equal(n.clientSecret, 'GOCSPX-plain-client-secret');
  const text = r.report.join('\n');
  assert.ok(!text.includes('plain-refresh-token') && !text.includes('GOCSPX') && !text.includes('1234-abc'), 'no secrets in the report');
  assert.ok(adaptersFor(r.integrations, tmpdir()).some(a => a.id === 'nest'));
});
