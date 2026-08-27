const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ltaFixture = require('./lta-network-fixture');
const walkingFixture = require('./walking-network-fixture');
const capture = require('./capture-walking-fixture');
const replay = require('./replay-walking-fixture');

const SCENARIO = {
  id: 'fixture-barrier-case',
  start: { lat: 1.3, lng: 103.8 },
  end: { lat: 1.31, lng: 103.81 },
};

function emptySchedule() {
  return {
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimesByTrip: new Map(),
    calendars: new Map(),
    calendarDates: new Map(),
  };
}

function networkFixture() {
  return ltaFixture.createFixture({
    capturedAt: '2026-08-26T03:03:41.577Z',
    requestedDate: '2026-08-26',
    busStops: [
      { BusStopCode: '71008', RoadName: 'Fixture Road', Description: 'Fixture origin', Latitude: '1.3045', Longitude: '103.8' },
      { BusStopCode: '81002', RoadName: 'Fixture Road', Description: 'Fixture destination', Latitude: '1.31', Longitude: '103.8102' },
    ],
    busRoutes: [
      { ServiceNo: '53', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '71008', Distance: 0 },
      { ServiceNo: '53', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '81002', Distance: 6 },
    ],
    busServices: [],
    busArrivals: {},
    trainSchedule: emptySchedule(),
  });
}

function walkingProvider({ side }) {
  return Promise.resolve(side === 'access'
    ? { distanceMetres: 190, durationSeconds: 137 }
    : { distanceMetres: 363, durationSeconds: 262 });
}

async function measuredFixture(network = networkFixture()) {
  return capture.captureWalkingFixture({
    networkFixture: network,
    requestedDate: '2026-08-26',
    scenarios: [SCENARIO],
    walkingProvider,
  });
}

test('captures measured walking outcomes and keeps the fixture compressed', async () => {
  const measured = await measuredFixture();
  assert.equal(measured.samples.length, 2);
  assert.deepEqual(measured.samples.map((sample) => [sample.side, sample.stopCode, sample.distanceMetres]), [
    ['access', '71008', 190],
    ['egress', '81002', 363],
  ]);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalan-walking-fixture-'));
  const filePath = path.join(tempDir, 'walking.json.gz');
  try {
    walkingFixture.writeFixture(filePath, measured);
    assert.equal(fs.readFileSync(filePath).readUInt16LE(0), 0x8b1f);
    const loaded = walkingFixture.readFixture(filePath);
    assert.deepEqual(loaded.samples, measured.samples);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('replays measured walking data offline without OneMap credentials', async () => {
  const measured = await measuredFixture();
  const previous = {
    ONEMAP_ACCESS_TOKEN: process.env.ONEMAP_ACCESS_TOKEN,
    ONEMAP_TOKEN: process.env.ONEMAP_TOKEN,
    ONEMAP_EMAIL: process.env.ONEMAP_EMAIL,
    ONEMAP_PASSWORD: process.env.ONEMAP_PASSWORD,
    ONEMAP_EMAIL_PASSWORD: process.env.ONEMAP_EMAIL_PASSWORD,
  };
  Object.keys(previous).forEach((key) => delete process.env[key]);
  try {
    const [result] = await replay.runWalkingFixtureReplay(networkFixture(), measured, { scenarios: [SCENARIO] });
    assert.deepEqual(result.walkingCheck, { status: 'ready', checked: 2, failed: 0 });
    assert.equal(result.rechecked, true);
    assert.equal(result.candidates[0].totalWalkMetres, 553);
    assert.equal(result.candidates[0].walkingDistanceStatus, 'measured');
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('fails explicitly when a measured walking endpoint is missing', async () => {
  const measured = await measuredFixture();
  measured.samples = measured.samples.filter((sample) => sample.side !== 'egress');
  const partial = walkingFixture.createFixture({
    capturedAt: measured.capturedAt,
    requestedDate: measured.requestedDate,
    samples: measured.samples,
  });
  await assert.rejects(
    replay.runWalkingFixtureReplay(networkFixture(), partial, { scenarios: [SCENARIO] }),
    /missing data for fixture-barrier-case: egress 81002/,
  );
});

test('rejects measured samples with missing numeric outcomes', async () => {
  const measured = await measuredFixture();
  measured.samples[0].distanceMetres = null;
  assert.throws(() => walkingFixture.validateFixture(measured), /distanceMetres must be a finite non-negative number/);
});

test('defaults capture and replay commands to compressed walking fixtures', () => {
  const captureOptions = capture.parseArgs(['--fixture', 'network.json.gz']);
  assert.equal(captureOptions.maxEndpoints, 8);
  assert.equal(captureOptions.concurrency, 4);
  const replayOptions = replay.parseArgs(['--network-fixture', 'network.json.gz', '--walking-fixture', 'walking.json.gz']);
  assert.equal(replayOptions.maxEndpoints, 8);
  assert.match(capture.helpText(), /Compressed walking fixture/);
  assert.match(replay.helpText(), /measured walking fixture/);
});
