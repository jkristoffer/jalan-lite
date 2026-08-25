
const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateRawSync, gzipSync } = require('node:zlib');
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

function bytesResponse(value, status = 200) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function u16(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const method = entry.method || 8;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const local = joinBytes(
      u32(0x04034b50), u16(20), u16(0x08), u16(method), u16(0), u16(0),
      u32(0), u32(0), u32(0), u16(name.length), u16(0), name, compressed,
      u32(0x08074b50), u32(checksum), u32(compressed.length), u32(data.length),
    );
    const central = joinBytes(
      u32(0x02014b50), u16(20), u16(20), u16(0x08), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    );
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDirectory = joinBytes(...centrals);
  return joinBytes(
    joinBytes(...locals),
    centralDirectory,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.length), u32(offset), u16(0),
  );
}

function validTripFeed() {
  return new Uint8Array([
    0x0a, 0x05, 0x0a, 0x03, 0x32, 0x2e, 0x30,
    0x12, 0x10,
      0x0a, 0x02, 0x65, 0x31,
      0x1a, 0x0a,
        0x0a, 0x08, 0x0a, 0x02, 0x74, 0x31, 0x2a, 0x02, 0x45, 0x57,
  ]);
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
  assert.equal(bus._test.isBusArrivalPayload({ Services: [{ ServiceNo: '166', NextBus: 'invalid' }] }), false);
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
  const validFeed = validTripFeed();
  const parsed = train._test.parseFeed(validFeed, 'trips');
  assert.equal(parsed.version, '2.0');
  assert.equal(parsed.entities[0].tripUpdate.tripId, 't1');
  assert.throws(() => train._test.parseFeed(new Uint8Array([0x0a, 0x01, 0x0a]), 'trips'));
});

test('reads the current LTA ZIP index and then fetches its signed protobuf URL', async () => {
  const timestamp = '2026-08-25T01:00:00+08:00';
  const link = 'https://dmprod-datasets.s3.ap-southeast-1.amazonaws.com/train-gtfs-trip-update/gtfs_trip_update.pb?X-Amz-Signature=test';
  const index = new TextEncoder().encode(JSON.stringify({
    'odata.metadata': 'https://datamall2.mytransport.sg/ltaodataservice/GTFSRealtimeTrainTripUpdates',
    value: [{ timestamp, link }],
  }));
  const archive = makeZip([
    { name: 'GTFSRealtimeTrainTripUpdates.xml', data: new TextEncoder().encode('<?xml version="1.0"?><feed />') },
    { name: 'GTFSRealtimeTrainTripUpdates.json', data: index },
  ]);
  const feed = validTripFeed();
  assert.equal(train._test.parseFeedIndex(index).link, link);
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? bytesResponse(archive) : bytesResponse(feed);
  };

  try {
    const result = await train._test.fetchFeed('https://lta.test/trips.zip', 'test-key');
    assert.deepEqual(Array.from(result.bytes), Array.from(feed));
    assert.equal(result.timestamp, Date.parse(timestamp));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, link);
    assert.equal(calls[1].options.headers.AccountKey, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('decodes a compressed protobuf ZIP entry and rejects an unsafe LTA index link', () => {
  const feed = validTripFeed();
  const archive = makeZip([{ name: 'gtfs_trip_update.pb.gz', data: gzipSync(feed) }]);
  assert.deepEqual(Array.from(train._test.unzipFirst(archive)), Array.from(feed));

  const invalidIndex = makeZip([{
    name: 'GTFSRealtimeTrainTripUpdates.json',
    data: new TextEncoder().encode(JSON.stringify({ value: [{ timestamp: '2026-08-25T01:00:00+08:00', link: 'https://example.test/feed.pb' }] })),
  }]);
  assert.throws(() => train._test.parseFeedIndex(invalidIndex), /invalid feed link/);
});

test('bounds cold BusStops cache loading with a total deadline', async () => {
  const originalFetch = global.fetch;
  stops._test.resetCache();
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    const startedAt = Date.now();
    await assert.rejects(
      stops._test.loadStops('test-key', 20),
      (error) => error.code === 'UPSTREAM_TIMEOUT' && error.service === 'LTA BusStops',
    );
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    global.fetch = originalFetch;
    stops._test.resetCache();
  }
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
