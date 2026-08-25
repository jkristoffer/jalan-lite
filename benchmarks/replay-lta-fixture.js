const multimodal = require('../api/multimodal-route');
const trainSchedule = require('../train-schedule')._shared;
const { SCENARIOS, DEFAULT_DEPARTURE_TIMES, benchmarkAt } = require('./routing-scenarios');
const fixture = require('./lta-network-fixture');

function captureTimestampMs(networkFixture) {
  const capturedAt = networkFixture?.capturedAt;
  const timestamp = typeof capturedAt === 'string' && capturedAt.trim() ? Date.parse(capturedAt) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('LTA network fixture capturedAt must be a valid timestamp for offline replay.');
  return timestamp;
}

async function runFixtureRoute(networkFixture, scenario, date, departureTime) {
  const clock = trainSchedule.clockFromIso(benchmarkAt(date, departureTime));
  if (!clock) throw new Error(`Invalid fixture route clock for ${date} ${departureTime}.`);
  const nowMs = captureTimestampMs(networkFixture);
  const missingArrivalStops = new Set();
  const providers = fixture.createProviders(networkFixture, {
    onMissingArrival(stopCode) {
      missingArrivalStops.add(String(stopCode));
    },
  });
  const query = new URLSearchParams({
    start: `${scenario.start.lat},${scenario.start.lng}`,
    end: `${scenario.end.lat},${scenario.end.lng}`,
    requestedClock: benchmarkAt(date, departureTime),
  });
  const capture = multimodal._test.captureResponse();
  await multimodal({
    url: `/api/multimodal-route?${query}`,
    _benchmark: { ...providers, clock, nowMs },
  }, capture.res);
  if (missingArrivalStops.size) {
    throw new Error(`LTA network fixture is missing BusArrival data for stop(s): ${[...missingArrivalStops].join(', ')}.`);
  }
  return capture.result;
}

async function runFixtureMatrix(networkFixture, { date, scenarios = SCENARIOS, departureTimes = DEFAULT_DEPARTURE_TIMES } = {}) {
  const results = [];
  for (const scenario of scenarios) {
    for (const departureTime of departureTimes) {
      const response = await runFixtureRoute(networkFixture, scenario, date, departureTime);
      results.push({ scenarioId: scenario.id, departureTime, status: response.status, body: response.body });
    }
  }
  return results;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { fixturePath: null, date: null, scenarioIds: null, departureTimes: [...DEFAULT_DEPARTURE_TIMES] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--fixture') options.fixturePath = next();
    else if (argument === '--date') options.date = next();
    else if (argument === '--scenarios') options.scenarioIds = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--times') options.departureTimes = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.fixturePath) throw new Error('--fixture is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))) throw new Error('--date must use YYYY-MM-DD format.');
  return options;
}

function helpText() {
  return [
    'Usage: node benchmarks/replay-lta-fixture.js --fixture FILE --date YYYY-MM-DD [options]',
    '',
    '  --fixture FILE         Compressed or plain LTA network fixture',
    '  --date YYYY-MM-DD      Singapore date used for scheduled rail',
    '  --times HH:MM,HH:MM    Departure times (default: 08:00,18:00)',
    '  --scenarios ID,ID      Limit the fixed scenario set',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const networkFixture = fixture.readFixture(options.fixturePath);
  const scenarios = options.scenarioIds ? SCENARIOS.filter((scenario) => options.scenarioIds.includes(scenario.id)) : SCENARIOS;
  if (!scenarios.length) throw new Error('No matching scenarios.');
  const results = await runFixtureMatrix(networkFixture, { date: options.date, scenarios, departureTimes: options.departureTimes });
  console.log(JSON.stringify({ source: 'lta-network-fixture', fixture: options.fixturePath, results }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`LTA fixture replay failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { captureTimestampMs, runFixtureRoute, runFixtureMatrix, parseArgs, helpText };
