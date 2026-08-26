const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const realtimeRoute = require('../api/realtime-route')._test;
const trainSchedule = require('../train-schedule')._shared;
const fixture = require('./lta-network-fixture');
const fixtureReplay = require('./replay-lta-fixture');
const capture = require('./capture-lta-fixture');

function scheduleFixture() {
  return {
    stops: new Map([
      ['A', { id: 'A', name: 'Alpha', lat: 1.30, lng: 103.80, parentStation: '', locationType: 1 }],
      ['B', { id: 'B', name: 'Bravo', lat: 1.31, lng: 103.81, parentStation: '', locationType: 1 }],
      ['C', { id: 'C', name: 'Central', lat: 1.32, lng: 103.82, parentStation: '', locationType: 1 }],
      ['D', { id: 'D', name: 'Delta', lat: 1.33, lng: 103.83, parentStation: '', locationType: 1 }],
    ]),
    routes: new Map([['R1', { id: 'R1', shortName: 'R1', longName: '', type: 1 }]]),
    trips: new Map([['T1', { id: 'T1', routeId: 'R1', serviceId: 'WK', directionId: 0 }]]),
    stopTimesByTrip: new Map([['T1', [
      { stopId: 'A', sequence: 1, arrival: 8 * 3600, departure: 8 * 3600 },
      { stopId: 'B', sequence: 2, arrival: 8 * 3600 + 300, departure: 8 * 3600 + 300 },
      { stopId: 'D', sequence: 3, arrival: 8 * 3600 + 600, departure: 8 * 3600 + 600 },
    ]]]),
    calendars: new Map([['WK', { service_id: 'WK', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '1', sunday: '1', start_date: '20260101', end_date: '20261231' }]]),
    calendarDates: new Map(),
    graphCache: new Map(),
    stationCache: null,
  };
}

function networkFixture(now) {
  return fixture.createFixture({
    capturedAt: '2026-08-25T08:00:00.000Z',
    requestedDate: '2026-08-25',
    busStops: [
      { BusStopCode: '65029', RoadName: 'Fixture Road', Description: 'Fixture origin', Latitude: '1.383486', Longitude: '103.900782' },
      { BusStopCode: '70289', RoadName: 'Fixture Road', Description: 'Fixture destination', Latitude: '1.335142', Longitude: '103.888389' },
    ],
    busRoutes: [
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0, WD_FirstBus: '0530', WD_LastBus: '2330' },
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '70289', Distance: 8 },
    ],
    busServices: [{
      ServiceNo: '80', Operator: 'SBST', Direction: 1,
      AM_Offpeak_Freq: '10-12', PM_Offpeak_Freq: '10-12',
      WD_FirstBus: '0530', WD_LastBus: '2330',
    }],
    busArrivals: {
      '65029': {
        Services: [{
          ServiceNo: '80',
          NextBus: { EstimatedArrival: new Date(now + 4 * 60000).toISOString(), Monitored: '1' },
          NextBus2: null,
          NextBus3: null,
        }],
      },
    },
    busArrivalCapturedAt: { '65029': new Date(now).toISOString() },
    trainSchedule: scheduleFixture(),
  });
}

