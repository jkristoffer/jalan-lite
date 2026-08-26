const { isClockTime, SCENARIOS, benchmarkAt } = require('./routing-scenarios');
const fixture = require('./lta-network-fixture');
const fixtureReplay = require('./replay-lta-fixture');
const routingBenchmark = require('./routing-benchmark');
const routingResults = require('./routing-results');

const COMPARISON_KIND = 'jalan-lta-fixture-comparison';
const COMPARISON_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function matrixKey(scenarioId, departureTime) {
  return `${scenarioId}\u0000${departureTime}`;
}

function validTimestamp(value, label) {
  const timestamp = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return Number.isFinite(Date.parse(`${value}T00:00:00+08:00`));
}

function uniqueValues(values, label) {
  const seen = new Set();
  values.forEach((value) => {
    if (seen.has(value)) throw new Error(`Snapshot ${label} contains a duplicate value: ${value}.`);
    seen.add(value);
  });
}

function snapshotMatrix(snapshot) {
  if (!isRecord(snapshot)) throw new Error('Benchmark snapshot is missing.');
  if (!validDate(snapshot.requestedDate)) throw new Error('Benchmark snapshot requestedDate must use a valid YYYY-MM-DD date.');
  if (!Array.isArray(snapshot.scenarioIds) || !snapshot.scenarioIds.length) {
    throw new Error('Benchmark snapshot scenarioIds are required for exact matrix replay.');
  }
  if (!Array.isArray(snapshot.departureTimes) || !snapshot.departureTimes.length) {
    throw new Error('Benchmark snapshot departureTimes are required for exact matrix replay.');
  }

  uniqueValues(snapshot.scenarioIds, 'scenarioIds');
  uniqueValues(snapshot.departureTimes, 'departureTimes');
  if (snapshot.departureTimes.some((time) => !isClockTime(time))) {
    throw new Error('Benchmark snapshot departureTimes must contain HH:MM values.');
  }

  const scenarios = snapshot.scenarioIds.map((scenarioId) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(`Benchmark snapshot references unknown scenario: ${scenarioId}.`);
    return scenario;
  });
  const expectedKeys = scenarios.flatMap((scenario) => snapshot.departureTimes.map((departureTime) => matrixKey(scenario.id, departureTime)));
  const expectedKeySet = new Set(expectedKeys);
  const samples = new Map();
  if (!Array.isArray(snapshot.samples) || !snapshot.samples.length) {
    throw new Error('Benchmark snapshot samples are required for exact matrix comparison.');
  }

  snapshot.samples.forEach((sample, index) => {
    if (!isRecord(sample) || !sample.scenarioId || !sample.departureTime || !sample.requestedAt) {
      throw new Error(`Benchmark snapshot sample ${index + 1} is missing matrix metadata.`);
    }
    const key = matrixKey(sample.scenarioId, sample.departureTime);
    if (!expectedKeySet.has(key)) {
      throw new Error(`Benchmark snapshot matrix mismatch: unexpected sample ${sample.scenarioId} @ ${sample.departureTime}.`);
    }
    if (samples.has(key)) {
      throw new Error(`Benchmark snapshot matrix mismatch: duplicate sample ${sample.scenarioId} @ ${sample.departureTime}.`);
    }
    const expectedAt = benchmarkAt(snapshot.requestedDate, sample.departureTime);
    if (sample.requestedAt !== expectedAt) {
      throw new Error(`Benchmark snapshot matrix mismatch: ${sample.scenarioId} @ ${sample.departureTime} has requestedAt ${sample.requestedAt}, expected ${expectedAt}.`);
    }
    samples.set(key, sample);
  });

  const missing = expectedKeys.filter((key) => !samples.has(key));
  if (missing.length || samples.size !== expectedKeys.length) {
    const labels = missing.map((key) => key.replace('\u0000', ' @ '));
    throw new Error(`Benchmark snapshot matrix mismatch: missing sample(s) ${labels.join(', ') || 'unknown'}.`);
  }

  return {
    requestedDate: snapshot.requestedDate,
    scenarioIds: [...snapshot.scenarioIds],
    departureTimes: [...snapshot.departureTimes],
    scenarios,
    expectedKeys,
    samples,
  };
}

