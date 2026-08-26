const nearbyStopsApi = require('./nearby-stops');
const busServiceSchedule = require('./bus-service-schedule');
const { getOneMapToken } = require('./_onemap-auth');
const onemapWalking = require('./onemap-walking');
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
const RECHECK_SEARCH_RADIUS_METRES = 1200;
const RECHECK_MAX_NEARBY_STOPS = 18;
const RECHECK_ENDPOINT_DISTANCE_PROXY_THRESHOLD_METRES = 450;
// The threshold uses straight-line endpoint distance, not a measured pedestrian route.
const WALKING_CHECK_TIMEOUT_MS = 5000;
const MAX_WALKING_CANDIDATES = 8;
const MAX_STATIC_CANDIDATES = 24;
const MAX_TRANSFER_CANDIDATES = 72;
const MAX_TRANSFER_LIVE_CHECKS = 12;
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
    .map((stop) => {
      const distanceMetres = Math.round(nearbyStopsApi._shared.distanceMetres(
        point.lat,
        point.lng,
        Number(stop.Latitude),
        Number(stop.Longitude),
      ));
      return {
        stopCode: String(stop.BusStopCode),
        roadName: stop.RoadName || '',
        name: stop.Description || stop.RoadName || `Bus stop ${stop.BusStopCode}`,
        lat: Number(stop.Latitude),
        lng: Number(stop.Longitude),
        distanceMetres,
        straightLineDistanceMetres: distanceMetres,
      };
    })
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
    operatingWindow: busServiceSchedule.normalizeOperatingWindow(row),
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
            ...(board.operatingWindow ? { operatingWindow: board.operatingWindow } : {}),
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
                ...(board.row.operatingWindow ? { operatingWindow: board.row.operatingWindow } : {}),
              },
              {
                serviceNo: alight.pattern.serviceNo,
                operator: alight.pattern.operator,
                direction: alight.pattern.direction,
                boardStopCode: secondTransfer.stopCode,
                alightStopCode: alight.stop.stopCode,
                rideStops: secondRideStops,
                routeDistanceKm: Number(secondDistanceKm.toFixed(2)),
                ...(secondTransfer.operatingWindow ? { operatingWindow: secondTransfer.operatingWindow } : {}),
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

function compareCandidateDiscovery(left, right) {
  const leftWalk = Number.isFinite(Number(left.totalWalkMetres))
    ? Number(left.totalWalkMetres)
    : Number.POSITIVE_INFINITY;
  const rightWalk = Number.isFinite(Number(right.totalWalkMetres))
    ? Number(right.totalWalkMetres)
    : Number.POSITIVE_INFINITY;
  const leftDistance = Number.isFinite(Number(left.routeDistanceKm))
    ? Number(left.routeDistanceKm)
    : Number.POSITIVE_INFINITY;
  const rightDistance = Number.isFinite(Number(right.routeDistanceKm))
    ? Number(right.routeDistanceKm)
    : Number.POSITIVE_INFINITY;
  const leftRideStops = Number.isFinite(Number(left.rideStops))
    ? Number(left.rideStops)
    : Number.POSITIVE_INFINITY;
  const rightRideStops = Number.isFinite(Number(right.rideStops))
    ? Number(right.rideStops)
    : Number.POSITIVE_INFINITY;
  return (Number(left.transfers) || 0) - (Number(right.transfers) || 0)
    || leftWalk - rightWalk
    || leftDistance - rightDistance
    || leftRideStops - rightRideStops;
}

function shouldRecheckCandidateDiscovery({ originStops = [], destinationStops = [], candidates = [] } = {}) {
  if (!originStops.length || !destinationStops.length || !candidates.length) return true;
  const best = [...candidates].sort(compareCandidateDiscovery)[0];
  return [best.board?.distanceMetres, best.alight?.distanceMetres]
    .some((distance) => Number.isFinite(Number(distance))
      && Number(distance) > RECHECK_ENDPOINT_DISTANCE_PROXY_THRESHOLD_METRES);
}

function discoverCandidatePass(stopRows, routeRows, start, end, radius, limit) {
  const originStops = nearby(stopRows, start, radius, limit);
  const destinationStops = nearby(stopRows, end, radius, limit);
  const candidates = [
    ...directCandidates(routeRows, originStops, destinationStops),
    ...oneTransferCandidates(routeRows, originStops, destinationStops),
  ];
  return { originStops, destinationStops, candidates };
}

function discoverCandidates(stopRows, routeRows, start, end) {
  const primary = discoverCandidatePass(
    stopRows,
    routeRows,
    start,
    end,
    SEARCH_RADIUS_METRES,
    MAX_NEARBY_STOPS,
  );
  if (!shouldRecheckCandidateDiscovery(primary)) {
    return { ...primary, primary, rechecked: false };
  }

  const expanded = discoverCandidatePass(
    stopRows,
    routeRows,
    start,
    end,
    RECHECK_SEARCH_RADIUS_METRES,
    RECHECK_MAX_NEARBY_STOPS,
  );
  const selected = expanded.candidates.length || !primary.candidates.length ? expanded : primary;
  return { ...selected, primary, expanded, rechecked: true };
}

function pointIsValid(point) {
  return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));
}

