const fs = require('node:fs');
const path = require('node:path');

const { isClockTime } = require('./routing-scenarios');

const COMPARISON_KIND = 'jalan-lta-fixture-comparison';
const COMPARISON_VERSION = 1;
const HISTORY_KIND = 'jalan-lta-fixture-stability';
const HISTORY_VERSION = 1;

const STABILITY_CRITERIA = Object.freeze({
  minimumComparisons: 3,
  maxObservationGapMinutes: 5,
  minPathMatchRate: 0.9,
  maxScheduledEstimateRate: 0.25,
  maxOneMapOutcomeChangeRate: 0,
});

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

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    && Number.isFinite(Date.parse(`${value}T00:00:00+08:00`));
}

function validTimestamp(value, label) {
  const timestamp = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp;
}

function rate(count, total) {
  return total ? count / total : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matrixSignature(scenarioIds, departureTimes) {
  return JSON.stringify({
    scenarioIds: [...scenarioIds].sort(),
    departureTimes: [...departureTimes].sort(),
  });
}

function validateMatrix(report, sourceLabel) {
  if (!validDate(report.requestedDate)) {
    throw new Error(`${sourceLabel} requestedDate must use a valid YYYY-MM-DD date.`);
  }
  if (!Array.isArray(report.scenarioIds) || !report.scenarioIds.length) {
    throw new Error(`${sourceLabel} scenarioIds are required.`);
  }
  if (!Array.isArray(report.departureTimes) || !report.departureTimes.length) {
    throw new Error(`${sourceLabel} departureTimes are required.`);
  }
  if (report.scenarioIds.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`${sourceLabel} scenarioIds must contain non-empty strings.`);
  }
  if (report.departureTimes.some((value) => !isClockTime(value))) {
    throw new Error(`${sourceLabel} departureTimes must contain HH:MM values.`);
  }
  const scenarioIds = new Set(report.scenarioIds);
  const departureTimes = new Set(report.departureTimes);
  if (scenarioIds.size !== report.scenarioIds.length) throw new Error(`${sourceLabel} scenarioIds contain duplicates.`);
  if (departureTimes.size !== report.departureTimes.length) throw new Error(`${sourceLabel} departureTimes contain duplicates.`);

  if (!Array.isArray(report.samples) || !report.samples.length) {
    throw new Error(`${sourceLabel} samples are required.`);
  }
  const expectedKeys = report.scenarioIds.flatMap((scenarioId) => report.departureTimes.map((departureTime) => matrixKey(scenarioId, departureTime)));
  const expectedKeySet = new Set(expectedKeys);
  const samples = new Map();
  report.samples.forEach((sample, index) => {
    if (!isRecord(sample) || !sample.scenarioId || !sample.departureTime || !sample.requestedAt) {
      throw new Error(`${sourceLabel} sample ${index + 1} is missing matrix metadata.`);
    }
    const key = matrixKey(sample.scenarioId, sample.departureTime);
    if (!expectedKeySet.has(key)) throw new Error(`${sourceLabel} has an unexpected sample ${sample.scenarioId} @ ${sample.departureTime}.`);
    if (samples.has(key)) throw new Error(`${sourceLabel} has a duplicate sample ${sample.scenarioId} @ ${sample.departureTime}.`);
    if (!isRecord(sample.comparison)) throw new Error(`${sourceLabel} sample ${index + 1} is missing comparison data.`);
    samples.set(key, sample);
  });
  const missing = expectedKeys.filter((key) => !samples.has(key));
  if (missing.length || samples.size !== expectedKeys.length) {
    throw new Error(`${sourceLabel} matrix is incomplete; missing ${missing.map((key) => key.replace('\u0000', ' @ ')).join(', ') || 'unknown sample(s)'}.`);
  }
  return {
    scenarioIds: [...report.scenarioIds],
    departureTimes: [...report.departureTimes],
    samples: expectedKeys.map((key) => samples.get(key)),
    signature: matrixSignature(report.scenarioIds, report.departureTimes),
  };
}

function sampleMetrics(samples) {
  const deltas = samples.map((sample) => finiteNumber(sample.minuteDelta)).filter(Number.isFinite);
  const pathMatches = samples.filter((sample) => sample.comparison.pathMatch === true).length;
  const scheduledEstimates = samples.filter((sample) => sample.replayBestPath?.timingSource === 'scheduled-estimate').length;
  const outcomeChanges = samples.filter((sample) => sample.oneMapOutcomeChanged === true || sample.comparison.oneMapOutcomeChanged === true).length;
  return {
    sampleCount: samples.length,
    pathMatches,
    pathMatchRate: rate(pathMatches, samples.length),
    scheduledEstimateCount: scheduledEstimates,
    scheduledEstimateRate: rate(scheduledEstimates, samples.length),
    oneMapOutcomeChanges: outcomeChanges,
    oneMapOutcomeChangeRate: rate(outcomeChanges, samples.length),
    minuteDeltaCount: deltas.length,
    medianMinuteDelta: median(deltas),
  };
}

