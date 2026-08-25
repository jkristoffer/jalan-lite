const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('./route-runtime.js');

test('superseding a request aborts the stale request', () => {
  const coordinator = runtime.createRequestCoordinator();
  const first = coordinator.start();
  const second = coordinator.start();

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(coordinator.hasActive(), true);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);

  coordinator.finish(second);
  assert.equal(coordinator.hasActive(), false);
  assert.equal(coordinator.isCurrent(second), false);
});

test('recognises the response envelopes used by the route and live APIs', () => {
  assert.equal(runtime.isRoutePayload({ plan: { itineraries: [] } }), true);
  assert.equal(runtime.isRoutePayload({ plan: {} }), false);
  assert.equal(runtime.isBusArrivalsPayload({ stopCode: '54009', services: [{ serviceNo: '166', arrivals: [3, 12, null] }] }), true);
  assert.equal(runtime.isBusArrivalsPayload({ stopCode: '54009', services: {} }), false);
  assert.equal(runtime.isTrainRealtimePayload({ updates: [], alerts: [] }), true);
  assert.equal(runtime.isTrainRealtimePayload({ updates: [] }), false);
  assert.equal(runtime.isNearbyStopsPayload({ nearby: [] }), true);
  assert.equal(runtime.isMapConfigPayload({ token: 'pk.example' }), true);
  assert.equal(runtime.isMapConfigPayload({ token: 'secret' }), false);
});

test('turns invalid JSON into a user-safe error', async () => {
  await assert.rejects(
    runtime.readJson({ json: async () => { throw new SyntaxError('not json'); } }, 'Routing unavailable.'),
    { message: 'Routing unavailable.' },
  );
});
