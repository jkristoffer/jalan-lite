const nearbyStopsApi = require('./nearby-stops');
const { UpstreamError, createTimeoutSignal, fetchJson, safeUpstreamFailure } = require('./_upstream');

const LTA_BUS_ROUTES_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusRoutes';
const LTA_BUS_ARRIVAL_URL = 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival';
const PAGE_SIZE = 500;
const ROUTE_BATCH_SIZE = 6;
const MAX_ROUTE_PAGES = 100;
const ROUTE_CACHE_MS = 12 * 60 * 60 * 1000;
const ROUTE_LOAD_TIMEOUT_MS = 15000;
const SEARCH_RADIUS_METRES = 600;
const MAX_NEARBY_STOPS = 6;
const MAX_STATIC_CANDIDATES = 24;
const MAX_TRANSFER_CANDIDATES = 72;
const MAX_RESULTS = 8;
const WALKING_SPEED_METRES_PER_SECOND = 1.25;

let cachedRoutes = null;
let cachedRoutesAt = 0;
let loadingRoutes = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBusRoute(value) {
  return isRecord(value)
    && typeof value.ServiceNo === 'string'
    && value.ServiceNo.trim().length > 0
    && [1, 2].includes(Number(value.Direction))
    && Number.isInteger(Number(value.StopSequence))
    && Number(value.StopSequence) > 0
    && /^\d{5}$/.test(String(value.BusStopCode || ''))
    && value.Distance !== null
    && value.Distance !== ''
    && Number.isFinite(Number(value.Distance));
}

function isBusRoutesPayload(value) {
  return isRecord(value) && Array.isArray(value.value) && value.value.every(isBusRoute);
}

function isBusObject(value) {
  return value === undefined || value === null || (isRecord(value)
    && (value.EstimatedArrival == null || typeof value.EstimatedArrival === 'string')
    && (value.Monitored == null || ['string', 'number', 'boolean'].includes(typeof value.Monitored)));
}

function isBusArrivalPayload(value) {
  return isRecord(value)
    && Array.isArray(value.Services)
    && value.Services.every((service) => isRecord(service)
      && typeof service.ServiceNo === 'string'
      && service.ServiceNo.trim().length > 0
      && isBusObject(service.NextBus)
      && isBusObject(service.NextBus2)
      && isBusObject(service.NextBus3));
}

function parsePoint(value) {
  const match = String(value || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 1.1 || lat > 1.55 || lng < 103.5 || lng > 104.15) return null;
  return { lat, lng };
}

async function fetchRoutePage(apiKey, page, signal) {
  const url = new URL(LTA_BUS_ROUTES_URL);
  url.searchParams.set('$skip', String(page * PAGE_SIZE));
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' }, signal },
    { service: 'LTA BusRoutes', validate: isBusRoutesPayload },
  );
  return data.value;
}

async function buildRouteCache(apiKey, signal) {
  const all = [];
  for (let page = 0; page < MAX_ROUTE_PAGES; page += ROUTE_BATCH_SIZE) {
    const pageNumbers = Array.from(
      { length: Math.min(ROUTE_BATCH_SIZE, MAX_ROUTE_PAGES - page) },
      (_, index) => page + index,
    );
    const pages = await Promise.all(pageNumbers.map((pageNumber) => fetchRoutePage(apiKey, pageNumber, signal)));
    for (const rows of pages) {
      all.push(...rows);
      if (rows.length < PAGE_SIZE) {
        cachedRoutes = all;
        cachedRoutesAt = Date.now();
        return cachedRoutes;
      }
    }
  }
  throw new UpstreamError('LTA BusRoutes exceeded the supported page limit.', {
    code: 'UPSTREAM_INVALID_SHAPE',
    service: 'LTA BusRoutes',
  });
}

async function loadRoutes(apiKey, timeoutMs = ROUTE_LOAD_TIMEOUT_MS) {
  if (cachedRoutes && Date.now() - cachedRoutesAt < ROUTE_CACHE_MS) return cachedRoutes;
  if (!loadingRoutes) {
    const deadline = createTimeoutSignal(timeoutMs);
    loadingRoutes = buildRouteCache(apiKey, deadline.signal)
      .catch((error) => {
        if (deadline.didTimeout()) {
          throw new UpstreamError('LTA BusRoutes cache loading timed out.', {
            code: 'UPSTREAM_TIMEOUT',
            service: 'LTA BusRoutes',
            cause: error,
          });
        }
        throw error;
      })
      .finally(() => {
        deadline.cancel();
        loadingRoutes = null;
      });
  }
  return loadingRoutes;
}

