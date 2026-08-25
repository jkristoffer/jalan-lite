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
    const normalized = {
      serviceNo: String(row.ServiceNo).trim(),
      operator: String(row.Operator || ''),
      direction: Number(row.Direction),
      sequence: Number(row.StopSequence),
      distanceKm: Number(row.Distance),
    };
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
        candidates.push({
          serviceNo: board.serviceNo,
          operator: board.operator,
          direction: board.direction,
          board: board.stop,
          alight: alight.stop,
          rideStops: alight.sequence - board.sequence,
          routeDistanceKm: Number(routeDistanceKm.toFixed(2)),
          totalWalkMetres: board.stop.distanceMetres + alight.stop.distanceMetres,
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
        engine: 'lta-realtime-direct-bus-v1',
        scope: 'direct-bus',
        candidates: [],
        reason: 'No nearby LTA bus stops were found within 600 metres of one or both endpoints.',
      });
    }

    const candidates = directCandidates(routeRows, originStops, destinationStops);
    if (!candidates.length) {
      return res.status(200).json({
        engine: 'lta-realtime-direct-bus-v1',
        scope: 'direct-bus',
        candidates: [],
        reason: 'No direct bus service connects the nearby origin and destination stops.',
      });
    }

    const liveDeadline = createTimeoutSignal(8000);
    try {
      await attachLiveArrivals(apiKey, candidates, liveDeadline.signal);
    } finally {
      liveDeadline.cancel();
    }

    return res.status(200).json({
      engine: 'lta-realtime-direct-bus-v1',
      scope: 'direct-bus',
      candidates: rankCandidates(candidates),
      nearby: { origin: originStops, destination: destinationStops },
      limitations: [
        'Direct buses only; transfers and MRT/LRT are not routed yet.',
        'Access and egress distances are straight-line approximations.',
        'Live arrivals determine catchability, but in-vehicle travel time is not estimated yet.',
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
  accessWalkMinutes,
  catchableArrival,
  rankCandidates,
  resetRouteCache() {
    cachedRoutes = null;
    cachedRoutesAt = 0;
    loadingRoutes = null;
  },
};
