const ltaFixture = require('./lta-network-fixture');
const walkingFixture = require('./walking-network-fixture');
const realtimeRoute = require('../api/realtime-route')._test;
const { SCENARIOS } = require('./routing-scenarios');

async function runWalkingFixtureReplay(networkFixture, measuredFixture, { scenarios = SCENARIOS, maxEndpoints = 8 } = {}) {
  ltaFixture.validateFixture(networkFixture);
  walkingFixture.validateFixture(measuredFixture);
  return Promise.all(scenarios.map(async (scenario) => {
    const discovery = realtimeRoute.discoverCandidates(
      networkFixture.busStops,
      networkFixture.busRoutes,
      scenario.start,
      scenario.end,
    );
    const endpoints = realtimeRoute.walkingEndpoints(discovery.candidates, scenario.start, scenario.end, maxEndpoints)
      .slice(0, maxEndpoints);
    walkingFixture.assertCoverage(measuredFixture, scenario.id, endpoints);
    const applied = await walkingFixture.applyFixture({
      fixture: measuredFixture,
      scenarioId: scenario.id,
      candidates: discovery.candidates,
      start: scenario.start,
      end: scenario.end,
      maxEndpoints,
    });
    return {
      scenarioId: scenario.id,
      rechecked: discovery.rechecked,
      walkingCheck: applied.walkingCheck,
      candidates: realtimeRoute.rankCandidates(discovery.candidates),
    };
  }));
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { networkFixturePath: null, walkingFixturePath: null, scenarioIds: null, maxEndpoints: 8 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--network-fixture') options.networkFixturePath = next();
    else if (argument === '--walking-fixture') options.walkingFixturePath = next();
    else if (argument === '--scenarios') options.scenarioIds = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--max-endpoints') options.maxEndpoints = parsePositiveInt(next(), '--max-endpoints');
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && !options.networkFixturePath) throw new Error('--network-fixture is required.');
  if (!options.help && !options.walkingFixturePath) throw new Error('--walking-fixture is required.');
  return options;
}

function helpText() {
  return [
    'Usage: node benchmarks/replay-walking-fixture.js --network-fixture FILE --walking-fixture FILE [options]',
    '',
    '  --network-fixture FILE  Compressed or plain LTA network fixture',
    '  --walking-fixture FILE  Compressed or plain measured walking fixture',
    '  --scenarios ID,ID       Limit the fixed scenario set',
    '  --max-endpoints N       Maximum endpoint checks per scenario (default: 8)',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const networkFixture = ltaFixture.readFixture(options.networkFixturePath);
  const measuredFixture = walkingFixture.readFixture(options.walkingFixturePath);
  const scenarios = options.scenarioIds
    ? SCENARIOS.filter((scenario) => options.scenarioIds.includes(scenario.id))
    : SCENARIOS;
  if (!scenarios.length) throw new Error('No matching scenarios.');
  const results = await runWalkingFixtureReplay(networkFixture, measuredFixture, { scenarios, maxEndpoints: options.maxEndpoints });
  console.log(JSON.stringify({ source: 'jalan-lta-walking-fixture', networkFixture: options.networkFixturePath, walkingFixture: options.walkingFixturePath, results }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Walking fixture replay failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runWalkingFixtureReplay, parseArgs, helpText };
