const busHandler = require('./realtime-route');
const trainSchedule = require('../train-schedule-source');

const CONNECTOR_MIN_DISTANCE_METRES = 600;
const CONNECTOR_MAX_DISTANCE_METRES = 3500;
const BUS_ESTIMATE_MAX_DISTANCE_KM = 8;
const BUS_ESTIMATE_MAX_STOPS = 20;
const BUS_ESTIMATE_MINUTES_PER_KM = 3;
const BUS_ESTIMATE_MINUTES_PER_STOP = 1.1;
const STATION_ENTRY_BUFFER_MINUTES = 2;
const WALKING_SPEED_METRES_PER_SECOND = 1.25;

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

function railStationPoint(station) { return { lat: station.lat, lng: station.lng }; }
function exactStation(station) { return [{ ...station, distanceMetres: 0 }]; }
function shiftedClock(clock, minutes) {
  return { ...clock, seconds: clock.seconds + Math.max(0, Math.round(Number(minutes) * 60 || 0)) };
}

function monitoredCatchable(candidate) {
  const arrivals = candidate?.arrivals || candidate?.legs?.[0]?.arrivals || [];
  const monitored = candidate?.monitored || candidate?.legs?.[0]?.monitored || [];
  const catchable = Number(candidate?.catchableArrivalMinutes);
  if (!Number.isFinite(catchable)) return false;
  return arrivals.some((arrival, index) => Number.isFinite(arrival) && arrival === catchable && monitored[index] === true);
}

function estimateDirectBusToStation(candidate) {
  if (!candidate || candidate.kind !== 'direct' || Number(candidate.transfers) !== 0 || candidate.legs?.length !== 1) return null;
  if (!monitoredCatchable(candidate)) return null;
  const leg = candidate.legs[0];
  const distanceKm = Number(leg.routeDistanceKm ?? candidate.routeDistanceKm);
  const rideStops = Number(leg.rideStops ?? candidate.rideStops);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > BUS_ESTIMATE_MAX_DISTANCE_KM) return null;
  if (!Number.isInteger(rideStops) || rideStops <= 0 || rideStops > BUS_ESTIMATE_MAX_STOPS) return null;
  const busWaitMinutes = Number(candidate.catchableArrivalMinutes);
  const busRideMinutes = Math.max(2, Math.ceil(Math.max(
    distanceKm * BUS_ESTIMATE_MINUTES_PER_KM,
    rideStops * BUS_ESTIMATE_MINUTES_PER_STOP,
  )));
  const stationWalkMetres = Math.max(0, Number(candidate.alight?.distanceMetres) || 0);
  const stationWalkMinutes = Math.ceil(stationWalkMetres / WALKING_SPEED_METRES_PER_SECOND / 60);
  const toStationMinutes = busWaitMinutes + busRideMinutes + stationWalkMinutes + STATION_ENTRY_BUFFER_MINUTES;
  return {
    confidence: 'bounded-estimate',
    busWaitMinutes,
    busRideMinutes,
    stationWalkMinutes,
    stationEntryBufferMinutes: STATION_ENTRY_BUFFER_MINUTES,
    toStationMinutes,
  };
}

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

function composeBusRail(bus, rail, station, estimate = null) {
  if (!bus || !rail) return null;
  const complete = Boolean(estimate && Number.isFinite(rail.estimatedTotalMinutes));
  return {
    kind: 'bus-rail',
    timingStatus: complete ? 'estimated' : 'partial',
    rankable: complete,
    connectorStation: { id: station.id, name: station.name, lat: station.lat, lng: station.lng },
    transfers: (Number(bus.transfers) || 0) + rail.transfers + 1,
    totalWalkMetres: (Number(bus.totalWalkMetres) || 0) + (Number(rail.totalWalkMetres) || 0),
    ...(complete ? {
      catchableArrivalMinutes: bus.catchableArrivalMinutes,
      estimatedTotalMinutes: estimate.toStationMinutes + rail.estimatedTotalMinutes,
      busTimingEstimate: estimate,
    } : {}),
    legs: [...busLegs(bus), ...rail.legs],
    note: complete
      ? 'Bus travel time uses a bounded estimate for a short direct live connector; rail timing is from the LTA GTFS Schedule.'
      : 'Bus travel time to the rail transfer is not sufficiently bounded, so this path remains topology-only and is not ranked.',
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

    const originConnector = trainSchedule.nearestStations(schedule, start, 1, CONNECTOR_MAX_DISTANCE_METRES)[0];
    if (originConnector && originConnector.distanceMetres > CONNECTOR_MIN_DISTANCE_METRES) {
      const connectorBusResult = await runBusRoute(start, railStationPoint(originConnector)).catch(() => null);
      const connectorBus = usableBusCandidate(connectorBusResult?.body);
      const estimate = estimateDirectBusToStation(connectorBus);
      const railClock = estimate ? shiftedClock(clock, estimate.toStationMinutes) : clock;
      const railAfterBus = trainSchedule.railJourney(schedule, railStationPoint(originConnector), end, { clock: railClock, startStations: exactStation(originConnector) });
      const combined = composeBusRail(connectorBus, railAfterBus, originConnector, estimate);
      if (combined) intermodal.push(combined);
    }

    const destinationConnector = trainSchedule.nearestStations(schedule, end, 1, CONNECTOR_MAX_DISTANCE_METRES)[0];
    if (destinationConnector && destinationConnector.distanceMetres > CONNECTOR_MIN_DISTANCE_METRES) {
      const railBeforeBus = trainSchedule.railJourney(schedule, start, railStationPoint(destinationConnector), { clock, endStations: exactStation(destinationConnector) });
      const connectorBusResult = await runBusRoute(railStationPoint(destinationConnector), end).catch(() => null);
      const connectorBus = usableBusCandidate(connectorBusResult?.body);
      const combined = composeRailBus(railBeforeBus, connectorBus, destinationConnector);
      if (combined) intermodal.push(combined);
    }
  }

  intermodal.sort((left, right) => Number(Boolean(right.rankable)) - Number(Boolean(left.rankable))
    || (Number(left.estimatedTotalMinutes) || Number.POSITIVE_INFINITY) - (Number(right.estimatedTotalMinutes) || Number.POSITIVE_INFINITY));

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
      'Short direct live bus-to-rail connectors can use a bounded travel-time estimate and become rankable; long, transfer, or unmonitored connectors remain topology-only.',
      'Rail-to-bus timing remains topology-only because future bus arrivals are not projected yet.',
      'Walking access and egress currently use straight-line distance.',
    ],
    updatedAt: new Date().toISOString(),
  });
};

module.exports._test = { captureResponse, usableBusCandidate, shiftedClock, monitoredCatchable, estimateDirectBusToStation, busLegs, composeBusRail, composeRailBus };
