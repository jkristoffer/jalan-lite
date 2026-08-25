const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_KIND = 'jalan-routing-benchmark-snapshot';
const SNAPSHOT_VERSION = 1;
const ENDPOINTS = Object.freeze(['lta', 'onemap']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function canonicalRequestKey(requestUrl) {
  let url;
  try {
    url = new URL(String(requestUrl), 'https://jalan.local');
  } catch (error) {
    throw new Error(`Invalid benchmark request URL: ${requestUrl}`);
  }

  const query = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

function normalizeResponse(response) {
  if (!isRecord(response)) throw new Error('Snapshot response must be an object.');
  const status = Number(response.status);
  if (!Number.isInteger(status) || status < 0 || status > 599) throw new Error('Snapshot response status must be an integer from 0 to 599.');
  if (response.error !== undefined && response.error !== null && typeof response.error !== 'string') {
    throw new Error('Snapshot response error must be a string or null.');
  }
  return {
    status,
    body: cloneJson(response.body),
    error: response.error || null,
  };
}

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new Error('Routing snapshot must be an object.');
  if (snapshot.kind !== SNAPSHOT_KIND) throw new Error(`Unsupported routing snapshot kind: ${snapshot.kind || 'missing'}.`);
  if (snapshot.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported routing snapshot version: ${snapshot.version || 'missing'}.`);
  if (!Array.isArray(snapshot.samples) || !snapshot.samples.length) throw new Error('Routing snapshot must contain at least one sample.');

  const requestKeys = new Set();
  snapshot.samples.forEach((sample, index) => {
    if (!isRecord(sample)) throw new Error(`Routing snapshot sample ${index + 1} must be an object.`);
    if (!sample.scenarioId || !sample.departureTime || !sample.requestedAt) {
      throw new Error(`Routing snapshot sample ${index + 1} is missing scenario metadata.`);
    }
    if (!isRecord(sample.requests) || !isRecord(sample.responses)) {
      throw new Error(`Routing snapshot sample ${index + 1} must contain requests and responses.`);
    }
    ENDPOINTS.forEach((endpoint) => {
      const request = sample.requests[endpoint];
      if (typeof request !== 'string' || !request) throw new Error(`Routing snapshot sample ${index + 1} is missing its ${endpoint} request.`);
      const key = canonicalRequestKey(request);
      if (requestKeys.has(key)) throw new Error(`Routing snapshot contains a duplicate request: ${key}`);
      requestKeys.add(key);
      normalizeResponse(sample.responses[endpoint]);
    });
  });

  return snapshot;
}

function createSnapshot(report) {
  if (!isRecord(report) || !Array.isArray(report.samples) || !report.samples.length) {
    throw new Error('A benchmark report with samples is required to create a routing snapshot.');
  }

  const snapshot = {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    capturedAt: report.generatedAt || new Date().toISOString(),
    sourceBaseUrl: report.baseUrl || null,
    requestedDate: report.requestedDate || null,
    departureTimes: Array.isArray(report.departureTimes) ? [...report.departureTimes] : [],
    scenarioIds: Array.isArray(report.scenarioIds) ? [...report.scenarioIds] : [],
    timingNote: report.timingNote || null,
    samples: report.samples.map((sample, index) => {
      if (!sample.requests || !sample.responses) {
        throw new Error(`Benchmark sample ${index + 1} does not contain captured requests and responses.`);
      }
      return {
        scenarioId: sample.scenarioId,
        scenarioLabel: sample.scenarioLabel || null,
        departureTime: sample.departureTime,
        requestedAt: sample.requestedAt,
        requests: {
          lta: sample.requests.lta,
          onemap: sample.requests.onemap,
        },
        responses: {
          lta: normalizeResponse(sample.responses.lta),
          onemap: normalizeResponse(sample.responses.onemap),
        },
      };
    }),
  };
  return validateSnapshot(snapshot);
}

function createSnapshotFetcher(snapshot) {
  const validated = validateSnapshot(snapshot);
  const responses = new Map();
  validated.samples.forEach((sample) => {
    ENDPOINTS.forEach((endpoint) => {
      responses.set(canonicalRequestKey(sample.requests[endpoint]), sample.responses[endpoint]);
    });
  });

  return async function snapshotFetcher(requestUrl) {
    const key = canonicalRequestKey(requestUrl);
    const response = responses.get(key);
    if (!response) {
      throw new Error(`Recorded routing snapshot miss for ${key}. Re-record the requested scenario/date before replaying.`);
    }
    return normalizeResponse(response);
  };
}

function readSnapshot(filePath) {
  const absolutePath = path.resolve(String(filePath));
  let value;
  try {
    value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read routing snapshot ${absolutePath}: ${error.message}`);
  }
  try {
    return validateSnapshot(value);
  } catch (error) {
    throw new Error(`Invalid routing snapshot ${absolutePath}: ${error.message}`);
  }
}

function writeSnapshot(filePath, snapshot, { overwrite = false } = {}) {
  const absolutePath = path.resolve(String(filePath));
  const validated = validateSnapshot(snapshot);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    fs.writeFileSync(absolutePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Routing snapshot already exists at ${absolutePath}; use --force to replace it.`);
    throw new Error(`Unable to write routing snapshot ${absolutePath}: ${error.message}`);
  }
  return absolutePath;
}

module.exports = {
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  ENDPOINTS,
  canonicalRequestKey,
  normalizeResponse,
  validateSnapshot,
  createSnapshot,
  createSnapshotFetcher,
  readSnapshot,
  writeSnapshot,
};
