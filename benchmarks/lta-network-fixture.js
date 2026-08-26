const fs = require('node:fs');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const realtimeRoute = require('../api/realtime-route')._test;
const busServiceSchedule = require('../api/bus-service-schedule');

const FIXTURE_KIND = 'jalan-lta-network-fixture';
const FIXTURE_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timestampMs(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function isValidTimestamp(value) {
  return Number.isFinite(timestampMs(value));
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function mapEntries(map, name) {
  if (!(map instanceof Map)) throw new Error(`${name} must be a Map.`);
  return [...map.entries()].map(([key, value]) => [String(key), cloneJson(value)]);
}

function serializeTrainSchedule(schedule) {
  if (isRecord(schedule) && Array.isArray(schedule.stops)) return cloneJson(schedule);
  if (!isRecord(schedule)) throw new Error('A parsed train schedule is required.');
  return {
    stops: mapEntries(schedule.stops, 'schedule.stops'),
    routes: mapEntries(schedule.routes, 'schedule.routes'),
    trips: mapEntries(schedule.trips, 'schedule.trips'),
    stopTimesByTrip: mapEntries(schedule.stopTimesByTrip, 'schedule.stopTimesByTrip'),
    calendars: mapEntries(schedule.calendars, 'schedule.calendars'),
    calendarDates: mapEntries(schedule.calendarDates, 'schedule.calendarDates'),
  };
}

function scheduleMap(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of key/value pairs.`);
  return new Map(value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${name} contains an invalid entry.`);
    return [String(entry[0]), cloneJson(entry[1])];
  }));
}

function deserializeTrainSchedule(serialized) {
  if (!isRecord(serialized)) throw new Error('Serialized train schedule must be an object.');
  return {
    stops: scheduleMap(serialized.stops, 'schedule.stops'),
    routes: scheduleMap(serialized.routes, 'schedule.routes'),
    trips: scheduleMap(serialized.trips, 'schedule.trips'),
    stopTimesByTrip: scheduleMap(serialized.stopTimesByTrip, 'schedule.stopTimesByTrip'),
    calendars: scheduleMap(serialized.calendars, 'schedule.calendars'),
    calendarDates: scheduleMap(serialized.calendarDates, 'schedule.calendarDates'),
    graphCache: new Map(),
    stationCache: null,
  };
}

function validateFixture(fixture) {
  if (!isRecord(fixture)) throw new Error('LTA network fixture must be an object.');
  if (fixture.kind !== FIXTURE_KIND) throw new Error(`Unsupported LTA network fixture kind: ${fixture.kind || 'missing'}.`);
  if (fixture.version !== FIXTURE_VERSION) throw new Error(`Unsupported LTA network fixture version: ${fixture.version || 'missing'}.`);
  ['busStops', 'busRoutes', 'busServices'].forEach((name) => {
    if (!Array.isArray(fixture[name])) throw new Error(`LTA network fixture ${name} must be an array.`);
  });
  if (!isRecord(fixture.busArrivals)) throw new Error('LTA network fixture busArrivals must be an object keyed by stop code.');
  if (fixture.busArrivalCapturedAt !== undefined) {
    if (!isRecord(fixture.busArrivalCapturedAt)) throw new Error('LTA network fixture busArrivalCapturedAt must be an object keyed by stop code.');
    Object.entries(fixture.busArrivalCapturedAt).forEach(([stopCode, capturedAt]) => {
      if (!isValidTimestamp(capturedAt)) throw new Error(`LTA network fixture busArrivalCapturedAt for stop ${stopCode} must be a valid timestamp.`);
    });
  }
  serializeTrainSchedule(fixture.trainSchedule);
  return fixture;
}

function createFixture({ capturedAt = new Date().toISOString(), requestedDate = null, busStops, busRoutes, busServices, busArrivals = {}, busArrivalCapturedAt, trainSchedule }) {
  return validateFixture({
    kind: FIXTURE_KIND,
    version: FIXTURE_VERSION,
    capturedAt,
    requestedDate,
    busStops: cloneJson(busStops),
    busRoutes: cloneJson(busRoutes),
    busServices: cloneJson(busServices),
    busArrivals: cloneJson(busArrivals),
    ...(busArrivalCapturedAt === undefined ? {} : { busArrivalCapturedAt: cloneJson(busArrivalCapturedAt) }),
    trainSchedule: serializeTrainSchedule(trainSchedule),
  });
}

function createProviders(fixture, { onMissingArrival } = {}) {
  const validated = validateFixture(fixture);
  return {
    stopsProvider: async () => cloneJson(validated.busStops),
    routesProvider: async () => cloneJson(validated.busRoutes),
    serviceScheduleProvider: async () => busServiceSchedule.normalizedServiceMap(cloneJson(validated.busServices)),
    arrivalProvider: async ({ stopCode, now }) => {
      const key = String(stopCode);
      if (!Object.prototype.hasOwnProperty.call(validated.busArrivals, key)) {
        if (typeof onMissingArrival === 'function') onMissingArrival(key);
        throw new Error(`LTA network fixture is missing BusArrival data for stop ${key}.`);
      }
      const payload = validated.busArrivals[key];
      const capturedAt = validated.busArrivalCapturedAt?.[key] || validated.capturedAt;
      return realtimeRoute.normalizeArrivalPayload(payload, timestampMs(capturedAt));
    },
    scheduleProvider: async () => deserializeTrainSchedule(validated.trainSchedule),
  };
}

function readFixture(filePath) {
  const absolutePath = path.resolve(String(filePath));
  try {
    const bytes = fs.readFileSync(absolutePath);
    const source = absolutePath.endsWith('.gz') ? gunzipSync(bytes) : bytes;
    return validateFixture(JSON.parse(source.toString('utf8')));
  } catch (error) {
    throw new Error(`Unable to read LTA network fixture ${absolutePath}: ${error.message}`);
  }
}

function writeFixture(filePath, fixture, { overwrite = false } = {}) {
  const absolutePath = path.resolve(String(filePath));
  const validated = validateFixture(fixture);
  const json = Buffer.from(JSON.stringify(validated));
  const output = absolutePath.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    fs.writeFileSync(absolutePath, output, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`LTA network fixture already exists at ${absolutePath}; use --force to replace it.`);
    throw new Error(`Unable to write LTA network fixture ${absolutePath}: ${error.message}`);
  }
  return absolutePath;
}

module.exports = {
  FIXTURE_KIND,
  FIXTURE_VERSION,
  serializeTrainSchedule,
  deserializeTrainSchedule,
  validateFixture,
  createFixture,
  createProviders,
  readFixture,
  writeFixture,
};
