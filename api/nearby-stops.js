const LTA_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusStops';
const PAGE_SIZE = 500;
const MAX_PAGES = 14;
const CACHE_MS = 6 * 60 * 60 * 1000;

let cachedStops = null;
let cachedAt = 0;

function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadStops(apiKey) {
  if (cachedStops && Date.now() - cachedAt < CACHE_MS) return cachedStops;

  const offsets = Array.from({ length: MAX_PAGES }, (_, index) => index * PAGE_SIZE);
  const pages = await Promise.all(offsets.map(async (skip) => {
    const url = new URL(LTA_URL);
    url.searchParams.set('$skip', String(skip));
    const response = await fetch(url, {
      headers: { AccountKey: apiKey, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`LTA BusStops request failed (${response.status}).`);
    const payload = await response.json();
    return payload.value || [];
  }));

  cachedStops = pages.flat().filter((stop) => stop.BusStopCode && stop.Latitude && stop.Longitude);
  cachedAt = Date.now();
  return cachedStops;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

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
        stopCode: stop.BusStopCode,
        roadName: stop.RoadName || '',
        name: stop.Description || stop.RoadName || `Bus stop ${stop.BusStopCode}`,
        lat: Number(stop.Latitude),
        lng: Number(stop.Longitude),
        distance: Math.round(distanceMetres(lat, lng, Number(stop.Latitude), Number(stop.Longitude))),
      }))
      .filter((stop) => Number.isFinite(stop.distance) && stop.distance <= 900)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    return res.status(200).json({ nearby, updatedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
  }
}
