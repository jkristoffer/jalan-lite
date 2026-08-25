const { fetchJson } = require('../api/_upstream');
const trainScheduleSource = require('../train-schedule-source');
const trainSchedule = require('../train-schedule')._shared;
const stopsApi = require('../api/nearby-stops')._test;
const router = require('../api/realtime-route')._test;
const serviceSchedule = require('../api/bus-service-schedule');
const fixture = require('./lta-network-fixture');
const { SCENARIOS } = require('./routing-scenarios');

const BUS_STOPS_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusStops';
const BUS_ROUTES_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusRoutes';
const BUS_ARRIVAL_URL = 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival';
const PAGE_SIZE = 500;
const MAX_STOP_PAGES = 20;
const MAX_ROUTE_PAGES = 100;
const MAX_SERVICE_PAGES = 8;
const BUS_SEARCH_RADIUS_METRES = 600;
const CONNECTOR_MAX_DISTANCE_METRES = 3500;
const CONNECTOR_STATION_LIMIT = 8;
const MAX_NEARBY_STOPS = 6;

async function fetchCollection(url, apiKey, maxPages, service, validate) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('$skip', String(page * PAGE_SIZE));
    const { data } = await fetchJson(
      requestUrl,
      { headers: { AccountKey: apiKey, Accept: 'application/json' } },
      { service, validate },
    );
    rows.push(...data.value);
    if (data.value.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${service} exceeded its supported page limit.`);
}

async function fetchArrivals(stopCode, apiKey) {
  const url = new URL(BUS_ARRIVAL_URL);
  url.searchParams.set('BusStopCode', String(stopCode));
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' } },
    { service: 'LTA BusArrival', validate: router.isBusArrivalPayload || (() => true) },
  );
  return data;
}

function routePatternKey(row) {
  return `${String(row.ServiceNo || '').trim()}|${Number(row.Direction)}`;
}

function nearbyCandidateStops(stopRows, point) {
  return stopRows
    .map((stop) => ({
      stopCode: String(stop.BusStopCode),
      roadName: stop.RoadName || '',
      name: stop.Description || stop.RoadName || `Bus stop ${stop.BusStopCode}`,
      lat: Number(stop.Latitude),
      lng: Number(stop.Longitude),
      distanceMetres: Math.round(trainSchedule.distanceMetres(
        point.lat,
        point.lng,
        Number(stop.Latitude),
        Number(stop.Longitude),
      )),
    }))
    .filter((stop) => Number.isFinite(stop.distanceMetres) && stop.distanceMetres <= BUS_SEARCH_RADIUS_METRES)
    .sort((left, right) => left.distanceMetres - right.distanceMetres)
    .slice(0, MAX_NEARBY_STOPS);
}

function discoveryPairs(schedule, scenario) {
  const pairs = [{ start: scenario.start, end: scenario.end }];
  if (!schedule) return pairs;

  trainSchedule.nearestStations(schedule, scenario.start, CONNECTOR_STATION_LIMIT, CONNECTOR_MAX_DISTANCE_METRES)
    .filter((station) => station.distanceMetres > BUS_SEARCH_RADIUS_METRES)
    .forEach((station) => pairs.push({ start: scenario.start, end: station }));

  const destinationConnector = trainSchedule.nearestStations(
    schedule,
    scenario.end,
    1,
    CONNECTOR_MAX_DISTANCE_METRES,
  )[0];
  if (destinationConnector && destinationConnector.distanceMetres > BUS_SEARCH_RADIUS_METRES) {
    pairs.push({ start: destinationConnector, end: scenario.end });
  }
  return pairs;
}

function discoverArrivalStops({ busStops, busRoutes, schedule = null, scenarios = SCENARIOS } = {}) {
  const stopCodes = new Set();
  scenarios.forEach((scenario) => {
    discoveryPairs(schedule, scenario).forEach((pair) => {
      const originStops = nearbyCandidateStops(busStops, pair.start);
      const destinationStops = nearbyCandidateStops(busStops, pair.end);
      if (!originStops.length || !destinationStops.length) return;

      const candidates = [
        ...router.directCandidates(busRoutes, originStops, destinationStops),
        ...router.oneTransferCandidates(busRoutes, originStops, destinationStops),
      ];
      candidates.forEach((candidate) => {
        if (candidate.board?.stopCode) stopCodes.add(String(candidate.board.stopCode));
        if (candidate.transfer?.stopCode) stopCodes.add(String(candidate.transfer.stopCode));
      });
    });
  });
  return [...stopCodes];
}

function normalizeStopCodes(stopCodes = []) {
  return [...new Set(stopCodes
    .map((stopCode) => String(stopCode).trim())
    .filter(Boolean))];
}

function selectStaticNetwork({ busStops, busRoutes, busServices, schedule, scenarios = SCENARIOS }) {
  const points = [];
  scenarios.forEach((scenario) => {
    points.push(scenario.start, scenario.end);
    trainSchedule.nearestStations(schedule, scenario.start, CONNECTOR_STATION_LIMIT, CONNECTOR_MAX_DISTANCE_METRES).forEach((station) => points.push(station));
    trainSchedule.nearestStations(schedule, scenario.end, 1, CONNECTOR_MAX_DISTANCE_METRES).forEach((station) => points.push(station));
  });

  const relevantStopCodes = new Set();
  busStops.forEach((stop) => {
    const lat = Number(stop.Latitude);
    const lng = Number(stop.Longitude);
    if (points.some((point) => trainSchedule.distanceMetres(point.lat, point.lng, lat, lng) <= BUS_SEARCH_RADIUS_METRES)) {
      relevantStopCodes.add(String(stop.BusStopCode));
    }
  });

  const patterns = new Map();
  const patternsByStop = new Map();
  busRoutes.forEach((row) => {
    const patternKey = routePatternKey(row);
    if (!patterns.has(patternKey)) patterns.set(patternKey, []);
    patterns.get(patternKey).push(row);
    const stopCode = String(row.BusStopCode);
    if (!patternsByStop.has(stopCode)) patternsByStop.set(stopCode, new Set());
    patternsByStop.get(stopCode).add(patternKey);
  });

  const selectedPatterns = new Set();
  patterns.forEach((rows, patternKey) => {
    if (rows.some((row) => relevantStopCodes.has(String(row.BusStopCode)))) selectedPatterns.add(patternKey);
  });
  [...selectedPatterns].forEach((patternKey) => {
    patterns.get(patternKey).forEach((row) => {
      (patternsByStop.get(String(row.BusStopCode)) || []).forEach((sharedPatternKey) => selectedPatterns.add(sharedPatternKey));
    });
  });

  const selectedRoutes = busRoutes.filter((row) => selectedPatterns.has(routePatternKey(row)));
  const selectedServices = busServices.filter((row) => selectedPatterns.has(routePatternKey(row)));
  return {
    busStops: busStops.filter((stop) => relevantStopCodes.has(String(stop.BusStopCode))),
    busRoutes: selectedRoutes,
    busServices: selectedServices,
    scope: { points: points.length, nearbyStopCodes: relevantStopCodes.size, routePatterns: selectedPatterns.size },
  };
}

async function captureFixture({ apiKey = process.env.LTA_API_KEY, arrivalStops = [], requestedDate = null, scenarios = SCENARIOS, fullStatic = false } = {}) {
  if (!apiKey) throw new Error('LTA_API_KEY is required to capture a network fixture.');
  const [busStops, busRoutes, busServices, scheduleBytes] = await Promise.all([
    fetchCollection(BUS_STOPS_URL, apiKey, MAX_STOP_PAGES, 'LTA BusStops', stopsApi.isBusStopsPayload),
    fetchCollection(BUS_ROUTES_URL, apiKey, MAX_ROUTE_PAGES, 'LTA BusRoutes', router.isBusRoutesPayload),
    fetchCollection(serviceSchedule.LTA_BUS_SERVICES_URL, apiKey, MAX_SERVICE_PAGES, 'LTA BusServices', serviceSchedule.isBusServicesPayload),
    trainScheduleSource.fetchScheduleBytes(apiKey),
  ]);
  const parsedSchedule = trainSchedule.parseScheduleBytes(scheduleBytes);
  const selected = fullStatic
    ? { busStops, busRoutes, busServices, scope: { fullStatic: true } }
    : selectStaticNetwork({ busStops, busRoutes, busServices, schedule: parsedSchedule, scenarios });
  const discoveredArrivalStops = discoverArrivalStops({
    busStops: selected.busStops,
    busRoutes: selected.busRoutes,
    schedule: parsedSchedule,
    scenarios,
  });
  const capturedArrivalStops = normalizeStopCodes([...arrivalStops, ...discoveredArrivalStops]);
  const busArrivals = {};
  for (const stopCode of capturedArrivalStops) busArrivals[stopCode] = await fetchArrivals(stopCode, apiKey);
  const result = fixture.createFixture({
    requestedDate,
    busStops: selected.busStops,
    busRoutes: selected.busRoutes,
    busServices: selected.busServices,
    busArrivals,
    trainSchedule: parsedSchedule,
  });
  result.scope = {
    ...selected.scope,
    arrivalStops: capturedArrivalStops.length,
    discoveredArrivalStops: discoveredArrivalStops.length,
  };
  return result;
}

function singaporeDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    output: `benchmarks/fixtures/lta-network-${singaporeDate()}.json.gz`,
    requestedDate: singaporeDate(),
    arrivalStops: [],
    force: false,
    fullStatic: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--output') options.output = next();
    else if (argument === '--date') options.requestedDate = next();
    else if (argument === '--stops') options.arrivalStops = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (argument === '--full-static') options.fullStatic = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && !/^\d{4}-\d{2}-\d{2}$/.test(options.requestedDate)) throw new Error('Date must use YYYY-MM-DD format.');
  return options;
}

function helpText() {
  return [
    'Usage: node benchmarks/capture-lta-fixture.js [options]',
    '',
    '  --output FILE          Fixture path; .json.gz is compressed (default: dated fixture)',
    '  --date YYYY-MM-DD      Date label stored in the fixture',
    '  --stops CODE,CODE      Additional BusArrival stops to capture',
    '  --full-static          Keep every static BusStops/BusRoutes/BusServices row',
    '  --force                Replace an existing fixture',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const captured = await captureFixture(options);
  const output = fixture.writeFixture(options.output, captured, { overwrite: options.force });
  console.log(`Captured LTA network fixture: ${output}`);
  console.log(`BusStops ${captured.busStops.length}; BusRoutes ${captured.busRoutes.length}; BusServices ${captured.busServices.length}; BusArrival stops ${Object.keys(captured.busArrivals).length}.`);
  if (captured.scope) console.log(`Static scope: ${JSON.stringify(captured.scope)}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`LTA fixture capture failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchCollection,
  fetchArrivals,
  selectStaticNetwork,
  discoverArrivalStops,
  normalizeStopCodes,
  captureFixture,
  parseArgs,
  helpText,
};