function validateComparisonReport(report, sourceLabel = 'Comparison report') {
  if (!isRecord(report)) throw new Error(`${sourceLabel} must be an object.`);
  if (report.kind !== COMPARISON_KIND) throw new Error(`${sourceLabel} has unsupported kind: ${report.kind || 'missing'}.`);
  if (report.version !== COMPARISON_VERSION) throw new Error(`${sourceLabel} has unsupported version: ${report.version || 'missing'}.`);
  const matrix = validateMatrix(report, sourceLabel);
  const fixtureCapturedAtMs = validTimestamp(report.fixtureCapturedAt, `${sourceLabel} fixtureCapturedAt`);
  const snapshotCapturedAtMs = validTimestamp(report.snapshotCapturedAt, `${sourceLabel} snapshotCapturedAt`);
  const observationGapMinutes = finiteNumber(report.observationGap?.minutes);
  if (observationGapMinutes === null) throw new Error(`${sourceLabel} observationGap.minutes is required.`);
  const calculatedGapMinutes = (snapshotCapturedAtMs - fixtureCapturedAtMs) / 60000;
  if (Math.abs(calculatedGapMinutes - observationGapMinutes) > 0.01) {
    throw new Error(`${sourceLabel} observationGap.minutes does not match its capture timestamps.`);
  }
  const metrics = sampleMetrics(matrix.samples);
  return {
    report,
    sourceLabel,
    requestedDate: report.requestedDate,
    fixtureCapturedAt: report.fixtureCapturedAt,
    snapshotCapturedAt: report.snapshotCapturedAt,
    fixtureCapturedAtMs,
    snapshotCapturedAtMs,
    observationGapMinutes,
    matrix,
    metrics,
  };
}