function normalizeBestPath(pathValue) {
  if (!isRecord(pathValue)) return null;
  const minutes = finiteNumber(pathValue.estimatedTotalMinutes ?? pathValue.minutes);
  return {
    minutes,
    estimatedTotalMinutes: minutes,
    source: pathValue.source || null,
    kind: pathValue.kind || null,
    confidence: pathValue.timingConfidence || pathValue.confidence || null,
    timingConfidence: pathValue.timingConfidence || pathValue.confidence || null,
    timingSource: pathValue.timingSource || null,
    rankable: pathValue.rankable === true,
    services: Array.isArray(pathValue.services) ? pathValue.services.map((service) => String(service)) : [],
  };
}

function pathIdentity(pathValue) {
  if (!pathValue) return null;
  return JSON.stringify({ kind: pathValue.kind, services: pathValue.services });
}

function sameServices(left, right) {
  if (!left || !right) return !left && !right;
  return left.services.length === right.services.length
    && left.services.every((service, index) => service === right.services[index]);
}

function compareBestPaths(replayPath, snapshotPath) {
  const replayMinutes = replayPath?.minutes ?? null;
  const snapshotMinutes = snapshotPath?.minutes ?? null;
  const minuteDelta = Number.isFinite(replayMinutes) && Number.isFinite(snapshotMinutes)
    ? replayMinutes - snapshotMinutes
    : null;
  const replayRankable = replayPath?.rankable === true;
  const snapshotRankable = snapshotPath?.rankable === true;
  const pathAvailabilityMatch = Boolean(replayPath) === Boolean(snapshotPath);
  const pathMatch = pathIdentity(replayPath) === pathIdentity(snapshotPath);
  const sourceMatch = (replayPath?.source || null) === (snapshotPath?.source || null);
  const rankabilityMatch = replayRankable === snapshotRankable;
  const exactMinuteMatch = minuteDelta !== null && minuteDelta === 0;

  return {
    minuteDelta,
    pathMatch,
    pathAvailabilityMatch,
    sourceMatch,
    servicesMatch: sameServices(replayPath, snapshotPath),
    rankabilityMatch,
    exactMinuteMatch,
  };
}

function compactSnapshotSample(sample) {
  try {
    return routingResults.compactSample(sample);
  } catch (error) {
    throw new Error(`Invalid benchmark snapshot sample ${sample?.scenarioId || 'unknown'} @ ${sample?.departureTime || 'unknown'}: ${error.message}`);
  }
}

function compareSample(snapshotSample, replayResult, scenario = null) {
  if (!isRecord(replayResult)) throw new Error('Replay result is missing.');
  const snapshot = compactSnapshotSample(snapshotSample);
  const replay = replayResult.lta || routingBenchmark.summarizeLta({
    status: replayResult.status,
    body: replayResult.body,
    error: replayResult.error || null,
  });
  const replayPath = normalizeBestPath(replay.bestPath);
  const snapshotPath = normalizeBestPath(snapshot.lta.bestPath);
  const pathComparison = compareBestPaths(replayPath, snapshotPath);
  const snapshotOneMapOutcome = snapshot.comparison.outcome || routingBenchmark.compareSample(snapshot.oneMap, snapshot.lta).outcome;
  const replayOneMapComparison = routingBenchmark.compareSample(snapshot.oneMap, replay);

  return {
    scenarioId: snapshot.scenarioId,
    scenarioLabel: snapshot.scenarioLabel || scenario?.label || null,
    departureTime: snapshot.departureTime,
    requestedAt: snapshot.requestedAt,
    replay: {
      status: finiteNumber(replay.status),
      ok: replay.ok === true,
      bestPath: replayPath,
    },
    snapshot: {
      status: finiteNumber(snapshot.lta.status),
      ok: snapshot.lta.ok === true,
      bestPath: snapshotPath,
    },
    replayStatus: finiteNumber(replay.status),
    snapshotStatus: finiteNumber(snapshot.lta.status),
    replayBestPath: replayPath,
    snapshotBestPath: snapshotPath,
    minuteDelta: pathComparison.minuteDelta,
    comparison: {
      statusMatch: finiteNumber(replay.status) === finiteNumber(snapshot.lta.status),
      responseMatch: replay.ok === snapshot.lta.ok && finiteNumber(replay.status) === finiteNumber(snapshot.lta.status),
      ...pathComparison,
      snapshotOneMapOutcome,
      replayOneMapOutcome: replayOneMapComparison.outcome,
      oneMapOutcomeChanged: snapshotOneMapOutcome !== replayOneMapComparison.outcome,
    },
    oneMapOutcomeChanged: snapshotOneMapOutcome !== replayOneMapComparison.outcome,
  };
}

