
const { getOneMapToken } = require('./_onemap-auth');
const { fetchJson, safeUpstreamFailure } = require('./_upstream');

function sgDateTime() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: p.month + '-' + p.day + '-' + p.year, time: p.hour + ':' + p.minute + ':' + p.second, hour: Number(p.hour) };
}

function addDay(date) {
  const [month, day, year] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return String(next.getUTCMonth() + 1).padStart(2, '0') + '-' + String(next.getUTCDate()).padStart(2, '0') + '-' + next.getUTCFullYear();
}

function shiftSgDateTime(date, time, offsetMinutes) {
  const [month, day, year] = date.split('-').map(Number);
  const [hour, minute, second = '0'] = time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute, second) + offsetMinutes * 60000);
  return {
    date: String(shifted.getUTCMonth() + 1).padStart(2, '0') + '-' + String(shifted.getUTCDate()).padStart(2, '0') + '-' + shifted.getUTCFullYear(),
    time: String(shifted.getUTCHours()).padStart(2, '0') + ':' + String(shifted.getUTCMinutes()).padStart(2, '0') + ':' + String(shifted.getUTCSeconds()).padStart(2, '0'),
  };
}

function sgTimestamp(date, time) {
  const [month, day, year] = date.split('-').map(Number);
  const [hour, minute, second = '0'] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000;
}

function validCoord(value) {
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value);
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function routeItineraries(data) {
  return data?.plan?.itineraries || data?.itineraries || [];
}

function isRoutePayload(data) {
  const value = data?.plan?.itineraries ?? data?.itineraries;
  return isRecord(data)
    && Array.isArray(value)
    && value.every((itinerary) => isRecord(itinerary)
      && Array.isArray(itinerary.legs)
      && Number.isFinite(Number(itinerary.startTime))
      && Number.isFinite(Number(itinerary.endTime)));
}

function isRouteResponsePayload(data) {
  return isRoutePayload(data)
    || (isRecord(data) && typeof data.error === 'string')
    || (isRecord(data) && typeof data.message === 'string');
}

function hasItinerary(data) {
  return routeItineraries(data).length > 0;
}

function isNoRoute(response, data) {
  const message = String(data?.error || data?.message || '');
  return response?.status === 404
    || (isRoutePayload(data) && !hasItinerary(data))
    || /no .*route|no itinerary|not found/i.test(message);
}

async function requestRoute({ token, start, end, date, time, arriveBy = false, numItineraries = '3', maxWalkDistance = '1200' }) {
  const url = new URL('https://www.onemap.gov.sg/api/public/routingsvc/route');
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('routeType', 'pt');
  url.searchParams.set('date', date);
  url.searchParams.set('time', time);
  url.searchParams.set('arriveBy', String(Boolean(arriveBy)));
  url.searchParams.set('mode', 'TRANSIT');
  url.searchParams.set('maxWalkDistance', maxWalkDistance);
  url.searchParams.set('numItineraries', numItineraries);

  return fetchJson(
    url,
    { headers: { Authorization: token } },
    {
      service: 'OneMap routing',
      allowStatuses: [404],
      validate: isRouteResponsePayload,
    },
  );
}

