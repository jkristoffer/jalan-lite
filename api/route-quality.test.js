const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('./route');

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test('caps OneMap transit walking at 1200 metres by default', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      plan: { itineraries: [{ startTime: 1, endTime: 2, legs: [] }] },
    });
  };

  try {
    await route._test.requestRoute({
      token: 'test-token',
      start: '1.383486,103.900782',
      end: '1.335142,103.888389',
      date: '08-25-2026',
      time: '13:00:00',
    });
    assert.equal(new URL(requestedUrl).searchParams.get('maxWalkDistance'), '1200');
  } finally {
    global.fetch = originalFetch;
  }
});
