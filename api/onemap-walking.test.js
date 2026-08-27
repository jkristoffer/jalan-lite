const test = require('node:test');
const assert = require('node:assert/strict');
const walking = require('./onemap-walking');

test('extracts walking distance and duration from a OneMap route envelope', () => {
  const result = walking.walkingResult({
    plan: {
      itineraries: [{
        duration: 420,
        legs: [{ mode: 'WALK', distance: 525, duration: 420 }],
      }],
    },
  });
  assert.deepEqual(result, { distanceMetres: 525, durationSeconds: 420 });
});

test('extracts walking distance and duration from the native OneMap route summary', () => {
  const payload = {
    status: 0,
    status_message: 'Found route between points',
    route_summary: { total_distance: 363, total_time: 900 },
    route_instructions: [['Walk', '0 m', '363 m']],
  };
  assert.equal(walking.isRoutePayload(payload), true);
  assert.deepEqual(walking.walkingResult(payload), { distanceMetres: 363, durationSeconds: 900 });
});

test('requests a walking route without exposing the authorization value', async () => {
  const originalFetch = global.fetch;
  let requestUrl = null;
  let requestOptions = null;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 0,
        status_message: 'Found route between points',
        route_summary: { total_distance: 375, total_time: 300 },
        route_instructions: [],
      }),
    };
  };

  try {
    const result = await walking.fetchWalkingDistance({
      token: 'test-onemap-token',
      start: { lat: 1.3, lng: 103.8 },
      end: { lat: 1.31, lng: 103.81 },
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    const url = new URL(requestUrl);
    assert.deepEqual(result, { distanceMetres: 375, durationSeconds: 300 });
    assert.equal(url.searchParams.get('routeType'), 'walk');
    assert.equal(url.searchParams.get('mode'), 'WALK');
    assert.equal(url.searchParams.get('numItineraries'), '1');
    assert.equal(requestOptions.headers.Authorization, 'test-onemap-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects a walking response with no usable distance', () => {
  assert.equal(walking.walkingResult({ plan: { itineraries: [{ legs: [] }] } }), null);
});

test('rejects native walking responses with missing route data', () => {
  const payload = {
    status: 0,
    status_message: 'Found route between points',
    route_summary: { total_time: 900 },
    route_instructions: [],
  };
  assert.equal(walking.isRoutePayload(payload), false);
  assert.equal(walking.walkingResult(payload), null);
  assert.equal(walking.isRoutePayload({
    ...payload,
    route_summary: { total_distance: 363, total_time: 900 },
    route_instructions: null,
  }), false);
  assert.equal(walking.isRoutePayload({
    ...payload,
    route_summary: { total_distance: null, total_time: 900 },
  }), false);
});
