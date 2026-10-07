import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankMode, blankMoment, blankOverlay, endOf, endWords, modeBody, modeDraftOf, modeError, momentBody, momentDraftOf, momentError,
  momentsIn, offsetWords, overlayBody, overlayDraftOf, overlayError, setTarget, targetsOf,
} from '../src/logic/modes.ts';

test('modes: drafts, checks and bodies', () => {
  const others = [{ id: 'day', name: 'Day' }, { id: 'evening', name: 'Evening' }];
  const d = { ...blankMode(), name: '  Late   night ' };
  assert.equal(modeError({ ...d, name: ' ' }, others), 'Give the mode a name');
  assert.equal(modeError({ ...d, name: 'evening' }, others), 'There’s already a mode called evening');
  assert.equal(modeError({ ...d, name: 'Evening' }, others, 'evening'), null, 'its own name is fine');
  assert.deepEqual(modeBody(d), { name: 'Late night', icon: 'routine', color: '#dcd27e', start: { kind: 'time', at: '18:00' }, lightTheWay: false, onlyWhenSomeoneHome: false });
  assert.deepEqual(modeBody(d, 'evening'), { name: 'Late night', icon: 'routine', color: '#dcd27e', start: { kind: 'time', at: '18:00' }, copyFrom: 'evening' });
  const m = modeDraftOf({ name: 'Evening', icon: 'wb_twilight', color: '#f2b14c', rhythm: { kind: 'sun', event: 'sunset', offsetMin: -10 }, lightTheWay: true });
  assert.deepEqual(m, { name: 'Evening', icon: 'wb_twilight', color: '#f2b14c', start: { kind: 'sun', event: 'sunset', offsetMin: -10 }, lightTheWay: true, onlyWhenSomeoneHome: false });
  assert.equal(offsetWords(-10), '10 min before');
  assert.equal(offsetWords(0), 'On time');
});

test('overlays: how they end, in words; checks and bodies', () => {
  const o = { ...blankOverlay(), name: 'Reading' };
  assert.equal(overlayError(o, []), null);
  assert.equal(overlayError({ ...o, ends: { kind: 'device_off', device: '' } }, []), 'Pick the device whose switching off ends it');
  assert.equal(overlayError(o, [{ id: 'reading', name: 'READING' }]), 'There’s already an overlay called Reading');
  assert.equal(endWords({ kind: 'manual' }), 'Ends when you end it');
  assert.equal(endWords({ kind: 'arrival' }), 'Ends when someone comes home');
  assert.equal(endWords({ kind: 'time', at: { kind: 'time', at: '00:00' } }), 'Ends at midnight');
  assert.equal(endWords({ kind: 'time', at: { kind: 'time', at: '23:00' } }), 'Ends at 23:00');
  assert.equal(endWords({ kind: 'time', at: { kind: 'sun', event: 'sunrise' } }), 'Ends at sunrise');
  assert.equal(endWords({ kind: 'device_off', device: 'tv' }, () => 'Lounge TV'), 'Ends when the lounge tv turns off');
  assert.deepEqual(endOf('device_off', { kind: 'manual' }, 'tv'), { kind: 'device_off', device: 'tv' });
  assert.deepEqual(endOf('time', { kind: 'manual' }), { kind: 'time', at: { kind: 'time', at: '00:00' } });
  const keep = { kind: 'time' as const, at: { kind: 'time' as const, at: '22:00' } };
  assert.equal(endOf('time', keep), keep, 'the same kind keeps what it had');
  assert.deepEqual(overlayBody(o, 'movie'), { name: 'Reading', icon: 'layers', ends: { kind: 'manual' }, allOff: false, copyFrom: 'movie' });
  assert.deepEqual(overlayDraftOf({ name: 'Away', icon: 'flight_takeoff', ends: { kind: 'arrival' }, allOff: true }), { name: 'Away', icon: 'flight_takeoff', ends: { kind: 'arrival' }, allOff: true });
});

test('moments: need a name and a device; drafts from the snapshot leave out missing devices', () => {
  const m = { ...blankMoment(), label: ' Rain ' };
  assert.equal(momentError(m), 'Add at least one device');
  const t = setTarget(m.targets, 'speaker', { on: true, media: 'Rain', vol: 30 });
  assert.equal(momentError({ ...m, targets: t }), null);
  assert.deepEqual(momentBody({ ...m, targets: t }), { label: 'Rain', what: '', at: { kind: 'time', at: '21:00' }, targets: { speaker: { on: true, media: 'Rain', vol: 30 } } });
  assert.deepEqual(setTarget(t, 'speaker', null), {});
  const rows = [{ deviceId: 'a', name: 'A', label: 'On', target: { on: true }, missing: false }, { deviceId: 'gone', name: 'gone', label: '', target: { on: true }, missing: true }];
  assert.deepEqual(targetsOf(rows), { a: { on: true } });
  assert.deepEqual(momentDraftOf({ label: 'Porch', what: 'off', at: { kind: 'time', at: '23:00' }, targets: rows }).targets, { a: { on: true } });
  assert.deepEqual(momentsIn([{ id: 'x' }, { id: 'y' }], ['y', 'z', 'x']).map(x => x.id), ['y', 'x']);
});

test('modes: every icon offered is in the app’s icon font', async () => {
  const { MODE_ICONS, OVERLAY_ICONS } = await import('../src/logic/modes.ts');
  const { ICON_CODES } = await import('../src/ui/icon-codes.ts');
  for (const i of [...MODE_ICONS, ...OVERLAY_ICONS]) assert.ok(i in ICON_CODES, i);
});