function walkingEndpoints(candidates, start, end, maxCandidates = MAX_WALKING_CANDIDATES) {
  if (!pointIsValid(start) || !pointIsValid(end)) return [];
  const endpoints = [];
  const seen = new Set();
  [...candidates]
    .sort(compareCandidateDiscovery)
    .slice(0, maxCandidates)
    .forEach((candidate) => {
      const add = (side, stop, from, to) => {
        if (!stop?.stopCode || !pointIsValid(stop)) return;
        const key = `${side}:${stop.stopCode}`;
        if (seen.has(key)) return;
        seen.add(key);
        endpoints.push({ key, side, stop, start: from, end: to });
      };
      add('access', candidate.board, start, candidate.board);
      add('egress', candidate.alight, candidate.alight, end);
    });
  return endpoints;
}

function normalizeWalkingResult(value) {
  const distanceMetres = Number(value?.distanceMetres);
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) return null;
  const durationSeconds = Number(value?.durationSeconds);
  return {
    distanceMetres: Math.round(distanceMetres),
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : null,
  };
}

function applyWalkingResult(stop, result) {
  const normalized = normalizeWalkingResult(result);
  if (!normalized) return false;
  const straightLineDistanceMetres = Number(stop.straightLineDistanceMetres ?? stop.distanceMetres);
  if (Number.isFinite(straightLineDistanceMetres) && stop.straightLineDistanceMetres === undefined) {
    stop.straightLineDistanceMetres = straightLineDistanceMetres;
  }
  stop.distanceMetres = normalized.distanceMetres;
  stop.walkingDistanceMetres = normalized.distanceMetres;
  if (normalized.durationSeconds === null) delete stop.walkingDurationSeconds;
  else stop.walkingDurationSeconds = normalized.durationSeconds;
  stop.walkingDistanceSource = 'onemap-walk';
  return true;
}

function refreshCandidateWalkingMetrics(candidates) {
  candidates.forEach((candidate) => {
    const boardDistance = Number(candidate.board?.distanceMetres);
    const alightDistance = Number(candidate.alight?.distanceMetres);
    if (Number.isFinite(boardDistance) && Number.isFinite(alightDistance)) {
      candidate.totalWalkMetres = Math.round(boardDistance + alightDistance);
    }
    const measured = [candidate.board, candidate.alight]
      .filter((stop) => stop?.walkingDistanceSource === 'onemap-walk').length;
    candidate.walkingDistanceStatus = measured === 2 ? 'measured' : measured === 1 ? 'partial' : 'proxy';
  });
  return candidates;
}

async function attachWalkingDistances(candidates, start, end, {
  signal = null,
  walkingProvider = null,
  allowNetwork = true,
  now = Date.now(),
} = {}) {
  const endpoints = walkingEndpoints(candidates, start, end);
  if (!endpoints.length) return { status: 'not-requested', checked: 0, failed: 0 };

  let provider = walkingProvider;
  if (!provider && !allowNetwork) {
    refreshCandidateWalkingMetrics(candidates);
    return { status: 'unavailable', checked: 0, failed: endpoints.length };
  }
  if (!provider) {
    let token;
    try {
      token = await getOneMapToken({ signal });
    } catch {
      refreshCandidateWalkingMetrics(candidates);
      return { status: 'unavailable', checked: 0, failed: endpoints.length };
    }
    provider = ({ start: from, end: to, signal: requestSignal }) => onemapWalking.fetchWalkingDistance({
      token,
      start: from,
      end: to,
      signal: requestSignal,
      now,
    });
  }

  const results = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const result = await provider({ ...endpoint, signal, now });
      return { endpoint, result: normalizeWalkingResult(result) };
    } catch {
      return { endpoint, result: null };
    }
  }));
  let checked = 0;
  let failed = 0;
  results.forEach(({ endpoint, result }) => {
    if (applyWalkingResult(endpoint.stop, result)) checked += 1;
    else failed += 1;
  });
  refreshCandidateWalkingMetrics(candidates);
  return {
    status: checked === endpoints.length ? 'ready' : checked ? 'partial' : 'unavailable',
    checked,
    failed,
  };
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

