const fs = require('node:fs');
const path = require('node:path');

const RESULT_KIND = 'jalan-routing-benchmark-results';
const RESULT_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function compactBestPath(pathValue) {
  if (!isRecord(pathValue)) return null;
  return {
    source: pathValue.source || null,
    kind: pathValue.kind || null,
    timingStatus: pathValue.timingStatus || null,
    timingSource: pathValue.timingSource || null,
    timingConfidence: pathValue.timingConfidence || null,
    rankable: pathValue.rankable === true,
    estimatedTotalMinutes: Number.isFinite(Number(pathValue.estimatedTotalMinutes)) ? Number(pathValue.estimatedTotalMinutes) : null,
    estimatedTotalRangeMinutes: Array.isArray(pathValue.estimatedTotalRangeMinutes)
      ? pathValue.estimatedTotalRangeMinutes.map(Number)
      : null,
    services: Array.isArray(pathValue.services) ? [...pathValue.services] : [],
  };
}

function compactSample(sample) {
  if (!isRecord(sample)) throw new Error('Benchmark result sample must be an object.');
  return {
    scenarioId: sample.scenarioId,
    scenarioLabel: sample.scenarioLabel || null,
    departureTime: sample.departureTime,
    requestedAt: sample.requestedAt,
    ltaObservationTime: sample.ltaObservationTime || null,
    lta: {
      ok: sample.lta?.ok === true,
      status: Number(sample.lta?.status || 0),
      error: sample.lta?.error || null,
      railMinutes: Number.isFinite(Number(sample.lta?.railMinutes)) ? Number(sample.lta.railMinutes) : null,
      directBus: sample.lta?.directBus ? {
        serviceNo: sample.lta.directBus.serviceNo || null,
        totalWalkMetres: Number.isFinite(Number(sample.lta.directBus.totalWalkMetres)) ? Number(sample.lta.directBus.totalWalkMetres) : null,
        liveStatus: sample.lta.directBus.liveStatus || null,
      } : null,
      intermodalRankable: sample.lta?.intermodalRankable === true,
      scheduledEstimateCount: Number(sample.lta?.scheduledEstimateCount || 0),
      lowConfidenceCount: Number(sample.lta?.lowConfidenceCount || 0),
      bestPath: compactBestPath(sample.lta?.bestPath),
    },
    oneMap: {
      ok: sample.oneMap?.ok === true,
      status: Number(sample.oneMap?.status || 0),
      error: sample.oneMap?.error || null,
      itineraryCount: Number(sample.oneMap?.itineraryCount || 0),
      firstMinutes: Number.isFinite(Number(sample.oneMap?.firstMinutes)) ? Number(sample.oneMap.firstMinutes) : null,
      bestMinutes: Number.isFinite(Number(sample.oneMap?.bestMinutes)) ? Number(sample.oneMap.bestMinutes) : null,
    },
    comparison: {
      oneMapMinutes: Number.isFinite(Number(sample.comparison?.oneMapMinutes)) ? Number(sample.comparison.oneMapMinutes) : null,
      ltaMinutes: Number.isFinite(Number(sample.comparison?.ltaMinutes)) ? Number(sample.comparison.ltaMinutes) : null,
      deltaMinutes: Number.isFinite(Number(sample.comparison?.deltaMinutes)) ? Number(sample.comparison.deltaMinutes) : null,
      outcome: sample.comparison?.outcome || 'unavailable',
    },
  };
}

function validateResults(results) {
  if (!isRecord(results)) throw new Error('Benchmark results must be an object.');
  if (results.kind !== RESULT_KIND) throw new Error(`Unsupported benchmark result kind: ${results.kind || 'missing'}.`);
  if (results.version !== RESULT_VERSION) throw new Error(`Unsupported benchmark result version: ${results.version || 'missing'}.`);
  if (!Array.isArray(results.samples) || !results.samples.length) throw new Error('Benchmark results must contain at least one sample.');
  results.samples.forEach((sample, index) => {
    if (!sample.scenarioId || !sample.departureTime || !sample.requestedAt) throw new Error(`Benchmark result sample ${index + 1} is missing scenario metadata.`);
    if (!isRecord(sample.lta) || !isRecord(sample.oneMap) || !isRecord(sample.comparison)) {
      throw new Error(`Benchmark result sample ${index + 1} is missing summary data.`);
    }
  });
  if (!isRecord(results.summary)) throw new Error('Benchmark results are missing their aggregate summary.');
  return results;
}

function createResults(report) {
  if (!isRecord(report) || !Array.isArray(report.samples) || !report.samples.length) {
    throw new Error('A benchmark report with samples is required.');
  }
  return validateResults({
    kind: RESULT_KIND,
    version: RESULT_VERSION,
    capturedAt: report.generatedAt || new Date().toISOString(),
    sourceBaseUrl: report.baseUrl || null,
    requestedDate: report.requestedDate || null,
    departureTimes: Array.isArray(report.departureTimes) ? [...report.departureTimes] : [],
    scenarioIds: Array.isArray(report.scenarioIds) ? [...report.scenarioIds] : [],
    timingNote: report.timingNote || null,
    promotionCriteria: cloneJson(report.promotionCriteria),
    samples: report.samples.map(compactSample),
    summary: cloneJson(report.summary),
  });
}

function reportFromResults(results) {
  const validated = validateResults(results);
  return {
    generatedAt: validated.capturedAt,
    source: 'recorded-results',
    baseUrl: validated.sourceBaseUrl,
    requestedDate: validated.requestedDate,
    departureTimes: [...(validated.departureTimes || [])],
    scenarioIds: [...(validated.scenarioIds || [])],
    timingNote: validated.timingNote,
    promotionCriteria: cloneJson(validated.promotionCriteria),
    samples: cloneJson(validated.samples),
    summary: cloneJson(validated.summary),
  };
}

function readResults(filePath) {
  const absolutePath = path.resolve(String(filePath));
  let value;
  try {
    value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read benchmark results ${absolutePath}: ${error.message}`);
  }
  try {
    return validateResults(value);
  } catch (error) {
    throw new Error(`Invalid benchmark results ${absolutePath}: ${error.message}`);
  }
}

function writeResults(filePath, results, { overwrite = false } = {}) {
  const absolutePath = path.resolve(String(filePath));
  const validated = validateResults(results);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    fs.writeFileSync(absolutePath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Benchmark results already exist at ${absolutePath}; use --force to replace them.`);
    throw new Error(`Unable to write benchmark results ${absolutePath}: ${error.message}`);
  }
  return absolutePath;
}

module.exports = {
  RESULT_KIND,
  RESULT_VERSION,
  compactBestPath,
  compactSample,
  validateResults,
  createResults,
  reportFromResults,
  readResults,
  writeResults,
};
