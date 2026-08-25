
const { fetchJson, safeUpstreamFailure } = require('./_upstream');

const LTA_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusStops';
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const CACHE_MS = 12 * 60 * 60 * 1000;

let cachedStops = null;
let cachedAt = 0;
let loadingStops = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBusStop(value) {
  return isRecord(value)
    && /^\d{5}$/.test(String(value.BusStopCode || ''))
    && Number.isFinite(Number(value.Latitude))
    && Number.isFinite(Number(value.Longitude));
}

function isBusStopsPayload(value) {
  return isRecord(value) && Array.isArray(value.value) && value.value.every(isBusStop);
}

function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchPage(apiKey, page) {
  const url = new URL(LTA_URL);
  url.searchParams.set('$skip', String(page * PAGE_SIZE));
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' } },
    { service: 'LTA BusStops', validate: isBusStopsPayload },
  );
  return data.value;
}

async function buildStopCache(apiKey) {
  const all = [];

  for (let page = 0; page < MAX_PAGES; page += 2) {
    const [first, second] = await Promise.allSettled([
      fetchPage(apiKey, page),
      page + 1 < MAX_PAGES ? fetchPage(apiKey, page + 1) : Promise.resolve([]),
    ]);

    if (first.status === 'rejected') throw first.reason;
    all.push(...first.value);
    if (first.value.length < PAGE_SIZE) break;

    if (second.status === 'rejected') throw second.reason;
    all.push(...second.value);
    if (second.value.length < PAGE_SIZE) break;
  }

  cachedStops = all;
  cachedAt = Date.now();
  return cachedStops;
}

async function loadStops(apiKey) {
  if (cachedStops && Date.now() - cachedAt < CACHE_MS) return cachedStops;
  if (!loadingStops) {
    loadingStops = buildStopCache(apiKey).finally(() => {
      loadingStops = null;
    });
  }
  return loadingStops;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  try {
    const url = new URL(req.url, 'https://jalan.local');
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }
    if (lat < 1.1 || lat > 1.55 || lng < 103.5 || lng > 104.15) {
      return res.status(400).json({ error: 'Location must be within Singapore.' });
    }

    const apiKey = process.env.LTA_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'LTA_API_KEY is not configured.' });

    const stops = await loadStops(apiKey);
    const nearby = stops
      .map((stop) => ({
        stopCode: String(stop.BusStopCode),
        roadName: stop.RoadName || '',
        name: stop.Description || stop.RoadName || 'Bus stop ' + stop.BusStopCode,
        lat: Number(stop.Latitude),
        lng: Number(stop.Longitude),
        distance: Math.round(distanceMetres(lat, lng, Number(stop.Latitude), Number(stop.Longitude))),
      }))
      .filter((stop) => Number.isFinite(stop.distance) && stop.distance <= 900)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    return res.status(200).json({ nearby, updatedAt: new Date().toISOString() });
  } catch (error) {
    safeUpstreamFailure(error);
    return res.status(502).json({ error: 'Nearby bus stops are temporarily unavailable.' });
  }
};

module.exports._test = { isBusStopsPayload };