function readComparisonReport(filePath) {
  const absolutePath = path.resolve(String(filePath));
  let value;
  try {
    value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read comparison report ${absolutePath}: ${error.message}`);
  }
  return validateComparisonReport(value, `Comparison report ${absolutePath}`);
}

function loadComparisonReports(filePaths) {
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('At least one --comparison file is required.');
  return filePaths.map(readComparisonReport);
}

function criterion(threshold, actual, pass) {
  return { threshold, actual, pass };
}

function aggregateHistory(inputReports, criteria = STABILITY_CRITERIA) {
  if (!Array.isArray(inputReports) || !inputReports.length) throw new Error('At least one comparison report is required.');
  const reports = inputReports.map((value, index) => value?.matrix ? value : validateComparisonReport(value, `Comparison report ${index + 1}`));
  const observationKeys = new Set();
  reports.forEach((value) => {
    const observationKey = `${value.fixtureCapturedAt}\u0000${value.snapshotCapturedAt}`;
    if (observationKeys.has(observationKey)) throw new Error(`Comparison reports contain a duplicate observation: ${value.fixtureCapturedAt}.`);
    observationKeys.add(observationKey);
  });
  const firstSignature = reports[0].matrix.signature;
  if (reports.some((value) => value.matrix.signature !== firstSignature)) {
    throw new Error('Comparison reports must use the same scenarioIds and departureTimes matrix.');
  }

  const reportRows = reports.map((value) => {
    const sameWindow = Math.abs(value.observationGapMinutes) <= criteria.maxObservationGapMinutes;
    return {
      source: value.sourceLabel,
      requestedDate: value.requestedDate,
      fixtureCapturedAt: value.fixtureCapturedAt,
      snapshotCapturedAt: value.snapshotCapturedAt,
      observationGapMinutes: value.observationGapMinutes,
      sameWindow,
      matrixComplete: true,
      eligibleForStability: sameWindow,
      ...value.metrics,
    };
  });
  const validReports = reports.filter((value) => Math.abs(value.observationGapMinutes) <= criteria.maxObservationGapMinutes);
  const validSamples = validReports.flatMap((value) => value.matrix.samples);
  const metrics = sampleMetrics(validSamples);
  const completeMatrixRate = rate(reports.length, reports.length);
  const sameWindowRate = rate(validReports.length, reports.length);
  const maxObservationGapMinutes = reports.reduce((maximum, value) => Math.max(maximum, Math.abs(value.observationGapMinutes)), 0);

  const evaluatedCriteria = {
    minimumComparisons: criterion(criteria.minimumComparisons, validReports.length, validReports.length >= criteria.minimumComparisons),
    completeMatrixRate: criterion(1, completeMatrixRate, completeMatrixRate === 1),
    observationGapMinutes: criterion(criteria.maxObservationGapMinutes, maxObservationGapMinutes, sameWindowRate === 1),
    pathMatchRate: criterion(criteria.minPathMatchRate, metrics.pathMatchRate, metrics.pathMatchRate !== null && metrics.pathMatchRate >= criteria.minPathMatchRate),
    scheduledEstimateRate: criterion(criteria.maxScheduledEstimateRate, metrics.scheduledEstimateRate, metrics.scheduledEstimateRate !== null && metrics.scheduledEstimateRate <= criteria.maxScheduledEstimateRate),
    oneMapOutcomeChangeRate: criterion(criteria.maxOneMapOutcomeChangeRate, metrics.oneMapOutcomeChangeRate, metrics.oneMapOutcomeChangeRate !== null && metrics.oneMapOutcomeChangeRate <= criteria.maxOneMapOutcomeChangeRate),
  };
  const status = Object.values(evaluatedCriteria).every((value) => value.pass) ? 'eligible' : 'hold';
  const scenarioIds = [...reports[0].matrix.scenarioIds];
  const departureTimes = [...reports[0].matrix.departureTimes];

  return {
    kind: HISTORY_KIND,
    version: HISTORY_VERSION,
    gate: 'stability-advisory',
    status,
    scenarioIds,
    departureTimes,
    criteria: { ...criteria },
    reports: reportRows,
    summary: {
      comparisonCount: reports.length,
      validComparisonCount: validReports.length,
      sampleCount: metrics.sampleCount,
      matrixCoverage: {
        complete: completeMatrixRate === 1,
        completeComparisonCount: reports.length,
        comparisonCount: reports.length,
        rate: completeMatrixRate,
      },
      sameWindowCoverage: {
        validComparisonCount: validReports.length,
        comparisonCount: reports.length,
        rate: sameWindowRate,
      },
      pathMatches: metrics.pathMatches,
      pathMatchRate: metrics.pathMatchRate,
      scheduledEstimateCount: metrics.scheduledEstimateCount,
      scheduledEstimateRate: metrics.scheduledEstimateRate,
      oneMapOutcomeChanges: metrics.oneMapOutcomeChanges,
      oneMapOutcomeChangeRate: metrics.oneMapOutcomeChangeRate,
      minuteDeltaCoverage: {
        count: metrics.minuteDeltaCount,
        total: metrics.sampleCount,
        rate: rate(metrics.minuteDeltaCount, metrics.sampleCount),
      },
      medianMinuteDelta: metrics.medianMinuteDelta,
      maxObservationGapMinutes,
    },
    stabilityGate: {
      status,
      criteria: evaluatedCriteria,
    },
    routerPromotion: {
      status: 'unchanged',
      note: 'This advisory stability gate does not promote or alter the user-facing router or the compact benchmark promotion gate.',
    },
  };
}

function signedMinutes(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value}m`;
}

function formatReport(report) {
  const lines = [
    'LTA fixture stability history (offline)',
    `Gate: ${report.status.toUpperCase()} (advisory; router promotion unchanged)`,
    `Matrix: ${report.scenarioIds.length} scenarios × ${report.departureTimes.length} times; valid samples ${report.summary.sampleCount}`,
    '',
  ];
  report.reports.forEach((entry) => {
    lines.push(`${entry.requestedDate}: gap ${signedMinutes(entry.observationGapMinutes)}, ${entry.sameWindow ? 'same-window' : 'excluded-large-gap'}, ${entry.pathMatches}/${entry.sampleCount} paths, ${entry.scheduledEstimateCount}/${entry.sampleCount} scheduled estimates`);
  });
  const summary = report.summary;
  lines.push(
    '',
    `Valid comparisons: ${summary.validComparisonCount}/${summary.comparisonCount}; path stability ${summary.pathMatches}/${summary.sampleCount} (${summary.pathMatchRate === null ? 'n/a' : `${Math.round(summary.pathMatchRate * 100)}%`});`,
    `Scheduled-estimate fallback: ${summary.scheduledEstimateCount}/${summary.sampleCount}; OneMap outcome changes: ${summary.oneMapOutcomeChanges}/${summary.sampleCount}; median replay delta: ${signedMinutes(summary.medianMinuteDelta)}.`,
    `Criteria: ${Object.entries(report.stabilityGate.criteria).map(([name, value]) => `${name} ${value.pass ? 'PASS' : 'HOLD'}`).join(', ')}.`,
  );
  return lines.join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { comparisonPaths: [], json: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--comparison') options.comparisonPaths.push(next());
    else if (argument === '--json') options.json = true;
    else if (argument === '--text') options.json = false;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.comparisonPaths.length) throw new Error('--comparison is required and may be repeated.');
  return options;
}

function helpText() {
  return [
    'Usage: node benchmarks/compare-lta-history.js --comparison FILE [--comparison FILE ...] [--json|--text]',
    '',
    '  --comparison FILE      JSON report from compare-lta-fixture.js; repeat for more windows',
    '  --json                 Emit JSON (default; useful for automation)',
    '  --text                 Emit a concise human-readable report',
    '',
    'Only complete reports within five minutes of snapshot/fixture capture are counted as same-window evidence.',
    'The stability gate is advisory and does not change the user-facing router.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = aggregateHistory(loadComparisonReports(options.comparisonPaths));
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`LTA fixture stability comparison failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  COMPARISON_KIND,
  COMPARISON_VERSION,
  HISTORY_KIND,
  HISTORY_VERSION,
  STABILITY_CRITERIA,
  matrixKey,
  sampleMetrics,
  validateComparisonReport,
  readComparisonReport,
  loadComparisonReports,
  aggregateHistory,
  parseArgs,
  formatReport,
  helpText,
};
