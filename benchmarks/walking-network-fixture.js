const fs = require('node:fs');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const realtimeRoute = require('../api/realtime-route')._test;

const FIXTURE_KIND = 'jalan-lta-walking-fixture';
const FIXTURE_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function timestampMs(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function isValidTimestamp(value) {
  return Number.isFinite(timestampMs(value));
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    && Number.isFinite(Date.parse(`${value}T00:00:00+08:00`));
}

function finiteNonNegative(value, label) {
  if (value === null || value === undefined || value === '') throw new Error(`${label} must be a finite non-negative number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a finite non-negative number.`);
  return number;
}

function point(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a point object.`);
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`${label} must contain finite lat/lng values.`);
  return { lat, lng };
}

function sampleKey(scenarioId, side, stopCode) {
  return `${String(scenarioId)}\u0000${String(side)}\u0000${String(stopCode)}`;
}

function normalizeSample(sample, index) {
  if (!isRecord(sample)) throw new Error(`Walking fixture sample ${index + 1} must be an object.`);
  const scenarioId = String(sample.scenarioId || '').trim();
  const side = String(sample.side || '').trim();
  const stopCode = String(sample.stopCode || '').trim();
  if (!scenarioId || !['access', 'egress'].includes(side) || !stopCode) {
    throw new Error(`Walking fixture sample ${index + 1} is missing scenarioId, side, or stopCode.`);
  }
  const straightLineDistanceMetres = finiteNonNegative(
    sample.straightLineDistanceMetres ?? sample.proxyDistanceMetres,
    `Walking fixture sample ${index + 1} straightLineDistanceMetres`,
  );
  const distanceMetres = finiteNonNegative(sample.distanceMetres, `Walking fixture sample ${index + 1} distanceMetres`);
  let durationSeconds = null;
  if (sample.durationSeconds !== null && sample.durationSeconds !== undefined) {
    durationSeconds = finiteNonNegative(sample.durationSeconds, `Walking fixture sample ${index + 1} durationSeconds`);
  }
  return {
    scenarioId,
    side,
    stopCode,
    straightLineDistanceMetres,
    distanceMetres,
    durationSeconds,
    start: point(sample.start, `Walking fixture sample ${index + 1} start`),
    end: point(sample.end, `Walking fixture sample ${index + 1} end`),
  };
}

function validateFixture(value) {
  if (!isRecord(value)) throw new Error('Walking network fixture must be an object.');
  if (value.kind !== FIXTURE_KIND) throw new Error(`Unsupported walking network fixture kind: ${value.kind || 'missing'}.`);
  if (value.version !== FIXTURE_VERSION) throw new Error(`Unsupported walking network fixture version: ${value.version || 'missing'}.`);
  if (!isValidTimestamp(value.capturedAt)) throw new Error('Walking network fixture capturedAt must be a valid timestamp.');
  if (value.requestedDate !== null && value.requestedDate !== undefined && !isValidDate(value.requestedDate)) {
    throw new Error('Walking network fixture requestedDate must use a valid YYYY-MM-DD date.');
  }
  if (value.sourceCapturedAt !== undefined && !isValidTimestamp(value.sourceCapturedAt)) {
    throw new Error('Walking network fixture sourceCapturedAt must be a valid timestamp.');
  }
  if (!Array.isArray(value.samples) || !value.samples.length) throw new Error('Walking network fixture samples are required.');
  const seen = new Set();
  value.samples.forEach((sample, index) => {
    const normalized = normalizeSample(sample, index);
    const key = sampleKey(normalized.scenarioId, normalized.side, normalized.stopCode);
    if (seen.has(key)) throw new Error(`Walking network fixture contains duplicate sample ${normalized.scenarioId} ${normalized.side} ${normalized.stopCode}.`);
    seen.add(key);
  });
  return value;
}

function createFixture({ capturedAt = new Date().toISOString(), requestedDate = null, sourceCapturedAt = null, sourceFixture = null, samples = [] } = {}) {
  return validateFixture({
    kind: FIXTURE_KIND,
    version: FIXTURE_VERSION,
    capturedAt,
    requestedDate,
    ...(sourceCapturedAt ? { sourceCapturedAt } : {}),
    ...(sourceFixture ? { sourceFixture: String(sourceFixture) } : {}),
    samples: samples.map((sample, index) => normalizeSample(sample, index)),
  });
}

function indexSamples(value) {
  const validated = validateFixture(value);
  return new Map(validated.samples.map((sample) => [sampleKey(sample.scenarioId, sample.side, sample.stopCode), sample]));
}

function missingSamples(value, scenarioId, endpoints = []) {
  const index = indexSamples(value);
  return endpoints.filter((endpoint) => !index.has(sampleKey(scenarioId, endpoint.side, endpoint.stop?.stopCode)));
}

function assertCoverage(value, scenarioId, endpoints = []) {
  const missing = missingSamples(value, scenarioId, endpoints);
  if (missing.length) {
    const labels = missing.map((endpoint) => `${endpoint.side} ${endpoint.stop?.stopCode || 'unknown'}`);
    throw new Error(`Walking network fixture is missing data for ${scenarioId}: ${labels.join(', ')}.`);
  }
}

function createProvider(value, scenarioId) {
  const index = indexSamples(value);
  return async ({ side, stop }) => {
    const stopCode = String(stop?.stopCode || '');
    const sample = index.get(sampleKey(scenarioId, side, stopCode));
    if (!sample) throw new Error(`Walking network fixture is missing data for ${scenarioId} ${side} stop ${stopCode}.`);
    return { distanceMetres: sample.distanceMetres, durationSeconds: sample.durationSeconds };
  };
}

async function applyFixture({ fixture, scenarioId, candidates, start, end, maxEndpoints } = {}) {
  const endpoints = realtimeRoute.walkingEndpoints(candidates, start, end, maxEndpoints);
  assertCoverage(fixture, scenarioId, endpoints);
  const walkingProvider = createProvider(fixture, scenarioId);
  const walkingCheck = await realtimeRoute.attachWalkingDistances(candidates, start, end, {
    walkingProvider,
    allowNetwork: false,
  });
  return { endpoints, walkingCheck };
}

function readFixture(filePath) {
  const absolutePath = path.resolve(String(filePath));
  try {
    const bytes = fs.readFileSync(absolutePath);
    const source = absolutePath.endsWith('.gz') ? gunzipSync(bytes) : bytes;
    return validateFixture(JSON.parse(source.toString('utf8')));
  } catch (error) {
    throw new Error(`Unable to read walking network fixture ${absolutePath}: ${error.message}`);
  }
}

function writeFixture(filePath, value, { overwrite = false } = {}) {
  const absolutePath = path.resolve(String(filePath));
  const validated = validateFixture(value);
  const json = Buffer.from(JSON.stringify(validated));
  const output = absolutePath.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    fs.writeFileSync(absolutePath, output, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Walking network fixture already exists at ${absolutePath}; use --force to replace it.`);
    throw new Error(`Unable to write walking network fixture ${absolutePath}: ${error.message}`);
  }
  return absolutePath;
}

module.exports = {
  FIXTURE_KIND,
  FIXTURE_VERSION,
  sampleKey,
  normalizeSample,
  validateFixture,
  createFixture,
  indexSamples,
  missingSamples,
  assertCoverage,
  createProvider,
  applyFixture,
  readFixture,
  writeFixture,
};