test('round-trips compressed source fixtures and exposes injectable providers', async () => {
  const now = Date.parse('2026-08-25T08:00:00+08:00');
  const saved = networkFixture(now);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalan-lta-fixture-'));
  const filePath = path.join(tempDir, 'fixture.json.gz');
  try {
    fixture.writeFixture(filePath, saved);
    assert.equal(fs.readFileSync(filePath).readUInt16LE(0), 0x8b1f);
    const loaded = fixture.readFixture(filePath);
    assert.equal(loaded.busArrivalCapturedAt['65029'], new Date(now).toISOString());
    const providers = fixture.createProviders(loaded);
    const arrivals = await providers.arrivalProvider({ stopCode: '65029', now });
    const schedule = await providers.scheduleProvider();
    assert.deepEqual(arrivals.get('80'), { arrivals: [4, null, null], monitored: [true, false, false] });
    assert.equal(schedule.stops.get('A').name, 'Alpha');
    assert.equal(schedule.stopTimesByTrip.get('T1').length, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails explicitly when a replay requests an uncaptured arrival stop', async () => {
  const now = Date.parse('2026-08-25T08:00:00+08:00');
  const providers = fixture.createProviders(networkFixture(now));
  await assert.rejects(
    providers.arrivalProvider({ stopCode: '70289', now }),
    /missing BusArrival data for stop 70289/,
  );
});

test('fails the offline route replay when required arrival data is missing', async () => {
  const network = networkFixture(Date.parse('2026-08-25T08:00:00+08:00'));
  network.busArrivals = {};
  await assert.rejects(
    fixtureReplay.runFixtureRoute(
      network,
      { start: { lat: 1.383486, lng: 103.900782 }, end: { lat: 1.335142, lng: 103.888389 } },
      '2026-08-25',
      '08:00',
    ),
    /missing BusArrival data for stop\(s\): 65029/,
  );
});

test('runs the bus router offline from raw fixture inputs without an LTA key', async () => {
  const now = Date.parse('2026-08-25T08:00:00+08:00');
  const providers = fixture.createProviders(networkFixture(now));
  const result = {};
  const response = {
    setHeader() {},
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return body; },
  };
  const handler = require('../api/realtime-route');
  const previousApiKey = process.env.LTA_API_KEY;
  delete process.env.LTA_API_KEY;
  try {
    await handler({
      url: '/api/realtime-route?start=1.383486,103.900782&end=1.335142,103.888389&includeSchedule=1',
      _benchmark: { ...providers, nowMs: now },
    }, response);
  } finally {
    if (previousApiKey === undefined) delete process.env.LTA_API_KEY;
    else process.env.LTA_API_KEY = previousApiKey;
  }
  assert.equal(result.status, 200);
  assert.equal(result.body.candidates[0].serviceNo, '80');
  assert.equal(result.body.candidates[0].liveStatus, 'ready');
  assert.equal(result.body.candidates[0].arrivals[0], 4);
});

test('replays scheduled rail from the same source fixture seam', async () => {
  const network = networkFixture(Date.parse('2026-08-25T08:00:00+08:00'));
  const scenario = {
    start: { lat: 1.30, lng: 103.80 },
    end: { lat: 1.33, lng: 103.83 },
  };
  const result = await fixtureReplay.runFixtureRoute(network, scenario, '2026-08-25', '08:00');
  assert.equal(result.status, 200);
  assert.equal(result.body.rail.candidate.legs[0].routeId, 'R1');
});

test('uses fixture capture time for live arrivals while requested time drives scheduled rail', async () => {
  const capturedAt = '2026-08-25T09:36:29.315Z';
  const network = networkFixture(Date.parse(capturedAt));
  network.capturedAt = capturedAt;
  delete network.busArrivalCapturedAt;
  const busResult = await fixtureReplay.runFixtureRoute(
    network,
    { start: { lat: 1.383486, lng: 103.900782 }, end: { lat: 1.335142, lng: 103.888389 } },
    '2026-08-25',
    '08:00',
  );
  assert.equal(busResult.body.bus.candidates[0].arrivals[0], 4);

  const railResult = await fixtureReplay.runFixtureRoute(
    network,
    { start: { lat: 1.30, lng: 103.80 }, end: { lat: 1.33, lng: 103.83 } },
    '2026-08-25',
    '08:00',
  );
  assert.equal(railResult.body.rail.candidate.legs[0].routeId, 'R1');
});

test('uses stop-specific capture time over a later provider clock', async () => {
  const capturedAt = Date.parse('2026-08-25T08:00:00.000Z');
  const network = networkFixture(capturedAt);
  const providers = fixture.createProviders(network);
  const arrivals = await providers.arrivalProvider({
    stopCode: '65029',
    now: capturedAt + 60 * 60000,
  });
  assert.deepEqual(arrivals.get('80').arrivals, [4, null, null]);
});

test('rejects invalid per-stop capture metadata instead of normalizing with NaN', () => {
  const network = networkFixture(Date.parse('2026-08-25T08:00:00.000Z'));
  network.busArrivalCapturedAt['65029'] = Date.parse('2026-08-25T08:00:00.000Z');
  assert.throws(
    () => fixture.validateFixture(network),
    /busArrivalCapturedAt for stop 65029 must be a valid timestamp/,
  );
});

test('requires a valid fixture capture timestamp for offline replay', () => {
  assert.throws(() => fixtureReplay.captureTimestampMs({}), /capturedAt must be a valid timestamp/);
  assert.throws(() => fixtureReplay.captureTimestampMs({ capturedAt: 'not-a-timestamp' }), /capturedAt must be a valid timestamp/);
});

test('keeps the raw arrival payload validator available for capture tools', () => {
  assert.equal(realtimeRoute.isBusArrivalPayload({ Services: [] }), true);
  assert.equal(realtimeRoute.isBusArrivalPayload({ Services: {} }), false);
  assert.equal(trainSchedule.clockFromIso('2026-08-25T08:00:00+08:00').seconds, 8 * 3600);
});

test('keeps capture output compressed by default and explicit stops additive', () => {
  const options = capture.parseArgs(['--stops', '65029,77009']);
  assert.match(options.output, /\.json\.gz$/);
  assert.deepEqual(options.arrivalStops, ['65029', '77009']);
  assert.match(capture.helpText(), /Additional BusArrival stops/);
});

test('discovers candidate boarding and transfer stops from selected static routes', () => {
  const network = networkFixture(Date.parse('2026-08-25T08:00:00+08:00'));
  const discovered = capture.discoverArrivalStops({
    busStops: network.busStops,
    busRoutes: [
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 },
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '70289', Distance: 8 },
      { ServiceNo: '82', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 },
      { ServiceNo: '82', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '77009', Distance: 3 },
      { ServiceNo: '3', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '77009', Distance: 0 },
      { ServiceNo: '3', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '70289', Distance: 4 },
    ],
    scenarios: [{ start: { lat: 1.383486, lng: 103.900782 }, end: { lat: 1.335142, lng: 103.888389 } }],
  });
  assert.deepEqual(discovered, ['65029', '77009']);
});