async function requestArriveBy({ token, start, end, date, time }) {
  const target = sgTimestamp(date, time);
  const probeOffsets = [0, 30, 60, 90, 120, 180, 240];
  const probes = await Promise.all(probeOffsets.map(async (offset) => {
    const probe = shiftSgDateTime(date, time, -offset);
    try {
      return { offset, ...(await requestRoute({ token, start, end, date: probe.date, time: probe.time, arriveBy: false })) };
    } catch (error) {
      return { offset, error };
    }
  }));

  const candidates = [];
  const seen = new Set();
  const usableResponse = probes.some((probe) => probe.response);
  const failedProbe = probes.find((probe) => probe.error);

  probes.forEach((probe) => {
    if (!probe.response?.ok || !isRoutePayload(probe.data)) return;
    probe.data.plan = { ...(probe.data.plan || {}), itineraries: routeItineraries(probe.data) };
    routeItineraries(probe.data).forEach((itinerary) => {
      const endTime = Number(itinerary.endTime || 0);
      const startTime = Number(itinerary.startTime || 0);
      if (endTime && endTime <= target && startTime) candidates.push({ data: probe.data, itinerary, startTime, endTime });
    });
  });

  if (!candidates.length) {
    if (!usableResponse && failedProbe) throw failedProbe.error;
    return null;
  }

  candidates.sort((left, right) => right.startTime - left.startTime || left.endTime - right.endTime);
  const alternatives = [];
  candidates.forEach((candidate) => {
    const signature = [
      candidate.itinerary.startTime,
      candidate.itinerary.endTime,
      (candidate.itinerary.legs || []).map((leg) => (leg.mode || '') + ':' + (leg.route || '') + ':' + (leg.from?.stopId || leg.from?.name) + ':' + (leg.to?.stopId || leg.to?.name)).join('|'),
    ].join(':');
    if (!seen.has(signature) && alternatives.length < 3) {
      seen.add(signature);
      alternatives.push(candidate.itinerary);
    }
  });

  const best = candidates[0];
  best.data.plan = { ...(best.data.plan || {}), itineraries: alternatives };
  return best.data;
}

function upstreamResponse(res, error, message) {
  if (error?.code === 'ONEMAP_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'OneMap routing is not configured.' });
  }
  safeUpstreamFailure(error);
  return res.status(502).json({ error: message });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const start = String(req.query?.start || '');
    const end = String(req.query?.end || '');
    const requestedTime = String(req.query?.time || '').trim();
    const requestedMode = requestedTime && String(req.query?.timeMode || '').trim().toLowerCase() === 'arrive' ? 'arrive' : 'depart';
    const arriveBy = requestedMode === 'arrive';

    if (!validCoord(start) || !validCoord(end)) return res.status(400).json({ error: 'Valid start and end coordinates are required.' });
    if (requestedTime && !validTime(requestedTime)) return res.status(400).json({ error: 'Time must use HH:MM format.' });

    const token = await getOneMapToken();
    const now = sgDateTime();
    const planned = Boolean(requestedTime);
    const queryTime = planned ? requestedTime + ':00' : now.time;

    if (arriveBy) {
      const arrived = await requestArriveBy({ token, start, end, date: now.date, time: queryTime });
      if (arrived) {
        arrived._jalan = { service: 'planned', requestedDate: now.date, requestedTime: queryTime, timeMode: 'arrive' };
        return res.status(200).json(arrived);
      }
      return res.status(404).json({ error: 'No public transport route was found arriving by ' + requestedTime + '.' });
    }

    const current = await requestRoute({ token, start, end, date: now.date, time: queryTime, arriveBy: false });
    if (current.response.ok && isRoutePayload(current.data) && hasItinerary(current.data)) {
      current.data._jalan = { service: planned ? 'planned' : 'now', requestedDate: now.date, requestedTime: queryTime, timeMode: requestedMode };
      return res.status(200).json(current.data);
    }

    if (isNoRoute(current.response, current.data)) {
      if (!planned) {
        const nextDate = now.hour < 5 ? now.date : addDay(now.date);
        const nextTime = '05:30:00';
        const next = await requestRoute({ token, start, end, date: nextDate, time: nextTime, arriveBy: false });
        if (next.response.ok && isRoutePayload(next.data) && hasItinerary(next.data)) {
          next.data._jalan = { service: 'next', requestedDate: nextDate, requestedTime: nextTime, timeMode: 'depart', reason: 'No public transport route was available for the current time.' };
          return res.status(200).json(next.data);
        }
        if (isNoRoute(next.response, next.data)) return res.status(404).json({ error: 'No public transport route is available now.' });
      } else {
        return res.status(404).json({ error: 'No public transport route was found for ' + requestedTime + '.' });
      }
    }

    return res.status(502).json({ error: 'OneMap routing is temporarily unavailable.' });
  } catch (error) {
    return upstreamResponse(res, error, 'OneMap routing is temporarily unavailable.');
  }
};

module.exports._test = { isRoutePayload, isRouteResponsePayload, requestRoute };
