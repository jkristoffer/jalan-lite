const busHandler = require('./realtime-route');
const trainSchedule = require('../train-schedule-source');

const CONNECTOR_MIN_DISTANCE_METRES = 600;
const CONNECTOR_MAX_DISTANCE_METRES = 3500;
const MAX_CONNECTOR_STATIONS = 3;
const WALKING_SPEED_METRES_PER_SECOND = 1.25;
const BUS_FAST_SPEED_KMH = 28;
const BUS_SLOW_SPEED_KMH = 15;
const BUS_MIN_DWELL_MINUTES = 0.2;
const BUS_MAX_DWELL_MINUTES = 0.5;
const MAX_BUS_TIMING_SPREAD_MINUTES = 15;
const MAX_BUS_ESTIMATED_RIDE_MINUTES = 45;
const MAX_INTERMODAL_TIMING_SPREAD_MINUTES = 20;

function captureResponse() {
  const result = { status: 200, body: null, headers: {} };
  return {
    result,
    res: {
      setHeader(name, value) { result.headers[String(name).toLowerCase()] = value; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return body; },
    },
  };
}

async function runBusRoute(start, end) {
  const capture = captureResponse();
  const query = new URLSearchParams({ start: `${start.lat},${start.lng}`, end: `${end.lat},${end.lng}` });
  await busHandler({ url: `/api/realtime-route?${query}` }, capture.res);
  return capture.result;
}

function usableBusCandidate(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return candidates.find((candidate) => Number.isFinite(candidate.catchableArrivalMinutes)) || candidates[0] || null;
}

function directLiveBusCandidates(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return candidates.filter((candidate) => (candidate.kind === 'direct' || Number(candidate.transfers) === 0)
    && Number(candidate.transfers) === 0
    && Array.isArray(candidate.legs)
    && candidate.legs.length === 1
    && Number.isFinite(candidate.catchableArrivalMinutes));
}

function walkMinutes(distanceMetres) {
  return Math.max(0, (Number(distanceMetres) || 0) / WALKING_SPEED_METRES_PER_SECOND / 60);
}

function estimateDirectBusTiming(candidate) {
  if (!candidate || Number(candidate.transfers) !== 0 || !Array.isArray(candidate.legs) || candidate.legs.length !== 1) return null;
  if (!Number.isFinite(candidate.catchableArrivalMinutes)) return null;
  const leg = candidate.legs[0];
  const distanceKm = Number(leg.routeDistanceKm ?? candidate.routeDistanceKm);
  const rideStops = Number(leg.rideStops ?? candidate.rideStops);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || !Number.isFinite(rideStops) || rideStops <= 0) return null;

  const intermediateStops = Math.max(0, rideStops - 1);
  const minRideMinutes = (distanceKm / BUS_FAST_SPEED_KMH) * 60 + intermediateStops * BUS_MIN_DWELL_MINUTES;
  const maxRideMinutes = (distanceKm / BUS_SLOW_SPEED_KMH) * 60 + intermediateStops * BUS_MAX_DWELL_MINUTES;
  const estimatedRideMinutes = (minRideMinutes + maxRideMinutes) / 2;
  const spreadMinutes = maxRideMinutes - minRideMinutes;
  const stationWalkMinutes = walkMinutes(candidate.alight?.distanceMetres);
  const readyAtConnectorMinutes = candidate.catchableArrivalMinutes + estimatedRideMinutes + stationWalkMinutes;
  const minReadyAtConnectorMinutes = candidate.catchableArrivalMinutes + minRideMinutes + stationWalkMinutes;
  const maxReadyAtConnectorMinutes = candidate.catchableArrivalMinutes + maxRideMinutes + stationWalkMinutes;
  return {
    minRideMinutes,
    estimatedRideMinutes,
    maxRideMinutes,
    spreadMinutes,
    stationWalkMinutes,
    readyAtConnectorMinutes,
    minReadyAtConnectorMinutes,
    maxReadyAtConnectorMinutes,
    reliable: spreadMinutes <= MAX_BUS_TIMING_SPREAD_MINUTES && estimatedRideMinutes <= MAX_BUS_ESTIMATED_RIDE_MINUTES,
  };
}

