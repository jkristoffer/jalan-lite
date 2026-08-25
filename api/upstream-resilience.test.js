
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout, fetchJson, UpstreamError } = require('./_upstream');
const route = require('./route');
const bus = require('./bus-arrivals');
const stops = require('./nearby-stops');
const location = require('./location');
const train = require('./train-realtime');

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test('aborts an upstream request when the timeout expires', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    await assert.rejects(
      fetchWithTimeout('https://upstream.test/slow', {}, { service: 'Test upstream', timeoutMs: 10 }),
      (error) => error instanceof UpstreamError && error.code === 'UPSTREAM_TIMEOUT',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('converts upstream HTTP failures to a typed safe error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ secret: 'must not escape' }, 503);

  try {
    await assert.rejects(
      fetchJson('https://upstream.test/failure', {}, { service: 'LTA BusArrival' }),
      (error) => error.code === 'UPSTREAM_HTTP'
        && error.status === 503
        && !error.message.includes('must not escape'),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('accepts a valid OneMap route envelope and rejects missing required fields', () => {
  assert.equal(route._test.isRoutePayload({
    plan: { itineraries: [{ startTime: 1, endTime: 2, legs: [] }] },
  }), true);
  assert.equal(route._test.isRoutePayload({ plan: { itineraries: [{ legs: [] }] } }), false);
  assert.equal(route._test.isRoutePayload({ plan: {} }), false);
});

test('accepts a valid LTA bus arrival payload and rejects malformed Services', () => {
  const busObject = { EstimatedArrival: '2026-08-25T01:00:00+08:00', Monitored: '1' };
  assert.equal(bus._test.isBusArrivalPayload({
    Services: [{ ServiceNo: '166', NextBus: busObject, NextBus2: null, NextBus3: null }],
  }), true);
  assert.equal(bus._test.isBusArrivalPayload({
    Services: [{ ServiceNo: '166', NextBus: { EstimatedArrival: null, Monitored: null } }],
  }), true);
  assert.equal(bus._test.isBusArrivalPayload({ Services: {} }), false);
  assert.equal(bus._test.isBusArrivalPayload({ Services: [{ ServiceNo: '166', NextBus: { EstimatedArrival: 3 } }] }), false);
});

test('accepts valid LTA bus-stop pages and rejects malformed values', () => {
  assert.equal(stops._test.isBusStopsPayload({
    value: [{ BusStopCode: '54009', Latitude: '1.38', Longitude: '103.90' }],
  }), true);
  assert.equal(stops._test.isBusStopsPayload({ value: [{ BusStopCode: '54009', Latitude: 'bad', Longitude: '103.90' }] }), false);
  assert.equal(stops._test.isBusStopsPayload({ value: {} }), false);
});

test('accepts valid OneMap location envelopes and rejects malformed results', () => {
  assert.equal(location._test.isSearchPayload({ results: [{ LATITUDE: '1.3', LONGITUDE: '103.8' }] }), true);
  assert.equal(location._test.isSearchPayload({ results: [null] }), false);
  assert.equal(location._test.isReversePayload({ GeocodeInfo: [] }), true);
  assert.equal(location._test.isReversePayload({ GeocodeInfo: {} }), false);
});

test('accepts a structurally valid GTFS-Realtime feed and rejects malformed protobuf', () => {
  const validFeed = new Uint8Array([
    0x0a, 0x05, 0x0a, 0x03, 0x32, 0x2e, 0x30,
    0x12, 0x10,
      0x0a, 0x02, 0x65, 0x31,
      0x1a, 0x0a,
        0x0a, 0x08, 0x0a, 0x02, 0x74, 0x31, 0x2a, 0x02, 0x45, 0x57,
  ]);
  const parsed = train._test.parseFeed(validFeed, 'trips');
  assert.equal(parsed.version, '2.0');
  assert.equal(parsed.entities[0].tripUpdate.tripId, 't1');
  assert.throws(() => train._test.parseFeed(new Uint8Array([0x0a, 0x01, 0x0a]), 'trips'));
});

test('returns a stable safe response for a malformed LTA bus feed', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.LTA_API_KEY;
  process.env.LTA_API_KEY = 'test-key';
  global.fetch = async () => jsonResponse({ Services: { invalid: true } });
  const result = {};
  const response = {
    setHeader() {},
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return body;
    },
  };

  try {
    await bus({ url: '/api/bus-arrivals?stopCode=54009', query: {} }, response);
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: 'LTA bus arrivals are temporarily unavailable.' });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LTA_API_KEY;
    else process.env.LTA_API_KEY = originalKey;
  }
});
