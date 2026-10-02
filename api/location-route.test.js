const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./_onemap-auth');
const location = require('./location');
const route = require('./route');

const originalFetch = global.fetch;
const originalToken = process.env.ONEMAP_TOKEN;

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function captureResponse() {
  const result = {};
  return {
    result,
    response: {
      setHeader() {},
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        return body;
      },
    },
  };
}

async function call(handler, query, url = '') {
  const captured = captureResponse();
  await handler({ query, url }, captured.response);
  return captured.result;
}

test.beforeEach(() => {
  auth._test.resetState();
  process.env.ONEMAP_TOKEN = 'test-token';
});

test.afterEach(() => {
  global.fetch = originalFetch;
  auth._test.resetState();
  if (originalToken === undefined) delete process.env.ONEMAP_TOKEN;
  else process.env.ONEMAP_TOKEN = originalToken;
});

test('normalizes multiple search candidates with stable identities', () => {
  const source = [
    { SEARCHVAL: 'City Hall MRT', ADDRESS: '1 North Bridge Road', LATITUDE: '1.2931', LONGITUDE: '103.8520' },
    { SEARCHVAL: 'City Hall MRT', ADDRESS: '2 North Bridge Road', LATITUDE: '1.2932', LONGITUDE: '103.8521' },
  ];
  const first = location._test.normalizeSearchResults(source);
  const second = location._test.normalizeSearchResults([...source].reverse()).reverse();

  assert.equal(first.length, 2);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.deepEqual(Object.keys(first[0]).sort(), ['address', 'id', 'label', 'lat', 'lng', 'name']);
  assert.equal(first[0].label, 'City Hall MRT · 1 North Bridge Road');
});

test('location search returns all candidates and legacy first-result fields', async () => {
  global.fetch = async () => jsonResponse({
    results: [
      { SEARCHVAL: 'Orchard MRT', ADDRESS: '1 Orchard Road', LATITUDE: '1.3048', LONGITUDE: '103.8318' },
      { SEARCHVAL: 'Orchard MRT', ADDRESS: '2 Orchard Road', LATITUDE: '1.3050', LONGITUDE: '103.8320' },
    ],
  });

  const result = await call(location, { q: 'Orchard MRT' });
  assert.equal(result.status, 200);
  assert.equal(result.body.results.length, 2);
  assert.equal(result.body.label, result.body.results[0].label);
  assert.deepEqual(result.body.point, { lat: result.body.lat, lng: result.body.lng });
  assert.equal(result.body.lat, result.body.results[0].lat);
});

test('location search distinguishes empty and unusable candidate responses', async () => {
  global.fetch = async () => jsonResponse({ results: [] });
  const empty = await call(location, { q: 'nowhere' });
  assert.equal(empty.status, 404);

  global.fetch = async () => jsonResponse({ results: [{ SEARCHVAL: 'Invalid', LATITUDE: '', LONGITUDE: '103.8' }] });
  const invalid = await call(location, { q: 'invalid' });
  assert.equal(invalid.status, 502);
});

test('route validates ISO dates and rejects an expired scheduled journey before upstream access', async () => {
  assert.equal(route._test.parseIsoDate('2026-02-30'), null);
  assert.equal(route._test.parseIsoDate('2026-10-04').api, '10-04-2026');

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ plan: { itineraries: [{ startTime: 1, endTime: 2, legs: [] }] } });
  };
  const result = await call(route, {
    start: '1.3000,103.8000',
    end: '1.3100,103.8100',
    date: '2026-10-04',
    time: '08:00',
    requestedClock: '2026-10-04T09:00:00+08:00',
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /future|scheduled/i);
  assert.equal(calls, 0);
});

test('route interprets an explicit future date and midnight in Singapore across a non-Singapore clock', async () => {
  const requests = [];
  global.fetch = async (url) => {
    requests.push(new URL(url));
    return jsonResponse({ plan: { itineraries: [{ startTime: 1, endTime: 2, legs: [] }] } });
  };
  const departure = await call(route, {
    start: '1.3000,103.8000',
    end: '1.3100,103.8100',
    date: '2026-10-04',
    time: '06:30',
    timeMode: 'depart',
    requestedClock: '2026-10-03T16:45:00-05:00',
  });

  assert.equal(departure.status, 200);
  assert.equal(requests[0].searchParams.get('date'), '10-04-2026');
  assert.equal(requests[0].searchParams.get('time'), '06:30:00');
  assert.equal(departure.body._jalan.requestedDate, '10-04-2026');

  requests.length = 0;
  const target = route._test.sgTimestampFromIsoDate('2026-10-05', '00:30');
  global.fetch = async (url) => {
    requests.push(new URL(url));
    return jsonResponse({
      plan: {
        itineraries: [{ startTime: target - 900000, endTime: target - 600000, legs: [] }],
      },
    });
  };
  const arrival = await call(route, {
    start: '1.3000,103.8000',
    end: '1.3100,103.8100',
    date: '2026-10-05',
    time: '00:30',
    timeMode: 'arrive',
    requestedClock: '2026-10-04T08:00:00-05:00',
  });

  assert.equal(arrival.status, 200);
  assert.equal(arrival.body._jalan.timeMode, 'arrive');
  assert.ok(requests.some((url) => url.searchParams.get('date') === '10-04-2026'));
  assert.ok(requests.some((url) => url.searchParams.get('date') === '10-05-2026'));
});
