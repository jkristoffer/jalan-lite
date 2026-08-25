const busHandler = require('./realtime-route');
const trainSchedule = require('./train-schedule')._shared;

const CONNECTOR_MIN_DISTANCE_METRES = 600;
const CONNECTOR_MAX_DISTANCE_METRES = 3500;

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
    note: 'Bus travel time to the rail transfer is not yet modeled, so this path is topology-only and is not ranked.',
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
  const schedulePromise = trainSchedule.loadSchedule().then((schedule) => ({ schedule })).catch((error) => ({ error }));
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
      const railAfterBus = trainSchedule.railJourney(schedule, railStationPoint(originConnector), end, { clock, startStations: exactStation(originConnector) });
      const combined = composeBusRail(connectorBus, railAfterBus, originConnector);
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

  const busOk = busResult.status === 200 && busResult.body;
  if (!busOk && !rail && !intermodal.length) {
    return res.status(502).json({ error: 'LTA multimodal routing is temporarily unavailable.', busError: busResult.body?.error || null, railError: scheduleResult.error ? 'Train schedule unavailable.' : null });
  }

  return res.status(200).json({
    engine: 'lta-realtime-multimodal-v1',
    scope: 'live-bus-plus-scheduled-rail',
    bus: busOk ? busResult.body : { candidates: [], error: busResult.body?.error || 'Bus routing unavailable.' },
    rail: rail ? { candidate: rail, source: 'LTA GTFS Schedule (Train)' } : { candidate: null, reason: scheduleResult.error ? 'Train schedule unavailable.' : 'No scheduled rail journey connects nearby stations at this time.' },
    intermodal,
    limitations: [
      'Rail routing uses the official LTA GTFS Schedule and supports scheduled MRT/LRT line transfers.',
      'Bus-only routing continues to use LTA BusRoutes and live BusArrival data.',
      'Bus-to-rail and rail-to-bus paths are topology-only until bus in-vehicle travel time is modeled; they are not ranked against complete journeys.',
      'Walking access and egress currently use straight-line distance.',
    ],
    updatedAt: new Date().toISOString(),
  });
};

module.exports._test = { captureResponse, usableBusCandidate, busLegs, composeBusRail, composeRailBus };