function normalizeArrivalPayload(payload, now = Date.now()) {
  if (!isBusArrivalPayload(payload)) throw new Error('Invalid LTA BusArrival payload.');
  return new Map(payload.Services.map((service) => {
    const buses = [service.NextBus, service.NextBus2, service.NextBus3];
    return [String(service.ServiceNo).trim(), {
      arrivals: buses.map((bus) => minutesUntil(bus?.EstimatedArrival, now)),
      monitored: buses.map((bus) => bus?.Monitored === '1' || bus?.Monitored === 1 || bus?.Monitored === true),
    }];
  }));
}

async function fetchStopArrivals(apiKey, stopCode, signal, now = Date.now(), arrivalProvider = null) {
  if (typeof arrivalProvider === 'function') {
    return arrivalProvider({ apiKey, stopCode, signal, now });
  }
  const url = new URL(LTA_BUS_ARRIVAL_URL);
  url.searchParams.set('BusStopCode', stopCode);
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' }, signal },
    { service: 'LTA BusArrival', validate: isBusArrivalPayload },
  );
  return normalizeArrivalPayload(data, now);
}

function setLegLive(candidate, index, status, arrivals, monitored, catchableArrivalMinutes = null) {
  const leg = candidate.legs?.[index];
  if (!leg) return;
  leg.liveStatus = status;
  leg.arrivals = arrivals;
  leg.monitored = monitored;
  if (index === 0) leg.catchableArrivalMinutes = catchableArrivalMinutes;
}

