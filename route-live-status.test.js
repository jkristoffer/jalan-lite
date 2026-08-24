const test = require('node:test');
const assert = require('node:assert/strict');
const liveStatus = require('./route-live-status.js');

test('marks a bus leg live when LTA returns an arrival', () => {
  const status = liveStatus.statusForLeg({ mode: 'BUS', liveStatus: 'ready', live: { arrivals: [4, 12, null] }, liveUpdatedAt: '2026-08-25T00:00:00Z' });
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
  const summary = liveStatus.summary({ legs: [
    { mode: 'BUS', liveStatus: 'ready', live: { arrivals: [6] } },
    { mode: 'SUBWAY', trainStatus: 'ready', trainRealtime: null },
  ] });
  assert.equal(summary.key, 'partial');
  assert.equal(summary.label, 'Partly live');
});

test('formats feed age for the compact status labels', () => {
  assert.equal(liveStatus.ageLabel('2026-08-25T00:00:00Z', Date.parse('2026-08-25T00:01:05Z')), '1 min ago');
});
