const { inflateRawSync } = require('node:zlib');
const { fetchBytes, safeUpstreamFailure } = require('./_upstream');

const GTFS_SCHEDULE_URL = 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/PublicTransportRelated/GTFSScheduleTrain.zip';
const CACHE_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 15000;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DEFAULT_RAIL_RADIUS_METRES = 1200;
const TRANSFER_BUFFER_SECONDS = 150;
const MAX_RAIL_TRANSFERS = 3;
const textDecoder = new TextDecoder();

let cachedSchedule = null;
let cachedAt = 0;
let loadingSchedule = null;

function hasRange(bytes, offset, length) {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= bytes.length;
}
function uint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function uint16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function findSignature(bytes, signature, start = 0) {
  for (let index = start; index <= bytes.length - 4; index += 1) if (uint32(bytes, index) === signature) return index;
  return -1;
}
function findCentralEntry(bytes, name, localOffset) {
  let cursor = 0;
  while (cursor <= bytes.length - 46) {
    const central = findSignature(bytes, ZIP_CENTRAL_SIGNATURE, cursor);
    if (central < 0 || !hasRange(bytes, central, 46)) return -1;
    const nameLength = uint16(bytes, central + 28);
    const extraLength = uint16(bytes, central + 30);
    const commentLength = uint16(bytes, central + 32);
    if (!hasRange(bytes, central + 46, nameLength + extraLength + commentLength)) return -1;
    const entryName = textDecoder.decode(bytes.slice(central + 46, central + 46 + nameLength));
    if (entryName === name && uint32(bytes, central + 42) === localOffset) return central;
    cursor = central + 46 + nameLength + extraLength + commentLength;
  }
  return -1;
}
function unzipEntries(bytes) {
  if (!(bytes instanceof Uint8Array) || !hasRange(bytes, 0, 4) || uint32(bytes, 0) !== ZIP_LOCAL_SIGNATURE) return [];
  const entries = [];
  let cursor = 0;
  while (cursor <= bytes.length - 30) {
    if (!hasRange(bytes, cursor, 30) || uint32(bytes, cursor) !== ZIP_LOCAL_SIGNATURE) break;
    const flags = uint16(bytes, cursor + 6);
    const method = uint16(bytes, cursor + 8);
    let compressedSize = uint32(bytes, cursor + 18);
    const nameLength = uint16(bytes, cursor + 26);
    const extraLength = uint16(bytes, cursor + 28);
    if (flags & 0x01) throw new Error('Encrypted GTFS ZIP entries are unsupported.');
    if (!hasRange(bytes, cursor + 30, nameLength + extraLength)) throw new Error('Invalid GTFS ZIP entry.');
    const name = textDecoder.decode(bytes.slice(cursor + 30, cursor + 30 + nameLength));
    const dataStart = cursor + 30 + nameLength + extraLength;
    if ((flags & 0x08) && !compressedSize) {
      const central = findCentralEntry(bytes, name, cursor);
      if (central >= 0 && hasRange(bytes, central + 20, 4)) compressedSize = uint32(bytes, central + 20);
    }
    if (!hasRange(bytes, dataStart, compressedSize)) throw new Error('Invalid GTFS ZIP payload.');
    if (!name.endsWith('/')) {
      const payload = bytes.slice(dataStart, dataStart + compressedSize);
      const decoded = method === 0 ? payload : method === 8 ? new Uint8Array(inflateRawSync(payload)) : null;
      if (!decoded) throw new Error('Unsupported GTFS ZIP compression method.');
      entries.push({ name: name.split('/').pop(), bytes: decoded });
    }
    let nextEntry = dataStart + compressedSize;
    if (flags & 0x08) nextEntry += hasRange(bytes, nextEntry, 4) && uint32(bytes, nextEntry) === ZIP_DATA_DESCRIPTOR_SIGNATURE ? 16 : 12;
    if (!hasRange(bytes, nextEntry, 4) || uint32(bytes, nextEntry) !== ZIP_LOCAL_SIGNATURE) {
      const nextHeader = findSignature(bytes, ZIP_LOCAL_SIGNATURE, nextEntry);
      if (nextHeader < 0) break;
      nextEntry = nextHeader;
    }
    if (nextEntry <= cursor) throw new Error('Invalid GTFS ZIP structure.');
    cursor = nextEntry;
  }
  return entries;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => value.trim());
  return rows.filter((values) => values.some((value) => value !== '')).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function requireTable(entries, name) {
  const entry = entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!entry) throw new Error(`LTA train GTFS is missing ${name}.`);
  return parseCsv(textDecoder.decode(entry.bytes));
}
function optionalTable(entries, name) {
  const entry = entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
  return entry ? parseCsv(textDecoder.decode(entry.bytes)) : [];
}
function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function parseTimeSeconds(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
function parsePoint(value) {
  const match = String(value || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]); const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 1.1 || lat > 1.55 || lng < 103.5 || lng > 104.15) return null;
  return { lat, lng };
}
function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180; const dLat = (lat2 - lat1) * rad; const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function dateKeyFromParts(year, month, day) { return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`; }
function dateInfo(dateKey) {
  const year = Number(dateKey.slice(0, 4)); const month = Number(dateKey.slice(4, 6)); const day = Number(dateKey.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return { year, month, day, weekday: names[date.getUTCDay()] };
}
function previousDateKey(dateKey) {
  const { year, month, day } = dateInfo(dateKey); const date = new Date(Date.UTC(year, month - 1, day - 1));
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
function sgClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour); const minute = Number(p.minute); const second = Number(p.second);
  const today = `${p.year}${p.month}${p.day}`;
  return hour < 4 ? { dateKey: previousDateKey(today), seconds: hour * 3600 + minute * 60 + second + 86400 } : { dateKey: today, seconds: hour * 3600 + minute * 60 + second };
}
function clockFromIso(value) {
  if (typeof value !== 'string' || !/[T ]\d{2}:\d{2}/.test(value)) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  return { ...sgClock(instant), epochMs: instant.getTime() };
}

function parseScheduleBytes(bytes) {
  const entries = unzipEntries(bytes);
  if (!entries.length) throw new Error('LTA train GTFS ZIP could not be read.');
  const stopsRows = requireTable(entries, 'stops.txt');
  const routesRows = requireTable(entries, 'routes.txt');
  const tripsRows = requireTable(entries, 'trips.txt');
  const stopTimesRows = requireTable(entries, 'stop_times.txt');
  const calendarRows = optionalTable(entries, 'calendar.txt');
  const calendarDateRows = optionalTable(entries, 'calendar_dates.txt');
  if (!calendarRows.length && !calendarDateRows.length) throw new Error('LTA train GTFS has no service calendar.');

  const stops = new Map(stopsRows.filter((row) => row.stop_id).map((row) => [row.stop_id, {
    id: row.stop_id, name: row.stop_name || row.stop_id, lat: numeric(row.stop_lat), lng: numeric(row.stop_lon), parentStation: row.parent_station || '', locationType: Number(row.location_type || 0),
  }]));
  const routes = new Map(routesRows.filter((row) => row.route_id).map((row) => [row.route_id, {
    id: row.route_id, shortName: row.route_short_name || '', longName: row.route_long_name || '', type: Number(row.route_type || 1),
  }]));
  const trips = new Map(tripsRows.filter((row) => row.trip_id && row.route_id).map((row) => [row.trip_id, {
    id: row.trip_id, routeId: row.route_id, serviceId: row.service_id || '', directionId: Number(row.direction_id || 0),
  }]));
  const stopTimesByTrip = new Map();
  stopTimesRows.forEach((row) => {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id)) return;
    const sequence = Number(row.stop_sequence); const arrival = parseTimeSeconds(row.arrival_time); const departure = parseTimeSeconds(row.departure_time);
    if (!Number.isFinite(sequence) || arrival === null || departure === null) return;
    if (!stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.set(row.trip_id, []);
    stopTimesByTrip.get(row.trip_id).push({ stopId: row.stop_id, sequence, arrival, departure });
  });
  stopTimesByTrip.forEach((times) => times.sort((a,b) => a.sequence - b.sequence));
  const calendars = new Map(calendarRows.filter((row) => row.service_id).map((row) => [row.service_id, row]));
  const calendarDates = new Map();
  calendarDateRows.forEach((row) => {
    if (!row.service_id || !/^\d{8}$/.test(row.date || '')) return;
    const key = `${row.service_id}|${row.date}`; calendarDates.set(key, Number(row.exception_type));
  });
  return { stops, routes, trips, stopTimesByTrip, calendars, calendarDates, graphCache: new Map(), stationCache: null };
}

function serviceActive(schedule, serviceId, dateKey) {
  const exception = schedule.calendarDates.get(`${serviceId}|${dateKey}`);
  if (exception === 1) return true;
  if (exception === 2) return false;
  const calendar = schedule.calendars.get(serviceId);
  if (!calendar) return false;
  if (calendar.start_date && dateKey < calendar.start_date) return false;
  if (calendar.end_date && dateKey > calendar.end_date) return false;
  return String(calendar[dateInfo(dateKey).weekday] || '0') === '1';
}
function canonicalStation(schedule, stopId) {
  const stop = schedule.stops.get(stopId); if (!stop) return null;
  const parent = stop.parentStation ? schedule.stops.get(stop.parentStation) : null;
  const station = parent || stop;
  const lat = Number.isFinite(station.lat) ? station.lat : stop.lat; const lng = Number.isFinite(station.lng) ? station.lng : stop.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { id: station.id, name: station.name || stop.name, lat, lng, platformStopId: stop.id };
}
function allStations(schedule) {
  if (schedule.stationCache) return schedule.stationCache;
  const stations = new Map();
  schedule.stops.forEach((stop) => { const station = canonicalStation(schedule, stop.id); if (station && !stations.has(station.id)) stations.set(station.id, { id: station.id, name: station.name, lat: station.lat, lng: station.lng }); });
  schedule.stationCache = [...stations.values()];
  return schedule.stationCache;
}
function nearbyStations(schedule, point, radius = DEFAULT_RAIL_RADIUS_METRES, limit = 5) {
  return allStations(schedule).map((station) => ({ ...station, distanceMetres: Math.round(distanceMetres(point.lat, point.lng, station.lat, station.lng)) }))
    .filter((station) => station.distanceMetres <= radius).sort((a,b) => a.distanceMetres - b.distanceMetres).slice(0, limit);
}
function nearestStations(schedule, point, limit = 2, maxRadius = 5000) { return nearbyStations(schedule, point, maxRadius, limit); }

function buildGraph(schedule, dateKey) {
  if (schedule.graphCache.has(dateKey)) return schedule.graphCache.get(dateKey);
  const edgesByFrom = new Map();
  schedule.trips.forEach((trip) => {
    if (!serviceActive(schedule, trip.serviceId, dateKey)) return;
    const times = schedule.stopTimesByTrip.get(trip.id); if (!times || times.length < 2) return;
    const route = schedule.routes.get(trip.routeId) || { id: trip.routeId, shortName: trip.routeId, longName: '', type: 1 };
    for (let index = 0; index < times.length - 1; index += 1) {
      const fromTime = times[index]; const toTime = times[index + 1];
      const from = canonicalStation(schedule, fromTime.stopId); const to = canonicalStation(schedule, toTime.stopId);
      if (!from || !to || from.id === to.id || toTime.arrival < fromTime.departure) continue;
      const edge = { tripId: trip.id, routeId: trip.routeId, routeName: route.shortName || route.longName || trip.routeId, routeType: route.type, directionId: trip.directionId, fromStationId: from.id, fromName: from.name, fromStopId: fromTime.stopId, toStationId: to.id, toName: to.name, toStopId: toTime.stopId, departure: fromTime.departure, arrival: toTime.arrival };
      if (!edgesByFrom.has(from.id)) edgesByFrom.set(from.id, []); edgesByFrom.get(from.id).push(edge);
    }
  });
  edgesByFrom.forEach((edges) => edges.sort((a,b) => a.departure - b.departure || a.arrival - b.arrival));
  const graph = { dateKey, edgesByFrom }; schedule.graphCache.set(dateKey, graph); return graph;
}

function groupLegs(edges) {
  const legs = [];
  edges.forEach((edge) => {
    const previous = legs[legs.length - 1];
    if (previous && previous.routeId === edge.routeId && previous.tripId === edge.tripId) {
      previous.alightStationId = edge.toStationId; previous.alightName = edge.toName; previous.alightStopId = edge.toStopId; previous.arrivalSeconds = edge.arrival; previous.rideStops += 1;
    } else {
      legs.push({ mode: edge.routeType === 0 ? 'LRT' : 'MRT', routeId: edge.routeId, routeName: edge.routeName, directionId: edge.directionId, tripId: edge.tripId, boardStationId: edge.fromStationId, boardName: edge.fromName, boardStopId: edge.fromStopId, alightStationId: edge.toStationId, alightName: edge.toName, alightStopId: edge.toStopId, departureSeconds: edge.departure, arrivalSeconds: edge.arrival, rideStops: 1, liveStatus: 'scheduled' });
    }
  });
  return legs;
}
function railJourney(schedule, start, end, { clock = sgClock(), startStations = null, endStations = null, railRadius = DEFAULT_RAIL_RADIUS_METRES } = {}) {
  const origins = startStations || nearbyStations(schedule, start, railRadius, 5);
  const destinations = endStations || nearbyStations(schedule, end, railRadius, 5);
  if (!origins.length || !destinations.length) return null;
  const destinationMap = new Map(destinations.map((station) => [station.id, station]));
  const graph = buildGraph(schedule, clock.dateKey);
  const queue = [];
  const best = new Map();
  origins.forEach((station) => {
    const walkSeconds = Math.ceil((station.distanceMetres || 0) / 1.25);
    queue.push({ stationId: station.id, time: clock.seconds + walkSeconds, lastRouteId: '', transfers: 0, edges: [], origin: station });
  });
  let winner = null;
  let iterations = 0;
  while (queue.length && iterations < 20000) {
    iterations += 1; queue.sort((a,b) => a.time - b.time); const state = queue.shift();
    const key = `${state.stationId}|${state.lastRouteId}|${state.transfers}`;
    if (best.has(key) && best.get(key) <= state.time) continue; best.set(key, state.time);
    const destination = destinationMap.get(state.stationId);
    if (destination) {
      const finalTime = state.time + Math.ceil((destination.distanceMetres || 0) / 1.25);
      if (!winner || finalTime < winner.finalTime) winner = { ...state, destination, finalTime };
      if (winner && state.time > winner.finalTime) break;
    }
    const edges = graph.edgesByFrom.get(state.stationId) || [];
    const seenNext = new Set();
    for (const edge of edges) {
      const isTransfer = Boolean(state.lastRouteId && state.lastRouteId !== edge.routeId);
      const readyAt = state.time + (isTransfer ? TRANSFER_BUFFER_SECONDS : 0);
      if (edge.departure < readyAt) continue;
      if (edge.departure - readyAt > 30 * 60) break;
      const nextTransfers = state.transfers + (isTransfer ? 1 : 0); if (nextTransfers > MAX_RAIL_TRANSFERS) continue;
      const nextKey = `${edge.routeId}|${edge.directionId}|${edge.toStationId}`; if (seenNext.has(nextKey)) continue; seenNext.add(nextKey);
      queue.push({ stationId: edge.toStationId, time: edge.arrival, lastRouteId: edge.routeId, transfers: nextTransfers, edges: [...state.edges, edge], origin: state.origin });
    }
  }
  if (!winner || !winner.edges.length) return null;
  const legs = groupLegs(winner.edges); const departure = legs[0].departureSeconds;
  return { kind: 'rail', transfers: Math.max(0, legs.length - 1), board: winner.origin, alight: winner.destination, totalWalkMetres: (winner.origin.distanceMetres || 0) + (winner.destination.distanceMetres || 0), catchableArrivalMinutes: Math.max(0, Math.ceil((departure - clock.seconds) / 60)), estimatedTotalMinutes: Math.max(1, Math.ceil((winner.finalTime - clock.seconds) / 60)), scheduledArrivalSeconds: winner.finalTime, legs, liveStatus: 'scheduled' };
}

async function loadSchedule(timeoutMs = TIMEOUT_MS) {
  if (cachedSchedule && Date.now() - cachedAt < CACHE_MS) return cachedSchedule;
  if (!loadingSchedule) {
    loadingSchedule = fetchBytes(GTFS_SCHEDULE_URL, { headers: { Accept: 'application/zip' } }, { service: 'LTA GTFS Schedule', timeoutMs, validate: (bytes) => bytes.length > 4 && uint32(bytes, 0) === ZIP_LOCAL_SIGNATURE })
      .then(({ bytes }) => { cachedSchedule = parseScheduleBytes(bytes); cachedAt = Date.now(); return cachedSchedule; })
      .finally(() => { loadingSchedule = null; });
  }
  return loadingSchedule;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  try {
    const schedule = await loadSchedule(); const clock = sgClock(); const graph = buildGraph(schedule, clock.dateKey);
    return res.status(200).json({ source: 'LTA GTFS Schedule (Train)', date: clock.dateKey, stations: allStations(schedule).length, routes: schedule.routes.size, trips: schedule.trips.size, activeStations: graph.edgesByFrom.size, updatedAt: new Date().toISOString() });
  } catch (error) {
    safeUpstreamFailure(error); return res.status(502).json({ error: 'LTA train schedule is temporarily unavailable.' });
  }
};

module.exports._shared = { GTFS_SCHEDULE_URL, unzipEntries, parseCsv, parseScheduleBytes, parseTimeSeconds, parsePoint, distanceMetres, sgClock, clockFromIso, serviceActive, canonicalStation, allStations, nearbyStations, nearestStations, buildGraph, railJourney, loadSchedule, reset() { cachedSchedule = null; cachedAt = 0; loadingSchedule = null; } };