function advanceClock(clock, minutes) {
  return { ...clock, seconds: clock.seconds + Math.max(0, Math.ceil(Number(minutes) * 60)) };
}

function railStationPoint(station) { return { lat: station.lat, lng: station.lng }; }
function exactStation(station) { return [{ ...station, distanceMetres: 0 }]; }

function busLegs(candidate) {
  return (candidate?.legs || []).map((leg) => ({
    mode: 'BUS',
    serviceNo: leg.serviceNo,
    operator: leg.operator || candidate.operator || '',
    direction: leg.direction,
    boardStopCode: leg.boardStopCode,
    alightStopCode: leg.alightStopCode,
    rideStops: leg.rideStops,
    routeDistanceKm: leg.routeDistanceKm,
    liveStatus: leg.liveStatus || candidate.liveStatus || 'unknown',
    arrivals: leg.arrivals || (leg === candidate.legs?.[0] ? candidate.arrivals : undefined),
  }));
}

function composeBusRail(bus, rail, station) {
  if (!bus || !rail) return null;
  return {
    kind: 'bus-rail',
    timingStatus: 'partial',
    rankable: false,
    connectorStation: { id: station.id, name: station.name, lat: station.lat, lng: station.lng },
    transfers: (Number(bus.transfers) || 0) + rail.transfers + 1,
    totalWalkMetres: (Number(bus.totalWalkMetres) || 0) + (Number(rail.totalWalkMetres) || 0),
    legs: [...busLegs(bus), ...rail.legs],
    note: 'Bus travel time to the rail transfer is not yet reliable enough to rank this path.',
  };
}

function composeEstimatedBusRail(bus, rail, station, timing, range) {
  if (!bus || !rail || !timing || !range) return null;
  const legs = busLegs(bus);
  if (legs[0]) {
    legs[0].estimatedRideMinutes = Math.round(timing.estimatedRideMinutes * 10) / 10;
    legs[0].estimatedRideRangeMinutes = [
      Math.round(timing.minRideMinutes * 10) / 10,
      Math.round(timing.maxRideMinutes * 10) / 10,
    ];
    legs[0].timingConfidence = 'estimated';
  }
  const estimatedTotalMinutes = timing.readyAtConnectorMinutes + rail.estimatedTotalMinutes;
  const minTotalMinutes = Math.min(range.minTotalMinutes, estimatedTotalMinutes, range.maxTotalMinutes);
  const maxTotalMinutes = Math.max(range.minTotalMinutes, estimatedTotalMinutes, range.maxTotalMinutes);
  const totalSpreadMinutes = maxTotalMinutes - minTotalMinutes;
  const rankable = totalSpreadMinutes <= MAX_INTERMODAL_TIMING_SPREAD_MINUTES;
  return {
    kind: 'bus-rail',
    timingStatus: 'estimated',
    timingConfidence: rankable && totalSpreadMinutes <= 10 ? 'medium' : 'low',
    rankable,
    connectorStation: { id: station.id, name: station.name, lat: station.lat, lng: station.lng },
    transfers: (Number(bus.transfers) || 0) + rail.transfers + 1,
    totalWalkMetres: (Number(bus.totalWalkMetres) || 0) + (Number(rail.totalWalkMetres) || 0),
    estimatedTotalMinutes: Math.round(estimatedTotalMinutes),
    estimatedTotalRangeMinutes: [Math.floor(minTotalMinutes), Math.ceil(maxTotalMinutes)],
    busTiming: {
      source: 'LTA route distance and stop count heuristic',
      boardingInMinutes: bus.catchableArrivalMinutes,
      estimatedRideMinutes: Math.round(timing.estimatedRideMinutes * 10) / 10,
      rideRangeMinutes: [Math.round(timing.minRideMinutes * 10) / 10, Math.round(timing.maxRideMinutes * 10) / 10],
      stationWalkMinutes: Math.round(timing.stationWalkMinutes * 10) / 10,
    },
    legs: [...legs, ...rail.legs],
    note: rankable
      ? 'Bus ride time is conservatively estimated from LTA route distance and stop count; rail timing is scheduled.'
      : 'The bus timing estimate is too uncertain to rank this path confidently.',
  };
}

