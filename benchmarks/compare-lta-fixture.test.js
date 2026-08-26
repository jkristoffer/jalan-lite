const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comparator = require('./compare-lta-fixture');
const fixture = require('./lta-network-fixture');
const routingBenchmark = require('./routing-benchmark');
const routingResults = require('./routing-results');
const { SCENARIOS, benchmarkAt } = require('./routing-scenarios');

const DATE = '2026-08-25';

function pathSummary({ minutes = 40, source = 'intermodal', kind = 'bus-rail', confidence = 'medium', rankable = true, services = ['80', 'EW'] } = {}) {
  return minutes === null ? null : {
    source,
    kind,
    timingStatus: 'estimated',
    timingSource: source === 'rail' ? 'scheduled' : 'live',
    timingConfidence: confidence,
    rankable,
    estimatedTotalMinutes: minutes,
    estimatedTotalRangeMinutes: null,
    services,
  };
}

function snapshotSample({ scenarioId, departureTime, minutes = 40, source = 'intermodal', services = ['80', 'EW'] } = {}) {
  const oneMap = {
    ok: true,
    status: 200,
    error: null,
    itineraryCount: 1,
    firstMinutes: 50,
    bestMinutes: 50,
  };
  const lta = {
    ok: true,
    status: 200,
    error: null,
    railMinutes: null,
    directBus: null,
    intermodalRankable: minutes !== null,
    scheduledEstimateCount: 0,
    lowConfidenceCount: 0,
    bestPath: pathSummary({ minutes, source, services }),
  };
  return {
    scenarioId,
    scenarioLabel: SCENARIOS.find((scenario) => scenario.id === scenarioId)?.label || null,
    departureTime,
    requestedAt: benchmarkAt(DATE, departureTime),
    lta,
    oneMap,
    comparison: routingBenchmark.compareSample(oneMap, lta),
  };
}

function snapshotResults({ scenarioIds = [SCENARIOS[0].id], departureTimes = ['08:00'], samples = null, capturedAt = '2026-08-25T09:00:00.000Z' } = {}) {
  const matrixSamples = samples || scenarioIds.flatMap((scenarioId) => departureTimes.map((departureTime) => snapshotSample({ scenarioId, departureTime })));
  return routingResults.createResults({
    generatedAt: capturedAt,
    baseUrl: 'https://example.test',
    requestedDate: DATE,
    departureTimes,
    scenarioIds,
    samples: matrixSamples,
    summary: { sampleCount: matrixSamples.length },
  });
}

function replayResult({ scenarioId, departureTime, minutes = 40, source = 'intermodal', services = ['80', 'EW'] } = {}) {
  const intermodal = source === 'rail' || minutes === null ? [] : [{
    kind: 'bus-rail',
    timingStatus: 'estimated',
    timingSource: 'live',
    timingConfidence: 'medium',
    rankable: true,
    estimatedTotalMinutes: minutes,
    legs: services.map((service) => ({ serviceNo: service })),
  }];
  return {
    scenarioId,
    departureTime,
    status: 200,
    body: {
      engine: 'lta-realtime-multimodal-v3',
      rail: { candidate: source === 'rail' && minutes !== null ? {
        estimatedTotalMinutes: minutes,
        legs: services.map((service) => ({ routeId: service })),
      } : null },
      intermodal,
    },
  };
}

function emptySerializedSchedule() {
  return {
    stops: [],
    routes: [],
    trips: [],
    stopTimesByTrip: [],
    calendars: [],
    calendarDates: [],
  };
}

test('aligns replay results to the snapshot matrix and rejects partial or extra data', () => {
  const snapshot = snapshotResults({
    scenarioIds: [SCENARIOS[0].id, SCENARIOS[1].id],
    departureTimes: ['08:00', '18:00'],
  });
  const replay = [
    replayResult({ scenarioId: SCENARIOS[1].id, departureTime: '18:00' }),
    replayResult({ scenarioId: SCENARIOS[0].id, departureTime: '08:00' }),
    replayResult({ scenarioId: SCENARIOS[1].id, departureTime: '08:00' }),
    replayResult({ scenarioId: SCENARIOS[0].id, departureTime: '18:00' }),
  ];

  const samples = comparator.compareMatrix(snapshot, replay);
  assert.deepEqual(samples.map((sample) => `${sample.scenarioId}@${sample.departureTime}`), [
    `${SCENARIOS[0].id}@08:00`,
    `${SCENARIOS[0].id}@18:00`,
    `${SCENARIOS[1].id}@08:00`,
    `${SCENARIOS[1].id}@18:00`,
  ]);
  assert.throws(
    () => comparator.compareMatrix(snapshot, replay.slice(1)),
    /Replay matrix mismatch: missing sample/,
  );
  assert.throws(
    () => comparator.compareMatrix(snapshot, [...replay, replayResult({ scenarioId: SCENARIOS[2].id, departureTime: '08:00' })]),
    /Replay matrix mismatch: unexpected sample/,
  );
});