function replayMatrixMap(replayResults) {
  if (!Array.isArray(replayResults) || !replayResults.length) throw new Error('Replay produced no samples.');
  const results = new Map();
  replayResults.forEach((result, index) => {
    if (!isRecord(result) || !result.scenarioId || !result.departureTime) {
      throw new Error(`Replay result ${index + 1} is missing matrix metadata.`);
    }
    const key = matrixKey(result.scenarioId, result.departureTime);
    if (results.has(key)) throw new Error(`Replay matrix mismatch: duplicate sample ${result.scenarioId} @ ${result.departureTime}.`);
    results.set(key, result);
  });
  return results;
}

function compareMatrix(snapshot, replayResults, matrix = snapshotMatrix(snapshot)) {
  const replayByKey = replayMatrixMap(replayResults);
  const expectedKeySet = new Set(matrix.expectedKeys);
  const unexpected = [...replayByKey.keys()].filter((key) => !expectedKeySet.has(key));
  const missing = matrix.expectedKeys.filter((key) => !replayByKey.has(key));
  if (unexpected.length || missing.length || replayByKey.size !== matrix.expectedKeys.length) {
    const unexpectedLabels = unexpected.map((key) => key.replace('\u0000', ' @ '));
    const missingLabels = missing.map((key) => key.replace('\u0000', ' @ '));
    throw new Error(`Replay matrix mismatch: ${[missingLabels.length ? `missing sample(s) ${missingLabels.join(', ')}` : '', unexpectedLabels.length ? `unexpected sample(s) ${unexpectedLabels.join(', ')}` : ''].filter(Boolean).join('; ')}.`);
  }

  return matrix.expectedKeys.map((key) => {
    const sample = matrix.samples.get(key);
    const scenario = matrix.scenarios.find((candidate) => candidate.id === sample.scenarioId);
    return compareSample(sample, replayByKey.get(key), scenario);
  });
}

function rate(count, total) {
  return total ? count / total : null;
}

function matchCounts(samples, field) {
  const count = samples.filter((sample) => sample.comparison[field]).length;
  return { count, total: samples.length, rate: rate(count, samples.length) };
}

