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
        plan: {
          itineraries: [{ duration: 300, legs: [{ mode: 'WALK', distance: 375, duration: 300 }] }],
        },
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