function nearby(stopRows, point, radius = SEARCH_RADIUS_METRES, limit = MAX_NEARBY_STOPS) {
  return stopRows
    .map((stop) => ({
      stopCode: String(stop.BusStopCode),
      roadName: stop.RoadName || '',
      name: stop.Description || stop.RoadName || `Bus stop ${stop.BusStopCode}`,
      lat: Number(stop.Latitude),
      lng: Number(stop.Longitude),
      distanceMetres: Math.round(nearbyStopsApi._shared.distanceMetres(
        point.lat,
        point.lng,
        Number(stop.Latitude),
        Number(stop.Longitude),
      )),
    }))
    .filter((stop) => Number.isFinite(stop.distanceMetres) && stop.distanceMetres <= radius)
    .sort((left, right) => left.distanceMetres - right.distanceMetres)
    .slice(0, limit);
}

function normalizedRouteRow(row) {
  return {
    serviceNo: String(row.ServiceNo).trim(),
    operator: String(row.Operator || ''),
    direction: Number(row.Direction),
    sequence: Number(row.StopSequence),
    stopCode: String(row.BusStopCode),
    distanceKm: Number(row.Distance),
  };
}

function routePatterns(routeRows) {
  const patterns = new Map();
  routeRows.forEach((row) => {
    const normalized = normalizedRouteRow(row);
    const key = `${normalized.serviceNo}|${normalized.direction}`;
    if (!patterns.has(key)) {
      patterns.set(key, {
        key,
        serviceNo: normalized.serviceNo,
        operator: normalized.operator,
        direction: normalized.direction,
        stops: [],
      });
    }
    patterns.get(key).stops.push(normalized);
  });
  patterns.forEach((pattern) => pattern.stops.sort((left, right) => left.sequence - right.sequence));
  return patterns;
}

function directCandidates(routeRows, originStops, destinationStops) {
  const origins = new Map(originStops.map((stop) => [stop.stopCode, stop]));
  const destinations = new Map(destinationStops.map((stop) => [stop.stopCode, stop]));
  const services = new Map();

  routeRows.forEach((row) => {
    const stopCode = String(row.BusStopCode);
    if (!origins.has(stopCode) && !destinations.has(stopCode)) return;
    const key = `${String(row.ServiceNo).trim()}|${Number(row.Direction)}`;
    if (!services.has(key)) services.set(key, { boards: [], alights: [] });
    const service = services.get(key);
    const normalized = normalizedRouteRow(row);
    if (origins.has(stopCode)) service.boards.push({ ...normalized, stop: origins.get(stopCode) });
    if (destinations.has(stopCode)) service.alights.push({ ...normalized, stop: destinations.get(stopCode) });
  });

  const candidates = [];
  services.forEach((service) => {
    service.boards.forEach((board) => {
      service.alights.forEach((alight) => {
        if (alight.sequence <= board.sequence) return;
        const routeDistanceKm = alight.distanceKm - board.distanceKm;
        if (!Number.isFinite(routeDistanceKm) || routeDistanceKm <= 0) return;
        const rideStops = alight.sequence - board.sequence;
        candidates.push({
          kind: 'direct',
          transfers: 0,
          serviceNo: board.serviceNo,
          operator: board.operator,
          direction: board.direction,
          board: board.stop,
          alight: alight.stop,
          rideStops,
          routeDistanceKm: Number(routeDistanceKm.toFixed(2)),
          totalWalkMetres: board.stop.distanceMetres + alight.stop.distanceMetres,
          legs: [{
            serviceNo: board.serviceNo,
            operator: board.operator,
            direction: board.direction,
            boardStopCode: board.stop.stopCode,
            alightStopCode: alight.stop.stopCode,
            rideStops,
            routeDistanceKm: Number(routeDistanceKm.toFixed(2)),
          }],
        });
      });
    });
  });

  return candidates
    .sort((left, right) => left.totalWalkMetres - right.totalWalkMetres
      || left.routeDistanceKm - right.routeDistanceKm
      || left.rideStops - right.rideStops)
    .slice(0, MAX_STATIC_CANDIDATES);
}