async function attachLiveArrivals(apiKey, candidates, signal, { now = Date.now(), arrivalProvider = null } = {}) {
  const byStop = new Map();
  candidates.forEach((candidate) => {
    if (!byStop.has(candidate.board.stopCode)) byStop.set(candidate.board.stopCode, []);
    byStop.get(candidate.board.stopCode).push(candidate);
  });

  await Promise.all([...byStop.entries()].map(async ([stopCode, stopCandidates]) => {
    try {
      const services = await fetchStopArrivals(apiKey, stopCode, signal, now, arrivalProvider);
      stopCandidates.forEach((candidate) => {
        const live = services.get(candidate.serviceNo);
        const status = live ? 'ready' : 'unavailable';
        const arrivals = live?.arrivals || [null, null, null];
        const monitored = live?.monitored || [false, false, false];
        const catchable = live ? catchableArrival(live.arrivals, candidate.board.distanceMetres) : null;
        candidate.liveStatus = status;
        candidate.arrivals = arrivals;
        candidate.monitored = monitored;
        candidate.catchableArrivalMinutes = catchable;
        setLegLive(candidate, 0, status, arrivals, monitored, catchable);
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      stopCandidates.forEach((candidate) => {
        candidate.liveStatus = 'error';
        candidate.arrivals = [null, null, null];
        candidate.monitored = [false, false, false];
        candidate.catchableArrivalMinutes = null;
        setLegLive(candidate, 0, 'error', [null, null, null], [false, false, false], null);
      });
    }
  }));

  return candidates;
}

async function attachTransferLiveArrivals(apiKey, candidates, signal, { now = Date.now(), arrivalProvider = null } = {}) {
  const transfers = candidates.filter((candidate) => candidate.kind === 'transfer' && candidate.legs?.[1]);
  transfers.forEach((candidate) => {
    candidate.secondLiveStatus = 'unchecked';
    candidate.secondArrivals = [null, null, null];
    candidate.secondMonitored = [false, false, false];
    setLegLive(candidate, 1, 'unchecked', candidate.secondArrivals, candidate.secondMonitored);
  });

  const shortlist = transfers
    .filter((candidate) => Number.isFinite(candidate.catchableArrivalMinutes))
    .sort((left, right) => left.catchableArrivalMinutes - right.catchableArrivalMinutes
      || left.totalWalkMetres - right.totalWalkMetres
      || left.routeDistanceKm - right.routeDistanceKm
      || left.rideStops - right.rideStops)
    .slice(0, MAX_TRANSFER_LIVE_CHECKS);
  const byStop = new Map();
  shortlist.forEach((candidate) => {
    const stopCode = candidate.transfer?.stopCode;
    if (!stopCode) return;
    if (!byStop.has(stopCode)) byStop.set(stopCode, []);
    byStop.get(stopCode).push(candidate);
  });

  await Promise.all([...byStop.entries()].map(async ([stopCode, stopCandidates]) => {
    try {
      const services = await fetchStopArrivals(apiKey, stopCode, signal, now, arrivalProvider);
      stopCandidates.forEach((candidate) => {
        const live = services.get(candidate.secondServiceNo);
        const status = live ? 'ready' : 'unavailable';
        const arrivals = live?.arrivals || [null, null, null];
        const monitored = live?.monitored || [false, false, false];
        candidate.secondLiveStatus = status;
        candidate.secondArrivals = arrivals;
        candidate.secondMonitored = monitored;
        setLegLive(candidate, 1, status, arrivals, monitored);
      });
    } catch {
      stopCandidates.forEach((candidate) => {
        candidate.secondLiveStatus = 'error';
        candidate.secondArrivals = [null, null, null];
        candidate.secondMonitored = [false, false, false];
        setLegLive(candidate, 1, 'error', candidate.secondArrivals, candidate.secondMonitored);
      });
    }
  }));

  return candidates;
}

async function attachServiceSchedules(apiKey, candidates, serviceScheduleProvider = null) {
  const schedules = typeof serviceScheduleProvider === 'function'
    ? await serviceScheduleProvider({ apiKey })
    : await busServiceSchedule.loadServiceSchedules(apiKey);
  candidates.forEach((candidate) => {
    (candidate.legs || []).forEach((leg) => {
      const schedule = schedules.get(busServiceSchedule.serviceKey(leg.serviceNo, leg.direction));
      if (schedule) leg.serviceSchedule = schedule;
    });
  });
  return candidates;
}

function liveCoverageTier(candidate) {
  if (!Number.isFinite(candidate.catchableArrivalMinutes)) return 2;
  if ((Number(candidate.transfers) || 0) === 0) return 0;
  const secondArrivals = candidate.secondArrivals || candidate.legs?.[1]?.arrivals || [];
  return candidate.secondLiveStatus === 'ready' && secondArrivals.some(Number.isFinite) ? 0 : 1;
}

function journeyKey(candidate) {
  const services = (candidate.legs || []).map((leg) => `${leg.serviceNo}:${leg.direction}`).join('>') || `${candidate.serviceNo}:${candidate.direction}`;
  return `${candidate.kind || 'direct'}|${services}|${candidate.board?.stopCode || ''}|${candidate.alight?.stopCode || ''}`;
}

function rankCandidates(candidates) {
  const ranked = [...candidates]
    .sort((left, right) => {
      const leftLive = Number.isFinite(left.catchableArrivalMinutes) ? left.catchableArrivalMinutes : Number.POSITIVE_INFINITY;
      const rightLive = Number.isFinite(right.catchableArrivalMinutes) ? right.catchableArrivalMinutes : Number.POSITIVE_INFINITY;
      return liveCoverageTier(left) - liveCoverageTier(right)
        || (Number(left.transfers) || 0) - (Number(right.transfers) || 0)
        || leftLive - rightLive
        || left.totalWalkMetres - right.totalWalkMetres
        || left.routeDistanceKm - right.routeDistanceKm
        || left.rideStops - right.rideStops;
    });
  const seen = new Set();
  return ranked
    .filter((candidate) => {
      const key = journeyKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RESULTS);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://dailyloop.local');
    const start = parsePoint(url.searchParams.get('start'));
    const end = parsePoint(url.searchParams.get('end'));
    const includeSchedule = url.searchParams.get('includeSchedule') === '1';
    if (!start || !end) return res.status(400).json({ error: 'Valid Singapore start and end coordinates are required.' });

    const apiKey = process.env.LTA_API_KEY;
    const benchmark = req._benchmark || {};
    const hasStaticProviders = typeof benchmark.stopsProvider === 'function' && typeof benchmark.routesProvider === 'function';
    if (!apiKey && !hasStaticProviders) return res.status(503).json({ error: 'LTA_API_KEY is not configured.' });
    const liveOptions = {
      now: Number.isFinite(Number(benchmark.nowMs)) ? Number(benchmark.nowMs) : Date.now(),
      arrivalProvider: benchmark.arrivalProvider,
    };

    const [stopRows, routeRows] = await Promise.all([
      typeof benchmark.stopsProvider === 'function' ? benchmark.stopsProvider({ apiKey }) : nearbyStopsApi._shared.loadStops(apiKey),
      typeof benchmark.routesProvider === 'function' ? benchmark.routesProvider({ apiKey }) : loadRoutes(apiKey),
    ]);
    const discovery = discoverCandidates(stopRows, routeRows, start, end);
    const { originStops, destinationStops, candidates } = discovery;
    if (!originStops.length || !destinationStops.length) {
      return res.status(200).json({
        engine: 'lta-realtime-bus-v2',
        scope: 'bus-up-to-one-transfer',
        candidates: [],
        reason: 'No nearby LTA bus stops were found within 600 metres of one or both endpoints.',
      });
    }

    if (!candidates.length) {
      const hadPrimaryEndpointCoverage = discovery.primary.originStops.length > 0
        && discovery.primary.destinationStops.length > 0;
      return res.status(200).json({
        engine: 'lta-realtime-bus-v2',
        scope: 'bus-up-to-one-transfer',
        candidates: [],
        reason: hadPrimaryEndpointCoverage
          ? 'No direct or one-transfer bus journey connects the nearby origin and destination stops.'
          : 'No nearby LTA bus stops were found within 600 metres of one or both endpoints.',
      });
    }

    let walkingCheck = { status: 'not-requested', checked: 0, failed: 0 };
    if (discovery.rechecked) {
      const walkingDeadline = createTimeoutSignal(WALKING_CHECK_TIMEOUT_MS);
      try {
        walkingCheck = await attachWalkingDistances(candidates, start, end, {
          signal: walkingDeadline.signal,
          walkingProvider: benchmark.walkingProvider,
          allowNetwork: !hasStaticProviders,
          now: liveOptions.now,
        });
      } finally {
        walkingDeadline.cancel();
      }
    }

    const liveDeadline = createTimeoutSignal(8000);
    try {
      await attachLiveArrivals(apiKey, candidates, liveDeadline.signal, liveOptions);
      await attachTransferLiveArrivals(apiKey, candidates, liveDeadline.signal, liveOptions);
    } finally {
      liveDeadline.cancel();
    }

    let scheduleStatus = 'not-requested';
    if (includeSchedule) {
      try {
        await attachServiceSchedules(apiKey, candidates, benchmark.serviceScheduleProvider);
        scheduleStatus = 'ready';
      } catch (error) {
        busServiceSchedule.reset();
        scheduleStatus = 'unavailable';
        safeUpstreamFailure(error);
      }
    }
    if (!includeSchedule) {
      candidates.forEach((candidate) => {
        (candidate.legs || []).forEach((leg) => {
          delete leg.operatingWindow;
          delete leg.serviceSchedule;
        });
      });
    }

    const response = {
      engine: 'lta-realtime-bus-v2',
      scope: 'bus-up-to-one-transfer',
      candidates: rankCandidates(candidates),
      nearby: { origin: originStops, destination: destinationStops },
      limitations: [
        'Bus journeys support direct routes and one transfer; MRT/LRT are not routed yet.',
        'Access and egress use OneMap walking-network distance during the bounded recheck when available; otherwise they remain straight-line approximations.',
        'Live arrivals are checked for both bus services when bounded live data is available, but transfer catchability and in-vehicle travel time are not estimated yet.',
      ],
      walkingCheck,
      updatedAt: new Date().toISOString(),
    };
    if (includeSchedule) response.scheduleStatus = scheduleStatus;
    return res.status(200).json(response);
  } catch (error) {
    safeUpstreamFailure(error);
    return res.status(502).json({ error: 'LTA realtime routing is temporarily unavailable.' });
  }
};

module.exports._test = {
  isBusArrivalPayload,
  isBusRoutesPayload,
  parsePoint,
  directCandidates,
  oneTransferCandidates,
  discoverCandidates,
  shouldRecheckCandidateDiscovery,
  walkingEndpoints,
  normalizeWalkingResult,
  refreshCandidateWalkingMetrics,
  attachWalkingDistances,
  accessWalkMinutes,
  catchableArrival,
  fetchStopArrivals,
  normalizeArrivalPayload,
  attachLiveArrivals,
  attachTransferLiveArrivals,
  attachServiceSchedules,
  busServiceSchedule,
  liveCoverageTier,
  rankCandidates,
  resetRouteCache() {
    cachedRoutes = null;
    cachedRoutesAt = 0;
    loadingRoutes = null;
  },
};