test('discovers boarding and transfer stops for station connector subroutes', () => {
  const discovered = capture.discoverArrivalStops({
    busStops: [
      { BusStopCode: '65029', RoadName: 'Fixture Road', Description: 'Fixture origin', Latitude: '1.30', Longitude: '103.80' },
      { BusStopCode: '77009', RoadName: 'Fixture Road', Description: 'Connector station', Latitude: '1.33', Longitude: '103.83' },
      { BusStopCode: '70289', RoadName: 'Fixture Road', Description: 'Fixture destination', Latitude: '1.34', Longitude: '103.84' },
    ],
    busRoutes: [
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 },
      { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '70289', Distance: 8 },
      { ServiceNo: '90', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '77009', Distance: 0 },
      { ServiceNo: '90', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '67169', Distance: 3 },
      { ServiceNo: '91', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '67169', Distance: 0 },
      { ServiceNo: '91', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '70289', Distance: 4 },
    ],
    schedule: scheduleFixture(),
    scenarios: [{ start: { lat: 1.30, lng: 103.80 }, end: { lat: 1.34, lng: 103.84 } }],
  });
  assert.deepEqual(discovered, ['65029', '77009', '67169']);
});

test('limits static capture to the fixed journey neighbourhood by default', () => {
  const network = networkFixture(Date.parse('2026-08-25T08:00:00+08:00'));
  const selected = capture.selectStaticNetwork({
    busStops: network.busStops,
    busRoutes: network.busRoutes,
    busServices: network.busServices,
    schedule: scheduleFixture(),
    scenarios: [{ start: { lat: 1.383486, lng: 103.900782 }, end: { lat: 1.335142, lng: 103.888389 } }],
  });
  assert.equal(selected.busStops.length, 2);
  assert.equal(selected.busRoutes.length, 2);
  assert.equal(selected.busServices.length, 1);
  assert.equal(selected.scope.routePatterns, 1);
});