function oneTransferCandidates(routeRows, originStops, destinationStops) {
  const origins = new Map(originStops.map((stop) => [stop.stopCode, stop]));
  const destinations = new Map(destinationStops.map((stop) => [stop.stopCode, stop]));
  const patterns = routePatterns(routeRows);
  const boards = [];
  const alights = [];

  patterns.forEach((pattern) => {
    pattern.stops.forEach((row, index) => {
      if (origins.has(row.stopCode)) boards.push({ pattern, index, row, stop: origins.get(row.stopCode) });
      if (destinations.has(row.stopCode)) alights.push({ pattern, index, row, stop: destinations.get(row.stopCode) });
    });
  });

  const candidates = [];
  const seen = new Set();

  boards.forEach((board) => {
    alights.forEach((alight) => {
      if (board.pattern.key === alight.pattern.key) return;
      if (board.pattern.serviceNo === alight.pattern.serviceNo) return;
      if (board.index >= board.pattern.stops.length - 1 || alight.index <= 0) return;

      const secondBeforeAlight = new Map();
      for (let secondIndex = 0; secondIndex < alight.index; secondIndex += 1) {
        const stopCode = alight.pattern.stops[secondIndex].stopCode;
        if (!secondBeforeAlight.has(stopCode)) secondBeforeAlight.set(stopCode, []);
        secondBeforeAlight.get(stopCode).push(secondIndex);
      }

      for (let firstIndex = board.index + 1; firstIndex < board.pattern.stops.length; firstIndex += 1) {
        const firstTransfer = board.pattern.stops[firstIndex];
        const secondIndexes = secondBeforeAlight.get(firstTransfer.stopCode);
        if (!secondIndexes) continue;

        secondIndexes.forEach((secondIndex) => {
          const secondTransfer = alight.pattern.stops[secondIndex];
          const firstDistanceKm = firstTransfer.distanceKm - board.row.distanceKm;
          const secondDistanceKm = alight.row.distanceKm - secondTransfer.distanceKm;
          if (!Number.isFinite(firstDistanceKm) || !Number.isFinite(secondDistanceKm) || firstDistanceKm <= 0 || secondDistanceKm <= 0) return;

          const signature = [
            board.pattern.key,
            board.stop.stopCode,
            firstTransfer.stopCode,
            alight.pattern.key,
            alight.stop.stopCode,
          ].join('|');
          if (seen.has(signature)) return;
          seen.add(signature);

          const firstRideStops = firstTransfer.sequence - board.row.sequence;
          const secondRideStops = alight.row.sequence - secondTransfer.sequence;
          const routeDistanceKm = firstDistanceKm + secondDistanceKm;
          candidates.push({
            kind: 'transfer',
            transfers: 1,
            serviceNo: board.pattern.serviceNo,
            secondServiceNo: alight.pattern.serviceNo,
            operator: board.pattern.operator,
            direction: board.pattern.direction,
            board: board.stop,
            alight: alight.stop,
            transfer: { stopCode: firstTransfer.stopCode },
            rideStops: firstRideStops + secondRideStops,
            routeDistanceKm: Number(routeDistanceKm.toFixed(2)),
            totalWalkMetres: board.stop.distanceMetres + alight.stop.distanceMetres,
            legs: [
              {
                serviceNo: board.pattern.serviceNo,
                operator: board.pattern.operator,
                direction: board.pattern.direction,
                boardStopCode: board.stop.stopCode,
                alightStopCode: firstTransfer.stopCode,
                rideStops: firstRideStops,
                routeDistanceKm: Number(firstDistanceKm.toFixed(2)),
              },
              {
                serviceNo: alight.pattern.serviceNo,
                operator: alight.pattern.operator,
                direction: alight.pattern.direction,
                boardStopCode: secondTransfer.stopCode,
                alightStopCode: alight.stop.stopCode,
                rideStops: secondRideStops,
                routeDistanceKm: Number(secondDistanceKm.toFixed(2)),
              },
            ],
          });
        });
      }
    });
  });

  return candidates
    .sort((left, right) => left.totalWalkMetres - right.totalWalkMetres
      || left.routeDistanceKm - right.routeDistanceKm
      || left.rideStops - right.rideStops)
    .slice(0, MAX_TRANSFER_CANDIDATES);
}

function minutesUntil(value, now = Date.now()) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.round((target - now) / 60000));
}

function accessWalkMinutes(distanceMetres) {
  return Math.max(0, Math.ceil((Number(distanceMetres) || 0) / WALKING_SPEED_METRES_PER_SECOND / 60));
}

function catchableArrival(arrivals, distanceMetres) {
  const minimum = accessWalkMinutes(distanceMetres);
  return arrivals.find((value) => Number.isFinite(value) && value >= minimum) ?? null;
}

async function fetchStopArrivals(apiKey, stopCode, signal, now = Date.now()) {
  const url = new URL(LTA_BUS_ARRIVAL_URL);
  url.searchParams.set('BusStopCode', stopCode);
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' }, signal },
    { service: 'LTA BusArrival', validate: isBusArrivalPayload },
  );
  return new Map(data.Services.map((service) => {
    const buses = [service.NextBus, service.NextBus2, service.NextBus3];
    return [String(service.ServiceNo).trim(), {
      arrivals: buses.map((bus) => minutesUntil(bus?.EstimatedArrival, now)),
      monitored: buses.map((bus) => bus?.Monitored === '1' || bus?.Monitored === 1 || bus?.Monitored === true),
    }];
  }));
}