test('compares best-path source, services, minutes, and OneMap outcome changes', () => {
  const snapshot = snapshotResults({ samples: [snapshotSample({ scenarioId: SCENARIOS[0].id, departureTime: '08:00', minutes: 40 })] });
  const replay = [replayResult({
    scenarioId: SCENARIOS[0].id,
    departureTime: '08:00',
    minutes: 52,
    source: 'rail',
    services: ['EW'],
  })];
  const [sample] = comparator.compareMatrix(snapshot, replay);

  assert.equal(sample.replay.status, 200);
  assert.equal(sample.snapshot.status, 200);
  assert.equal(sample.replayBestPath.minutes, 52);
  assert.equal(sample.replayBestPath.source, 'rail');
  assert.deepEqual(sample.replayBestPath.services, ['EW']);
  assert.equal(sample.snapshotBestPath.minutes, 40);
  assert.equal(sample.snapshotBestPath.source, 'intermodal');
  assert.deepEqual(sample.snapshotBestPath.services, ['80', 'EW']);
  assert.equal(sample.minuteDelta, 12);
  assert.equal(sample.comparison.pathMatch, false);
  assert.equal(sample.comparison.sourceMatch, false);
  assert.equal(sample.comparison.rankabilityMatch, true);
  assert.equal(sample.comparison.exactMinuteMatch, false);
  assert.equal(sample.comparison.snapshotOneMapOutcome, 'lta-faster');
  assert.equal(sample.comparison.replayOneMapOutcome, 'onemap-faster');
  assert.equal(sample.oneMapOutcomeChanged, true);

  const summary = comparator.aggregateComparison([sample]);
  assert.equal(summary.matrixCoverage.matched, 1);
  assert.equal(summary.rankedPathCoverage.replay.count, 1);
  assert.equal(summary.pathMatches, 0);
  assert.equal(summary.sourceMatches, 0);
  assert.equal(summary.exactMinuteMatches, 0);
  assert.equal(summary.medianMinuteDelta, 12);
});

test('reports exact minute matches and signed fixture observation gaps', () => {
  const snapshot = snapshotResults({
    capturedAt: '2026-08-25T09:30:00.000Z',
    samples: [snapshotSample({ scenarioId: SCENARIOS[0].id, departureTime: '08:00', minutes: 40 })],
  });
  const samples = comparator.compareMatrix(snapshot, [replayResult({
    scenarioId: SCENARIOS[0].id,
    departureTime: '08:00',
    minutes: 40,
  })]);
  const summary = comparator.aggregateComparison(samples);
  assert.equal(samples[0].minuteDelta, 0);
  assert.equal(samples[0].comparison.exactMinuteMatch, true);
  assert.equal(summary.exactMinuteMatches, 1);
  assert.equal(summary.medianMinuteDelta, 0);

  assert.deepEqual(comparator.observationGap('2026-08-25T08:00:00.000Z', '2026-08-25T09:30:00.000Z'), {
    milliseconds: 90 * 60 * 1000,
    minutes: 90,
    direction: 'snapshot-after-fixture',
  });
  assert.equal(comparator.observationGap('2026-08-25T10:00:00.000Z', '2026-08-25T09:30:00.000Z').minutes, -30);
});

test('reports per-stop BusArrival timing with fixture fallback', () => {
  const snapshot = snapshotResults({ samples: [snapshotSample({ scenarioId: SCENARIOS[0].id, departureTime: '08:00' })] });
  const report = comparator.buildReport({
    fixturePath: 'fixture.json.gz',
    snapshotPath: 'snapshot.json',
    networkFixture: { capturedAt: '2026-08-25T09:00:00.000Z' },
    snapshot,
    replayResults: [replayResult({ scenarioId: SCENARIOS[0].id, departureTime: '08:00' })],
  });
  assert.equal(
    report.timingNote,
    'Replay uses each raw BusArrival payload\'s optional busArrivalCapturedAt stop timestamp, falling back to fixture capturedAt when absent; requestedDate and departureTimes control scheduled rail.',
  );
});

test('fails explicitly for missing files and invalid fixture capturedAt', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalan-lta-compare-'));
  const fixturePath = path.join(tempDir, 'fixture.json.gz');
  const snapshotPath = path.join(tempDir, 'snapshot.json');
  try {
    const networkFixture = {
      kind: fixture.FIXTURE_KIND,
      version: fixture.FIXTURE_VERSION,
      capturedAt: 'not-a-timestamp',
      requestedDate: DATE,
      busStops: [],
      busRoutes: [],
      busServices: [],
      busArrivals: {},
      trainSchedule: emptySerializedSchedule(),
    };
    fixture.writeFixture(fixturePath, networkFixture);
    routingResults.writeResults(snapshotPath, snapshotResults());

    await assert.rejects(
      comparator.runComparison({ fixturePath, snapshotPath }),
      /LTA network fixture capturedAt must be a valid timestamp for offline replay/,
    );
    await assert.rejects(
      comparator.runComparison({ fixturePath: path.join(tempDir, 'missing.json.gz'), snapshotPath }),
      /Unable to read LTA network fixture/,
    );
    await assert.rejects(
      comparator.runComparison({ fixturePath, snapshotPath: path.join(tempDir, 'missing-snapshot.json') }),
      /Unable to read benchmark results/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects a snapshot whose declared matrix is missing a sample', () => {
  const snapshot = snapshotResults({
    scenarioIds: [SCENARIOS[0].id, SCENARIOS[1].id],
    departureTimes: ['08:00'],
    samples: [snapshotSample({ scenarioId: SCENARIOS[0].id, departureTime: '08:00' })],
  });
  assert.throws(() => comparator.snapshotMatrix(snapshot), /Benchmark snapshot matrix mismatch: missing sample/);
});
