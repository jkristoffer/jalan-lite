const { fetchJson } = require('./_upstream');

const ONEMAP_ROUTING_URL = 'https://www.onemap.gov.sg/api/public/routingsvc/route';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function routeItineraries(data) {
  return data?.plan?.itineraries || data?.itineraries || [];
}

function isWalkingRouteSummaryPayload(data) {
  return isRecord(data)
    && Object.prototype.hasOwnProperty.call(data, 'status')
    && typeof data.status_message === 'string'
    && isRecord(data.route_summary)
    && Array.isArray(data.route_instructions)
    && finiteNonNegative(data.route_summary.total_distance) !== null
    && finiteNonNegative(data.route_summary.total_time) !== null;
}

function isRoutePayload(data) {
  const itineraries = routeItineraries(data);
  return isRecord(data)
    && (isWalkingRouteSummaryPayload(data)
      || (Array.isArray(itineraries) && itineraries.length > 0
        && itineraries.every((itinerary) => isRecord(itinerary) && Array.isArray(itinerary.legs))));
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function walkingResult(data) {
  if (isWalkingRouteSummaryPayload(data)) {
    return {
      distanceMetres: finiteNonNegative(data.route_summary.total_distance),
      durationSeconds: finiteNonNegative(data.route_summary.total_time),
    };
  }
  if (!isRoutePayload(data)) return null;
  const itinerary = routeItineraries(data)[0];
  if (!itinerary) return null;

  const legDistance = itinerary.legs.reduce((sum, leg) => {
    const distance = finiteNonNegative(leg?.distance);
    return distance === null ? sum : sum + distance;
  }, 0);
  const distanceMetres = finiteNonNegative(
    itinerary.walkDistance ?? itinerary.walkDistanceMetres ?? itinerary.distance,
  ) ?? (legDistance > 0 ? legDistance : null);
  if (distanceMetres === null) return null;

  const legDuration = itinerary.legs.reduce((sum, leg) => {
    const duration = finiteNonNegative(leg?.duration);
    return duration === null ? sum : sum + duration;
  }, 0);
  const durationSeconds = finiteNonNegative(itinerary.walkTime ?? itinerary.duration)
    ?? (legDuration > 0 ? legDuration : null);
  return { distanceMetres, durationSeconds };
}

function singaporeClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.month}-${values.day}-${values.year}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function pointString(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('A valid walking endpoint is required.');
  return `${lat},${lng}`;
}

async function fetchWalkingDistance({ token, start, end, signal, now = new Date() } = {}) {
  if (!token) throw new Error('OneMap walking routing token is required.');
  const clock = singaporeClock(now);
  const url = new URL(ONEMAP_ROUTING_URL);
  url.searchParams.set('start', pointString(start));
  url.searchParams.set('end', pointString(end));
  url.searchParams.set('routeType', 'walk');
  url.searchParams.set('date', clock.date);
  url.searchParams.set('time', clock.time);
  url.searchParams.set('arriveBy', 'false');
  url.searchParams.set('mode', 'WALK');
  url.searchParams.set('numItineraries', '1');

  const { data } = await fetchJson(
    url,
    { headers: { Authorization: token, Accept: 'application/json' }, signal },
    { service: 'OneMap walking routing', validate: isRoutePayload },
  );
  const result = walkingResult(data);
  if (!result) throw new Error('OneMap walking routing returned no usable distance.');
  return result;
}

module.exports = {
  ONEMAP_ROUTING_URL,
  isRoutePayload,
  isWalkingRouteSummaryPayload,
  walkingResult,
  singaporeClock,
  fetchWalkingDistance,
};
