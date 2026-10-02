const test = require('node:test');
const assert = require('node:assert/strict');
const liveStatus = require('./route-live-status.js');

test('marks a bus leg live when LTA returns an arrival', () => {
  const status = liveStatus.statusForLeg({ mode: 'BUS', liveStatus: 'ready', live: { arrivals: [4, 12, null] }, liveUpdatedAt: '2026-08-25T00:00:00Z' }, Date.parse('2026-08-25T00:00:30Z'));
  assert.deepEqual(status, { key: 'live', label: 'Live', source: 'LTA', tone: 'live', updatedAt: '2026-08-25T00:00:00Z' });
});

test('marks a train leg scheduled when the realtime feed has no matching trip', () => {
  const status = liveStatus.statusForLeg({ mode: 'SUBWAY', trainStatus: 'ready', trainRealtime: null });
  assert.equal(status.key, 'scheduled');
  assert.equal(status.source, 'OneMap');
});

test('marks failed live feeds as fallback while retaining the OneMap source', () => {
  const status = liveStatus.statusForLeg({ mode: 'SUBWAY', trainStatus: 'error' });
  assert.deepEqual(status, { key: 'fallback', label: 'Fallback', source: 'OneMap', tone: 'fallback', updatedAt: '' });
});

test('summarizes a mixed bus and MRT route as partly live', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  const summary = liveStatus.summary({ legs: [
    { mode: 'BUS', liveStatus: 'ready', live: { arrivals: [6] }, liveUpdatedAt: now },
    { mode: 'SUBWAY', trainStatus: 'ready', trainRealtime: null },
  ] }, now);
  assert.equal(summary.key, 'partial');
  assert.equal(summary.label, 'Partly live');
});

const now = Date.parse('2026-10-02T00:00:00Z');
const bus = (extra = {}) => ({ mode: 'BUS', liveStatus: 'ready', liveUpdatedAt: now, live: { arrivals: [3, 7, 12] }, ...extra });

test('feeds over 90 seconds old cannot claim live confidence or a reachable connection', () => {
  const leg = bus();
  assert.equal(liveStatus.statusForLeg(leg, now + 90000).key, 'live');
  assert.equal(liveStatus.statusForLeg(leg, now + 90001).key, 'stale');
  assert.equal(liveStatus.hasBusLive(leg, now + 90001), false);
  assert.equal(liveStatus.summary({ legs: [leg] }, now + 90001).key, 'stale');
  assert.equal(liveStatus.reachableConnection(leg, now + 120000, now + 90001).reason, 'stale');
});

test('missing feed timestamps never imply current live data', () => {
  assert.equal(liveStatus.statusForLeg(bus({ liveUpdatedAt: '' }), now).key, 'scheduled');
  assert.equal(liveStatus.statusForLeg({ mode: 'SUBWAY', trainStatus: 'ready', trainRealtime: { departureTime: now + 600000 } }, now).key, 'scheduled');
});

test('historical train alert text remains available while stale confidence takes precedence', () => {
  const leg = { mode: 'SUBWAY', trainStatus: 'ready', liveUpdatedAt: now,
    trainRealtime: { alertText: 'Service delay', departureTime: now + 600000 } };
  assert.equal(liveStatus.statusForLeg(leg, now).key, 'alert');
  const later = now + 180000;
  assert.equal(liveStatus.statusForLeg(leg, later).key, 'stale');
  assert.equal(liveStatus.modeStatus({ legs: [leg] }, 'SUBWAY', later), 'stale');
  const freshAlert = { ...leg, liveUpdatedAt: later };
  assert.equal(liveStatus.modeStatus({ legs: [leg, freshAlert] }, 'SUBWAY', later), 'stale');
  assert.equal(liveStatus.summary({ legs: [leg, freshAlert] }, later).key, 'stale');
  assert.equal(leg.trainRealtime.alertText, 'Service delay');
});

test('connection predictions account for reaching the stop and a two minute margin', () => {
  const connection = liveStatus.reachableConnection(bus(), now + 5 * 60000, now);
  assert.equal(connection.departureAt, now + 7 * 60000);
  assert.equal(connection.waitMinutes, 2);
  assert.equal(connection.reachable, true);
  assert.equal(connection.marginMs, 120000);
  assert.equal(liveStatus.reachableConnection(bus(), now + 11 * 60000, now).reachable, false);
});

test('bus arrival countdowns remain anchored to the observation time on later refreshes', () => {
  const connection = liveStatus.reachableConnection(bus(), now + 5 * 60000, now + 60000);
  assert.equal(connection.departureAt, now + 7 * 60000);
});

test('train connection requires a boardable departure rather than a destination arrival', () => {
  const leg = { mode: 'SUBWAY', trainStatus: 'ready', liveUpdatedAt: now, trainRealtime: { departureTime: now + 8 * 60000, arrivalTime: now + 20 * 60000 } };
  assert.equal(liveStatus.reachableConnection(leg, now + 6 * 60000, now).reachable, true);
  assert.equal(liveStatus.reachableConnection(leg, now + 7 * 60000, now).reachable, false);
  assert.equal(liveStatus.reachableConnection({ ...leg, trainRealtime: { arrivalTime: now + 20 * 60000 } }, now + 6 * 60000, now).reachable, false);
});

test('formats feed age for the compact status labels', () => {
  assert.equal(liveStatus.ageLabel('2026-08-25T00:00:00Z', Date.parse('2026-08-25T00:01:05Z')), '1 min ago');
});