async function attachLiveArrivals(apiKey, candidates, signal) {
  const byStop = new Map();
  candidates.forEach((candidate) => {
    if (!byStop.has(candidate.board.stopCode)) byStop.set(candidate.board.stopCode, []);
    byStop.get(candidate.board.stopCode).push(candidate);
  });

  await Promise.all([...byStop.entries()].map(async ([stopCode, stopCandidates]) => {
    try {
      const services = await fetchStopArrivals(apiKey, stopCode, signal);
      stopCandidates.forEach((candidate) => {
        const live = services.get(candidate.serviceNo);
        candidate.liveStatus = live ? 'ready' : 'unavailable';
        candidate.arrivals = live?.arrivals || [null, null, null];
        candidate.monitored = live?.monitored || [false, false, false];
        candidate.catchableArrivalMinutes = live ? catchableArrival(live.arrivals, candidate.board.distanceMetres) : null;
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      stopCandidates.forEach((candidate) => {
        candidate.liveStatus = 'error';
        candidate.arrivals = [null, null, null];
        candidate.monitored = [false, false, false];
        candidate.catchableArrivalMinutes = null;
      });
    }
  }));

  return candidates;
}

function rankCandidates(candidates) {
  return [...candidates]
    .sort((left, right) => {
      const leftLive = Number.isFinite(left.catchableArrivalMinutes) ? left.catchableArrivalMinutes : Number.POSITIVE_INFINITY;
      const rightLive = Number.isFinite(right.catchableArrivalMinutes) ? right.catchableArrivalMinutes : Number.POSITIVE_INFINITY;
      return leftLive - rightLive
        || (Number(left.transfers) || 0) - (Number(right.transfers) || 0)
        || left.totalWalkMetres - right.totalWalkMetres
        || left.routeDistanceKm - right.routeDistanceKm
        || left.rideStops - right.rideStops;
    })
    .slice(0, MAX_RESULTS);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://dailyloop.local');
    const start = parsePoint(url.searchParams.get('start'));
    const end = parsePoint(url.searchParams.get('end'));
    if (!start || !end) return res.status(400).json({ error: 'Valid Singapore start and end coordinates are required.' });

    const apiKey = process.env.LTA_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'LTA_API_KEY is not configured.' });

    const [stopRows, routeRows] = await Promise.all([
      nearbyStopsApi._shared.loadStops(apiKey),
      loadRoutes(apiKey),
    ]);
    const originStops = nearby(stopRows, start);
    const destinationStops = nearby(stopRows, end);
    if (!originStops.length || !destinationStops.length) {
      return res.status(200).json({
        engine: 'lta-realtime-bus-v2',
        scope: 'bus-up-to-one-transfer',
        candidates: [],
        reason: 'No nearby LTA bus stops were found within 600 metres of one or both endpoints.',
      });
    }

    const direct = directCandidates(routeRows, originStops, destinationStops);
    const transfers = oneTransferCandidates(routeRows, originStops, destinationStops);
    const candidates = [...direct, ...transfers];
    if (!candidates.length) {
      return res.status(200).json({
        engine: 'lta-realtime-bus-v2',
        scope: 'bus-up-to-one-transfer',
        candidates: [],
        reason: 'No direct or one-transfer bus journey connects the nearby origin and destination stops.',
      });
    }

    const liveDeadline = createTimeoutSignal(8000);
    try {
      await attachLiveArrivals(apiKey, candidates, liveDeadline.signal);
    } finally {
      liveDeadline.cancel();
    }

    return res.status(200).json({
      engine: 'lta-realtime-bus-v2',
      scope: 'bus-up-to-one-transfer',
      candidates: rankCandidates(candidates),
      nearby: { origin: originStops, destination: destinationStops },
      limitations: [
        'Bus journeys support direct routes and one transfer; MRT/LRT are not routed yet.',
        'Access and egress distances are straight-line approximations.',
        'Live arrivals determine first-bus catchability, but second-leg transfer timing and in-vehicle travel time are not estimated yet.',
      ],
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    safeUpstreamFailure(error);
    return res.status(502).json({ error: 'LTA realtime routing is temporarily unavailable.' });
  }
};

module.exports._test = {
  isBusRoutesPayload,
  parsePoint,
  directCandidates,
  oneTransferCandidates,
  accessWalkMinutes,
  catchableArrival,
  rankCandidates,
  resetRouteCache() {
    cachedRoutes = null;
    cachedRoutesAt = 0;
    loadingRoutes = null;
  },
};