function composeRailBus(rail, bus, station) {
  if (!rail || !bus) return null;
  return {
    kind: 'rail-bus',
    timingStatus: 'partial',
    rankable: false,
    connectorStation: { id: station.id, name: station.name, lat: station.lat, lng: station.lng },
    transfers: rail.transfers + (Number(bus.transfers) || 0) + 1,
    totalWalkMetres: (Number(rail.totalWalkMetres) || 0) + (Number(bus.totalWalkMetres) || 0),
    legs: [...rail.legs, ...busLegs(bus)],
    note: 'Bus arrival timing after the rail transfer is not yet projected, so this path is topology-only and is not ranked.',
  };
}

function timedBusRailCandidate(schedule, end, clock, station, bus) {
  const timing = estimateDirectBusTiming(bus);
  if (!timing?.reliable) return null;
  const stationPoint = railStationPoint(station);
  const options = { startStations: exactStation(station) };
  const rail = trainSchedule.railJourney(schedule, stationPoint, end, { ...options, clock: advanceClock(clock, timing.readyAtConnectorMinutes) });
  const railAtMin = trainSchedule.railJourney(schedule, stationPoint, end, { ...options, clock: advanceClock(clock, timing.minReadyAtConnectorMinutes) });
  const railAtMax = trainSchedule.railJourney(schedule, stationPoint, end, { ...options, clock: advanceClock(clock, timing.maxReadyAtConnectorMinutes) });
  if (!rail || !railAtMin || !railAtMax) return null;
  return composeEstimatedBusRail(bus, rail, station, timing, {
    minTotalMinutes: timing.minReadyAtConnectorMinutes + railAtMin.estimatedTotalMinutes,
    maxTotalMinutes: timing.maxReadyAtConnectorMinutes + railAtMax.estimatedTotalMinutes,
  });
}

function sortConnectorOptions(options) {
  return [...options].sort((left, right) => {
    const leftMode = left.rail?.legs?.[0]?.mode === 'MRT' ? 0 : 1;
    const rightMode = right.rail?.legs?.[0]?.mode === 'MRT' ? 0 : 1;
    return leftMode - rightMode || left.station.distanceMetres - right.station.distanceMetres;
  });
}

