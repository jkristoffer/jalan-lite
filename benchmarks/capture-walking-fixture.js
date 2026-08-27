const path = require('node:path');
const { getOneMapToken } = require('../api/_onemap-auth');
const onemapWalking = require('../api/onemap-walking');
const realtimeRoute = require('../api/realtime-route')._test;
const ltaFixture = require('./lta-network-fixture');
const walkingFixture = require('./walking-network-fixture');
const { SCENARIOS } = require('./routing-scenarios');

const DEFAULT_MAX_ENDPOINTS = 8;
const DEFAULT_CONCURRENCY = 4;

function singaporeDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function endpointJobs(networkFixture, scenarios = SCENARIOS, maxEndpoints = DEFAULT_MAX_ENDPOINTS) {
  ltaFixture.validateFixture(networkFixture);
  return scenarios.flatMap((scenario) => {
    const discovery = realtimeRoute.discoverCandidates(
      networkFixture.busStops,
      networkFixture.busRoutes,
      scenario.start,
      scenario.end,
    );
    const endpoints = realtimeRoute.walkingEndpoints(discovery.candidates, scenario.start, scenario.end, maxEndpoints)
      .slice(0, maxEndpoints);
    if (!endpoints.length) throw new Error(`No walking endpoints were discovered for ${scenario.id}.`);
    return endpoints.map((endpoint) => ({ scenario, endpoint }));
  });
}

async function captureWalkingFixture({
  networkFixture,
  requestedDate = networkFixture?.requestedDate || singaporeDate(),
  scenarios = SCENARIOS,
  maxEndpoints = DEFAULT_MAX_ENDPOINTS,
  concurrency = DEFAULT_CONCURRENCY,
  token = null,
  walkingProvider = null,
  now = new Date(),
} = {}) {
  const jobs = endpointJobs(networkFixture, scenarios, maxEndpoints);
  let provider = walkingProvider;
  if (!provider) {
    const accessToken = token || await getOneMapToken();
    provider = ({ start, end, signal }) => onemapWalking.fetchWalkingDistance({
      token: accessToken,
      start,
      end,
      signal,
      now,
    });
  }
  const capturedAt = new Date().toISOString();
  const samples = await mapLimit(jobs, concurrency, async ({ scenario, endpoint }) => {
    const result = realtimeRoute.normalizeWalkingResult(await provider({ ...endpoint, scenarioId: scenario.id, now }));
    if (!result) throw new Error(`Walking provider returned no usable distance for ${scenario.id} ${endpoint.side} stop ${endpoint.stop.stopCode}.`);
    return {
      scenarioId: scenario.id,
      side: endpoint.side,
      stopCode: endpoint.stop.stopCode,
      straightLineDistanceMetres: Number(endpoint.stop.straightLineDistanceMetres ?? endpoint.stop.distanceMetres),
      distanceMetres: result.distanceMetres,
      durationSeconds: result.durationSeconds,
      start: endpoint.start,
      end: endpoint.end,
    };
  });
  return walkingFixture.createFixture({
    capturedAt,
    requestedDate,
    sourceCapturedAt: networkFixture.capturedAt,
    samples,
  });
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    fixturePath: null,
    output: null,
    requestedDate: null,
    scenarioIds: null,
    maxEndpoints: DEFAULT_MAX_ENDPOINTS,
    concurrency: DEFAULT_CONCURRENCY,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--fixture') options.fixturePath = next();
    else if (argument === '--output') options.output = next();
    else if (argument === '--date') options.requestedDate = next();
    else if (argument === '--scenarios') options.scenarioIds = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--max-endpoints') options.maxEndpoints = parsePositiveInt(next(), '--max-endpoints');
    else if (argument === '--concurrency') options.concurrency = parsePositiveInt(next(), '--concurrency');
    else if (argument === '--force') options.force = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && !options.fixturePath) throw new Error('--fixture is required.');
  if (!options.help && options.requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(options.requestedDate)) throw new Error('--date must use YYYY-MM-DD format.');
  return options;
}

function helpText() {
  return [
    'Usage: node benchmarks/capture-walking-fixture.js --fixture FILE [options]',
    '',
    '  --fixture FILE         Compressed or plain LTA network fixture',
    '  --output FILE          Compressed walking fixture (default: dated benchmarks/fixtures file)',
    '  --date YYYY-MM-DD      Date label for the walking capture',
    '  --scenarios ID,ID      Limit the fixed scenario set',
    '  --max-endpoints N      Maximum endpoint checks per scenario (default: 8)',
    '  --concurrency N        Maximum concurrent OneMap requests (default: 4)',
    '  --force                Replace an existing fixture',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const networkFixture = ltaFixture.readFixture(options.fixturePath);
  const scenarios = options.scenarioIds
    ? SCENARIOS.filter((scenario) => options.scenarioIds.includes(scenario.id))
    : SCENARIOS;
  if (!scenarios.length) throw new Error('No matching scenarios.');
  const requestedDate = options.requestedDate || networkFixture.requestedDate || singaporeDate();
  const output = options.output || path.join('benchmarks/fixtures', `lta-walking-${requestedDate}.json.gz`);
  const captured = await captureWalkingFixture({
    networkFixture,
    requestedDate,
    scenarios,
    maxEndpoints: options.maxEndpoints,
    concurrency: options.concurrency,
  });
  const outputPath = walkingFixture.writeFixture(output, captured, { overwrite: options.force });
  console.log(`Captured OneMap walking fixture: ${outputPath}`);
  console.log(`Walking samples ${captured.samples.length}; source captured at ${captured.sourceCapturedAt}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Walking fixture capture failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { mapLimit, endpointJobs, captureWalkingFixture, parseArgs, helpText };
