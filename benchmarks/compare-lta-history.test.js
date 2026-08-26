const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  COMPARISON_KIND,
  COMPARISON_VERSION,
  STABILITY_CRITERIA,
  aggregateHistory,
  loadComparisonReports,
  parseArgs,
} = require('./compare-lta-history');

const MATRIX = {
  scenarioIds: ['rivervale-tai-seng'],
  departureTimes: ['08:00', '18:00'],
};

function comparisonSample(departureTime, {
  pathMatch = true,
  scheduledEstimate = false,
  minuteDelta = 0,
  outcomeChanged = false,
} = {}) {
  return {
    scenarioId: 'rivervale-tai-seng',
    scenarioLabel: 'Rivervale → Tai Seng',
    departureTime,
    requestedAt: `2026-08-26T${departureTime}:00+08:00`,
    replayBestPath: { timingSource: scheduledEstimate ? 'scheduled-estimate' : 'live' },
    snapshotBestPath: { timingSource: 'live' },
    minuteDelta,
    oneMapOutcomeChanged: outcomeChanged,
    comparison: {
      pathMatch,
      oneMapOutcomeChanged: outcomeChanged,
    },
  };
}

function comparisonReport({
  requestedDate = '2026-08-26',
  observationGapMinutes = -1,
  captureOffsetMinutes = 0,
  pathMatch = true,
  scheduledEstimate = false,
  minuteDelta = 0,
  outcomeChanged = false,
  scenarioIds = MATRIX.scenarioIds,
  departureTimes = MATRIX.departureTimes,
} = {}) {
  const samples = departureTimes.map((departureTime) => comparisonSample(departureTime, {
    pathMatch,
    scheduledEstimate,
    minuteDelta,
    outcomeChanged,
  }));
  const fixtureCapturedAtMs = Date.parse('2026-08-26T04:01:00.000Z') + (captureOffsetMinutes * 60000);
  const snapshotCapturedAtMs = fixtureCapturedAtMs + (observationGapMinutes * 60000);
  return {
    kind: COMPARISON_KIND,
    version: COMPARISON_VERSION,
    requestedDate,
    scenarioIds,
    departureTimes,
    fixtureCapturedAt: new Date(fixtureCapturedAtMs).toISOString(),
    snapshotCapturedAt: new Date(snapshotCapturedAtMs).toISOString(),
    observationGap: { minutes: observationGapMinutes },
    samples,
  };
}

test('aggregates comparable reports and exposes path/fallback thresholds', () => {
  const report = aggregateHistory([
    comparisonReport({ pathMatch: true, captureOffsetMinutes: 0 }),
    comparisonReport({ pathMatch: true, captureOffsetMinutes: 1, minuteDelta: 1 }),
    comparisonReport({ pathMatch: false, captureOffsetMinutes: 2, scheduledEstimate: true, minuteDelta: -1 }),
  ]);

  assert.equal(report.status, 'hold');
  assert.equal(report.summary.comparisonCount, 3);
  assert.equal(report.summary.validComparisonCount, 3);
  assert.equal(report.summary.sampleCount, 6);
  assert.equal(report.summary.pathMatches, 4);
  assert.equal(report.summary.pathMatchRate, 4 / 6);
  assert.equal(report.summary.scheduledEstimateCount, 2);
  assert.equal(report.summary.scheduledEstimateRate, 2 / 6);
  assert.equal(report.summary.oneMapOutcomeChanges, 0);
  assert.equal(report.stabilityGate.criteria.minimumComparisons.pass, true);
  assert.equal(report.stabilityGate.criteria.pathMatchRate.pass, false);
  assert.equal(report.routerPromotion.status, 'unchanged');
  assert.equal(STABILITY_CRITERIA.maxObservationGapMinutes, 5);
});

test('surfaces but excludes a report outside the same-window gap', () => {
  const report = aggregateHistory([
    comparisonReport({ pathMatch: true, captureOffsetMinutes: 0 }),
    comparisonReport({ pathMatch: true, captureOffsetMinutes: 1 }),
    comparisonReport({ pathMatch: true, captureOffsetMinutes: 2 }),
    comparisonReport({ captureOffsetMinutes: 3, observationGapMinutes: -60, pathMatch: false, scheduledEstimate: true }),
  ]);

  assert.equal(report.summary.comparisonCount, 4);
  assert.equal(report.summary.validComparisonCount, 3);
  assert.equal(report.summary.sampleCount, 6);
  assert.equal(report.reports[3].sameWindow, false);
  assert.equal(report.reports[3].eligibleForStability, false);
  assert.equal(report.summary.pathMatches, 6);
  assert.equal(report.summary.scheduledEstimateCount, 0);
  assert.equal(report.stabilityGate.criteria.observationGapMinutes.pass, false);
});

test('holds when minimum windows, path stability, fallback, or outcome thresholds fail', () => {
  const report = aggregateHistory([
    comparisonReport({ pathMatch: false, scheduledEstimate: true, outcomeChanged: true }),
  ]);

  assert.equal(report.status, 'hold');
  assert.equal(report.stabilityGate.criteria.minimumComparisons.pass, false);
  assert.equal(report.stabilityGate.criteria.pathMatchRate.pass, false);
  assert.equal(report.stabilityGate.criteria.scheduledEstimateRate.pass, false);
  assert.equal(report.stabilityGate.criteria.oneMapOutcomeChangeRate.pass, false);
});

test('rejects matrix mismatches and malformed comparison files explicitly', () => {
  assert.throws(
    () => aggregateHistory([
      comparisonReport(),
      comparisonReport({ captureOffsetMinutes: 1, departureTimes: ['07:00', '18:00'] }),
    ]),
    /same scenarioIds and departureTimes matrix/,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalan-lta-history-'));
  try {
    const missingPath = path.join(tempDir, 'missing.json');
    assert.throws(() => loadComparisonReports([missingPath]), /Unable to read comparison report/);
    const malformedPath = path.join(tempDir, 'malformed.json');
    fs.writeFileSync(malformedPath, JSON.stringify({ kind: COMPARISON_KIND, version: COMPARISON_VERSION }));
    assert.throws(() => loadComparisonReports([malformedPath]), /requestedDate must use a valid/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects duplicate observation reports instead of inflating window count', () => {
  assert.throws(
    () => aggregateHistory([comparisonReport(), comparisonReport()]),
    /duplicate observation/,
  );
});

test('parses repeated comparison inputs and text mode', () => {
  assert.deepEqual(parseArgs(['--comparison', 'a.json', '--comparison', 'b.json', '--text']), {
    comparisonPaths: ['a.json', 'b.json'],
    json: false,
  });
  assert.throws(() => parseArgs([]), /--comparison is required/);
});