async function findBusRailCandidate(schedule, start, end, clock) {
  const options = trainSchedule.nearestStations(schedule, start, 8, CONNECTOR_MAX_DISTANCE_METRES)
    .filter((station) => station.distanceMetres > CONNECTOR_MIN_DISTANCE_METRES)
    .map((station) => ({
      station,
      rail: trainSchedule.railJourney(schedule, railStationPoint(station), end, { clock, startStations: exactStation(station) }),
    }))
    .filter((option) => option.rail);

  const candidates = [];
  let fallback = null;
  for (const option of sortConnectorOptions(options).slice(0, MAX_CONNECTOR_STATIONS)) {
    const connectorBusResult = await runBusRoute(start, railStationPoint(option.station)).catch(() => null);
    const payload = connectorBusResult?.body;
    const bus = usableBusCandidate(payload);
    if (!fallback) fallback = composeBusRail(bus, option.rail, option.station);
    for (const directBus of directLiveBusCandidates(payload)) {
      const estimated = timedBusRailCandidate(schedule, end, clock, option.station, directBus);
      if (estimated) candidates.push(estimated);
    }
  }
  return candidates
    .sort((left, right) => Number(right.rankable) - Number(left.rankable)
      || (left.estimatedTotalMinutes ?? Number.POSITIVE_INFINITY) - (right.estimatedTotalMinutes ?? Number.POSITIVE_INFINITY)
      || left.totalWalkMetres - right.totalWalkMetres)[0] || fallback;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'https://dailyloop.local');
  const start = trainSchedule.parsePoint(url.searchParams.get('start'));
  const end = trainSchedule.parsePoint(url.searchParams.get('end'));
  if (!start || !end) return res.status(400).json({ error: 'Valid Singapore start and end coordinates are required.' });

  const busPromise = runBusRoute(start, end).catch((error) => ({ status: 502, body: { error: error.message || 'Bus routing unavailable.' } }));
  const apiKey = process.env.LTA_API_KEY;
  const schedulePromise = apiKey
    ? trainSchedule.loadSchedule(apiKey).then((schedule) => ({ schedule })).catch((error) => ({ error }))
    : Promise.resolve({ error: new Error('LTA_API_KEY is not configured.') });
  const [busResult, scheduleResult] = await Promise.all([busPromise, schedulePromise]);
  const clock = trainSchedule.sgClock();
  let rail = null;
  const intermodal = [];

  if (scheduleResult.schedule) {
    const schedule = scheduleResult.schedule;
    rail = trainSchedule.railJourney(schedule, start, end, { clock });

    const busRail = await findBusRailCandidate(schedule, start, end, clock);
    if (busRail) intermodal.push(busRail);

    const destinationConnector = trainSchedule.nearestStations(schedule, end, 1, CONNECTOR_MAX_DISTANCE_METRES)[0];
    if (destinationConnector && destinationConnector.distanceMetres > CONNECTOR_MIN_DISTANCE_METRES) {
      const railBeforeBus = trainSchedule.railJourney(schedule, start, railStationPoint(destinationConnector), { clock, endStations: exactStation(destinationConnector) });
      const connectorBusResult = await runBusRoute(railStationPoint(destinationConnector), end).catch(() => null);
      const connectorBus = usableBusCandidate(connectorBusResult?.body);
      const combined = composeRailBus(railBeforeBus, connectorBus, destinationConnector);
      if (combined) intermodal.push(combined);
    }
  }

  const busOk = busResult.status === 200 && busResult.body;
  if (!busOk && !rail && !intermodal.length) {
    return res.status(502).json({ error: 'LTA multimodal routing is temporarily unavailable.', busError: busResult.body?.error || null, railError: scheduleResult.error ? 'Train schedule unavailable.' : null });
  }

  return res.status(200).json({
    engine: 'lta-realtime-multimodal-v2',
    scope: 'live-bus-plus-scheduled-rail',
    bus: busOk ? busResult.body : { candidates: [], error: busResult.body?.error || 'Bus routing unavailable.' },
    rail: rail ? { candidate: rail, source: 'LTA GTFS Schedule (Train)' } : { candidate: null, reason: scheduleResult.error ? 'Train schedule unavailable.' : 'No scheduled rail journey connects nearby stations at this time.' },
    intermodal,
    limitations: [
      'Rail routing uses the official LTA GTFS Schedule and supports scheduled MRT/LRT line transfers.',
      'Bus-only routing continues to use LTA BusRoutes and live BusArrival data.',
      'Direct live bus-to-rail paths may be time-estimated when the LTA distance/stop-count uncertainty stays bounded; bus-transfer-to-rail paths remain unranked.',
      'Rail-to-bus paths remain topology-only because future bus arrival timing is not projected yet.',
      'Walking access and egress currently use straight-line distance.',
    ],
    updatedAt: new Date().toISOString(),
  });
};

module.exports._test = {
  captureResponse,
  usableBusCandidate,
  directLiveBusCandidates,
  walkMinutes,
  estimateDirectBusTiming,
  advanceClock,
  busLegs,
  composeBusRail,
  composeEstimatedBusRail,
  composeRailBus,
  timedBusRailCandidate,
  sortConnectorOptions,
};