function rankedCoverage(samples, side) {
  const count = samples.filter((sample) => sample[side].bestPath?.rankable === true).length;
  const pathCount = samples.filter((sample) => Boolean(sample[side].bestPath)).length;
  return { count, pathCount, total: samples.length, rate: rate(count, samples.length) };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateComparison(samples) {
  const total = samples.length;
  const deltas = samples.map((sample) => sample.minuteDelta).filter(Number.isFinite);
  const matches = {
    status: matchCounts(samples, 'statusMatch'),
    path: matchCounts(samples, 'pathMatch'),
    pathAvailability: matchCounts(samples, 'pathAvailabilityMatch'),
    source: matchCounts(samples, 'sourceMatch'),
    services: matchCounts(samples, 'servicesMatch'),
    rankability: matchCounts(samples, 'rankabilityMatch'),
    exactMinutes: {
      count: samples.filter((sample) => sample.comparison.exactMinuteMatch).length,
      total,
      comparable: deltas.length,
      rate: rate(samples.filter((sample) => sample.comparison.exactMinuteMatch).length, deltas.length),
    },
  };
  const replayRanked = rankedCoverage(samples, 'replay');
  const snapshotRanked = rankedCoverage(samples, 'snapshot');
  const changedOutcomes = samples.filter((sample) => sample.oneMapOutcomeChanged).length;

  return {
    sampleCount: total,
    matrixCoverage: {
      replay: total,
      snapshot: total,
      matched: total,
      expected: total,
      complete: true,
      rate: rate(total, total),
    },
    rankedPathCoverage: {
      replay: replayRanked,
      snapshot: snapshotRanked,
      both: samples.filter((sample) => sample.replay.bestPath?.rankable === true && sample.snapshot.bestPath?.rankable === true).length,
    },
    statusMatches: matches.status.count,
    pathMatches: matches.path.count,
    sourceMatches: matches.source.count,
    rankabilityMatches: matches.rankability.count,
    exactMinuteMatches: matches.exactMinutes.count,
    medianMinuteDelta: median(deltas),
    minuteDeltaCoverage: { count: deltas.length, total, rate: rate(deltas.length, total) },
    oneMapOutcomeChanges: { count: changedOutcomes, total, rate: rate(changedOutcomes, total) },
    matches,
  };
}

function observationGap(fixtureCapturedAt, snapshotCapturedAt) {
  const fixtureMs = validTimestamp(fixtureCapturedAt, 'Fixture capturedAt');
  const snapshotMs = validTimestamp(snapshotCapturedAt, 'Snapshot capturedAt');
  const milliseconds = snapshotMs - fixtureMs;
  return {
    milliseconds,
    minutes: milliseconds / 60000,
    direction: milliseconds >= 0 ? 'snapshot-after-fixture' : 'snapshot-before-fixture',
  };
}

function buildReport({ fixturePath, snapshotPath, networkFixture, snapshot, replayResults }) {
  const matrix = snapshotMatrix(snapshot);
  const samples = compareMatrix(snapshot, replayResults, matrix);
  const gap = observationGap(networkFixture.capturedAt, snapshot.capturedAt);
  return {
    kind: COMPARISON_KIND,
    version: COMPARISON_VERSION,
    source: 'offline-lta-fixture-vs-recorded-snapshot',
    fixture: fixturePath,
    snapshot: snapshotPath,
    fixtureCapturedAt: networkFixture.capturedAt,
    snapshotCapturedAt: snapshot.capturedAt,
    observationGap: gap,
    observationGapMs: gap.milliseconds,
    observationGapMinutes: gap.minutes,
    requestedDate: matrix.requestedDate,
    scenarioIds: matrix.scenarioIds,
    departureTimes: matrix.departureTimes,
    samples,
    summary: aggregateComparison(samples),
    timingNote: 'Replay uses each raw BusArrival payload\'s optional busArrivalCapturedAt stop timestamp, falling back to fixture capturedAt when absent; requestedDate and departureTimes control scheduled rail.',
  };
}

async function runComparison({ fixturePath, snapshotPath } = {}) {
  if (!fixturePath) throw new Error('--fixture is required.');
  if (!snapshotPath) throw new Error('--snapshot is required.');

  const networkFixture = fixture.readFixture(fixturePath);
  const snapshot = routingResults.readResults(snapshotPath);
  fixtureReplay.captureTimestampMs(networkFixture);
  observationGap(networkFixture.capturedAt, snapshot.capturedAt);
  const matrix = snapshotMatrix(snapshot);
  const replayResults = await fixtureReplay.runFixtureMatrix(networkFixture, {
    date: matrix.requestedDate,
    scenarios: matrix.scenarios,
    departureTimes: matrix.departureTimes,
  });
  return buildReport({ fixturePath, snapshotPath, networkFixture, snapshot, replayResults });
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { fixturePath: null, snapshotPath: null, json: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--fixture') options.fixturePath = next();
    else if (argument === '--snapshot') options.snapshotPath = next();
    else if (argument === '--json') options.json = true;
    else if (argument === '--text') options.json = false;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.fixturePath) throw new Error('--fixture is required.');
  if (!options.snapshotPath) throw new Error('--snapshot is required.');
  return options;
}

function formatPath(pathValue) {
  if (!pathValue) return 'no-ranked-path';
  const minutes = pathValue.minutes === null ? 'n/a' : `${pathValue.minutes}m`;
  const services = pathValue.services.length ? `/${pathValue.services.join(',')}` : '';
  return `${minutes}/${pathValue.source || 'unknown'}/${pathValue.confidence || 'unknown'}/${pathValue.rankable ? 'rankable' : 'unranked'}${services}`;
}

function signedMinutes(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value}m`;
}

function formatReport(report) {
  const lines = [
    'LTA fixture comparison (offline)',
    `Fixture capturedAt: ${report.fixtureCapturedAt}`,
    `Snapshot capturedAt: ${report.snapshotCapturedAt}`,
    `Observation gap: ${signedMinutes(report.observationGapMinutes)} (${report.observationGap.direction})`,
    `Requested date: ${report.requestedDate}; samples: ${report.summary.sampleCount}`,
    '',
  ];
  report.samples.forEach((sample) => {
    const changed = sample.oneMapOutcomeChanged ? 'changed' : 'unchanged';
    lines.push(`${sample.scenarioId} @ ${sample.departureTime}: replay ${sample.replayStatus} ${formatPath(sample.replayBestPath)}; snapshot ${sample.snapshotStatus} ${formatPath(sample.snapshotBestPath)}; delta ${signedMinutes(sample.minuteDelta)}; OneMap ${sample.comparison.snapshotOneMapOutcome} → ${sample.comparison.replayOneMapOutcome} (${changed})`);
  });
  const summary = report.summary;
  lines.push(
    '',
    `Coverage: matrix ${summary.matrixCoverage.matched}/${summary.matrixCoverage.expected}; ranked paths replay ${summary.rankedPathCoverage.replay.count}/${summary.rankedPathCoverage.replay.total}, snapshot ${summary.rankedPathCoverage.snapshot.count}/${summary.rankedPathCoverage.snapshot.total}.`,
    `Matches: status ${summary.matches.status.count}/${summary.matches.status.total}, path ${summary.matches.path.count}/${summary.matches.path.total}, source ${summary.matches.source.count}/${summary.matches.source.total}, rankability ${summary.matches.rankability.count}/${summary.matches.rankability.total}, exact minutes ${summary.matches.exactMinutes.count}/${summary.matches.exactMinutes.comparable}.`,
    `Median minute delta: ${summary.medianMinuteDelta === null ? 'n/a' : signedMinutes(summary.medianMinuteDelta)}.`,
  );
  return lines.join('\n');
}

function helpText() {
  return [
    'Usage: node benchmarks/compare-lta-fixture.js --fixture FILE --snapshot FILE [--json|--text]',
    '',
    '  --fixture FILE         Compressed or plain raw LTA network fixture',
    '  --snapshot FILE        Compact routing benchmark result snapshot',
    '  --json                 Emit JSON (default; useful for automation)',
    '  --text                 Emit a concise human-readable report',
    '',
    'The snapshot requestedDate, scenarioIds, and departureTimes define the exact replay matrix.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await runComparison(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`LTA fixture comparison failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMPARISON_KIND,
  COMPARISON_VERSION,
  matrixKey,
  snapshotMatrix,
  normalizeBestPath,
  compareBestPaths,
  compareSample,
  compareMatrix,
  aggregateComparison,
  observationGap,
  buildReport,
  runComparison,
  parseArgs,
  formatReport,
  helpText,
};
