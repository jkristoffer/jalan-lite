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
    const loaded = fixture.readFixture(filePath);
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
  await handler({
    url: '/api/realtime-route?start=1.383486,103.900782&end=1.335142,103.888389&includeSchedule=1',
    _benchmark: { ...providers, nowMs: now },
  }, response);
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

test('keeps the raw arrival payload validator available for capture tools', () => {
  assert.equal(realtimeRoute.isBusArrivalPayload({ Services: [] }), true);
  assert.equal(realtimeRoute.isBusArrivalPayload({ Services: {} }), false);
  assert.equal(trainSchedule.clockFromIso('2026-08-25T08:00:00+08:00').seconds, 8 * 3600);
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
